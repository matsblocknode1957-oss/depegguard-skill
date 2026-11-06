"use strict";

/**
 * deploy-demo-contracts-arbitrum.js
 *
 * Deploys the five optional demo contracts on Arbitrum Sepolia:
 *   1. MockMorphoVaultV2        — settable synthetic Morpho vault for the demo
 *   2. MorphoSentinelAdapter    — calls onDepeg() / onRecovery() on the mock vault
 *   3. CustomerOverrideModule   — customer Safe opt-in hold / earlyUnlock
 *   4. TestPriceFeed            — CRE workflow reads this instead of a real Chainlink feed
 *   5. MockSafe                 — single-owner Safe stand-in; deployer is the initial owner
 *
 * Pre-requisite: run scripts/deploy-arbitrum-sepolia.js first; this script reads
 * deployments/arbitrum-sepolia.json for the core contract addresses.
 *
 * Usage (PowerShell):
 *   npx hardhat run scripts/deploy-demo-contracts-arbitrum.js --network arbitrumSepolia
 */

const hre  = require("hardhat");
const fs   = require("fs");
const path = require("path");

// CustomerOverrideModule constructor params
const MAX_HOLD_DURATION  = 7_200;   // 2 hours in seconds
const SUPPRESSION_WINDOW = 3_600;   // 1 hour in seconds

// TestPriceFeed: $1.00 initial price (8 decimals = 100_000_000)
const INITIAL_PRICE = 100_000_000n;

