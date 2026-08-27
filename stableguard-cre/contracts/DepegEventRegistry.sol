// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

/// @title  DepegEventRegistry
/// @notice Forward-only state machine tracking per-coin depeg lifecycle.
///
///   Score-driven path (processReport):
///     WATCH ──────────────────────────────────────────────────────► NORMAL
///       └─(score≥confirmed)─► CONFIRMED_DEPEG ──(score<watch)─────► NORMAL
///
///   Action-driven path (explicit controller calls + DC callbacks):
///     CONFIRMED_DEPEG
///       └─(initiateProtection)─► PROTECTION_PENDING
///                                  ├─(allSettled, all complete)──────────► PROTECTED
///                                  ├─(allSettled, partial complete)───────► PARTIALLY_PROTECTED
///                                  └─(allSettled, none complete)──────────► FAILED  [terminal]
///                                        PARTIALLY_PROTECTED
///                                          └─(retry+DC, all complete)──────► PROTECTED
///                                        PROTECTED
///                                          ├─(initiateRecovery)─────────────────────────────────────► RECOVERY_PENDING
///                                          └─(processReport×stabilityWindow stable)─[auto-recovery]─► RECOVERY_PENDING
///                                                                   ├─(allSettled+cooldown, all)─► NORMAL [terminal]
///                                                                   ├─(allSettled, partial)──────► PARTIALLY_RECOVERED
///                                                                   └─(allSettled, none)─────────► FAILED  [terminal]
///                                                                         PARTIALLY_RECOVERED
///                                                                           └─(retry+DC, all+cooldown)─► NORMAL
///
///   Any non-terminal state → EXPIRED  when  block.timestamp ≥ createdAt + eventTTL  (highest priority)
///   PROTECTION_PENDING / RECOVERY_PENDING → FAILED  when  pendingTTL elapsed
///   WATCH / CONFIRMED_DEPEG → SUPERSEDED  via  supersede()  (blocked at PROTECTION_PENDING and beyond)
interface IProtectionHoldLedger {
    struct ProtectionHold {
        bytes32 holdId;
        bytes32 rootIncidentId;
        bytes32 assetId;
        address vault;
        bool    active;
    }
    function getHold(bytes32 holdId) external view returns (ProtectionHold memory);
}

