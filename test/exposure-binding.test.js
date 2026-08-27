"use strict";

const { ethers } = require("hardhat");
const { expect } = require("chai");
const { time } = require("@nomicfoundation/hardhat-network-helpers");

const LOCAL_CHAIN_SELECTOR = 1n;

// WATCH_THRESHOLD=1, CONFIRMED_THRESHOLD=2: matches depeg-event-registry.test.js fixture.
// signalLevel=2 (HEDGE) reaches CONFIRMED_DEPEG in a single processReport call from NORMAL
// (G0 creates WATCH, _applyScoreTransitions immediately advances via G2 — one transaction).
const WATCH_THRESHOLD      = 1;
const CONFIRMED_THRESHOLD  = 2;
const STABILITY_WINDOW     = 3;       // matches depeg-event-registry.test.js fixture
const EVENT_TTL            = 86400n;  // 24 h
const PENDING_TTL          = 3600n;   // 1 h
const RECOVERY_COOLDOWN    = 900n;    // 15 min

function encodeReport(coins, signalLevels, compositeScore) {
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
            BigInt(Math.floor(Date.now() / 1000)),
        ]
    );
}

// Mirrors Solidity: bytes32(uint256(uint160(addr)))
function addrToBytes32(addr) {
    return ethers.zeroPadValue(addr, 32);
}

const S = {
    WATCH: 0, CONFIRMED_DEPEG: 1,
    PROTECTION_PENDING: 2, PARTIALLY_PROTECTED: 3, PROTECTED: 4,
    RECOVERY_PENDING: 5, PARTIALLY_RECOVERED: 6,
    NORMAL: 7, EXPIRED: 8, FAILED: 9, SUPERSEDED: 10,
};

