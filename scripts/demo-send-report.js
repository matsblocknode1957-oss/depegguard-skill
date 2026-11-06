"use strict";

/**
 * demo-send-report.js
 *
 * Sends a depeg or stable report to StableGuardCREReceiver via the
 * MockKeystoneForwarder on Arbitrum Sepolia (no signature verification needed).
 * Reads addresses from deployments/arbitrum-sepolia.json.
 *
 * Usage (PowerShell):
 *   # Send 1 CRITICAL report (USDC depeg)
 *   $env:SCENARIO="depeg"; npx hardhat run scripts/demo-send-report.js --network arbitrumSepolia; Remove-Item Env:SCENARIO
 *
 *   # Send 2 CRITICAL reports (triggers CONFIRMED_DEPEG + vault freeze on report 2)
 *   $env:SCENARIO="depeg"; $env:COUNT="2"; npx hardhat run scripts/demo-send-report.js --network arbitrumSepolia; Remove-Item Env:SCENARIO,Env:COUNT
 *
 *   # Send 3 STABLE reports (triggers auto-recovery after stabilityWindow=3)
 *   $env:SCENARIO="stable"; $env:COUNT="3"; npx hardhat run scripts/demo-send-report.js --network arbitrumSepolia; Remove-Item Env:SCENARIO,Env:COUNT
 *
 * Report flow:
 *   deployer → MockKeystoneForwarder.report(receiver, rawReport, "0x", [])
 *            → receiver.onReport("0x", rawReport)
 */

const hre  = require("hardhat");
const fs   = require("fs");
const path = require("path");

// Mainnet USDC — chain-agnostic identifier matching register-exposure.js
const USDC_MAINNET = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48";

// Standard Chainlink KeystoneForwarder interface.
// MockKeystoneForwarder uses the same ABI but skips DON signature verification.
// It calls:  receiver.onReport(reportContext, rawReport)
// So pass:   rawReport = ABI-encoded payload, reportContext = "0x" (metadata)
const FORWARDER_ABI = [
    "function report(address receiver, bytes calldata rawReport, bytes calldata reportContext, bytes[] calldata signatures) external",
];

async function main() {
    const coreFile = path.join(__dirname, "../deployments/arbitrum-sepolia.json");
    if (!fs.existsSync(coreFile)) {
        throw new Error(
            `Core deployment not found at ${coreFile}.\n` +
            "Run deploy-arbitrum-sepolia.js first."
        );
    }
    const core = JSON.parse(fs.readFileSync(coreFile, "utf8"));
    const receiverAddr  = core.contracts.StableGuardCREReceiver;
    const forwarderAddr = core.params.keystoneForwarder;

    const scenario = process.env.SCENARIO ?? "depeg";
    const count    = Math.max(1, parseInt(process.env.COUNT ?? "1", 10));

    if (!["depeg", "stable"].includes(scenario)) {
        throw new Error(`SCENARIO must be "depeg" or "stable". Got: "${scenario}"`);
    }

    const signalLevel    = scenario === "depeg" ? 3 : 0;   // 3=CRITICAL, 0=STABLE
    const compositeScore = signalLevel;
    const price18        = scenario === "depeg"
        ? 940_000_000_000_000_000n   // $0.94 (600 bps)
        : 1_000_000_000_000_000_000n; // $1.00 (0 bps)
    const deviationBps   = scenario === "depeg" ? 600n : 0n;

    const [deployer] = await hre.ethers.getSigners();
    console.log("Network:    ", hre.network.name);
    console.log("Caller:     ", deployer.address);
    console.log("Forwarder:  ", forwarderAddr);
    console.log("Receiver:   ", receiverAddr);
    console.log(`Scenario:    ${scenario.toUpperCase()} x${count}`);
    console.log(`Coin:        ${USDC_MAINNET}  (mainnet USDC — chain-agnostic identifier)\n`);

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
                0,            // marketStress
                observedAt,
            ]
        );

        const tx = await forwarder.report(receiverAddr, rawReport, "0x", []);
        console.log(`Report ${i + 1}/${count}  TX: ${tx.hash}`);
        await tx.wait();

        // Brief pause between reports so timestamps differ (observedAt must be monotonically increasing)
        if (i < count - 1) await new Promise(r => setTimeout(r, 1000));
    }

    console.log();
    if (scenario === "depeg") {
        console.log("✓ CRITICAL report(s) sent.");
        console.log("  1st report → WATCH");
        console.log("  2nd report → CONFIRMED_DEPEG + vault freeze (if CustomerOverrideModule is wired,");
        console.log("               hold slot registered; run demo-place-hold.js to activate it)");
    } else {
        console.log("✓ STABLE report(s) sent.");
        if (count >= 3) {
            console.log("  stabilityWindow=3 reached → auto-recovery initiated (RECOVERY_PENDING).");
            console.log("  Wait recoveryCooldown (1800 s) then the vault unpauses on the next report.");
        } else {
            console.log(`  ${count}/3 stable reports sent — need ${3 - count} more to trigger auto-recovery.`);
        }
    }
}

main().catch(err => {
    console.error(err);
    process.exitCode = 1;
});
