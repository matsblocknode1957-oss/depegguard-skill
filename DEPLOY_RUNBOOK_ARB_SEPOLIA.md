# StableGuard — Arbitrum Sepolia Redeploy Runbook
## Branch: release/redeploy-bundle | Target: end-to-end demo
## Shell: Windows PowerShell 5.1

---

## 0. Pre-flight

Open PowerShell in the repo root (`C:\Users\charl\depegguard-skill`).

```powershell
git checkout release/redeploy-bundle
git status          # must be clean (or stash any tmp_* scratch files)
npx hardhat compile # zero errors, zero warnings
npx hardhat test    # 333 passing, 2 pending (fork tests)
```

Review every contract diff against the previous deploy tag. Confirm the new deployer wallet has ETH on Arbitrum Sepolia (Arbiscan balance check). Record the new deployer address before continuing.

Required `.env` variables in the repo root (names only — never paste values):

| Variable | Used by |
|---|---|
| `ARB_SEPOLIA_RPC_URL` | Hardhat network connection |
| `CRE_ETH_PRIVATE_KEY` | Deployer private key (all scripts) |
| `ARBISCAN_API_KEY` | Contract verification |
| `USE_DEMO_FORWARDER` | Set to `1` to deploy with MockKeystoneForwarder (demo only) |

---

## 1. Contracts to deploy — order and constructor arguments

### Production deploy (default)

```powershell
npx hardhat run scripts/deploy-arbitrum-sepolia.js --network arbitrumSepolia
```

This deploys the production receiver using `0x76c9cf548b4179F8901cda1f8623568b58215E62` (the Chainlink Keystone Forwarder on Arbitrum Sepolia, which enforces DON signature verification).

### Demo deploy (MockKeystoneForwarder)

```powershell
$env:USE_DEMO_FORWARDER="1"
npx hardhat run scripts/deploy-arbitrum-sepolia.js --network arbitrumSepolia
Remove-Item Env:USE_DEMO_FORWARDER
```

This deploys the receiver using `0xd41263567ddfead91504199b8c6c87371e83ca5d` (the MockKeystoneForwarder on Arbitrum Sepolia). The mock forwarder skips signature verification, so any address can call `report()` on it — suitable for the demo but never for production.

**WARNING: Never use MockKeystoneForwarder on mainnet or with real user funds.**

The script deploys 5 contracts in dependency order and writes `deployments/arbitrum-sepolia.json`:

**1 — ExposureRegistry**
- Constructor: `(address _admin)` → deployer address

**2 — DepegEventRegistry**
- Constructor: `(address _admin, uint8 watchThr, uint8 confirmedThr, uint8 stabilityWin, uint256 evTTL, uint256 pendTTL, uint256 recoveryCd)`
- Values: `(deployer, 1, 2, 3, 86400, 3600, 1800)`

**3 — ProtectionHoldLedger**
- Constructor: `(address _governance, address _coordinator)` → `(deployer, deployer)`

**4 — StableGuardVault**
- Constructor: `(IERC20 asset_, string name_, string symbol_, address governance)`
- Values: `(0x75faf114eafb1BDbe2F0316DF893fd58CE46AA4d, "StableGuard USDC Vault", "sgUSDC", deployer)`

**5 — StableGuardCREReceiver**
- Constructor: `(address forwarder, address exposureRegistry, address eventRegistry, address vault, uint64 chainSelector, address holdLedger, uint256 maxReportAge)`
- Forwarder: production `0x76c9cf548b4179F8901cda1f8623568b58215E62` or demo `0xd41263567ddfead91504199b8c6c87371e83ca5d` depending on `USE_DEMO_FORWARDER`

The script prints each address and writes the full deployment JSON. Save `deployments/arbitrum-sepolia.json`.

---

## 2. Post-deploy wiring — ordered to run before role revocation

**Role dependency map** — every script that needs a deployer role must run before step 2h:

| Script | Role required |
|---|---|
| `register-exposure.js` | ExposureRegistry admin (deployer) |
| `deploy-demo-contracts-arbitrum.js` | None on existing contracts; deployer is owner of new contracts |
| `demo-wire-all.js` | GOVERNANCE_ROLE on StableGuardVault (deployer) |
| `demo-wire-morpho.js` | MockMorphoVaultV2.owner() = deployer (no vault GOVERNANCE_ROLE required) |
| `remediate-role-revocation.js` | **Runs last** — confirms no operational roles remain on deployer |

### 2a. Wiring performed automatically by `deploy-arbitrum-sepolia.js`

