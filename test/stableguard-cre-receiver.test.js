"use strict";

const { ethers } = require("hardhat");
const { expect } = require("chai");
const { time } = require("@nomicfoundation/hardhat-network-helpers");

describe("StableGuardCREReceiver", function () {
    let receiver;

    beforeEach(async function () {
        const StableGuardCREReceiver = await ethers.getContractFactory("StableGuardCREReceiver");
        receiver = await StableGuardCREReceiver.deploy(
            ethers.ZeroAddress,  // forwarder
            ethers.ZeroAddress,  // exposureRegistry
            ethers.ZeroAddress,  // eventRegistry
            ethers.ZeroAddress,  // vault
            1n,                  // localChainSelector
            ethers.ZeroAddress,  // holdLedger
            3600n                // maxReportAge
        );
        await receiver.waitForDeployment();
    });

    describe("supportsInterface", function () {
        it("returns true for IReceiver (0x805f2132)", async function () {
            expect(await receiver.supportsInterface("0x805f2132")).to.equal(true);
        });

        it("returns true for IERC165 (0x01ffc9a7)", async function () {
            expect(await receiver.supportsInterface("0x01ffc9a7")).to.equal(true);
        });

        it("returns false for unsupported (0xffffffff)", async function () {
            expect(await receiver.supportsInterface("0xffffffff")).to.equal(false);
        });
    });

    // ── Recovery-resume guard ──────────────────────────────────────────────────
    // Bug: recovery-continuation check (eventId==0 && vault.paused()) fires for
    // every coin in the report, including healthy bystanders that never had a hold.
    // Fix: add _coinHoldId[coin] != bytes32(0) so only coins with an active hold
    // can trigger resumeProtectionTracking.

    describe("recovery-resume guard", function () {
        let receiver, registry, eventRegistry, holdLedger, vault;
        let forwarder, admin, coinA, coinB;

        const WATCH_THRESHOLD      = 1;
        const CONFIRMED_THRESHOLD  = 2;
        const STABILITY_WINDOW     = 3;
        const EVENT_TTL            = 86400n;
        const PENDING_TTL          = 3600n;
        const RECOVERY_COOLDOWN    = 900n;
        const MAX_REPORT_AGE       = 604800n;
        const LOCAL_CHAIN_SELECTOR = 1n;

        let _ts;

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

        beforeEach(async function () {
            [forwarder, admin, coinA, coinB] = await ethers.getSigners();
            _ts = BigInt((await ethers.provider.getBlock("latest")).timestamp) - 1000n;

            const MockVaultFactory = await ethers.getContractFactory("MockVault");
            vault = await MockVaultFactory.deploy();

            const LedgerFactory = await ethers.getContractFactory("ProtectionHoldLedger");
            holdLedger = await LedgerFactory.deploy(admin.address, admin.address);

            const ExposureRegistryFactory = await ethers.getContractFactory("ExposureRegistry");
            registry = await ExposureRegistryFactory.deploy(admin.address);

            const DepegEventRegistryFactory = await ethers.getContractFactory("DepegEventRegistry");
            eventRegistry = await DepegEventRegistryFactory.deploy(
                admin.address,
                WATCH_THRESHOLD,
                CONFIRMED_THRESHOLD,
                STABILITY_WINDOW,
                EVENT_TTL,
                PENDING_TTL,
                RECOVERY_COOLDOWN
            );

            const ReceiverFactory = await ethers.getContractFactory("StableGuardCREReceiver");
            receiver = await ReceiverFactory.deploy(
                forwarder.address,
                await registry.getAddress(),
                await eventRegistry.getAddress(),
                await vault.getAddress(),
                LOCAL_CHAIN_SELECTOR,
                await holdLedger.getAddress(),
                MAX_REPORT_AGE
            );

            await eventRegistry.connect(admin).setHoldLedger(await holdLedger.getAddress());
            await eventRegistry.connect(admin).transferController(await receiver.getAddress());
            await holdLedger.connect(admin).transferCoordinator(await receiver.getAddress());
            // Only coinA is exposed; coinB is a healthy bystander with no history
            await registry.connect(admin).registerExposure(
                await vault.getAddress(), addrToBytes32(coinA.address)
            );
        });

        it("healthy bystander coin emits no RecoveryResumeFailed while vault is paused by another coin", async function () {
            // coinA depegs → vault paused, hold acquired for coinA
            await receiver.connect(forwarder).onReport("0x",
                encodeReport([coinA.address], [2], 2));
            expect(await vault.paused()).to.equal(true,
                "vault should be paused after coinA depeg");

            // coinB is healthy (level 0) and has _coinHoldId == 0; vault is still paused
            const tx = await receiver.connect(forwarder).onReport("0x",
                encodeReport([coinB.address], [0], 0));
            const receipt = await tx.wait();

            const resumeFailedEvents = receipt.logs
                .map(l => { try { return receiver.interface.parseLog(l); } catch { return null; } })
                .filter(e => e && e.name === "RecoveryResumeFailed");

            expect(resumeFailedEvents.length).to.equal(0,
                "RecoveryResumeFailed must not fire for a coin that was never in a depeg/protected state");
        });

        it("expired-event coin with active hold triggers resumeProtectionTracking successfully", async function () {
            // coinA depegs → PROTECTED, hold acquired, vault paused
            await receiver.connect(forwarder).onReport("0x",
                encodeReport([coinA.address], [2], 2));
            expect(await vault.paused()).to.equal(true,
                "vault should be paused after coinA depeg");

            // Advance past EVENT_TTL so the next processReport terminates the event to EXPIRED
            await time.increase(Number(EVENT_TTL) + 1);

            // First post-TTL report: processReport returns (eventId_A, EXPIRED)
            // eventId != bytes32(0), so the resume block is not entered yet
            await receiver.connect(forwarder).onReport("0x",
                encodeReport([coinA.address], [0], 0));

            // Second post-TTL report: processReport returns (bytes32(0), NORMAL) since
            // activeEventId is now cleared; _coinHoldId[coinA] is still set → resume fires
            const tx = await receiver.connect(forwarder).onReport("0x",
                encodeReport([coinA.address], [0], 0));
            const receipt = await tx.wait();

            // resumeProtectionTracking must have succeeded — no failure event
            const resumeFailedEvents = receipt.logs
                .map(l => { try { return receiver.interface.parseLog(l); } catch { return null; } })
                .filter(e => e && e.name === "RecoveryResumeFailed");
            expect(resumeFailedEvents.length).to.equal(0,
                "resumeProtectionTracking should succeed when the hold is still active and lineage is valid");

            // A fresh PROTECTED event is now active for coinA
            const activeId = await eventRegistry.getActiveEventId(coinA.address);
            expect(activeId).to.not.equal(ethers.ZeroHash,
                "a fresh PROTECTED event should exist after a successful resume");
        });
    });

    // ── Workflow auth guard (B-03) ─────────────────────────────────────────────
    // Metadata layout from KeystoneForwarder (abi.encodePacked):
    //   bytes32 workflowId | bytes10 workflowName | address workflowOwner | bytes2 reportId
    // = 32 + 10 + 20 + 2 = 64 bytes total; checks require >= 62 bytes.

    describe("workflow auth (B-03)", function () {
        let receiver, deployer, fwd, other;
        let workflowId, workflowOwner;

        function makeReport(observedAt) {
            const coder = ethers.AbiCoder.defaultAbiCoder();
            return coder.encode(
                ["address[]", "uint256[]", "uint256[]", "uint8[]", "bytes[]", "uint8", "uint8", "uint256"],
                [[], [], [], [], [], 0, 0, observedAt]
            );
        }

        function makeMetadata(owner, wfId) {
            return ethers.solidityPacked(
                ["bytes32", "bytes10", "address", "bytes2"],
                [wfId, "0x00000000000000000000", owner, "0x0000"]
            );
        }

        beforeEach(async function () {
            [deployer, fwd, other] = await ethers.getSigners();
            workflowId    = ethers.id("test-workflow");
            workflowOwner = deployer.address;

            const ReceiverFactory = await ethers.getContractFactory("StableGuardCREReceiver");
            receiver = await ReceiverFactory.deploy(
                fwd.address,         // forwarder
                ethers.ZeroAddress,  // exposureRegistry
                ethers.ZeroAddress,  // eventRegistry
                ethers.ZeroAddress,  // vault
                1n,                  // localChainSelector
                ethers.ZeroAddress,  // holdLedger
                3600n                // maxReportAge
            );
            await receiver.waitForDeployment();
            // deployer is admin (constructor sets admin = msg.sender)
        });

        async function currentTs() {
            return BigInt((await ethers.provider.getBlock("latest")).timestamp);
        }

        it("T1: wrong workflowOwner rejected, reportCount unchanged", async function () {
            await receiver.connect(deployer).setExpectedWorkflowOwner(workflowOwner);
            const wrongOwner = other.address;
            const meta = makeMetadata(wrongOwner, workflowId);
            const report = makeReport((await currentTs()) - 10n);
            await expect(
                receiver.connect(fwd).onReport(meta, report)
            ).to.be.revertedWithCustomError(receiver, "UnauthorizedWorkflow")
             .withArgs(wrongOwner, workflowId);
            expect(await receiver.reportCount()).to.equal(0n);
        });

        it("T2: wrong workflowId rejected", async function () {
            await receiver.connect(deployer).setExpectedWorkflowId(workflowId);
            const wrongId = ethers.id("wrong-workflow");
            const meta = makeMetadata(workflowOwner, wrongId);
            const report = makeReport((await currentTs()) - 10n);
            await expect(
                receiver.connect(fwd).onReport(meta, report)
            ).to.be.revertedWithCustomError(receiver, "UnauthorizedWorkflow")
             .withArgs(workflowOwner, wrongId);
        });

        it("T3: correct metadata accepted, reportCount increments", async function () {
            await receiver.connect(deployer).setExpectedWorkflowOwner(workflowOwner);
            await receiver.connect(deployer).setExpectedWorkflowId(workflowId);
            const meta = makeMetadata(workflowOwner, workflowId);
            const report = makeReport((await currentTs()) - 10n);
            await receiver.connect(fwd).onReport(meta, report);
            expect(await receiver.reportCount()).to.equal(1n);
        });

        it("T4: both checks unset (zero) — any metadata accepted", async function () {
            const report = makeReport((await currentTs()) - 10n);
            await receiver.connect(fwd).onReport("0x", report);
            expect(await receiver.reportCount()).to.equal(1n);
        });

        it("T5: non-forwarder rejected before metadata check", async function () {
            await receiver.connect(deployer).setExpectedWorkflowOwner(workflowOwner);
            const meta = makeMetadata(workflowOwner, workflowId);
            const report = makeReport((await currentTs()) - 10n);
            await expect(
                receiver.connect(other).onReport(meta, report)
            ).to.be.revertedWithCustomError(receiver, "UnauthorizedForwarder")
             .withArgs(other.address);
        });

        it("T6: metadata shorter than 62 bytes reverts InvalidMetadata", async function () {
            await receiver.connect(deployer).setExpectedWorkflowOwner(workflowOwner);
            const shortMeta = "0x" + "aa".repeat(61); // 61 bytes < 62
            const report = makeReport((await currentTs()) - 10n);
            await expect(
                receiver.connect(fwd).onReport(shortMeta, report)
            ).to.be.revertedWithCustomError(receiver, "InvalidMetadata")
             .withArgs(61n);
        });

        it("non-admin cannot call setExpectedWorkflowOwner", async function () {
            await expect(
                receiver.connect(other).setExpectedWorkflowOwner(workflowOwner)
            ).to.be.revertedWithCustomError(receiver, "UnauthorizedAdmin")
             .withArgs(other.address);
        });

        it("non-admin cannot call setExpectedWorkflowId", async function () {
            await expect(
                receiver.connect(other).setExpectedWorkflowId(workflowId)
            ).to.be.revertedWithCustomError(receiver, "UnauthorizedAdmin")
             .withArgs(other.address);
        });

        it("non-admin cannot call transferAdmin", async function () {
            await expect(
                receiver.connect(other).transferAdmin(other.address)
            ).to.be.revertedWithCustomError(receiver, "UnauthorizedAdmin")
             .withArgs(other.address);
        });

        it("transferAdmin to zero address reverts ZeroAddress", async function () {
            await expect(
                receiver.connect(deployer).transferAdmin(ethers.ZeroAddress)
            ).to.be.revertedWithCustomError(receiver, "ZeroAddress");
        });
    });
});
