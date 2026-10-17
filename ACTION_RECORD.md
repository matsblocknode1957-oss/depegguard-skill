# StableGuard — Action Record

**Milestone 5 · Reviewer checklist · 2026-08-18**

Documents exactly what evidence state must exist before each action fires,
which contract guards enforce it, and which tests prove it. Honest about
what is and is not yet proven: sections 2 and 3 map cleanly onto what has
been built (milestones 1–2) versus what requires real CCIP wiring
(milestone 3, pending review feedback).

---

## 1. Evidence state required per action

### 1.1 Alert (WATCH signal published)

**Trigger path:**
The CRE workflow (`stableguard-cre/depeg-monitor/main.ts`) fetches prices
from Chainlink Data Streams on every cron tick, computes per-coin
`classifySignal(bps)` (0 STABLE / 1 WATCH / 2 HEDGE / 3 EXIT), and writes
a signed ABI-encoded report to `StableGuardCREReceiver.onReport()` via the
KeystoneForwarder.

**Required evidence state before alert fires:**

| condition | enforced by |
|---|---|
| Caller is the registered KeystoneForwarder address | `StableGuardCREReceiver.onReport()` line 110: `if (msg.sender != forwarder) revert UnauthorizedForwarder(caller)` |
| Per-coin `signalLevel ≥ watchThreshold` | **G0** (`DepegEventRegistry.processReport`): score below `watchThreshold` with no active event returns `(bytes32(0), State.NORMAL)` — no event is created and no alert is emitted |
| No non-terminal event already open for this coin | **G1** (`processReport` lookup-before-create): `activeEventId[coinKey]` checked first; if an active (non-terminal) event exists, `_extend()` is called instead of `_create()` — one event per ongoing incident, never two |

**On success:** `_create()` opens a new event in `State.WATCH` and emits
`EventCreated(eventId, coin, score)`.

**If an active event exists:** `_extend()` updates `compositeScore`,
`evidenceRoot`, and `observedAt`; emits `EventExtended`. The existing
`eventId` is returned unchanged. This is the idempotency guarantee: the
same incident always maps to the same `eventId` until that event reaches a
terminal state.

---

### 1.2 Pause / hedge (vault protection)

Protection fires inside `StableGuardCREReceiver.onReport()` in four
sequential try/catch calls per coin. Each is independently caught; a
failure at any step emits an event and skips to the next coin.

**Required evidence state — in order of enforcement:**

**Step 1 — score reaches `confirmedThreshold` in `processReport`:**

| condition | enforced by |
|---|---|
| Coin is in WATCH state and `score ≥ confirmedThreshold` | **G2** (`_applyScoreTransitions`): `if (ev.state == State.WATCH && score >= confirmedThreshold)` advances to `State.CONFIRMED_DEPEG` and emits `EventAdvanced` |
| Event has not expired | **G13** (`_applyScoreTransitions`, checked first): `if (block.timestamp >= ev.createdAt + eventTTL)` terminates as EXPIRED before any score transition; protection never fires |
| `processReport` caller is the controller | `if (msg.sender != controller) revert Unauthorized()` — `controller` is set to the receiver address via `transferController()` after deployment |

If `processReport` returns any state other than `CONFIRMED_DEPEG`,
`onReport()` calls `continue` — no further action for that coin in this
report cycle.

**Step 2 — exposure gate:**

```solidity
bytes32 sym = bytes32(uint256(uint160(coin)));
if (!exposureRegistry.isExposed(vault, sym))  {
    emit VaultExposureMissing(vault, sym);
    continue;
}
```

`ExposureRegistry.isExposed(vault, symbol)` returns `true` only for
`(vault, symbol)` pairs explicitly registered via
`ExposureRegistry.registerExposure()`. A coin that reached CONFIRMED_DEPEG
in the registry does **not** trigger a pause unless the vault provably holds
that asset. If the check fails, the event stays in CONFIRMED_DEPEG
(protection is not initiated), and subsequent reports re-evaluate the gate.

**Step 3 — `initiateProtection` (G5):**

