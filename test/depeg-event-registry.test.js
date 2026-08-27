"use strict";

const { ethers } = require("hardhat");
const { expect }  = require("chai");
const { time }    = require("@nomicfoundation/hardhat-network-helpers");
const { anyValue } = require("@nomicfoundation/hardhat-chai-matchers/withArgs");
// eslint-disable-next-line no-unused-vars

// ── Constants matching constructor args ────────────────────────────────────────

const WATCH_THRESHOLD    = 1;
const CONFIRMED_THRESHOLD = 2;
const STABILITY_WINDOW   = 3;        // consecutive stable reports for auto-recovery (illustrative)
const EVENT_TTL          = 86_400;   // 1 day
const PENDING_TTL        = 3_600;    // 1 hour
const RECOVERY_COOLDOWN  = 1_800;    // 30 min

// ── State enum mirrors Solidity ────────────────────────────────────────────────

const S = {
    WATCH: 0, CONFIRMED_DEPEG: 1,
    PROTECTION_PENDING: 2, PARTIALLY_PROTECTED: 3, PROTECTED: 4,
    RECOVERY_PENDING: 5, PARTIALLY_RECOVERED: 6,
    NORMAL: 7, EXPIRED: 8, FAILED: 9, SUPERSEDED: 10,
};

const DS = { PENDING: 0, COMPLETE: 1, SUPERSEDED: 2, FAILED: 3 };

// ── Helpers ────────────────────────────────────────────────────────────────────

function evidence(coin, score) {
    return ethers.keccak256(
        ethers.AbiCoder.defaultAbiCoder().encode(["address", "uint8"], [coin, score])
    );
}

function dest(chainSelector, vault) {
    return { chainSelector: BigInt(chainSelector), vault };
}

// ──────────────────────────────────────────────────────────────────────────────

