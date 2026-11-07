"use strict";

/**
 * verify-all-arbitrum.js
 *
 * Verifies all 13 contracts deployed for the Arbitrum Sepolia demo.
 * Reads addresses and constructor args from:
 *   deployments/arbitrum-sepolia.json      (core 5)
 *   deployments/arbitrum-sepolia-demo.json (demo 5 + Morpho 3)
 *
 * Each contract is wrapped in try/catch so "already verified" or one failure
 * never stops the rest. Prints a summary table at the end.
 *
 * Usage:
 *   npx hardhat run scripts/verify-all-arbitrum.js --network arbitrumSepolia
 */

const hre  = require("hardhat");
const fs   = require("fs");
const path = require("path");

const MAX_REPORT_AGE = 3_600; // hardcoded in both deploy-arbitrum-sepolia.js and demo-wire-morpho.js

async function main() {
    const coreFile = path.join(__dirname, "../deployments/arbitrum-sepolia.json");
    const demoFile = path.join(__dirname, "../deployments/arbitrum-sepolia-demo.json");

    for (const f of [coreFile, demoFile]) {
        if (!fs.existsSync(f)) throw new Error(`Missing deployment file: ${f}`);
    }

    const core = JSON.parse(fs.readFileSync(coreFile, "utf8"));
    const demo = JSON.parse(fs.readFileSync(demoFile, "utf8"));

    const deployer     = core.deployer;
    const chainSelector = BigInt(core.params.chainSelector);

    const c = core.contracts;
    const d = demo.contracts;

    const contracts = [
        // ── Core (arbitrum-sepolia.json) ──────────────────────────────────────
        {
            name: "ExposureRegistry",
            address: c.ExposureRegistry,
            constructorArguments: [deployer],
        },
        {
            name: "DepegEventRegistry",
            address: c.DepegEventRegistry,
            constructorArguments: [deployer, 1, 2, 3, 86_400, 3_600, 1_800],
        },
        {
            name: "ProtectionHoldLedger",
            address: c.ProtectionHoldLedger,
            constructorArguments: [deployer, deployer],
        },
        {
            name: "StableGuardVault",
            address: c.StableGuardVault,
            constructorArguments: [
                core.params.asset,
                core.params.vaultName,
                core.params.vaultSymbol,
                deployer,
            ],
        },
        {
            name: "StableGuardCREReceiver",
            address: c.StableGuardCREReceiver,
            constructorArguments: [
                core.params.keystoneForwarder,
                c.ExposureRegistry,
                c.DepegEventRegistry,
                c.StableGuardVault,
                chainSelector,
                c.ProtectionHoldLedger,
                MAX_REPORT_AGE,
            ],
        },
        // ── Demo (arbitrum-sepolia-demo.json) ─────────────────────────────────
        {
            name: "MockMorphoVaultV2",
            address: d.MockMorphoVaultV2,
            constructorArguments: [deployer],
        },
        {
            name: "MorphoSentinelAdapter",
            address: d.MorphoSentinelAdapter,
            constructorArguments: [d.MockMorphoVaultV2],
        },
        {
            name: "CustomerOverrideModule",
            address: d.CustomerOverrideModule,
            constructorArguments: [
                c.ProtectionHoldLedger,
                demo.params.maxHoldDuration,
                demo.params.suppressionWindow,
                deployer,
            ],
        },
        {
            name: "TestPriceFeed",
            address: d.TestPriceFeed,
            // constructor(int256 _initialPrice) — pass BigInt to encode as int256
            constructorArguments: [BigInt(demo.params.initialPrice)],
        },
        {
            name: "MockSafe",
            address: d.MockSafe,
            constructorArguments: [deployer],
        },
        // ── Morpho infrastructure (also in arbitrum-sepolia-demo.json) ────────
        // These are the same Solidity contracts as above; pass `contract` to
        // disambiguate the artifact name from the JSON key name.
        {
            name: "MorphoDepegEventRegistry",
            address: d.MorphoDepegEventRegistry,
            constructorArguments: [deployer, 1, 2, 3, 86_400, 3_600, 1_800],
            contract: "stableguard-cre/contracts/DepegEventRegistry.sol:DepegEventRegistry",
        },
        {
            name: "MorphoHoldLedger",
            address: d.MorphoHoldLedger,
            constructorArguments: [deployer, deployer],
            contract: "stableguard-cre/contracts/ProtectionHoldLedger.sol:ProtectionHoldLedger",
        },
        {
            name: "MorphoCREReceiver",
            address: d.MorphoCREReceiver,
            constructorArguments: [
                core.params.keystoneForwarder,
                c.ExposureRegistry,
                d.MorphoDepegEventRegistry,
                d.MockMorphoVaultV2,
                chainSelector,
                d.MorphoHoldLedger,
                MAX_REPORT_AGE,
            ],
            contract: "stableguard-cre/contracts/StableGuardCREReceiver.sol:StableGuardCREReceiver",
        },
    ];

    const results = [];

    for (const entry of contracts) {
        const { name, address, constructorArguments, contract } = entry;
        process.stdout.write(`Verifying ${name} @ ${address} ... `);
        try {
            const args = { address, constructorArguments };
            if (contract) args.contract = contract;
            await hre.run("verify:verify", args);
            console.log("✓ verified");
            results.push({ name, address, status: "verified" });
        } catch (err) {
            const msg = err.message ?? String(err);
            const alreadyVerified =
                msg.includes("Already Verified") ||
                msg.includes("already verified") ||
                msg.includes("Contract source code already verified") ||
                msg.includes("Smart-contract already verified");
            if (alreadyVerified) {
                console.log("✓ already verified");
                results.push({ name, address, status: "already" });
            } else {
                const short = msg.split("\n")[0].slice(0, 120);
                console.log(`✗ FAILED: ${short}`);
                results.push({ name, address, status: "failed", error: short });
            }
        }
    }

    // ── Summary table ─────────────────────────────────────────────────────────
    const W_NAME = 28;
    const W_ADDR = 42;
    const divider = "─".repeat(W_NAME + W_ADDR + 20);

    console.log(`\n${divider}`);
    console.log("VERIFICATION SUMMARY");
    console.log(divider);
    console.log(
        `${"Contract".padEnd(W_NAME)}  ${"Address".padEnd(W_ADDR)}  Status`
    );
    console.log(divider);
    for (const r of results) {
        const status =
            r.status === "verified" ? "✓ verified" :
            r.status === "already"  ? "✓ already verified" :
                                      `✗ failed: ${r.error ?? ""}`;
        console.log(`${r.name.padEnd(W_NAME)}  ${r.address.padEnd(W_ADDR)}  ${status}`);
    }
    console.log(divider);

    const failed = results.filter(r => r.status === "failed");
    if (failed.length > 0) {
        console.log(`\n${failed.length} contract(s) failed verification.`);
        process.exitCode = 1;
    } else {
        console.log(`\nAll ${results.length} contracts verified.`);
    }
}

main().catch(err => {
    console.error(err);
    process.exitCode = 1;
});
