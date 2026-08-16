"use strict";

const { ethers } = require("hardhat");
const { expect } = require("chai");

const PAUSE_THRESHOLD = 2;

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
    let receiver, registry, vault;
    let forwarder, admin, coinA, coinB;

    beforeEach(async function () {
        [forwarder, admin, coinA, coinB] = await ethers.getSigners();

        const ExposureRegistry = await ethers.getContractFactory("ExposureRegistry");
        registry = await ExposureRegistry.deploy(admin.address);

        const MockVault = await ethers.getContractFactory("MockVault");
        vault = await MockVault.deploy();

        const StableGuardCREReceiver = await ethers.getContractFactory("StableGuardCREReceiver");
        receiver = await StableGuardCREReceiver.deploy(
            forwarder.address,
            await registry.getAddress(),
            await vault.getAddress(),
            PAUSE_THRESHOLD
        );
    });

    it("emits VaultExposureMissing and does not pause when vault holds B but alert is for A", async function () {
        const vaultAddr = await vault.getAddress();
        await registry
            .connect(admin)
            .registerExposure(vaultAddr, addrToBytes32(coinB.address));

        const report = encodeReport([coinA.address], [1], PAUSE_THRESHOLD);
        await expect(receiver.connect(forwarder).onReport("0x", report))
            .to.emit(receiver, "VaultExposureMissing")
            .withArgs(vaultAddr, addrToBytes32(coinA.address));

        expect(await vault.paused()).to.equal(false);
    });

    it("pauses vault when it holds the alerted asset", async function () {
        await registry
            .connect(admin)
            .registerExposure(await vault.getAddress(), addrToBytes32(coinA.address));

        const report = encodeReport([coinA.address], [1], PAUSE_THRESHOLD);
        await receiver.connect(forwarder).onReport("0x", report);

        expect(await vault.paused()).to.equal(true);
    });

    it("emits VaultExposureMissing and does not pause when vault has no exposure registered", async function () {
        const vaultAddr = await vault.getAddress();
        const report = encodeReport([coinA.address], [1], PAUSE_THRESHOLD);
        await expect(receiver.connect(forwarder).onReport("0x", report))
            .to.emit(receiver, "VaultExposureMissing")
            .withArgs(vaultAddr, addrToBytes32(coinA.address));

        expect(await vault.paused()).to.equal(false);
    });

    it("emits VaultExposureMissing and does not pause after exposure is revoked", async function () {
        const vaultAddr = await vault.getAddress();
        const symA = addrToBytes32(coinA.address);
        await registry.connect(admin).registerExposure(vaultAddr, symA);

        const report = encodeReport([coinA.address], [1], PAUSE_THRESHOLD);

        // First alert pauses successfully
        await receiver.connect(forwarder).onReport("0x", report);
        expect(await vault.paused()).to.equal(true);
        await vault.unpause();

        // Revoke then re-alert
        await registry.connect(admin).revokeExposure(vaultAddr, symA);
        await expect(receiver.connect(forwarder).onReport("0x", report))
            .to.emit(receiver, "VaultExposureMissing")
            .withArgs(vaultAddr, addrToBytes32(coinA.address));
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
            [1, 1],
            PAUSE_THRESHOLD
        );

        await expect(receiver.connect(forwarder).onReport("0x", report))
            .to.emit(receiver, "VaultExposureMissing")
            .withArgs(vaultAddr, addrToBytes32(coinA.address));

        // coinB was registered, so pause still fires despite coinA being skipped
        expect(await vault.paused()).to.equal(true);
    });
});
