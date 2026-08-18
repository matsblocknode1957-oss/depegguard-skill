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

describe("ExposureRegistry binding", function () {
    let receiver, registry, eventRegistry, vault;
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
            EVENT_TTL,
            PENDING_TTL,
            RECOVERY_COOLDOWN
        );

        const StableGuardCREReceiver = await ethers.getContractFactory("StableGuardCREReceiver");
        receiver = await StableGuardCREReceiver.deploy(
            forwarder.address,
            await registry.getAddress(),
            await eventRegistry.getAddress(),
            await vault.getAddress(),
            LOCAL_CHAIN_SELECTOR
        );

        // Hand control to the receiver (resolves chicken-and-egg)
        await eventRegistry.connect(admin).transferController(await receiver.getAddress());
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
