"use strict";

/**
 * Redeploy StableGuardCREReceiver with supportsInterface support on Arbitrum Sepolia.
 *
 * Usage:
 *   npx hardhat run scripts/redeploy-receiver-arbitrum.js --network arbitrumSepolia
 *
 * Idempotent: if a previous run deployed the new receiver but failed during wiring,
 * re-running skips the deployment step and retries only the incomplete wiring steps.
 * Completed wiring steps are detected via on-chain state and skipped.
 */

const hre  = require("hardhat");
const fs   = require("fs");
const path = require("path");

const REQUIRED_CHAIN_ID = 421614n;  // Arbitrum Sepolia
const MAX_REPORT_AGE    = 3_600n;   // override old value (was 604800)

async function main() {
    const network = hre.network.name;

    // ── Chain guard ───────────────────────────────────────────────────────────
    const { chainId } = await hre.ethers.provider.getNetwork();
    if (chainId !== REQUIRED_CHAIN_ID) {
        throw new Error(
            `Wrong network. Expected Arbitrum Sepolia (chainId 421614), got ${chainId}.\n` +
            `Run with: --network arbitrumSepolia`
        );
    }

    // ── Load deployment record ────────────────────────────────────────────────
    const filenameMap    = { arbitrumSepolia: "arbitrum-sepolia" };
    const deploymentFile = path.join(__dirname, `../deployments/${filenameMap[network] ?? network}.json`);
    if (!fs.existsSync(deploymentFile)) {
        throw new Error(`No deployment file at ${deploymentFile}`);
    }
    const deployment       = JSON.parse(fs.readFileSync(deploymentFile, "utf8"));
    const recordedDeployer = deployment.deployer;

    // ── Signer guard ─────────────────────────────────────────────────────────
    const [signer] = await hre.ethers.getSigners();
    if (signer.address.toLowerCase() !== recordedDeployer.toLowerCase()) {
        throw new Error(
            `Signer mismatch.\n` +
            `  Expected: ${recordedDeployer}\n` +
            `  Got:      ${signer.address}\n` +
            `Load the correct private key before running this script.`
        );
    }
    console.log(`Network:  ${network} (chainId ${chainId})`);
    console.log(`Deployer: ${signer.address}\n`);

    // ── Idempotency check ─────────────────────────────────────────────────────
    let oldReceiverAddr;
    let newReceiverAddr;
    let skipDeploy = false;

    if (deployment.contracts.previousReceiver) {
        oldReceiverAddr = deployment.contracts.previousReceiver;
        newReceiverAddr = deployment.contracts.StableGuardCREReceiver;
        skipDeploy      = true;
        console.log(`Resuming previous run.`);
        console.log(`  Old receiver: ${oldReceiverAddr}`);
        console.log(`  New receiver: ${newReceiverAddr}\n`);
    } else {
        oldReceiverAddr = deployment.contracts.StableGuardCREReceiver;
        console.log(`Old receiver: ${oldReceiverAddr}\n`);
    }

    // ── Read constructor args from old receiver ───────────────────────────────
    console.log("Reading constructor args from old receiver...");
    const oldReceiver = await hre.ethers.getContractAt("StableGuardCREReceiver", oldReceiverAddr);
    const [
        forwarderAddr,
        exposureAddr,
        eventAddr,
        vaultAddr,
        localChainSelector,
        holdAddr,
    ] = await Promise.all([
        oldReceiver.forwarder(),
        oldReceiver.exposureRegistry(),
        oldReceiver.eventRegistry(),
        oldReceiver.vault(),
        oldReceiver.localChainSelector(),
        oldReceiver.holdLedger(),
    ]);
    console.log(`  forwarder:          ${forwarderAddr}`);
    console.log(`  exposureRegistry:   ${exposureAddr}`);
    console.log(`  eventRegistry:      ${eventAddr}`);
    console.log(`  vault:              ${vaultAddr}`);
    console.log(`  localChainSelector: ${localChainSelector}`);
    console.log(`  holdLedger:         ${holdAddr}`);
    console.log(`  maxReportAge:       ${MAX_REPORT_AGE} (overriding old value)\n`);

    // ── Deploy new receiver (skip if already done) ────────────────────────────
    if (!skipDeploy) {
        console.log("Deploying new StableGuardCREReceiver...");
        const StableGuardCREReceiver = await hre.ethers.getContractFactory("StableGuardCREReceiver");
        const newReceiver = await StableGuardCREReceiver.deploy(
            forwarderAddr,
            exposureAddr,
            eventAddr,
            vaultAddr,
            localChainSelector,
            holdAddr,
            MAX_REPORT_AGE
        );
        await newReceiver.waitForDeployment();
        newReceiverAddr = await newReceiver.getAddress();
        console.log(`  ✓ New StableGuardCREReceiver: ${newReceiverAddr}\n`);

        // Write to deployment file immediately before wiring so a partial run is resumable
        deployment.contracts.previousReceiver       = oldReceiverAddr;
        deployment.contracts.StableGuardCREReceiver = newReceiverAddr;
        fs.writeFileSync(deploymentFile, JSON.stringify(deployment, null, 2));
        console.log(`  ✓ Deployment file updated (saved before wiring)\n`);
    }

    // ── Interface check guard ─────────────────────────────────────────────────
    console.log("Interface check...");
    const newReceiver = await hre.ethers.getContractAt("StableGuardCREReceiver", newReceiverAddr);
    const [si_iface, si_erc165, si_invalid] = await Promise.all([
        newReceiver.supportsInterface("0x805f2132"),
        newReceiver.supportsInterface("0x01ffc9a7"),
        newReceiver.supportsInterface("0xffffffff"),
    ]);
    if (!si_iface || !si_erc165 || si_invalid) {
        throw new Error(
            `Interface check failed on ${newReceiverAddr}\n` +
            `  supportsInterface(0x805f2132) = ${si_iface}   (expected: true)\n` +
            `  supportsInterface(0x01ffc9a7) = ${si_erc165}  (expected: true)\n` +
            `  supportsInterface(0xffffffff) = ${si_invalid} (expected: false)`
        );
    }
    console.log(`  ✓ IReceiver (0x805f2132): ${si_iface}`);
    console.log(`  ✓ IERC165   (0x01ffc9a7): ${si_erc165}`);
    console.log(`  ✓ invalid   (0xffffffff): ${si_invalid}\n`);

    // ── Wiring ────────────────────────────────────────────────────────────────
    console.log("Wiring...");
    const eventRegistry = await hre.ethers.getContractAt("DepegEventRegistry",   eventAddr);
    const holdLedger    = await hre.ethers.getContractAt("ProtectionHoldLedger", holdAddr);
    const vault         = await hre.ethers.getContractAt("StableGuardVault",     vaultAddr);

    const REPORTER_ROLE_ID    = await eventRegistry.REPORTER_ROLE();
    const ACTION_ROLE_ID      = await eventRegistry.ACTION_ROLE();
    const EVT_PAUSE_ROLE_ID   = await eventRegistry.PAUSE_COORDINATOR_ROLE();
    const VAULT_PAUSE_ROLE_ID = await vault.PAUSE_COORDINATOR_ROLE();

    // Step 1: grant new receiver control of eventRegistry (REPORTER + ACTION + PAUSE_COORDINATOR)
    const newHasReporter = await eventRegistry.hasRole(REPORTER_ROLE_ID, newReceiverAddr);
    if (!newHasReporter) {
        const tx = await eventRegistry.transferController(newReceiverAddr);
        const receipt = await tx.wait();
        console.log(`  ✓ eventRegistry.transferController(new)  tx: ${receipt.hash}`);
    } else {
        console.log(`  SKIP  eventRegistry.transferController (new receiver already has REPORTER_ROLE)`);
    }

    // Step 2: revoke 3 roles from old receiver on eventRegistry
    for (const [id, name] of [
        [REPORTER_ROLE_ID,  "REPORTER_ROLE"],
        [ACTION_ROLE_ID,    "ACTION_ROLE"],
        [EVT_PAUSE_ROLE_ID, "PAUSE_COORDINATOR_ROLE"],
    ]) {
        const held = await eventRegistry.hasRole(id, oldReceiverAddr);
        if (held) {
            const tx = await eventRegistry.revokeRole(id, oldReceiverAddr);
            const receipt = await tx.wait();
            console.log(`  ✓ eventRegistry.revokeRole(${name}, old)  tx: ${receipt.hash}`);
        } else {
            console.log(`  SKIP  eventRegistry.revokeRole(${name}, old) — not held`);
        }
    }

    // Step 3: transfer holdLedger coordinator to new receiver
    // forceTransferCoordinator is callable by governance (deployer); needed because the
    // old receiver (a contract) is coordinator and cannot call transferCoordinator itself.
    const currentCoordinator = await holdLedger.coordinator();
    if (currentCoordinator.toLowerCase() !== newReceiverAddr.toLowerCase()) {
        const tx = await holdLedger.forceTransferCoordinator(newReceiverAddr);
        const receipt = await tx.wait();
        console.log(`  ✓ holdLedger.forceTransferCoordinator(new)  tx: ${receipt.hash}`);
    } else {
        console.log(`  SKIP  holdLedger.forceTransferCoordinator (already new receiver)`);
    }

    // Step 4: grant vault PAUSE_COORDINATOR_ROLE to new receiver
    const newHasVaultPause = await vault.hasRole(VAULT_PAUSE_ROLE_ID, newReceiverAddr);
    if (!newHasVaultPause) {
        const tx = await vault.grantRole(VAULT_PAUSE_ROLE_ID, newReceiverAddr);
        const receipt = await tx.wait();
        console.log(`  ✓ vault.grantRole(PAUSE_COORDINATOR_ROLE, new)  tx: ${receipt.hash}`);
    } else {
        console.log(`  SKIP  vault.grantRole(PAUSE_COORDINATOR_ROLE, new) — already held`);
    }

    // Step 5: revoke vault PAUSE_COORDINATOR_ROLE from old receiver
    const oldHasVaultPause = await vault.hasRole(VAULT_PAUSE_ROLE_ID, oldReceiverAddr);
    if (oldHasVaultPause) {
        const tx = await vault.revokeRole(VAULT_PAUSE_ROLE_ID, oldReceiverAddr);
        const receipt = await tx.wait();
        console.log(`  ✓ vault.revokeRole(PAUSE_COORDINATOR_ROLE, old)  tx: ${receipt.hash}`);
    } else {
        console.log(`  SKIP  vault.revokeRole(PAUSE_COORDINATOR_ROLE, old) — not held`);
    }

    // ── Post-wiring read-back checklist ───────────────────────────────────────
    console.log("\nPost-wiring verification:");
    const [
        newHasRep,
        newHasAct,
        oldHasRep,
        oldHasAct,
        coordinator,
        newHasVP,
        oldHasVP,
        siIface,
        siErc165,
    ] = await Promise.all([
        eventRegistry.hasRole(REPORTER_ROLE_ID,    newReceiverAddr),
        eventRegistry.hasRole(ACTION_ROLE_ID,       newReceiverAddr),
        eventRegistry.hasRole(REPORTER_ROLE_ID,    oldReceiverAddr),
        eventRegistry.hasRole(ACTION_ROLE_ID,       oldReceiverAddr),
        holdLedger.coordinator(),
        vault.hasRole(VAULT_PAUSE_ROLE_ID,          newReceiverAddr),
        vault.hasRole(VAULT_PAUSE_ROLE_ID,          oldReceiverAddr),
        newReceiver.supportsInterface("0x805f2132"),
        newReceiver.supportsInterface("0x01ffc9a7"),
    ]);

    const chk = (pass) => pass ? "✓" : "✗";
    const coordOk = coordinator.toLowerCase() === newReceiverAddr.toLowerCase();

    console.log(`  ${chk(newHasRep)}  eventRegistry: new receiver has REPORTER_ROLE`);
    console.log(`  ${chk(newHasAct)}  eventRegistry: new receiver has ACTION_ROLE`);
    console.log(`  ${chk(!oldHasRep)} eventRegistry: old receiver lost REPORTER_ROLE`);
    console.log(`  ${chk(!oldHasAct)} eventRegistry: old receiver lost ACTION_ROLE`);
    console.log(`  ${chk(coordOk)}  holdLedger coordinator = new receiver  (${coordinator})`);
    console.log(`  ${chk(newHasVP)}  vault: new receiver has PAUSE_COORDINATOR_ROLE`);
    console.log(`  ${chk(!oldHasVP)} vault: old receiver lost PAUSE_COORDINATOR_ROLE`);
    console.log(`  ${chk(siIface)}   new receiver supportsInterface(0x805f2132) [IReceiver]`);
    console.log(`  ${chk(siErc165)}  new receiver supportsInterface(0x01ffc9a7) [IERC165]`);

    const allOk = newHasRep && newHasAct && !oldHasRep && !oldHasAct
        && coordOk && newHasVP && !oldHasVP && siIface && siErc165;

    if (!allOk) {
        throw new Error("One or more wiring checks failed — review the output above.");
    }

    console.log(`\n✓ Receiver redeployment complete on ${network}`);
    console.log(`  Old receiver: ${oldReceiverAddr}`);
    console.log(`  New receiver: ${newReceiverAddr}`);
}

main().catch((err) => {
    console.error(err);
    process.exitCode = 1;
});
