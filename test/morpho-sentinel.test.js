"use strict";

const { ethers } = require("hardhat");
const { expect } = require("chai");
const { time } = require("@nomicfoundation/hardhat-network-helpers");

// ─── Helpers ────────────────────────────────────────────────────────────────

const coder = ethers.AbiCoder.defaultAbiCoder();

function encodeMarketData(loanToken, collateralToken, oracle, irm, lltv) {
    return coder.encode(
        ["address", "address", "address", "address", "uint256"],
        [loanToken, collateralToken, oracle, irm, lltv]
    );
}

// Build a minimal valid receiver report with one coin at a given signal level.
let _ts;
function encodeReport(coins, signalLevels, compositeScore) {
    const observedAt = ++_ts;
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

function findEvent(receipt, iface, name) {
    return receipt.logs
        .map(l => { try { return iface.parseLog(l); } catch { return null; } })
        .filter(e => e && e.name === name);
}

// ─── MorphoSentinelAdapter unit tests ────────────────────────────────────────

describe("MorphoSentinelAdapter", function () {
    let owner, receiverSigner, nonOwner, coinSigner, oracleSigner, irmSigner;
    let morphoVault, adapter;
    let coinAddr, marketData, marketEntry;

    const ABS_CAP = 1_000_000n;
    const REL_CAP =   500_000n;
    const ALLOC   =   200_000n;
    const ADAPTER_ADDR = "0x000000000000000000000000000000000000dEaD";

    beforeEach(async function () {
        [owner, receiverSigner, nonOwner, coinSigner, oracleSigner, irmSigner] =
            await ethers.getSigners();

        coinAddr = coinSigner.address;

        const MockMorpho = await ethers.getContractFactory("MockMorphoVaultV2");
        morphoVault = await MockMorpho.deploy(owner.address);

        const Adapter = await ethers.getContractFactory("MorphoSentinelAdapter");
        adapter = await Adapter.deploy(await morphoVault.getAddress());

        // Encode a valid market: collateralToken == coinAddr
        marketData = encodeMarketData(
            nonOwner.address,   // loanToken (arbitrary)
            coinAddr,           // collateralToken = coin
            oracleSigner.address,
            irmSigner.address,
            700000000000000000n // lltv 70%
        );
        marketEntry = { marketData, adapter: ADAPTER_ADDR };

        // Register the adapter as sentinel on the vault
        await morphoVault.connect(owner).setIsSentinel(await adapter.getAddress(), true);
        // Set caps and allocation in the mock
        await morphoVault.connect(owner).setCap(marketData, ABS_CAP, REL_CAP);
        await morphoVault.connect(owner).setAllocation(marketData, ALLOC);
    });

    // ── T-1: Happy path ─────────────────────────────────────────────────────

    it("T-1: onDepeg zeros caps and deallocates, returns 1", async function () {
        // Set receiver and register markets
        await adapter.connect(owner).setReceiver(receiverSigner.address);
        await adapter.connect(owner).registerMarkets(coinAddr, [marketEntry]);

        const tx = await adapter.connect(receiverSigner).onDepeg(coinAddr, 3);
        const receipt = await tx.wait();

        // absoluteCap and relativeCap should be zeroed
        const id = ethers.keccak256(marketData);
        expect(await morphoVault.absoluteCap(id)).to.equal(0n);
        expect(await morphoVault.relativeCap(id)).to.equal(0n);

        // allocation should be zeroed by deallocate
        expect(await morphoVault.allocation(id)).to.equal(0n);

        // deallocate was called once with correct args
        expect(await morphoVault.getDeallocCallCount()).to.equal(1n);
        const [dAdapter, dData, dAssets] = await morphoVault.getDeallocCall(0);
        expect(dAdapter).to.equal(ADAPTER_ADDR);
        expect(dData).to.equal(marketData);
        expect(dAssets).to.equal(ALLOC);

        // MorphoCapsZeroed emitted with marketsCapped=1
        const zeroedEvents = findEvent(receipt, adapter.interface, "MorphoCapsZeroed");
        expect(zeroedEvents.length).to.equal(1);
        expect(zeroedEvents[0].args.marketsCapped).to.equal(1n);
    });

    // ── T-2: Score below threshold ──────────────────────────────────────────

    it("T-2: score below threshold returns 0 and emits MorphoThresholdNotMet", async function () {
        await adapter.connect(owner).setReceiver(receiverSigner.address);
        await adapter.connect(owner).registerMarkets(coinAddr, [marketEntry]);

        // Default threshold is 3; pass score=2
        const tx = await adapter.connect(receiverSigner).onDepeg(coinAddr, 2);
        const receipt = await tx.wait();

        const events = findEvent(receipt, adapter.interface, "MorphoThresholdNotMet");
        expect(events.length).to.equal(1);
        expect(events[0].args.score).to.equal(2n);
        expect(events[0].args.threshold).to.equal(3n);

        // No caps changed
        const id = ethers.keccak256(marketData);
        expect(await morphoVault.absoluteCap(id)).to.equal(ABS_CAP);
    });

    // ── T-3: Threshold lowered to 2, score=2 now triggers ───────────────────

    it("T-3: threshold 2 triggers on score=2", async function () {
        await adapter.connect(owner).setReceiver(receiverSigner.address);
        await adapter.connect(owner).registerMarkets(coinAddr, [marketEntry]);
        await adapter.connect(owner).setCriticalThreshold(2);

        const tx = await adapter.connect(receiverSigner).onDepeg(coinAddr, 2);
        const receipt = await tx.wait();

        const zeroedEvents = findEvent(receipt, adapter.interface, "MorphoCapsZeroed");
        expect(zeroedEvents.length).to.equal(1);
        expect(zeroedEvents[0].args.marketsCapped).to.equal(1n);
    });

    // ── T-4: Threshold rejects 0 and 1 ──────────────────────────────────────

    it("T-4a: setCriticalThreshold(0) reverts with InvalidThreshold", async function () {
        await expect(adapter.connect(owner).setCriticalThreshold(0))
            .to.be.revertedWithCustomError(adapter, "InvalidThreshold")
            .withArgs(0);
    });

    it("T-4b: setCriticalThreshold(1) reverts with InvalidThreshold", async function () {
        await expect(adapter.connect(owner).setCriticalThreshold(1))
            .to.be.revertedWithCustomError(adapter, "InvalidThreshold")
            .withArgs(1);
    });

    // ── T-5: Not sentinel ────────────────────────────────────────────────────

    it("T-5: adapter not sentinel → emits MorphoNotSentinel, returns 0", async function () {
        // Revoke sentinel status
        await morphoVault.connect(owner).setIsSentinel(await adapter.getAddress(), false);
        await adapter.connect(owner).setReceiver(receiverSigner.address);
        await adapter.connect(owner).registerMarkets(coinAddr, [marketEntry]);

        const tx = await adapter.connect(receiverSigner).onDepeg(coinAddr, 3);
        const receipt = await tx.wait();

        const events = findEvent(receipt, adapter.interface, "MorphoNotSentinel");
        expect(events.length).to.equal(1);
        expect(events[0].args.adapter).to.equal(await adapter.getAddress());

        // No caps changed
        const id = ethers.keccak256(marketData);
        expect(await morphoVault.absoluteCap(id)).to.equal(ABS_CAP);
    });

    // ── T-6: No markets for the requested coin ───────────────────────────────

    it("T-6: no markets for coin → emits MorphoMarketsNotRegistered, returns 0", async function () {
        await adapter.connect(owner).setReceiver(receiverSigner.address);
        // Register for coinAddr but call onDepeg for a different coin
        await adapter.connect(owner).registerMarkets(coinAddr, [marketEntry]);

        const tx = await adapter.connect(receiverSigner).onDepeg(nonOwner.address, 3);
        const receipt = await tx.wait();

        const events = findEvent(receipt, adapter.interface, "MorphoMarketsNotRegistered");
        expect(events.length).to.equal(1);
    });

    // ── T-7: Deallocate fails (stuck market) ─────────────────────────────────

    it("T-7: deallocate fails → MorphoDeallocateFailed emitted, marketsCapped still 1", async function () {
        await morphoVault.connect(owner).setDeallocateReverts(marketData, true);
        await adapter.connect(owner).setReceiver(receiverSigner.address);
        await adapter.connect(owner).registerMarkets(coinAddr, [marketEntry]);

        const tx = await adapter.connect(receiverSigner).onDepeg(coinAddr, 3);
        const receipt = await tx.wait();

        const failEvents = findEvent(receipt, adapter.interface, "MorphoDeallocateFailed");
        expect(failEvents.length).to.equal(1);

        const zeroedEvents = findEvent(receipt, adapter.interface, "MorphoCapsZeroed");
        expect(zeroedEvents[0].args.marketsCapped).to.equal(1n, "caps were zeroed even though deallocate failed");

        // Caps should still be zeroed
        const id = ethers.keccak256(marketData);
        expect(await morphoVault.absoluteCap(id)).to.equal(0n);
    });

    // ── T-8: Allocation is 0 — no deallocate call ────────────────────────────

    it("T-8: allocation is 0 → deallocate not called, marketsCapped=1", async function () {
        await morphoVault.connect(owner).setAllocation(marketData, 0);
        await adapter.connect(owner).setReceiver(receiverSigner.address);
        await adapter.connect(owner).registerMarkets(coinAddr, [marketEntry]);

        const tx = await adapter.connect(receiverSigner).onDepeg(coinAddr, 3);
        await tx.wait();

        expect(await morphoVault.getDeallocCallCount()).to.equal(0n, "deallocate must not be called when allocation is 0");
    });

    // ── T-9: Cap decrease fails — market not counted ─────────────────────────

    it("T-9: both cap decreases fail → MorphoCapDecreaseFailed ×2, marketsCapped=0", async function () {
        await morphoVault.connect(owner).setCapDecreaseReverts(marketData, true);
        await adapter.connect(owner).setReceiver(receiverSigner.address);
        await adapter.connect(owner).registerMarkets(coinAddr, [marketEntry]);

        const tx = await adapter.connect(receiverSigner).onDepeg(coinAddr, 3);
        const receipt = await tx.wait();

        const failEvents = findEvent(receipt, adapter.interface, "MorphoCapDecreaseFailed");
        expect(failEvents.length).to.equal(2, "both decreaseAbsoluteCap and decreaseRelativeCap failures emitted");

        const zeroedEvents = findEvent(receipt, adapter.interface, "MorphoCapsZeroed");
        expect(zeroedEvents[0].args.marketsCapped).to.equal(0n);
    });

    // ── T-10: Multiple markets — partial failure ─────────────────────────────

    it("T-10: two markets, one cap-fails → marketsCapped=1", async function () {
        // Second market with a different oracle (makes its marketData different)
        const marketData2 = encodeMarketData(
            nonOwner.address,
            coinAddr,
            owner.address,  // different oracle → different bytes32 id
            irmSigner.address,
            700000000000000000n
        );
        const marketEntry2 = { marketData: marketData2, adapter: ADAPTER_ADDR };

        // Set up caps for market2
        await morphoVault.connect(owner).setCap(marketData2, ABS_CAP, REL_CAP);
        await morphoVault.connect(owner).setAllocation(marketData2, ALLOC);

        // Make market1 cap decrease fail
        await morphoVault.connect(owner).setCapDecreaseReverts(marketData, true);

        await adapter.connect(owner).setReceiver(receiverSigner.address);
        await adapter.connect(owner).registerMarkets(coinAddr, [marketEntry, marketEntry2]);

        const tx = await adapter.connect(receiverSigner).onDepeg(coinAddr, 3);
        const receipt = await tx.wait();

        const zeroedEvents = findEvent(receipt, adapter.interface, "MorphoCapsZeroed");
        expect(zeroedEvents[0].args.marketsCapped).to.equal(1n, "only market2 counted");
    });

    // ── T-11: registerMarkets — collateral mismatch reverts ──────────────────

    it("T-11: registerMarkets reverts when collateralToken != coin", async function () {
        const wrongCollateral = encodeMarketData(
            nonOwner.address,
            owner.address,   // wrong collateralToken (not coinAddr)
            oracleSigner.address,
            irmSigner.address,
            700000000000000000n
        );
        await expect(
            adapter.connect(owner).registerMarkets(coinAddr, [{ marketData: wrongCollateral, adapter: ADAPTER_ADDR }])
        ).to.be.revertedWithCustomError(adapter, "CollateralMismatch")
         .withArgs(coinAddr, owner.address);
    });

    // ── T-12: registerMarkets — non-owner reverts ────────────────────────────

    it("T-12: registerMarkets from non-owner reverts", async function () {
        await expect(
            adapter.connect(nonOwner).registerMarkets(coinAddr, [marketEntry])
        ).to.be.revertedWithCustomError(adapter, "Unauthorized");
    });

    // ── T-13: clearMarkets ───────────────────────────────────────────────────

    it("T-13: clearMarkets removes all markets; subsequent onDepeg returns 0", async function () {
        await adapter.connect(owner).setReceiver(receiverSigner.address);
        await adapter.connect(owner).registerMarkets(coinAddr, [marketEntry]);
        await adapter.connect(owner).clearMarkets(coinAddr);

        expect((await adapter.getMarkets(coinAddr)).length).to.equal(0);

        const tx = await adapter.connect(receiverSigner).onDepeg(coinAddr, 3);
        const receipt = await tx.wait();

        const events = findEvent(receipt, adapter.interface, "MorphoMarketsNotRegistered");
        expect(events.length).to.equal(1);
    });

    // ── T-14: onRecovery ─────────────────────────────────────────────────────

    it("T-14: onRecovery emits MorphoRecoverySignalled", async function () {
        await adapter.connect(owner).setReceiver(receiverSigner.address);

        const tx = await adapter.connect(receiverSigner).onRecovery(coinAddr);
        const receipt = await tx.wait();

        const events = findEvent(receipt, adapter.interface, "MorphoRecoverySignalled");
        expect(events.length).to.equal(1);
        expect(events[0].args.coin).to.equal(coinAddr);
    });

    // ── T-15: Only receiver can call onDepeg / onRecovery ────────────────────

    it("T-15a: onDepeg from non-receiver reverts with Unauthorized", async function () {
        await adapter.connect(owner).setReceiver(receiverSigner.address);
        await expect(
            adapter.connect(nonOwner).onDepeg(coinAddr, 3)
        ).to.be.revertedWithCustomError(adapter, "Unauthorized");
    });

    it("T-15b: onRecovery from non-receiver reverts with Unauthorized", async function () {
        await adapter.connect(owner).setReceiver(receiverSigner.address);
        await expect(
            adapter.connect(nonOwner).onRecovery(coinAddr)
        ).to.be.revertedWithCustomError(adapter, "Unauthorized");
    });

    // ── T-16: vaultAuthority() returns current vault owner ───────────────────

    it("T-16: vaultAuthority() returns current vault owner", async function () {
        expect(await adapter.vaultAuthority()).to.equal(owner.address);
    });

    // ── T-17: registerMarkets replaces existing markets ──────────────────────

    it("T-17: registerMarkets replaces previous markets for the coin", async function () {
        const marketData2 = encodeMarketData(
            nonOwner.address,
            coinAddr,
            owner.address,
            irmSigner.address,
            700000000000000000n
        );
        await adapter.connect(owner).registerMarkets(coinAddr, [marketEntry]);
        await adapter.connect(owner).registerMarkets(coinAddr, [{ marketData: marketData2, adapter: ADAPTER_ADDR }]);

        const markets = await adapter.getMarkets(coinAddr);
        expect(markets.length).to.equal(1);
        expect(markets[0].marketData).to.equal(marketData2);
    });

    // ── T-18: setCriticalThreshold non-owner reverts ─────────────────────────

    it("T-18: setCriticalThreshold from non-owner reverts", async function () {
        await expect(
            adapter.connect(nonOwner).setCriticalThreshold(2)
        ).to.be.revertedWithCustomError(adapter, "Unauthorized");
    });

    // ── T-24: H-03 — caps already 0 → market counted, no decrease calls ─────

    it("T-24 (H-03): caps already 0 → market counted without calling decreaseAbsoluteCap/decreaseRelativeCap", async function () {
        // Set both caps to 0 (pre-protected state)
        await morphoVault.connect(owner).setCap(marketData, 0, 0);
        // If the code tried to call decreaseAbsoluteCap/decreaseRelativeCap it would revert
        await morphoVault.connect(owner).setCapDecreaseReverts(marketData, true);

        await adapter.connect(owner).setReceiver(receiverSigner.address);
        await adapter.connect(owner).registerMarkets(coinAddr, [marketEntry]);

        const tx = await adapter.connect(receiverSigner).onDepeg(coinAddr, 3);
        const receipt = await tx.wait();

        // marketsCapped must be 1 — the market is considered already protected
        const zeroedEvents = findEvent(receipt, adapter.interface, "MorphoCapsZeroed");
        expect(zeroedEvents.length).to.equal(1);
        expect(zeroedEvents[0].args.marketsCapped).to.equal(1n,
            "market with pre-zeroed caps must count as capped");

        // No cap-decrease failure events (the calls were skipped, not attempted)
        const failEvents = findEvent(receipt, adapter.interface, "MorphoCapDecreaseFailed");
        expect(failEvents.length).to.equal(0, "no MorphoCapDecreaseFailed when caps are already 0");

        // deallocate still called (allocation > 0 from beforeEach)
        expect(await morphoVault.getDeallocCallCount()).to.equal(1n);
    });
});

// ─── Receiver + MorphoSentinelAdapter integration tests ──────────────────────

describe("StableGuardCREReceiver + MorphoSentinelAdapter integration", function () {
    let forwarder, vaultOwner, admin, coinSigner, oracleSigner, irmSigner;
    let morphoVault, adapter, receiver, registry, eventRegistry, holdLedger;
    let coinAddr, marketData, marketEntry;

    const WATCH_THRESHOLD      = 1;
    const CONFIRMED_THRESHOLD  = 2;
    const STABILITY_WINDOW     = 3;
    const EVENT_TTL            = 86400n;
    const PENDING_TTL          = 3600n;
    const RECOVERY_COOLDOWN    = 900n;
    const MAX_REPORT_AGE       = 604800n;
    const LOCAL_CHAIN_SELECTOR = 1n;
    const ABS_CAP = 1_000_000n;
    const REL_CAP =   500_000n;
    const ALLOC   =   200_000n;
    const ADAPTER_ADDR = "0x000000000000000000000000000000000000dEaD";

    beforeEach(async function () {
        [forwarder, vaultOwner, admin, coinSigner, oracleSigner, irmSigner] =
            await ethers.getSigners();

        _ts = BigInt((await ethers.provider.getBlock("latest")).timestamp) - 1000n;

        coinAddr = coinSigner.address;

        // Deploy MockMorphoVaultV2 (owned by vaultOwner)
        const MockMorpho = await ethers.getContractFactory("MockMorphoVaultV2");
        morphoVault = await MockMorpho.deploy(vaultOwner.address);

        // Deploy holdLedger, exposureRegistry, eventRegistry
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

        // Deploy receiver — vault = morphoVault
        const ReceiverFactory = await ethers.getContractFactory("StableGuardCREReceiver");
        receiver = await ReceiverFactory.deploy(
            forwarder.address,
            await registry.getAddress(),
            await eventRegistry.getAddress(),
            await morphoVault.getAddress(),
            LOCAL_CHAIN_SELECTOR,
            await holdLedger.getAddress(),
            MAX_REPORT_AGE
        );

        await eventRegistry.connect(admin).setHoldLedger(await holdLedger.getAddress());
        await eventRegistry.connect(admin).transferController(await receiver.getAddress());
        await holdLedger.connect(admin).transferCoordinator(await receiver.getAddress());

        // Register exposure (ExposureRegistry admin = admin)
        await registry.connect(admin).registerExposure(
            await morphoVault.getAddress(),
            addrToBytes32(coinAddr)
        );

        // Deploy and wire the Morpho sentinel adapter
        const AdapterFactory = await ethers.getContractFactory("MorphoSentinelAdapter");
        adapter = await AdapterFactory.deploy(await morphoVault.getAddress());

        // Set adapter as sentinel on the vault (vault owner)
        await morphoVault.connect(vaultOwner).setIsSentinel(await adapter.getAddress(), true);

        // Set receiver on adapter (vault owner)
        await adapter.connect(vaultOwner).setReceiver(await receiver.getAddress());

        // Register markets on adapter (vault owner)
        marketData = encodeMarketData(
            admin.address,
            coinAddr,
            oracleSigner.address,
            irmSigner.address,
            700000000000000000n
        );
        marketEntry = { marketData, adapter: ADAPTER_ADDR };
        await adapter.connect(vaultOwner).registerMarkets(coinAddr, [marketEntry]);

        // Set caps and allocation in the mock vault
        await morphoVault.connect(vaultOwner).setCap(marketData, ABS_CAP, REL_CAP);
        await morphoVault.connect(vaultOwner).setAllocation(marketData, ALLOC);

        // Wire the adapter to the receiver (vault owner, because vault has owner())
        await receiver.connect(vaultOwner).setMorphoAdapter(await adapter.getAddress());
    });

    // ── T-19: setMorphoAdapter — non-owner reverts ───────────────────────────

    it("T-19: setMorphoAdapter from non-vault-owner reverts", async function () {
        const AdapterFactory = await ethers.getContractFactory("MorphoSentinelAdapter");
        const adapter2 = await AdapterFactory.deploy(await morphoVault.getAddress());

        await expect(
            receiver.connect(admin).setMorphoAdapter(await adapter2.getAddress())
        ).to.be.revertedWithCustomError(receiver, "Unauthorized");
    });

    // ── T-20: Full depeg — caps zeroed, destination COMPLETE ─────────────────

    it("T-20: depeg report → caps zeroed via adapter → destination slot COMPLETE", async function () {
        // Two watch-level reports first
        await receiver.connect(forwarder).onReport("0x",
            encodeReport([coinAddr], [1], 1));
        await receiver.connect(forwarder).onReport("0x",
            encodeReport([coinAddr], [2], 2));

        // CONFIRMED_DEPEG trigger
        const tx = await receiver.connect(forwarder).onReport("0x",
            encodeReport([coinAddr], [3], 3));
        const receipt = await tx.wait();

        // MorphoCapsZeroed must have fired
        const zeroedEvents = findEvent(receipt, adapter.interface, "MorphoCapsZeroed");
        expect(zeroedEvents.length).to.equal(1);
        expect(zeroedEvents[0].args.marketsCapped).to.equal(1n);

        // Caps zeroed on the vault
        const id = ethers.keccak256(marketData);
        expect(await morphoVault.absoluteCap(id)).to.equal(0n);
        expect(await morphoVault.relativeCap(id)).to.equal(0n);

        // Deallocate called
        expect(await morphoVault.getDeallocCallCount()).to.equal(1n);

        // vaultAuthority returns vault owner
        expect(await receiver.vaultAuthority()).to.equal(vaultOwner.address);
    });

    // ── T-21: Recovery — onRecovery called, MorphoRecoverySignalled emitted ──

    it("T-21: recovery reports → adapter.onRecovery called → MorphoRecoverySignalled emitted", async function () {
        // Trigger depeg
        await receiver.connect(forwarder).onReport("0x",
            encodeReport([coinAddr], [1], 1));
        await receiver.connect(forwarder).onReport("0x",
            encodeReport([coinAddr], [2], 2));
        await receiver.connect(forwarder).onReport("0x",
            encodeReport([coinAddr], [3], 3));

        // STABILITY_WINDOW stable reports to trigger recovery
        let recoveryReceipt = null;
        for (let i = 0; i < STABILITY_WINDOW; i++) {
            const tx = await receiver.connect(forwarder).onReport("0x",
                encodeReport([coinAddr], [0], 0));
            recoveryReceipt = await tx.wait();
        }

        // At least one of the recovery reports should emit MorphoRecoverySignalled
        const recoveryEvents = findEvent(recoveryReceipt, adapter.interface, "MorphoRecoverySignalled");
        expect(recoveryEvents.length).to.equal(1);
        expect(recoveryEvents[0].args.coin).to.equal(coinAddr);
    });

    // ── T-22: onDepeg with marketsCapped=0 → hold released, destination FAILED

    it("T-22: onDepeg returns 0 (not sentinel) → hold released, destination FAILED", async function () {
        // Revoke sentinel status before depeg triggers
        await morphoVault.connect(vaultOwner).setIsSentinel(await adapter.getAddress(), false);

        await receiver.connect(forwarder).onReport("0x",
            encodeReport([coinAddr], [1], 1));
        await receiver.connect(forwarder).onReport("0x",
            encodeReport([coinAddr], [2], 2));

        const tx = await receiver.connect(forwarder).onReport("0x",
            encodeReport([coinAddr], [3], 3));
        const receipt = await tx.wait();

        // MorphoNotSentinel must have fired from the adapter
        const notSentinelEvents = findEvent(receipt, adapter.interface, "MorphoNotSentinel");
        expect(notSentinelEvents.length).to.equal(1);

        // VaultPauseFailed should NOT fire — onDepeg returned 0 cleanly without throwing
        const pauseFailedEvents = findEvent(receipt, receiver.interface, "VaultPauseFailed");
        expect(pauseFailedEvents.length).to.equal(0);

        // Hold was released — activeHoldCount should be 0
        expect(await holdLedger.activeHoldCount(await morphoVault.getAddress())).to.equal(0n);

        // EventTerminated with State.FAILED (9) was emitted by the registry
        const termEvents = findEvent(receipt, eventRegistry.interface, "EventTerminated");
        expect(termEvents.length).to.equal(1);
        expect(termEvents[0].args.terminal).to.equal(9n); // State.FAILED
    });

    // ── T-23: setMorphoAdapter reads vault.owner() live ─────────────────────

    it("T-23: setMorphoAdapter reads vault.owner() live — after transfer old owner reverts, new owner succeeds", async function () {
        const signers = await ethers.getSigners();
        const newVaultOwner = signers[6]; // spare signer not used in beforeEach

        // Transfer vault ownership to a new address
        await morphoVault.connect(vaultOwner).transferOwnership(newVaultOwner.address);

        // Old owner (vaultOwner) can no longer set the adapter — auth re-reads owner() live
        await expect(
            receiver.connect(vaultOwner).setMorphoAdapter(ethers.ZeroAddress)
        ).to.be.revertedWithCustomError(receiver, "Unauthorized");

        // New owner can now set the adapter
        const AdapterFactory = await ethers.getContractFactory("MorphoSentinelAdapter");
        const adapter2 = await AdapterFactory.deploy(await morphoVault.getAddress());
        await receiver.connect(newVaultOwner).setMorphoAdapter(await adapter2.getAddress());
        expect(await receiver.morphoAdapter()).to.equal(await adapter2.getAddress());
    });

    // ── T-25: L-03 — receiver passes per-coin level, not compositeScore, to onDepeg ──

    it("T-25 (L-03): receiver passes per-coin level to adapter — level=3 caps when compositeScore=2 would not", async function () {
        // Bring event to WATCH
        await receiver.connect(forwarder).onReport("0x",
            encodeReport([coinAddr], [1], 1));

        // Bring event to CONFIRMED_DEPEG via level=2; adapter receives level=2 < criticalThreshold=3
        // → onDepeg returns 0 → hold released → event FAILED (terminal)
        await receiver.connect(forwarder).onReport("0x",
            encodeReport([coinAddr], [2], 2));

        // Final report: coin level=3 (at criticalThreshold=3), compositeScore=2 (below criticalThreshold).
        // Before L-03 fix: onDepeg(coin, compositeScore=2) → 0 → no caps zeroed → FAILED
        // After  L-03 fix: onDepeg(coin, level=3)          → caps zeroed → destination COMPLETE
        const tx = await receiver.connect(forwarder).onReport("0x",
            encodeReport([coinAddr], [3], 2));
        const receipt = await tx.wait();

        // MorphoCapsZeroed must fire with marketsCapped=1 (level=3 met criticalThreshold=3)
        const zeroedEvents = findEvent(receipt, adapter.interface, "MorphoCapsZeroed");
        expect(zeroedEvents.length).to.equal(1, "MorphoCapsZeroed must be emitted");
        expect(zeroedEvents[0].args.marketsCapped).to.equal(1n,
            "one market must be capped — proves level (not compositeScore) was used");

        // No VaultPauseFailed — caps zeroed cleanly
        const pauseFailedEvents = findEvent(receipt, receiver.interface, "VaultPauseFailed");
        expect(pauseFailedEvents.length).to.equal(0, "VaultPauseFailed must not fire");
    });

    // ── T-26: M-01 — setMorphoAdapter blocked while active hold exists ───────

    it("T-26 (M-01-a): setMorphoAdapter reverts ActiveHoldsExist while vault has an active hold", async function () {
        // Three-report sequence to reach PROTECTED with one active hold
        await receiver.connect(forwarder).onReport("0x", encodeReport([coinAddr], [1], 1));
        await receiver.connect(forwarder).onReport("0x", encodeReport([coinAddr], [2], 2));
        await receiver.connect(forwarder).onReport("0x", encodeReport([coinAddr], [3], 3));

        expect(await holdLedger.activeHoldCount(await morphoVault.getAddress())).to.equal(1n);

        // setMorphoAdapter must revert while the vault hold is live
        await expect(
            receiver.connect(vaultOwner).setMorphoAdapter(ethers.ZeroAddress)
        ).to.be.revertedWithCustomError(receiver, "ActiveHoldsExist");
    });

    // ── T-27: M-01 — setMorphoAdapter succeeds after recovery (hold released) ─

    it("T-27 (M-01-b): setMorphoAdapter succeeds after recovery releases the hold", async function () {
        // Freeze vault (reports at 1, 2, 3)
        await receiver.connect(forwarder).onReport("0x", encodeReport([coinAddr], [1], 1));
        await receiver.connect(forwarder).onReport("0x", encodeReport([coinAddr], [2], 2));
        await receiver.connect(forwarder).onReport("0x", encodeReport([coinAddr], [3], 3));

        // Run stability window to trigger recovery and release the hold
        for (let i = 0; i < STABILITY_WINDOW; i++) {
            await receiver.connect(forwarder).onReport("0x", encodeReport([coinAddr], [0], 0));
        }

        expect(await holdLedger.activeHoldCount(await morphoVault.getAddress())).to.equal(0n,
            "hold must be released after recovery");

        // setMorphoAdapter must now succeed
        const AdapterFactory = await ethers.getContractFactory("MorphoSentinelAdapter");
        const newAdapter = await AdapterFactory.deploy(await morphoVault.getAddress());
        await expect(
            receiver.connect(vaultOwner).setMorphoAdapter(await newAdapter.getAddress())
        ).to.emit(receiver, "MorphoAdapterSet");
        expect(await receiver.morphoAdapter()).to.equal(await newAdapter.getAddress());
    });
});