| Call | Why |
|---|---|
| `eventRegistry.setHoldLedger(holdLedger)` | Links registry to ledger |
| `eventRegistry.transferController(receiver)` | Grants receiver REPORTER_ROLE + ACTION_ROLE + PAUSE_COORDINATOR_ROLE |
| `eventRegistry.revokeRole(REPORTER_ROLE, deployer)` | Strips deployer of live operational roles |
| `eventRegistry.revokeRole(ACTION_ROLE, deployer)` | Same |
| `eventRegistry.revokeRole(PAUSE_COORDINATOR_ROLE, deployer)` | Same |
| `holdLedger.transferCoordinator(receiver)` | Receiver becomes sole coordinator |
| `vault.grantRole(PAUSE_COORDINATOR_ROLE, receiver)` | Lets receiver call `vault.pause()` |

### 2b. Register USDC exposure

Requires ExposureRegistry admin (= deployer). **Must run before 2h.**

```powershell
npx hardhat run scripts/register-exposure.js --network arbitrumSepolia
```

The script reads addresses from `deployments/arbitrum-sepolia.json` and verifies the signer matches the recorded deployer.

### 2c. Deploy demo contracts

```powershell
npx hardhat run scripts/deploy-demo-contracts-arbitrum.js --network arbitrumSepolia
```

Deploys MockMorphoVaultV2, MorphoSentinelAdapter, CustomerOverrideModule, TestPriceFeed, and MockSafe. Writes addresses to `deployments/arbitrum-sepolia-demo.json`.

### 2d. Update `config.arbitrum-demo.json`

After 2a and 2c, fill in the two `REPLACE_WITH_...` placeholders in
`stableguard-cre/depeg-monitor/config.arbitrum-demo.json`:

```json
"consumerAddress": "<StableGuardCREReceiver from deployments/arbitrum-sepolia.json>",
...
"demoFeedAddress": "<TestPriceFeed from deployments/arbitrum-sepolia-demo.json>"
```

Leave `priceFeedAddress` on USDC and USDT as `REPLACE_WITH_...` — the workflow skips
any coin whose feed starts with `REPLACE_`, so only USDC (via `demoFeedAddress`) is
reported during the demo. The `chainSelectorName: "ethereum-testnet-sepolia-arbitrum-1"`
and `chainSelector: "3478487238524512106"` are already correct for Arbitrum Sepolia.

The CRE simulate tool writes through the chain's forwarder for that environment. For
`ethereum-testnet-sepolia-arbitrum-1` in simulate mode this is the MockKeystoneForwarder
(`0xd41263567ddfead91504199b8c6c87371e83ca5d`) — the same address the receiver trusts.

### 2e. Wire CustomerOverrideModule

Requires GOVERNANCE_ROLE on StableGuardVault (= deployer). **Must run before 2h.**

```powershell
npx hardhat run scripts/demo-wire-all.js --network arbitrumSepolia
```

Performs all four wiring steps:

| Call | Purpose |
|---|---|
| `module.setVaultAuthority(vault, mockSafe)` | Binds MockSafe as the override authority |
| `module.setVaultReceiver(vault, receiver)` | Module calls `receiver.executeEarlyUnlock` on early unlock |
| `receiver.setOverrideModule(module)` | Enables override path in receiver |
| `holdLedger.approveVaultModule(vault, module)` | Grants module the right to call `releaseByOverride` |

### 2f. Wire Morpho infrastructure

Requires MockMorphoVaultV2.owner() = deployer. **Must run after 2c. Must run before 2h.**

```powershell
npx hardhat run scripts/demo-wire-morpho.js --network arbitrumSepolia
```

This deploys three fresh contracts (MorphoDepegEventRegistry, MorphoProtectionHoldLedger, MorphoCREReceiver) and wires the full Morpho path:

| Call | Purpose |
|---|---|
| `morphoEventReg.setHoldLedger(morphoHoldLedger)` | Links Morpho registry to its own ledger |
| `morphoEventReg.transferController(morphoReceiver)` | Grants Morpho receiver operational roles |
| `morphoHoldLedger.transferCoordinator(morphoReceiver)` | Morpho receiver becomes sole coordinator |
| `exposureRegistry.registerExposure(mockVault, USDC)` | Morpho receiver filters reports by exposure |
| `mockVault.setIsSentinel(adapter, true)` | Grants adapter sentinel rights on MockMorphoVaultV2 |
| `mockVault.setCap(marketData, 1_000_000, 500_000)` | Sets initial demo caps (zeroed on CONFIRMED_DEPEG) |
| `mockVault.setAllocation(marketData, 200_000)` | Sets initial demo allocation (deallocated on CONFIRMED_DEPEG) |
| `adapter.setReceiver(morphoReceiver)` | Binds adapter to the Morpho receiver |
| `adapter.registerMarkets(USDC_MAINNET, [marketEntry])` | Registers USDC market for cap-zeroing |
| `morphoReceiver.setMorphoAdapter(adapter)` | Activates the Morpho path in the receiver |