async function main() {
    const { chainId } = await hre.ethers.provider.getNetwork();
    if (chainId !== 421614n) {
        throw new Error(`Expected Arbitrum Sepolia (421614), got ${chainId}`);
    }

    const [deployer] = await hre.ethers.getSigners();
    const balance = await hre.ethers.provider.getBalance(deployer.address);
    console.log("Network:  Arbitrum Sepolia");
    console.log("Deployer:", deployer.address);
    console.log("Balance: ", hre.ethers.formatEther(balance), "ETH\n");

    // ── Load core deployment ──────────────────────────────────────────────────
    const coreFile = path.join(__dirname, "../deployments/arbitrum-sepolia.json");
    if (!fs.existsSync(coreFile)) {
        throw new Error(
            `No core deployment at ${coreFile}.\n` +
            "Run deploy-arbitrum-sepolia.js first."
        );
    }
    const core = JSON.parse(fs.readFileSync(coreFile, "utf8"));
    const holdLedgerAddr = core.contracts.ProtectionHoldLedger;
    const receiverAddr   = core.contracts.StableGuardCREReceiver;

    console.log("Using core contracts:");
    console.log("  HoldLedger:", holdLedgerAddr);
    console.log("  Receiver:  ", receiverAddr);
    console.log();

    // ── 1. MockMorphoVaultV2 ──────────────────────────────────────────────────
    console.log("1/4  Deploying MockMorphoVaultV2...");
    const MockMorphoVaultV2 = await hre.ethers.getContractFactory("MockMorphoVaultV2");
    const mockVault = await MockMorphoVaultV2.deploy(deployer.address);
    await mockVault.waitForDeployment();
    const mockVaultAddr = await mockVault.getAddress();
    console.log("     ✓", mockVaultAddr);

    // ── 2. MorphoSentinelAdapter ──────────────────────────────────────────────
    console.log("2/4  Deploying MorphoSentinelAdapter...");
    const MorphoSentinelAdapter = await hre.ethers.getContractFactory("MorphoSentinelAdapter");
    const adapter = await MorphoSentinelAdapter.deploy(mockVaultAddr);
    await adapter.waitForDeployment();
    const adapterAddr = await adapter.getAddress();
    console.log("     ✓", adapterAddr);

    // ── 3. CustomerOverrideModule ─────────────────────────────────────────────
    console.log("3/4  Deploying CustomerOverrideModule...");
    const CustomerOverrideModule = await hre.ethers.getContractFactory("CustomerOverrideModule");
    const overrideModule = await CustomerOverrideModule.deploy(
        holdLedgerAddr,
        MAX_HOLD_DURATION,
        SUPPRESSION_WINDOW,
        deployer.address
    );
    await overrideModule.waitForDeployment();
    const overrideModuleAddr = await overrideModule.getAddress();
    console.log("     ✓", overrideModuleAddr);

    // ── 4. TestPriceFeed ──────────────────────────────────────────────────────
    console.log("4/5  Deploying TestPriceFeed (initial $1.00)...");
    const TestPriceFeed = await hre.ethers.getContractFactory("TestPriceFeed");
    const priceFeed = await TestPriceFeed.deploy(INITIAL_PRICE);
    await priceFeed.waitForDeployment();
    const priceFeedAddr = await priceFeed.getAddress();
    console.log("     ✓", priceFeedAddr);

    // ── 5. MockSafe ───────────────────────────────────────────────────────────
    // Single-owner Safe stand-in. Deployer is the initial (and only) owner.
    // Used as overrideAuthority by CustomerOverrideModule.
    // earlyUnlock and cancelHold are routed through this contract so that
    // msg.sender == MockSafe address == overrideAuthority[vault].
    console.log("5/5  Deploying MockSafe (owner: deployer)...");
    const MockSafe = await hre.ethers.getContractFactory("MockSafe");
    const mockSafe = await MockSafe.deploy(deployer.address);
    await mockSafe.waitForDeployment();
    const mockSafeAddr = await mockSafe.getAddress();
    console.log("     ✓", mockSafeAddr);

    // ── Summary ───────────────────────────────────────────────────────────────
    console.log("\n── Demo contracts deployed ─────────────────────────────────────────");
    console.log("  MockMorphoVaultV2:       ", mockVaultAddr);
    console.log("  MorphoSentinelAdapter:   ", adapterAddr);
    console.log("  CustomerOverrideModule:  ", overrideModuleAddr);
    console.log("  TestPriceFeed ($1.00):   ", priceFeedAddr);
    console.log("  MockSafe (owner: deployer):", mockSafeAddr);

    console.log("\n── Next steps ──────────────────────────────────────────────────────");
    console.log("  1. Update config.arbitrum-demo.json:");
    console.log("     - consumerAddress  → new receiver address");
    console.log("     - demoFeedAddress  → TestPriceFeed:", priceFeedAddr);
    console.log("  2. Wire CustomerOverrideModule:");
    console.log("     npx hardhat run scripts/demo-wire-all.js --network arbitrumSepolia");
    console.log("  3. Stage depeg price (PowerShell):');");
    console.log("     $env:PRICE='94000000'; npx hardhat run scripts/demo-set-price.js --network arbitrumSepolia");

    const demo = {
        network:     "arbitrumSepolia",
        deployedAt:  new Date().toISOString(),
        deployer:    deployer.address,
        contracts: {
            MockMorphoVaultV2:      mockVaultAddr,
            MorphoSentinelAdapter:  adapterAddr,
            CustomerOverrideModule: overrideModuleAddr,
            TestPriceFeed:          priceFeedAddr,
            MockSafe:               mockSafeAddr,
        },
        params: {
            maxHoldDuration:   MAX_HOLD_DURATION,
            suppressionWindow: SUPPRESSION_WINDOW,
            initialPrice:      INITIAL_PRICE.toString(),
        },
    };

    console.log(JSON.stringify(demo, null, 2));

    const outPath = path.join(__dirname, "../deployments/arbitrum-sepolia-demo.json");
    fs.writeFileSync(outPath, JSON.stringify(demo, null, 2));
    console.log(`\nAddresses saved to deployments/arbitrum-sepolia-demo.json`);
}

main().catch(err => {
    console.error(err);
    process.exitCode = 1;
});
