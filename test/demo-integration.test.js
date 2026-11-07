"use strict";

/**
 * demo-integration.test.js
 *
 * End-to-end local test of the full two-scene demo sequence.
 * Runs entirely on the Hardhat local network — no testnet connection needed.
 * Proves correctness before the live Arbitrum Sepolia recording.
 *
 * Scene 1 — automatic protection (no human action):
 *   CRITICAL × 2 to MorphoCREReceiver → MorphoCapsZeroed(marketsCapped=1)
 *   CRITICAL × 2 to main receiver     → StableGuardVault.paused() = true
 *   STABLE   × 3                      → RECOVERY_PENDING
 *   time.increase(1800)                → cooldown elapsed
 *   STABLE   × 1                      → NORMAL, vault.paused() = false (auto-unfreeze)
 *
 * Scene 2 — human override + ProtectionSuppressed:
 *   CRITICAL × 2 to main receiver → new incident; vault freezes (NOT suppressed from Scene 1)
 *   placeHold                      → override hold active
 *   earlyUnlock via MockSafe       → vault.paused() = false immediately (KEY MOMENT)
 *   STABLE × 3                     → RECOVERY_PENDING
 *   time.increase(1800)            → cooldown elapsed
 *   STABLE × 1                     → NORMAL
 *   CRITICAL × 2 (new incident)   → ProtectionSuppressed emitted; vault stays unpaused
 */

const { ethers }  = require("hardhat");
const { expect }  = require("chai");
const { time }    = require("@nomicfoundation/hardhat-network-helpers");

// ─── Helpers ─────────────────────────────────────────────────────────────────

const coder = ethers.AbiCoder.defaultAbiCoder();

function findEvent(receipt, iface, name) {
    return receipt.logs
        .map(l => { try { return iface.parseLog(l); } catch { return null; } })
        .filter(e => e && e.name === name);
}

function encodeMarketData(loanToken, collateralToken, oracle, irm, lltv) {
    return coder.encode(
        ["address","address","address","address","uint256"],
        [loanToken, collateralToken, oracle, irm, lltv]
    );
}

let _ts;
function encodeReport(coin, signalLevel, compositeScore) {
    const observedAt = ++_ts;
    const price18 = signalLevel > 0
        ? 940_000_000_000_000_000n
        : 1_000_000_000_000_000_000n;
    const deviationBps = signalLevel > 0 ? 600n : 0n;
    return coder.encode(
        ["address[]","uint256[]","uint256[]","uint8[]","bytes[]","uint8","uint8","uint256"],
        [[coin], [price18], [deviationBps], [signalLevel], ["0x"], compositeScore, 0, observedAt]
    );
}

async function sendReport(forwarder, receiverContract, coin, signalLevel, compositeScore) {
    const rawReport = encodeReport(coin, signalLevel, compositeScore);
    const tx = await receiverContract.connect(forwarder).onReport("0x", rawReport);
    return tx.wait();
}

// ─── Constants ────────────────────────────────────────────────────────────────

const WATCH_THRESHOLD     = 1;
const CONFIRMED_THRESHOLD = 2;
const STABILITY_WINDOW    = 3;
const EVENT_TTL           = 86400n;
const PENDING_TTL         = 3600n;
const RECOVERY_COOLDOWN   = 1800n;
const MAX_REPORT_AGE      = 604800n;    // 7 days — generous for local testing
const LOCAL_CHAIN_SEL     = 1n;

const PAUSE_COORDINATOR_ROLE = ethers.keccak256(ethers.toUtf8Bytes("PAUSE_COORDINATOR_ROLE"));
const GOVERNANCE_ROLE        = ethers.keccak256(ethers.toUtf8Bytes("GOVERNANCE_ROLE"));

const ABS_CAP = 1_000_000n;
const REL_CAP =   500_000n;
const ALLOC   =   200_000n;

// ─── Main describe ────────────────────────────────────────────────────────────