**Why a separate receiver?**
`setMorphoAdapter` authenticates via `vault.owner()`. StableGuardVault uses AccessControl (no `owner()`), so `setMorphoAdapter` always reverts on the main receiver. MockMorphoVaultV2 has `owner() = deployer`, which satisfies the auth check and enables a separate `MorphoCREReceiver`.

Saves `MorphoCREReceiver`, `MorphoDepegEventRegistry`, and `MorphoHoldLedger` addresses to `deployments/arbitrum-sepolia-demo.json`.

### Customer Safe options — MockSafe vs Real Safe

**Option A — MockSafe (recommended for the video demo)**

MockSafe is deployed by `deploy-demo-contracts-arbitrum.js` with the deployer as the only owner. All demo scripts use it automatically. No Safe app, no multisig UX needed during recording.

- `placeHold` / `renewHold`: call directly from the deployer EOA (MockSafe.isOwner(deployer) = true)
- `earlyUnlock`: deployer calls `mockSafe.callEarlyUnlock(...)` — msg.sender is the MockSafe contract, satisfying the `overrideAuthority` check

**Option B — Real Gnosis Safe (Arbitrum Sepolia, two wallets)**

1. Create a Safe at app.safe.global on Arbitrum Sepolia. Add both wallet addresses as owners. Set threshold to 1 (for demos) or 2 (realistic multisig).
2. Before running `demo-wire-all.js`, edit it to use your Safe address instead of `mockSafeAddr` for `setVaultAuthority`.
3. `placeHold` / `renewHold`: either wallet owner calls `module.placeHold(coin, vault)` directly (no Safe transaction needed).
4. `earlyUnlock`: go to app.safe.global → New transaction → Contract interaction → `module.earlyUnlock(coin, vault, rootIncidentId)`. Approve with the required threshold. The Safe contract is msg.sender == overrideAuthority ✓

**Recommendation**: Use MockSafe (Option A) for the video. Add a brief voiceover: "In production this would be a Gnosis Safe requiring multiple owners; here we use MockSafe so a single key demonstrates the full flow."

### setExpectedWorkflowOwner / setExpectedWorkflowId

Both default to zero after deploy (checks skipped). Leave at zero for the demo. If you obtain a paid CRE deployment, set them via a one-off Hardhat script.

### 2g. Verify all contracts on Arbiscan

Replace `<addr>` placeholders with addresses from `deployments/arbitrum-sepolia.json`.

```powershell
npx hardhat verify --network arbitrumSepolia <ExposureRegistry> <deployer>

npx hardhat verify --network arbitrumSepolia <DepegEventRegistry> `
  <deployer> 1 2 3 86400 3600 1800

npx hardhat verify --network arbitrumSepolia <ProtectionHoldLedger> `
  <deployer> <deployer>

npx hardhat verify --network arbitrumSepolia <StableGuardVault> `
  0x75faf114eafb1BDbe2F0316DF893fd58CE46AA4d "StableGuard USDC Vault" "sgUSDC" <deployer>

npx hardhat verify --network arbitrumSepolia <StableGuardCREReceiver> `
  <forwarder> <exposureRegistry> <eventRegistry> <vault> `
  3478487238524512106 <holdLedger> 3600
