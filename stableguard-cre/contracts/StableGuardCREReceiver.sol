// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

interface IExposureRegistry {
    function isExposed(address vault, bytes32 symbol) external view returns (bool);
}

interface IPausable {
    function pause() external;
    function unpause() external;
    function paused() external view returns (bool);
}

interface IDepegEventRegistry {
    enum State {
        WATCH, CONFIRMED_DEPEG, PROTECTION_PENDING, PARTIALLY_PROTECTED,
        PROTECTED, RECOVERY_PENDING, PARTIALLY_RECOVERED,
        NORMAL, EXPIRED, FAILED, SUPERSEDED
    }
    enum DestState { PENDING, COMPLETE, SUPERSEDED, FAILED }
    struct DestinationInput { uint64 chainSelector; address vault; }

    function processReport(address coin, uint8 score, bytes32 evidenceRoot)
        external returns (bytes32 eventId, State resultState);
    function initiateProtection(bytes32 eventId, DestinationInput[] calldata dests) external;
    function destinationCallback(bytes32 eventId, uint256 destIndex, DestState newDestState) external;
    function resumeProtectionTracking(
        address coin,
        bytes32 evidenceRoot,
        DestinationInput[] calldata dests,
        bytes32 expiredEventId,
        bytes32 holdId
    ) external returns (bytes32 eventId);
    function finalizeRecovery(bytes32 eventId) external;
}

interface IProtectionHoldLedger {
    function acquire(address vault, bytes32 rootIncidentId, bytes32 assetId)
        external returns (bytes32 holdId);
    function release(bytes32 holdId) external returns (bool vaultFullyReleased);
}

/**
 * StableGuardCREReceiver
 *
 * Receives ABI-encoded depeg reports from the StableGuard CRE workflow via
 * the KeystoneForwarder. Decodes and stores the latest composite signal state,
 * emitting events for offchain indexers, then drives the DepegEventRegistry
 * state machine and executes an exposure-gated vault pause.
 *
 * Per-coin call sequence in onReport() (each call independently try/caught):
 *   1. eventRegistry.processReport   — advance state machine
 *   2. eventRegistry.initiateProtection — only when state → CONFIRMED_DEPEG
 *   3. vault.pause()                 — exposure-gated; outcome captured in bool
 *   4. holdLedger.acquire()          — record hold identity after successful pause
 *   5. eventRegistry.destinationCallback(COMPLETE | FAILED) — honest result
 *
 * Constructor args:
 *   forwarder         Broadcast simulation : 0x15fC6ae953E024d975e77382eEeC56A9101f9F88
 *                     Production           : 0xF8344CFd5c43616a4366C34E3EEE75af79a74482
 *   exposureRegistry  ExposureRegistry that gates which vault/symbol pairs are tracked
 *   eventRegistry     DepegEventRegistry (must transferController to this address after deploy)
 *   vault             Target vault to pause on confirmed depeg
 *   localChainSelector CCIP chain selector for the local chain (used as destination ID)
 *   holdLedger        ProtectionHoldLedger (must transferCoordinator to this address after deploy)
 */
