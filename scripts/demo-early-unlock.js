"use strict";

/**
 * demo-early-unlock.js
 *
 * Executes customer Safe early unlock via MockSafe.callEarlyUnlock().
 * This releases the vault hold immediately and starts the suppression window.
 * Reads addresses from deployments/arbitrum-sepolia.json + arbitrum-sepolia-demo.json.
 *
 * Usage (PowerShell):
 *   npx hardhat run scripts/demo-early-unlock.js --network arbitrumSepolia
 *
 * Pre-requisites:
 *   - demo-wire-all.js has been run
 *   - vault is frozen and hold slot is active (demo-place-hold.js was run)
 *
 * Call chain:
 *   deployer → MockSafe.callEarlyUnlock(module, coin, vault, rootIncidentId)
 *            → CustomerOverrideModule.earlyUnlock(coin, vault, rootIncidentId)
 *            → holdLedger.releaseByOverride(holdId)
 *            → receiver.executeEarlyUnlock(coin, vault)   ← vault unpaused here
 */

const hre  = require("hardhat");
const fs   = require("fs");
const path = require("path");

const USDC_MAINNET = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48";

async function main() {
    const coreFile = path.join(__dirname, "../deployments/arbitrum-sepolia.json");
    const demoFile = path.join(__dirname, "../deployments/arbitrum-sepolia-demo.json");

    for (const f of [coreFile, demoFile]) {
        if (!fs.existsSync(f)) throw new Error(`Missing deployment file: ${f}`);
    }

    const core = JSON.parse(fs.readFileSync(coreFile, "utf8"));
    const demo = JSON.parse(fs.readFileSync(demoFile, "utf8"));

    const vaultAddr    = core.contracts.StableGuardVault;
    const moduleAddr   = demo.contracts.CustomerOverrideModule;
    const mockSafeAddr = demo.contracts.MockSafe;

    const [deployer] = await hre.ethers.getSigners();
    console.log("Network:                 ", hre.network.name);
    console.log("Caller:                  ", deployer.address);
    console.log("MockSafe:                ", mockSafeAddr);
    console.log("CustomerOverrideModule:  ", moduleAddr);
    console.log("Vault:                   ", vaultAddr);
    console.log("Coin (mainnet USDC):     ", USDC_MAINNET);
    console.log();

    const moduleAbi = [
        "function overrideHolds(address coin, address vault) external view returns (bytes32,bytes32,uint256,uint8,bool,bool)",
        "function isHoldActive(address coin, address vault) external view returns (bool)",
    ];
    const module_ = new hre.ethers.Contract(moduleAddr, moduleAbi, deployer);

    const isActive = await module_.isHoldActive(USDC_MAINNET, vaultAddr);
    if (!isActive) {
        throw new Error(
            "No active hold for (USDC, vault).\n" +
            "Run demo-place-hold.js first."
        );
    }

    const slot           = await module_.overrideHolds(USDC_MAINNET, vaultAddr);
    const rootIncidentId = slot[1];
    console.log("rootIncidentId:", rootIncidentId);
    console.log("holdUntil:     ", new Date(Number(slot[2]) * 1000).toISOString());
    console.log();

    const mockSafeAbi = [
        "function callEarlyUnlock(address module, address coin, address vault, bytes32 rootIncidentId) external",
    ];
    const mockSafe = new hre.ethers.Contract(mockSafeAddr, mockSafeAbi, deployer);

    console.log("Executing early unlock via MockSafe...");
    const tx = await mockSafe.callEarlyUnlock(moduleAddr, USDC_MAINNET, vaultAddr, rootIncidentId);
    console.log("TX:", tx.hash);
    await tx.wait();

    console.log("\n✓ Early unlock executed.");
    console.log("  - hold released via holdLedger.releaseByOverride");
    console.log("  - vault.unpause() called by receiver.executeEarlyUnlock");
    console.log("  - suppression window started (same severity will not re-freeze during window)");
    console.log("\nNext: run demo-send-report.js with SCENARIO=stable COUNT=3 to complete recovery.");
}

main().catch(err => {
    console.error(err);
    process.exitCode = 1;
});