```

### 2h. Role revocation check — LAST wiring step

Run this **after** 2b (register-exposure), 2e (demo-wire-all), and 2f (demo-wire-morpho) are complete.
All three scripts require deployer roles that this script confirms are clear of operational access.

```powershell
npx hardhat run scripts/remediate-role-revocation.js --network arbitrumSepolia
```

This confirms (and revokes if still present) REPORTER_ROLE, ACTION_ROLE, and
PAUSE_COORDINATOR_ROLE on DepegEventRegistry. Expected output: all three "already revoked".

**Roles the deployer intentionally retains after this step:**

| Role | Contract | Why retained |
|---|---|---|
| `admin` | ExposureRegistry | Governance — add/remove vault exposures |
| `admin` | DepegEventRegistry | Governance — emergency controls (B-05) |
| `governance` | ProtectionHoldLedger | Governance — `forceTransferCoordinator` emergency override |
| `GOVERNANCE_ROLE` | StableGuardVault | Governance — rotate PAUSE_COORDINATOR_ROLE if needed |

None of these roles can submit reports, acquire holds, or trigger freezes — only the receiver can do that.

---

## 3. Demo vault — Morpho path

The demo uses two receivers, each targeting a different vault:

| Receiver | Vault | Freeze action |
|---|---|---|
| `StableGuardCREReceiver` | `StableGuardVault` | `vault.pause()` |
| `MorphoCREReceiver` | `MockMorphoVaultV2` | `adapter.onDepeg()` → zeroes Morpho market caps |

Both receivers share the same MockKeystoneForwarder. During Scene 1, reports are sent to both receivers in sequence — first the CRE simulate tool writes to the main receiver (vault pause), then `demo-send-morpho.js` writes directly to the Morpho receiver (caps zeroed). Both transactions are visible on Arbiscan in the same session.

There is no real Morpho Vault V2 on Arbitrum Sepolia. MockMorphoVaultV2 (deployed by `deploy-demo-contracts-arbitrum.js`) implements every interface that MorphoSentinelAdapter calls and is fully tested. Morpho cap restoration after recovery is a vault-owner admin action — the protocol does not auto-restore caps.

---

## 4. CRE workflow — price feed vs stub mode

The workflow (`stableguard-cre/depeg-monitor/main.ts`) reads prices on-chain via `evmClient.callContract` calling `latestRoundData()` on a Chainlink AggregatorV3-compatible feed. No Data Streams credentials are required.

### Stub mode (dry run, no chain writes)

`config.arbitrum-staging.json` has `"stubScenario": "depeg"`. When `stubScenario` is set, the workflow uses hardcoded offsets — USDC is forced to 300 bps CRITICAL — and no on-chain reads are needed. Use this to confirm the workflow compiles and produces a report before the live demo:

> **Login required**: `cre workflow simulate` calls the CRE API.
> Run `cre login` once before any simulate command.

```powershell
Set-Location stableguard-cre\depeg-monitor
cre workflow simulate . --target=arbitrum-staging-settings
Set-Location ..\..
```

No `--broadcast` — this is a dry run only. Confirm the JSON output shows `compositeScore: 3` and `signal: "CRITICAL"` for USDC.

### Demo mode — TestPriceFeed with `--broadcast`

`config.arbitrum-demo.json` points `demoFeedAddress` at the deployed TestPriceFeed. The workflow reads that feed on-chain, computes the signal, ABI-encodes the report, and (with `--broadcast`) submits it via the CRE forwarder infrastructure to `consumerAddress` (the receiver).

For `chainSelectorName: "ethereum-testnet-sepolia-arbitrum-1"` the simulate tool routes writes through the MockKeystoneForwarder (`0xd41263567ddfead91504199b8c6c87371e83ca5d`), which the receiver trusts. No DON signatures are verified.

---

## 5. Demo script — two scenes

Pre-requisites: steps 2a–2h complete; small USDC deposit in vault; `vault.paused()` = false; `cre login` done.

All `cre workflow simulate` commands run from `stableguard-cre\depeg-monitor`.

---

## Scene 1 — Automatic: depeg freeze + Morpho cap → auto-recovery

No human intervention after the depeg price is staged. The vault unfreezes on its own when the event reaches NORMAL.

---

### S1 Step 1 — Stage the depeg price (TestPriceFeed → $0.94)

```powershell
$env:PRICE="94000000"
npx hardhat run scripts/demo-set-price.js --network arbitrumSepolia
Remove-Item Env:PRICE
```

TestPriceFeed now returns $0.94 = 600 bps below peg → CRITICAL when the workflow reads it.

---

### S1 Step 2 — CRE simulate cycle 1: NORMAL → WATCH

```powershell
Set-Location stableguard-cre\depeg-monitor
cre workflow simulate . --target=arbitrum-demo-settings --broadcast
Set-Location ..\..
```

The workflow reads TestPriceFeed ($0.94), classifies USDC as CRITICAL (signalLevel=3,
compositeScore=3), ABI-encodes the report, and writes it on-chain via the MockKeystoneForwarder.
The receiver calls `eventRegistry.processReport` → state: **NORMAL → WATCH**.

Arbiscan — DepegEventRegistry: `EventAdvanced(NORMAL → WATCH)`

---

### S1 Step 3 — CRE simulate cycle 2: WATCH → CONFIRMED\_DEPEG + vault freeze

```powershell
Set-Location stableguard-cre\depeg-monitor
cre workflow simulate . --target=arbitrum-demo-settings --broadcast
Set-Location ..\..
```

confirmedThreshold=2 → `ProtectionInitiated` fires: hold acquired, `vault.pause()` called.

Arbiscan:
- DepegEventRegistry: `EventAdvanced(WATCH → CONFIRMED_DEPEG)`, `ProtectionInitiated(eventId, coin, destCount=1)`
- ProtectionHoldLedger: `HoldAcquired(holdId, vault, coin, ...)`
- StableGuardVault: `Paused(account=receiver)`
- `vault.paused()` = **true** ← show on Arbiscan

---

### S1 Step 4 — Morpho cap: second CRITICAL report to MorphoCREReceiver

```powershell
$env:COUNT="2"
npx hardhat run scripts/demo-send-morpho.js --network arbitrumSepolia
Remove-Item Env:COUNT
```

Sends two CRITICAL reports directly to MorphoCREReceiver via the same MockKeystoneForwarder.
The 1st report advances MorphoCREReceiver's registry to WATCH; the 2nd reaches CONFIRMED_DEPEG,
triggering `adapter.onDepeg()`.

Arbiscan — MorphoSentinelAdapter:
- `MorphoCapsZeroed(coin=0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48, marketsCapped=1)` ← **KEY MOMENT**
- `adapter.absoluteCap(marketId)` = 0
- `adapter.relativeCap(marketId)` = 0

> **Note**: Morpho cap restoration is a vault-owner admin action after recovery.
> The protocol signals recovery via `MorphoRecoverySignalled` but does NOT auto-restore caps.
> To restore: `mockVault.setCap(marketData, newAbsCap, newRelCap)` from the owner.

---

### S1 Step 5 — Reset price to peg

```powershell
$env:RESET="1"
npx hardhat run scripts/demo-set-price.js --network arbitrumSepolia
Remove-Item Env:RESET
```

TestPriceFeed now returns $1.00 = 0 bps → STABLE.

---

### S1 Step 6 — CRE simulate cycles 3 × STABLE → RECOVERY\_PENDING

Run the simulate three times (the stabilityWindow=3 requires three consecutive stable reports):

```powershell
Set-Location stableguard-cre\depeg-monitor
cre workflow simulate . --target=arbitrum-demo-settings --broadcast
cre workflow simulate . --target=arbitrum-demo-settings --broadcast
cre workflow simulate . --target=arbitrum-demo-settings --broadcast
Set-Location ..\..
```

After the third STABLE report, `eventRegistry` automatically transitions to **RECOVERY_PENDING**
and starts the recovery cooldown (recoveryCooldown = 1800 s).

Arbiscan — DepegEventRegistry: `EventAdvanced(PROTECTED → RECOVERY_PENDING)`

---

### S1 Step 7 — Wait cooldown, then final cycle → NORMAL (vault auto-unpauses)

After 1800 s (30 min), run one more cycle. `finalizeRecovery` becomes callable and the
receiver calls it, transitioning the event to **NORMAL** and calling `vault.unpause()` automatically — **no human action**.

```powershell
Set-Location stableguard-cre\depeg-monitor
cre workflow simulate . --target=arbitrum-demo-settings --broadcast
Set-Location ..\..
```

Arbiscan:
- DepegEventRegistry: `EventTerminated(eventId, coin, terminal=NORMAL)`
- StableGuardVault: `Unpaused(account=receiver)`
- `vault.paused()` = **false** ← show on Arbiscan — vault unfroze with no human action

> **Demo tip**: the 30-minute cooldown happens offscreen between S1 Step 6 and S1 Step 7.
> Cut the recording after the RECOVERY_PENDING transition, note "30-minute cooldown",
> then resume to show the NORMAL state and auto-unpause.

---

### BACKUP — Scene 1, if CRE simulate is unavailable

Replace S1 Steps 2–3 and S1 Steps 6–7 with `demo-send-report.js`. The report payload and receiver interaction are identical; the only difference is the transaction is sent directly by the deployer EOA rather than by the CRE DON.

```powershell
# BACKUP S1 Steps 2–3: two CRITICAL reports → freeze
$env:SCENARIO="depeg"
$env:COUNT="2"
npx hardhat run scripts/demo-send-report.js --network arbitrumSepolia
Remove-Item Env:SCENARIO
Remove-Item Env:COUNT