describe("Demo integration — two-scene end-to-end", function () {
    // Signers
    let governance, forwarderSigner, coinSigner, oracleSigner;
    let COIN;   // address used as the USDC stand-in

    // Core contracts
    let asset, vault, exposureReg, eventReg, holdLedger, receiver;
    // Override contracts
    let overrideModule, mockSafe;
    // Morpho contracts
    let morphoVault, adapter, morphoEventReg, morphoHoldLedger, morphoReceiver;
    // Encoded market data for the Morpho adapter
    let marketData;

    beforeEach(async function () {
        [governance, forwarderSigner, coinSigner, oracleSigner] = await ethers.getSigners();
        COIN = coinSigner.address;

        _ts = BigInt((await ethers.provider.getBlock("latest")).timestamp) - 1000n;

        // ── Core: ExposureRegistry ────────────────────────────────────────────
        const ExposureRegFactory = await ethers.getContractFactory("ExposureRegistry");
        exposureReg = await ExposureRegFactory.deploy(governance.address);

        // ── Core: DepegEventRegistry ──────────────────────────────────────────
        const DepegEventRegFactory = await ethers.getContractFactory("DepegEventRegistry");
        eventReg = await DepegEventRegFactory.deploy(
            governance.address,
            WATCH_THRESHOLD,
            CONFIRMED_THRESHOLD,
            STABILITY_WINDOW,
            EVENT_TTL,
            PENDING_TTL,
            RECOVERY_COOLDOWN
        );

        // ── Core: ProtectionHoldLedger ────────────────────────────────────────
        const HoldLedgerFactory = await ethers.getContractFactory("ProtectionHoldLedger");
        holdLedger = await HoldLedgerFactory.deploy(governance.address, governance.address);

        // ── Core: StableGuardVault ────────────────────────────────────────────
        const MockERC20Factory = await ethers.getContractFactory("MockERC20");
        asset = await MockERC20Factory.deploy("Demo USDC", "dUSDC", 6);

        const VaultFactory = await ethers.getContractFactory("StableGuardVault");
        vault = await VaultFactory.deploy(
            await asset.getAddress(),
            "StableGuard USDC Vault",
            "sgUSDC",
            governance.address
        );

        // ── Core: StableGuardCREReceiver (standard vault path) ─────────────────
        const ReceiverFactory = await ethers.getContractFactory("StableGuardCREReceiver");
        receiver = await ReceiverFactory.deploy(
            forwarderSigner.address,
            await exposureReg.getAddress(),
            await eventReg.getAddress(),
            await vault.getAddress(),
            LOCAL_CHAIN_SEL,
            await holdLedger.getAddress(),
            MAX_REPORT_AGE
        );

        // ── Core: CustomerOverrideModule + MockSafe ────────────────────────────
        const OverrideModuleFactory = await ethers.getContractFactory("CustomerOverrideModule");
        overrideModule = await OverrideModuleFactory.deploy(
            await holdLedger.getAddress(),
            7200,   // maxHoldDuration: 2 hours
            3600,   // suppressionWindow: 1 hour
            governance.address
        );

        const MockSafeFactory = await ethers.getContractFactory("MockSafe");
        mockSafe = await MockSafeFactory.deploy(governance.address);

        // ── Wire core: event registry + hold ledger → receiver ────────────────
        await eventReg.connect(governance).setHoldLedger(await holdLedger.getAddress());
        await eventReg.connect(governance).transferController(await receiver.getAddress());
        await holdLedger.connect(governance).transferCoordinator(await receiver.getAddress());
        // Grant receiver PAUSE_COORDINATOR_ROLE on vault
        await vault.connect(governance).grantRole(PAUSE_COORDINATOR_ROLE, await receiver.getAddress());

        // Register COIN exposure for main vault
        const coinSym = ethers.zeroPadValue(COIN, 32);
        await exposureReg.connect(governance).registerExposure(await vault.getAddress(), coinSym);

        // Wire CustomerOverrideModule
        await receiver.connect(governance).setOverrideModule(await overrideModule.getAddress());
        await overrideModule.connect(governance).setVaultAuthority(await vault.getAddress(), await mockSafe.getAddress());
        await overrideModule.connect(governance).setVaultReceiver(await vault.getAddress(), await receiver.getAddress());
        await holdLedger.connect(governance).approveVaultModule(await vault.getAddress(), await overrideModule.getAddress());

        // ── Morpho: MockMorphoVaultV2 + MorphoSentinelAdapter ─────────────────
        const MorphoVaultFactory = await ethers.getContractFactory("MockMorphoVaultV2");
        morphoVault = await MorphoVaultFactory.deploy(governance.address);

        const AdapterFactory = await ethers.getContractFactory("MorphoSentinelAdapter");
        adapter = await AdapterFactory.deploy(await morphoVault.getAddress());

        // ── Morpho: separate DepegEventRegistry + ProtectionHoldLedger ────────
        morphoEventReg = await DepegEventRegFactory.deploy(
            governance.address,
            WATCH_THRESHOLD,
            CONFIRMED_THRESHOLD,
            STABILITY_WINDOW,
            EVENT_TTL,
            PENDING_TTL,
            RECOVERY_COOLDOWN
        );

        morphoHoldLedger = await HoldLedgerFactory.deploy(governance.address, governance.address);

        // ── Morpho: StableGuardCREReceiver (vault = MockMorphoVaultV2) ─────────
        morphoReceiver = await ReceiverFactory.deploy(
            forwarderSigner.address,
            await exposureReg.getAddress(),
            await morphoEventReg.getAddress(),
            await morphoVault.getAddress(),
            LOCAL_CHAIN_SEL,
            await morphoHoldLedger.getAddress(),
            MAX_REPORT_AGE
        );

        // Wire morpho: event registry + hold ledger → morpho receiver
        await morphoEventReg.connect(governance).setHoldLedger(await morphoHoldLedger.getAddress());
        await morphoEventReg.connect(governance).transferController(await morphoReceiver.getAddress());
        await morphoHoldLedger.connect(governance).transferCoordinator(await morphoReceiver.getAddress());

        // Register COIN exposure for morpho vault
        await exposureReg.connect(governance).registerExposure(await morphoVault.getAddress(), coinSym);

        // Set up MorphoSentinelAdapter
        // market: collateralToken = COIN (must match reported coin)
        marketData = encodeMarketData(
            ethers.ZeroAddress, COIN, oracleSigner.address, ethers.ZeroAddress, 700000000000000000n
        );
        const marketEntry = { marketData, adapter: governance.address }; // market adapter = dummy

        await morphoVault.connect(governance).setIsSentinel(await adapter.getAddress(), true);
        await morphoVault.connect(governance).setCap(marketData, ABS_CAP, REL_CAP);
        await morphoVault.connect(governance).setAllocation(marketData, ALLOC);
        await adapter.connect(governance).setReceiver(await morphoReceiver.getAddress());
        await adapter.connect(governance).registerMarkets(COIN, [marketEntry]);

        // morphoReceiver.setMorphoAdapter: auth = morphoVault.owner() = governance
        await morphoReceiver.connect(governance).setMorphoAdapter(await adapter.getAddress());
    });

    // ─── Scene 1 ─────────────────────────────────────────────────────────────

    it("Scene 1a — Morpho: CONFIRMED_DEPEG emits MorphoCapsZeroed(marketsCapped=1)", async function () {
        // Report 1: WATCH
        await sendReport(forwarderSigner, morphoReceiver, COIN, 1, 1);

        // Report 2: CONFIRMED_DEPEG → adapter.onDepeg → caps zeroed
        const receipt = await sendReport(forwarderSigner, morphoReceiver, COIN, 3, 3);

        const zeroedEvents = findEvent(receipt, adapter.interface, "MorphoCapsZeroed");
        expect(zeroedEvents.length).to.equal(1, "MorphoCapsZeroed must fire on CONFIRMED_DEPEG");
        expect(zeroedEvents[0].args.marketsCapped).to.equal(1n, "one market must be capped");

        const mId = ethers.keccak256(marketData);
        expect(await morphoVault.absoluteCap(mId)).to.equal(0n, "absoluteCap must be zeroed");
        expect(await morphoVault.relativeCap(mId)).to.equal(0n, "relativeCap must be zeroed");
        expect(await morphoVault.getDeallocCallCount()).to.equal(1n, "deallocate must be called");
    });

    it("Scene 1b — vault: auto-recovery; vault.paused() = false with no human action", async function () {
        const vaultAddr = await vault.getAddress();

        // ── Freeze phase: 2 CRITICAL → vault.paused() = true ──────────────────
        await sendReport(forwarderSigner, receiver, COIN, 1, 1); // WATCH
        await sendReport(forwarderSigner, receiver, COIN, 3, 3); // CONFIRMED_DEPEG
        expect(await vault.paused()).to.equal(true, "vault must be paused on CONFIRMED_DEPEG");

        // ── Recovery phase: 3 STABLE → RECOVERY_PENDING ───────────────────────
        await sendReport(forwarderSigner, receiver, COIN, 0, 0);
        await sendReport(forwarderSigner, receiver, COIN, 0, 0);
        await sendReport(forwarderSigner, receiver, COIN, 0, 0);
        // After stabilityWindow=3 stable reports, event enters RECOVERY_PENDING.
        // The receiver releases the hold and unpauses vault automatically.
        expect(await vault.paused()).to.equal(false, "vault must be unpaused after 3 stable reports");

        // ── Cooldown + finalize → NORMAL ──────────────────────────────────────
        await time.increase(1800);
        _ts = BigInt((await ethers.provider.getBlock("latest")).timestamp) - 10n;

        const finalReceipt = await sendReport(forwarderSigner, receiver, COIN, 0, 0);
        // EventTerminated(eventId, coin, State.NORMAL=7) must have been emitted
        const termEvents = findEvent(finalReceipt, eventReg.interface, "EventTerminated");
        expect(termEvents.length).to.equal(1, "EventTerminated must fire when NORMAL is reached");
        expect(termEvents[0].args.terminal).to.equal(7n, "terminal state must be NORMAL (7)");
        expect(await vault.paused()).to.equal(false, "vault must still be unpaused at NORMAL");
    });

    // ─── Scene 2 ─────────────────────────────────────────────────────────────

    it("Scene 2 — human override: earlyUnlock unfreezes vault immediately; ProtectionSuppressed on new incident within window", async function () {
        const vaultAddr  = await vault.getAddress();
        const moduleAddr = await overrideModule.getAddress();

        // ── Verify: no suppression active before Scene 2 (no earlyUnlock in Scene 1) ──
        // This confirms Scene 2 is not suppressed from a prior Scene 1 earlyUnlock.
        // isSuppressed requires a rootIncidentId; bytes32(0) covers the coin-level check
        expect(
            await overrideModule.isSuppressed(ethers.ZeroHash, COIN, vaultAddr, 3)
        ).to.equal(false, "no suppression should be active at the start of Scene 2");

        // ── Freeze: 2 CRITICAL → vault.paused() = true (new incident) ──────────
        await sendReport(forwarderSigner, receiver, COIN, 1, 1); // WATCH
        await sendReport(forwarderSigner, receiver, COIN, 3, 3); // CONFIRMED_DEPEG
        expect(await vault.paused()).to.equal(true, "vault must be paused on Scene 2 CONFIRMED_DEPEG");

        // Hold was registered automatically in onReport
        expect(
            await overrideModule.isHoldRegistered(COIN, vaultAddr)
        ).to.equal(true, "hold slot must be registered after freeze");

        // ── placeHold → override hold becomes active ───────────────────────────
        await overrideModule.connect(governance).placeHold(COIN, vaultAddr);
        expect(
            await overrideModule.isHoldActive(COIN, vaultAddr)
        ).to.equal(true, "hold must be active after placeHold");

        // ── earlyUnlock via MockSafe → vault.paused() = false immediately ───────
        const holdSlot      = await overrideModule.overrideHolds(COIN, vaultAddr);
        const rootIncidentId = holdSlot.rootIncidentId;

        const unlockReceipt = await (await mockSafe.connect(governance).callEarlyUnlock(
            moduleAddr, COIN, vaultAddr, rootIncidentId
        )).wait();

        // KEY MOMENT: vault is unpaused immediately
        expect(await vault.paused()).to.equal(false, "vault must be unpaused immediately after earlyUnlock");

        // EarlyUnlockExecuted event on receiver confirms the call chain completed
        const unlockEvents = findEvent(unlockReceipt, receiver.interface, "EarlyUnlockExecuted");
        expect(unlockEvents.length).to.equal(1, "EarlyUnlockExecuted must be emitted");

        // ── Recovery: 3 STABLE → RECOVERY_PENDING ─────────────────────────────
        await sendReport(forwarderSigner, receiver, COIN, 0, 0);
        await sendReport(forwarderSigner, receiver, COIN, 0, 0);
        await sendReport(forwarderSigner, receiver, COIN, 0, 0);
        // Vault is already unpaused; receiver confirms the hold is released.

        // ── Cooldown + finalize → NORMAL ──────────────────────────────────────
        await time.increase(1800);
        _ts = BigInt((await ethers.provider.getBlock("latest")).timestamp) - 10n;
        await sendReport(forwarderSigner, receiver, COIN, 0, 0);

        // ── New incident within suppression window → ProtectionSuppressed ──────
        // Suppression window is 3600s. We're ~1800s past earlyUnlock. Well within window.
        await sendReport(forwarderSigner, receiver, COIN, 1, 1); // WATCH (new incident)
        const suppressedReceipt = await sendReport(forwarderSigner, receiver, COIN, 3, 3); // CONFIRMED_DEPEG attempt

        const suppressedEvents = findEvent(suppressedReceipt, receiver.interface, "ProtectionSuppressed");
        expect(suppressedEvents.length).to.equal(1, "ProtectionSuppressed must fire for same-severity incident within window");
        expect(suppressedEvents[0].args.coin).to.equal(COIN);
        expect(suppressedEvents[0].args.vault).to.equal(vaultAddr);

        // KEY SAFETY: vault is NOT frozen — the freeze was suppressed
        expect(await vault.paused()).to.equal(false, "vault must NOT be frozen during suppression window");
    });

    // ─── Cross-scene validation ───────────────────────────────────────────────

    it("cross-scene: Scene 2 freeze proceeds normally after full Scene 1 auto-recovery (no earlyUnlock suppression)", async function () {
        // Run abbreviated Scene 1 (auto-recovery, no earlyUnlock)
        await sendReport(forwarderSigner, receiver, COIN, 1, 1);
        await sendReport(forwarderSigner, receiver, COIN, 3, 3);
        for (let i = 0; i < 3; i++) {
            await sendReport(forwarderSigner, receiver, COIN, 0, 0);
        }
        await time.increase(1800);
        _ts = BigInt((await ethers.provider.getBlock("latest")).timestamp) - 10n;
        await sendReport(forwarderSigner, receiver, COIN, 0, 0); // NORMAL

        // Scene 1 had no earlyUnlock → no suppression set
        expect(
            await overrideModule.isSuppressed(ethers.ZeroHash, COIN, await vault.getAddress(), 3)
        ).to.equal(false, "no suppression from Scene 1 (no earlyUnlock)");

        // Scene 2: new incident → vault freezes normally
        await sendReport(forwarderSigner, receiver, COIN, 1, 1);
        const scene2Receipt = await sendReport(forwarderSigner, receiver, COIN, 3, 3);
        expect(await vault.paused()).to.equal(true, "vault must freeze normally in Scene 2 — not suppressed from Scene 1");

        // No ProtectionSuppressed was emitted
        const suppressed = findEvent(scene2Receipt, receiver.interface, "ProtectionSuppressed");
        expect(suppressed.length).to.equal(0, "ProtectionSuppressed must NOT fire in Scene 2 after Scene 1 auto-recovery");
    });
});
