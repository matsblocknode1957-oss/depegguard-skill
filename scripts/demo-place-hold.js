"use strict";

/**
 * demo-place-hold.js
 *
 * Activates the customer override hold after the vault has been frozen.
 * Caller must be an owner of the MockSafe (the deployer is added automatically).
 * Reads addresses from deployments/arbitrum-sepolia.json + arbitrum-sepolia-demo.json.
 *
 * Usage (PowerShell):
 *   npx hardhat run scripts/demo-place-hold.js --network arbitrumSepolia
 *
 * Pre-requisites:
 *   - demo-wire-all.js has been run
 *   - vault is frozen (demo-send-report.js SCENARIO=depeg run twice)
 *   - hold slot was registered by the receiver (happens automatically on freeze)
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

    const vaultAddr  = core.contracts.StableGuardVault;
    const moduleAddr = demo.contracts.CustomerOverrideModule;

    const [deployer] = await hre.ethers.getSigners();
    console.log("Network:                 ", hre.network.name);
    console.log("Caller:                  ", deployer.address);
    console.log("CustomerOverrideModule:  ", moduleAddr);
    console.log("Vault:                   ", vaultAddr);
    console.log("Coin (mainnet USDC):     ", USDC_MAINNET);
    console.log();

    const moduleAbi = [
        "function placeHold(address coin, address vault) external",
        "function isHoldRegistered(address coin, address vault) external view returns (bool)",
        "function isHoldActive(address coin, address vault) external view returns (bool)",
        "function overrideHolds(address coin, address vault) external view returns (bytes32,bytes32,uint256,uint8,bool,bool)",
    ];
    const module_ = new hre.ethers.Contract(moduleAddr, moduleAbi, deployer);

    const isRegistered = await module_.isHoldRegistered(USDC_MAINNET, vaultAddr);
    if (!isRegistered) {
        throw new Error(
            "No hold slot registered for (USDC, vault).\n" +
            "The vault must be frozen first. Run demo-send-report.js with SCENARIO=depeg twice."
        );
    }

    const alreadyActive = await module_.isHoldActive(USDC_MAINNET, vaultAddr);
    if (alreadyActive) {
        const slot = await module_.overrideHolds(USDC_MAINNET, vaultAddr);
        console.log("Hold is already active.");
        console.log(`  holdUntil:      ${new Date(Number(slot[2]) * 1000).toISOString()}`);
        console.log(`  rootIncidentId: ${slot[1]}`);
        console.log("\nRun demo-early-unlock.js to execute the early unlock.");
        return;
    }

    console.log("Placing hold (caller must be an owner of MockSafe)...");
    const tx = await module_.placeHold(USDC_MAINNET, vaultAddr);
    console.log("TX:", tx.hash);
    await tx.wait();

    const slot = await module_.overrideHolds(USDC_MAINNET, vaultAddr);
    console.log("\n✓ Hold placed.");
    console.log(`  holdUntil:      ${new Date(Number(slot[2]) * 1000).toISOString()}`);
    console.log(`  rootIncidentId: ${slot[1]}`);
    console.log("\nNext: run demo-early-unlock.js to trigger immediate vault unfreeze.");
}

main().catch(err => {
    console.error(err);
    process.exitCode = 1;
});