| condition | enforced by |
|---|---|
| Event is in CONFIRMED_DEPEG | **G5** (`initiateProtection`): `if (ev.state != State.CONFIRMED_DEPEG) revert InvalidTransition(ev.state)` |
| At least one destination provided | `if (dests.length == 0) revert NoDestinations()` |
| Event TTL not elapsed | G13 check inside `initiateProtection`: terminates as EXPIRED and returns before advancing to PROTECTION_PENDING |
| Caller is controller | `if (msg.sender != controller) revert Unauthorized()` |

On success: event advances to `State.PROTECTION_PENDING`, emits
`EventAdvanced(…, CONFIRMED_DEPEG, PROTECTION_PENDING)` and
`ProtectionInitiated`.

**Step 4 — `vault.pause()`:**

Called only after `initiateProtection` succeeds. Failure is caught, emits
`VaultPauseFailed`, and the outcome is recorded honestly in step 5.

**Step 5 — `destinationCallback` (DG1–DG3):**

```solidity
IDepegEventRegistry.DestState dcState = paused
    ? IDepegEventRegistry.DestState.COMPLETE
    : IDepegEventRegistry.DestState.FAILED;
eventRegistry.destinationCallback(eventId, 0, dcState);
```

The slot must be in `DestState.PENDING`; any other state reverts
`DestinationNotPending` (**DG3**). `COMPLETE` is structurally sticky: once
written, no subsequent callback — delayed, duplicated, or reordered — can
overwrite it.

---

### 1.3 Recovery / unpause

Recovery is the action-driven path (G9–G12) and is **not yet wired into the
CRE workflow**. It currently requires an explicit controller call.

**Required evidence state:**

| step | condition | enforced by |
|---|---|---|
| `initiateRecovery(eventId, dests)` | Event in `State.PROTECTED` | **G9**: `if (ev.state != State.PROTECTED) revert InvalidTransition(ev.state)` |
| | Event TTL not elapsed | G13 check inside `initiateRecovery` |
| | Caller is controller | `Unauthorized()` |
| All recovery destinations COMPLETE | All destination slots settled to `COMPLETE` | **G10** (`_evaluateRecovery`): advances to NORMAL only when `allSettled && completeCount == effectiveTotal` |
| Recovery cooldown elapsed | `block.timestamp >= ev.recoveryInitiatedAt + recoveryCooldown` | **G10** / `finalizeRecovery()`: reverts `RecoveryConditionsNotMet` if cooldown not elapsed |
| Partial recovery | Some destinations COMPLETE, some FAILED | **G10b**: advances to `PARTIALLY_RECOVERED`; retry via `retryFailedDestinations` + further DCs |
| All recovery destinations FAILED | None COMPLETE | **G11**: terminates as `State.FAILED` |
| Recovery pending timeout | `block.timestamp >= recoveryInitiatedAt + pendingTTL` | **G12**: terminates as FAILED via DC or `settlePending()` |

Terminal state `NORMAL` clears `activeEventId[coinKey]`, allowing a fresh
event to be opened on the next qualifying report.

---

## 2. What's proven (with test references)

### 2.1 Asset-to-vault exposure binding

**Claim:** An alert for an asset the vault does not hold cannot change vault
state.

**Proven by:** `test/exposure-binding.test.js`

| test name | what it proves |
|---|---|
| `"emits VaultExposureMissing and does not pause when vault holds B but alert is for A"` | Alert for coinA with only coinB registered → VaultExposureMissing emitted, `vault.paused() === false` |
| `"emits VaultExposureMissing and does not pause when vault has no exposure registered"` | Zero exposure registered → same outcome |
| `"pauses vault when it holds the alerted asset"` | Positive path: coinA registered, coinA alert → `vault.paused() === true` |
| `"skips unregistered coin but still pauses for registered coin in same report"` | Multi-coin report: coinA skipped (VaultExposureMissing), coinB protected — per-coin isolation in the loop |
| `"revoked exposure blocks a fresh pause after prior event expires"` | After first event expires (`settleExpired`) and exposure is revoked, a fresh CONFIRMED_DEPEG triggers VaultExposureMissing, not pause — proves the gate re-evaluates on every new event, not just the first |

