"use strict";

const hre = require("hardhat");
const fs  = require("fs");
const path = require("path");

// ── Deployment parameters ──────────────────────────────────────────────────────

const SEPOLIA_USDC           = "0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238"; // Circle USDC on Sepolia
const KEYSTONE_FORWARDER     = "0xF8344CFd5c43616a4366C34E3EEE75af79a74482"; // Production Keystone Forwarder (Sepolia)
const SEPOLIA_CHAIN_SELECTOR = 16015286601757825753n;                        // Chainlink chain selector for Ethereum Sepolia

// DepegEventRegistry thresholds — mirrors test constants
const WATCH_THRESHOLD     = 1;
const CONFIRMED_THRESHOLD = 2;
const STABILITY_WINDOW    = 3;
const EVENT_TTL           = 86_400;  // 1 day
const PENDING_TTL         =  3_600;  // 1 hour
const RECOVERY_COOLDOWN   =  1_800;  // 30 min

// StableGuardCREReceiver
const MAX_REPORT_AGE = 604_800;      // 7 days

// StableGuardVault
const VAULT_NAME   = "StableGuard USDC Vault";
const VAULT_SYMBOL = "sgUSDC";

// ── Main ───────────────────────────────────────────────────────────────────────

async function main() {
    const [deployer] = await hre.ethers.getSigners();

    const balance = await hre.ethers.provider.getBalance(deployer.address);
    console.log("Network:  ", hre.network.name);
    console.log("Deployer: ", deployer.address);
    console.log("Balance:  ", hre.ethers.formatEther(balance), "ETH\n");

    if (balance === 0n) {
        throw new Error("Deployer wallet has no ETH — fund it with Sepolia ETH before deploying.");
    }

    // ── 1. ExposureRegistry ──────────────────────────────────────────────────
    console.log("1/5  Deploying ExposureRegistry...");
    const ExposureRegistry = await hre.ethers.getContractFactory("ExposureRegistry");
    const exposureRegistry = await ExposureRegistry.deploy(deployer.address);
    await exposureRegistry.waitForDeployment();
    const exposureAddr = await exposureRegistry.getAddress();
    console.log("     ✓", exposureAddr);

    // ── 2. DepegEventRegistry ────────────────────────────────────────────────
    console.log("2/5  Deploying DepegEventRegistry...");
    const DepegEventRegistry = await hre.ethers.getContractFactory("DepegEventRegistry");
    const eventRegistry = await DepegEventRegistry.deploy(
        deployer.address,
        WATCH_THRESHOLD,
        CONFIRMED_THRESHOLD,
        STABILITY_WINDOW,
        EVENT_TTL,
        PENDING_TTL,
        RECOVERY_COOLDOWN
    );
    await eventRegistry.waitForDeployment();
    const eventAddr = await eventRegistry.getAddress();
    console.log("     ✓", eventAddr);

    // ── 3. ProtectionHoldLedger ──────────────────────────────────────────────
    // coordinator = deployer initially; transferred to receiver in post-deploy wiring
    console.log("3/5  Deploying ProtectionHoldLedger...");
    const ProtectionHoldLedger = await hre.ethers.getContractFactory("ProtectionHoldLedger");
    const holdLedger = await ProtectionHoldLedger.deploy(deployer.address, deployer.address);
    await holdLedger.waitForDeployment();
    const holdAddr = await holdLedger.getAddress();
    console.log("     ✓", holdAddr);

    // ── 4. StableGuardVault ──────────────────────────────────────────────────
    console.log("4/5  Deploying StableGuardVault (asset: Sepolia USDC)...");
    const StableGuardVault = await hre.ethers.getContractFactory("StableGuardVault");
    const vault = await StableGuardVault.deploy(
        SEPOLIA_USDC,
        VAULT_NAME,
        VAULT_SYMBOL,
        deployer.address
    );
    await vault.waitForDeployment();
    const vaultAddr = await vault.getAddress();
    console.log("     ✓", vaultAddr);

    // ── 5. StableGuardCREReceiver ────────────────────────────────────────────
    console.log("5/5  Deploying StableGuardCREReceiver...");
    const StableGuardCREReceiver = await hre.ethers.getContractFactory("StableGuardCREReceiver");
    const receiver = await StableGuardCREReceiver.deploy(
        KEYSTONE_FORWARDER,
        exposureAddr,
        eventAddr,
        vaultAddr,
        SEPOLIA_CHAIN_SELECTOR,
        holdAddr,
        MAX_REPORT_AGE
    );
    await receiver.waitForDeployment();
    const receiverAddr = await receiver.getAddress();
    console.log("     ✓", receiverAddr);

    // ── Post-deploy wiring ───────────────────────────────────────────────────
    console.log("\nWiring contracts...");

    await (await eventRegistry.setHoldLedger(holdAddr)).wait();
    console.log("  ✓ eventRegistry.setHoldLedger(holdLedger)");

    await (await eventRegistry.transferController(receiverAddr)).wait();
    console.log("  ✓ eventRegistry.transferController(receiver)");

    await (await holdLedger.transferCoordinator(receiverAddr)).wait();
    console.log("  ✓ holdLedger.transferCoordinator(receiver)");

    const PAUSE_COORDINATOR_ROLE = await vault.PAUSE_COORDINATOR_ROLE();
    await (await vault.grantRole(PAUSE_COORDINATOR_ROLE, receiverAddr)).wait();
    console.log("  ✓ vault.grantRole(PAUSE_COORDINATOR_ROLE, receiver)");

    // ── Summary ──────────────────────────────────────────────────────────────
    console.log("\n── Deployment complete ──────────────────────────────────────────────");

    const deployment = {
        network:     hre.network.name,
        deployedAt:  new Date().toISOString(),
        deployer:    deployer.address,
        contracts: {
            ExposureRegistry:       exposureAddr,
            DepegEventRegistry:     eventAddr,
            ProtectionHoldLedger:   holdAddr,
            StableGuardVault:       vaultAddr,
            StableGuardCREReceiver: receiverAddr,
        },
        params: {
            asset:             SEPOLIA_USDC,
            keystoneForwarder: KEYSTONE_FORWARDER,
            chainSelector:     SEPOLIA_CHAIN_SELECTOR.toString(),
            vaultName:         VAULT_NAME,
            vaultSymbol:       VAULT_SYMBOL,
        },
    };

    console.log(JSON.stringify(deployment, null, 2));

    const outPath = path.join(__dirname, "../deployments/sepolia.json");
    fs.writeFileSync(outPath, JSON.stringify(deployment, null, 2));
    console.log(`\nAddresses saved to deployments/sepolia.json`);
    console.log("\nNext step: paste StableGuardCREReceiver address into");
    console.log("  stableguard-cre/depeg-monitor/config.production.json → consumerAddress");
}

main().catch((err) => {
    console.error(err);
    process.exitCode = 1;
});
