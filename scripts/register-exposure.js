"use strict";

/**
 * register-exposure.js
 *
 * Registers USDC exposure for the StableGuard vault in ExposureRegistry.
 * Reads addresses from deployments/<network>.json (written by deploy-arbitrum-sepolia.js).
 *
 * Usage:
 *   npx hardhat run scripts/register-exposure.js --network arbitrumSepolia
 *   npx hardhat run scripts/register-exposure.js --network sepolia
 */

const hre  = require("hardhat");
const fs   = require("fs");
const path = require("path");

// Mainnet USDC — used as coin identifier in the workflow (chain-agnostic key).
// The receiver encodes coin addresses as bytes32(uint256(uint160(addr))).
const USDC_MAINNET = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48";

const NETWORK_FILE_MAP = {
  arbitrumSepolia: "arbitrum-sepolia",
  sepolia:         "sepolia",
};

const EXPOSURE_REGISTRY_ABI = [
  "function registerExposure(address vault, bytes32 symbol) external",
  "function isExposed(address vault, bytes32 symbol) external view returns (bool)",
  "function admin() external view returns (address)",
];

const VAULT_ABI = [
  "function asset() external view returns (address)",
];

async function main() {
  const network   = hre.network.name;
  const fileKey   = NETWORK_FILE_MAP[network];
  if (!fileKey) {
    throw new Error(
      `Unsupported network "${network}". Supported: ${Object.keys(NETWORK_FILE_MAP).join(", ")}`
    );
  }

  const deploymentFile = path.join(__dirname, `../deployments/${fileKey}.json`);
  if (!fs.existsSync(deploymentFile)) {
    throw new Error(
      `No deployment file at ${deploymentFile}.\n` +
      "Run the deploy script first."
    );
  }

  const deployment = JSON.parse(fs.readFileSync(deploymentFile, "utf8"));
  const exposureRegistryAddr = deployment.contracts.ExposureRegistry;
  const vaultAddr            = deployment.contracts.StableGuardVault;
  const expectedAsset        = deployment.params.asset;
  const recordedDeployer     = deployment.deployer;

  const [caller] = await hre.ethers.getSigners();
  console.log("Network:  ", network);
  console.log("Caller:   ", caller.address);

  if (caller.address.toLowerCase() !== recordedDeployer.toLowerCase()) {
    throw new Error(
      `Signer mismatch.\n` +
      `  Expected deployer: ${recordedDeployer}\n` +
      `  Got:               ${caller.address}\n` +
      "Set CRE_ETH_PRIVATE_KEY to the original deployer key."
    );
  }

  // ── 1. Confirm vault.asset() matches ──────────────────────────────────────
  const vault = new hre.ethers.Contract(vaultAddr, VAULT_ABI, caller);
  const onChainAsset = await vault.asset();
  console.log("\nvault.asset():   ", onChainAsset);
  console.log("Expected asset:  ", expectedAsset);

  if (onChainAsset.toLowerCase() !== expectedAsset.toLowerCase()) {
    throw new Error(
      `vault.asset() mismatch. Got ${onChainAsset}, expected ${expectedAsset}.\n` +
      "The vault may be pointing at the wrong token."
    );
  }

  console.log(
    "NOTE: Registration uses MAINNET USDC as the coin identifier.\n" +
    "      The workflow uses mainnet addresses as chain-agnostic keys."
  );

  // ── 2. Compute symbol ──────────────────────────────────────────────────────
  const sym = hre.ethers.zeroPadValue(hre.ethers.getAddress(USDC_MAINNET), 32);
  console.log("\nMainnet USDC:    ", USDC_MAINNET);
  console.log("Symbol (bytes32):", sym);

  // ── 3. Check current state ─────────────────────────────────────────────────
  const reg   = new hre.ethers.Contract(exposureRegistryAddr, EXPOSURE_REGISTRY_ABI, caller);
  const admin = await reg.admin();
  console.log("\nExposureRegistry admin:", admin);

  if (admin.toLowerCase() !== caller.address.toLowerCase()) {
    throw new Error(
      `Caller ${caller.address} is not the ExposureRegistry admin (${admin}).`
    );
  }

  const alreadyRegistered = await reg.isExposed(vaultAddr, sym);
  if (alreadyRegistered) {
    console.log("\n✓ Exposure already registered — nothing to do.");
    return;
  }

  // ── 4. Register ────────────────────────────────────────────────────────────
  console.log("\nRegistering exposure...");
  const tx = await reg.registerExposure(vaultAddr, sym);
  console.log("  tx:", tx.hash);
  await tx.wait();

  const confirmed = await reg.isExposed(vaultAddr, sym);
  if (!confirmed) {
    throw new Error("tx succeeded but isExposed() still returns false — check logs.");
  }

  console.log(`\n✓ Exposure registered.`);
  console.log(`  network:   ${network}`);
  console.log(`  vault:     ${vaultAddr}`);
  console.log(`  symbol:    ${sym}  (mainnet USDC ${USDC_MAINNET})`);
  console.log(`  tx:        ${tx.hash}`);
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
