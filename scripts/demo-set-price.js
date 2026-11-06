"use strict";

/**
 * demo-set-price.js
 *
 * Sets the price on TestPriceFeed (Arbitrum Sepolia demo).
 * Reads TestPriceFeed address from deployments/arbitrum-sepolia-demo.json.
 *
 * Usage (PowerShell):
 *   # Stage depeg — $0.94 → 600 bps → CRITICAL
 *   $env:PRICE="94000000"; npx hardhat run scripts/demo-set-price.js --network arbitrumSepolia; Remove-Item Env:PRICE
 *
 *   # Reset to peg — $1.00 → STABLE
 *   $env:RESET="1"; npx hardhat run scripts/demo-set-price.js --network arbitrumSepolia; Remove-Item Env:RESET
 *
 *   # Custom price (8 decimals, e.g. $0.98 = 200 bps WATCH)
 *   $env:PRICE="98000000"; npx hardhat run scripts/demo-set-price.js --network arbitrumSepolia; Remove-Item Env:PRICE
 */

const hre  = require("hardhat");
const fs   = require("fs");
const path = require("path");

const TESTPRICEFEED_ABI = [
    "function setPrice(int256 _price) external",
    "function latestRoundData() external view returns (uint80, int256, uint256, uint256, uint80)",
    "function owner() external view returns (address)",
];

async function main() {
    const demoFile = path.join(__dirname, "../deployments/arbitrum-sepolia-demo.json");
    if (!fs.existsSync(demoFile)) {
        throw new Error(
            `Demo deployment not found at ${demoFile}.\n` +
            "Run deploy-demo-contracts-arbitrum.js first."
        );
    }
    const demo = JSON.parse(fs.readFileSync(demoFile, "utf8"));
    const priceFeedAddr = demo.contracts.TestPriceFeed;

    const price = process.env.RESET === "1"
        ? 100_000_000n
        : BigInt(process.env.PRICE ?? "94000000");

    if (price <= 0n) throw new Error(`Price must be positive (8 decimals). Got: ${price}`);

    const [deployer] = await hre.ethers.getSigners();
    console.log("Network:       ", hre.network.name);
    console.log("Caller:        ", deployer.address);
    console.log("TestPriceFeed: ", priceFeedAddr);
    console.log("Setting price: ", price.toString(), `= $${(Number(price) / 1e8).toFixed(8)}`);

    const feed = new hre.ethers.Contract(priceFeedAddr, TESTPRICEFEED_ABI, deployer);
    const tx   = await feed.setPrice(price);
    console.log("TX:", tx.hash);
    await tx.wait();

    const [, answer] = await feed.latestRoundData();
    const dollars    = (Number(answer) / 1e8).toFixed(8);
    const bps        = Math.round(Math.abs(1 - Number(answer) / 1e8) * 10000);
    console.log(`\n✓ Price set.`);
    console.log(`  latestRoundData answer: ${answer} = $${dollars} (${bps} bps from peg)`);

    if (price === 94_000_000n)  console.log("  → 600 bps CRITICAL — depeg staged.");
    if (price === 100_000_000n) console.log("  → 0 bps STABLE — price reset to peg.");
}

main().catch(err => {
    console.error(err);
    process.exitCode = 1;
});
