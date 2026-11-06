// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

interface IAccessControl {
    function hasRole(bytes32 role, address account) external view returns (bool);
}

interface ISafe {
    function isOwner(address owner) external view returns (bool);
}

interface IProtectionHoldLedgerOverride {
    function releaseByOverride(bytes32 holdId) external returns (bool vaultFullyReleased);
    function activeHoldCount(address vault) external view returns (uint256);
}

interface IExecuteEarlyUnlock {
    function executeEarlyUnlock(address coin, address vault) external;
}

/// @title  CustomerOverrideModule
/// @notice Lets a per-vault Safe block or shorten protection-hold recovery.
///
///         Lifecycle:
///           1. Governance (GOVERNANCE_ROLE on vault) calls setVaultAuthority + setVaultReceiver
///           2. On every vault freeze the receiver calls registerHold — records a slot only if
///              the vault has a configured overrideAuthority.  The slot is NOT active by default;
///              auto-recovery proceeds normally until placeHold is called.
///           3. Any single Safe owner may call placeHold to activate the hold.
///              The receiver checks isHoldActive(coin, vault) each recovery cycle:
///                  – PENDING dest + hold active  → receiver calls markHoldPaused
///                  – HOLD_PAUSED dest + hold gone → receiver proceeds with normal recovery
///           4. Any single Safe owner may call renewHold.
///           5. The full override Safe may call earlyUnlock (immediate unfreeze + suppression
///              window) or cancelHold (deactivate hold; vault unfreezes on next receiver cycle).
///
///         Suppression window: after earlyUnlock, the same (rootIncidentId, vault) pair is
///         suppressed for suppressionWindow seconds if the new composite score ≤ severityAtUnlock.
///         A different rootIncidentId is never suppressed regardless.
contract CustomerOverrideModule {

    bytes32 public constant GOVERNANCE_ROLE        = keccak256("GOVERNANCE_ROLE");
    bytes32 public constant PAUSE_COORDINATOR_ROLE = keccak256("PAUSE_COORDINATOR_ROLE");

    IProtectionHoldLedgerOverride public immutable holdLedger;

    address public admin;
    uint256 public maxHoldDuration;
    uint256 public suppressionWindow;

    // vault → Safe authorised to call earlyUnlock / cancelHold (full threshold)
    mapping(address => address) public overrideAuthority;

    // vault → receiver that calls registerHold and receives executeEarlyUnlock calls
    mapping(address => address) public vaultReceiver;

    struct OverrideHold {
        bytes32 ledgerHoldId;
        bytes32 rootIncidentId;
        uint256 holdUntil;      // 0 until placeHold is called
        uint8   severityAtHold;
        bool    registered;
        bool    ownerRenewUsed; // H-01: true once a single Safe owner has renewed; reset by Safe-driven renewal
    }

    // coin → vault → override hold slot
    mapping(address => mapping(address => OverrideHold)) public overrideHolds;

    struct Suppression {
        uint256 suppressUntil;
        uint8   severityAtUnlock;
    }

    // rootIncidentId → vault → suppression record
    mapping(bytes32 => mapping(address => Suppression)) private _suppressions;
    // vault → vault-level suppression (H-04: set by earlyUnlock so fresh events are also suppressed)
    mapping(address => Suppression) private _vaultSuppressions;

    // ── Events ────────────────────────────────────────────────────────────────

    event VaultAuthoritySet(address indexed vault, address indexed safe);
    event VaultReceiverSet(address indexed vault, address indexed receiver_);
    event HoldSlotRegistered(
        address indexed coin,
        address indexed vault,
        bytes32 indexed rootIncidentId
    );
    event HoldPlaced(
        address indexed coin,
        address indexed vault,
        address indexed signer,
        uint256 holdUntil
    );
    event HoldEarlyUnlocked(
        address indexed coin,
        address indexed vault,
        bytes32 indexed rootIncidentId,
        uint256 suppressUntil
    );
    event HoldCancelled(address indexed coin, address indexed vault);
    event HoldRenewed(address indexed coin, address indexed vault, uint256 newHoldUntil);
    event StaleHoldOverwritten(
        address indexed coin,
        address indexed vault,
        bytes32 indexed oldLedgerHoldId,
        bytes32         newLedgerHoldId
    );
    event MaxHoldDurationSet(uint256 newDuration);
    event SuppressionWindowSet(uint256 newWindow);
    event AdminTransferred(address indexed oldAdmin, address indexed newAdmin);

    // ── Errors ────────────────────────────────────────────────────────────────

    error Unauthorized();
    error ZeroAddress();
    error HoldNotRegistered();
    error HoldAlreadyPlaced();
    error HoldNotActive();
    error DurationExceedsMax(uint256 duration, uint256 maxAllowed);
    error RootIncidentMismatch(bytes32 given, bytes32 stored);
    error ReceiverNotSet(address vault);
    error OwnerRenewLimitReached();

    // ── Constructor ───────────────────────────────────────────────────────────

    constructor(
        address _holdLedger,
        uint256 _maxHoldDuration,
        uint256 _suppressionWindow,
        address _admin
    ) {
        if (_holdLedger == address(0) || _admin == address(0)) revert ZeroAddress();
        holdLedger        = IProtectionHoldLedgerOverride(_holdLedger);
        maxHoldDuration   = _maxHoldDuration;
        suppressionWindow = _suppressionWindow;
        admin             = _admin;
    }

    // ── admin setters ─────────────────────────────────────────────────────────

    function transferAdmin(address newAdmin) external {
        if (msg.sender != admin) revert Unauthorized();
        if (newAdmin == address(0)) revert ZeroAddress();
        emit AdminTransferred(admin, newAdmin);
        admin = newAdmin;
    }

    function setMaxHoldDuration(uint256 newMax) external {
        if (msg.sender != admin) revert Unauthorized();
        emit MaxHoldDurationSet(newMax);
        maxHoldDuration = newMax;
    }

    function setSuppressionWindow(uint256 newWindow) external {
        if (msg.sender != admin) revert Unauthorized();
        emit SuppressionWindowSet(newWindow);
        suppressionWindow = newWindow;
    }

    // ── per-vault setup (GOVERNANCE_ROLE on vault) ────────────────────────────

    function setVaultAuthority(address vault, address safe) external {
        if (!IAccessControl(vault).hasRole(GOVERNANCE_ROLE, msg.sender)) revert Unauthorized();
        if (safe == address(0)) revert ZeroAddress();
        overrideAuthority[vault] = safe;
        emit VaultAuthoritySet(vault, safe);
    }

    function setVaultReceiver(address vault, address receiver_) external {
        if (!IAccessControl(vault).hasRole(GOVERNANCE_ROLE, msg.sender)) revert Unauthorized();
        if (receiver_ == address(0)) revert ZeroAddress();
        vaultReceiver[vault] = receiver_;
        emit VaultReceiverSet(vault, receiver_);
    }

    // ── registerHold ──────────────────────────────────────────────────────────
    // Called by the receiver (PAUSE_COORDINATOR_ROLE) after a successful vault
    // freeze.  No-op if vault has no overrideAuthority.  Records the slot only —
    // does NOT activate the hold.  holdUntil stays 0 until placeHold is called.

    function registerHold(
        address coin,
        address vault,
        bytes32 rootIncidentId,
        bytes32 ledgerHoldId,
        uint8   score
    ) external {
        if (!IAccessControl(vault).hasRole(PAUSE_COORDINATOR_ROLE, msg.sender)) revert Unauthorized();

        // No authority configured → override feature not enabled for this vault
        if (overrideAuthority[vault] == address(0)) return;

        // M-03: if a previous slot exists, release its ledger hold so it doesn't
        // remain live alongside the new one.  The new hold already keeps the vault
        // frozen, so releasing the old hold has no adverse effect.  Wrapped in
        // try/catch because the hold may have been released during a prior recovery
        // cycle (HoldAlreadyReleased) or may have been recorded with a placeholder id.
        OverrideHold storage existing = overrideHolds[coin][vault];
        if (existing.registered) {
            bytes32 oldId = existing.ledgerHoldId;
            try holdLedger.releaseByOverride(oldId) { } catch { }
            emit StaleHoldOverwritten(coin, vault, oldId, ledgerHoldId);
        }

        overrideHolds[coin][vault] = OverrideHold({
            ledgerHoldId:   ledgerHoldId,
            rootIncidentId: rootIncidentId,
            holdUntil:      0,
            severityAtHold: score,
            registered:     true,
            ownerRenewUsed: false
        });
        emit HoldSlotRegistered(coin, vault, rootIncidentId);
    }

    // ── placeHold ─────────────────────────────────────────────────────────────
    // Activates the registered hold slot.  Callable by any single owner of the
    // vault's override Safe.  A hold slot must already exist (vault must be frozen).

    function placeHold(address coin, address vault) external {
        address authority = overrideAuthority[vault];
        if (!ISafe(authority).isOwner(msg.sender)) revert Unauthorized();

        OverrideHold storage h = overrideHolds[coin][vault];
        if (!h.registered) revert HoldNotRegistered();
        if (h.holdUntil > 0 && block.timestamp < h.holdUntil) revert HoldAlreadyPlaced();

        uint256 holdUntil = block.timestamp + maxHoldDuration;
        h.holdUntil      = holdUntil;
        h.ownerRenewUsed = false;
        emit HoldPlaced(coin, vault, msg.sender, holdUntil);
    }

    // ── isHoldActive ──────────────────────────────────────────────────────────

    function isHoldActive(address coin, address vault) public view returns (bool) {
        OverrideHold storage h = overrideHolds[coin][vault];
        return h.registered && h.holdUntil > 0 && block.timestamp < h.holdUntil;
    }

    // ── isHoldRegistered ──────────────────────────────────────────────────────

    function isHoldRegistered(address coin, address vault) public view returns (bool) {
        return overrideHolds[coin][vault].registered;
    }

    // ── isSuppressed ──────────────────────────────────────────────────────────

    function isSuppressed(bytes32 rootIncidentId, address vault, uint8 score)
        external view returns (bool)
    {
        Suppression storage s1 = _suppressions[rootIncidentId][vault];
        if (block.timestamp < s1.suppressUntil && score <= s1.severityAtUnlock) return true;
        // H-04: also check vault-level suppression so fresh events (new rootIncidentId) are caught
        Suppression storage s2 = _vaultSuppressions[vault];
        return block.timestamp < s2.suppressUntil && score <= s2.severityAtUnlock;
    }

    // ── getSuppression ────────────────────────────────────────────────────────

    function getSuppression(bytes32 rootIncidentId, address vault)
        external view returns (uint256 suppressUntil, uint8 severityAtUnlock)
    {
        Suppression storage s = _suppressions[rootIncidentId][vault];
        return (s.suppressUntil, s.severityAtUnlock);
    }

    // ── earlyUnlock ───────────────────────────────────────────────────────────
    // Immediately releases the vault hold, unfreezes the vault, and stores a
    // suppression window.  Requires the full Safe as msg.sender.

    function earlyUnlock(address coin, address vault, bytes32 rootIncidentId) external {
        if (msg.sender != overrideAuthority[vault]) revert Unauthorized();

        OverrideHold storage h = overrideHolds[coin][vault];
        if (!h.registered) revert HoldNotRegistered();
        if (!isHoldActive(coin, vault)) revert HoldNotActive();
        if (h.rootIncidentId != rootIncidentId)
            revert RootIncidentMismatch(rootIncidentId, h.rootIncidentId);

        uint8   severity = h.severityAtHold;
        bytes32 lhId     = h.ledgerHoldId;
        h.registered = false;
        h.holdUntil  = 0;

        // Release the physical vault hold (bypasses coordinator check)
        holdLedger.releaseByOverride(lhId);

        // Tell the receiver to unfreeze and mark COMPLETE in the event registry
        address recv = vaultReceiver[vault];
        if (recv == address(0)) revert ReceiverNotSet(vault);
        IExecuteEarlyUnlock(recv).executeEarlyUnlock(coin, vault);

        // Record suppression — both per-incident and vault-level (H-04).
        // Per-incident covers resumeProtectionTracking (same rootIncidentId reused).
        // Vault-level covers fresh events after earlyUnlock (new rootIncidentId).
        uint256 suppressUntil = block.timestamp + suppressionWindow;
        Suppression memory sup = Suppression({ suppressUntil: suppressUntil, severityAtUnlock: severity });
        _suppressions[rootIncidentId][vault] = sup;
        _vaultSuppressions[vault]            = sup;
        emit HoldEarlyUnlocked(coin, vault, rootIncidentId, suppressUntil);
    }

    // ── cancelHold ────────────────────────────────────────────────────────────
    // Deactivates the override hold without immediately touching the vault.
    // The receiver will release the ledger hold and unfreeze on its next cycle.
    // Requires the full Safe as msg.sender.

    function cancelHold(address coin, address vault) external {
        if (msg.sender != overrideAuthority[vault]) revert Unauthorized();

        OverrideHold storage h = overrideHolds[coin][vault];
        if (!h.registered) revert HoldNotRegistered();
        if (!isHoldActive(coin, vault)) revert HoldNotActive();

        h.registered = false;
        h.holdUntil  = 0;
        emit HoldCancelled(coin, vault);
    }

    // ── renewHold ─────────────────────────────────────────────────────────────
    // Resets holdUntil to exactly now + newDuration (not additive).
    // Capped at maxHoldDuration.
    //
    // H-01: a single Safe owner may renew at most once per hold lifecycle.
    //       The full Safe (msg.sender == overrideAuthority[vault]) may always renew
    //       and resets the owner-renew allowance so owners get one more renewal.

    function renewHold(address coin, address vault, uint256 newDuration) external {
        address authority = overrideAuthority[vault];
        bool    isSafe    = msg.sender == authority;
        if (!isSafe && !ISafe(authority).isOwner(msg.sender)) revert Unauthorized();
        if (newDuration > maxHoldDuration) revert DurationExceedsMax(newDuration, maxHoldDuration);
        if (!isHoldActive(coin, vault)) revert HoldNotActive();

        OverrideHold storage h = overrideHolds[coin][vault];
        if (isSafe) {
            h.ownerRenewUsed = false;
        } else {
            if (h.ownerRenewUsed) revert OwnerRenewLimitReached();
            h.ownerRenewUsed = true;
        }

        uint256 newHoldUntil = block.timestamp + newDuration;
        h.holdUntil = newHoldUntil;
        emit HoldRenewed(coin, vault, newHoldUntil);
    }
}
