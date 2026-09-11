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

// ── Bug 1: acquire() reverts → FAILED destinationCallback ────────────────────
//
// The old code used `dcState = pauseResult ? COMPLETE : FAILED`, which reported
// COMPLETE even when holdLedger.acquire() had thrown.  The fix requires both
// pauseResult AND holdAcquired before sending COMPLETE.

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

    it("vault pauses but event reaches FAILED when holdLedger.acquire() reverts", async function () {
        const report = encodeReport([coinA.address], [2], 2);
        const tx = await receiver.connect(forwarder).onReport("0x", report);
        const receipt = await tx.wait();

        // Capture eventId from EventCreated before it terminates
        const evCreated = receipt.logs
            .map(l => { try { return eventRegistry.interface.parseLog(l); } catch { return null; } })
            .find(e => e && e.name === "EventCreated");
        const eventId = evCreated.args.eventId;

        // pause() preceded acquire(), so the vault is physically paused
        expect(await vault.paused()).to.equal(true);

        // destinationCallback received FAILED → 1 dest, all FAILED → terminal FAILED
        const ev = await eventRegistry.getDepegEvent(eventId);
        expect(Number(ev.state)).to.equal(S.FAILED);
        expect(await eventRegistry.getActiveEventId(coinA.address)).to.equal(ethers.ZeroHash);
    });
});

// ── Bug 2: vault.unpause() reverts → FAILED destinationCallback ───────────────
//
// The old code used `cbState = holdReleased ? COMPLETE : FAILED`, which reported
// COMPLETE even when vault.unpause() had thrown.  The fix requires both
// holdReleased AND unpaused before sending COMPLETE.

describe("Bug-2: vault.unpause() revert produces FAILED destinationCallback", function () {
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

    it("hold released but event FAILED when vault.unpause() reverts during auto-recovery", async function () {
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

        // destinationCallback received FAILED → 1 dest, all FAILED → terminal FAILED
        const ev = await eventRegistry.getDepegEvent(firstId);
        expect(Number(ev.state)).to.equal(S.FAILED);
    });
});

// ── Bug-2 retry: unpause-only retry succeeds without HoldAlreadyReleased ──────
//
// After release() succeeds, _coinHoldId[coin] is cleared to bytes32(0).
// On the next cycle the receiver must detect "hold gone, vault still paused"
// and re-attempt unpause without calling release() again (which would throw
// HoldAlreadyReleased).  The fix adds an else-if branch that fires when
// _coinHoldId[coin]==0 && activeHoldCount==0.
//
// To keep the event in RECOVERY_PENDING after the first FAILED callback we set
// up 2 destinations via admin.initiateRecovery(): dest-0 is the local vault,
// dest-1 is a stub that stays PENDING.  With dest-1 still PENDING the
// _evaluateRecovery aggregate is "partial settled → stay RECOVERY_PENDING".

describe("Bug-2 retry: vault unpauses on second attempt without HoldAlreadyReleased", function () {
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

    it("vault unpauses on retry without reverting on HoldAlreadyReleased", async function () {
        // Alert → CONFIRMED_DEPEG → vault paused → PROTECTED (1 dest, COMPLETE)
        await receiver.connect(forwarder).onReport("0x", encodeReport([coinA.address], [2], 2));
        expect(await flakyVault.paused()).to.equal(true);

        const firstId = await eventRegistry.getActiveEventId(coinA.address);

        // Admin manually opens recovery with 2 destinations so that dest-0 FAILED
        // does not immediately terminate the event (dest-1 stays PENDING → partial).
        await eventRegistry.connect(admin).initiateRecovery(firstId, [
            { chainSelector: LOCAL_CHAIN_SELECTOR, vault: await flakyVault.getAddress() },
            { chainSelector: 999n,                 vault: admin.address }
        ]);

        // Attempt 1: hold released, unpause reverts → cbState = FAILED
        await flakyVault.setUnpauseReverts(true);
        await receiver.connect(forwarder).onReport("0x", stableReport([coinA.address]));

        // vault still paused; event still RECOVERY_PENDING (dest-1 = PENDING → not all settled)
        expect(await flakyVault.paused()).to.equal(true);
        expect(Number((await eventRegistry.getDepegEvent(firstId)).state))
            .to.equal(S.RECOVERY_PENDING);

        // Attempt 2: _coinHoldId[coin] == 0, activeHoldCount == 0 → retry path
        // must NOT throw HoldAlreadyReleased; vault.unpause() now succeeds.
        await flakyVault.setUnpauseReverts(false);
        await expect(
            receiver.connect(forwarder).onReport("0x", stableReport([coinA.address]))
        ).to.not.be.reverted;
        expect(await flakyVault.paused()).to.equal(false);
    });
});