### 2.2 Idempotent cross-chain transition ID (lookup-before-create)

**Claim:** Multiple reports during the same ongoing incident map to the same
`eventId`; a new event is minted only after the prior one reaches a terminal
state.

**Proven by:** `test/depeg-event-registry.test.js`, describe block `"G1 – lookup-before-create (extend)"`

| test name | what it proves |
|---|---|
| `"extends an existing WATCH event instead of creating a new one"` | Second `processReport` emits `EventExtended` with the same `eventId`, not `EventCreated` |
| `"extends an existing CONFIRMED_DEPEG event"` | Lookup-before-create works in all active states, not only WATCH |
| `"creates a new event after prior event reaches NORMAL"` | Terminal NORMAL clears `activeEventId`; next qualifying report mints a distinct `eventId` |
| `"creates a new event after prior event reaches EXPIRED"` | Same for EXPIRED terminal; G13 expiry and subsequent creation tested together |

Also covered in describe `"G16 – terminal state blocks writes"`:
`"processReport on same coin creates new event (lookup-before-create)"` —
terminal NORMAL allows new creation, all write functions (`settleExpired`,
`supersede`, `initiateProtection`, `destinationCallback`) revert
`AlreadyTerminal` on the old `eventId`.

### 2.3 Stale-message rejection / replay safety (DG3)

**Claim:** Once a destination slot leaves `DestState.PENDING`, no further
write can change it — duplicate, delayed, or reordered CCIP callbacks
cannot alter a settled outcome.

**Proven by:** `test/depeg-event-registry.test.js`, describe block
`"DG1–DG3 – destination slot guard (COMPLETE is sticky)"`

| test name | what it proves |
|---|---|
| `"DG3: reverts when DC called on a COMPLETE destination (duplicate callback)"` | `destinationCallback(id, 0, FAILED)` after slot 0 is COMPLETE → `DestinationNotPending(0, COMPLETE)` |
| `"DG3: duplicate COMPLETE on same slot reverts DestinationNotPending"` | Even a duplicate COMPLETE (same value) is rejected — slot must be PENDING |
| `"DG3: reverts when DC called on a FAILED destination"` | FAILED slot is equally frozen — cannot be overwritten without `retryFailedDestinations` first resetting it to PENDING |
| `"DG3: stale FAILED cannot overwrite COMPLETE after retry succeeded"` | Slot 1: FAILED → retried to PENDING → COMPLETE → PROTECTED. Late-arriving FAILED reverts `InvalidTransition` (event is now PROTECTED, no longer a DC-accepting state) |

The `retryFailedDestinations` guard (DG4–DG5) is also tested in
`"DG5: reverts when retrying a COMPLETE destination"` and
`"DG5: reverts when retrying a PENDING destination (slot already re-queued)"`.

### 2.4 One bad source, pool, or delayed message cannot silently cause an unintended treasury action

**Claim:** A single rogue or delayed input cannot cause a vault pause or
unregistered-asset protection without passing all three gates: forwarder
authentication, CONFIRMED_DEPEG state machine transition, and exposure
registry check.

**Proven by:** the combination of tests across both files.

The forwarder gate is unit-tested implicitly by every `exposure-binding.test.js`
test: all calls go via `receiver.connect(forwarder)` — calls from any other
address revert `UnauthorizedForwarder`. The `onReport` forwarder check has
no dedicated negative test (it was not written because the custom error
makes it unambiguous), but this is a gap worth noting.

The state machine gate is proven by:
- `"returns zero eventId and NORMAL when score is below watchThreshold with no active event"` (G0 negative path) — below-threshold score produces no event
- `"stays WATCH below confirmedThreshold"` (G2 negative) — single WATCH-level report does not reach CONFIRMED_DEPEG
- `"reverts when not in CONFIRMED_DEPEG"` (G5 negative) — `initiateProtection` cannot fire from WATCH

The exposure gate is proven by the `exposure-binding.test.js` tests in 2.1
above — particularly `"revoked exposure blocks a fresh pause after prior
event expires"`, which proves the gate is re-evaluated on every new event
and cannot be bypassed by a leftover terminal event.

