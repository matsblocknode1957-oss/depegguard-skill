"use strict";

const { ethers } = require("hardhat");
const { expect }  = require("chai");
const { anyValue } = require("@nomicfoundation/hardhat-chai-matchers/withArgs");

const ASSET_A = ethers.keccak256(ethers.toUtf8Bytes("USDC"));
const ASSET_B = ethers.keccak256(ethers.toUtf8Bytes("USDT"));
const ROOT_A  = ethers.keccak256(ethers.toUtf8Bytes("incident-A"));
const ROOT_B  = ethers.keccak256(ethers.toUtf8Bytes("incident-B"));

describe("ProtectionHoldLedger", function () {
    let ledger;
    let coordinator, other;
    let vaultA, vaultB;

    beforeEach(async function () {
        [coordinator, other, vaultA, vaultB] = await ethers.getSigners();
        const Factory = await ethers.getContractFactory("ProtectionHoldLedger");
        ledger = await Factory.deploy(coordinator.address);
    });

    // Parse holdId from HoldAcquired event log
    async function acquireHold(vault, root = ROOT_A, asset = ASSET_A) {
        const tx = await ledger.connect(coordinator).acquire(vault.address, root, asset);
        const receipt = await tx.wait();
        const parsed = receipt.logs
            .map(l => { try { return ledger.interface.parseLog(l); } catch { return null; } })
            .find(e => e && e.name === "HoldAcquired");
        return parsed.args.holdId;
    }

    // ── constructor ────────────────────────────────────────────────────────────

    describe("constructor", function () {
        it("sets coordinator", async function () {
            expect(await ledger.coordinator()).to.equal(coordinator.address);
        });

        it("reverts with zero coordinator address", async function () {
            const Factory = await ethers.getContractFactory("ProtectionHoldLedger");
            await expect(Factory.deploy(ethers.ZeroAddress))
                .to.be.revertedWithCustomError(ledger, "ZeroAddress");
        });
    });

    // ── acquire ────────────────────────────────────────────────────────────────

    describe("acquire", function () {
        it("returns a non-zero holdId via emitted event", async function () {
            const holdId = await acquireHold(vaultA);
            expect(holdId).to.not.equal(ethers.ZeroHash);
        });

        it("writes all struct fields correctly", async function () {
            const holdId = await acquireHold(vaultA);
            const h = await ledger.holds(holdId);
            expect(h.holdId).to.equal(holdId);
            expect(h.rootIncidentId).to.equal(ROOT_A);
            expect(h.assetId).to.equal(ASSET_A);
            expect(h.vault).to.equal(vaultA.address);
            expect(h.active).to.equal(true);
        });

        it("increments activeHoldCount for the vault", async function () {
            expect(await ledger.activeHoldCount(vaultA.address)).to.equal(0);
            await acquireHold(vaultA, ROOT_A, ASSET_A);
            expect(await ledger.activeHoldCount(vaultA.address)).to.equal(1);
            await acquireHold(vaultA, ROOT_B, ASSET_B);
            expect(await ledger.activeHoldCount(vaultA.address)).to.equal(2);
        });

        it("different vaults have independent counts", async function () {
            await acquireHold(vaultA, ROOT_A, ASSET_A);
            await acquireHold(vaultB, ROOT_B, ASSET_B);
            expect(await ledger.activeHoldCount(vaultA.address)).to.equal(1);
            expect(await ledger.activeHoldCount(vaultB.address)).to.equal(1);
        });

        it("produces unique holdIds for distinct calls", async function () {
            const idFirst  = await acquireHold(vaultA, ROOT_A, ASSET_A);
            const idSecond = await acquireHold(vaultA, ROOT_B, ASSET_B);
            expect(idFirst).to.not.equal(idSecond);
        });

        it("emits HoldAcquired with correct args", async function () {
            await expect(ledger.connect(coordinator).acquire(vaultA.address, ROOT_A, ASSET_A))
                .to.emit(ledger, "HoldAcquired")
                .withArgs(anyValue, ROOT_A, ASSET_A, vaultA.address);
        });

        it("reverts from non-coordinator", async function () {
            await expect(
                ledger.connect(other).acquire(vaultA.address, ROOT_A, ASSET_A)
            ).to.be.revertedWithCustomError(ledger, "Unauthorized");
        });

        it("reverts with zero vault address", async function () {
            await expect(
                ledger.connect(coordinator).acquire(ethers.ZeroAddress, ROOT_A, ASSET_A)
            ).to.be.revertedWithCustomError(ledger, "ZeroAddress");
        });
    });

    // ── release ────────────────────────────────────────────────────────────────

    describe("release", function () {
        it("marks the hold as inactive", async function () {
            const holdId = await acquireHold(vaultA);
            await ledger.connect(coordinator).release(holdId);
            const h = await ledger.holds(holdId);
            expect(h.active).to.equal(false);
        });

        it("decrements activeHoldCount for the vault", async function () {
            const holdId = await acquireHold(vaultA);
            expect(await ledger.activeHoldCount(vaultA.address)).to.equal(1);
            await ledger.connect(coordinator).release(holdId);
            expect(await ledger.activeHoldCount(vaultA.address)).to.equal(0);
        });

        it("returns true (vaultFullyReleased) when the last hold on a vault is released", async function () {
            const holdId = await acquireHold(vaultA);
            const fully = await ledger.connect(coordinator).release.staticCall(holdId);
            expect(fully).to.equal(true);
        });

        it("returns false when another hold remains on the same vault", async function () {
            const holdId1 = await acquireHold(vaultA, ROOT_A, ASSET_A);
            await acquireHold(vaultA, ROOT_B, ASSET_B);
            const fully = await ledger.connect(coordinator).release.staticCall(holdId1);
            expect(fully).to.equal(false);
        });

        it("count is 1 after releasing one of two holds, then 0 after releasing the second", async function () {
            const holdId1 = await acquireHold(vaultA, ROOT_A, ASSET_A);
            const holdId2 = await acquireHold(vaultA, ROOT_B, ASSET_B);
            await ledger.connect(coordinator).release(holdId1);
            expect(await ledger.activeHoldCount(vaultA.address)).to.equal(1);
            await ledger.connect(coordinator).release(holdId2);
            expect(await ledger.activeHoldCount(vaultA.address)).to.equal(0);
        });

        it("releasing one vault's hold does not affect another vault's count", async function () {
            const holdIdA = await acquireHold(vaultA, ROOT_A, ASSET_A);
            await acquireHold(vaultB, ROOT_B, ASSET_B);
            await ledger.connect(coordinator).release(holdIdA);
            expect(await ledger.activeHoldCount(vaultA.address)).to.equal(0);
            expect(await ledger.activeHoldCount(vaultB.address)).to.equal(1);
        });

        it("emits HoldReleased with vaultFullyReleased=true on last hold", async function () {
            const holdId = await acquireHold(vaultA);
            await expect(ledger.connect(coordinator).release(holdId))
                .to.emit(ledger, "HoldReleased")
                .withArgs(holdId, vaultA.address, true);
        });

        it("emits HoldReleased with vaultFullyReleased=false when a hold remains", async function () {
            const holdId1 = await acquireHold(vaultA, ROOT_A, ASSET_A);
            await acquireHold(vaultA, ROOT_B, ASSET_B);
            await expect(ledger.connect(coordinator).release(holdId1))
                .to.emit(ledger, "HoldReleased")
                .withArgs(holdId1, vaultA.address, false);
        });

        it("reverts from non-coordinator", async function () {
            const holdId = await acquireHold(vaultA);
            await expect(
                ledger.connect(other).release(holdId)
            ).to.be.revertedWithCustomError(ledger, "Unauthorized");
        });

        it("reverts HoldNotFound for an unknown holdId", async function () {
            await expect(
                ledger.connect(coordinator).release(ethers.ZeroHash)
            ).to.be.revertedWithCustomError(ledger, "HoldNotFound")
              .withArgs(ethers.ZeroHash);
        });

        it("reverts HoldAlreadyReleased on double-release", async function () {
            const holdId = await acquireHold(vaultA);
            await ledger.connect(coordinator).release(holdId);
            await expect(
                ledger.connect(coordinator).release(holdId)
            ).to.be.revertedWithCustomError(ledger, "HoldAlreadyReleased")
              .withArgs(holdId);
        });

        // Hold identity: the struct fields from holds[holdId] survive release correctly
        it("released hold retains correct identity fields with active=false", async function () {
            const holdId = await acquireHold(vaultA);
            await ledger.connect(coordinator).release(holdId);
            const h = await ledger.holds(holdId);
            expect(h.holdId).to.equal(holdId);
            expect(h.rootIncidentId).to.equal(ROOT_A);
            expect(h.assetId).to.equal(ASSET_A);
            expect(h.vault).to.equal(vaultA.address);
            expect(h.active).to.equal(false);
        });
    });

    // ── transferCoordinator ────────────────────────────────────────────────────

    describe("transferCoordinator", function () {
        it("transfers the coordinator role", async function () {
            await ledger.connect(coordinator).transferCoordinator(other.address);
            expect(await ledger.coordinator()).to.equal(other.address);
        });

        it("new coordinator can acquire holds; old coordinator cannot", async function () {
            await ledger.connect(coordinator).transferCoordinator(other.address);
            await expect(
                ledger.connect(coordinator).acquire(vaultA.address, ROOT_A, ASSET_A)
            ).to.be.revertedWithCustomError(ledger, "Unauthorized");
            await expect(
                ledger.connect(other).acquire(vaultA.address, ROOT_A, ASSET_A)
            ).to.emit(ledger, "HoldAcquired");
        });

        it("emits CoordinatorTransferred", async function () {
            await expect(ledger.connect(coordinator).transferCoordinator(other.address))
                .to.emit(ledger, "CoordinatorTransferred")
                .withArgs(coordinator.address, other.address);
        });

        it("reverts from non-coordinator", async function () {
            await expect(
                ledger.connect(other).transferCoordinator(other.address)
            ).to.be.revertedWithCustomError(ledger, "Unauthorized");
        });

        it("reverts with zero address", async function () {
            await expect(
                ledger.connect(coordinator).transferCoordinator(ethers.ZeroAddress)
            ).to.be.revertedWithCustomError(ledger, "ZeroAddress");
        });
    });
});
