"use strict";

const { ethers } = require("hardhat");
const { expect } = require("chai");

describe("TestPriceFeed", function () {
    let owner, other;
    let feed;

    beforeEach(async function () {
        [owner, other] = await ethers.getSigners();
        const TestPriceFeed = await ethers.getContractFactory("TestPriceFeed");
        feed = await TestPriceFeed.deploy(100_000_000n);
        await feed.waitForDeployment();
    });

    it("deploys with initial price", async function () {
        expect(await feed.price()).to.equal(100_000_000n);
        expect(await feed.decimals()).to.equal(8);
        expect(await feed.owner()).to.equal(owner.address);
    });

    it("latestRoundData returns initial price", async function () {
        const [roundId, answer,,, answeredInRound] = await feed.latestRoundData();
        expect(roundId).to.equal(1n);
        expect(answer).to.equal(100_000_000n);
        expect(answeredInRound).to.equal(1n);
    });

    it("owner can setPrice", async function () {
        await feed.setPrice(94_000_000n);
        const [, answer] = await feed.latestRoundData();
        expect(answer).to.equal(94_000_000n);
    });

    it("setPrice emits PriceSet event", async function () {
        await expect(feed.setPrice(94_000_000n))
            .to.emit(feed, "PriceSet")
            .withArgs(94_000_000n, owner.address);
    });

    it("non-owner cannot setPrice", async function () {
        await expect(feed.connect(other).setPrice(94_000_000n))
            .to.be.revertedWithCustomError(feed, "Unauthorized");
    });

    it("reverts on zero or negative initial price", async function () {
        const TestPriceFeed = await ethers.getContractFactory("TestPriceFeed");
        await expect(TestPriceFeed.deploy(0n))
            .to.be.revertedWithCustomError(feed, "InvalidPrice");
    });

    it("reverts on zero or negative setPrice", async function () {
        await expect(feed.setPrice(0n))
            .to.be.revertedWithCustomError(feed, "InvalidPrice");
        await expect(feed.setPrice(-1n))
            .to.be.revertedWithCustomError(feed, "InvalidPrice");
    });

    it("owner can transfer ownership and new owner can set price", async function () {
        await feed.transferOwnership(other.address);
        await feed.connect(other).setPrice(94_000_000n);
        expect(await feed.price()).to.equal(94_000_000n);
    });

    it("transferOwnership to zero reverts", async function () {
        await expect(feed.transferOwnership(ethers.ZeroAddress))
            .to.be.revertedWithCustomError(feed, "Unauthorized");
    });
});
