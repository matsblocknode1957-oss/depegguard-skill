"use strict";

/**
 * demo-wire-morpho.js
 *
 * Deploys the Morpho-path infrastructure and wires MorphoSentinelAdapter so that
 * a CRE depeg report can zero Morpho market caps alongside the StableGuardVault freeze.
 *
 * Run AFTER deploy-demo-contracts-arbitrum.js.
 * Run BEFORE demo-wire-all.js and remediate-role-revocation.js.
 *
 * Why a separate receiver?
 *   receiver.setMorphoAdapter requires vault.owner().  StableGuardVault uses AccessControl
 *   (no owner()), so setMorphoAdapter always reverts on the main receiver.  MockMorphoVaultV2
 *   has owner() = deployer, so a fresh StableGuardCREReceiver using it as vault works.
 *
 * What this script deploys and wires:
 *   1. MorphoDepegEventRegistry   — fresh event registry for the Morpho receiver
 *   2. MorphoProtectionHoldLedger — fresh hold ledger for the Morpho receiver
 *   3. MorphoCREReceiver          — vault = MockMorphoVaultV2
 *   4. Wire: setHoldLedger + transferController + transferCoordinator
 *   5. Register USDC exposure on the shared ExposureRegistry for MockMorphoVaultV2
 *   6. mockVault.setIsSentinel(adapter, true)
 *   7. mockVault.setCap + setAllocation  (demo initial values — will be zeroed on depeg)
 *   8. adapter.setReceiver(morphoReceiver)
 *   9. adapter.registerMarkets(USDC_MAINNET, [marketEntry])
 *  10. morphoReceiver.setMorphoAdapter(adapter)
 *  11. Write all Morpho addresses to deployments/arbitrum-sepolia-demo.json
 *
 * On-chain effects of a CRE CONFIRMED_DEPEG report to MorphoCREReceiver:
 *   - MorphoCapsZeroed(coin=USDC_MAINNET, marketsCapped=1) on the adapter
 *   - adapter.absoluteCap == 0, relativeCap == 0  (verify on Arbiscan)
 *   - MorphoHoldLedger.acquire called (hold on MockMorphoVaultV2)
 *
 * Usage (PowerShell):
 *   npx hardhat run scripts/demo-wire-morpho.js --network arbitrumSepolia
 */

const hre  = require("hardhat");
const fs   = require("fs");
const path = require("path");

const USDC_MAINNET = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48";

// Same registry params as the main DepegEventRegistry
const WATCH_THRESHOLD     = 1;
const CONFIRMED_THRESHOLD = 2;
const STABILITY_WINDOW    = 3;
const EVENT_TTL           = 86400;
const PENDING_TTL         = 3600;
const RECOVERY_COOLDOWN   = 1800;
const MAX_REPORT_AGE      = 3600;

// Demo market initial caps — will be zeroed on CONFIRMED_DEPEG
const ABS_CAP = 1_000_000n;
const REL_CAP =   500_000n;
const ALLOC   =   200_000n;