The settled-event non-re-fire is proven by:
`"settled event does not re-fire on repeat alert"` (`exposure-binding.test.js`) —
once an event is PROTECTED, subsequent `processReport` calls return
PROTECTED and `onReport` short-circuits before touching exposure or pause
logic.

---

## 3. What is NOT yet proven

The following gaps are explicit. Each requires real CCIP wiring (milestone 3)
or a governance/ops policy decision before it can be closed.

### 3.1 Destination acknowledgement and retry ledger under real asynchronous multi-chain CCIP conditions

The destination callback loop (G6, G6b, G7, G8, DG1–DG5) is tested against
a single synchronous in-process destination — all callbacks arrive
immediately in the same test block. Under real CCIP, messages may arrive
minutes or hours apart, out of order, or not at all. The ledger mechanics
are correct by construction, but the real-world timing path — message
dispatch, destination-chain execution, CCIP acknowledgement back to source —
has not been exercised.

### 3.2 Partial-delivery handling under genuine cross-chain latency and failure

`PARTIALLY_PROTECTED` and `PARTIALLY_RECOVERED` states exist and are
covered by local tests (G6b, G10b). Under genuine cross-chain conditions,
partial delivery means some vaults are paused and some are not during the
gap between the first and last successful CCIP message. The actual window
of partial protection — how long it lasts, which vaults are affected — has
not been measured or bounded.

### 3.3 Maximum action latency

End-to-end latency from a price anomaly appearing in a Data Streams report
to a vault being paused is not measured. It depends on: CRE cron interval
(currently `*/30 * * * * *` in staging, `0 */5 * * * *` in production
config), CCIP message finality time on each destination chain, and gas
conditions. No SLO exists for this path.

### 3.4 Human / governance override mechanism

`supersede(eventId)` exists in `DepegEventRegistry` and allows the
controller (currently the receiver) to terminate a WATCH or CONFIRMED_DEPEG
event before it reaches PROTECTION_PENDING. Beyond that transition window,
`CannotSupersede` reverts (G15). There is no governance-gated wrapper,
multisig, or timelock around either `supersede` or `transferController`.
An operator who needs to override a protection in-flight (PROTECTION_PENDING
or later) has no on-chain mechanism to do so without also terminating the
event via TTL expiry.

### 3.5 Recovery and unpause operational policy

The state machine supports recovery: `PROTECTED → initiateRecovery() →
RECOVERY_PENDING → NORMAL`. The `recoveryCooldown` timer and the
`finalizeRecovery()` permissionless helper are implemented and tested. The
four open questions from earlier review have been resolved as follows.

**Default path — fully automatic, no human involved:**
Recovery is condition-triggered via `stableCount` reaching `stabilityWindow`
(built in this branch). No operator key, no signatory, no manual
`initiateRecovery()` call is needed for the standard case. This directly
resolves the original questions about who authorises recovery, what triggers
it, and whether there is an SLA — there is no human waiting period at all in
the default path.

**Override authority belongs entirely to the customer, never to StableGuard:**
StableGuard builds the override *mechanism*; the customer's own treasury/DAO
governance holds the actual keys and authority. StableGuard is never a signer
on any customer's override multisig and never has unilateral power to force a
pause or force a recovery on a customer's vault.

**Two distinct override paths, treated asymmetrically:**

The two overrides carry different risk profiles and are intentionally held to
different bars.

1. **Delay override** (hold locked past when the algorithm would reopen): low
   bar. Any single authorised signer from the customer's own multisig can
   invoke this. Pure downside protection — the only cost of misuse is
   unnecessary caution, not risk to funds. Use case: adverse news about an
   issuer has not yet shown up in price data and the customer wants to wait
   before reopening even though `stableCount` has been met.

2. **Early-unlock override** (reopen before the algorithm's own conditions are
   met): higher bar. Requires the customer's own multisig threshold (e.g.
   2-of-3, whatever the customer has configured — StableGuard does not set
   this). The on-chain call must include a recorded justification string,
   creating a permanent audit trail of why a human chose to override the
   automatic safety check. This is deliberately harder to invoke than the
   delay override, since forcing an early unlock reintroduces exactly the kind
   of manual-trust risk the automatic system was built to remove.

