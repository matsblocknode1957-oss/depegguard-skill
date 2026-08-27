// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

/// @title  ProtectionHoldLedger
/// @notice Records per-hold identity for every active vault protection.
///         A vault's hold count must reach zero before an unpause is authorised.
///         Each hold carries full identity (rootIncidentId, assetId, vault) so
///         resumeProtectionTracking can validate lineage without trusting a bare counter.
contract ProtectionHoldLedger {

    // ── Structs ───────────────────────────────────────────────────────────────

    struct ProtectionHold {
        bytes32 holdId;
        bytes32 rootIncidentId;
        bytes32 assetId;
        address vault;
        bool    active;
    }

    // ── Storage ───────────────────────────────────────────────────────────────

    address public coordinator;

    mapping(bytes32 => ProtectionHold) public holds;
    mapping(address => uint256)        public activeHoldCount;

    uint256 private _nonce;

    // ── Events ────────────────────────────────────────────────────────────────

    event HoldAcquired(
        bytes32 indexed holdId,
        bytes32 indexed rootIncidentId,
        bytes32         assetId,
        address         vault
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

    // ── Constructor ───────────────────────────────────────────────────────────

    constructor(address _coordinator) {
        if (_coordinator == address(0)) revert ZeroAddress();
        coordinator = _coordinator;
    }

    // ── getHold ───────────────────────────────────────────────────────────────

    function getHold(bytes32 holdId) external view returns (ProtectionHold memory) {
        return holds[holdId];
    }

    // ── transferCoordinator ───────────────────────────────────────────────────

    function transferCoordinator(address newCoordinator) external {
        if (msg.sender != coordinator) revert Unauthorized();
        if (newCoordinator == address(0)) revert ZeroAddress();
        address old = coordinator;
        coordinator = newCoordinator;
        emit CoordinatorTransferred(old, newCoordinator);
    }

    // ── acquire ───────────────────────────────────────────────────────────────

    /// @notice Register a new protection hold for a vault.
    ///         Called by the coordinator when a vault is paused.
    ///         Returns the holdId — callers must persist this to call release later.
    function acquire(
        address vault,
        bytes32 rootIncidentId,
        bytes32 assetId
    ) external returns (bytes32 holdId) {
        if (msg.sender != coordinator) revert Unauthorized();
        if (vault == address(0))       revert ZeroAddress();

        holdId = keccak256(abi.encode(rootIncidentId, vault, assetId, block.timestamp, ++_nonce));
        holds[holdId] = ProtectionHold({
            holdId:         holdId,
            rootIncidentId: rootIncidentId,
            assetId:        assetId,
            vault:          vault,
            active:         true
        });
        activeHoldCount[vault]++;
        emit HoldAcquired(holdId, rootIncidentId, assetId, vault);
    }

    // ── release ───────────────────────────────────────────────────────────────

    /// @notice Release an active hold.
    ///         Returns true when the vault's activeHoldCount reaches zero —
    ///         the coordinator may then unpause the vault.
    function release(bytes32 holdId) external returns (bool vaultFullyReleased) {
        if (msg.sender != coordinator) revert Unauthorized();

        ProtectionHold storage h = holds[holdId];
        if (h.vault == address(0)) revert HoldNotFound(holdId);
        if (!h.active)             revert HoldAlreadyReleased(holdId);

        h.active = false;
        activeHoldCount[h.vault]--;
        vaultFullyReleased = activeHoldCount[h.vault] == 0;
        emit HoldReleased(holdId, h.vault, vaultFullyReleased);
    }
}
