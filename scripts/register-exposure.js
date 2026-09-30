"use strict";

/**
 * register-exposure.js
 *
 * Registers USDC exposure for the StableGuard vault in ExposureRegistry.
 *
 * Symbol encoding: the receiver uses `bytes32(uint256(uint160(coin)))` where
 * `coin` is the address from the workflow config. The workflow uses MAINNET
 * coin addresses as chain-agnostic identifiers, so the symbol registered here
 * must be derived from the mainnet USDC address regardless of which testnet
 * the vault is deployed on.
 *
 * Usage:
 *   npx hardhat run scripts/register-exposure.js --network sepolia
 *   npx hardhat run scripts/register-exposure.js --network arbitrumSepolia
 */

const hre = require("hardhat");

// Mainnet USDC — used as coin identifier in the workflow (chain-agnostic key)
const USDC_MAINNET = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48";

// Deployments keyed by Hardhat network name.
// expectedAsset: the USDC token address on that testnet (from deployments/*.json params.asset).
// This is the address vault.asset() must return — if it doesn't, something was deployed wrong.
const DEPLOYMENTS = {
  sepolia: {
    exposureRegistry: "0xC60Ceb4faB3B63495534B2a9A5EB3F6C3f668789",
    vault:            "0xAa940C87f3D3251fD297894b5cef7dC7e71b3665",
    expectedAsset:    "0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238",
  },
  arbitrumSepolia: {
    exposureRegistry: "0x55fc74c807dd5aC468Cf2e9B5c26Abb9b1149945",
    vault:            "0x86602cDeC52Df65Bc8D66528De429EB11A9E0497",
    expectedAsset:    "0x75faf114eafb1BDbe2F0316DF893fd58CE46AA4d",
  },
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
  const network = hre.network.name;
  const addrs   = DEPLOYMENTS[network];

  if (!addrs) {
    throw new Error(
      `No deployment addresses for network "${network}". ` +
      `Supported: ${Object.keys(DEPLOYMENTS).join(", ")}`
    );
  }

  const [caller] = await hre.ethers.getSigners();
  console.log("Network:          ", network);
  console.log("Caller:           ", caller.address);

  // ── 1. Confirm vault.asset() matches the expected testnet USDC ────────────
  const vault = new hre.ethers.Contract(addrs.vault, VAULT_ABI, caller);
  const onChainAsset = await vault.asset();
  console.log("\nvault.asset():   ", onChainAsset);
  console.log("Expected asset:  ", addrs.expectedAsset);

  if (onChainAsset.toLowerCase() !== addrs.expectedAsset.toLowerCase()) {
    throw new Error(
      `vault.asset() mismatch on ${network}.\n` +
      `  got:      ${onChainAsset}\n` +
      `  expected: ${addrs.expectedAsset}\n` +
      "The vault may be pointing at a different token. Aborting — do not register exposure."
    );
  }

  console.log(
    "NOTE: The workflow uses MAINNET USDC address as the coin identifier.\n" +
    "      vault.asset() is the deployed-chain asset (different address, same token).\n" +
    "      Registration must use the MAINNET address so the receiver can match it."
  );

  // ── 2. Compute symbol ─────────────────────────────────────────────────────
  // bytes32(uint256(uint160(mainnetUsdcAddress))) — left-pad to 32 bytes
  const sym = hre.ethers.zeroPadValue(hre.ethers.getAddress(USDC_MAINNET), 32);
  console.log("\nMainnet USDC:    ", USDC_MAINNET);
  console.log("Symbol (bytes32):", sym);

  // ── 3. Check current state ────────────────────────────────────────────────
  const reg = new hre.ethers.Contract(addrs.exposureRegistry, EXPOSURE_REGISTRY_ABI, caller);
  const admin = await reg.admin();
  console.log("\nExposureRegistry admin:", admin);

  if (admin.toLowerCase() !== caller.address.toLowerCase()) {
    throw new Error(
      `Caller ${caller.address} is not the admin (${admin}). ` +
      "Use the deployer wallet (CRE_ETH_PRIVATE_KEY in stableguard-cre/.env)."
    );
  }

  const alreadyRegistered = await reg.isExposed(addrs.vault, sym);
  if (alreadyRegistered) {
    console.log("\n✓ Exposure already registered — nothing to do.");
    return;
  }

  // ── 4. Register ───────────────────────────────────────────────────────────
  console.log("\nRegistering exposure...");
  const tx = await reg.registerExposure(addrs.vault, sym);
  console.log("  tx:", tx.hash);
  await tx.wait();

  // ── 5. Verify ─────────────────────────────────────────────────────────────
  const confirmed = await reg.isExposed(addrs.vault, sym);
  if (!confirmed) {
    throw new Error("Registration tx succeeded but isExposed() still returns false — check logs.");
  }

  console.log(`\n✓ Exposure registered.`);
  console.log(`  network:   ${network}`);
  console.log(`  vault:     ${addrs.vault}`);
  console.log(`  symbol:    ${sym}  (mainnet USDC ${USDC_MAINNET})`);
  console.log(`  tx:        ${tx.hash}`);
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