contract StableGuardCREReceiver {
    address                public immutable forwarder;
    IExposureRegistry      public immutable exposureRegistry;
    IDepegEventRegistry    public immutable eventRegistry;
    address                public immutable vault;
    uint64                 public immutable localChainSelector;
    IProtectionHoldLedger  public immutable holdLedger;

    uint8   public lastCompositeScore;
    uint8   public lastMarketStress;
    uint256 public lastObservedAt;
    uint256 public reportCount;

    // Per-coin hold tracking for lineage proof on resumeProtectionTracking
    mapping(address => bytes32) private _coinHoldId;   // coin => active holdId (0 = none)
    mapping(address => bytes32) private _lastEventId;  // coin => last non-zero eventId seen

    struct CoinSignal {
        address coin;
        uint256 price;
        uint256 deviationBps;
        uint8   signalLevel;
    }

    CoinSignal[] public lastCoins;

    event DepegReport(
        uint256 indexed reportIndex,
        uint8   compositeScore,
        uint8   marketStress,
        uint256 observedAt
    );

    event CoinAlert(
        uint256 indexed reportIndex,
        address indexed coin,
        uint256 deviationBps,
        uint8   signalLevel
    );

    // TODO (ops): index and alert on this event before production deployment.
    // A forgotten ExposureRegistry.registerExposure() call will silently skip
    // the pause for that coin — this event is the only on-chain signal of that gap.
    event VaultExposureMissing(address indexed vault, bytes32 indexed symbol);

    event RegistryUpdateFailed(address indexed coin, bytes reason);
    event VaultPauseFailed(address indexed vault, bytes32 indexed symbol, bytes reason);
    event VaultUnpauseFailed(address indexed vault, bytes32 indexed symbol, bytes reason);
    event RegistryCallbackFailed(bytes32 indexed eventId, address indexed coin, bytes reason);
    event RecoveryResumeFailed(address indexed coin, bytes reason);

    error UnauthorizedForwarder(address caller);

    constructor(
        address _forwarder,
        address _exposureRegistry,
        address _eventRegistry,
        address _vault,
        uint64  _localChainSelector,
        address _holdLedger
    ) {
        forwarder           = _forwarder;
        exposureRegistry    = IExposureRegistry(_exposureRegistry);
        eventRegistry       = IDepegEventRegistry(_eventRegistry);
        vault               = _vault;
        localChainSelector  = _localChainSelector;
        holdLedger          = IProtectionHoldLedger(_holdLedger);
    }

    function onReport(bytes calldata metadata, bytes calldata report) external {
        if (msg.sender != forwarder) revert UnauthorizedForwarder(msg.sender);
        // metadata intentionally unused — forwarder check is the access control boundary

        (
            address[] memory coins,
            uint256[] memory prices,
            uint256[] memory deviationsBps,
            uint8[]   memory signalLevels,
            bytes[]   memory fullReports,   // decoded but not stored (gas efficiency)
            uint8  compositeScore,
            uint8  marketStress,
            uint256 observedAt
        ) = abi.decode(
            report,
            (address[], uint256[], uint256[], uint8[], bytes[], uint8, uint8, uint256)
        );

        // suppress unused-var warning for fullReports
        fullReports;

        uint256 idx = reportCount++;
        lastCompositeScore = compositeScore;
        lastMarketStress   = marketStress;
        lastObservedAt     = observedAt;

        delete lastCoins;
        for (uint256 i = 0; i < coins.length; i++) {
            lastCoins.push(CoinSignal({
                coin:         coins[i],
                price:        prices[i],
                deviationBps: deviationsBps[i],
                signalLevel:  signalLevels[i]
            }));
            if (signalLevels[i] >= 1) {
                emit CoinAlert(idx, coins[i], deviationsBps[i], signalLevels[i]);
            }
        }

        emit DepegReport(idx, compositeScore, marketStress, observedAt);

        for (uint256 i = 0; i < coins.length; i++) {
            address coin  = coins[i];
            uint8   level = signalLevels[i];

            // Call 1: advance state machine; skip this coin on any registry failure
            bytes32 eventId;
            IDepegEventRegistry.State newState;
            try eventRegistry.processReport(coin, level, bytes32(0))
                returns (bytes32 _eventId, IDepegEventRegistry.State _newState)
            {
                eventId  = _eventId;
                newState = _newState;
            } catch (bytes memory reason) {
                emit RegistryUpdateFailed(coin, reason);
                continue;
            }

            // Track the last non-zero eventId per coin for resumeProtectionTracking lineage
            if (eventId != bytes32(0)) _lastEventId[coin] = eventId;

            bytes32 sym = bytes32(uint256(uint160(coin)));

            // ── Auto-recovery: vault unpause ──────────────────────────────────────
            // Fires when processReport transitions PROTECTED → RECOVERY_PENDING,
            // and on subsequent cycles until the destination slot is settled.
            if (newState == IDepegEventRegistry.State.RECOVERY_PENDING) {
                if (IPausable(vault).paused()) {
                    // Release the protection hold before unpausing
                    bytes32 hId = _coinHoldId[coin];
                    if (hId != bytes32(0)) {
                        try holdLedger.release(hId) { _coinHoldId[coin] = bytes32(0); } catch { }
                    }

                    bool unpaused = false;
                    try IPausable(vault).unpause() {
                        unpaused = true;
                    } catch (bytes memory reason) {
                        emit VaultUnpauseFailed(vault, sym, reason);
                    }
                    IDepegEventRegistry.DestState cbState = unpaused
                        ? IDepegEventRegistry.DestState.COMPLETE
                        : IDepegEventRegistry.DestState.FAILED;
                    try eventRegistry.destinationCallback(eventId, 0, cbState) { }
                    catch (bytes memory reason) {
                        emit RegistryCallbackFailed(eventId, coin, reason);
                    }
                }
                // Permissionless; silent if cooldown not yet elapsed
                try eventRegistry.finalizeRecovery(eventId) { } catch { }
                continue;
            }

            // ── Recovery continuation: re-open tracking on paused vault ───────────
            // Fires when the prior PROTECTED event expired before stableCount
            // reached stabilityWindow. The vault is still paused and needs
            // a fresh PROTECTED event to re-arm auto-recovery.
            if (eventId == bytes32(0) && IPausable(vault).paused()) {
                IDepegEventRegistry.DestinationInput[] memory resumeDests =
                    new IDepegEventRegistry.DestinationInput[](1);
                resumeDests[0] = IDepegEventRegistry.DestinationInput({
                    chainSelector: localChainSelector,
                    vault:         vault
                });
                try eventRegistry.resumeProtectionTracking(
                    coin, bytes32(0), resumeDests,
                    _lastEventId[coin], _coinHoldId[coin]
                ) { }
                catch (bytes memory reason) {
                    emit RecoveryResumeFailed(coin, reason);
                }
                continue;
            }

            if (newState != IDepegEventRegistry.State.CONFIRMED_DEPEG) continue;

            // Exposure gate: only protect vaults that demonstrably hold the asset
            if (!exposureRegistry.isExposed(vault, sym)) {
                emit VaultExposureMissing(vault, sym);
                continue;
            }

            // Call 2: CONFIRMED_DEPEG → PROTECTION_PENDING; silent catch (may already
            // be in-flight if a previous cycle fired before this callback arrived)
            IDepegEventRegistry.DestinationInput[] memory dests =
                new IDepegEventRegistry.DestinationInput[](1);
            dests[0] = IDepegEventRegistry.DestinationInput({
                chainSelector: localChainSelector,
                vault:         vault
            });
            try eventRegistry.initiateProtection(eventId, dests) {
                // fall through to pause
            } catch {
                continue;
            }

            // Call 3: pause vault; capture outcome so Call 4 reports honestly
            bool pauseResult = false;
            try IPausable(vault).pause() {
                pauseResult = true;
            } catch (bytes memory reason) {
                emit VaultPauseFailed(vault, sym, reason);
            }

            // Call 4: acquire hold after successful pause (eventId == rootIncidentId for new events)
            if (pauseResult) {
                try holdLedger.acquire(vault, bytes32(eventId), sym)
                    returns (bytes32 hId)
                {
                    _coinHoldId[coin] = hId;
                } catch { }
            }

            // Call 5: close the destination slot with the honest result
            IDepegEventRegistry.DestState dcState = pauseResult
                ? IDepegEventRegistry.DestState.COMPLETE
                : IDepegEventRegistry.DestState.FAILED;
            try eventRegistry.destinationCallback(eventId, 0, dcState) {
                // ack
            } catch (bytes memory reason) {
                emit RegistryCallbackFailed(eventId, coin, reason);
            }
        }
    }

    function getLastCoins() external view returns (CoinSignal[] memory) {
        return lastCoins;
    }
}
