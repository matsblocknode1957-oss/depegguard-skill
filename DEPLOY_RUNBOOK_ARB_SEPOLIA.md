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

This deploys the receiver using `0xd41263567ddfead91504199b8c6c87371e83ca5d` (the MockKeystoneForwarder on Arbitrum Sepolia). The mock forwarder skips signature verification, so any address can call `report()` on it — suitable for the demo scripts but never for production.

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

## 2. Post-deploy role wiring

The deploy script handles all wiring automatically. This section documents what it does and what you need to wire by hand for the optional modules.

### Wiring performed automatically by `deploy-arbitrum-sepolia.js`

| Call | Why |
|---|---|
| `eventRegistry.setHoldLedger(holdLedger)` | Links registry to ledger |
| `eventRegistry.transferController(receiver)` | Grants receiver REPORTER_ROLE + ACTION_ROLE + PAUSE_COORDINATOR_ROLE |
| `eventRegistry.revokeRole(REPORTER_ROLE, deployer)` | Strips deployer of live operational roles |
| `eventRegistry.revokeRole(ACTION_ROLE, deployer)` | Same |
| `eventRegistry.revokeRole(PAUSE_COORDINATOR_ROLE, deployer)` | Same |
| `holdLedger.transferCoordinator(receiver)` | Receiver becomes sole coordinator |
| `vault.grantRole(PAUSE_COORDINATOR_ROLE, receiver)` | Lets receiver call `vault.pause()` |

After the deploy script completes, the deployer must hold no operational roles. Verify:

```powershell
npx hardhat run scripts/remediate-role-revocation.js --network arbitrumSepolia
```

### Register USDC exposure

```powershell
npx hardhat run scripts/register-exposure.js --network arbitrumSepolia
```

The script reads addresses from `deployments/arbitrum-sepolia.json` and verifies the signer matches the recorded deployer. No manual address edits required.

### Deploy optional demo contracts

```powershell
npx hardhat run scripts/deploy-demo-contracts-arbitrum.js --network arbitrumSepolia
```

Deploys MockMorphoVaultV2, MorphoSentinelAdapter, CustomerOverrideModule, TestPriceFeed, and MockSafe. Writes addresses to `deployments/arbitrum-sepolia-demo.json`.

### Wire CustomerOverrideModule (standard freeze path)

```powershell
npx hardhat run scripts/demo-wire-all.js --network arbitrumSepolia
```

Performs all four wiring steps in one shot:

| Call | Purpose |
|---|---|
| `module.setVaultAuthority(vault, mockSafe)` | Binds MockSafe as the override authority for this vault |
| `module.setVaultReceiver(vault, receiver)` | Module calls receiver.executeEarlyUnlock on early unlock |
| `receiver.setOverrideModule(module)` | Enables override path in receiver |
| `holdLedger.approveVaultModule(vault, module)` | Grants module the right to call `releaseByOverride` |

Caller must hold GOVERNANCE_ROLE on StableGuardVault (= original deployer).

### Customer Safe options — MockSafe vs Real Safe

**Option A — MockSafe (recommended for the video demo)**

MockSafe is deployed by `deploy-demo-contracts-arbitrum.js` with the deployer as the only owner. All demo scripts use it automatically. No Safe app, no multisig UX needed during recording.

- `placeHold` and `renewHold`: call directly from the deployer EOA (MockSafe.isOwner(deployer) = true)
- `earlyUnlock`: deployer calls `mockSafe.callEarlyUnlock(module, coin, vault, rootIncidentId)` — msg.sender is the MockSafe contract, satisfying the `overrideAuthority` check
- Scripts: `demo-place-hold.js` and `demo-early-unlock.js` handle both steps automatically

**Option B — Real Gnosis Safe (Arbitrum Sepolia, two wallets)**

1. Create a Safe at app.safe.global on Arbitrum Sepolia. Add both wallet addresses as owners. Set threshold to 1 (for demos) or 2 (realistic multisig).
2. After `deploy-demo-contracts-arbitrum.js`, call `module.setVaultAuthority(vault, <SafeAddress>)` manually or update `demo-wire-all.js` to use your Safe address.
3. `placeHold` / `renewHold`: either wallet owner calls `module.placeHold(coin, vault)` directly (no Safe transaction needed — single-owner call).
4. `earlyUnlock`: go to app.safe.global → New transaction → Contract interaction → `module.earlyUnlock(coin, vault, rootIncidentId)`. Both owners approve (or just one if threshold=1). The Safe contract executes the call, so msg.sender == Safe address == overrideAuthority ✓