**TTL expiry while paused:**
Unchanged from what is already built — `resumeProtectionTracking()`
automatically re-arms tracking if `eventTTL` expires before `stableCount`
reaches `stabilityWindow`, so a vault can never be permanently stuck with
nothing tracking it. No automatic unpause is tied to the TTL clock; recovery
remains condition-based, not calendar-based.

---

## 4. Threshold and configuration caveat

The `watchThreshold` and `confirmedThreshold` constructor arguments to
`DepegEventRegistry` determine the score required to open a WATCH event and
to advance to CONFIRMED_DEPEG respectively. The values used in both test
suites are **test fixture values only**:

| file | `watchThreshold` | `confirmedThreshold` | note |
|---|---|---|---|
| `test/depeg-event-registry.test.js` | 1 | 2 | Standard two-step path: WATCH then CONFIRMED |
| `test/exposure-binding.test.js` | 1 | 2 | Standardized to match registry suite |

Both test suites now use the same constructor arguments. The earlier
`exposure-binding` fixture used `confirmedThreshold = 1` (collapsing
WATCH→CONFIRMED_DEPEG into one step) purely for setup brevity. That
was confirmed to be a test-only simplification with no effect on what the
tests assert — all exposure-binding tests verify behaviour after
CONFIRMED_DEPEG is reached, not how many reports it took to get there.
The fixture was standardized as part of this milestone.

Neither value reflects a confirmed production deployment. `DepegEventRegistry`
has no live deployment as of 2026-08-18. Production constructor arguments
(including `eventTTL`, `pendingTTL`, `recoveryCooldown`) are not documented
in this repository. Any detection-record backtest or scoring analysis that
uses these values must state clearly that they are illustrative.

The `classifySignal` thresholds in `stableguard-cre/depeg-monitor/main.ts`
(20 / 50 / 100 bps → WATCH / HEDGE / EXIT) are the confirmed production
values — they are hardcoded in the CRE workflow and not constructor
parameters.

---

## 5. Live protection event — 2 Oct 2026

The first successful on-chain protection fired on Arbitrum Sepolia shortly after
2 Oct 2026 22:14 BST. It is documented in the README (commit `66fdc56`, 4 Oct 2026)
as the "live protection transaction (simulated 3% USDC depeg, testnet)".

| field | value |
|---|---|
| Date | 2026-10-02T21:17:13 UTC (22:17:13 BST) — block 315,108,940 |
| Network | Arbitrum Sepolia (chain selector `3478487238524512106`, chain ID 421614) |
| Coin | USDC (`0x75faf114eafb1BDbe2F0316DF893fd58CE46AA4d` on Arb Sepolia) |
| Signal | CRITICAL (level 3) — 300 bps simulated depeg via `stubScenario: "depeg"` in `config.arbitrum-staging.json` |
| Receiver | `StableGuardCREReceiver` `0xac83a85Ee4dF1FfF44DFdEF055e95Db4886a9aD8` |
| Vault | `StableGuardVault` `0x86602cDeC52Df65Bc8D66528De429EB11A9E0497` |

**What triggered it:**

The CRE arbitrum-staging workflow (`config.arbitrum-staging.json`, 30-second cron,
`chainSelectorName: "ethereum-testnet-sepolia-arbitrum-1"`) was running with
`stubScenario: "depeg"`, which applies `STUB_DEPEG_USDC_OFFSET = −30,000,000,000,000,000`
raw price units (−300 bps) to USDC on every tick. `classifySignal(300)` returns CRITICAL
(level 3); with `watchThreshold = 1` and `confirmedThreshold = 2` this reaches
`CONFIRMED_DEPEG` on the second consecutive tick (~30 s after the first).

