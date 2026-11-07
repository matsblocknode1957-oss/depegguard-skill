"use strict";

/**
 * demo-wire-all.js
 *
 * Wires CustomerOverrideModule to StableGuardVault (standard freeze path).
 * Run AFTER deploy-demo-contracts-arbitrum.js.
 *
 * Caller must hold GOVERNANCE_ROLE on StableGuardVault (= original deployer).
 *
 * Wiring steps:
 *   1. module.setVaultAuthority(vault, mockSafe)   — binds MockSafe as the override authority
 *   2. module.setVaultReceiver(vault, receiver)    — module calls executeEarlyUnlock on receiver
 *   3. receiver.setOverrideModule(module)          — enables override path in receiver
 *   4. holdLedger.approveVaultModule(vault, module)— grants module the right to call releaseByOverride
 *
 * Run BEFORE demo-wire-morpho.js and remediate-role-revocation.js.
 */

const hre  = require("hardhat");
const fs   = require("fs");
const path = require("path");

async function main() {
    const coreFile = path.join(__dirname, "../deployments/arbitrum-sepolia.json");
    const demoFile = path.join(__dirname, "../deployments/arbitrum-sepolia-demo.json");

    for (const f of [coreFile, demoFile]) {
        if (!fs.existsSync(f)) throw new Error(`Missing deployment file: ${f}`);
    }

    const core = JSON.parse(fs.readFileSync(coreFile, "utf8"));
    const demo = JSON.parse(fs.readFileSync(demoFile, "utf8"));

    const vaultAddr    = core.contracts.StableGuardVault;
    const holdAddr     = core.contracts.ProtectionHoldLedger;
    const receiverAddr = core.contracts.StableGuardCREReceiver;
    const moduleAddr   = demo.contracts.CustomerOverrideModule;
    const mockSafeAddr = demo.contracts.MockSafe;

    const [deployer] = await hre.ethers.getSigners();
    console.log("Network:                  ", hre.network.name);
    console.log("Caller:                   ", deployer.address);
    console.log("StableGuardVault:         ", vaultAddr);
    console.log("ProtectionHoldLedger:     ", holdAddr);
    console.log("StableGuardCREReceiver:   ", receiverAddr);
    console.log("CustomerOverrideModule:   ", moduleAddr);
    console.log("MockSafe (authority):     ", mockSafeAddr);
    console.log();

    // Confirm caller holds GOVERNANCE_ROLE on the vault
    const govAbi = [
        "function GOVERNANCE_ROLE() external view returns (bytes32)",
        "function hasRole(bytes32 role, address account) external view returns (bool)",
    ];
    const vault   = new hre.ethers.Contract(vaultAddr, govAbi, deployer);
    const govRole = await vault.GOVERNANCE_ROLE();
    if (!(await vault.hasRole(govRole, deployer.address))) {
        throw new Error(
            `Caller ${deployer.address} does not hold GOVERNANCE_ROLE on StableGuardVault.\n` +
            "Set CRE_ETH_PRIVATE_KEY to the original deployer key."
        );
    }
    console.log("✓ Caller holds GOVERNANCE_ROLE on vault\n");

    const moduleAbi = [
        "function setVaultAuthority(address vault, address safe) external",
        "function setVaultReceiver(address vault, address receiver_) external",
    ];
    const receiverAbi  = ["function setOverrideModule(address module) external"];
    const ledgerAbi    = ["function approveVaultModule(address vault, address module) external"];

    const module_  = new hre.ethers.Contract(moduleAddr, moduleAbi, deployer);
    const receiver = new hre.ethers.Contract(receiverAddr, receiverAbi, deployer);
    const ledger   = new hre.ethers.Contract(holdAddr, ledgerAbi, deployer);

    console.log("1/4  module.setVaultAuthority(vault, mockSafe)...");
    await (await module_.setVaultAuthority(vaultAddr, mockSafeAddr)).wait();
    console.log("     ✓");

    console.log("2/4  module.setVaultReceiver(vault, receiver)...");
    await (await module_.setVaultReceiver(vaultAddr, receiverAddr)).wait();
    console.log("     ✓");

    console.log("3/4  receiver.setOverrideModule(module)...");
    await (await receiver.setOverrideModule(moduleAddr)).wait();
    console.log("     ✓");

    console.log("4/4  holdLedger.approveVaultModule(vault, module)...");
    await (await ledger.approveVaultModule(vaultAddr, moduleAddr)).wait();
    console.log("     ✓");

    console.log("\n── CustomerOverrideModule wiring complete ─────────────────────────");
    console.log("  MockSafe (override authority): ", mockSafeAddr);
    console.log("  CustomerOverrideModule:        ", moduleAddr);
    console.log("\nNext: run demo-wire-morpho.js (Morpho infrastructure wiring)");
    console.log("Then: run remediate-role-revocation.js (LAST — strips operational roles)");
}

main().catch(err => {
    console.error(err);
    process.exitCode = 1;
});