**Recommendation**: Use MockSafe (Option A) for the video. It is functionally identical to a real Safe for every security property in scope; the only difference is the multisig UX, which creates dead air during recording. Add a brief voiceover explaining "In production this would be a Gnosis Safe; here we use MockSafe so a single key can demonstrate the full flow."

### MorphoSentinelAdapter wiring (advanced — requires separate demo receiver)

`setMorphoAdapter` authenticates via `vault.owner()`. StableGuardVault uses AccessControl (not Ownable) so `owner()` does not exist on it and `setMorphoAdapter` will revert. For a Morpho-path demo:

1. Deploy a separate demo receiver with `MockMorphoVaultV2` as its vault (the mock vault implements `owner()`).
2. Deploy fresh ExposureRegistry + DepegEventRegistry + ProtectionHoldLedger instances for that receiver (so it can become coordinator without replacing the production receiver).
3. Wire in this order: `setIsSentinel`, `setReceiver`, `registerMarkets`, `registerExposure`, `setMorphoAdapter`.

This is not part of the standard video demo but is documented here for completeness.

### setExpectedWorkflowOwner / setExpectedWorkflowId

Both default to zero after deploy (checks skipped). Leave at zero for the demo. If you obtain a paid CRE deployment:

```powershell
# Call via Hardhat console or a one-off script:
# receiver.setExpectedWorkflowOwner(<DON workflow owner address>)
# receiver.setExpectedWorkflowId(<workflow ID as bytes32>)
```

### Verify all contracts on Arbiscan

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

---

## 3. Demo vault — Morpho path

There is no real Morpho Vault V2 on Arbitrum Sepolia. Use MockMorphoVaultV2 (already in the repo), deployed by `deploy-demo-contracts-arbitrum.js`. It implements every interface that MorphoSentinelAdapter calls and is fully tested. Option B (deploying morpho-org/vault-v2 from source) adds hours of setup for no demo benefit.

---

## 4. CRE workflow — price feed vs stub mode

The workflow (`stableguard-cre/depeg-monitor/main.ts`) reads prices on-chain via `evmClient.callContract` calling `latestRoundData()` on a Chainlink AggregatorV3-compatible feed. No Data Streams credentials are required.

### Stub mode (no chain connection)

`config.arbitrum-staging.json` has `"stubScenario": "depeg"`. When `stubScenario` is set, the workflow uses hardcoded offsets instead of calling any price feed. USDC is forced to 300 bps below peg (CRITICAL). Use this for local simulation:

> **Login required**: `cre workflow simulate` calls the CRE API and requires a valid session.
> Run `cre login` before the commands below, then re-run after logging in.

```powershell
# From stableguard-cre/depeg-monitor:
Set-Location stableguard-cre\depeg-monitor
cre workflow simulate . --target=arbitrum-staging-settings
Set-Location ..\..
```

### Live feed mode

Set `priceFeedAddress` in the config to a real Chainlink USD feed address on Arbitrum Sepolia (or the deployed TestPriceFeed address in `demoFeedAddress` for the demo). Remove or leave `stubScenario` unset.

### Demo mode — TestPriceFeed

The TestPriceFeed contract (`stableguard-cre/contracts/test/TestPriceFeed.sol`) lets you control the price by calling `setPrice()`. The `demoFeedAddress` field in `config.arbitrum-demo.json` takes precedence over `priceFeedAddress` when set.

After deploying TestPriceFeed, to stage a depeg:

```powershell
# $0.94 = 600 bps below peg → CRITICAL
$env:PRICE="94000000"
npx hardhat run scripts/demo-set-price.js --network arbitrumSepolia
Remove-Item Env:PRICE

# Reset to peg ($1.00 → STABLE) after the demo
$env:RESET="1"
npx hardhat run scripts/demo-set-price.js --network arbitrumSepolia
Remove-Item Env:RESET
```

### Broadcasting on-chain (demo receiver)

