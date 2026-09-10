require("@nomicfoundation/hardhat-toolbox");
require("dotenv").config({ path: "./stableguard-cre/.env" });

const SEPOLIA_RPC_URL     = process.env.SEPOLIA_RPC_URL     ?? "";
const CRE_ETH_PRIVATE_KEY = process.env.CRE_ETH_PRIVATE_KEY ?? "";

/** @type import('hardhat/config').HardhatUserConfig */
module.exports = {
    solidity: {
        version: "0.8.24",
        settings: {
            evmVersion: "cancun",
        },
    },
    networks: {
        sepolia: {
            url:      SEPOLIA_RPC_URL,
            accounts: CRE_ETH_PRIVATE_KEY ? [`0x${CRE_ETH_PRIVATE_KEY}`] : [],
            chainId:  11155111,
        },
    },
    paths: {
        sources:   "./stableguard-cre/contracts",
        tests:     "./test",
        cache:     "./cache",
        artifacts: "./artifacts",
    },
};
