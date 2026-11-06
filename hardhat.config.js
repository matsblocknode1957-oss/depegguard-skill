require("@nomicfoundation/hardhat-toolbox");
require("dotenv").config({ path: "./stableguard-cre/.env" });

const SEPOLIA_RPC_URL     = process.env.SEPOLIA_RPC_URL     ?? "";
const CRE_ETH_PRIVATE_KEY = process.env.CRE_ETH_PRIVATE_KEY ?? "";
const MAINNET_RPC_URL     = process.env.MAINNET_RPC_URL     ?? "";

const ARB_SEPOLIA_RPC_URL = "https://sepolia-rollup.arbitrum.io/rpc";

// Fork mode: only enabled when FORK=1 AND MAINNET_RPC_URL is set.
// Normal test runs (CI, local) must work with no MAINNET_RPC_URL.
const hardhatNetwork = {};
if (process.env.FORK === "1" && MAINNET_RPC_URL) {
    hardhatNetwork.forking = { url: MAINNET_RPC_URL };
}

/** @type import('hardhat/config').HardhatUserConfig */
module.exports = {
    solidity: {
        version: "0.8.24",
        settings: {
            evmVersion: "cancun",
            optimizer: {
                enabled: true,
                runs: 200,
            },
            viaIR: true,
        },
    },
    networks: {
        hardhat: hardhatNetwork,
        sepolia: {
            url:      SEPOLIA_RPC_URL,
            accounts: CRE_ETH_PRIVATE_KEY ? [`0x${CRE_ETH_PRIVATE_KEY}`] : [],
            chainId:  11155111,
        },
        arbitrumSepolia: {
            url:      ARB_SEPOLIA_RPC_URL,
            accounts: CRE_ETH_PRIVATE_KEY ? [`0x${CRE_ETH_PRIVATE_KEY}`] : [],
            chainId:  421614,
        },
    },
    paths: {
        sources:   "./stableguard-cre/contracts",
        tests:     "./test",
        cache:     "./cache",
        artifacts: "./artifacts",
    },
};
