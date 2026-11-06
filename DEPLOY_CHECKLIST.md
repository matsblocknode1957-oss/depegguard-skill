# Deploy Checklist — StableGuard redeploy bundle

Work through this list top to bottom before and after every production deploy.
Check each item off only when it is confirmed, not when you think it is done.

---

## Pre-deploy

1. Pull the latest `release/redeploy-bundle`; confirm the working tree is clean (`git status`).
2. Run `npx hardhat compile` — zero errors, zero warnings.
3. **Run the full test suite (`npx hardhat test`) — every test must pass before proceeding.**
4. Review every contract diff against the previous deploy tag; confirm no unintended changes slipped in.
5. Confirm `ARB_SEPOLIA_RPC_URL`, `CRE_ETH_PRIVATE_KEY`, and `ARBISCAN_API_KEY` are present in `.env`.
6. Confirm the new deployer wallet has enough ETH on Arbitrum Sepolia for gas (check Arbiscan balance).
7. Record the new deployer address before running any script; paste it here before continuing.

## Deploy

The main deploy script deploys all five contracts in dependency order and writes
`deployments/arbitrum-sepolia.json`:

```
npx hardhat run scripts/deploy-arbitrum-sepolia.js --network arbitrumSepolia
```

Contracts are deployed in this order (do NOT reorder — later contracts take earlier ones as constructor args):

8.  Deploy `ExposureRegistry` — record address.
9.  Deploy `DepegEventRegistry` — record address.
10. Deploy `ProtectionHoldLedger` — record address.
11. Deploy `StableGuardVault` — record address.
12. Deploy `StableGuardCREReceiver` with all constructor args; the script wires roles immediately.
13. **Deploy ONLY from the new wallet. Never use the old deployer wallet for anything.**
14. Revoke every operational role (PAUSE_COORDINATOR_ROLE, controller, coordinator) from the deployer
    immediately after wiring — the deployer must hold no live role after setup is complete.
    The deploy script does this automatically; verify with the remediation script below.

> **DEMO vs PRODUCTION forwarder:**  
> The deploy script defaults to the production Keystone Forwarder  
> `0x76c9cf548b4179F8901cda1f8623568b58215E62` (verifies DON signatures).  
> For the demo receiver, set `USE_DEMO_FORWARDER=1` in `.env` to use the  
> MockKeystoneForwarder `0xd41263567ddfead91504199b8c6c87371e83ca5d` instead.  
> **WARNING: MockKeystoneForwarder does NOT verify signatures. Never use for production.**

## Post-deploy

15. **Verify every contract on Arbiscan after deploying:**
    ```
    npx hardhat verify --network arbitrumSepolia <address> <constructorArg1> ...
    ```
    Repeat for each deployed contract. Confirmed verification links must be recorded before the checklist is considered done.

16. Run the remediation script to confirm zero residual roles remain on the deployer:
    ```
    npx hardhat run scripts/remediate-role-revocation.js --network arbitrumSepolia
    ```
    If any role remains, revoke it before going live.

17. Register USDC exposure:
    ```
    npx hardhat run scripts/register-exposure.js --network arbitrumSepolia
    ```

18. (Optional demo) Deploy demo contracts (MockMorphoVaultV2, MorphoSentinelAdapter, CustomerOverrideModule, TestPriceFeed):
    ```
    npx hardhat run scripts/deploy-demo-contracts-arbitrum.js --network arbitrumSepolia
    ```
    Then wire them per DEPLOY_RUNBOOK_ARB_SEPOLIA.md §2.
