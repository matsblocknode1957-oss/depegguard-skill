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

**Role dependency map** — every script that needs a deployer role must run before step 2f:

| Script | Role required |
|---|---|
| `register-exposure.js` | ExposureRegistry admin (deployer) |
| `deploy-demo-contracts-arbitrum.js` | None on existing contracts; deployer is owner of new contracts |
| `demo-wire-all.js` | GOVERNANCE_ROLE on StableGuardVault (deployer) |
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

Requires ExposureRegistry admin (= deployer). **Must run before 2f.**

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

Requires GOVERNANCE_ROLE on StableGuardVault (= deployer). **Must run before 2f.**

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

### MorphoSentinelAdapter (advanced — requires separate demo receiver)

`setMorphoAdapter` authenticates via `vault.owner()`. StableGuardVault uses AccessControl (not Ownable) so `owner()` is not present and `setMorphoAdapter` will revert. For a Morpho-path demo, deploy a separate receiver with MockMorphoVaultV2 as its vault (the mock implements `owner()`), plus fresh registry + ledger instances. Not part of the standard video demo.

### setExpectedWorkflowOwner / setExpectedWorkflowId

Both default to zero after deploy (checks skipped). Leave at zero for the demo. If you obtain a paid CRE deployment, set them via a one-off Hardhat script.

### 2f. Verify all contracts on Arbiscan

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

### 2g. Role revocation check — LAST wiring step

Run this **after** 2b (register-exposure) and 2e (demo-wire-all) are complete.
Both scripts require deployer roles that this script confirms are clear of operational access.

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

There is no real Morpho Vault V2 on Arbitrum Sepolia. Use MockMorphoVaultV2 (already in the repo), deployed by `deploy-demo-contracts-arbitrum.js`. It implements every interface that MorphoSentinelAdapter calls and is fully tested.

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

## 5. Demo script — alarm → freeze → customer Safe unlock → recovery

Pre-requisites: steps 2a–2g complete; small USDC deposit in vault; `vault.paused()` = false; `cre login` done.

All `cre workflow simulate` commands run from `stableguard-cre\depeg-monitor`.

---

### Step 1 — Stage the depeg price (TestPriceFeed → $0.94)

```powershell
$env:PRICE="94000000"
npx hardhat run scripts/demo-set-price.js --network arbitrumSepolia
Remove-Item Env:PRICE
```

TestPriceFeed now returns $0.94 = 600 bps below peg → CRITICAL when the workflow reads it.

---

### Step 2 — CRE simulate cycle 1: NORMAL → WATCH

```powershell
Set-Location stableguard-cre\depeg-monitor
cre workflow simulate . --target=arbitrum-demo-settings --broadcast
Set-Location ..\..
```

The workflow reads TestPriceFeed ($0.94), classifies USDC as CRITICAL (signalLevel=3,
compositeScore=3), ABI-encodes the report, and writes it on-chain via the MockKeystoneForwarder.
The receiver calls `eventRegistry.processReport` → state: **NORMAL → WATCH**.

---

### Step 3 — CRE simulate cycle 2: WATCH → CONFIRMED\_DEPEG + vault freeze

```powershell
Set-Location stableguard-cre\depeg-monitor
cre workflow simulate . --target=arbitrum-demo-settings --broadcast
Set-Location ..\..
```

confirmedThreshold=2 → `initiateProtection` fires: hold acquired, `vault.pause()` called.
On Arbiscan, `vault.paused()` = true. CustomerOverrideModule receives `registerHold` automatically.

---

### Step 4 — Customer Safe places hold (blocks auto-recovery)

```powershell
npx hardhat run scripts/demo-place-hold.js --network arbitrumSepolia
```

MockSafe owner activates the override hold. Auto-recovery is blocked while the hold is active.

---

### Step 5 — Customer Safe early unlock (immediate vault unfreeze)

```powershell
npx hardhat run scripts/demo-early-unlock.js --network arbitrumSepolia
```

Call chain: deployer → `mockSafe.callEarlyUnlock(...)` → `module.earlyUnlock(...)` →
`holdLedger.releaseByOverride(...)` → `receiver.executeEarlyUnlock(...)` → `vault.unpause()`.

On Arbiscan immediately after: `vault.paused()` = false. The destination slot is marked COMPLETE;
the event is now PROTECTED and eligible for recovery tracking.

---

### Step 6 — Reset price to peg

```powershell
$env:RESET="1"
npx hardhat run scripts/demo-set-price.js --network arbitrumSepolia
Remove-Item Env:RESET
```

TestPriceFeed now returns $1.00 = 0 bps → STABLE.

---

### Step 7 — CRE simulate cycles 3 × STABLE → RECOVERY\_PENDING

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

---

### Step 8 — Wait cooldown, then final cycle → NORMAL

