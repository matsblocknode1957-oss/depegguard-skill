"use strict";

const { ethers } = require("hardhat");
const { expect } = require("chai");
const { time } = require("@nomicfoundation/hardhat-network-helpers");

const LOCAL_CHAIN_SELECTOR = 1n;

const WATCH_THRESHOLD     = 1;
const CONFIRMED_THRESHOLD = 2;
const STABILITY_WINDOW    = 3;
const EVENT_TTL           = 86400n;
const PENDING_TTL         = 3600n;
const RECOVERY_COOLDOWN   = 900n;
const MAX_REPORT_AGE      = 604800n; // 1 week — survives any time.increase in these tests

const S = {
    WATCH: 0, CONFIRMED_DEPEG: 1,
    PROTECTION_PENDING: 2, PARTIALLY_PROTECTED: 3, PROTECTED: 4,
    RECOVERY_PENDING: 5, PARTIALLY_RECOVERED: 6,
    NORMAL: 7, EXPIRED: 8, FAILED: 9, SUPERSEDED: 10,
};

let _ts = 0n;
function encodeReport(coins, signalLevels, compositeScore) {
    const observedAt = ++_ts;
    const coder = ethers.AbiCoder.defaultAbiCoder();
    return coder.encode(
        ["address[]", "uint256[]", "uint256[]", "uint8[]", "bytes[]", "uint8", "uint8", "uint256"],
        [
            coins,
            coins.map(() => ethers.parseUnits("0.98", 8)),
            coins.map(() => 200n),
            signalLevels,
            coins.map(() => "0x"),
            compositeScore,
            1,
            observedAt,
        ]
    );
}

function addrToBytes32(addr) {
    return ethers.zeroPadValue(addr, 32);
}

function stableReport(coins) {
    return encodeReport(coins, coins.map(() => 0), 0);
}

async function deployEventRegistry(admin) {
    const Factory = await ethers.getContractFactory("DepegEventRegistry");
    return Factory.deploy(
        admin.address,
        WATCH_THRESHOLD,
        CONFIRMED_THRESHOLD,
        STABILITY_WINDOW,
        EVENT_TTL,
        PENDING_TTL,
        RECOVERY_COOLDOWN
    );
}

// ── Bug 1: acquire() reverts → vault left unpaused, FAILED destinationCallback ─
//
// Original fix: `dcState = pauseResult ? COMPLETE : FAILED` was changed to require
// both pauseResult AND holdAcquired.  Current fix goes further: acquire() now runs
// before pause(), so a failing acquire() never triggers a vault freeze at all.
// This eliminates the orphaned-pause state (vault frozen, no hold, no active event)
// that would cause the next report to attempt a double-pause on a real vault.

describe("Bug-1: acquire() revert produces FAILED destinationCallback", function () {
    let receiver, registry, eventRegistry, mockLedger, vault;
    let forwarder, admin, coinA;

    beforeEach(async function () {
        [forwarder, admin, coinA] = await ethers.getSigners();
        _ts = BigInt((await ethers.provider.getBlock("latest")).timestamp) - 1000n;

        const MockVaultFactory = await ethers.getContractFactory("MockVault");
        vault = await MockVaultFactory.deploy();

        const MockLedgerFactory = await ethers.getContractFactory("MockHoldLedgerRevertAcquire");
        mockLedger = await MockLedgerFactory.deploy();

        const ExposureRegistry = await ethers.getContractFactory("ExposureRegistry");
        registry = await ExposureRegistry.deploy(admin.address);

        eventRegistry = await deployEventRegistry(admin);

        // MockHoldLedgerRevertAcquire lacks getHold, but setHoldLedger is safe here
        // because resumeProtectionTracking (the only caller of getHold) is never reached.
        await eventRegistry.connect(admin).setHoldLedger(await mockLedger.getAddress());

        const ReceiverFactory = await ethers.getContractFactory("StableGuardCREReceiver");
        receiver = await ReceiverFactory.deploy(
            forwarder.address,
            await registry.getAddress(),
            await eventRegistry.getAddress(),
            await vault.getAddress(),
            LOCAL_CHAIN_SELECTOR,
            await mockLedger.getAddress(),
            MAX_REPORT_AGE
        );

        await eventRegistry.connect(admin).transferController(await receiver.getAddress());
        await registry.connect(admin).registerExposure(
            await vault.getAddress(), addrToBytes32(coinA.address)
        );
    });

    it("vault stays unpaused and event reaches FAILED when holdLedger.acquire() reverts", async function () {
        const report = encodeReport([coinA.address], [2], 2);
        const tx = await receiver.connect(forwarder).onReport("0x", report);
        const receipt = await tx.wait();

        // Capture eventId from EventCreated before it terminates
        const evCreated = receipt.logs
            .map(l => { try { return eventRegistry.interface.parseLog(l); } catch { return null; } })
            .find(e => e && e.name === "EventCreated");
        const eventId = evCreated.args.eventId;

        // acquire() runs before pause() — vault is NOT paused when acquire() fails
        expect(await vault.paused()).to.equal(false);

        // destinationCallback received FAILED → 1 dest, all FAILED → terminal FAILED
        const ev = await eventRegistry.getDepegEvent(eventId);
        expect(Number(ev.state)).to.equal(S.FAILED);
        expect(await eventRegistry.getActiveEventId(coinA.address)).to.equal(ethers.ZeroHash);
    });
});

