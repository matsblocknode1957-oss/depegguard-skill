require("@nomicfoundation/hardhat-toolbox");

/** @type import('hardhat/config').HardhatUserConfig */
module.exports = {
    solidity: "0.8.24",
    paths: {
        sources: "./stableguard-cre/contracts",
        tests: "./test",
        cache: "./cache",
        artifacts: "./artifacts",
    },
};