# BACKUP S1 Steps 6–7: three STABLE reports → recovery
$env:SCENARIO="stable"
$env:COUNT="3"
npx hardhat run scripts/demo-send-report.js --network arbitrumSepolia
Remove-Item Env:SCENARIO
Remove-Item Env:COUNT
# Then wait recoveryCooldown (1800 s) and run once more:
$env:SCENARIO="stable"
npx hardhat run scripts/demo-send-report.js --network arbitrumSepolia
Remove-Item Env:SCENARIO
```

S1 Step 1 (price set), S1 Step 4 (Morpho), S1 Step 5 (price reset) are unchanged.

---

## Scene 2 — Human override: earlyUnlock → vault unfreeze + ProtectionSuppressed

Begins immediately after Scene 1 completes (event in NORMAL state, vault unpaused).

**Check**: Scene 2 creates a new incident with a new `rootIncidentId`. Scene 1 had no `earlyUnlock`, so no suppression was set for (USDC, vault). Scene 2 freezes normally — there is nothing suppressed from Scene 1.

---

### S2 Step 1 — Stage the depeg price again (TestPriceFeed → $0.94)

```powershell
$env:PRICE="94000000"
npx hardhat run scripts/demo-set-price.js --network arbitrumSepolia
Remove-Item Env:PRICE
```

---

### S2 Step 2 — CRE simulate cycle 1: NORMAL → WATCH

```powershell
Set-Location stableguard-cre\depeg-monitor
cre workflow simulate . --target=arbitrum-demo-settings --broadcast
Set-Location ..\..
```

New incident: state **NORMAL → WATCH**. This is a fresh rootIncidentId — not suppressed by Scene 1.

---

### S2 Step 3 — CRE simulate cycle 2: WATCH → CONFIRMED\_DEPEG + vault freeze

```powershell
Set-Location stableguard-cre\depeg-monitor
cre workflow simulate . --target=arbitrum-demo-settings --broadcast
Set-Location ..\..
```

Arbiscan:
- DepegEventRegistry: `ProtectionInitiated(eventId, coin, destCount=1)`
- ProtectionHoldLedger: `HoldAcquired(holdId, vault, coin, ...)`
- StableGuardVault: `Paused(account=receiver)` ← **KEY MOMENT 0**: vault frozen again

---

### S2 Step 4 — Customer Safe places hold

```powershell
npx hardhat run scripts/demo-place-hold.js --network arbitrumSepolia
```

MockSafe owner activates the override hold. The hold ledger slot records the `rootIncidentId` for this incident, allowing the early unlock call to reference it.

---

### S2 Step 5 — Customer Safe early unlock (immediate vault unfreeze)

```powershell
npx hardhat run scripts/demo-early-unlock.js --network arbitrumSepolia
```

Call chain: deployer → `mockSafe.callEarlyUnlock(...)` → `module.earlyUnlock(...)` →
`holdLedger.releaseByOverride(...)` → `receiver.executeEarlyUnlock(...)` → `vault.unpause()`.

Arbiscan:
- ProtectionHoldLedger: `HoldReleasedByOverride(holdId, vault, ...)`
- StableGuardCREReceiver: `EarlyUnlockExecuted(coin, vault)`
- StableGuardVault: `Unpaused(account=receiver)` ← **KEY MOMENT 1**: vault unpaused immediately

`vault.paused()` = **false** immediately after this transaction. Suppression window now active for (USDC, vault) at this severity level.

---

### S2 Step 6 — Reset price to peg

```powershell
$env:RESET="1"
npx hardhat run scripts/demo-set-price.js --network arbitrumSepolia
Remove-Item Env:RESET
```

---

### S2 Step 7 — CRE simulate cycles 3 × STABLE → RECOVERY\_PENDING

```powershell
Set-Location stableguard-cre\depeg-monitor
cre workflow simulate . --target=arbitrum-demo-settings --broadcast
cre workflow simulate . --target=arbitrum-demo-settings --broadcast
cre workflow simulate . --target=arbitrum-demo-settings --broadcast
Set-Location ..\..
```

After the third STABLE report: **RECOVERY_PENDING**. Cooldown starts (1800 s).

---

### S2 Step 8 — Wait cooldown, then final cycle → NORMAL

After 1800 s (30 min):

```powershell
Set-Location stableguard-cre\depeg-monitor
cre workflow simulate . --target=arbitrum-demo-settings --broadcast
Set-Location ..\..
```

DepegEventRegistry: `EventTerminated(eventId, coin, terminal=NORMAL)`.
Suppression window remains active for the full `suppressionWindow` duration (3600 s from earlyUnlock).

---

### S2 Step 9 — Stage depeg price again (new CRITICAL attempt)

```powershell
$env:PRICE="94000000"
npx hardhat run scripts/demo-set-price.js --network arbitrumSepolia
Remove-Item Env:PRICE
```

---

### S2 Step 10 — CRE simulate × 2: ProtectionSuppressed (vault stays unpaused)

```powershell
Set-Location stableguard-cre\depeg-monitor
cre workflow simulate . --target=arbitrum-demo-settings --broadcast
cre workflow simulate . --target=arbitrum-demo-settings --broadcast
Set-Location ..\..
```

The second report would reach CONFIRMED_DEPEG, but the suppression window (set in S2 Step 5) is still active. The receiver detects the coin-vault suppression and gates the freeze.

Arbiscan — StableGuardCREReceiver:
- `ProtectionSuppressed(coin, vault, rootIncidentId)` ← **KEY MOMENT 2**
- StableGuardVault: **no** `Paused` event
- `vault.paused()` = **false** — customer override is in effect; same-severity reports cannot re-freeze during the suppression window

---

### BACKUP — Scene 2, if CRE simulate is unavailable

```powershell
# BACKUP S2 Steps 2–3: two CRITICAL reports → freeze
$env:SCENARIO="depeg"
$env:COUNT="2"
npx hardhat run scripts/demo-send-report.js --network arbitrumSepolia
Remove-Item Env:SCENARIO
Remove-Item Env:COUNT

