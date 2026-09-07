// SPDX-License-Identifier: MIT
pragma solidity ^0.8.19;

/// @notice Per-vault freeze behaviour on a confirmed depeg.
///         FULL_FREEZE   — block deposits AND withdrawals (default, backward-compatible).
///         DEPOSIT_ONLY_FREEZE — block new deposits only; leave withdrawals open so
///         existing holders can exit during a de-peg event.
///         Set by the vault's own admin (customer multisig) via setFreezeMode().
enum FreezeMode { FULL_FREEZE, DEPOSIT_ONLY_FREEZE }

/// @title ExposureRegistry
/// @notice Maps vault addresses to the asset symbol(s) they actually hold.
/// @dev This is the missing binding identified in review: an alert for symbol X
///      must not be able to change state on a vault that does not hold X.
///      Phase 1 uses manual admin registration. Oracle-fed or vault self-reporting
///      can replace `registerExposure` later without changing the read interface.
contract ExposureRegistry {
    address public admin;

    /// @notice vault => set of asset symbols (as bytes32) the vault holds
    mapping(address => mapping(bytes32 => bool)) private _exposure;

    /// @notice vault => list of symbols currently registered (for enumeration)
    mapping(address => bytes32[]) private _exposureList;

    /// @notice vault => freeze behaviour on depeg. Defaults to FULL_FREEZE (zero value).
    ///         The customer's own admin sets this; StableGuard never overrides it.
    mapping(address => FreezeMode) public vaultFreezeMode;

    event ExposureRegistered(address indexed vault, bytes32 indexed symbol);
    event ExposureRevoked(address indexed vault, bytes32 indexed symbol);
    event AdminTransferred(address indexed oldAdmin, address indexed newAdmin);
    event FreezeModeUpdated(address indexed vault, FreezeMode mode);

    error NotAdmin();
    error AlreadyRegistered();
    error NotRegistered();
    error ZeroAddress();

    modifier onlyAdmin() {
        if (msg.sender != admin) revert NotAdmin();
        _;
    }

    constructor(address _admin) {
        if (_admin == address(0)) revert ZeroAddress();
        admin = _admin;
    }

    /// @notice Register that `vault` holds `symbol` (e.g. keccak256("USDC")).
    function registerExposure(address vault, bytes32 symbol) external onlyAdmin {
        if (vault == address(0)) revert ZeroAddress();
        if (_exposure[vault][symbol]) revert AlreadyRegistered();

        _exposure[vault][symbol] = true;
        _exposureList[vault].push(symbol);

        emit ExposureRegistered(vault, symbol);
    }

    /// @notice Revoke a previously registered exposure (vault no longer holds it).
    function revokeExposure(address vault, bytes32 symbol) external onlyAdmin {
        if (!_exposure[vault][symbol]) revert NotRegistered();

        _exposure[vault][symbol] = false;

        // Remove from enumeration list (swap-and-pop; order not preserved)
        bytes32[] storage list = _exposureList[vault];
        for (uint256 i = 0; i < list.length; i++) {
            if (list[i] == symbol) {
                list[i] = list[list.length - 1];
                list.pop();
                break;
            }
        }

        emit ExposureRevoked(vault, symbol);
    }

    /// @notice Core check used by the receiver: does `vault` actually hold `symbol`?
    function isExposed(address vault, bytes32 symbol) external view returns (bool) {
        return _exposure[vault][symbol];
    }

    /// @notice Enumerate all symbols currently registered for a vault.
    function getExposures(address vault) external view returns (bytes32[] memory) {
        return _exposureList[vault];
    }

    /// @notice Set the freeze mode for a vault. Only the vault's admin (customer multisig)
    ///         should call this. Defaults to FULL_FREEZE if never called, preserving
    ///         backward-compatible behaviour for all existing integrations.
    function setFreezeMode(address vault, FreezeMode mode) external onlyAdmin {
        if (vault == address(0)) revert ZeroAddress();
        vaultFreezeMode[vault] = mode;
        emit FreezeModeUpdated(vault, mode);
    }

    function transferAdmin(address newAdmin) external onlyAdmin {
        if (newAdmin == address(0)) revert ZeroAddress();
        emit AdminTransferred(admin, newAdmin);
        admin = newAdmin;
    }
}