The workflow had been deployed to the CRE private registry (commit `c98b52e`, 20:02 BST)
but was not routing correctly: the previous receiver (`0x8A3De0095Eb8741f89d3a3BF71DEA1d4857a9bbd`)
was missing `supportsInterface(IReceiver_ID = 0x805f2132)`, causing the Chainlink
KeystoneForwarder to mark it `invalidReceiver` and skip `onReport()`. Commit `d420a3a`
(22:03 BST) added ERC-165 support and redeployed the receiver to `0xac83a85...`; commit
`43d93bc` (22:14 BST) updated both arbitrum workflow configs to point at the new address.
The first `onReport()` that actually executed was the 30-second tick after 22:14 BST.

**Call sequence (§ 1.2 and `StableGuardCREReceiver` NatSpec):**

**Ticks 1 and 2 (same transaction)** — `EventCreated` and all transitions to PROTECTED fired
in the single protection tx. This was the first `onReport()` call after the receiver was
redeployed; `processReport` called `_create()` (→ `State.WATCH`, emits `EventCreated`) and
then `_applyScoreTransitions` immediately advanced to `CONFIRMED_DEPEG` (score 3 ≥
`confirmedThreshold` 2) in the same call. There is no separate preceding WATCH tick on-chain.

**The protection tx (22:17:13 BST) — this is the recorded transaction:**

1. `processReport(USDC, 3, evidenceRoot)` — score 3 ≥ `confirmedThreshold` 2 → `CONFIRMED_DEPEG`, emits `EventAdvanced`
2. `ExposureRegistry.isExposed(vault, usdcKey)` → `true`
3. `DepegEventRegistry.initiateProtection(eventId, [{localChainSelector, vault}])` → `PROTECTION_PENDING`
4. `ProtectionHoldLedger.acquire()` at `0xA3175824EEF5964bA5A839CdBc01e6F8F1F3444b` — hold claimed
5. `StableGuardVault.pause()` at `0x86602cDeC52Df65Bc8D66528De429EB11A9E0497` — vault frozen
6. `DepegEventRegistry.destinationCallback(eventId, 0, COMPLETE)` → `PROTECTED`

**Transaction hashes:**

| event | tx hash | explorer |
|---|---|---|
| Protection (vault paused → PROTECTED) | `0x2bce3db20f25841c7d0570440ffd22e05542842302286da790d6c9591f1cbc6c` | [Arbiscan](https://sepolia.arbiscan.io/tx/0x2bce3db20f25841c7d0570440ffd22e05542842302286da790d6c9591f1cbc6c) |
| Preceding WATCH tick | None — `EventCreated` fired in the protection tx (no prior tick; see above) | — |
| Recovery / unpause | No recovery as of 2026-10-17 (block 320,180,853). Vault remains paused. No `VaultUnpaused`, `RecoveryInitiated`, or `HoldReleased` found on-chain. | — |

**All 14 events in the protection tx — decoded from chain:**

| # | contract | event | key args |
|---|---|---|---|
| 1 | Receiver | `CoinAlert` | coin=USDC `0xA0b8…eB48`, deviationBps=300, signalLevel=3 |
| 2 | Receiver | `DepegReport` | compositeScore=3, marketStress=0, observedAt=1790975830 |
| 3 | Registry | `EventCreated` | eventId=`0xc6e8…f133`, score=3 → WATCH |
| 4 | Registry | `EventAdvanced` | WATCH → CONFIRMED\_DEPEG |
| 5 | Registry | `EventAdvanced` | CONFIRMED\_DEPEG → PROTECTION\_PENDING |
| 6 | Registry | `ProtectionInitiated` | destCount=1 |
| 7 | Ledger | `HoldAcquired` | holdId=`0x4968…79da`, vault=`0x8660…0497` |
| 8 | Vault | `VaultPaused` | by=`0xac83…9aD8` (receiver) |
| 9 | Registry | `DestinationUpdated` | destIndex=0, newState=COMPLETE |
| 10 | Registry | `EventAdvanced` | PROTECTION\_PENDING → PROTECTED |
| 11–13 | Receiver | *(3 internal state-storage logs, topic0=`0x8f32c7ab`)* | |
| 14 | KeystoneForwarder | *(forwarder acknowledgement, topic0=`0x3617b009`)* | |

**Event ID:** `0xc6e8da8f4cd97f7d134f8c2decc525263b761548285c748939fd4fe783aef133`