// ── Bug-2: vault.unpause() reverts → callback suppressed, event stays RECOVERY_PENDING ──
//
// The original wrong code sent COMPLETE even when unpause threw (cbState=holdReleased).
// An intermediate fix sent FAILED when !unpaused — but that terminated single-destination
// events permanently (G11).  The final fix skips the callback entirely when holdReleased
// && !unpaused, leaving the destination PENDING for the next cycle's autonomous retry path.

describe("Bug-2: vault.unpause() revert suppresses callback; event stays RECOVERY_PENDING", function () {
    let receiver, registry, eventRegistry, holdLedger, flakyVault;
    let forwarder, admin, coinA;

    beforeEach(async function () {
        [forwarder, admin, coinA] = await ethers.getSigners();
        _ts = BigInt((await ethers.provider.getBlock("latest")).timestamp) - 1000n;

        const FlakyVaultFactory = await ethers.getContractFactory("MockFlakyVault");
        flakyVault = await FlakyVaultFactory.deploy();

        const LedgerFactory = await ethers.getContractFactory("ProtectionHoldLedger");
        holdLedger = await LedgerFactory.deploy(admin.address, admin.address);

        const ExposureRegistry = await ethers.getContractFactory("ExposureRegistry");
        registry = await ExposureRegistry.deploy(admin.address);

        eventRegistry = await deployEventRegistry(admin);

        const ReceiverFactory = await ethers.getContractFactory("StableGuardCREReceiver");
        receiver = await ReceiverFactory.deploy(
            forwarder.address,
            await registry.getAddress(),
            await eventRegistry.getAddress(),
            await flakyVault.getAddress(),
            LOCAL_CHAIN_SELECTOR,
            await holdLedger.getAddress(),
            MAX_REPORT_AGE
        );

        await eventRegistry.connect(admin).setHoldLedger(await holdLedger.getAddress());
        await eventRegistry.connect(admin).transferController(await receiver.getAddress());
        await holdLedger.connect(admin).transferCoordinator(await receiver.getAddress());
        await registry.connect(admin).registerExposure(
            await flakyVault.getAddress(), addrToBytes32(coinA.address)
        );
    });

    it("hold released but callback suppressed when vault.unpause() reverts; event stays RECOVERY_PENDING", async function () {
        // Alert → CONFIRMED_DEPEG → vault paused → PROTECTED
        await receiver.connect(forwarder).onReport("0x", encodeReport([coinA.address], [2], 2));
        expect(await flakyVault.paused()).to.equal(true);

        const firstId = await eventRegistry.getActiveEventId(coinA.address);
        expect(Number((await eventRegistry.getDepegEvent(firstId)).state)).to.equal(S.PROTECTED);

        // Arm unpause revert before auto-recovery fires
        await flakyVault.setUnpauseReverts(true);

        // STABILITY_WINDOW stable reports: report 1 → stableCount=1, report 2 → stableCount=2,
        // report 3 → stableCount+1==STABILITY_WINDOW → _applyAutoRecovery fires within processReport
        for (let i = 0; i < STABILITY_WINDOW; i++) {
            await receiver.connect(forwarder).onReport("0x", stableReport([coinA.address]));
        }

        // unpause threw → vault still paused
        expect(await flakyVault.paused()).to.equal(true);

        // callback suppressed (holdReleased && !unpaused) → event stays RECOVERY_PENDING
        const ev = await eventRegistry.getDepegEvent(firstId);
        expect(Number(ev.state)).to.equal(S.RECOVERY_PENDING);
    });
});