describe("DepegEventRegistry", function () {
    let registry;
    let controller, other;
    let coinA, coinB;

    beforeEach(async function () {
        [controller, other, coinA, coinB] = await ethers.getSigners();

        const Factory = await ethers.getContractFactory("DepegEventRegistry");
        registry = await Factory.deploy(
            controller.address,
            WATCH_THRESHOLD,
            CONFIRMED_THRESHOLD,
            STABILITY_WINDOW,
            EVENT_TTL,
            PENDING_TTL,
            RECOVERY_COOLDOWN
        );
    });

    // ── Shared helpers that use the deployed registry ──────────────────────────

    async function report(coin, score) {
        return registry.connect(controller).processReport(
            coin, score, evidence(coin, score)
        );
    }

    async function activeId(coin) {
        return registry.getActiveEventId(coin);
    }

    async function stateOf(eventId) {
        return Number((await registry.getDepegEvent(eventId)).state);
    }

    async function destStateOf(eventId, idx) {
        const ev = await registry.getDepegEvent(eventId);
        return Number(ev.destinations[idx].state);
    }

    // Advance to CONFIRMED_DEPEG, returns eventId
    async function toConfirmed(coin) {
        await report(coin, CONFIRMED_THRESHOLD);
        return activeId(coin);
    }

    // Advance to PROTECTION_PENDING with `n` destinations, returns eventId
    async function toProtectionPending(coin, n = 2) {
        const id = await toConfirmed(coin);
        const dests = Array.from({ length: n }, (_, i) =>
            dest(i + 1, ethers.Wallet.createRandom().address)
        );
        await registry.connect(controller).initiateProtection(id, dests);
        return id;
    }

    // Advance to PROTECTED (all dests COMPLETE), returns eventId
    async function toProtected(coin, n = 2) {
        const id = await toProtectionPending(coin, n);
        for (let i = 0; i < n; i++) {
            await registry.connect(controller).destinationCallback(id, i, DS.COMPLETE);
        }
        return id;
    }

    // Advance to RECOVERY_PENDING with `n` destinations, returns eventId
    async function toRecoveryPending(coin, n = 2) {
        const id = await toProtected(coin, n);
        const dests = Array.from({ length: n }, (_, i) =>
            dest(i + 1, ethers.Wallet.createRandom().address)
        );
        await registry.connect(controller).initiateRecovery(id, dests);
        return id;
    }

    // ── G0: create ─────────────────────────────────────────────────────────────

    describe("G0 – event creation", function () {
        it("creates a WATCH event when score meets watchThreshold", async function () {
            await expect(report(coinA.address, WATCH_THRESHOLD))
                .to.emit(registry, "EventCreated")
                .withArgs(anyValue, coinA.address, WATCH_THRESHOLD);

            const id = await activeId(coinA.address);
            expect(id).to.not.equal(ethers.ZeroHash);
            expect(await stateOf(id)).to.equal(S.WATCH);
        });

        it("returns zero eventId and NORMAL when score is below watchThreshold with no active event", async function () {
            const [id, state] = await registry.connect(controller).processReport.staticCall(
                coinA.address, 0, evidence(coinA.address, 0)
            );
            expect(id).to.equal(ethers.ZeroHash);
            expect(Number(state)).to.equal(S.NORMAL);
        });

        it("assigns unique eventIds across coins", async function () {
            await report(coinA.address, WATCH_THRESHOLD);
            await report(coinB.address, WATCH_THRESHOLD);
            const idA = await activeId(coinA.address);
            const idB = await activeId(coinB.address);
            expect(idA).to.not.equal(idB);
        });
    });

    // ── rootIncidentId lineage ────────────────────────────────────────────────

    describe("rootIncidentId – incident lineage", function () {
        it("rootIncidentId equals eventId on a freshly created WATCH event", async function () {
            await report(coinA.address, WATCH_THRESHOLD);
            const id = await activeId(coinA.address);
            const ev = await registry.getDepegEvent(id);
            expect(ev.rootIncidentId).to.equal(id);
        });

        it("rootIncidentId is unchanged after an extension (EventExtended)", async function () {
            await report(coinA.address, WATCH_THRESHOLD);
            const id = await activeId(coinA.address);
            const evBefore = await registry.getDepegEvent(id);
            await report(coinA.address, WATCH_THRESHOLD);
            const evAfter = await registry.getDepegEvent(id);
            expect(evAfter.rootIncidentId).to.equal(evBefore.rootIncidentId);
        });

        it("rootIncidentId is unchanged through WATCH → CONFIRMED_DEPEG transition", async function () {
            await report(coinA.address, WATCH_THRESHOLD);
            const id = await activeId(coinA.address);
            const root = (await registry.getDepegEvent(id)).rootIncidentId;
            await report(coinA.address, CONFIRMED_THRESHOLD);
            expect((await registry.getDepegEvent(id)).rootIncidentId).to.equal(root);
        });

        it("rootIncidentId is unchanged through CONFIRMED_DEPEG → PROTECTION_PENDING → PROTECTED", async function () {
            await report(coinA.address, WATCH_THRESHOLD);
            const id = await activeId(coinA.address);
            const root = (await registry.getDepegEvent(id)).rootIncidentId;

            await report(coinA.address, CONFIRMED_THRESHOLD);
            const dests = [dest(1, ethers.Wallet.createRandom().address)];
            await registry.connect(controller).initiateProtection(id, dests);
            await registry.connect(controller).destinationCallback(id, 0, DS.COMPLETE);

            expect((await registry.getDepegEvent(id)).rootIncidentId).to.equal(root);
        });

        it("two distinct coins have independent rootIncidentIds", async function () {
            await report(coinA.address, WATCH_THRESHOLD);
            await report(coinB.address, WATCH_THRESHOLD);
            const idA = await activeId(coinA.address);
            const idB = await activeId(coinB.address);
            const evA = await registry.getDepegEvent(idA);
            const evB = await registry.getDepegEvent(idB);
            expect(evA.rootIncidentId).to.equal(idA);
            expect(evB.rootIncidentId).to.equal(idB);
            expect(evA.rootIncidentId).to.not.equal(evB.rootIncidentId);
        });

        it("a new event created after the prior terminates gets its own rootIncidentId", async function () {
            await report(coinA.address, WATCH_THRESHOLD);
            const firstId = await activeId(coinA.address);
            // terminate via score-based recovery
            await report(coinA.address, 0);
            expect(await activeId(coinA.address)).to.equal(ethers.ZeroHash);

            await report(coinA.address, WATCH_THRESHOLD);
            const secondId = await activeId(coinA.address);
            expect(secondId).to.not.equal(firstId);
            const evSecond = await registry.getDepegEvent(secondId);
            expect(evSecond.rootIncidentId).to.equal(secondId);
            expect(evSecond.rootIncidentId).to.not.equal(firstId);
        });

        it("resumeProtectionTracking produces an event with rootIncidentId == its own eventId (Step 1 behaviour)", async function () {
            const dests = [dest(1, ethers.Wallet.createRandom().address)];
            const tx = await registry.connect(controller).resumeProtectionTracking(
                coinA.address, evidence(coinA.address, 0), dests
            );
            const receipt = await tx.wait();
            const evt = receipt.logs
                .map(l => { try { return registry.interface.parseLog(l); } catch { return null; } })
                .find(e => e && e.name === "RecoveryTrackingResumed");
            const resumedId = evt.args.eventId;
            const ev = await registry.getDepegEvent(resumedId);
            expect(ev.rootIncidentId).to.equal(resumedId);
        });
    });

    // ── G1: extend ────────────────────────────────────────────────────────────

    describe("G1 – lookup-before-create (extend)", function () {
        it("extends an existing WATCH event instead of creating a new one", async function () {
            await report(coinA.address, WATCH_THRESHOLD);
            const firstId = await activeId(coinA.address);

            await expect(report(coinA.address, WATCH_THRESHOLD))
                .to.emit(registry, "EventExtended")
                .withArgs(firstId, coinA.address, WATCH_THRESHOLD)
                .and.not.to.emit(registry, "EventCreated");

            expect(await activeId(coinA.address)).to.equal(firstId);
        });

        it("extends an existing CONFIRMED_DEPEG event", async function () {
            const firstId = await toConfirmed(coinA.address);

            await expect(report(coinA.address, CONFIRMED_THRESHOLD))
                .to.emit(registry, "EventExtended")
                .and.not.to.emit(registry, "EventCreated");

            expect(await activeId(coinA.address)).to.equal(firstId);
        });

        it("creates a new event after prior event reaches NORMAL", async function () {
            await report(coinA.address, WATCH_THRESHOLD);
            const firstId = await activeId(coinA.address);

            await report(coinA.address, 0); // G3: WATCH → NORMAL
            expect(await stateOf(firstId)).to.equal(S.NORMAL);
            expect(await activeId(coinA.address)).to.equal(ethers.ZeroHash);

            await expect(report(coinA.address, WATCH_THRESHOLD))
                .to.emit(registry, "EventCreated");

            const secondId = await activeId(coinA.address);
            expect(secondId).to.not.equal(firstId);
        });

        it("creates a new event after prior event reaches EXPIRED", async function () {
            await report(coinA.address, WATCH_THRESHOLD);
            const firstId = await activeId(coinA.address);

            await time.increase(EVENT_TTL);
            await report(coinA.address, WATCH_THRESHOLD); // G13: triggers EXPIRED on existing

            expect(await stateOf(firstId)).to.equal(S.EXPIRED);
            expect(await activeId(coinA.address)).to.equal(ethers.ZeroHash);

            // Next report opens fresh event
            await expect(report(coinA.address, WATCH_THRESHOLD))
                .to.emit(registry, "EventCreated");
        });
    });

    // ── G2: WATCH → CONFIRMED_DEPEG ───────────────────────────────────────────

    describe("G2 – WATCH → CONFIRMED_DEPEG", function () {
        it("advances when score meets confirmedThreshold", async function () {
            await report(coinA.address, WATCH_THRESHOLD);
            const id = await activeId(coinA.address);

            await expect(report(coinA.address, CONFIRMED_THRESHOLD))
                .to.emit(registry, "EventAdvanced")
                .withArgs(id, coinA.address, S.WATCH, S.CONFIRMED_DEPEG);

            expect(await stateOf(id)).to.equal(S.CONFIRMED_DEPEG);
        });

        it("stays WATCH below confirmedThreshold", async function () {
            await report(coinA.address, WATCH_THRESHOLD);
            const id = await activeId(coinA.address);
            await report(coinA.address, WATCH_THRESHOLD);
            expect(await stateOf(id)).to.equal(S.WATCH);
        });
    });

    // ── G3/G4: recovery from WATCH / CONFIRMED_DEPEG ─────────────────────────

    describe("G3/G4 – score-based recovery", function () {
        it("G3: WATCH → NORMAL when score drops below watchThreshold", async function () {
            await report(coinA.address, WATCH_THRESHOLD);
            const id = await activeId(coinA.address);
            await expect(report(coinA.address, 0))
                .to.emit(registry, "EventTerminated")
                .withArgs(id, coinA.address, S.NORMAL);
            expect(await activeId(coinA.address)).to.equal(ethers.ZeroHash);
        });

        it("G4: CONFIRMED_DEPEG → NORMAL when score drops below watchThreshold", async function () {
            const id = await toConfirmed(coinA.address);
            await expect(report(coinA.address, 0))
                .to.emit(registry, "EventTerminated")
                .withArgs(id, coinA.address, S.NORMAL);
            expect(await activeId(coinA.address)).to.equal(ethers.ZeroHash);
        });
    });

    // ── G5: initiateProtection ────────────────────────────────────────────────

    describe("G5 – initiateProtection", function () {
        it("advances CONFIRMED_DEPEG → PROTECTION_PENDING", async function () {
            const id = await toConfirmed(coinA.address);
            const dests = [dest(1, ethers.Wallet.createRandom().address)];

            await expect(registry.connect(controller).initiateProtection(id, dests))
                .to.emit(registry, "EventAdvanced")
                .withArgs(id, coinA.address, S.CONFIRMED_DEPEG, S.PROTECTION_PENDING)
                .and.to.emit(registry, "ProtectionInitiated")
                .withArgs(id, coinA.address, 1);

            expect(await stateOf(id)).to.equal(S.PROTECTION_PENDING);
        });

        it("reverts from non-controller", async function () {
            const id = await toConfirmed(coinA.address);
            await expect(
                registry.connect(other).initiateProtection(id, [dest(1, other.address)])
            ).to.be.revertedWithCustomError(registry, "Unauthorized");
        });

        it("reverts when not in CONFIRMED_DEPEG", async function () {
            await report(coinA.address, WATCH_THRESHOLD);
            const id = await activeId(coinA.address);
            await expect(
                registry.connect(controller).initiateProtection(id, [dest(1, other.address)])
            ).to.be.revertedWithCustomError(registry, "InvalidTransition");
        });

        it("reverts with empty destinations", async function () {
            const id = await toConfirmed(coinA.address);
            await expect(
                registry.connect(controller).initiateProtection(id, [])
            ).to.be.revertedWithCustomError(registry, "NoDestinations");
        });

        it("terminates as EXPIRED when event TTL already elapsed", async function () {
            const id = await toConfirmed(coinA.address);
            await time.increase(EVENT_TTL);
            await registry.connect(controller).initiateProtection(id, [dest(1, other.address)]);
            expect(await stateOf(id)).to.equal(S.EXPIRED);
        });
    });

    // ── G6: PROTECTION_PENDING → PROTECTED ───────────────────────────────────

    describe("G6 – PROTECTION_PENDING → PROTECTED (all destinations)", function () {
        it("advances to PROTECTED once all destinations report COMPLETE", async function () {
            const id = await toProtectionPending(coinA.address, 3);

            await registry.connect(controller).destinationCallback(id, 0, DS.COMPLETE);
            await registry.connect(controller).destinationCallback(id, 1, DS.COMPLETE);
            expect(await stateOf(id)).to.equal(S.PROTECTION_PENDING); // not yet

            await expect(registry.connect(controller).destinationCallback(id, 2, DS.COMPLETE))
                .to.emit(registry, "EventAdvanced")
                .withArgs(id, coinA.address, S.PROTECTION_PENDING, S.PROTECTED);

            expect(await stateOf(id)).to.equal(S.PROTECTED);
        });

        it("counts SUPERSEDED as settled-but-not-complete; advances to PROTECTED on all-effective-complete", async function () {
            const id = await toProtectionPending(coinA.address, 3);
            await registry.connect(controller).destinationCallback(id, 0, DS.SUPERSEDED);
            await registry.connect(controller).destinationCallback(id, 1, DS.COMPLETE);
            await expect(registry.connect(controller).destinationCallback(id, 2, DS.COMPLETE))
                .to.emit(registry, "EventAdvanced")
                .withArgs(id, coinA.address, S.PROTECTION_PENDING, S.PROTECTED);
        });
    });

    // ── G6b: PROTECTION_PENDING → PARTIALLY_PROTECTED ────────────────────────

    describe("G6b – partial protection", function () {
        it("advances to PARTIALLY_PROTECTED when some (not all) destinations complete", async function () {
            const id = await toProtectionPending(coinA.address, 3);
            await registry.connect(controller).destinationCallback(id, 0, DS.COMPLETE);
            await registry.connect(controller).destinationCallback(id, 1, DS.COMPLETE);
            await expect(registry.connect(controller).destinationCallback(id, 2, DS.FAILED))
                .to.emit(registry, "EventAdvanced")
                .withArgs(id, coinA.address, S.PROTECTION_PENDING, S.PARTIALLY_PROTECTED);

            expect(await stateOf(id)).to.equal(S.PARTIALLY_PROTECTED);
            expect(await activeId(coinA.address)).to.equal(id); // still active
        });

        it("advances PARTIALLY_PROTECTED → PROTECTED after retry of failed destination", async function () {
            const id = await toProtectionPending(coinA.address, 2);
            await registry.connect(controller).destinationCallback(id, 0, DS.COMPLETE);
            await registry.connect(controller).destinationCallback(id, 1, DS.FAILED);
            expect(await stateOf(id)).to.equal(S.PARTIALLY_PROTECTED);

            // retry dest[1]
            await registry.connect(controller).retryFailedDestinations(id, [1]);
            await expect(registry.connect(controller).destinationCallback(id, 1, DS.COMPLETE))
                .to.emit(registry, "EventAdvanced")
                .withArgs(id, coinA.address, S.PARTIALLY_PROTECTED, S.PROTECTED);
        });

        it("stays PARTIALLY_PROTECTED when retry also fails", async function () {
            const id = await toProtectionPending(coinA.address, 2);
            await registry.connect(controller).destinationCallback(id, 0, DS.COMPLETE);
            await registry.connect(controller).destinationCallback(id, 1, DS.FAILED);

            await registry.connect(controller).retryFailedDestinations(id, [1]);
            await registry.connect(controller).destinationCallback(id, 1, DS.FAILED);

            expect(await stateOf(id)).to.equal(S.PARTIALLY_PROTECTED);
        });
    });

    // ── G7: PROTECTION_PENDING → FAILED ──────────────────────────────────────

    describe("G7 – all destinations failed", function () {
        it("terminates as FAILED when all destinations report FAILED", async function () {
            const id = await toProtectionPending(coinA.address, 2);
            await registry.connect(controller).destinationCallback(id, 0, DS.FAILED);
            await expect(registry.connect(controller).destinationCallback(id, 1, DS.FAILED))
                .to.emit(registry, "EventTerminated")
                .withArgs(id, coinA.address, S.FAILED);

            expect(await stateOf(id)).to.equal(S.FAILED);
            expect(await activeId(coinA.address)).to.equal(ethers.ZeroHash);
        });
    });

    // ── G8: PROTECTION_PENDING pendingTTL ─────────────────────────────────────

    describe("G8 – PROTECTION_PENDING pendingTTL", function () {
        it("terminates as FAILED via destinationCallback after pendingTTL", async function () {
            const id = await toProtectionPending(coinA.address, 2);
            await time.increase(PENDING_TTL);

            await expect(registry.connect(controller).destinationCallback(id, 0, DS.COMPLETE))
                .to.emit(registry, "EventTerminated")
                .withArgs(id, coinA.address, S.FAILED);
        });

        it("terminates as FAILED via settlePending after pendingTTL", async function () {
            const id = await toProtectionPending(coinA.address, 2);
            await time.increase(PENDING_TTL);

            await expect(registry.settlePending(id))
                .to.emit(registry, "EventTerminated")
                .withArgs(id, coinA.address, S.FAILED);
        });

        it("settlePending reverts if pendingTTL not yet elapsed", async function () {
            const id = await toProtectionPending(coinA.address, 2);
            await expect(registry.settlePending(id))
                .to.be.revertedWithCustomError(registry, "PendingNotTimedOut");
        });

        it("PARTIALLY_PROTECTED is NOT subject to settlePending", async function () {
            const id = await toProtectionPending(coinA.address, 2);
            await registry.connect(controller).destinationCallback(id, 0, DS.COMPLETE);
            await registry.connect(controller).destinationCallback(id, 1, DS.FAILED);
            expect(await stateOf(id)).to.equal(S.PARTIALLY_PROTECTED);

            await time.increase(PENDING_TTL);
            await expect(registry.settlePending(id))
                .to.be.revertedWithCustomError(registry, "InvalidTransition");
        });
    });

    // ── DG1–DG3: per-destination write guard ──────────────────────────────────

    describe("DG1–DG3 – destination slot guard (COMPLETE is sticky)", function () {
        it("DG3: reverts when DC called on a COMPLETE destination (duplicate callback)", async function () {
            const id = await toProtectionPending(coinA.address, 2);
            await registry.connect(controller).destinationCallback(id, 0, DS.COMPLETE);
            // Still pending on dest 1 so state is PROTECTION_PENDING
            await expect(
                registry.connect(controller).destinationCallback(id, 0, DS.FAILED)
            ).to.be.revertedWithCustomError(registry, "DestinationNotPending")
             .withArgs(0, DS.COMPLETE);
        });

        it("DG3: stale FAILED cannot overwrite COMPLETE after retry succeeded", async function () {
            const id = await toProtectionPending(coinA.address, 2);
            await registry.connect(controller).destinationCallback(id, 0, DS.COMPLETE);
            await registry.connect(controller).destinationCallback(id, 1, DS.FAILED);
            // retry dest[1]
            await registry.connect(controller).retryFailedDestinations(id, [1]);
            // Retry succeeds — both complete → PROTECTED
            await registry.connect(controller).destinationCallback(id, 1, DS.COMPLETE);
            expect(await stateOf(id)).to.equal(S.PROTECTED);

            // Stale FAILED arrives: event is now PROTECTED, which is not a DC-accepting state
            await expect(
                registry.connect(controller).destinationCallback(id, 1, DS.FAILED)
            ).to.be.revertedWithCustomError(registry, "InvalidTransition");
        });

        it("DG3: duplicate COMPLETE on same slot reverts DestinationNotPending", async function () {
            const id = await toProtectionPending(coinA.address, 2);
            await registry.connect(controller).destinationCallback(id, 0, DS.COMPLETE);
            // Dest 1 still pending, so event is still PROTECTION_PENDING
            await expect(
                registry.connect(controller).destinationCallback(id, 0, DS.COMPLETE)
            ).to.be.revertedWithCustomError(registry, "DestinationNotPending")
             .withArgs(0, DS.COMPLETE);
        });

        it("DG3: reverts when DC called on a FAILED destination", async function () {
            const id = await toProtectionPending(coinA.address, 2);
            await registry.connect(controller).destinationCallback(id, 0, DS.FAILED);
            // dest[1] still pending, so state is PROTECTION_PENDING
            await expect(
                registry.connect(controller).destinationCallback(id, 0, DS.COMPLETE)
            ).to.be.revertedWithCustomError(registry, "DestinationNotPending")
             .withArgs(0, DS.FAILED);
        });
    });

    // ── DG4–DG5: retryFailedDestinations guard ────────────────────────────────

    describe("DG4–DG5 – retryFailedDestinations guard", function () {
        it("DG5: reverts when retrying a COMPLETE destination", async function () {
            const id = await toProtectionPending(coinA.address, 2);
            await registry.connect(controller).destinationCallback(id, 0, DS.COMPLETE);
            await registry.connect(controller).destinationCallback(id, 1, DS.FAILED);

            await expect(
                registry.connect(controller).retryFailedDestinations(id, [0])
            ).to.be.revertedWithCustomError(registry, "DestinationNotFailed")
             .withArgs(0, DS.COMPLETE);
        });

        it("DG5: reverts when retrying a PENDING destination (slot already re-queued)", async function () {
            // Need PARTIALLY_PROTECTED so retryFailedDestinations state-check passes.
            // 3 dests: 0→COMPLETE, 1→COMPLETE, 2→FAILED → PARTIALLY_PROTECTED
            const id = await toProtectionPending(coinA.address, 3);
            await registry.connect(controller).destinationCallback(id, 0, DS.COMPLETE);
            await registry.connect(controller).destinationCallback(id, 1, DS.COMPLETE);
            await registry.connect(controller).destinationCallback(id, 2, DS.FAILED);
            expect(await stateOf(id)).to.equal(S.PARTIALLY_PROTECTED);

            // First retry: FAILED → PENDING
            await registry.connect(controller).retryFailedDestinations(id, [2]);
            expect(await destStateOf(id, 2)).to.equal(DS.PENDING);

            // Second retry while still PENDING → DestinationNotFailed
            await expect(
                registry.connect(controller).retryFailedDestinations(id, [2])
            ).to.be.revertedWithCustomError(registry, "DestinationNotFailed")
             .withArgs(2, DS.PENDING);
        });

        it("reverts from wrong state (PROTECTION_PENDING, not PARTIALLY_PROTECTED)", async function () {
            const id = await toProtectionPending(coinA.address, 2);
            await expect(
                registry.connect(controller).retryFailedDestinations(id, [0])
            ).to.be.revertedWithCustomError(registry, "InvalidTransition");
        });
    });

    // ── G9: PROTECTED → RECOVERY_PENDING ─────────────────────────────────────

    describe("G9 – initiateRecovery", function () {
        it("advances PROTECTED → RECOVERY_PENDING", async function () {
            const id = await toProtected(coinA.address, 2);
            const dests = [dest(1, ethers.Wallet.createRandom().address)];
            await expect(registry.connect(controller).initiateRecovery(id, dests))
                .to.emit(registry, "EventAdvanced")
                .withArgs(id, coinA.address, S.PROTECTED, S.RECOVERY_PENDING)
                .and.to.emit(registry, "RecoveryInitiated")
                .withArgs(id, coinA.address, 1);

            expect(await stateOf(id)).to.equal(S.RECOVERY_PENDING);
        });

        it("reverts from non-PROTECTED state", async function () {
            const id = await toProtectionPending(coinA.address, 2);
            await expect(
                registry.connect(controller).initiateRecovery(id, [dest(1, other.address)])
            ).to.be.revertedWithCustomError(registry, "InvalidTransition");
        });
    });

    // ── G10: RECOVERY_PENDING → NORMAL ───────────────────────────────────────

    describe("G10 – RECOVERY_PENDING → NORMAL (all complete + cooldown)", function () {
        it("advances to NORMAL at DC time when all complete and cooldown already elapsed", async function () {
            const id = await toRecoveryPending(coinA.address, 2);
            await time.increase(RECOVERY_COOLDOWN);

            await registry.connect(controller).destinationCallback(id, 0, DS.COMPLETE);
            await expect(registry.connect(controller).destinationCallback(id, 1, DS.COMPLETE))
                .to.emit(registry, "EventTerminated")
                .withArgs(id, coinA.address, S.NORMAL);

            expect(await activeId(coinA.address)).to.equal(ethers.ZeroHash);
        });

        it("stays in RECOVERY_PENDING when all complete but cooldown not yet elapsed", async function () {
            const id = await toRecoveryPending(coinA.address, 2);

            await registry.connect(controller).destinationCallback(id, 0, DS.COMPLETE);
            await registry.connect(controller).destinationCallback(id, 1, DS.COMPLETE);

            // cooldown not elapsed — should NOT be NORMAL yet
            expect(await stateOf(id)).to.equal(S.RECOVERY_PENDING);
        });

        it("finalizeRecovery advances to NORMAL after cooldown elapses", async function () {
            const id = await toRecoveryPending(coinA.address, 2);

            await registry.connect(controller).destinationCallback(id, 0, DS.COMPLETE);
            await registry.connect(controller).destinationCallback(id, 1, DS.COMPLETE);
            expect(await stateOf(id)).to.equal(S.RECOVERY_PENDING);

            await time.increase(RECOVERY_COOLDOWN);

            await expect(registry.finalizeRecovery(id))
                .to.emit(registry, "EventTerminated")
                .withArgs(id, coinA.address, S.NORMAL);
        });

        it("finalizeRecovery reverts if cooldown not yet elapsed", async function () {
            const id = await toRecoveryPending(coinA.address, 2);
            await registry.connect(controller).destinationCallback(id, 0, DS.COMPLETE);
            await registry.connect(controller).destinationCallback(id, 1, DS.COMPLETE);
            await expect(registry.finalizeRecovery(id))
                .to.be.revertedWithCustomError(registry, "RecoveryConditionsNotMet");
        });

        it("finalizeRecovery reverts if not all destinations complete", async function () {
            const id = await toRecoveryPending(coinA.address, 2);
            await registry.connect(controller).destinationCallback(id, 0, DS.COMPLETE);
            // dest[1] still PENDING
            await time.increase(RECOVERY_COOLDOWN);
            await expect(registry.finalizeRecovery(id))
                .to.be.revertedWithCustomError(registry, "RecoveryConditionsNotMet");
        });
    });

    // ── G10b: RECOVERY_PENDING → PARTIALLY_RECOVERED ─────────────────────────

    describe("G10b – partial recovery", function () {
        it("advances to PARTIALLY_RECOVERED on partial completion", async function () {
            const id = await toRecoveryPending(coinA.address, 2);
            await registry.connect(controller).destinationCallback(id, 0, DS.COMPLETE);
            await expect(registry.connect(controller).destinationCallback(id, 1, DS.FAILED))
                .to.emit(registry, "EventAdvanced")
                .withArgs(id, coinA.address, S.RECOVERY_PENDING, S.PARTIALLY_RECOVERED);

            expect(await stateOf(id)).to.equal(S.PARTIALLY_RECOVERED);
            expect(await activeId(coinA.address)).to.equal(id);
        });

        it("PARTIALLY_RECOVERED → NORMAL via retry + finalizeRecovery", async function () {
            const id = await toRecoveryPending(coinA.address, 2);
            await registry.connect(controller).destinationCallback(id, 0, DS.COMPLETE);
            await registry.connect(controller).destinationCallback(id, 1, DS.FAILED);

            await registry.connect(controller).retryFailedDestinations(id, [1]);
            await time.increase(RECOVERY_COOLDOWN);
            await registry.connect(controller).destinationCallback(id, 1, DS.COMPLETE);

            expect(await stateOf(id)).to.equal(S.NORMAL);
        });
    });

    // ── G11: RECOVERY_PENDING → FAILED ───────────────────────────────────────

    describe("G11 – all recovery destinations failed", function () {
        it("terminates as FAILED", async function () {
            const id = await toRecoveryPending(coinA.address, 2);
            await registry.connect(controller).destinationCallback(id, 0, DS.FAILED);
            await expect(registry.connect(controller).destinationCallback(id, 1, DS.FAILED))
                .to.emit(registry, "EventTerminated")
                .withArgs(id, coinA.address, S.FAILED);
        });
    });

    // ── G12: RECOVERY_PENDING pendingTTL ─────────────────────────────────────

    describe("G12 – RECOVERY_PENDING pendingTTL", function () {
        it("terminates as FAILED via destinationCallback after pendingTTL", async function () {
            const id = await toRecoveryPending(coinA.address, 2);
            await time.increase(PENDING_TTL);
            await expect(registry.connect(controller).destinationCallback(id, 0, DS.COMPLETE))
                .to.emit(registry, "EventTerminated")
                .withArgs(id, coinA.address, S.FAILED);
        });

        it("terminates as FAILED via settlePending after pendingTTL", async function () {
            const id = await toRecoveryPending(coinA.address, 2);
            await time.increase(PENDING_TTL);
            await expect(registry.settlePending(id))
                .to.emit(registry, "EventTerminated")
                .withArgs(id, coinA.address, S.FAILED);
        });

        it("PARTIALLY_RECOVERED is NOT subject to settlePending", async function () {
            const id = await toRecoveryPending(coinA.address, 2);
            await registry.connect(controller).destinationCallback(id, 0, DS.COMPLETE);
            await registry.connect(controller).destinationCallback(id, 1, DS.FAILED);
            expect(await stateOf(id)).to.equal(S.PARTIALLY_RECOVERED);

            await time.increase(PENDING_TTL);
            await expect(registry.settlePending(id))
                .to.be.revertedWithCustomError(registry, "InvalidTransition");
        });
    });

    // ── G13: event TTL ────────────────────────────────────────────────────────

    describe("G13 – event TTL (EXPIRED, wins over score)", function () {
        it("terminates as EXPIRED via processReport after TTL", async function () {
            await report(coinA.address, WATCH_THRESHOLD);
            const id = await activeId(coinA.address);
            await time.increase(EVENT_TTL);

            await expect(report(coinA.address, WATCH_THRESHOLD))
                .to.emit(registry, "EventTerminated")
                .withArgs(id, coinA.address, S.EXPIRED);
        });

        it("EXPIRED wins over score-recovery: below-threshold score + TTL → EXPIRED not NORMAL", async function () {
            await report(coinA.address, WATCH_THRESHOLD);
            const id = await activeId(coinA.address);
            await time.increase(EVENT_TTL);
            await report(coinA.address, 0); // score says recover but TTL wins
            expect(await stateOf(id)).to.equal(S.EXPIRED);
        });

        it("settleExpired terminates WATCH event after TTL", async function () {
            await report(coinA.address, WATCH_THRESHOLD);
            const id = await activeId(coinA.address);
            await time.increase(EVENT_TTL);
            await expect(registry.settleExpired(id))
                .to.emit(registry, "EventTerminated")
                .withArgs(id, coinA.address, S.EXPIRED);
        });

        it("settleExpired reverts before TTL", async function () {
            await report(coinA.address, WATCH_THRESHOLD);
            const id = await activeId(coinA.address);
            await expect(registry.settleExpired(id))
                .to.be.revertedWithCustomError(registry, "NotYetExpired");
        });

        it("G13 terminates even when in PROTECTION_PENDING", async function () {
            const id = await toProtectionPending(coinA.address, 2);
            await time.increase(EVENT_TTL);
            await expect(registry.connect(controller).destinationCallback(id, 0, DS.COMPLETE))
                .to.emit(registry, "EventTerminated")
                .withArgs(id, coinA.address, S.EXPIRED);
        });
    });

    // ── G14/G15: supersede ────────────────────────────────────────────────────

    describe("G14/G15 – supersede", function () {
        it("G14: supersedes a WATCH event", async function () {
            await report(coinA.address, WATCH_THRESHOLD);
            const id = await activeId(coinA.address);
            await expect(registry.connect(controller).supersede(id))
                .to.emit(registry, "EventTerminated")
                .withArgs(id, coinA.address, S.SUPERSEDED);
            expect(await activeId(coinA.address)).to.equal(ethers.ZeroHash);
        });

        it("G14: supersedes a CONFIRMED_DEPEG event", async function () {
            const id = await toConfirmed(coinA.address);
            await expect(registry.connect(controller).supersede(id))
                .to.emit(registry, "EventTerminated")
                .withArgs(id, coinA.address, S.SUPERSEDED);
        });

        it("G15: reverts when superseding PROTECTION_PENDING", async function () {
            const id = await toProtectionPending(coinA.address, 2);
            await expect(registry.connect(controller).supersede(id))
                .to.be.revertedWithCustomError(registry, "CannotSupersede");
        });

        it("G15: reverts when superseding PARTIALLY_PROTECTED", async function () {
            const id = await toProtectionPending(coinA.address, 2);
            await registry.connect(controller).destinationCallback(id, 0, DS.COMPLETE);
            await registry.connect(controller).destinationCallback(id, 1, DS.FAILED);
            await expect(registry.connect(controller).supersede(id))
                .to.be.revertedWithCustomError(registry, "CannotSupersede");
        });

        it("G15: reverts when superseding PROTECTED", async function () {
            const id = await toProtected(coinA.address, 2);
            await expect(registry.connect(controller).supersede(id))
                .to.be.revertedWithCustomError(registry, "CannotSupersede");
        });

        it("G15: reverts when superseding RECOVERY_PENDING", async function () {
            const id = await toRecoveryPending(coinA.address, 2);
            await expect(registry.connect(controller).supersede(id))
                .to.be.revertedWithCustomError(registry, "CannotSupersede");
        });

        it("G15: reverts when superseding PARTIALLY_RECOVERED", async function () {
            const id = await toRecoveryPending(coinA.address, 2);
            await registry.connect(controller).destinationCallback(id, 0, DS.COMPLETE);
            await registry.connect(controller).destinationCallback(id, 1, DS.FAILED);
            await expect(registry.connect(controller).supersede(id))
                .to.be.revertedWithCustomError(registry, "CannotSupersede");
        });

        it("allows new event after supersession", async function () {
            const id = await toConfirmed(coinA.address);
            await registry.connect(controller).supersede(id);
            await expect(report(coinA.address, WATCH_THRESHOLD))
                .to.emit(registry, "EventCreated");
            expect(await activeId(coinA.address)).to.not.equal(id);
        });

        it("reverts from non-controller", async function () {
            await report(coinA.address, WATCH_THRESHOLD);
            const id = await activeId(coinA.address);
            await expect(registry.connect(other).supersede(id))
                .to.be.revertedWithCustomError(registry, "Unauthorized");
        });
    });

    // ── G16: terminal state blocks all writes ─────────────────────────────────

    describe("G16 – terminal state blocks writes", function () {
        async function makeNormal() {
            await report(coinA.address, WATCH_THRESHOLD);
            const id = await activeId(coinA.address);
            await report(coinA.address, 0);
            return id;
        }

        it("processReport on same coin creates new event (lookup-before-create)", async function () {
            const id = await makeNormal();
            expect(await stateOf(id)).to.equal(S.NORMAL);
            // next processReport with score finds no active → creates new
            await expect(report(coinA.address, WATCH_THRESHOLD))
                .to.emit(registry, "EventCreated");
        });

        it("settleExpired reverts on terminal event", async function () {
            const id = await makeNormal();
            await expect(registry.settleExpired(id))
                .to.be.revertedWithCustomError(registry, "AlreadyTerminal");
        });

        it("supersede reverts on terminal event", async function () {
            const id = await makeNormal();
            await expect(registry.connect(controller).supersede(id))
                .to.be.revertedWithCustomError(registry, "AlreadyTerminal");
        });

        it("initiateProtection reverts on terminal event", async function () {
            const id = await makeNormal();
            await expect(
                registry.connect(controller).initiateProtection(id, [dest(1, other.address)])
            ).to.be.revertedWithCustomError(registry, "AlreadyTerminal");
        });

        it("destinationCallback reverts on terminal event", async function () {
            const id = await makeNormal();
            await expect(
                registry.connect(controller).destinationCallback(id, 0, DS.COMPLETE)
            ).to.be.revertedWithCustomError(registry, "AlreadyTerminal");
        });
    });

    // ── resumeProtectionTracking ──────────────────────────────────────────────

    describe("resumeProtectionTracking", function () {
        it("creates a PROTECTED event with COMPLETE destinations when no active event", async function () {
            await registry.connect(controller).resumeProtectionTracking(
                coinA.address,
                evidence(coinA.address, 0),
                [dest(1, other.address)]
            );
            const id = await activeId(coinA.address);
            expect(id).to.not.equal(ethers.ZeroHash);
            expect(await stateOf(id)).to.equal(S.PROTECTED);
            expect(await destStateOf(id, 0)).to.equal(DS.COMPLETE);
        });

        it("emits RecoveryTrackingResumed", async function () {
            await expect(
                registry.connect(controller).resumeProtectionTracking(
                    coinA.address,
                    evidence(coinA.address, 0),
                    [dest(1, other.address)]
                )
            ).to.emit(registry, "RecoveryTrackingResumed")
             .withArgs(anyValue, coinA.address, 1n);
        });

        it("reverts from non-controller", async function () {
            await expect(
                registry.connect(other).resumeProtectionTracking(
                    coinA.address,
                    evidence(coinA.address, 0),
                    [dest(1, other.address)]
                )
            ).to.be.revertedWithCustomError(registry, "Unauthorized");
        });

        it("reverts with empty destinations", async function () {
            await expect(
                registry.connect(controller).resumeProtectionTracking(
                    coinA.address,
                    evidence(coinA.address, 0),
                    []
                )
            ).to.be.revertedWithCustomError(registry, "NoDestinations");
        });

        it("reverts when active non-terminal event exists", async function () {
            await report(coinA.address, WATCH_THRESHOLD);
            await expect(
                registry.connect(controller).resumeProtectionTracking(
                    coinA.address,
                    evidence(coinA.address, 0),
                    [dest(1, other.address)]
                )
            ).to.be.revertedWithCustomError(registry, "InvalidTransition");
        });

        it("succeeds after prior event reaches NORMAL (terminal)", async function () {
            await report(coinA.address, WATCH_THRESHOLD);
            const firstId = await activeId(coinA.address);
            await report(coinA.address, 0); // G3: WATCH → NORMAL
            expect(await stateOf(firstId)).to.equal(S.NORMAL);

            await expect(
                registry.connect(controller).resumeProtectionTracking(
                    coinA.address,
                    evidence(coinA.address, 0),
                    [dest(1, other.address)]
                )
            ).to.emit(registry, "RecoveryTrackingResumed");
        });

        it("auto-recovery fires from resumed event after stabilityWindow stable reports", async function () {
            await registry.connect(controller).resumeProtectionTracking(
                coinA.address,
                evidence(coinA.address, 0),
                [dest(1, other.address), dest(2, other.address)]
            );
            const id = await activeId(coinA.address);
            expect(await stateOf(id)).to.equal(S.PROTECTED);

            for (let i = 0; i < STABILITY_WINDOW - 1; i++) {
                await report(coinA.address, 0);
                expect(await stateOf(id)).to.equal(S.PROTECTED);
            }

            await expect(report(coinA.address, 0))
                .to.emit(registry, "EventAdvanced")
                .withArgs(id, coinA.address, S.PROTECTED, S.RECOVERY_PENDING)
                .and.to.emit(registry, "RecoveryInitiated")
                .withArgs(id, coinA.address, 2n);

            expect(await stateOf(id)).to.equal(S.RECOVERY_PENDING);
            expect(await destStateOf(id, 0)).to.equal(DS.PENDING);
            expect(await destStateOf(id, 1)).to.equal(DS.PENDING);
        });
    });

    // ── GA: auto-recovery ─────────────────────────────────────────────────────

    describe("GA – auto-recovery (stabilityWindow consecutive stable reports)", function () {
        it("fires RECOVERY_PENDING after stabilityWindow stable reports while PROTECTED", async function () {
            const id = await toProtected(coinA.address, 2);
            expect(await stateOf(id)).to.equal(S.PROTECTED);

            // stabilityWindow - 1 stable reports: not yet
            for (let i = 0; i < STABILITY_WINDOW - 1; i++) {
                await report(coinA.address, 0);
                expect(await stateOf(id)).to.equal(S.PROTECTED);
            }

            // Nth stable report: triggers auto-recovery
            await expect(report(coinA.address, 0))
                .to.emit(registry, "EventAdvanced")
                .withArgs(id, coinA.address, S.PROTECTED, S.RECOVERY_PENDING)
                .and.to.emit(registry, "RecoveryInitiated")
                .withArgs(id, coinA.address, 2n);

            expect(await stateOf(id)).to.equal(S.RECOVERY_PENDING);

            // All destination slots reset to PENDING for recovery delivery
            expect(await destStateOf(id, 0)).to.equal(DS.PENDING);
            expect(await destStateOf(id, 1)).to.equal(DS.PENDING);
        });

        it("non-stable report hard-resets stableCount — recovery does not fire prematurely", async function () {
            const id = await toProtected(coinA.address, 2);

            // stabilityWindow - 1 stable reports
            for (let i = 0; i < STABILITY_WINDOW - 1; i++) {
                await report(coinA.address, 0);
            }
            expect(await stateOf(id)).to.equal(S.PROTECTED);

            // Non-stable: hard reset
            await report(coinA.address, WATCH_THRESHOLD);
            expect(await stateOf(id)).to.equal(S.PROTECTED);

            // stabilityWindow - 1 stable reports again — still not enough
            for (let i = 0; i < STABILITY_WINDOW - 1; i++) {
                await report(coinA.address, 0);
                expect(await stateOf(id)).to.equal(S.PROTECTED);
            }

            // Now the Nth stable since reset fires
            await report(coinA.address, 0);
            expect(await stateOf(id)).to.equal(S.RECOVERY_PENDING);
        });

        it("event TTL in processReport takes priority over auto-recovery", async function () {
            const id = await toProtected(coinA.address, 2);

            // One stable report (stableCount = 1)
            await report(coinA.address, 0);

            // Advance past TTL
            await time.increase(EVENT_TTL + 1);

            // Next processReport: TTL check fires first, terminates as EXPIRED
            await expect(report(coinA.address, 0))
                .to.emit(registry, "EventTerminated")
                .withArgs(id, coinA.address, S.EXPIRED);

            expect(await stateOf(id)).to.equal(S.EXPIRED);
            expect(await activeId(coinA.address)).to.equal(ethers.ZeroHash);
        });

        it("auto-recovery proceeds through RECOVERY_PENDING to NORMAL via DC + cooldown", async function () {
            const id = await toProtected(coinA.address, 2);

            // Trigger auto-recovery
            for (let i = 0; i < STABILITY_WINDOW; i++) {
                await report(coinA.address, 0);
            }
            expect(await stateOf(id)).to.equal(S.RECOVERY_PENDING);

            // Original destination slots were reset to PENDING; complete them after cooldown
            await time.increase(RECOVERY_COOLDOWN);
            await registry.connect(controller).destinationCallback(id, 0, DS.COMPLETE);
            await registry.connect(controller).destinationCallback(id, 1, DS.COMPLETE);

            expect(await stateOf(id)).to.equal(S.NORMAL);
            expect(await activeId(coinA.address)).to.equal(ethers.ZeroHash);
        });
    });

    // ── Full happy-path lifecycle ──────────────────────────────────────────────

    describe("full lifecycle: WATCH → NORMAL", function () {
        it("traverses every active state to NORMAL", async function () {
            // WATCH
            await report(coinA.address, WATCH_THRESHOLD);
            let id = await activeId(coinA.address);
            expect(await stateOf(id)).to.equal(S.WATCH);

            // CONFIRMED_DEPEG
            await report(coinA.address, CONFIRMED_THRESHOLD);
            expect(await stateOf(id)).to.equal(S.CONFIRMED_DEPEG);

            // PROTECTION_PENDING
            const protDest = [dest(1, ethers.Wallet.createRandom().address)];
            await registry.connect(controller).initiateProtection(id, protDest);
            expect(await stateOf(id)).to.equal(S.PROTECTION_PENDING);

            // PROTECTED
            await registry.connect(controller).destinationCallback(id, 0, DS.COMPLETE);
            expect(await stateOf(id)).to.equal(S.PROTECTED);

            // RECOVERY_PENDING
            const recDest = [dest(1, ethers.Wallet.createRandom().address)];
            await registry.connect(controller).initiateRecovery(id, recDest);
            expect(await stateOf(id)).to.equal(S.RECOVERY_PENDING);

            // NORMAL (DC fires after cooldown)
            await time.increase(RECOVERY_COOLDOWN);
            await registry.connect(controller).destinationCallback(id, 0, DS.COMPLETE);
            expect(await stateOf(id)).to.equal(S.NORMAL);
            expect(await activeId(coinA.address)).to.equal(ethers.ZeroHash);
        });
    });
});
