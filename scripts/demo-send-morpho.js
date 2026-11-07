"use strict";

/**
 * demo-send-morpho.js
 *
 * Sends a depeg or stable report to MorphoCREReceiver via MockKeystoneForwarder.
 * On CONFIRMED_DEPEG (2nd CRITICAL report), MorphoSentinelAdapter zeros the USDC
 * market caps and emits MorphoCapsZeroed(coin, marketsCapped=1).
 *
 * This runs ALONGSIDE the main CRE simulate flow in Scene 1 to show the Morpho
 * market protection path on Arbiscan at the same time as StableGuardVault is paused.
 *
 * Usage (PowerShell):
 *   # Two CRITICAL reports → CONFIRMED_DEPEG + MorphoCapsZeroed
 *   $env:COUNT="2"
 *   npx hardhat run scripts/demo-send-morpho.js --network arbitrumSepolia
 *   Remove-Item Env:COUNT
 *
 *   # Three STABLE reports → start RECOVERY_PENDING on Morpho receiver
 *   $env:SCENARIO="stable"; $env:COUNT="3"
 *   npx hardhat run scripts/demo-send-morpho.js --network arbitrumSepolia
 *   Remove-Item Env:SCENARIO, Env:COUNT
 *
 * Pre-requisites: demo-wire-morpho.js has been run.
 *
 * What to look for on Arbiscan after the 2nd CRITICAL report:
 *   TX → MorphoCREReceiver.onReport → MorphoSentinelAdapter call:
 *     MorphoCapsZeroed(coin=0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48, marketsCapped=1)
 *   MorphoSentinelAdapter.absoluteCap(marketId) == 0
 *   MorphoSentinelAdapter.relativeCap(marketId) == 0
 *
 * Note: Morpho cap restoration is a vault-owner admin action, not automated.
 *       After recovery: mockVault.setCap(marketData, newAbsCap, newRelCap) manually.
 */

const hre  = require("hardhat");
const fs   = require("fs");
const path = require("path");

const USDC_MAINNET = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48";

const FORWARDER_ABI = [
    "function report(address receiver, bytes calldata rawReport, bytes calldata reportContext, bytes[] calldata signatures) external",
];

async function main() {
    const coreFile = path.join(__dirname, "../deployments/arbitrum-sepolia.json");
    const demoFile = path.join(__dirname, "../deployments/arbitrum-sepolia-demo.json");

    for (const f of [coreFile, demoFile]) {
        if (!fs.existsSync(f)) throw new Error(`Missing deployment file: ${f}`);
    }

    const core = JSON.parse(fs.readFileSync(coreFile, "utf8"));
    const demo = JSON.parse(fs.readFileSync(demoFile, "utf8"));

    const forwarderAddr = core.params.keystoneForwarder;
    const receiverAddr  = demo.contracts.MorphoCREReceiver;
    if (!receiverAddr) {
        throw new Error("MorphoCREReceiver not found in demo JSON.\nRun demo-wire-morpho.js first.");
    }

    const scenario = process.env.SCENARIO ?? "depeg";
    const count    = Math.max(1, parseInt(process.env.COUNT ?? "1", 10));

    if (!["depeg", "stable"].includes(scenario)) {
        throw new Error(`SCENARIO must be "depeg" or "stable". Got: "${scenario}"`);
    }

    const signalLevel    = scenario === "depeg" ? 3 : 0;
    const compositeScore = signalLevel;
    const price18        = scenario === "depeg"
        ? 940_000_000_000_000_000n
        : 1_000_000_000_000_000_000n;
    const deviationBps   = scenario === "depeg" ? 600n : 0n;

    const [deployer] = await hre.ethers.getSigners();
    console.log("Network:          ", hre.network.name);
    console.log("Caller:           ", deployer.address);
    console.log("Forwarder:        ", forwarderAddr);
    console.log("MorphoCREReceiver:", receiverAddr);
    console.log(`Scenario:          ${scenario.toUpperCase()} x${count}`);
    console.log(`Coin (USDC):       ${USDC_MAINNET}\n`);

    const forwarder = new hre.ethers.Contract(forwarderAddr, FORWARDER_ABI, deployer);
    const coder     = hre.ethers.AbiCoder.defaultAbiCoder();

    for (let i = 0; i < count; i++) {
        const observedAt = BigInt(Math.floor(Date.now() / 1000));
        const rawReport  = coder.encode(
            ["address[]", "uint256[]", "uint256[]", "uint8[]", "bytes[]", "uint8", "uint8", "uint256"],
            [
                [USDC_MAINNET],
                [price18],
                [deviationBps],
                [signalLevel],
                ["0x"],
                compositeScore,
                0,
                observedAt,
            ]
        );

        const tx = await forwarder.report(receiverAddr, rawReport, "0x", []);
        console.log(`Report ${i + 1}/${count}  TX: ${tx.hash}`);
        await tx.wait();

        if (i < count - 1) await new Promise(r => setTimeout(r, 1000));
    }

    console.log();
    if (scenario === "depeg") {
        console.log("✓ CRITICAL report(s) sent to MorphoCREReceiver.");
        if (count === 1) {
            console.log("  1st report → WATCH");
        } else {
            console.log("  1st report → WATCH");
            console.log("  2nd report → CONFIRMED_DEPEG → MorphoCapsZeroed(marketsCapped=1)");
            console.log("  Look for MorphoCapsZeroed on the MorphoSentinelAdapter contract on Arbiscan.");
        }
    } else {
        console.log("✓ STABLE report(s) sent to MorphoCREReceiver.");
        if (count >= 3) {
            console.log("  stabilityWindow=3 reached → RECOVERY_PENDING.");
            console.log("  Wait recoveryCooldown (1800 s), then run once more with COUNT=1 to reach NORMAL.");
            console.log("  On recovery: MorphoRecoverySignalled is emitted (caps NOT auto-restored by protocol).");
        }
    }
}

main().catch(err => {
    console.error(err);
    process.exitCode = 1;
});