After 1800 s (30 min), run one more cycle. `finalizeRecovery` becomes callable and the
receiver calls it, transitioning the event to **NORMAL**:

```powershell
Set-Location stableguard-cre\depeg-monitor
cre workflow simulate . --target=arbitrum-demo-settings --broadcast
Set-Location ..\..
```

> **Demo tip**: the vault is already unpaused after Step 5 — that is the key on-screen
> moment. The 30-minute cooldown happens offscreen. You can cut the recording after Step 5,
> note "recovery completes automatically after a 30-minute cooldown," then show the
> NORMAL state later or in a voiceover.

---

### BACKUP — if CRE simulate is unavailable on the day

If `cre workflow simulate --broadcast` fails (auth issue, CRE API outage), replace
Steps 2–3 and Steps 7–8 with `demo-send-report.js`. The report payload and receiver
interaction are identical; the only difference is the transaction is sent directly
through the MockKeystoneForwarder by the deployer EOA rather than by the CRE DON.

```powershell
# BACKUP Steps 2–3: two CRITICAL reports → freeze
$env:SCENARIO="depeg"; $env:COUNT="2"
npx hardhat run scripts/demo-send-report.js --network arbitrumSepolia
Remove-Item Env:SCENARIO, Env:COUNT

# BACKUP Steps 7–8: three STABLE reports → recovery
$env:SCENARIO="stable"; $env:COUNT="3"
npx hardhat run scripts/demo-send-report.js --network arbitrumSepolia
Remove-Item Env:SCENARIO, Env:COUNT
# Then wait recoveryCooldown (1800 s) and run once more:
$env:SCENARIO="stable"
npx hardhat run scripts/demo-send-report.js --network arbitrumSepolia
Remove-Item Env:SCENARIO
```

Steps 1, 4, 5, 6 are unchanged — demo-set-price.js and the override scripts do not use the CRE tool.

---

## 6. What you need to do yourself — ordered steps

### Wallet funding (before any deploy)

Arbitrum Sepolia ETH: get from the Arbitrum Sepolia faucet. Budget 20–25 transactions (5 deploys + wiring + demo).

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

 8. Verify all 5 contracts on Arbiscan (see Section 2f)

 9. Role revocation check — LAST wiring step:
      npx hardhat run scripts/remediate-role-revocation.js --network arbitrumSepolia
      Expected: all three operational roles already revoked ✓

10. Deposit small USDC into the vault (use Arbiscan write tab or a one-off script)

11. Pre-recording checks:
      receiver.forwarder() == 0xd41263567ddfead91504199b8c6c87371e83ca5d  ✓
      vault.paused()       == false                                         ✓
      vault.asset()        == 0x75faf114eafb1BDbe2F0316DF893fd58CE46AA4d   ✓
      module.overrideAuthority(vault) == MockSafe address                   ✓

12. cre login

13. Dry-run to confirm workflow compiles and produces CRITICAL signal:
      Set-Location stableguard-cre\depeg-monitor
      cre workflow simulate . --target=arbitrum-staging-settings
      Set-Location ..\..

--- RECORDING STARTS ---

14. demo-set-price.js → $0.94 (CRITICAL)
15. cre workflow simulate --broadcast × 1  →  WATCH
16. cre workflow simulate --broadcast × 1  →  CONFIRMED_DEPEG + vault freeze
17. demo-place-hold.js                      →  override hold active
18. demo-early-unlock.js                    →  vault.paused() = false (KEY MOMENT)
19. demo-set-price.js → $1.00 (STABLE)
20. cre workflow simulate --broadcast × 3  →  RECOVERY_PENDING (after 3rd stable cycle)
21. Wait 1800 s, then:
    cre workflow simulate --broadcast × 1  →  NORMAL
```

### Pre-demo checklist

- [ ] Deployer wallet funded with Arbitrum Sepolia ETH
- [ ] All 5 core contracts deployed — addresses in `deployments/arbitrum-sepolia.json`
- [ ] All contracts verified on Arbiscan
- [ ] USDC exposure registered (`register-exposure.js`)
- [ ] Demo contracts deployed — addresses in `deployments/arbitrum-sepolia-demo.json`
- [ ] `config.arbitrum-demo.json` `consumerAddress` and `demoFeedAddress` filled in
- [ ] `demo-wire-all.js` completed successfully
- [ ] `remediate-role-revocation.js` reports all three roles revoked ✓
- [ ] Small USDC deposit visible in vault on Arbiscan
- [ ] `receiver.forwarder()` on Arbiscan = `0xd41263567ddfead91504199b8c6c87371e83ca5d`
- [ ] `vault.paused()` = false before recording begins
- [ ] `cre login` completed
- [ ] Dry-run simulate (stub mode) confirmed CRITICAL signal for USDC