With the demo receiver (MockKeystoneForwarder), use `demo-send-report.js` — it calls `MockKeystoneForwarder.report(receiver, payload, "0x", [])` which triggers `receiver.onReport` with no signature check.

---

## 5. Demo script — alarm → freeze → customer Safe unlock → recovery

Pre-requisites: `demo-wire-all.js` has been run; small USDC deposit in vault; `vault.paused()` = false.

**Step 1 — Stage the depeg price (TestPriceFeed)**

```powershell
$env:PRICE="94000000"
npx hardhat run scripts/demo-set-price.js --network arbitrumSepolia
Remove-Item Env:PRICE
```

**Step 2 — First CRITICAL report (registry enters WATCH)**

```powershell
$env:SCENARIO="depeg"
npx hardhat run scripts/demo-send-report.js --network arbitrumSepolia
Remove-Item Env:SCENARIO
```

Registry transitions NORMAL → WATCH.

**Step 3 — Second CRITICAL report (CONFIRMED_DEPEG + vault freeze)**

```powershell
$env:SCENARIO="depeg"
npx hardhat run scripts/demo-send-report.js --network arbitrumSepolia
Remove-Item Env:SCENARIO
```

confirmedThreshold=2 → `initiateProtection` fires: hold acquired, vault paused. If CustomerOverrideModule is wired, the hold slot is registered automatically.

**Step 4 — Customer Safe places hold (blocks auto-recovery)**

```powershell
npx hardhat run scripts/demo-place-hold.js --network arbitrumSepolia
```

Any MockSafe owner activates the hold. Auto-recovery is blocked while hold is active.

**Step 5 — Customer Safe early unlock (immediate unfreeze)**

```powershell
npx hardhat run scripts/demo-early-unlock.js --network arbitrumSepolia
```

MockSafe routes the call: `hold released → vault.unpause() → suppression window started`.

**Step 6 — Recovery (3 × STABLE reports)**

```powershell
$env:SCENARIO="stable"
$env:COUNT="3"
npx hardhat run scripts/demo-send-report.js --network arbitrumSepolia
Remove-Item Env:SCENARIO, Env:COUNT
```

After stabilityWin=3 consecutive stable reports, `eventRegistry.finalizeRecovery(eventId)` is callable on the next cycle. Recovery cooldown is 1800 s; the vault is fully released after cooldown.

---

## 6. What you need to do yourself

### Wallet funding

Arbitrum Sepolia ETH: get from the Arbitrum Sepolia faucet. Budget 15–20 transactions (5 deploys + wiring + demo).

Arbitrum Sepolia USDC: Circle USDC testnet faucet or bridge from Ethereum Sepolia. Address: `0x75faf114eafb1BDbe2F0316DF893fd58CE46AA4d`.

### Environment variable names (never paste values)

| Variable | Required for |
|---|---|
| `ARB_SEPOLIA_RPC_URL` | All `--network arbitrumSepolia` commands |
| `CRE_ETH_PRIVATE_KEY` | Deployer private key for all scripts |
| `ARBISCAN_API_KEY` | Contract verification after deploy |
| `USE_DEMO_FORWARDER` | Set to `1` to use MockKeystoneForwarder (demo only) |

### Pre-demo checklist

- [ ] New deployer wallet funded with Arbitrum Sepolia ETH
- [ ] All 5 contracts deployed — addresses recorded in `deployments/arbitrum-sepolia.json`
- [ ] All contracts verified on Arbiscan
- [ ] `remediate-role-revocation.js` reports no residual roles on deployer
- [ ] USDC exposure registered (`register-exposure.js`)
- [ ] Demo contracts deployed (`deploy-demo-contracts-arbitrum.js`) — addresses in `deployments/arbitrum-sepolia-demo.json`
- [ ] `config.arbitrum-demo.json` updated with new receiver address and TestPriceFeed address
- [ ] `demo-wire-all.js` completed successfully (CustomerOverrideModule wired)
- [ ] `receiver.forwarder()` on Arbiscan matches `0xd41263567ddfead91504199b8c6c87371e83ca5d`
- [ ] Small USDC deposit visible in vault on Arbiscan
- [ ] `vault.paused()` = false before recording begins
- [ ] `cre login` completed (for simulate; not needed for demo scripts)