# BACKUP S2 Steps 7–8: three STABLE + cooldown + one STABLE → NORMAL
$env:SCENARIO="stable"
$env:COUNT="3"
npx hardhat run scripts/demo-send-report.js --network arbitrumSepolia
Remove-Item Env:SCENARIO
Remove-Item Env:COUNT
# Wait 1800 s, then:
$env:SCENARIO="stable"
npx hardhat run scripts/demo-send-report.js --network arbitrumSepolia
Remove-Item Env:SCENARIO

# BACKUP S2 Steps 9–10: two CRITICAL → ProtectionSuppressed
$env:SCENARIO="depeg"
$env:COUNT="2"
npx hardhat run scripts/demo-send-report.js --network arbitrumSepolia
Remove-Item Env:SCENARIO
Remove-Item Env:COUNT
```

S2 Steps 1, 4, 5, 6, 9 (price set, place hold, early unlock) do not use the CRE tool and are unchanged.

---

## 6. What you need to do yourself — ordered steps

### Wallet funding (before any deploy)

Arbitrum Sepolia ETH: get from the Arbitrum Sepolia faucet. Budget 25–30 transactions (5 deploys + wiring + demo).

Arbitrum Sepolia USDC: Circle USDC testnet faucet or bridge from Ethereum Sepolia. Address: `0x75faf114eafb1BDbe2F0316DF893fd58CE46AA4d`.

### Environment variable names (never paste values)

| Variable | Required for |
|---|---|
| `ARB_SEPOLIA_RPC_URL` | All `--network arbitrumSepolia` commands |
| `CRE_ETH_PRIVATE_KEY` | Deployer private key for all scripts |
| `ARBISCAN_API_KEY` | Contract verification after deploy |
| `USE_DEMO_FORWARDER` | Set to `1` to use MockKeystoneForwarder (demo only) |

### Ordered step list

```
 1. Fund deployer wallet with Arbitrum Sepolia ETH and USDC
 2. Set ARB_SEPOLIA_RPC_URL, CRE_ETH_PRIVATE_KEY, ARBISCAN_API_KEY in .env

 3. Deploy core contracts (demo mode):
      $env:USE_DEMO_FORWARDER="1"
      npx hardhat run scripts/deploy-arbitrum-sepolia.js --network arbitrumSepolia
      Remove-Item Env:USE_DEMO_FORWARDER

 4. Register USDC exposure (needs ExposureRegistry admin):
      npx hardhat run scripts/register-exposure.js --network arbitrumSepolia

 5. Deploy demo contracts:
      npx hardhat run scripts/deploy-demo-contracts-arbitrum.js --network arbitrumSepolia

 6. Fill in stableguard-cre/depeg-monitor/config.arbitrum-demo.json:
      consumerAddress  → StableGuardCREReceiver address from deployments/arbitrum-sepolia.json
      demoFeedAddress  → TestPriceFeed address from deployments/arbitrum-sepolia-demo.json

 7. Wire CustomerOverrideModule (needs GOVERNANCE_ROLE on vault):
      npx hardhat run scripts/demo-wire-all.js --network arbitrumSepolia

 8. Wire Morpho infrastructure (needs MockMorphoVaultV2.owner = deployer):
      npx hardhat run scripts/demo-wire-morpho.js --network arbitrumSepolia

 9. Verify all 5 core contracts on Arbiscan (see Section 2g)

