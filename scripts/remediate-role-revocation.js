"use strict";

/**
 * Remediation script: revoke REPORTER_ROLE, ACTION_ROLE and PAUSE_COORDINATOR_ROLE
 * from the deployer EOA on an already-deployed DepegEventRegistry.
 *
 * Targets the live testnet contract — no redeployment required.
 *
 * Usage:
 *   npx hardhat run scripts/remediate-role-revocation.js --network sepolia
 *   npx hardhat run scripts/remediate-role-revocation.js --network arbitrumSepolia
 */

const hre  = require("hardhat");
const fs   = require("fs");
const path = require("path");

async function main() {
    const network = hre.network.name;

    // ── Load deployment record ────────────────────────────────────────────────
    // Map Hardhat network names to deployment filenames (camelCase → kebab-case).
    const filenameMap = { arbitrumSepolia: "arbitrum-sepolia" };
    const deploymentFile = path.join(__dirname, `../deployments/${filenameMap[network] ?? network}.json`);
    if (!fs.existsSync(deploymentFile)) {
        throw new Error(`No deployment file found for network "${network}" at ${deploymentFile}`);
    }
    const deployment = JSON.parse(fs.readFileSync(deploymentFile, "utf8"));
    const registryAddr = deployment.contracts.DepegEventRegistry;
    const recordedDeployer = deployment.deployer;

    console.log(`Network:            ${network}`);
    console.log(`DepegEventRegistry: ${registryAddr}`);
    console.log(`Recorded deployer:  ${recordedDeployer}\n`);

    // ── Signer check — must be the deployer ──────────────────────────────────
    const [signer] = await hre.ethers.getSigners();
    if (signer.address.toLowerCase() !== recordedDeployer.toLowerCase()) {
        throw new Error(
            `Signer mismatch.\n` +
            `  Expected: ${recordedDeployer}\n` +
            `  Got:      ${signer.address}\n` +
            `Load the correct private key before running this script.`
        );
    }
    console.log(`Signer confirmed:   ${signer.address}\n`);

    // ── Attach to contract ───────────────────────────────────────────────────
    const registry = await hre.ethers.getContractAt("DepegEventRegistry", registryAddr);

    // ── Resolve role IDs ─────────────────────────────────────────────────────
    const REPORTER_ROLE_ID          = await registry.REPORTER_ROLE();
    const ACTION_ROLE_ID            = await registry.ACTION_ROLE();
    const PAUSE_COORDINATOR_ROLE_ID = await registry.PAUSE_COORDINATOR_ROLE();

    const roles = [
        { id: REPORTER_ROLE_ID,          name: "REPORTER_ROLE" },
        { id: ACTION_ROLE_ID,            name: "ACTION_ROLE" },
        { id: PAUSE_COORDINATOR_ROLE_ID, name: "PAUSE_COORDINATOR_ROLE" },
    ];

    // ── Pre-flight: log current state ────────────────────────────────────────
    console.log("Pre-flight role check (deployer):");
    for (const role of roles) {
        const held = await registry.hasRole(role.id, recordedDeployer);
        console.log(`  ${role.name.padEnd(26)} ${held ? "HELD   ← will revoke" : "already revoked — skipping"}`);
    }
    console.log();

    // ── Revoke each role (skip if already clear) ─────────────────────────────
    for (const role of roles) {
        const held = await registry.hasRole(role.id, recordedDeployer);
        if (!held) {
            console.log(`  SKIP  ${role.name} (not held)`);
            continue;
        }
        const tx = await registry.revokeRole(role.id, recordedDeployer);
        const receipt = await tx.wait();
        console.log(`  ✓ revokeRole(${role.name}, deployer)  tx: ${receipt.hash}`);
    }
    console.log();

    // ── Post-flight: assert all three are cleared ────────────────────────────
    console.log("Post-flight verification:");
    let allClear = true;
    for (const role of roles) {
        const held = await registry.hasRole(role.id, recordedDeployer);
        const status = held ? "STILL HELD ✗" : "revoked    ✓";
        console.log(`  ${role.name.padEnd(26)} ${status}`);
        if (held) allClear = false;
    }
    console.log();

    if (!allClear) {
        throw new Error("One or more roles were not successfully revoked — check the output above.");
    }

    console.log("✓ All three operational roles revoked from deployer on", network);
}

main().catch((err) => {
    console.error(err);
    process.exitCode = 1;
});
