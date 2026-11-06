# Deploy Checklist — StableGuard redeploy bundle

Work through this list top to bottom before and after every production deploy.
Check each item off only when it is confirmed, not when you think it is done.

---

## Pre-deploy

1. Pull the latest `release/redeploy-bundle`; confirm the working tree is clean (`git status`).
2. Run `npx hardhat compile` — zero errors, zero warnings.
3. **Run the full test suite (`npx hardhat test`) — every test must pass before proceeding.**
4. Review every contract diff against the previous deploy tag; confirm no unintended changes slipped in.
5. Confirm `MAINNET_RPC_URL`, `CRE_ETH_PRIVATE_KEY`, and `ARBISCAN_API_KEY` are present in `.env`.
6. Confirm the new deployer wallet has enough ETH on Arbitrum for gas (check Arbiscan balance).
7. Record the new deployer address before running any script; paste it here before continuing.

## Deploy

8. Deploy `ProtectionHoldLedger` — record address.
9. Deploy `DepegEventRegistry` — record address.
10. Deploy `ExposureRegistry` — record address.
11. Deploy `StableGuardCREReceiver` with all constructor args; wire roles immediately after deploy (transferController, transferCoordinator).
12. **Deploy ONLY from the new wallet. Never use the old deployer wallet for anything.**
13. Revoke every operational role (PAUSE_COORDINATOR_ROLE, controller, coordinator) from the deployer address immediately after wiring — the deployer must hold no live role after setup is complete.

## Post-deploy

14. **Verify every contract on Arbiscan after deploying:**
    ```
    npx hardhat verify --network arbitrumSepolia <address> <constructorArg1> ...
    ```
    Repeat for each deployed contract. Confirmed verification links must be recorded before the checklist is considered done.
15. Run the remediation script to confirm zero residual roles remain on the deployer:
    ```
    node scripts/check-deployer-roles.js
    ```
    If any role remains, revoke it before going live.