10. Role revocation check — LAST wiring step:
      npx hardhat run scripts/remediate-role-revocation.js --network arbitrumSepolia
      Expected: all three operational roles already revoked ✓

11. Deposit small USDC into the vault (use Arbiscan write tab or a one-off script)

12. Pre-recording checks:
      receiver.forwarder() == 0xd41263567ddfead91504199b8c6c87371e83ca5d       ✓
      vault.paused()       == false                                              ✓
      vault.asset()        == 0x75faf114eafb1BDbe2F0316DF893fd58CE46AA4d        ✓
      module.overrideAuthority(vault) == MockSafe address                        ✓
      adapter.absoluteCap(marketId)   > 0  (demo initial caps set)              ✓
      morphoReceiver.morphoAdapter()  == MorphoSentinelAdapter address           ✓

13. cre login

14. Dry-run to confirm workflow compiles and produces CRITICAL signal:
      Set-Location stableguard-cre\depeg-monitor
      cre workflow simulate . --target=arbitrum-staging-settings
      Set-Location ..\..

--- RECORDING STARTS ---

--- SCENE 1: Automatic ---

15. demo-set-price.js → $0.94 (CRITICAL)
       $env:PRICE="94000000"
       npx hardhat run scripts/demo-set-price.js --network arbitrumSepolia
       Remove-Item Env:PRICE

