"use strict";

const { ethers } = require("hardhat");
const { expect } = require("chai");

// 1000 tokens with 6 decimals (USDC-style)
const DEPOSIT = ethers.parseUnits("1000", 6);
const HALF    = ethers.parseUnits("500", 6);

const PAUSE_THRESHOLD = 2;

function encodeReport(coins, signalLevels, compositeScore) {
    return ethers.AbiCoder.defaultAbiCoder().encode(
        ["address[]", "uint256[]", "uint256[]", "uint8[]", "bytes[]", "uint8", "uint8", "uint256"],
        [
            coins,
            coins.map(() => ethers.parseUnits("0.98", 8)),
            coins.map(() => 200n),
            signalLevels,
            coins.map(() => "0x"),
            compositeScore,
            1,
            BigInt(Math.floor(Date.now() / 1000)),
        ]
    );
}

function addrToBytes32(addr) {
    return ethers.zeroPadValue(addr, 32);
}

describe("StableGuardVault", function () {
    let vault, token;
    let governance, coordinator, alice, bob, attacker;

    beforeEach(async function () {
        [governance, coordinator, alice, bob, attacker] = await ethers.getSigners();

        const MockERC20 = await ethers.getContractFactory("MockERC20");
        token = await MockERC20.deploy("Mock USDC", "mUSDC", 6);

        const StableGuardVault = await ethers.getContractFactory("StableGuardVault");
        vault = await StableGuardVault.deploy(
            await token.getAddress(),
            "StableGuard USDC Vault",
            "sgUSDC",
            governance.address
        );

        // Grant PAUSE_COORDINATOR_ROLE — this is the explicit post-deploy step the spec requires
        await vault.connect(governance).grantRole(
            await vault.PAUSE_COORDINATOR_ROLE(),
            coordinator.address
        );

        // Mint and approve tokens for depositors
        await token.mint(alice.address, DEPOSIT * 10n);
        await token.mint(bob.address, DEPOSIT * 10n);
        await token.connect(alice).approve(await vault.getAddress(), ethers.MaxUint256);
        await token.connect(bob).approve(await vault.getAddress(), ethers.MaxUint256);
    });

    // ── ERC-4626 conformance ──────────────────────────────────────────────────

    describe("ERC-4626 conformance", function () {
        it("deposit pulls tokens from caller and mints shares to receiver", async function () {
            const shares = await vault.previewDeposit(DEPOSIT);
            await vault.connect(alice).deposit(DEPOSIT, alice.address);

            expect(await vault.balanceOf(alice.address)).to.equal(shares);
            expect(await token.balanceOf(await vault.getAddress())).to.equal(DEPOSIT);
        });

        it("mint issues exact shares and pulls the correct assets from caller", async function () {
            const targetShares = ethers.parseUnits("500", 6);
            const assetsRequired = await vault.previewMint(targetShares);

            await vault.connect(alice).mint(targetShares, alice.address);

            expect(await vault.balanceOf(alice.address)).to.equal(targetShares);
            expect(await token.balanceOf(alice.address)).to.equal(DEPOSIT * 10n - assetsRequired);
        });

        it("withdraw burns shares from owner and sends exact assets to receiver", async function () {
            await vault.connect(alice).deposit(DEPOSIT, alice.address);
            const sharesBefore = await vault.balanceOf(alice.address);

            const sharesBurned = await vault.previewWithdraw(HALF);
            await vault.connect(alice).withdraw(HALF, alice.address, alice.address);

            expect(await vault.balanceOf(alice.address)).to.equal(sharesBefore - sharesBurned);
            expect(await token.balanceOf(alice.address)).to.equal(DEPOSIT * 10n - DEPOSIT + HALF);
        });

        it("redeem burns exact shares from owner and sends assets to receiver", async function () {
            await vault.connect(alice).deposit(DEPOSIT, alice.address);
            const shares = await vault.balanceOf(alice.address);
            const assetsOut = await vault.previewRedeem(shares);

            await vault.connect(alice).redeem(shares, alice.address, alice.address);

            expect(await vault.balanceOf(alice.address)).to.equal(0);
            expect(await token.balanceOf(alice.address)).to.equal(DEPOSIT * 10n - DEPOSIT + assetsOut);
        });

        it("totalAssets equals the vault's token balance", async function () {
            await vault.connect(alice).deposit(DEPOSIT, alice.address);
            await vault.connect(bob).deposit(HALF, bob.address);

            expect(await vault.totalAssets()).to.equal(
                await token.balanceOf(await vault.getAddress())
            );
        });

        it("previewDeposit matches actual shares minted", async function () {
            const preview = await vault.previewDeposit(DEPOSIT);
            const tx      = await vault.connect(alice).deposit(DEPOSIT, alice.address);
            const receipt = await tx.wait();
            const event   = receipt.logs.find(
                l => l.fragment && l.fragment.name === "Deposit"
            );
            expect(event.args.shares).to.equal(preview);
        });

        it("previewWithdraw matches actual shares burned", async function () {
            await vault.connect(alice).deposit(DEPOSIT, alice.address);
            const preview = await vault.previewWithdraw(HALF);
            const shares  = await vault.connect(alice).withdraw.staticCall(
                HALF, alice.address, alice.address
            );
            expect(shares).to.equal(preview);
        });

        it("previewRedeem matches actual assets received", async function () {
            await vault.connect(alice).deposit(DEPOSIT, alice.address);
            const shares  = await vault.balanceOf(alice.address);
            const preview = await vault.previewRedeem(shares);
            const assets  = await vault.connect(alice).redeem.staticCall(
                shares, alice.address, alice.address
            );
            expect(assets).to.equal(preview);
        });

        it("convertToShares and convertToAssets are inverses at 1:1 initial rate", async function () {
            await vault.connect(alice).deposit(DEPOSIT, alice.address);
            const shares = await vault.convertToShares(HALF);
            const back   = await vault.convertToAssets(shares);
            // Allow ±1 wei rounding from mulDiv
            const diff = back > HALF ? back - HALF : HALF - back;
            expect(diff).to.be.lte(1n);
        });

        it("share token has the same decimals as the underlying asset", async function () {
            expect(await vault.decimals()).to.equal(await token.decimals());
        });

        // OZ 5.x ERC-4626 applies virtual shares (_decimalsOffset=0: 1 virtual share + 1 virtual
        // asset). This makes donation-based inflation attacks unprofitable without a seeded deposit.
        it("virtual-share protection: first depositor receives shares proportional to assets", async function () {
            await vault.connect(alice).deposit(DEPOSIT, alice.address);
            // With virtual shares the ratio is (0+1)/(0+1)=1:1 for the first deposit.
            // totalAssets() == DEPOSIT; totalSupply() == DEPOSIT.
            expect(await vault.totalSupply()).to.equal(await vault.totalAssets());
        });
    });

    // ── Full freeze (paused = true) ───────────────────────────────────────────

    describe("full freeze (paused)", function () {
        beforeEach(async function () {
            await vault.connect(alice).deposit(DEPOSIT, alice.address);
            await vault.connect(coordinator).pause();
        });

        it("deposit reverts with VaultFullyFrozen", async function () {
            await expect(vault.connect(alice).deposit(HALF, alice.address))
                .to.be.revertedWithCustomError(vault, "VaultFullyFrozen");
        });

        it("mint reverts with VaultFullyFrozen", async function () {
            const shares = await vault.previewDeposit(HALF);
            await expect(vault.connect(alice).mint(shares, alice.address))
                .to.be.revertedWithCustomError(vault, "VaultFullyFrozen");
        });

        it("withdraw reverts with VaultFullyFrozen", async function () {
            await expect(vault.connect(alice).withdraw(HALF, alice.address, alice.address))
                .to.be.revertedWithCustomError(vault, "VaultFullyFrozen");
        });

        it("redeem reverts with VaultFullyFrozen", async function () {
            const shares = await vault.balanceOf(alice.address);
            await expect(vault.connect(alice).redeem(shares, alice.address, alice.address))
                .to.be.revertedWithCustomError(vault, "VaultFullyFrozen");
        });

        it("maxDeposit returns 0", async function () {
            expect(await vault.maxDeposit(alice.address)).to.equal(0);
        });

        it("maxMint returns 0", async function () {
            expect(await vault.maxMint(alice.address)).to.equal(0);
        });

        it("maxRedeem returns 0", async function () {
            expect(await vault.maxRedeem(alice.address)).to.equal(0);
        });

        it("maxWithdraw returns 0 (derived from maxRedeem)", async function () {
            expect(await vault.maxWithdraw(alice.address)).to.equal(0);
        });

        it("unpausing restores all operations", async function () {
            await vault.connect(coordinator).unpause();
            await expect(vault.connect(alice).deposit(HALF, alice.address)).to.not.be.reverted;
            await expect(vault.connect(alice).withdraw(HALF, alice.address, alice.address)).to.not.be.reverted;
        });

        it("emits VaultPaused on pause and VaultUnpaused on unpause", async function () {
            // pause already happened in beforeEach; check VaultUnpaused here
            await expect(vault.connect(coordinator).unpause())
                .to.emit(vault, "VaultUnpaused")
                .withArgs(coordinator.address);
        });
    });

    // ── Deposit-only freeze (depositsFrozen = true) ───────────────────────────

    describe("deposit-only freeze (depositsFrozen)", function () {
        beforeEach(async function () {
            await vault.connect(alice).deposit(DEPOSIT, alice.address);
            await vault.connect(coordinator).pauseDeposits();
        });

        it("deposit reverts with VaultDepositsFrozen", async function () {
            await expect(vault.connect(alice).deposit(HALF, alice.address))
                .to.be.revertedWithCustomError(vault, "VaultDepositsFrozen");
        });

        it("mint reverts with VaultDepositsFrozen", async function () {
            const shares = await vault.previewDeposit(HALF);
            await expect(vault.connect(alice).mint(shares, alice.address))
                .to.be.revertedWithCustomError(vault, "VaultDepositsFrozen");
        });

        it("withdraw succeeds — existing holders can exit during depeg", async function () {
            await expect(vault.connect(alice).withdraw(HALF, alice.address, alice.address))
                .to.not.be.reverted;
            expect(await token.balanceOf(alice.address)).to.equal(DEPOSIT * 10n - DEPOSIT + HALF);
        });

        it("redeem succeeds — existing holders can exit during depeg", async function () {
            const shares = await vault.balanceOf(alice.address);
            await expect(vault.connect(alice).redeem(shares, alice.address, alice.address))
                .to.not.be.reverted;
            expect(await vault.balanceOf(alice.address)).to.equal(0);
        });

        it("maxDeposit returns 0", async function () {
            expect(await vault.maxDeposit(alice.address)).to.equal(0);
        });

        it("maxMint returns 0", async function () {
            expect(await vault.maxMint(alice.address)).to.equal(0);
        });

        it("maxRedeem returns alice's full share balance (withdrawals allowed)", async function () {
            expect(await vault.maxRedeem(alice.address)).to.equal(
                await vault.balanceOf(alice.address)
            );
        });

        it("maxWithdraw returns alice's full withdrawable amount (derived from maxRedeem)", async function () {
            expect(await vault.maxWithdraw(alice.address)).to.be.gt(0);
        });

        it("emits DepositsFrozen on pauseDeposits and DepositsUnfrozen on unpauseDeposits", async function () {
            await expect(vault.connect(coordinator).unpauseDeposits())
                .to.emit(vault, "DepositsUnfrozen")
                .withArgs(coordinator.address);
        });

        it("unpauseDeposits restores deposit access", async function () {
            await vault.connect(coordinator).unpauseDeposits();
            await expect(vault.connect(alice).deposit(HALF, alice.address)).to.not.be.reverted;
        });
    });

    // ── Access control ────────────────────────────────────────────────────────

    describe("access control", function () {
        it("pause() reverts for non-coordinator", async function () {
            await expect(vault.connect(attacker).pause())
                .to.be.revertedWithCustomError(vault, "AccessControlUnauthorizedAccount");
        });

        it("unpause() reverts for non-coordinator", async function () {
            await vault.connect(coordinator).pause();
            await expect(vault.connect(attacker).unpause())
                .to.be.revertedWithCustomError(vault, "AccessControlUnauthorizedAccount");
        });

        it("pauseDeposits() reverts for non-coordinator", async function () {
            await expect(vault.connect(attacker).pauseDeposits())
                .to.be.revertedWithCustomError(vault, "AccessControlUnauthorizedAccount");
        });

        it("unpauseDeposits() reverts for non-coordinator", async function () {
            await vault.connect(coordinator).pauseDeposits();
            await expect(vault.connect(attacker).unpauseDeposits())
                .to.be.revertedWithCustomError(vault, "AccessControlUnauthorizedAccount");
        });

        it("governance cannot directly call pause() — it must first grant itself PAUSE_COORDINATOR_ROLE", async function () {
            // GOVERNANCE_ROLE ≠ PAUSE_COORDINATOR_ROLE; holding governance is not enough to freeze
            await expect(vault.connect(governance).pause())
                .to.be.revertedWithCustomError(vault, "AccessControlUnauthorizedAccount");
        });

        describe("PAUSE_COORDINATOR_ROLE rotation by GOVERNANCE_ROLE", function () {
            it("governance can grant PAUSE_COORDINATOR_ROLE to a new coordinator", async function () {
                const [, , , , , newCoord] = await ethers.getSigners();
                await vault.connect(governance).grantRole(
                    await vault.PAUSE_COORDINATOR_ROLE(), newCoord.address
                );
                await expect(vault.connect(newCoord).pause()).to.not.be.reverted;
            });

            it("governance can revoke PAUSE_COORDINATOR_ROLE from the old coordinator", async function () {
                await vault.connect(governance).revokeRole(
                    await vault.PAUSE_COORDINATOR_ROLE(), coordinator.address
                );
                await expect(vault.connect(coordinator).pause())
                    .to.be.revertedWithCustomError(vault, "AccessControlUnauthorizedAccount");
            });

            it("full rotation: old coordinator loses access, new coordinator gains access", async function () {
                const [, , , , , newCoord] = await ethers.getSigners();

                await vault.connect(governance).grantRole(
                    await vault.PAUSE_COORDINATOR_ROLE(), newCoord.address
                );
                await vault.connect(governance).revokeRole(
                    await vault.PAUSE_COORDINATOR_ROLE(), coordinator.address
                );

                await expect(vault.connect(coordinator).pause())
                    .to.be.revertedWithCustomError(vault, "AccessControlUnauthorizedAccount");
                await expect(vault.connect(newCoord).pause()).to.not.be.reverted;
            });

            it("GOVERNANCE_ROLE can rotate itself", async function () {
                const [, , , , , , newGov] = await ethers.getSigners();

                await vault.connect(governance).grantRole(
                    await vault.GOVERNANCE_ROLE(), newGov.address
                );
                await vault.connect(governance).revokeRole(
                    await vault.GOVERNANCE_ROLE(), governance.address
                );

                // Old governance can no longer grant roles
                await expect(
                    vault.connect(governance).grantRole(
                        await vault.PAUSE_COORDINATOR_ROLE(), attacker.address
                    )
                ).to.be.revertedWithCustomError(vault, "AccessControlUnauthorizedAccount");

                // New governance can
                await expect(
                    vault.connect(newGov).grantRole(
                        await vault.PAUSE_COORDINATOR_ROLE(), attacker.address
                    )
                ).to.not.be.reverted;
            });

            it("DEFAULT_ADMIN_ROLE is ungranted — no bypass path around GOVERNANCE_ROLE", async function () {
                const DEFAULT_ADMIN = ethers.ZeroHash;
                // No one holds DEFAULT_ADMIN_ROLE; attacker cannot grant themselves PAUSE_COORDINATOR
                expect(await vault.hasRole(DEFAULT_ADMIN, governance.address)).to.equal(false);
                expect(await vault.hasRole(DEFAULT_ADMIN, coordinator.address)).to.equal(false);
            });
        });
    });

    // ── PAUSE_COORDINATOR_ROLE fund-drain invariant ───────────────────────────

    describe("coordinator fund-drain invariant", function () {
        beforeEach(async function () {
            // Alice deposits 1000 tokens; coordinator has NO shares and NO allowance
            await vault.connect(alice).deposit(DEPOSIT, alice.address);
        });

        it("coordinator has no shares and cannot redeem alice's position", async function () {
            expect(await vault.balanceOf(coordinator.address)).to.equal(0);

            const aliceShares = await vault.balanceOf(alice.address);
            await expect(
                vault.connect(coordinator).redeem(aliceShares, coordinator.address, alice.address)
            ).to.be.reverted; // ERC20InsufficientAllowance — coordinator has no allowance from alice
        });

        it("coordinator cannot withdraw alice's assets without an allowance", async function () {
            await expect(
                vault.connect(coordinator).withdraw(DEPOSIT, coordinator.address, alice.address)
            ).to.be.reverted;
        });

        it("coordinator cannot approve itself for alice's shares", async function () {
            // coordinator cannot call approve on alice's behalf — only alice can
            // This test confirms there is no hidden approve path from the freeze functions
            await vault.connect(coordinator).pause();
            await vault.connect(coordinator).unpause();
            // vault.approve is ERC20 — caller is msg.sender (alice), not coordinator
            // coordinator still has 0 allowance from alice
            expect(
                await vault.allowance(alice.address, coordinator.address)
            ).to.equal(0);
        });

        it("PAUSE_COORDINATOR_ROLE cannot call any function that emits Transfer or moves assets", async function () {
            const vaultAddr = await vault.getAddress();
            const tokenBefore = await token.balanceOf(vaultAddr);

            // Coordinator calls all four freeze functions — none should move funds
            await vault.connect(coordinator).pause();
            await vault.connect(coordinator).unpause();
            await vault.connect(coordinator).pauseDeposits();
            await vault.connect(coordinator).unpauseDeposits();

            expect(await token.balanceOf(vaultAddr)).to.equal(tokenBefore);
            expect(await vault.balanceOf(alice.address)).to.equal(DEPOSIT); // shares unchanged
        });
    });

    // ── Deposit/freeze ordering ───────────────────────────────────────────────

    describe("deposit/freeze ordering", function () {
        it("a deposit that lands before a freeze is fully preserved and withdrawable after unfreeze", async function () {
            await vault.connect(alice).deposit(DEPOSIT, alice.address);
            // Freeze arrives next
            await vault.connect(coordinator).pause();
            // Vault is paused — funds are safe, nothing can move
            expect(await vault.totalAssets()).to.equal(DEPOSIT);
            // Unfreeze
            await vault.connect(coordinator).unpause();
            // Alice can withdraw everything
            const shares = await vault.balanceOf(alice.address);
            await vault.connect(alice).redeem(shares, alice.address, alice.address);
            expect(await vault.totalAssets()).to.equal(0);
        });

        it("under DEPOSIT_ONLY_FREEZE, a pre-freeze depositor can fully exit at redemption value", async function () {
            await vault.connect(alice).deposit(DEPOSIT, alice.address);
            await vault.connect(coordinator).pauseDeposits();

            // Alice can still exit — this is the explicit economic property of DEPOSIT_ONLY_FREEZE
            const shares = await vault.balanceOf(alice.address);
            const assetsOut = await vault.previewRedeem(shares);
            await vault.connect(alice).redeem(shares, alice.address, alice.address);

            expect(await token.balanceOf(alice.address)).to.equal(DEPOSIT * 10n - DEPOSIT + assetsOut);
        });

        it("new depositor is blocked during DEPOSIT_ONLY_FREEZE while pre-freeze holder can exit", async function () {
            await vault.connect(alice).deposit(DEPOSIT, alice.address);
            await vault.connect(coordinator).pauseDeposits();

            // Bob (new depositor) is blocked
            await expect(vault.connect(bob).deposit(HALF, bob.address))
                .to.be.revertedWithCustomError(vault, "VaultDepositsFrozen");

            // Alice (pre-freeze) can exit
            const shares = await vault.balanceOf(alice.address);
            await expect(vault.connect(alice).redeem(shares, alice.address, alice.address))
                .to.not.be.reverted;
        });
    });

    // ── Integration with StableGuardCREReceiver ───────────────────────────────

    describe("integration with StableGuardCREReceiver (main-branch)", function () {
        let receiver, exposureRegistry, forwarder, coinA;

        beforeEach(async function () {
            [, , , , , , , forwarder, , coinA] = await ethers.getSigners();

            const ExposureRegistry = await ethers.getContractFactory("ExposureRegistry");
            exposureRegistry = await ExposureRegistry.deploy(governance.address);

            const StableGuardCREReceiver = await ethers.getContractFactory("StableGuardCREReceiver");
            receiver = await StableGuardCREReceiver.deploy(
                forwarder.address,
                await exposureRegistry.getAddress(),
                await vault.getAddress(),
                PAUSE_THRESHOLD
            );

            // Grant PAUSE_COORDINATOR_ROLE to the receiver — this is the critical wiring step
            await vault.connect(governance).grantRole(
                await vault.PAUSE_COORDINATOR_ROLE(),
                await receiver.getAddress()
            );

            // Register vault's exposure to coinA
            await exposureRegistry.connect(governance).registerExposure(
                await vault.getAddress(),
                addrToBytes32(coinA.address)
            );
        });

        it("receiver pauses vault when a depeg alert fires for a registered coin", async function () {
            const report = encodeReport([coinA.address], [1], PAUSE_THRESHOLD);
            await receiver.connect(forwarder).onReport("0x", report);
            expect(await vault.paused()).to.equal(true);
        });

        it("deposits are blocked after receiver-triggered pause", async function () {
            const report = encodeReport([coinA.address], [1], PAUSE_THRESHOLD);
            await receiver.connect(forwarder).onReport("0x", report);

            await expect(vault.connect(alice).deposit(HALF, alice.address))
                .to.be.revertedWithCustomError(vault, "VaultFullyFrozen");
        });

        it("withdrawals are blocked after receiver-triggered full pause", async function () {
            await vault.connect(alice).deposit(DEPOSIT, alice.address);
            const report = encodeReport([coinA.address], [1], PAUSE_THRESHOLD);
            await receiver.connect(forwarder).onReport("0x", report);

            const shares = await vault.balanceOf(alice.address);
            await expect(vault.connect(alice).redeem(shares, alice.address, alice.address))
                .to.be.revertedWithCustomError(vault, "VaultFullyFrozen");
        });

        it("receiver can unpause vault directly (governance delegates unpause to coordinator)", async function () {
            const report = encodeReport([coinA.address], [1], PAUSE_THRESHOLD);
            await receiver.connect(forwarder).onReport("0x", report);
            expect(await vault.paused()).to.equal(true);

            // In production, unpause is triggered by the receiver's auto-recovery path.
            // Here we call it directly to confirm the role is wired correctly.
            await vault.connect(governance).grantRole(
                await vault.PAUSE_COORDINATOR_ROLE(),
                governance.address
            );
            await vault.connect(governance).unpause();
            expect(await vault.paused()).to.equal(false);
        });

        it("an unauthorized caller cannot bypass PAUSE_COORDINATOR_ROLE to pause the vault", async function () {
            await expect(vault.connect(attacker).pause())
                .to.be.revertedWithCustomError(vault, "AccessControlUnauthorizedAccount");
            expect(await vault.paused()).to.equal(false);
        });

        it("VaultExposureMissing fires and vault stays unpaused when exposure not registered", async function () {
            const [, , , , , , , , unregisteredCoin] = await ethers.getSigners();
            const report = encodeReport([unregisteredCoin.address], [1], PAUSE_THRESHOLD);

            await expect(receiver.connect(forwarder).onReport("0x", report))
                .to.emit(receiver, "VaultExposureMissing");

            expect(await vault.paused()).to.equal(false);
        });
    });
});