// ── Bug-2 single-dest retry: callback suppression allows autonomous retry ──────
//
// With the fix, when holdReleased && !unpaused the receiver skips the callback,
// leaving the destination slot PENDING and the event alive in RECOVERY_PENDING.
// The next cycle's retry path (_coinHoldId==0, activeHoldCount==0) re-attempts
// vault.unpause() without calling release() again — HoldAlreadyReleased is
// never thrown.  Once unpause succeeds, destinationCallback(COMPLETE) fires;
// after recoveryCooldown elapses, _evaluateRecovery G10 terminates to NORMAL.

describe("Bug-2 single-dest retry: callback skipped on unpause failure, retries autonomously, resolves NORMAL", function () {
    let receiver, registry, eventRegistry, holdLedger, flakyVault;
    let forwarder, admin, coinA;

    beforeEach(async function () {
        [forwarder, admin, coinA] = await ethers.getSigners();
        _ts = BigInt((await ethers.provider.getBlock("latest")).timestamp) - 1000n;

        const FlakyVaultFactory = await ethers.getContractFactory("MockFlakyVault");
        flakyVault = await FlakyVaultFactory.deploy();

        const LedgerFactory = await ethers.getContractFactory("ProtectionHoldLedger");
        holdLedger = await LedgerFactory.deploy(admin.address, admin.address);

        const ExposureRegistry = await ethers.getContractFactory("ExposureRegistry");
        registry = await ExposureRegistry.deploy(admin.address);

        eventRegistry = await deployEventRegistry(admin);

        const ReceiverFactory = await ethers.getContractFactory("StableGuardCREReceiver");
        receiver = await ReceiverFactory.deploy(
            forwarder.address,
            await registry.getAddress(),
            await eventRegistry.getAddress(),
            await flakyVault.getAddress(),
            LOCAL_CHAIN_SELECTOR,
            await holdLedger.getAddress(),
            MAX_REPORT_AGE
        );

        await eventRegistry.connect(admin).setHoldLedger(await holdLedger.getAddress());
        await eventRegistry.connect(admin).transferController(await receiver.getAddress());
        await holdLedger.connect(admin).transferCoordinator(await receiver.getAddress());
        await registry.connect(admin).registerExposure(
            await flakyVault.getAddress(), addrToBytes32(coinA.address)
        );
    });

    it("vault unpauses and event resolves NORMAL after one failed cycle, no manual intervention", async function () {
        // Alert → CONFIRMED_DEPEG → vault paused → PROTECTED (1 dest, COMPLETE)
        await receiver.connect(forwarder).onReport("0x", encodeReport([coinA.address], [2], 2));
        expect(await flakyVault.paused()).to.equal(true);

        const firstId = await eventRegistry.getActiveEventId(coinA.address);
        expect(Number((await eventRegistry.getDepegEvent(firstId)).state)).to.equal(S.PROTECTED);

        // Arm unpause revert before auto-recovery fires
        await flakyVault.setUnpauseReverts(true);

        // STABILITY_WINDOW stable reports: report 1 → stableCount=1, report 2 → stableCount=2,
        // report 3 → stableCount+1==STABILITY_WINDOW → _applyAutoRecovery fires.
        // Recovery block: hold released, unpause reverts → callback SKIPPED → dest stays PENDING.
        for (let i = 0; i < STABILITY_WINDOW; i++) {
            await receiver.connect(forwarder).onReport("0x", stableReport([coinA.address]));
        }

        // vault still paused; event stays RECOVERY_PENDING — no FAILED callback was sent
        expect(await flakyVault.paused()).to.equal(true);
        expect(Number((await eventRegistry.getDepegEvent(firstId)).state))
            .to.equal(S.RECOVERY_PENDING);

        // Fix unpause and advance past recoveryCooldown so G10 can terminate to NORMAL
        await flakyVault.setUnpauseReverts(false);
        await time.increase(Number(RECOVERY_COOLDOWN) + 1);

        // Retry cycle: _coinHoldId==0, activeHoldCount==0 → retry path → unpause succeeds →
        // destinationCallback(COMPLETE) → G10 (cooldown elapsed) → _terminate(NORMAL)
        await receiver.connect(forwarder).onReport("0x", stableReport([coinA.address]));

        expect(await flakyVault.paused()).to.equal(false);
        const ev = await eventRegistry.getDepegEvent(firstId);
        expect(Number(ev.state)).to.equal(S.NORMAL);
        expect(await eventRegistry.getActiveEventId(coinA.address)).to.equal(ethers.ZeroHash);
    });
});

