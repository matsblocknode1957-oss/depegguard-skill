"use strict";

const { ethers } = require("hardhat");
const { expect } = require("chai");

describe("StableGuardCREReceiver", function () {
    let receiver;

    beforeEach(async function () {
        const StableGuardCREReceiver = await ethers.getContractFactory("StableGuardCREReceiver");
        receiver = await StableGuardCREReceiver.deploy(
            ethers.ZeroAddress,  // forwarder
            ethers.ZeroAddress,  // exposureRegistry
            ethers.ZeroAddress,  // eventRegistry
            ethers.ZeroAddress,  // vault
            1n,                  // localChainSelector
            ethers.ZeroAddress,  // holdLedger
            3600n                // maxReportAge
        );
        await receiver.waitForDeployment();
    });

    describe("supportsInterface", function () {
        it("returns true for IReceiver (0x805f2132)", async function () {
            expect(await receiver.supportsInterface("0x805f2132")).to.equal(true);
        });

        it("returns true for IERC165 (0x01ffc9a7)", async function () {
            expect(await receiver.supportsInterface("0x01ffc9a7")).to.equal(true);
        });

        it("returns false for unsupported (0xffffffff)", async function () {
            expect(await receiver.supportsInterface("0xffffffff")).to.equal(false);
        });
    });
});
