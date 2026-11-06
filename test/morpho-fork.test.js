"use strict";

// Fork tests for MorphoSentinelAdapter against RockawayX USDC Yield v2 on Arbitrum mainnet.
//
// These tests run ONLY when FORK=1 is set.  They make no on-chain transactions;
// all state mutations are local to the hardhat fork.
//
// Usage:
//   FORK=1 MAINNET_RPC_URL=<arb-mainnet-rpc> npx hardhat test test/morpho-fork.test.js

const { ethers, network } = require("hardhat");
const { expect } = require("chai");

const VAULT_ADDR = "0xE0181090c22579B6A217f1522cbf8c9f1F0C1965"; // RockawayX USDC Yield v2 (Arbitrum)

const VAULT_ABI = [
    "function owner() external view returns (address)",
    "function isSentinel(address) external view returns (bool)",
    "function setIsSentinel(address, bool) external",
    "function decreaseAbsoluteCap(bytes memory idData, uint256 newCap) external",
    "function decreaseRelativeCap(bytes memory idData, uint256 newCap) external",
    "function allocation(bytes32 id) external view returns (uint256)",
    "function absoluteCap(bytes32 id) external view returns (uint256)",
    "function relativeCap(bytes32 id) external view returns (uint256)",
];

const IS_FORK = process.env.FORK === "1";

(IS_FORK ? describe : describe.skip)(
    "Fork: RockawayX USDC Yield v2 — MorphoSentinelAdapter compatibility",
    function () {
        this.timeout(120_000);

        let vault;
        let testSentinel;

        before(async function () {
            [testSentinel] = await ethers.getSigners();

            vault = new ethers.Contract(VAULT_ADDR, VAULT_ABI, ethers.provider);

            // Impersonate the vault owner so we can grant sentinel role locally.
            // This is a local fork mutation — nothing is sent to Arbitrum mainnet.
            const ownerAddr = await vault.owner();
            await network.provider.send("hardhat_impersonateAccount", [ownerAddr]);
            await network.provider.send("hardhat_setBalance", [
                ownerAddr,
                "0x" + (10n ** 20n).toString(16), // 100 ETH
            ]);
            const vaultOwner = await ethers.getImpersonatedSigner(ownerAddr);

            await vault.connect(vaultOwner).setIsSentinel(testSentinel.address, true);
        });

        // ── FORK-1: confirm Vault V2 ──────────────────────────────────────────

        it("FORK-1: vault is Morpho V2 — isSentinel() exists and returns expected value", async function () {
            // isSentinel(address) is a V2-only function; calling it on a V1 vault reverts.
            const isSent = await vault.isSentinel(testSentinel.address);
            expect(isSent).to.equal(true,
                "testSentinel was granted via setIsSentinel — isSentinel() must return true");
        });

        // ── FORK-2: probe <= vs < semantics of decreaseAbsoluteCap ───────────

        it("FORK-2: decreaseAbsoluteCap with newCap == currentCap — reports <= vs < semantics", async function () {
            // Use a synthetic market (all-zero params).  For any unregistered market
            // the vault holds absoluteCap = 0, which is the most informative probe value:
            //   • if the vault enforces strict decrease (< ), calling with 0 == 0 reverts.
            //   • if the vault allows equal   (<=), the call succeeds as a no-op.
            const coder = ethers.AbiCoder.defaultAbiCoder();
            const marketData = coder.encode(
                ["address", "address", "address", "address", "uint256"],
                [ethers.ZeroAddress, ethers.ZeroAddress, ethers.ZeroAddress, ethers.ZeroAddress, 0n]
            );
            const marketId   = ethers.keccak256(marketData);
            const currentCap = await vault.absoluteCap(marketId);

            let allowsEqualCap;
            try {
                await vault.connect(testSentinel).decreaseAbsoluteCap.staticCall(marketData, currentCap);
                allowsEqualCap = true;
            } catch {
                allowsEqualCap = false;
            }

            console.log(
                `\n  FORK-2 result: decreaseAbsoluteCap(marketData, currentCap=${currentCap}) ` +
                (allowsEqualCap
                    ? "SUCCEEDS — vault uses <= (equal cap allowed; H-03 skip is a gas optimisation)"
                    : "REVERTS  — vault uses <  (equal cap disallowed; H-03 skip is required for safety)")
                + "\n"
            );

            // This is a probe, not a constraint — both outcomes are valid.
            // Our H-03 fix reads the cap first and skips the call when it is 0,
            // which is correct under both < and <= semantics.
            expect(typeof allowsEqualCap).to.equal("boolean");
        });
    }
);