16. cre workflow simulate --broadcast × 1  →  WATCH
       (EventAdvanced NORMAL→WATCH on DepegEventRegistry)

17. cre workflow simulate --broadcast × 1  →  CONFIRMED_DEPEG + vault freeze
       (ProtectionInitiated, HoldAcquired, vault.paused() = true)

18. demo-send-morpho.js COUNT=2  →  MorphoCapsZeroed(marketsCapped=1)
       $env:COUNT="2"
       npx hardhat run scripts/demo-send-morpho.js --network arbitrumSepolia
       Remove-Item Env:COUNT
       (MorphoCapsZeroed on MorphoSentinelAdapter — show on Arbiscan)

19. demo-set-price.js → $1.00 (STABLE)
       $env:RESET="1"
       npx hardhat run scripts/demo-set-price.js --network arbitrumSepolia
       Remove-Item Env:RESET

20. cre workflow simulate --broadcast × 3  →  RECOVERY_PENDING (after 3rd stable cycle)
       (EventAdvanced PROTECTED→RECOVERY_PENDING on DepegEventRegistry)

21. Wait 1800 s (30 min — do offscreen), then:
    cre workflow simulate --broadcast × 1  →  NORMAL + vault auto-unpauses
       (EventTerminated NORMAL, vault.paused() = false — no human action)

--- Scene 1 ends (vault unpaused automatically) ---

--- SCENE 2: Human override ---

22. demo-set-price.js → $0.94 (new incident)
       $env:PRICE="94000000"
       npx hardhat run scripts/demo-set-price.js --network arbitrumSepolia
       Remove-Item Env:PRICE

23. cre workflow simulate --broadcast × 1  →  WATCH (new incident, not suppressed)

24. cre workflow simulate --broadcast × 1  →  CONFIRMED_DEPEG + vault freeze
       (vault.paused() = true — KEY MOMENT 0)

25. demo-place-hold.js  →  override hold active
       npx hardhat run scripts/demo-place-hold.js --network arbitrumSepolia

26. demo-early-unlock.js  →  vault.paused() = false (KEY MOMENT 1)
       npx hardhat run scripts/demo-early-unlock.js --network arbitrumSepolia
       (EarlyUnlockExecuted on receiver, vault unpaused immediately)

27. demo-set-price.js → $1.00 (STABLE)
       $env:RESET="1"
       npx hardhat run scripts/demo-set-price.js --network arbitrumSepolia
       Remove-Item Env:RESET

28. cre workflow simulate --broadcast × 3  →  RECOVERY_PENDING

29. Wait 1800 s (30 min — do offscreen), then:
    cre workflow simulate --broadcast × 1  →  NORMAL
       (suppressionWindow still active — 3600 s from earlyUnlock in step 26)

30. demo-set-price.js → $0.94 (new CRITICAL attempt during suppression window)
       $env:PRICE="94000000"
       npx hardhat run scripts/demo-set-price.js --network arbitrumSepolia
       Remove-Item Env:PRICE

31. cre workflow simulate --broadcast × 2  →  ProtectionSuppressed (KEY MOMENT 2)
       (ProtectionSuppressed on receiver; vault.paused() = false — override in effect)

--- RECORDING ENDS ---
```

### Pre-demo checklist

- [ ] Deployer wallet funded with Arbitrum Sepolia ETH
- [ ] All 5 core contracts deployed — addresses in `deployments/arbitrum-sepolia.json`
- [ ] All contracts verified on Arbiscan
- [ ] USDC exposure registered (`register-exposure.js`)
- [ ] Demo contracts deployed — addresses in `deployments/arbitrum-sepolia-demo.json`
- [ ] `config.arbitrum-demo.json` `consumerAddress` and `demoFeedAddress` filled in
- [ ] `demo-wire-all.js` completed successfully
- [ ] `demo-wire-morpho.js` completed successfully — MorphoCREReceiver in demo JSON
- [ ] `remediate-role-revocation.js` reports all three roles revoked ✓
- [ ] Small USDC deposit visible in vault on Arbiscan
- [ ] `receiver.forwarder()` on Arbiscan = `0xd41263567ddfead91504199b8c6c87371e83ca5d`
- [ ] `adapter.absoluteCap(marketId)` > 0 on Arbiscan (demo caps set by demo-wire-morpho.js)
- [ ] `vault.paused()` = false before recording begins
- [ ] `cre login` completed
- [ ] Dry-run simulate (stub mode) confirmed CRITICAL signal for USDC