// ── Bug-1 double-pause regression ─────────────────────────────────────────────
//
// Before the acquire()-first fix, a failing acquire() left the vault paused with
// no hold on record (orphaned freeze).  The next report for the same coin would
// find activeHoldCount==0 and paused()==true, skip the alreadyFrozen short-circuit,
// and call pause() again — reverting on any vault that guards double-pause (OZ
// Pausable throws EnforcedPause).
//
// With acquire()-first: no hold → no pause → vault stays unpaused → the second
// report starts from clean state.  This test uses MockVaultRevertDoublePause
// (reverts on double-pause) to exercise the exact scenario the earlier Bug-1 test
// did not cover.

describe("Bug-1 double-pause regression: acquire() fail leaves vault unpaused; second report does not double-pause", function () {
    let receiver, eventRegistry, registry, mockLedger, vault;
    let forwarder, admin, coinA;

    beforeEach(async function () {
        [forwarder, admin, coinA] = await ethers.getSigners();
        _ts = BigInt((await ethers.provider.getBlock("latest")).timestamp) - 1000n;

        const VaultFactory = await ethers.getContractFactory("MockVaultRevertDoublePause");
        vault = await VaultFactory.deploy();

        const LedgerFactory = await ethers.getContractFactory("MockHoldLedgerRevertAcquire");
        mockLedger = await LedgerFactory.deploy();

        const ExposureRegistry = await ethers.getContractFactory("ExposureRegistry");
        registry = await ExposureRegistry.deploy(admin.address);

        eventRegistry = await deployEventRegistry(admin);
        await eventRegistry.connect(admin).setHoldLedger(await mockLedger.getAddress());

        const ReceiverFactory = await ethers.getContractFactory("StableGuardCREReceiver");
        receiver = await ReceiverFactory.deploy(
            forwarder.address,
            await registry.getAddress(),
            await eventRegistry.getAddress(),
            await vault.getAddress(),
            LOCAL_CHAIN_SELECTOR,
            await mockLedger.getAddress(),
            MAX_REPORT_AGE
        );

        await eventRegistry.connect(admin).transferController(await receiver.getAddress());
        await registry.connect(admin).registerExposure(
            await vault.getAddress(), addrToBytes32(coinA.address)
        );
    });

    it("vault stays unpaused when acquire() reverts; second report does not trigger double-pause revert", async function () {
        // First report: acquire() reverts → no pause attempted → vault stays unpaused
        await receiver.connect(forwarder).onReport("0x", encodeReport([coinA.address], [2], 2));
        expect(await vault.paused()).to.equal(false,
            "vault must not be paused after acquire() failure (no orphaned freeze)");

        // Second report: vault is unpaused, so pause() would be a legal first call.
        // Without the fix vault would be paused here and vault.pause() would throw
        // AlreadyPaused — soft-caught as VaultPauseFailed, but vault stuck paused forever.
        // With the fix acquire() fails first so pause() is never called on either report.
        await expect(
            receiver.connect(forwarder).onReport("0x", encodeReport([coinA.address], [2], 2))
        ).to.not.be.reverted;

        expect(await vault.paused()).to.equal(false,
            "vault must remain unpaused — acquire() always reverts so pause() is never called");
    });
});
