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

const FREEZE_MODE_FULL_FREEZE         = 0n;
const FREEZE_MODE_DEPOSIT_ONLY_FREEZE = 1n;

const S = {
    WATCH: 0, CONFIRMED_DEPEG: 1,
    PROTECTION_PENDING: 2, PARTIALLY_PROTECTED: 3, PROTECTED: 4,
    RECOVERY_PENDING: 5, PARTIALLY_RECOVERED: 6,
    NORMAL: 7, EXPIRED: 8, FAILED: 9, SUPERSEDED: 10,
};

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

function addrToBytes32(addr) {
    return ethers.zeroPadValue(addr, 32);
}

describe("FreezeMode — ExposureRegistry + StableGuardCREReceiver", function () {
    let receiver, registry, eventRegistry, vault, holdLedger;
    let forwarder, admin, coinA;

    beforeEach(async function () {
        [forwarder, admin, coinA] = await ethers.getSigners();

        const ExposureRegistry = await ethers.getContractFactory("ExposureRegistry");
        registry = await ExposureRegistry.deploy(admin.address);

        const MockVault = await ethers.getContractFactory("MockVault");
        vault = await MockVault.deploy();

        const DepegEventRegistry = await ethers.getContractFactory("DepegEventRegistry");
        eventRegistry = await DepegEventRegistry.deploy(
            admin.address,
            WATCH_THRESHOLD,
            CONFIRMED_THRESHOLD,
            STABILITY_WINDOW,
            EVENT_TTL,
            PENDING_TTL,
            RECOVERY_COOLDOWN
        );

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

        await eventRegistry.connect(admin).setHoldLedger(await holdLedger.getAddress());
        await eventRegistry.connect(admin).transferController(await receiver.getAddress());
        await holdLedger.connect(admin).transferCoordinator(await receiver.getAddress());
    });

    // ── helpers ───────────────────────────────────────────────────────────────

    async function registerAndAlert(mode) {
        const vaultAddr = await vault.getAddress();
        await registry.connect(admin).registerExposure(vaultAddr, addrToBytes32(coinA.address));
        if (mode !== undefined) {
            await registry.connect(admin).setFreezeMode(vaultAddr, mode);
        }
        const alert = encodeReport([coinA.address], [2], 2);
        await receiver.connect(forwarder).onReport("0x", alert);
    }

    async function driveToRecovery() {
        // STABILITY_WINDOW stable reports → RECOVERY_PENDING, vault unfrozen
        const stable = encodeReport([coinA.address], [0], 0);
        for (let i = 0; i < STABILITY_WINDOW; i++) {
            await receiver.connect(forwarder).onReport("0x", stable);
        }
    }

    // ── default mode ──────────────────────────────────────────────────────────

    describe("default freeze mode", function () {
        it("is FULL_FREEZE (zero) for a newly registered vault without an explicit setFreezeMode call", async function () {
            const vaultAddr = await vault.getAddress();
            await registry.connect(admin).registerExposure(vaultAddr, addrToBytes32(coinA.address));
            expect(await registry.vaultFreezeMode(vaultAddr)).to.equal(FREEZE_MODE_FULL_FREEZE);
        });

        it("is FULL_FREEZE for a vault address that was never registered at all", async function () {
            expect(await registry.vaultFreezeMode(ethers.Wallet.createRandom().address))
                .to.equal(FREEZE_MODE_FULL_FREEZE);
        });
    });

    // ── setFreezeMode access control and events ───────────────────────────────

    describe("setFreezeMode", function () {
        it("reverts when caller is not the admin", async function () {
            const [, , , nonAdmin] = await ethers.getSigners();
            await expect(
                registry.connect(nonAdmin).setFreezeMode(await vault.getAddress(), FREEZE_MODE_DEPOSIT_ONLY_FREEZE)
            ).to.be.revertedWithCustomError(registry, "NotAdmin");
        });

        it("reverts with ZeroAddress for the zero vault address", async function () {
            await expect(
                registry.connect(admin).setFreezeMode(ethers.ZeroAddress, FREEZE_MODE_DEPOSIT_ONLY_FREEZE)
            ).to.be.revertedWithCustomError(registry, "ZeroAddress");
        });

        it("stores the mode and emits FreezeModeUpdated", async function () {
            const vaultAddr = await vault.getAddress();
            await expect(
                registry.connect(admin).setFreezeMode(vaultAddr, FREEZE_MODE_DEPOSIT_ONLY_FREEZE)
            )
                .to.emit(registry, "FreezeModeUpdated")
                .withArgs(vaultAddr, FREEZE_MODE_DEPOSIT_ONLY_FREEZE);

            expect(await registry.vaultFreezeMode(vaultAddr)).to.equal(FREEZE_MODE_DEPOSIT_ONLY_FREEZE);
        });

        it("can be updated back to FULL_FREEZE after being set to DEPOSIT_ONLY_FREEZE", async function () {
            const vaultAddr = await vault.getAddress();
            await registry.connect(admin).setFreezeMode(vaultAddr, FREEZE_MODE_DEPOSIT_ONLY_FREEZE);
            await registry.connect(admin).setFreezeMode(vaultAddr, FREEZE_MODE_FULL_FREEZE);
            expect(await registry.vaultFreezeMode(vaultAddr)).to.equal(FREEZE_MODE_FULL_FREEZE);
        });
    });

    // ── FULL_FREEZE (regression — existing behaviour) ─────────────────────────

    describe("FULL_FREEZE (default behaviour)", function () {
        it("CONFIRMED_DEPEG pauses vault completely — both paused and depositsFrozen flags checked", async function () {
            await registerAndAlert(/* default, no explicit setFreezeMode */);
            expect(await vault.paused()).to.equal(true);
            expect(await vault.depositsFrozen()).to.equal(false);
            expect(await vault.pauseCallCount()).to.equal(1n);
            expect(await vault.depositPauseCallCount()).to.equal(0n);
        });

        it("recovery under FULL_FREEZE calls unpause() not unpauseDeposits()", async function () {
            await registerAndAlert();
            expect(await vault.paused()).to.equal(true);
            await driveToRecovery();
            expect(await vault.paused()).to.equal(false);
            expect(await vault.depositsFrozen()).to.equal(false);
        });
    });

    // ── DEPOSIT_ONLY_FREEZE ───────────────────────────────────────────────────

    describe("DEPOSIT_ONLY_FREEZE", function () {
        it("CONFIRMED_DEPEG freezes deposits but leaves vault.paused false", async function () {
            await registerAndAlert(FREEZE_MODE_DEPOSIT_ONLY_FREEZE);
            expect(await vault.paused()).to.equal(false);
            expect(await vault.depositsFrozen()).to.equal(true);
            expect(await vault.pauseCallCount()).to.equal(0n);
            expect(await vault.depositPauseCallCount()).to.equal(1n);
        });

        it("recovery under DEPOSIT_ONLY_FREEZE calls unpauseDeposits() not unpause()", async function () {
            await registerAndAlert(FREEZE_MODE_DEPOSIT_ONLY_FREEZE);
            expect(await vault.depositsFrozen()).to.equal(true);
            await driveToRecovery();
            expect(await vault.paused()).to.equal(false);
            expect(await vault.depositsFrozen()).to.equal(false);
        });
    });

    // ── mid-incident mode changes ─────────────────────────────────────────────

    describe("mode changed mid-incident", function () {
        it("FULL_FREEZE → DEPOSIT_ONLY_FREEZE: recovery still calls unpause() because vault.paused is true", async function () {
            // Incident opens under FULL_FREEZE → vault.pause() is called
            await registerAndAlert();
            expect(await vault.paused()).to.equal(true);
            expect(await vault.depositsFrozen()).to.equal(false);

            // Customer switches mode mid-incident
            await registry.connect(admin).setFreezeMode(
                await vault.getAddress(), FREEZE_MODE_DEPOSIT_ONLY_FREEZE
            );

            // Recovery reads vault.paused() == true → calls unpause() (state-based, not mode-based)
            await driveToRecovery();
            expect(await vault.paused()).to.equal(false);
            expect(await vault.depositsFrozen()).to.equal(false);
        });

        it("DEPOSIT_ONLY_FREEZE → FULL_FREEZE: recovery still calls unpauseDeposits() because depositsFrozen is true", async function () {
            // Incident opens under DEPOSIT_ONLY_FREEZE → vault.pauseDeposits() is called
            await registerAndAlert(FREEZE_MODE_DEPOSIT_ONLY_FREEZE);
            expect(await vault.paused()).to.equal(false);
            expect(await vault.depositsFrozen()).to.equal(true);

            // Customer switches mode mid-incident
            await registry.connect(admin).setFreezeMode(
                await vault.getAddress(), FREEZE_MODE_FULL_FREEZE
            );

            // Recovery reads vault.depositsFrozen() == true → calls unpauseDeposits() (state-based)
            await driveToRecovery();
            expect(await vault.paused()).to.equal(false);
            expect(await vault.depositsFrozen()).to.equal(false);
        });
    });

    // ── regression: existing milestone tests are unaffected ───────────────────

    describe("existing behaviour regression", function () {
        it("VaultExposureMissing still emitted when vault has no exposure registered (FULL_FREEZE default)", async function () {
            const vaultAddr = await vault.getAddress();
            const alert = encodeReport([coinA.address], [2], 2);
            await expect(receiver.connect(forwarder).onReport("0x", alert))
                .to.emit(receiver, "VaultExposureMissing")
                .withArgs(vaultAddr, addrToBytes32(coinA.address));
            expect(await vault.paused()).to.equal(false);
        });

        it("B-01 invariant holds under DEPOSIT_ONLY_FREEZE: second coin skips pauseDeposits(), depositPauseCallCount == 1", async function () {
            const [, , coinA2, coinB2] = await ethers.getSigners();
            const vaultAddr = await vault.getAddress();
            const symA = addrToBytes32(coinA2.address);
            const symB = addrToBytes32(coinB2.address);

            await registry.connect(admin).registerExposure(vaultAddr, symA);
            await registry.connect(admin).registerExposure(vaultAddr, symB);
            await registry.connect(admin).setFreezeMode(vaultAddr, FREEZE_MODE_DEPOSIT_ONLY_FREEZE);

            const report = encodeReport([coinA2.address, coinB2.address], [2, 2], 2);
            await receiver.connect(forwarder).onReport("0x", report);

            expect(await vault.depositPauseCallCount()).to.equal(1n);
            expect(await vault.depositsFrozen()).to.equal(true);
            expect(await vault.paused()).to.equal(false);
            expect(await holdLedger.activeHoldCount(vaultAddr)).to.equal(2n);
        });
    });
});
