"use strict";

const { ethers } = require("hardhat");
const { expect } = require("chai");
const { time } = require("@nomicfoundation/hardhat-network-helpers");

describe("CustomerOverrideModule — 25 edge cases", function () {

    // ── Constants ─────────────────────────────────────────────────────────────

    const MAX_HOLD_DURATION   = 7200n;   // 2 hours
    const SUPPRESSION_WINDOW  = 3600n;   // 1 hour
    const WATCH_THRESHOLD     = 1;
    const CONFIRMED_THRESHOLD = 2;
    const STABILITY_WINDOW    = 3;
    const EVENT_TTL           = 86400n;
    const PENDING_TTL         = 3600n;
    const RECOVERY_COOLDOWN   = 900n;
    const MAX_REPORT_AGE      = 604800n;
    const LOCAL_CHAIN_SELECTOR = 1n;

    // ── Accounts ──────────────────────────────────────────────────────────────

    let governance, admin, forwarder, safeOwner, stranger, coin, coordinator;

    // ── Contracts ─────────────────────────────────────────────────────────────

    let asset, vault, registry, holdLedger, eventRegistry, receiver, overrideModule, safeContract;

    let _ts;

    // ── Helpers ───────────────────────────────────────────────────────────────

    function encodeReport(coins, signalLevels, compositeScore) {
        _ts++;
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
                _ts,
            ]
        );
    }

    function addrToBytes32(addr) {
        return ethers.zeroPadValue(addr, 32);
    }

    // ── beforeEach ────────────────────────────────────────────────────────────

    beforeEach(async function () {
        [governance, admin, forwarder, safeOwner, stranger, coin, coordinator] =
            await ethers.getSigners();
        _ts = BigInt((await ethers.provider.getBlock("latest")).timestamp) - 1000n;

        const MockERC20Factory = await ethers.getContractFactory("MockERC20");
        asset = await MockERC20Factory.deploy("Test USD", "TUSD", 6);

        const VaultFactory = await ethers.getContractFactory("StableGuardVault");
        vault = await VaultFactory.deploy(
            await asset.getAddress(), "StableGuard Vault", "sgTUSD",
            governance.address
        );

        const ExposureFactory = await ethers.getContractFactory("ExposureRegistry");
        registry = await ExposureFactory.deploy(admin.address);

        const LedgerFactory = await ethers.getContractFactory("ProtectionHoldLedger");
        holdLedger = await LedgerFactory.deploy(governance.address, governance.address);

        const DepegFactory = await ethers.getContractFactory("DepegEventRegistry");
        eventRegistry = await DepegFactory.deploy(
            admin.address,
            WATCH_THRESHOLD, CONFIRMED_THRESHOLD, STABILITY_WINDOW,
            EVENT_TTL, PENDING_TTL, RECOVERY_COOLDOWN
        );

        // governance (signers[0]) is the implicit deployer — receiver.admin = governance
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

        const ModuleFactory = await ethers.getContractFactory("CustomerOverrideModule");
        overrideModule = await ModuleFactory.deploy(
            await holdLedger.getAddress(),
            MAX_HOLD_DURATION,
            SUPPRESSION_WINDOW,
            admin.address
        );

        const MockSafeFactory = await ethers.getContractFactory("MockSafe");
        safeContract = await MockSafeFactory.deploy(safeOwner.address);

        // ── Wiring ────────────────────────────────────────────────────────────
        await eventRegistry.connect(admin).setHoldLedger(await holdLedger.getAddress());
        await eventRegistry.connect(admin).transferController(await receiver.getAddress());
        await holdLedger.connect(governance).transferCoordinator(await receiver.getAddress());
        // Per-vault module approval: vault governance approves the module (FIX B)
        await holdLedger.connect(governance).approveVaultModule(
            await vault.getAddress(), await overrideModule.getAddress()
        );
        // Receiver setOverrideModule now requires GOVERNANCE_ROLE on vault (FIX B)
        await receiver.connect(governance).setOverrideModule(await overrideModule.getAddress());

        // Grant PAUSE_COORDINATOR_ROLE to receiver on vault
        const PC_ROLE = await vault.PAUSE_COORDINATOR_ROLE();
        await vault.connect(governance).grantRole(PC_ROLE, await receiver.getAddress());

        // For direct registerHold tests: grant role to coordinator EOA too (test-only)
        await vault.connect(governance).grantRole(PC_ROLE, coordinator.address);

        // Register coin exposure
        await registry.connect(admin).registerExposure(
            await vault.getAddress(), addrToBytes32(coin.address)
        );

        // Set override authority + receiver on module (governance has GOVERNANCE_ROLE on vault)
        await overrideModule.connect(governance).setVaultAuthority(
            await vault.getAddress(), await safeContract.getAddress()
        );
        await overrideModule.connect(governance).setVaultReceiver(
            await vault.getAddress(), await receiver.getAddress()
        );
    });

    // ── freezeVault: trigger one depeg report to freeze the vault ─────────────
    async function freezeVault() {
        await receiver.connect(forwarder).onReport("0x",
            encodeReport([coin.address], [CONFIRMED_THRESHOLD], CONFIRMED_THRESHOLD));
        expect(await vault.paused()).to.equal(true, "vault must be paused after freeze");
    }

    // ── advanceToRecovery: send STABILITY_WINDOW stable reports after freeze ──
    // No hold is placed — auto-recovery fires in the last stable report's onReport call.
    async function advanceToRecovery() {
        await freezeVault();
        for (let i = 0; i < STABILITY_WINDOW; i++) {
            await receiver.connect(forwarder).onReport("0x",
                encodeReport([coin.address], [0], 0));
        }
    }

    // ── advanceToRecoveryWithHold: freeze + placeHold + stability reports ─────
    // Places a hold before stability reports so the receiver calls markHoldPaused
    // instead of running normal recovery.  After this helper: event=RECOVERY_PENDING,
    // dest=HOLD_PAUSED, vault still frozen.
    async function advanceToRecoveryWithHold() {
        await freezeVault();
        await overrideModule.connect(safeOwner).placeHold(
            coin.address, await vault.getAddress()
        );
        for (let i = 0; i < STABILITY_WINDOW; i++) {
            await receiver.connect(forwarder).onReport("0x",
                encodeReport([coin.address], [0], 0));
        }
    }

    // ── Test 1 ────────────────────────────────────────────────────────────────
    it("1 — setVaultAuthority: reverts Unauthorized for non-GOVERNANCE_ROLE caller", async function () {
        await expect(
            overrideModule.connect(stranger).setVaultAuthority(
                await vault.getAddress(), safeOwner.address
            )
        ).to.be.revertedWithCustomError(overrideModule, "Unauthorized");
    });

    // ── Test 2 ────────────────────────────────────────────────────────────────
    it("2 — setVaultAuthority: stores override Safe and emits VaultAuthoritySet", async function () {
        // Deploy a fresh vault with no authority set
        const VaultFactory = await ethers.getContractFactory("StableGuardVault");
        const vault2 = await VaultFactory.deploy(
            await asset.getAddress(), "V2", "sgV2", governance.address
        );
        await expect(
            overrideModule.connect(governance).setVaultAuthority(
                await vault2.getAddress(), safeOwner.address
            )
        ).to.emit(overrideModule, "VaultAuthoritySet")
            .withArgs(await vault2.getAddress(), safeOwner.address);

        expect(await overrideModule.overrideAuthority(await vault2.getAddress()))
            .to.equal(safeOwner.address);
    });

    // ── Test 3 ────────────────────────────────────────────────────────────────
    it("3 — setVaultReceiver: reverts Unauthorized for non-GOVERNANCE_ROLE caller", async function () {
        await expect(
            overrideModule.connect(stranger).setVaultReceiver(
                await vault.getAddress(), await receiver.getAddress()
            )
        ).to.be.revertedWithCustomError(overrideModule, "Unauthorized");
    });

    // ── Test 4 ────────────────────────────────────────────────────────────────
    it("4 — registerHold: reverts Unauthorized if caller lacks PAUSE_COORDINATOR_ROLE", async function () {
        await expect(
            overrideModule.connect(stranger).registerHold(
                coin.address, await vault.getAddress(),
                ethers.ZeroHash, ethers.ZeroHash, 2
            )
        ).to.be.revertedWithCustomError(overrideModule, "Unauthorized");
    });

    // ── Test 5 ────────────────────────────────────────────────────────────────
    it("5 — registerHold: no-op (no hold stored) when vault has no overrideAuthority", async function () {
        // Deploy vault2 with no overrideAuthority configured
        const VaultFactory = await ethers.getContractFactory("StableGuardVault");
        const vault2 = await VaultFactory.deploy(
            await asset.getAddress(), "V2", "sgV2", governance.address
        );
        await vault2.connect(governance).grantRole(
            await vault2.PAUSE_COORDINATOR_ROLE(), coordinator.address
        );

        const fakeHoldId = ethers.keccak256(ethers.toUtf8Bytes("hold1"));
        const fakeRootId = ethers.keccak256(ethers.toUtf8Bytes("root1"));

        // Should not revert, but also not store a hold (authority is zero)
        await expect(
            overrideModule.connect(coordinator).registerHold(
                coin.address, await vault2.getAddress(), fakeRootId, fakeHoldId, 2
            )
        ).to.not.be.reverted;

        // No hold was stored
        expect(await overrideModule.isHoldActive(coin.address, await vault2.getAddress()))
            .to.equal(false);
    });

    // ── Test 6 ────────────────────────────────────────────────────────────────
    it("6 — registerHold: records slot; isHoldActive is false until placeHold is called", async function () {
        const fakeHoldId = ethers.keccak256(ethers.toUtf8Bytes("hold1"));
        const fakeRootId = ethers.keccak256(ethers.toUtf8Bytes("root1"));

        await expect(
            overrideModule.connect(coordinator).registerHold(
                coin.address, await vault.getAddress(), fakeRootId, fakeHoldId, 2
            )
        ).to.emit(overrideModule, "HoldSlotRegistered")
            .withArgs(coin.address, await vault.getAddress(), fakeRootId);

        // Slot is registered but hold is NOT yet active
        expect(await overrideModule.isHoldRegistered(coin.address, await vault.getAddress()))
            .to.equal(true);
        expect(await overrideModule.isHoldActive(coin.address, await vault.getAddress()))
            .to.equal(false);

        const h = await overrideModule.overrideHolds(coin.address, await vault.getAddress());
        expect(h.ledgerHoldId).to.equal(fakeHoldId);
        expect(h.rootIncidentId).to.equal(fakeRootId);
        expect(h.registered).to.equal(true);
        expect(h.holdUntil).to.equal(0n);
    });

    // ── Test 7 ────────────────────────────────────────────────────────────────
    it("7 — registerHold: idempotent overwrite — second call updates slot without revert", async function () {
        const fakeHoldId  = ethers.keccak256(ethers.toUtf8Bytes("hold1"));
        const fakeRootId  = ethers.keccak256(ethers.toUtf8Bytes("root1"));
        const fakeHoldId2 = ethers.keccak256(ethers.toUtf8Bytes("hold2"));
        const fakeRootId2 = ethers.keccak256(ethers.toUtf8Bytes("root2"));

        await overrideModule.connect(coordinator).registerHold(
            coin.address, await vault.getAddress(), fakeRootId, fakeHoldId, 2
        );

        // Second call overwrites without revert
        await expect(
            overrideModule.connect(coordinator).registerHold(
                coin.address, await vault.getAddress(), fakeRootId2, fakeHoldId2, 3
            )
        ).to.not.be.reverted;

        const h = await overrideModule.overrideHolds(coin.address, await vault.getAddress());
        expect(h.registered).to.equal(true);
        expect(h.rootIncidentId).to.equal(fakeRootId2);
        expect(h.ledgerHoldId).to.equal(fakeHoldId2);
    });

    // ── Test 8 ────────────────────────────────────────────────────────────────
    it("8 — earlyUnlock: reverts Unauthorized for non-Safe caller", async function () {
        await freezeVault();

        const coinAddr  = await coin.getAddress();
        const vaultAddr = await vault.getAddress();
        const h = await overrideModule.overrideHolds(coinAddr, vaultAddr);
        await expect(
            overrideModule.connect(stranger).earlyUnlock(
                coinAddr, vaultAddr, h.rootIncidentId
            )
        ).to.be.revertedWithCustomError(overrideModule, "Unauthorized");
    });

    // ── Test 9 ────────────────────────────────────────────────────────────────
    it("9 — earlyUnlock: reverts HoldNotRegistered if no hold slot exists", async function () {
        // No freeze has happened, so no hold is registered
        await expect(
            safeContract.connect(safeOwner).callEarlyUnlock(
                await overrideModule.getAddress(),
                coin.address, await vault.getAddress(), ethers.ZeroHash
            )
        ).to.be.revertedWithCustomError(overrideModule, "HoldNotRegistered");
    });

    // ── Test 10 ───────────────────────────────────────────────────────────────
    it("10 — earlyUnlock: reverts RootIncidentMismatch on wrong rootIncidentId", async function () {
        await freezeVault();
        // Hold must be placed (active) before earlyUnlock checks rootIncidentId
        await overrideModule.connect(safeOwner).placeHold(
            coin.address, await vault.getAddress()
        );

        const wrongRootId = ethers.keccak256(ethers.toUtf8Bytes("wrong-root"));
        await expect(
            safeContract.connect(safeOwner).callEarlyUnlock(
                await overrideModule.getAddress(),
                coin.address, await vault.getAddress(), wrongRootId
            )
        ).to.be.revertedWithCustomError(overrideModule, "RootIncidentMismatch");
    });

    // ── Test 11 ───────────────────────────────────────────────────────────────
    it("11 — earlyUnlock: full path — releases hold, unfreezes vault, marks COMPLETE", async function () {
        await advanceToRecoveryWithHold();

        // After STABILITY_WINDOW stable reports: event=RECOVERY_PENDING, dest=HOLD_PAUSED, vault frozen
        const vaultAddr = await vault.getAddress();
        const coinAddr  = await coin.getAddress();
        expect(await vault.paused()).to.equal(true, "vault must still be frozen");

        const evId = await eventRegistry.getActiveEventId(coinAddr);
        const HOLD_PAUSED = 4;
        expect(await eventRegistry.getDestinationState(evId, 0)).to.equal(HOLD_PAUSED,
            "dest slot should be HOLD_PAUSED after recovery attempt with active hold");

        // Advance past cooldown so finalizeRecovery in executeEarlyUnlock can terminate to NORMAL
        await time.increase(Number(RECOVERY_COOLDOWN) + 1);

        const h = await overrideModule.overrideHolds(coinAddr, vaultAddr);
        await safeContract.connect(safeOwner).callEarlyUnlock(
            await overrideModule.getAddress(),
            coinAddr, vaultAddr, h.rootIncidentId
        );

        // Vault must be unfrozen
        expect(await vault.paused()).to.equal(false, "vault must be unfrozen after earlyUnlock");

        // Dest slot must be COMPLETE
        const COMPLETE = 1;
        expect(await eventRegistry.getDestinationState(evId, 0)).to.equal(COMPLETE,
            "dest slot must be COMPLETE after earlyUnlock");

        // Hold must be inactive
        expect(await overrideModule.isHoldActive(coinAddr, vaultAddr)).to.equal(false);

        // Ledger hold released — activeHoldCount == 0
        expect(await holdLedger.activeHoldCount(vaultAddr)).to.equal(0n);
    });

    // ── Test 12 ───────────────────────────────────────────────────────────────
    it("12 — earlyUnlock: stores suppression window; isSuppressed true within window, false after", async function () {
        await advanceToRecoveryWithHold();

        const vaultAddr = await vault.getAddress();
        const coinAddr  = await coin.getAddress();
        const h = await overrideModule.overrideHolds(coinAddr, vaultAddr);
        const rootId = h.rootIncidentId;
        const score  = h.severityAtHold;

        await safeContract.connect(safeOwner).callEarlyUnlock(
            await overrideModule.getAddress(),
            coinAddr, vaultAddr, rootId
        );

        // isSuppressed: same rootId, same vault, score <= severityAtHold → true
        expect(await overrideModule.isSuppressed(rootId, vaultAddr, score)).to.equal(true);
        expect(await overrideModule.isSuppressed(rootId, vaultAddr, score + 1n)).to.equal(false,
            "higher severity score must not be suppressed");

        // Advance past suppression window
        await time.increase(Number(SUPPRESSION_WINDOW) + 1);
        expect(await overrideModule.isSuppressed(rootId, vaultAddr, score)).to.equal(false,
            "suppression must expire after suppressionWindow");
    });

    // ── Test 13 ───────────────────────────────────────────────────────────────
    it("13 — cancelHold: deactivates hold without touching vault; next recovery cycle unfreezes", async function () {
        await advanceToRecoveryWithHold();

        const vaultAddr = await vault.getAddress();
        expect(await vault.paused()).to.equal(true, "vault must be frozen before cancel");

        await expect(
            safeContract.connect(safeOwner).callCancelHold(
                await overrideModule.getAddress(), coin.address, vaultAddr
            )
        ).to.emit(overrideModule, "HoldCancelled").withArgs(coin.address, vaultAddr);

        // Hold deactivated but vault is still frozen (ledger hold still active)
        expect(await overrideModule.isHoldActive(coin.address, vaultAddr)).to.equal(false);
        expect(await vault.paused()).to.equal(true,
            "vault must remain frozen immediately after cancelHold");
        expect(await holdLedger.activeHoldCount(vaultAddr)).to.equal(1n,
            "ledger hold must still be active after cancelHold");

        // Advance past cooldown
        await time.increase(Number(RECOVERY_COOLDOWN) + 1);

        // Next stable report: isHoldActive=false → normal recovery → vault unfreezes
        await receiver.connect(forwarder).onReport("0x",
            encodeReport([coin.address], [0], 0));

        expect(await vault.paused()).to.equal(false,
            "vault must unfreeze on next receiver cycle after cancelHold");
    });

    // ── Test 14 ───────────────────────────────────────────────────────────────
    it("14 — renewHold: resets holdUntil (not stacking); DurationExceedsMax reverts; single owner sufficient", async function () {
        await freezeVault();
        // placeHold required before renewHold (hold must be active)
        await overrideModule.connect(safeOwner).placeHold(
            coin.address, await vault.getAddress()
        );

        const vaultAddr = await vault.getAddress();
        const renewDuration = 1800n; // 30 min — shorter than original MAX_HOLD_DURATION (2h)

        // Single owner calls renewHold directly (no Safe proxy needed)
        await expect(
            overrideModule.connect(safeOwner).renewHold(
                coin.address, vaultAddr, renewDuration
            )
        ).to.emit(overrideModule, "HoldRenewed");

        // Verify holdUntil is approximately now + renewDuration (not now + 2*renewDuration)
        const h = await overrideModule.overrideHolds(coin.address, vaultAddr);
        const blockTs = BigInt((await ethers.provider.getBlock("latest")).timestamp);
        expect(h.holdUntil).to.be.closeTo(blockTs + renewDuration, 5n);

        // Over-max reverts
        await expect(
            overrideModule.connect(safeOwner).renewHold(
                coin.address, vaultAddr, MAX_HOLD_DURATION + 1n
            )
        ).to.be.revertedWithCustomError(overrideModule, "DurationExceedsMax");
    });

    // ── Test 15 ───────────────────────────────────────────────────────────────
    it("15 — isHoldActive: returns false after natural hold TTL expires", async function () {
        await freezeVault();
        await overrideModule.connect(safeOwner).placeHold(
            coin.address, await vault.getAddress()
        );

        const vaultAddr = await vault.getAddress();
        expect(await overrideModule.isHoldActive(coin.address, vaultAddr)).to.equal(true);

        // Advance past MAX_HOLD_DURATION
        await time.increase(Number(MAX_HOLD_DURATION) + 1);

        expect(await overrideModule.isHoldActive(coin.address, vaultAddr)).to.equal(false,
            "hold must be considered inactive after maxHoldDuration expires");

        // Vault is still physically frozen (receiver has not yet run a recovery cycle)
        expect(await vault.paused()).to.equal(true);
    });

    // ── Test 16 ───────────────────────────────────────────────────────────────
    it("16 — pendingTTL does NOT terminate event while dest is HOLD_PAUSED", async function () {
        await advanceToRecoveryWithHold();

        // Dest should be HOLD_PAUSED and event in RECOVERY_PENDING
        const coinAddr  = await coin.getAddress();
        const vaultAddr = await vault.getAddress();
        const evId = await eventRegistry.getActiveEventId(coinAddr);
        const HOLD_PAUSED = 4;
        expect(await eventRegistry.getDestinationState(evId, 0)).to.equal(HOLD_PAUSED);

        const ev = await eventRegistry.getDepegEvent(evId);
        const RECOVERY_PENDING = 5;
        expect(Number(ev.state)).to.equal(RECOVERY_PENDING);

        // Advance past pendingTTL
        await time.increase(Number(PENDING_TTL) + 1);

        // settlePending must NOT terminate the event (HOLD_PAUSED guard)
        await expect(eventRegistry.settlePending(evId)).to.not.be.reverted;

        // Event must still be RECOVERY_PENDING (not FAILED)
        const evAfter = await eventRegistry.getDepegEvent(evId);
        expect(Number(evAfter.state)).to.equal(RECOVERY_PENDING,
            "event must remain RECOVERY_PENDING — pendingTTL must not terminate while HOLD_PAUSED");

        // Vault still frozen
        expect(await vault.paused()).to.equal(true);

        // Confirm earlyUnlock can still resolve the event after pendingTTL has passed
        await time.increase(Number(RECOVERY_COOLDOWN) + 1);
        const h = await overrideModule.overrideHolds(coinAddr, vaultAddr);
        await safeContract.connect(safeOwner).callEarlyUnlock(
            await overrideModule.getAddress(),
            coinAddr, vaultAddr, h.rootIncidentId
        );
        expect(await vault.paused()).to.equal(false, "vault must be unfrozen after earlyUnlock");
    });

    // ════════════════════════════════════════════════════════════════════════════
    // Fix A tests — opt-in holds
    // ════════════════════════════════════════════════════════════════════════════

    // ── Test 17 ───────────────────────────────────────────────────────────────
    it("17 (Fix A) — no hold placed: vault auto-recovers normally after stability window", async function () {
        await freezeVault();
        // Deliberately do NOT call placeHold

        expect(await vault.paused()).to.equal(true, "vault must be paused after freeze");
        expect(await overrideModule.isHoldRegistered(coin.address, await vault.getAddress()))
            .to.equal(true, "slot must be registered");
        expect(await overrideModule.isHoldActive(coin.address, await vault.getAddress()))
            .to.equal(false, "hold must NOT be active without placeHold");

        for (let i = 0; i < STABILITY_WINDOW; i++) {
            await receiver.connect(forwarder).onReport("0x",
                encodeReport([coin.address], [0], 0));
        }

        expect(await vault.paused()).to.equal(false,
            "vault must auto-recover when no hold was placed");
    });

    // ── Test 18 ───────────────────────────────────────────────────────────────
    it("18 (Fix A) — single owner places hold: recovery blocked, dest becomes HOLD_PAUSED", async function () {
        await freezeVault();

        const coinAddr  = coin.address;
        const vaultAddr = await vault.getAddress();

        // Single Safe owner activates the hold
        await expect(
            overrideModule.connect(safeOwner).placeHold(coinAddr, vaultAddr)
        ).to.emit(overrideModule, "HoldPlaced");

        expect(await overrideModule.isHoldActive(coinAddr, vaultAddr))
            .to.equal(true, "hold must be active after placeHold");

        // Send stability window reports — recovery should be blocked
        for (let i = 0; i < STABILITY_WINDOW; i++) {
            await receiver.connect(forwarder).onReport("0x",
                encodeReport([coin.address], [0], 0));
        }

        expect(await vault.paused()).to.equal(true,
            "vault must remain frozen when hold is placed");

        const evId = await eventRegistry.getActiveEventId(coinAddr);
        const HOLD_PAUSED = 4;
        expect(await eventRegistry.getDestinationState(evId, 0)).to.equal(HOLD_PAUSED,
            "dest slot must be HOLD_PAUSED after hold is placed");
    });

    // ── Test 19 ───────────────────────────────────────────────────────────────
    it("19 (Fix A) — non-owner placeHold reverts Unauthorized", async function () {
        await freezeVault();
        await expect(
            overrideModule.connect(stranger).placeHold(
                coin.address, await vault.getAddress()
            )
        ).to.be.revertedWithCustomError(overrideModule, "Unauthorized");
    });

    // ── Test 20 ───────────────────────────────────────────────────────────────
    it("20 (Fix A) — placeHold with no registered slot reverts HoldNotRegistered", async function () {
        // No freeze → no registerHold called → slot not registered
        await expect(
            overrideModule.connect(safeOwner).placeHold(
                coin.address, await vault.getAddress()
            )
        ).to.be.revertedWithCustomError(overrideModule, "HoldNotRegistered");
    });

    // ── Test 21 ───────────────────────────────────────────────────────────────
    it("21 (Fix A) — single owner can renewHold; calling cancelHold directly (not via Safe) reverts", async function () {
        await freezeVault();
        await overrideModule.connect(safeOwner).placeHold(
            coin.address, await vault.getAddress()
        );

        const vaultAddr    = await vault.getAddress();
        const newDuration  = 1800n;

        // Single owner renews hold directly (no Safe proxy)
        await expect(
            overrideModule.connect(safeOwner).renewHold(
                coin.address, vaultAddr, newDuration
            )
        ).to.emit(overrideModule, "HoldRenewed");

        // Single owner cannot call cancelHold directly — msg.sender must be the Safe contract
        await expect(
            overrideModule.connect(safeOwner).cancelHold(
                coin.address, vaultAddr
            )
        ).to.be.revertedWithCustomError(overrideModule, "Unauthorized");
    });

    // ════════════════════════════════════════════════════════════════════════════
    // Fix B tests — StableGuard cannot plug in a fake override module
    // ════════════════════════════════════════════════════════════════════════════

    // ── Test 22 ───────────────────────────────────────────────────────────────
    it("22 (Fix B) — receiver.setOverrideModule: StableGuard admin reverts; vault governance works", async function () {
        const moduleAddr = await overrideModule.getAddress();

        // StableGuard admin (no GOVERNANCE_ROLE on vault) → reverts
        await expect(
            receiver.connect(admin).setOverrideModule(moduleAddr)
        ).to.be.revertedWithCustomError(receiver, "Unauthorized");

        // Vault governance can set it
        await expect(
            receiver.connect(governance).setOverrideModule(moduleAddr)
        ).to.not.be.reverted;
    });

    // ── Test 23 ───────────────────────────────────────────────────────────────
    it("23 (Fix B) — holdLedger.approveVaultModule: non-GOVERNANCE_ROLE reverts; vault governance works", async function () {
        const vaultAddr  = await vault.getAddress();
        const moduleAddr = await overrideModule.getAddress();

        // stranger has no GOVERNANCE_ROLE on vault → reverts
        await expect(
            holdLedger.connect(stranger).approveVaultModule(vaultAddr, moduleAddr)
        ).to.be.revertedWithCustomError(holdLedger, "Unauthorized");

        // Vault governance can approve
        await expect(
            holdLedger.connect(governance).approveVaultModule(vaultAddr, moduleAddr)
        ).to.not.be.reverted;

        expect(await holdLedger.vaultApprovedModule(vaultAddr)).to.equal(moduleAddr);
    });

    // ── Test 24 ───────────────────────────────────────────────────────────────
    it("24 (Fix B) — vaultApprovedModule is per-vault: approving for vault1 does not affect vault2", async function () {
        const VaultFactory = await ethers.getContractFactory("StableGuardVault");
        const vault2 = await VaultFactory.deploy(
            await asset.getAddress(), "V2", "sgV2", governance.address
        );
        const moduleAddr = await overrideModule.getAddress();

        // vault1 approved in beforeEach; vault2 not yet approved
        expect(await holdLedger.vaultApprovedModule(await vault2.getAddress()))
            .to.equal(ethers.ZeroAddress,
                "module approved for vault1 must not carry over to vault2");

        // Approve for vault2 separately
        await holdLedger.connect(governance).approveVaultModule(
            await vault2.getAddress(), moduleAddr
        );
        expect(await holdLedger.vaultApprovedModule(await vault2.getAddress()))
            .to.equal(moduleAddr);
    });

    // ── Test 25 ───────────────────────────────────────────────────────────────
    it("25 (Fix B) — releaseByOverride: only vaultApprovedModule may call it; stranger reverts", async function () {
        await freezeVault();

        // Get the ledger holdId recorded in the override module's slot
        const h = await overrideModule.overrideHolds(
            coin.address, await vault.getAddress()
        );
        const ledgerHoldId = h.ledgerHoldId;

        // A non-approved address calling releaseByOverride directly → Unauthorized
        await expect(
            holdLedger.connect(stranger).releaseByOverride(ledgerHoldId)
        ).to.be.revertedWithCustomError(holdLedger, "Unauthorized");

        // Admin calling it → also Unauthorized (not the approved module)
        await expect(
            holdLedger.connect(admin).releaseByOverride(ledgerHoldId)
        ).to.be.revertedWithCustomError(holdLedger, "Unauthorized");
    });

});

// chai `anyValue` helper
const { anyValue } = require("@nomicfoundation/hardhat-chai-matchers/withArgs");