describe("ExposureRegistry binding", function () {
    let receiver, registry, eventRegistry, vault, holdLedger;
    let forwarder, admin, coinA, coinB;

    beforeEach(async function () {
        [forwarder, admin, coinA, coinB] = await ethers.getSigners();

        const ExposureRegistry = await ethers.getContractFactory("ExposureRegistry");
        registry = await ExposureRegistry.deploy(admin.address);

        const MockVault = await ethers.getContractFactory("MockVault");
        vault = await MockVault.deploy();

        // Deploy registry with deployer as initial controller; transferController after receiver deploy
        const DepegEventRegistry = await ethers.getContractFactory("DepegEventRegistry");
        eventRegistry = await DepegEventRegistry.deploy(
            admin.address,          // initial controller = deployer (admin signer)
            WATCH_THRESHOLD,
            CONFIRMED_THRESHOLD,
            STABILITY_WINDOW,
            EVENT_TTL,
            PENDING_TTL,
            RECOVERY_COOLDOWN
        );

        // Deploy hold ledger with admin as initial coordinator; transferCoordinator after receiver deploy
        const ProtectionHoldLedger = await ethers.getContractFactory("ProtectionHoldLedger");
        holdLedger = await ProtectionHoldLedger.deploy(admin.address);

        const StableGuardCREReceiver = await ethers.getContractFactory("StableGuardCREReceiver");
        receiver = await StableGuardCREReceiver.deploy(
            forwarder.address,
            await registry.getAddress(),
            await eventRegistry.getAddress(),
            await vault.getAddress(),
            LOCAL_CHAIN_SELECTOR,
            await holdLedger.getAddress()
        );

        // Wire holdLedger into registry while admin is still controller
        await eventRegistry.connect(admin).setHoldLedger(await holdLedger.getAddress());

        // Hand control to the receiver (resolves chicken-and-egg)
        await eventRegistry.connect(admin).transferController(await receiver.getAddress());

        // Hand ledger coordination to the receiver so it can acquire/release holds
        await holdLedger.connect(admin).transferCoordinator(await receiver.getAddress());
    });

    it("reverts when caller is not the registered forwarder", async function () {
        const report = encodeReport([coinA.address], [2], 2);
        await expect(receiver.connect(admin).onReport("0x", report))
            .to.be.revertedWithCustomError(receiver, "UnauthorizedForwarder")
            .withArgs(admin.address);
    });

    it("emits VaultExposureMissing and does not pause when vault holds B but alert is for A", async function () {
        const vaultAddr = await vault.getAddress();
        await registry
            .connect(admin)
            .registerExposure(vaultAddr, addrToBytes32(coinB.address));

        const report = encodeReport([coinA.address], [2], 2);
        await expect(receiver.connect(forwarder).onReport("0x", report))
            .to.emit(receiver, "VaultExposureMissing")
            .withArgs(vaultAddr, addrToBytes32(coinA.address));

        expect(await vault.paused()).to.equal(false);
    });

    it("pauses vault when it holds the alerted asset", async function () {
        await registry
            .connect(admin)
            .registerExposure(await vault.getAddress(), addrToBytes32(coinA.address));

        const report = encodeReport([coinA.address], [2], 2);
        await receiver.connect(forwarder).onReport("0x", report);

        expect(await vault.paused()).to.equal(true);
    });

    it("emits VaultExposureMissing and does not pause when vault has no exposure registered", async function () {
        const vaultAddr = await vault.getAddress();
        const report = encodeReport([coinA.address], [2], 2);
        await expect(receiver.connect(forwarder).onReport("0x", report))
            .to.emit(receiver, "VaultExposureMissing")
            .withArgs(vaultAddr, addrToBytes32(coinA.address));

        expect(await vault.paused()).to.equal(false);
    });

    // The active event reaches PROTECTED after the first alert, so subsequent
    // processReport calls return PROTECTED (not CONFIRMED_DEPEG) and the loop
    // short-circuits before touching exposure or pause logic.
    it("settled event does not re-fire on repeat alert", async function () {
        const vaultAddr = await vault.getAddress();
        const symA = addrToBytes32(coinA.address);
        await registry.connect(admin).registerExposure(vaultAddr, symA);

        const report = encodeReport([coinA.address], [2], 2);

        // First alert: CONFIRMED_DEPEG → PROTECTION_PENDING → vault paused → PROTECTED
        await receiver.connect(forwarder).onReport("0x", report);
        expect(await vault.paused()).to.equal(true);
        await vault.unpause();

        // Revoke exposure — irrelevant here because the active event is PROTECTED,
        // so processReport returns PROTECTED and the loop exits before the exposure check.
        await registry.connect(admin).revokeExposure(vaultAddr, symA);
        await receiver.connect(forwarder).onReport("0x", report);
        expect(await vault.paused()).to.equal(false);
    });

    // The actual Milestone 1 invariant: revoked exposure must block a pause even when
    // a fresh event is created (old event is terminal, lookup-before-create mints a new one).
    it("revoked exposure blocks a fresh pause after prior event expires", async function () {
        const vaultAddr = await vault.getAddress();
        const symA = addrToBytes32(coinA.address);
        await registry.connect(admin).registerExposure(vaultAddr, symA);

        const report = encodeReport([coinA.address], [2], 2);

        // First alert: new WATCH event → CONFIRMED_DEPEG → PROTECTION_PENDING →
        // vault paused → PROTECTED.
        await receiver.connect(forwarder).onReport("0x", report);
        expect(await vault.paused()).to.equal(true);

        // Expire the PROTECTED event via settleExpired (permissionless).
        const activeId = await eventRegistry.getActiveEventId(coinA.address);
        await time.increase(EVENT_TTL + 1n);
        await eventRegistry.settleExpired(activeId);

        // Reset vault and revoke exposure.
        await vault.unpause();
        await registry.connect(admin).revokeExposure(vaultAddr, symA);

        // Second alert: lookup-before-create opens a FRESH event (old one is EXPIRED/terminal).
        // processReport returns CONFIRMED_DEPEG → exposure gate fires → VaultExposureMissing.
        // vault.pause() is never reached.
        await expect(receiver.connect(forwarder).onReport("0x", report))
            .to.emit(receiver, "VaultExposureMissing")
            .withArgs(vaultAddr, symA);
        expect(await vault.paused()).to.equal(false);
    });

    // Helpers for scenario test
    async function eventState(eventId) {
        return Number((await eventRegistry.getDepegEvent(eventId)).state);
    }
    async function activeEventId(coin) {
        return eventRegistry.getActiveEventId(coin);
    }

    // Encodes a report with all coins at signalLevel=0 (stable, compositeScore=0)
    function stableReport(coins) {
        return encodeReport(coins, coins.map(() => 0), 0);
    }

    it("receiver auto-resumes tracking and reaches NORMAL when event expires with vault still paused", async function () {
        const vaultAddr = await vault.getAddress();
        const symA = addrToBytes32(coinA.address);
        await registry.connect(admin).registerExposure(vaultAddr, symA);

        // First alert: CONFIRMED_DEPEG → vault paused → PROTECTED (1 dest, COMPLETE)
        const alert = encodeReport([coinA.address], [2], 2);
        await receiver.connect(forwarder).onReport("0x", alert);
        expect(await vault.paused()).to.equal(true);
        const firstId = await activeEventId(coinA.address);
        expect(await eventState(firstId)).to.equal(S.PROTECTED);

        // One stable report: stableCount = 1 (STABILITY_WINDOW = 3, not yet)
        const stable = stableReport([coinA.address]);
        await receiver.connect(forwarder).onReport("0x", stable);
        expect(await vault.paused()).to.equal(true);
        expect(await activeEventId(coinA.address)).to.equal(firstId); // same event

        // Advance past eventTTL
        await time.increase(EVENT_TTL + 1n);

        // First stable report after TTL: G13 fires, first event → EXPIRED.
        // Receiver sees (firstId, EXPIRED) — not CONFIRMED_DEPEG, not RECOVERY_PENDING,
        // eventId != bytes32(0) — so no action taken. Vault stays paused.
        await receiver.connect(forwarder).onReport("0x", stable);
        expect(await eventState(firstId)).to.equal(S.EXPIRED);
        expect(await activeEventId(coinA.address)).to.equal(ethers.ZeroHash);
        expect(await vault.paused()).to.equal(true);

        // KEY REPORT: processReport returns (bytes32(0), NORMAL) — no active event,
        // stable score. Receiver detects vault.paused() = true and calls
        // resumeProtectionTracking → fresh PROTECTED event with stableCount = 0.
        await expect(receiver.connect(forwarder).onReport("0x", stable))
            .to.emit(eventRegistry, "RecoveryTrackingResumed");

        const continuationId = await activeEventId(coinA.address);
        expect(continuationId).to.not.equal(ethers.ZeroHash);
        expect(continuationId).to.not.equal(firstId);
        expect(await eventState(continuationId)).to.equal(S.PROTECTED);
        expect(await vault.paused()).to.equal(true); // still paused — auto-recovery not fired yet

        // STABILITY_WINDOW more stable reports: stableCount → 1, 2, then fires on 3
        // (the resumeProtectionTracking call itself doesn't increment stableCount)
        for (let i = 0; i < STABILITY_WINDOW - 1; i++) {
            await receiver.connect(forwarder).onReport("0x", stable);
            expect(await vault.paused()).to.equal(true);
        }

        // Final stable report: stableCount reaches STABILITY_WINDOW → _applyAutoRecovery
        // fires → RECOVERY_PENDING. Receiver: vault.paused() = true → vault.unpause()
        // → destinationCallback(0, COMPLETE). Cooldown not yet elapsed → stays RECOVERY_PENDING.
        await receiver.connect(forwarder).onReport("0x", stable);
        expect(await vault.paused()).to.equal(false);
        expect(await eventState(continuationId)).to.equal(S.RECOVERY_PENDING);

        // Advance past recoveryCooldown → finalizeRecovery() on next report succeeds → NORMAL
        await time.increase(RECOVERY_COOLDOWN + 1n);
        await receiver.connect(forwarder).onReport("0x", stable);

        expect(await eventState(continuationId)).to.equal(S.NORMAL);
        expect(await activeEventId(coinA.address)).to.equal(ethers.ZeroHash);
    });

    it("skips unregistered coin but still pauses for registered coin in same report", async function () {
        const vaultAddr = await vault.getAddress();
        // Vault holds coinB only — coinA is unregistered
        await registry
            .connect(admin)
            .registerExposure(vaultAddr, addrToBytes32(coinB.address));

        // Two coins alerting in one report
        const report = encodeReport(
            [coinA.address, coinB.address],
            [2, 2],
            2
        );

        await expect(receiver.connect(forwarder).onReport("0x", report))
            .to.emit(receiver, "VaultExposureMissing")
            .withArgs(vaultAddr, addrToBytes32(coinA.address));

        // coinB was registered, so pause still fires despite coinA being skipped
        expect(await vault.paused()).to.equal(true);
    });
});
