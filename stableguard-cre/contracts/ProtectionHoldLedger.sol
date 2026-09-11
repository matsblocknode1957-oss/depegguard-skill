// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

/// @notice Per-vault freeze behaviour required by each hold.
///         FULL_FREEZE         — block deposits AND withdrawals.
///         DEPOSIT_ONLY_FREEZE — block new deposits only; leave withdrawals open.
///
///         Naming and values deliberately match ExposureRegistry.FreezeMode (PR #4)
///         so the two enums are ABI-compatible without an import dependency.
enum FreezeMode { FULL_FREEZE, DEPOSIT_ONLY_FREEZE }

/// @title  ProtectionHoldLedger
/// @notice Records per-hold identity for every active vault protection,
///         including the freeze mode each hold requires.
///
///         A vault's hold count must reach zero before any unfreeze is authorised.
///         When holds with different modes coexist, the aggregate required mode is
///         FULL_FREEZE as long as any FULL_FREEZE hold remains; once only
///         DEPOSIT_ONLY_FREEZE holds remain the coordinator may downgrade the vault
///         from a full pause to a deposit-only freeze without releasing it entirely.
///
///         Each hold carries full identity (rootIncidentId, assetId, vault, mode) so
///         resumeProtectionTracking can validate lineage without trusting a bare counter.
contract ProtectionHoldLedger {

    // ── Structs ───────────────────────────────────────────────────────────────

    struct ProtectionHold {
        bytes32    holdId;
        bytes32    rootIncidentId;
        bytes32    assetId;
        address    vault;
        FreezeMode requiredMode;
        bool       active;
    }

    // ── Storage ───────────────────────────────────────────────────────────────

    address public immutable governance;
    address public coordinator;

    mapping(bytes32 => ProtectionHold) public holds;
    mapping(address => uint256)        public activeHoldCount;
    // Counts how many currently-active holds on each vault require FULL_FREEZE.
    // When this reaches zero (but activeHoldCount > 0), only DEPOSIT_ONLY holds
    // remain and the coordinator may downgrade the vault's freeze state.
    mapping(address => uint256)        public fullFreezeHoldCount;

    uint256 private _nonce;

    // ── Events ────────────────────────────────────────────────────────────────

    event HoldAcquired(
        bytes32    indexed holdId,
        bytes32    indexed rootIncidentId,
        bytes32           assetId,
        address           vault,
        FreezeMode        requiredMode
    );
    event HoldReleased(
        bytes32 indexed holdId,
        address         vault,
        bool            vaultFullyReleased
    );
    event CoordinatorTransferred(address indexed oldCoordinator, address indexed newCoordinator);

    // ── Errors ────────────────────────────────────────────────────────────────

    error Unauthorized();
    error ZeroAddress();
    error HoldNotFound(bytes32 holdId);
    error HoldAlreadyReleased(bytes32 holdId);
    error NoActiveHolds(address vault);

    // ── Constructor ───────────────────────────────────────────────────────────

    constructor(address _governance, address _coordinator) {
        if (_governance   == address(0)) revert ZeroAddress();
        if (_coordinator  == address(0)) revert ZeroAddress();
        governance  = _governance;
        coordinator = _coordinator;
    }

    // ── getHold ───────────────────────────────────────────────────────────────

    function getHold(bytes32 holdId) external view returns (ProtectionHold memory) {
        return holds[holdId];
    }

    // ── requiredFreezeMode ────────────────────────────────────────────────────

    /// @notice Returns the strictest freeze mode currently required by any active
    ///         hold on `vault`.  Returns FULL_FREEZE when at least one hold requires
    ///         it; DEPOSIT_ONLY_FREEZE otherwise (including when no holds exist —
    ///         callers should check activeHoldCount before acting on this value).
    function requiredFreezeMode(address vault) external view returns (FreezeMode) {
        if (activeHoldCount[vault] == 0) revert NoActiveHolds(vault);
        return fullFreezeHoldCount[vault] > 0
            ? FreezeMode.FULL_FREEZE
            : FreezeMode.DEPOSIT_ONLY_FREEZE;
    }

    // ── transferCoordinator ───────────────────────────────────────────────────

    function transferCoordinator(address newCoordinator) external {
        if (msg.sender != coordinator) revert Unauthorized();
        if (newCoordinator == address(0)) revert ZeroAddress();
        address old = coordinator;
        coordinator = newCoordinator;
        emit CoordinatorTransferred(old, newCoordinator);
    }

    // ── forceTransferCoordinator ──────────────────────────────────────────────

    /// @notice Emergency override: governance can rotate the coordinator even if
    ///         the current coordinator is compromised or unresponsive.
    function forceTransferCoordinator(address newCoordinator) external {
        if (msg.sender != governance) revert Unauthorized();
        if (newCoordinator == address(0)) revert ZeroAddress();
        address old = coordinator;
        coordinator = newCoordinator;
        emit CoordinatorTransferred(old, newCoordinator);
    }

    // ── acquire ───────────────────────────────────────────────────────────────

    /// @notice Register a new protection hold for a vault.
    ///         Called by the coordinator when a vault is frozen.
    ///         `mode` records what physical freeze level this hold requires so
    ///         release() can correctly aggregate remaining requirements.
    ///         Returns the holdId — callers must persist this to call release later.
    function acquire(
        address    vault,
        bytes32    rootIncidentId,
        bytes32    assetId,
        FreezeMode mode
    ) external returns (bytes32 holdId) {
        if (msg.sender != coordinator) revert Unauthorized();
        if (vault == address(0))       revert ZeroAddress();

        holdId = keccak256(abi.encode(rootIncidentId, vault, assetId, block.timestamp, ++_nonce));
        holds[holdId] = ProtectionHold({
            holdId:         holdId,
            rootIncidentId: rootIncidentId,
            assetId:        assetId,
            vault:          vault,
            requiredMode:   mode,
            active:         true
        });
        activeHoldCount[vault]++;
        if (mode == FreezeMode.FULL_FREEZE) fullFreezeHoldCount[vault]++;
        emit HoldAcquired(holdId, rootIncidentId, assetId, vault, mode);
    }

    // ── release ───────────────────────────────────────────────────────────────

    /// @notice Release an active hold.
    ///         Returns true when the vault's activeHoldCount reaches zero —
    ///         the coordinator may then fully unfreeze the vault.
    ///         When false, call requiredFreezeMode() to determine whether the
    ///         remaining holds allow a downgrade (e.g. FULL_FREEZE → DEPOSIT_ONLY).
    function release(bytes32 holdId) external returns (bool vaultFullyReleased) {
        if (msg.sender != coordinator) revert Unauthorized();

        ProtectionHold storage h = holds[holdId];
        if (h.vault == address(0)) revert HoldNotFound(holdId);
        if (!h.active)             revert HoldAlreadyReleased(holdId);

        h.active = false;
        if (h.requiredMode == FreezeMode.FULL_FREEZE) fullFreezeHoldCount[h.vault]--;
        activeHoldCount[h.vault]--;
        vaultFullyReleased = activeHoldCount[h.vault] == 0;
        emit HoldReleased(holdId, h.vault, vaultFullyReleased);
    }
}