contract DepegEventRegistry {

    // ── Enums ─────────────────────────────────────────────────────────────────

    enum State {
        WATCH,               // 0  active
        CONFIRMED_DEPEG,     // 1  active
        PROTECTION_PENDING,  // 2  active – CCIP protection in-flight
        PARTIALLY_PROTECTED, // 3  active – some destinations confirmed, retries pending
        PROTECTED,           // 4  active – ALL effective destinations confirmed protected
        RECOVERY_PENDING,    // 5  active – CCIP recovery in-flight
        PARTIALLY_RECOVERED, // 6  active – some destinations confirmed recovered
        NORMAL,              // 7  terminal – full recovery confirmed
        EXPIRED,             // 8  terminal – event TTL elapsed
        FAILED,              // 9  terminal – action exhausted with zero completions
        SUPERSEDED           // 10 terminal – explicit edge-case cleanup
    }

    enum DestState {
        PENDING,    // 0 – CCIP message in-flight
        COMPLETE,   // 1 – delivery confirmed  (sticky: DC cannot overwrite)
        SUPERSEDED, // 2 – destination no longer relevant
        FAILED      // 3 – delivery failed
    }

    // ── Structs ───────────────────────────────────────────────────────────────

    struct Destination {
        uint64    chainSelector;
        address   vault;
        DestState state;
    }

    struct DestinationInput {
        uint64  chainSelector;
        address vault;
    }

    struct DepegEvent {
        address       coin;
        bytes32       rootIncidentId; // set once at _create(); links resumptions back to the originating incident
        State         state;
        uint8         compositeScore;
        uint8         stableCount;    // consecutive stable reports while PROTECTED; hard-reset on any non-stable
        bytes32       evidenceRoot;
        uint256       createdAt;
        uint256       observedAt;
        uint256       protectionInitiatedAt; // 0 until PROTECTION_PENDING
        uint256       recoveryInitiatedAt;   // 0 until RECOVERY_PENDING
        Destination[] destinations;
    }

    // ── Immutables ────────────────────────────────────────────────────────────

    uint8   public immutable watchThreshold;      // min score to open a WATCH event
    uint8   public immutable confirmedThreshold;  // score for WATCH → CONFIRMED_DEPEG
    uint8   public immutable stabilityWindow;     // consecutive stable reports required for auto-recovery
    uint256 public immutable eventTTL;            // outer TTL for the entire event
    uint256 public immutable pendingTTL;          // TTL for PROTECTION_PENDING / RECOVERY_PENDING only
    uint256 public immutable recoveryCooldown;    // min time in RECOVERY_PENDING before NORMAL allowed

    // ── Storage ───────────────────────────────────────────────────────────────

    // Mutable: deployer bootstraps with itself then calls transferController(receiver)
    // once StableGuardCREReceiver is deployed (chicken-and-egg resolution).
    address public controller;
    IProtectionHoldLedger public holdLedger;
    mapping(bytes32 => DepegEvent) private _events;

    /// Lookup table: coinKey → currently active (non-terminal) eventId.
    /// Cleared on any terminal transition. Set on event creation.
    mapping(bytes32 => bytes32) public activeEventId;

    uint256 private _nonce;

    // ── Events ────────────────────────────────────────────────────────────────

    event EventCreated(bytes32 indexed eventId, address indexed coin, uint8 score);
    event EventExtended(bytes32 indexed eventId, address indexed coin, uint8 score);
    event EventAdvanced(bytes32 indexed eventId, address indexed coin, State from, State to);
    event EventTerminated(bytes32 indexed eventId, address indexed coin, State terminal);
    event ProtectionInitiated(bytes32 indexed eventId, address indexed coin, uint256 destCount);
    event RecoveryInitiated(bytes32 indexed eventId, address indexed coin, uint256 destCount);
    event RecoveryTrackingResumed(bytes32 indexed eventId, address indexed coin, uint256 destCount);
    event DestinationUpdated(bytes32 indexed eventId, uint256 indexed destIndex, DestState newState);
    event ControllerTransferred(address indexed oldController, address indexed newController);

    // ── Errors ────────────────────────────────────────────────────────────────

    error Unauthorized();
    error ZeroAddress();
    error EventNotFound();
    error AlreadyTerminal();
    error InvalidTransition(State current);
    error CannotSupersede(State current);
    error NoDestinations();
    error DestinationIndexOutOfRange(uint256 index);
    error DestinationNotPending(uint256 index, DestState current);
    error DestinationNotFailed(uint256 index, DestState current);
    error NotYetExpired();
    error PendingNotTimedOut();
    error RecoveryConditionsNotMet();
    error HoldLedgerNotSet();
    error HoldInactive(bytes32 holdId);
    error HoldVaultMismatch(bytes32 holdId, address holdVault, address resumeVault);
    error HoldAssetMismatch(bytes32 holdId, bytes32 holdAsset, bytes32 coinAsset);
    error HoldIncidentMismatch(bytes32 holdId, bytes32 holdRoot, bytes32 eventRoot);
    error EventAssetMismatch(bytes32 eventId, address expected, address got);
    error NotTerminalContinuable(bytes32 eventId, State state);

    // ── Constructor ───────────────────────────────────────────────────────────

    constructor(
        address _controller,
        uint8   _watchThreshold,
        uint8   _confirmedThreshold,
        uint8   _stabilityWindow,
        uint256 _eventTTL,
        uint256 _pendingTTL,
        uint256 _recoveryCooldown
    ) {
        controller         = _controller;
        watchThreshold     = _watchThreshold;
        confirmedThreshold = _confirmedThreshold;
        stabilityWindow    = _stabilityWindow;
        eventTTL           = _eventTTL;
        pendingTTL         = _pendingTTL;
        recoveryCooldown   = _recoveryCooldown;
    }

    // ── transferController ────────────────────────────────────────────────────

    /// @notice Transfer the controller role. Used post-deployment to hand control
    ///         to StableGuardCREReceiver once its address is known.
    function transferController(address newController) external {
        if (msg.sender != controller) revert Unauthorized();
        if (newController == address(0)) revert ZeroAddress();
        address old = controller;
        controller = newController;
        emit ControllerTransferred(old, newController);
    }

    // ── setHoldLedger ─────────────────────────────────────────────────────────

    function setHoldLedger(address newHoldLedger) external {
        if (msg.sender != controller) revert Unauthorized();
        if (newHoldLedger == address(0)) revert ZeroAddress();
        holdLedger = IProtectionHoldLedger(newHoldLedger);
    }

    // ── processReport ─────────────────────────────────────────────────────────

    /// @notice Update a coin's depeg score. Lookup-before-create: extends the
    ///         active event if non-terminal, mints a new WATCH event otherwise.
    ///         Score-driven transitions (G2–G4) apply only to WATCH and
    ///         CONFIRMED_DEPEG; all later states require explicit action calls.
    function processReport(
        address coin,
        uint8   score,
        bytes32 evidenceRoot
    ) external returns (bytes32 eventId, State resultState) {
        if (msg.sender != controller) revert Unauthorized();

        bytes32 coinKey  = keccak256(abi.encode(coin));
        bytes32 activeId = activeEventId[coinKey];
        bool    hasActive = activeId != bytes32(0) && !_isTerminal(_events[activeId].state);

        if (hasActive) {
            eventId = activeId;
            _extend(eventId, score, evidenceRoot);
        } else if (score >= watchThreshold) {
            eventId = _create(coinKey, coin, score, evidenceRoot);
        } else {
            return (bytes32(0), State.NORMAL);
        }

        resultState = _applyScoreTransitions(eventId, coinKey, score);
    }

    // ── initiateProtection ────────────────────────────────────────────────────

    /// @notice G5: CONFIRMED_DEPEG → PROTECTION_PENDING.
    ///         Called by the controller after dispatching CCIP protection messages.
    ///         Resets the destinations array to the provided list, all PENDING.
    function initiateProtection(
        bytes32                     eventId,
        DestinationInput[] calldata dests
    ) external {
        if (msg.sender != controller) revert Unauthorized();
        if (dests.length == 0)        revert NoDestinations();

        DepegEvent storage ev = _events[eventId];
        _requireExists(ev);
        _requireNonTerminal(ev);
        if (ev.state != State.CONFIRMED_DEPEG) revert InvalidTransition(ev.state);

        bytes32 coinKey = keccak256(abi.encode(ev.coin));
        if (block.timestamp >= ev.createdAt + eventTTL) {
            _terminate(eventId, coinKey, State.EXPIRED);
            return;
        }

        ev.state                 = State.PROTECTION_PENDING;
        ev.protectionInitiatedAt = block.timestamp;
        delete ev.destinations;
        for (uint256 i; i < dests.length; ) {
            ev.destinations.push(Destination({
                chainSelector: dests[i].chainSelector,
                vault:         dests[i].vault,
                state:         DestState.PENDING
            }));
            unchecked { ++i; }
        }

        emit EventAdvanced(eventId, ev.coin, State.CONFIRMED_DEPEG, State.PROTECTION_PENDING);
        emit ProtectionInitiated(eventId, ev.coin, dests.length);
    }

    // ── destinationCallback ───────────────────────────────────────────────────

    /// @notice Update one destination slot and re-evaluate aggregate state.
    ///
    ///         DG1–DG3: the slot MUST be PENDING; any other current state reverts
    ///         DestinationNotPending. COMPLETE is therefore structurally sticky —
    ///         a duplicate, stale, or reordered callback cannot overwrite it.
    ///
    ///         Valid in: PROTECTION_PENDING, PARTIALLY_PROTECTED,
    ///                   RECOVERY_PENDING, PARTIALLY_RECOVERED.
    function destinationCallback(
        bytes32   eventId,
        uint256   destIndex,
        DestState newDestState
    ) external {
        if (msg.sender != controller) revert Unauthorized();

        DepegEvent storage ev = _events[eventId];
        _requireExists(ev);
        _requireNonTerminal(ev);

        bytes32 coinKey = keccak256(abi.encode(ev.coin));

        // G13: event TTL always wins
        if (block.timestamp >= ev.createdAt + eventTTL) {
            _terminate(eventId, coinKey, State.EXPIRED);
            return;
        }

        bool isProtecting = ev.state == State.PROTECTION_PENDING || ev.state == State.PARTIALLY_PROTECTED;
        bool isRecovering  = ev.state == State.RECOVERY_PENDING   || ev.state == State.PARTIALLY_RECOVERED;
        if (!isProtecting && !isRecovering) revert InvalidTransition(ev.state);

        // G8: pendingTTL applies to PROTECTION_PENDING only (not PARTIALLY_PROTECTED)
        if (ev.state == State.PROTECTION_PENDING &&
            block.timestamp >= ev.protectionInitiatedAt + pendingTTL) {
            _terminate(eventId, coinKey, State.FAILED);
            return;
        }
        // G12: pendingTTL applies to RECOVERY_PENDING only (not PARTIALLY_RECOVERED)
        if (ev.state == State.RECOVERY_PENDING &&
            block.timestamp >= ev.recoveryInitiatedAt + pendingTTL) {
            _terminate(eventId, coinKey, State.FAILED);
            return;
        }

        // DG1/DG2/DG2b/DG3: slot must be PENDING
        if (destIndex >= ev.destinations.length) revert DestinationIndexOutOfRange(destIndex);
        DestState cur = ev.destinations[destIndex].state;
        if (cur != DestState.PENDING) revert DestinationNotPending(destIndex, cur);

        ev.destinations[destIndex].state = newDestState;
        emit DestinationUpdated(eventId, destIndex, newDestState);

        if (isProtecting) {
            _evaluateProtection(eventId, coinKey);
        } else {
            _evaluateRecovery(eventId, coinKey);
        }
    }

    // ── initiateRecovery ──────────────────────────────────────────────────────

    /// @notice G9: PROTECTED → RECOVERY_PENDING.
    function initiateRecovery(
        bytes32                     eventId,
        DestinationInput[] calldata dests
    ) external {
        if (msg.sender != controller) revert Unauthorized();
        if (dests.length == 0)        revert NoDestinations();

        DepegEvent storage ev = _events[eventId];
        _requireExists(ev);
        _requireNonTerminal(ev);
        if (ev.state != State.PROTECTED) revert InvalidTransition(ev.state);

        bytes32 coinKey = keccak256(abi.encode(ev.coin));
        if (block.timestamp >= ev.createdAt + eventTTL) {
            _terminate(eventId, coinKey, State.EXPIRED);
            return;
        }

        ev.state               = State.RECOVERY_PENDING;
        ev.recoveryInitiatedAt = block.timestamp;
        delete ev.destinations;
        for (uint256 i; i < dests.length; ) {
            ev.destinations.push(Destination({
                chainSelector: dests[i].chainSelector,
                vault:         dests[i].vault,
                state:         DestState.PENDING
            }));
            unchecked { ++i; }
        }

        emit EventAdvanced(eventId, ev.coin, State.PROTECTED, State.RECOVERY_PENDING);
        emit RecoveryInitiated(eventId, ev.coin, dests.length);
    }

    // ── resumeProtectionTracking ──────────────────────────────────────────────

    /// @notice Creates a new PROTECTED-state event for a coin whose prior PROTECTED
    ///         event expired before auto-recovery could fire, while the vault remains
    ///         physically paused. Requires explicit lineage proof via six checks:
    ///         (1) hold active, (2) hold vault matches destination, (3) hold asset
    ///         matches coin, (4) hold and expired event share rootIncidentId,
    ///         (5) expired event coin matches coin param, (6) expired event is EXPIRED
    ///         (not FAILED, SUPERSEDED, or NORMAL).
    function resumeProtectionTracking(
        address                     coin,
        bytes32                     evidenceRoot,
        DestinationInput[] calldata dests,
        bytes32                     expiredEventId,
        bytes32                     holdId
    ) external returns (bytes32 eventId) {
        if (msg.sender != controller) revert Unauthorized();
        if (dests.length == 0)        revert NoDestinations();
        if (address(holdLedger) == address(0)) revert HoldLedgerNotSet();

        // Guard: no active non-terminal event for this coin
        bytes32 coinKey  = keccak256(abi.encode(coin));
        bytes32 activeId = activeEventId[coinKey];
        if (activeId != bytes32(0) && !_isTerminal(_events[activeId].state)) {
            revert InvalidTransition(_events[activeId].state);
        }

        // ── Six lineage checks ───────────────────────────────────────────────

        IProtectionHoldLedger.ProtectionHold memory hold = holdLedger.getHold(holdId);

        // Check 1: hold must still be active
        if (!hold.active) revert HoldInactive(holdId);

        // Check 2: hold belongs to the vault being resumed
        address resumeVault = dests[0].vault;
        if (hold.vault != resumeVault)
            revert HoldVaultMismatch(holdId, hold.vault, resumeVault);

        // Check 3: hold covers this specific asset
        bytes32 assetId = bytes32(uint256(uint160(coin)));
        if (hold.assetId != assetId)
            revert HoldAssetMismatch(holdId, hold.assetId, assetId);

        DepegEvent storage parentEv = _events[expiredEventId];
        _requireExists(parentEv);

        // Check 4: hold and expired event share the same originating incident
        if (hold.rootIncidentId != parentEv.rootIncidentId)
            revert HoldIncidentMismatch(holdId, hold.rootIncidentId, parentEv.rootIncidentId);

        // Check 5: expired event was tracking this same coin (independent belt-and-suspenders)
        if (parentEv.coin != coin)
            revert EventAssetMismatch(expiredEventId, coin, parentEv.coin);

        // Check 6: parent must be EXPIRED — FAILED, SUPERSEDED, and NORMAL are not continuable
        if (!_isTerminalContinuable(parentEv.state))
            revert NotTerminalContinuable(expiredEventId, parentEv.state);

        // ── Create successor PROTECTED event, inheriting the incident root ──

        eventId = keccak256(abi.encode(coin, block.timestamp, ++_nonce));
        DepegEvent storage ev = _events[eventId];
        ev.coin                  = coin;
        ev.rootIncidentId        = parentEv.rootIncidentId; // inherit from expired parent
        ev.state                 = State.PROTECTED;
        ev.compositeScore        = 0;
        ev.evidenceRoot          = evidenceRoot;
        ev.createdAt             = block.timestamp;
        ev.observedAt            = block.timestamp;
        ev.protectionInitiatedAt = block.timestamp;

        for (uint256 i; i < dests.length; ) {
            ev.destinations.push(Destination({
                chainSelector: dests[i].chainSelector,
                vault:         dests[i].vault,
                state:         DestState.COMPLETE   // protection already confirmed
            }));
            unchecked { ++i; }
        }

        activeEventId[coinKey] = eventId;
        emit RecoveryTrackingResumed(eventId, coin, dests.length);
    }

    // ── retryFailedDestinations ───────────────────────────────────────────────

    /// @notice DG4/DG5: re-mark specific FAILED destinations as PENDING for retry.
    ///         Only valid from PARTIALLY_PROTECTED or PARTIALLY_RECOVERED.
    ///         COMPLETE and SUPERSEDED slots are untouchable (DG5 reverts on them).
    function retryFailedDestinations(
        bytes32            eventId,
        uint256[] calldata destIndices
    ) external {
        if (msg.sender != controller) revert Unauthorized();

        DepegEvent storage ev = _events[eventId];
        _requireExists(ev);
        _requireNonTerminal(ev);
        if (ev.state != State.PARTIALLY_PROTECTED && ev.state != State.PARTIALLY_RECOVERED)
            revert InvalidTransition(ev.state);

        for (uint256 i; i < destIndices.length; ) {
            uint256   idx = destIndices[i];
            if (idx >= ev.destinations.length) revert DestinationIndexOutOfRange(idx);
            DestState cur = ev.destinations[idx].state;
            if (cur != DestState.FAILED) revert DestinationNotFailed(idx, cur);
            ev.destinations[idx].state = DestState.PENDING;
            unchecked { ++i; }
        }
    }

    // ── finalizeRecovery ──────────────────────────────────────────────────────

    /// @notice Permissionless: advance RECOVERY_PENDING or PARTIALLY_RECOVERED to
    ///         NORMAL once all effective destinations are COMPLETE and the cooldown
    ///         has elapsed. Called by keepers when DC confirmed all destinations but
    ///         the cooldown had not yet elapsed at DC time.
    function finalizeRecovery(bytes32 eventId) external {
        DepegEvent storage ev = _events[eventId];
        _requireExists(ev);
        _requireNonTerminal(ev);
        if (ev.state != State.RECOVERY_PENDING && ev.state != State.PARTIALLY_RECOVERED)
            revert InvalidTransition(ev.state);

        (bool allSettled, uint256 completeCount, uint256 total, uint256 supersededCount) = _destStats(eventId);
        uint256 effectiveTotal = total - supersededCount;

        if (!allSettled || effectiveTotal == 0 || completeCount < effectiveTotal)
            revert RecoveryConditionsNotMet();
        if (block.timestamp < ev.recoveryInitiatedAt + recoveryCooldown)
            revert RecoveryConditionsNotMet();

        bytes32 coinKey = keccak256(abi.encode(ev.coin));
        _terminate(eventId, coinKey, State.NORMAL);
    }

    // ── supersede ─────────────────────────────────────────────────────────────

    /// @notice G14: terminate WATCH or CONFIRMED_DEPEG as SUPERSEDED.
    ///         Hard-reverts (G15) if state is PROTECTION_PENDING or beyond.
    function supersede(bytes32 eventId) external {
        if (msg.sender != controller) revert Unauthorized();

        DepegEvent storage ev = _events[eventId];
        _requireExists(ev);
        _requireNonTerminal(ev);
        if (_isProtectedFamily(ev.state)) revert CannotSupersede(ev.state);

        bytes32 coinKey = keccak256(abi.encode(ev.coin));
        _terminate(eventId, coinKey, State.SUPERSEDED);
    }

    // ── settle helpers (permissionless) ───────────────────────────────────────

    /// @notice Permissionless: push any event past its outer eventTTL to EXPIRED.
    function settleExpired(bytes32 eventId) external {
        DepegEvent storage ev = _events[eventId];
        _requireExists(ev);
        _requireNonTerminal(ev);
        if (block.timestamp < ev.createdAt + eventTTL) revert NotYetExpired();

        bytes32 coinKey = keccak256(abi.encode(ev.coin));
        _terminate(eventId, coinKey, State.EXPIRED);
    }

    /// @notice Permissionless: push PROTECTION_PENDING or RECOVERY_PENDING to FAILED
    ///         once its pendingTTL has elapsed. PARTIALLY_* states are not eligible
    ///         (they are bounded by eventTTL only).
    function settlePending(bytes32 eventId) external {
        DepegEvent storage ev = _events[eventId];
        _requireExists(ev);
        _requireNonTerminal(ev);

        if (ev.state == State.PROTECTION_PENDING) {
            if (block.timestamp < ev.protectionInitiatedAt + pendingTTL) revert PendingNotTimedOut();
        } else if (ev.state == State.RECOVERY_PENDING) {
            if (block.timestamp < ev.recoveryInitiatedAt + pendingTTL) revert PendingNotTimedOut();
        } else {
            revert InvalidTransition(ev.state);
        }

        bytes32 coinKey = keccak256(abi.encode(ev.coin));
        _terminate(eventId, coinKey, State.FAILED);
    }

    // ── View helpers ──────────────────────────────────────────────────────────

    function getDepegEvent(bytes32 eventId) external view returns (DepegEvent memory) {
        return _events[eventId];
    }

    function getActiveEventId(address coin) external view returns (bytes32) {
        return activeEventId[keccak256(abi.encode(coin))];
    }

    // ── Internal: score-driven transitions ────────────────────────────────────

    function _applyScoreTransitions(
        bytes32 eventId,
        bytes32 coinKey,
        uint8   score
    ) internal returns (State) {
        DepegEvent storage ev = _events[eventId];

        // G13: event TTL wins over all score transitions
        if (block.timestamp >= ev.createdAt + eventTTL) {
            _terminate(eventId, coinKey, State.EXPIRED);
            return State.EXPIRED;
        }

        // GA: auto-recovery gate — count consecutive stable reports while PROTECTED.
        if (ev.state == State.PROTECTED) {
            if (score < watchThreshold) {
                if (ev.stableCount + 1 >= stabilityWindow) {
                    ev.stableCount = 0;
                    _applyAutoRecovery(eventId, ev);
                    return State.RECOVERY_PENDING;
                }
                ev.stableCount++;
            } else {
                ev.stableCount = 0;  // hard reset on any non-stable report
            }
            return State.PROTECTED;
        }

        // Score transitions apply only to WATCH and CONFIRMED_DEPEG.
        // All states from PROTECTION_PENDING onward require explicit action calls.
        if (ev.state != State.WATCH && ev.state != State.CONFIRMED_DEPEG) {
            return ev.state;
        }

        // G3/G4: recovery — WATCH or CONFIRMED_DEPEG, score below floor
        if (score < watchThreshold) {
            _terminate(eventId, coinKey, State.NORMAL);
            return State.NORMAL;
        }

        // G2: WATCH → CONFIRMED_DEPEG
        if (ev.state == State.WATCH && score >= confirmedThreshold) {
            ev.state = State.CONFIRMED_DEPEG;
            emit EventAdvanced(eventId, ev.coin, State.WATCH, State.CONFIRMED_DEPEG);
        }

        return ev.state;
    }

    // ── Internal: auto-recovery ───────────────────────────────────────────────

    function _applyAutoRecovery(bytes32 eventId, DepegEvent storage ev) internal {
        for (uint256 i; i < ev.destinations.length; ) {
            ev.destinations[i].state = DestState.PENDING;
            unchecked { ++i; }
        }
        ev.recoveryInitiatedAt = block.timestamp;
        ev.state               = State.RECOVERY_PENDING;
        emit EventAdvanced(eventId, ev.coin, State.PROTECTED, State.RECOVERY_PENDING);
        emit RecoveryInitiated(eventId, ev.coin, ev.destinations.length);
    }

    // ── Internal: destination completion evaluation ────────────────────────────

    function _evaluateProtection(bytes32 eventId, bytes32 coinKey) internal {
        (bool allSettled, uint256 completeCount, uint256 total, uint256 supersededCount) = _destStats(eventId);
        if (!allSettled) return;

        uint256 effectiveTotal = total - supersededCount;
        if (effectiveTotal == 0) return; // degenerate — await TTL

        DepegEvent storage ev = _events[eventId];
        State from = ev.state;

        if (completeCount == effectiveTotal) {
            // G6: all effective destinations complete
            ev.state = State.PROTECTED;
            emit EventAdvanced(eventId, ev.coin, from, State.PROTECTED);
        } else if (completeCount > 0 && from == State.PROTECTION_PENDING) {
            // G6b: partial on initial attempt → PARTIALLY_PROTECTED
            ev.state = State.PARTIALLY_PROTECTED;
            emit EventAdvanced(eventId, ev.coin, from, State.PARTIALLY_PROTECTED);
        } else if (completeCount == 0 && from == State.PROTECTION_PENDING) {
            // G7: all failed on initial attempt
            _terminate(eventId, coinKey, State.FAILED);
        }
        // PARTIALLY_PROTECTED + retry still partial: no state change — await more retries or TTL
    }

    function _evaluateRecovery(bytes32 eventId, bytes32 coinKey) internal {
        (bool allSettled, uint256 completeCount, uint256 total, uint256 supersededCount) = _destStats(eventId);
        if (!allSettled) return;

        uint256 effectiveTotal = total - supersededCount;
        if (effectiveTotal == 0) return;

        DepegEvent storage ev = _events[eventId];
        State from = ev.state;

        if (completeCount == effectiveTotal) {
            if (block.timestamp >= ev.recoveryInitiatedAt + recoveryCooldown) {
                // G10: all complete + cooldown elapsed
                _terminate(eventId, coinKey, State.NORMAL);
            }
            // else: await cooldown; finalizeRecovery() is the trigger
        } else if (completeCount > 0 && from == State.RECOVERY_PENDING) {
            // G10b: partial on initial attempt
            ev.state = State.PARTIALLY_RECOVERED;
            emit EventAdvanced(eventId, ev.coin, from, State.PARTIALLY_RECOVERED);
        } else if (completeCount == 0 && from == State.RECOVERY_PENDING) {
            // G11: all failed on initial attempt
            _terminate(eventId, coinKey, State.FAILED);
        }
        // PARTIALLY_RECOVERED + retry still partial: await more retries or TTL
    }

    // ── Internal: storage primitives ──────────────────────────────────────────

    function _create(
        bytes32 coinKey,
        address coin,
        uint8   score,
        bytes32 evidenceRoot
    ) internal returns (bytes32 eventId) {
        eventId = keccak256(abi.encode(coin, block.timestamp, ++_nonce));
        DepegEvent storage ev = _events[eventId];
        ev.coin           = coin;
        ev.rootIncidentId = eventId;
        ev.state          = State.WATCH;
        ev.compositeScore = score;
        ev.evidenceRoot   = evidenceRoot;
        ev.createdAt      = block.timestamp;
        ev.observedAt     = block.timestamp;
        activeEventId[coinKey] = eventId;
        emit EventCreated(eventId, coin, score);
    }

    function _extend(bytes32 eventId, uint8 score, bytes32 evidenceRoot) internal {
        DepegEvent storage ev = _events[eventId];
        ev.compositeScore = score;
        ev.evidenceRoot   = evidenceRoot;
        ev.observedAt     = block.timestamp;
        emit EventExtended(eventId, ev.coin, score);
    }

    function _terminate(bytes32 eventId, bytes32 coinKey, State terminal) internal {
        address coin = _events[eventId].coin;
        _events[eventId].state = terminal;
        if (activeEventId[coinKey] == eventId) delete activeEventId[coinKey];
        emit EventTerminated(eventId, coin, terminal);
    }

    function _destStats(bytes32 eventId) internal view returns (
        bool    allSettled,
        uint256 completeCount,
        uint256 total,
        uint256 supersededCount
    ) {
        Destination[] storage dests = _events[eventId].destinations;
        total      = dests.length;
        allSettled = true;
        for (uint256 i; i < total; ) {
            DestState s = dests[i].state;
            if (s == DestState.PENDING)    allSettled = false;
            if (s == DestState.COMPLETE)   completeCount++;
            if (s == DestState.SUPERSEDED) supersededCount++;
            unchecked { ++i; }
        }
    }

    // ── Internal: guards ──────────────────────────────────────────────────────

    function _requireExists(DepegEvent storage ev) internal view {
        if (ev.coin == address(0)) revert EventNotFound();
    }

    function _requireNonTerminal(DepegEvent storage ev) internal view {
        if (_isTerminal(ev.state)) revert AlreadyTerminal();
    }

    function _isTerminal(State s) internal pure returns (bool) {
        return s == State.NORMAL
            || s == State.EXPIRED
            || s == State.FAILED
            || s == State.SUPERSEDED;
    }

    function _isTerminalContinuable(State s) internal pure returns (bool) {
        return s == State.EXPIRED; // only EXPIRED justifies a resumption; FAILED/SUPERSEDED/NORMAL do not
    }

    function _isProtectedFamily(State s) internal pure returns (bool) {
        return s == State.PROTECTION_PENDING
            || s == State.PARTIALLY_PROTECTED
            || s == State.PROTECTED
            || s == State.RECOVERY_PENDING
            || s == State.PARTIALLY_RECOVERED;
    }
}