async function main() {
    const { chainId } = await hre.ethers.provider.getNetwork();
    if (chainId !== 421614n) {
        throw new Error(`Expected Arbitrum Sepolia (421614), got ${chainId}`);
    }

    const coreFile = path.join(__dirname, "../deployments/arbitrum-sepolia.json");
    const demoFile = path.join(__dirname, "../deployments/arbitrum-sepolia-demo.json");

    for (const f of [coreFile, demoFile]) {
        if (!fs.existsSync(f)) throw new Error(`Missing deployment file: ${f}\nRun the previous deploy steps first.`);
    }

    const core = JSON.parse(fs.readFileSync(coreFile, "utf8"));
    const demo = JSON.parse(fs.readFileSync(demoFile, "utf8"));

    const exposureRegistryAddr = core.contracts.ExposureRegistry;
    const forwarderAddr        = core.params.keystoneForwarder;
    const chainSelector        = BigInt(core.params.chainSelector);
    const mockVaultAddr        = demo.contracts.MockMorphoVaultV2;
    const adapterAddr          = demo.contracts.MorphoSentinelAdapter;

    const [deployer] = await hre.ethers.getSigners();
    console.log("Network:                  ", hre.network.name);
    console.log("Caller:                   ", deployer.address);
    console.log("ExposureRegistry:         ", exposureRegistryAddr);
    console.log("Forwarder:                ", forwarderAddr);
    console.log("MockMorphoVaultV2:        ", mockVaultAddr);
    console.log("MorphoSentinelAdapter:    ", adapterAddr);
    console.log();

    // Verify deployer owns MockMorphoVaultV2 (required for setIsSentinel, setReceiver, etc.)
    const mockVault = new hre.ethers.Contract(mockVaultAddr, [
        "function owner() external view returns (address)",
        "function setIsSentinel(address account, bool val) external",
        "function setCap(bytes memory idData, uint128 absCap, uint128 relCap) external",
        "function setAllocation(bytes memory idData, uint256 amount) external",
    ], deployer);

    const vaultOwner = await mockVault.owner();
    if (vaultOwner.toLowerCase() !== deployer.address.toLowerCase()) {
        throw new Error(
            `Deployer ${deployer.address} is not MockMorphoVaultV2 owner (${vaultOwner}).\n` +
            "Set CRE_ETH_PRIVATE_KEY to the original deployer key."
        );
    }
    console.log("✓ Deployer owns MockMorphoVaultV2\n");

    // ── 1. MorphoDepegEventRegistry ───────────────────────────────────────────
    console.log("1/3  Deploying MorphoDepegEventRegistry...");
    const DepegEventRegistry = await hre.ethers.getContractFactory("DepegEventRegistry");
    const morphoEventReg = await DepegEventRegistry.deploy(
        deployer.address,
        WATCH_THRESHOLD,
        CONFIRMED_THRESHOLD,
        STABILITY_WINDOW,
        EVENT_TTL,
        PENDING_TTL,
        RECOVERY_COOLDOWN
    );
    await morphoEventReg.waitForDeployment();
    const morphoEventRegAddr = await morphoEventReg.getAddress();
    console.log("     ✓", morphoEventRegAddr);

    // ── 2. MorphoProtectionHoldLedger ─────────────────────────────────────────
    console.log("2/3  Deploying MorphoProtectionHoldLedger...");
    const HoldLedger = await hre.ethers.getContractFactory("ProtectionHoldLedger");
    const morphoHoldLedger = await HoldLedger.deploy(deployer.address, deployer.address);
    await morphoHoldLedger.waitForDeployment();
    const morphoHoldLedgerAddr = await morphoHoldLedger.getAddress();
    console.log("     ✓", morphoHoldLedgerAddr);

    // ── 3. MorphoCREReceiver (vault = MockMorphoVaultV2) ─────────────────────
    console.log("3/3  Deploying MorphoCREReceiver (vault = MockMorphoVaultV2)...");
    const ReceiverFactory = await hre.ethers.getContractFactory("StableGuardCREReceiver");
    const morphoReceiver = await ReceiverFactory.deploy(
        forwarderAddr,
        exposureRegistryAddr,
        morphoEventRegAddr,
        mockVaultAddr,
        chainSelector,
        morphoHoldLedgerAddr,
        MAX_REPORT_AGE
    );
    await morphoReceiver.waitForDeployment();
    const morphoReceiverAddr = await morphoReceiver.getAddress();
    console.log("     ✓", morphoReceiverAddr);

    // ── 4. Wire registry + ledger to receiver ─────────────────────────────────
    console.log("\n── Wiring ───────────────────────────────────────────────────────────");

    console.log("1/6  morphoEventReg.setHoldLedger(morphoHoldLedger)...");
    await (await morphoEventReg.setHoldLedger(morphoHoldLedgerAddr)).wait();
    console.log("     ✓");

    console.log("2/6  morphoEventReg.transferController(morphoReceiver)...");
    await (await morphoEventReg.transferController(morphoReceiverAddr)).wait();
    console.log("     ✓");

    console.log("3/6  morphoHoldLedger.transferCoordinator(morphoReceiver)...");
    await (await morphoHoldLedger.transferCoordinator(morphoReceiverAddr)).wait();
    console.log("     ✓");

    // ── 5. Register USDC exposure for MockMorphoVaultV2 ───────────────────────
    const usdcSym = hre.ethers.zeroPadValue(USDC_MAINNET, 32);
    const exposureReg = new hre.ethers.Contract(exposureRegistryAddr, [
        "function registerExposure(address vault, bytes32 symbol) external",
        "function isExposed(address vault, bytes32 symbol) external view returns (bool)",
    ], deployer);

    const alreadyExposed = await exposureReg.isExposed(mockVaultAddr, usdcSym);
    if (alreadyExposed) {
        console.log("4/6  ExposureRegistry: USDC already registered for MockMorphoVaultV2 — skipping");
    } else {
        console.log("4/6  exposureRegistry.registerExposure(mockVault, USDC)...");
        await (await exposureReg.registerExposure(mockVaultAddr, usdcSym)).wait();
        console.log("     ✓");
    }

    // ── 6-10. Set up MorphoSentinelAdapter ────────────────────────────────────
    console.log("5/6  Setting up MorphoSentinelAdapter...");

    // Encode the demo market: collateralToken = USDC_MAINNET (must equal the reported coin)
    const coder = hre.ethers.AbiCoder.defaultAbiCoder();
    const marketData = coder.encode(
        ["address","address","address","address","uint256"],
        [hre.ethers.ZeroAddress, USDC_MAINNET, hre.ethers.ZeroAddress, hre.ethers.ZeroAddress, 0n]
    );
    // market adapter address passed to vault.deallocate — use deployer as a dummy
    const marketEntry = { marketData, adapter: deployer.address };

    const adapter = new hre.ethers.Contract(adapterAddr, [
        "function setReceiver(address newReceiver) external",
        "function registerMarkets(address coin, tuple(bytes marketData, address adapter)[] entries) external",
    ], deployer);

    console.log("     (a) mockVault.setIsSentinel(adapter, true)");
    await (await mockVault.setIsSentinel(adapterAddr, true)).wait();

    console.log("     (b) mockVault.setCap(marketData, 1_000_000, 500_000)  — initial demo caps");
    await (await mockVault.setCap(marketData, ABS_CAP, REL_CAP)).wait();

    console.log("     (c) mockVault.setAllocation(marketData, 200_000)      — initial demo allocation");
    await (await mockVault.setAllocation(marketData, ALLOC)).wait();

    console.log("     (d) adapter.setReceiver(morphoReceiver)");
    await (await adapter.setReceiver(morphoReceiverAddr)).wait();

    console.log("     (e) adapter.registerMarkets(USDC_MAINNET, [marketEntry])");
    await (await adapter.registerMarkets(USDC_MAINNET, [marketEntry])).wait();

    console.log("6/6  morphoReceiver.setMorphoAdapter(adapter)  (auth: mockVault.owner = deployer)...");
    const rcvr = new hre.ethers.Contract(morphoReceiverAddr, [
        "function setMorphoAdapter(address adapter) external",
    ], deployer);
    await (await rcvr.setMorphoAdapter(adapterAddr)).wait();
    console.log("     ✓ MorphoSentinelAdapter fully wired");

    // ── Save addresses ─────────────────────────────────────────────────────────
    demo.contracts.MorphoCREReceiver        = morphoReceiverAddr;
    demo.contracts.MorphoDepegEventRegistry = morphoEventRegAddr;
    demo.contracts.MorphoHoldLedger         = morphoHoldLedgerAddr;
    demo.morpho = {
        coin:       USDC_MAINNET,
        marketData: marketData,
        absCap:     ABS_CAP.toString(),
        relCap:     REL_CAP.toString(),
        allocation: ALLOC.toString(),
    };
    fs.writeFileSync(demoFile, JSON.stringify(demo, null, 2));
    console.log(`\nAddresses saved to deployments/arbitrum-sepolia-demo.json`);

    console.log("\n── Morpho infrastructure ───────────────────────────────────────────");
    console.log("  MorphoDepegEventRegistry:", morphoEventRegAddr);
    console.log("  MorphoHoldLedger:        ", morphoHoldLedgerAddr);
    console.log("  MorphoCREReceiver:       ", morphoReceiverAddr);
    console.log("  Market coin:              USDC_MAINNET =", USDC_MAINNET);
    console.log("  Initial absCap:           1,000,000  → zeroed on CONFIRMED_DEPEG");
    console.log("  Initial relCap:             500,000  → zeroed on CONFIRMED_DEPEG");
    console.log("  Initial allocation:         200,000  → deallocated on CONFIRMED_DEPEG");
    console.log("\n── Arbiscan checks (after demo-send-morpho.js COUNT=2) ─────────────");
    console.log("  Adapter tx:  MorphoCapsZeroed(coin=USDC_MAINNET, marketsCapped=1)");
    console.log("  Adapter:     absoluteCap(marketId) == 0");
    console.log("  Adapter:     relativeCap(marketId) == 0");
    console.log("\nNext: run demo-wire-all.js (CustomerOverrideModule wiring)");
    console.log("Then: run remediate-role-revocation.js (LAST)");
}

main().catch(err => {
    console.error(err);
    process.exitCode = 1;
});
