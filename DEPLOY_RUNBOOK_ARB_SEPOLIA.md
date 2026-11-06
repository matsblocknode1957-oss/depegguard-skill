# StableGuard — Arbitrum Sepolia Redeploy Runbook
## Branch: release/redeploy-bundle | Target: end-to-end demo

---

## 0. Pre-flight

Before running any script:

```
git checkout release/redeploy-bundle
git status          # must be clean (or stash any tmp_* scratch files)
npx hardhat compile # zero errors, zero warnings
npx hardhat test    # all tests pass
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

```
npx hardhat run scripts/deploy-arbitrum-sepolia.js --network arbitrumSepolia
```

This deploys the production receiver using `0x76c9cf548b4179F8901cda1f8623568b58215E62` (the Chainlink Keystone Forwarder on Arbitrum Sepolia, which enforces DON signature verification).

### Demo deploy (MockKeystoneForwarder)

```
USE_DEMO_FORWARDER=1 npx hardhat run scripts/deploy-arbitrum-sepolia.js --network arbitrumSepolia
```

This deploys the receiver using `0xd41263567ddfead91504199b8c6c87371e83ca5d` (the MockKeystoneForwarder on Arbitrum Sepolia). The mock forwarder skips signature verification, so any address can call `onReport` directly — suitable for the demo script but never for production.

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

```
npx hardhat run scripts/remediate-role-revocation.js --network arbitrumSepolia
```

### Register USDC exposure

```
npx hardhat run scripts/register-exposure.js --network arbitrumSepolia
```

The script reads addresses from `deployments/arbitrum-sepolia.json` and verifies the signer matches the recorded deployer. No manual address edits required.

### Deploy optional demo contracts

```
npx hardhat run scripts/deploy-demo-contracts-arbitrum.js --network arbitrumSepolia
```

Deploys MockMorphoVaultV2, MorphoSentinelAdapter, CustomerOverrideModule, and TestPriceFeed. Writes addresses to `deployments/arbitrum-sepolia-demo.json`.

### MorphoSentinelAdapter wiring (after demo deploy)

| Call | Purpose |
|---|---|
| `mockMorphoVault.setIsSentinel(adapter, true)` | Grants adapter sentinel permission |
| `adapter.setReceiver(receiver)` | Locks adapter to your receiver |
| `adapter.registerMarkets(USDC_MAINNET, entries)` | Tells adapter which markets to cap on depeg |
| `exposureRegistry.registerExposure(mockMorphoVault, sym)` | Tells receiver to track this vault for USDC |
| `receiver.setMorphoAdapter(adapter)` | Switches receiver to Morpho path |

### CustomerOverrideModule wiring (after demo deploy)

| Call | Purpose |
|---|---|
| `module.setVaultAuthority(vault, safeAddress)` | Binds a Safe to the vault |
| `module.setVaultReceiver(vault, receiver)` | Tells module which receiver to callback |
| `receiver.setOverrideModule(module)` | Enables override path in receiver |
| `holdLedger.approveModule(vault, module)` | Grants module the right to call `releaseByOverride` |

### setExpectedWorkflowOwner / setExpectedWorkflowId

Both default to zero after deploy (checks skipped). Leave at zero for the demo. If you obtain a paid CRE deployment:

```
receiver.setExpectedWorkflowOwner(<DON workflow owner address>)
receiver.setExpectedWorkflowId(<workflow ID as bytes32>)
```

### Verify all contracts on Arbiscan

```
npx hardhat verify --network arbitrumSepolia <ExposureRegistry>    <deployer>
npx hardhat verify --network arbitrumSepolia <DepegEventRegistry>  <deployer> 1 2 3 86400 3600 1800
npx hardhat verify --network arbitrumSepolia <ProtectionHoldLedger> <deployer> <deployer>
npx hardhat verify --network arbitrumSepolia <StableGuardVault>    0x75faf114eafb1BDbe2F0316DF893fd58CE46AA4d "StableGuard USDC Vault" "sgUSDC" <deployer>
npx hardhat verify --network arbitrumSepolia <StableGuardCREReceiver> <forwarder> <exposureRegistry> <eventRegistry> <vault> 3478487238524512106 <holdLedger> 3600
```

---

## 3. Demo vault — Morpho path

There is no real Morpho Vault V2 on Arbitrum Sepolia. Use MockMorphoVaultV2 (already in the repo), deployed by `deploy-demo-contracts-arbitrum.js`. It implements every interface that MorphoSentinelAdapter calls and is fully tested. Option B (deploying morpho-org/vault-v2 from source) adds hours of setup for no demo benefit.

---

## 4. CRE workflow — price feed vs stub mode

The workflow (`stableguard-cre/depeg-monitor/main.ts`) now reads prices on-chain via `evmClient.callContract` calling `latestRoundData()` on a Chainlink AggregatorV3-compatible feed. No Data Streams credentials are required.

### Stub mode (no chain connection)

`config.arbitrum-staging.json` has `"stubScenario": "depeg"`. When `stubScenario` is set, the workflow uses hardcoded offsets instead of calling any price feed. USDC is forced to 300 bps below peg (CRITICAL) for the depeg scenario. Use this for local simulation:

```
cre workflow simulate stableguard-cre/depeg-monitor --target=arbitrum-staging-settings
```

### Live feed mode

Set `priceFeedAddress` in the config to a real Chainlink USD feed address on Arbitrum Sepolia (or the deployed TestPriceFeed address in `demoFeedAddress` for the demo). Remove or leave `stubScenario` unset.

### Demo mode — TestPriceFeed

The TestPriceFeed contract (`stableguard-cre/contracts/test/TestPriceFeed.sol`) lets you control the price by calling `setPrice()`. The `demoFeedAddress` field in `config.arbitrum-demo.json` takes precedence over `priceFeedAddress` when set.

After deploying TestPriceFeed, to stage a depeg:

```
cast send <TestPriceFeed> "setPrice(int256)" 94000000 --rpc-url $ARB_SEPOLIA_RPC_URL --private-key $CRE_ETH_PRIVATE_KEY
```

This sets price to $0.94 (600 bps below peg → CRITICAL).

### Broadcasting on-chain (demo receiver)

With the demo receiver (MockKeystoneForwarder), you can call `receiver.onReport(metadata, encodedPayload)` directly from the deployer address. The forwarder does not verify signatures, so no DON is required.

---

## 5. Demo script — alarm → freeze → customer Safe unlock → recovery

Pre-requisites: MockMorphoVaultV2 and MorphoSentinelAdapter deployed and wired; small USDC deposit in vault; non-zero cap set on the mock vault.

**Transaction 1 — First CRITICAL report (registry enters WATCH)**

Call `receiver.onReport(metadata, encodedPayload)` with USDC signalLevel=3. Registry transitions NORMAL → WATCH.

**Transaction 2 — Second CRITICAL report (CONFIRMED_DEPEG + freeze)**

Same report again. confirmedThreshold=2, so the second CRITICAL triggers `initiateProtection`: hold acquired, Morpho caps zeroed (or vault paused on the standard path).

**Transaction 3 — Customer Safe early-unlock (optional)**

If CustomerOverrideModule is wired, call `module.placeHold` then `module.earlyUnlock`. The module releases the hold and calls `receiver.executeEarlyUnlock`.

**Transaction 4 — Recovery (3 × STABLE reports)**

Send 3 reports with USDC signalLevel=0. After stabilityWin=3 consecutive stable reports, `eventRegistry.finalizeRecovery(eventId)` becomes callable on the next cycle.

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
- [ ] MockMorphoVaultV2 deployed with non-zero caps and allocation set
- [ ] MorphoSentinelAdapter fully wired (sentinel approved, markets registered, receiver set, morphoAdapter set on receiver)
- [ ] `config.arbitrum-demo.json` updated with new receiver address and TestPriceFeed address
- [ ] Small USDC deposit visible in vault on Arbiscan
- [ ] `receiver.forwarder()` matches the address you plan to call from
- [ ] `vault.paused()` = false before recording begins
