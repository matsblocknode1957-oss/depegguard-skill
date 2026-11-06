// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

interface IMorphoVaultV2 {
    function owner() external view returns (address);
    function isSentinel(address) external view returns (bool);
    function allocation(bytes32 id) external view returns (uint256);
    function absoluteCap(bytes32 id) external view returns (uint256);
    function relativeCap(bytes32 id) external view returns (uint256);
    function decreaseAbsoluteCap(bytes memory idData, uint256 newCap) external;
    function decreaseRelativeCap(bytes memory idData, uint256 newCap) external;
    function deallocate(address adapter, bytes memory data, uint256 assets) external;
}

/**
 * MorphoSentinelAdapter
 *
 * Called by StableGuardCREReceiver on confirmed depeg. Uses the Morpho Vault V2
 * sentinel role to zero absolute and relative caps for each registered market,
 * then deallocates any remaining allocation. Returns the count of markets
 * successfully capped; if 0, the receiver marks its destination slot FAILED.
 *
 * Setup checklist (must be done before a depeg triggers):
 *   1. Deploy this contract pointing at the target Morpho vault.
 *   2. Vault owner calls vault.setIsSentinel(address(this), true).
 *   3. Vault owner calls this.setReceiver(receiverAddress).
 *   4. Vault owner calls this.registerMarkets(coin, [...entries...]).
 *   5. StableGuard admin calls ExposureRegistry.registerExposure(vault, symbol)
 *      using symbol = bytes32(uint256(uint160(coinAddress))). Without this step
 *      the receiver will not acquire a hold or invoke this adapter on depeg.
 */
contract MorphoSentinelAdapter {

    // ── Structs ───────────────────────────────────────────────────────────────

    struct MarketParams {
        address loanToken;
        address collateralToken;
        address oracle;
        address irm;
        uint256 lltv;
    }

    /// @param marketData  abi.encode(MarketParams); cap id = keccak256(marketData);
    ///                    also passed verbatim to vault.deallocate as the data arg.
    /// @param adapter     first arg to vault.deallocate (the market adapter address).
    struct MarketEntry {
        bytes   marketData;
        address adapter;
    }

    // ── State ─────────────────────────────────────────────────────────────────

    IMorphoVaultV2 public immutable morphoVault;

    address public receiver;
    uint8   public criticalThreshold;

    mapping(address => MarketEntry[]) private _markets;

    // ── Events ────────────────────────────────────────────────────────────────

    event MorphoCapsZeroed(address indexed coin, uint256 marketsCapped);
    event MorphoCapDecreaseFailed(address indexed coin, bytes32 indexed marketId, bytes reason);
    event MorphoDeallocateFailed(address indexed coin, bytes32 indexed marketId, bytes reason);
    event MorphoNotSentinel(address indexed adapter, address indexed vault_);
    event MorphoThresholdNotMet(address indexed coin, uint8 score, uint8 threshold);
    event MorphoMarketsNotRegistered(address indexed coin);
    event MorphoRecoverySignalled(address indexed coin);
    event ReceiverSet(address indexed previousReceiver, address indexed newReceiver);
    event ThresholdSet(uint8 previousThreshold, uint8 newThreshold);
    event MarketsRegistered(address indexed coin, uint256 count);
    event MarketsCleared(address indexed coin);

    // ── Errors ────────────────────────────────────────────────────────────────

    error Unauthorized();
    error ZeroAddress();
    error InvalidThreshold(uint8 value);
    error CollateralMismatch(address expected, address actual);

    // ── Constructor ───────────────────────────────────────────────────────────

    constructor(address _morphoVault) {
        if (_morphoVault == address(0)) revert ZeroAddress();
        morphoVault       = IMorphoVaultV2(_morphoVault);
        criticalThreshold = 3;
    }

    // ── Internal auth ─────────────────────────────────────────────────────────

    function _requireVaultOwner() internal view {
        if (morphoVault.owner() != msg.sender) revert Unauthorized();
    }

    function _requireReceiver() internal view {
        if (msg.sender != receiver) revert Unauthorized();
    }

    // ── View ──────────────────────────────────────────────────────────────────

    /// Live read of the vault's current owner(). Used in the setup checklist
    /// and as the auth source for all owner-gated calls on this adapter.
    function vaultAuthority() external view returns (address) {
        try morphoVault.owner() returns (address o) { return o; }
        catch { return address(0); }
    }

    function getMarkets(address coin) external view returns (MarketEntry[] memory) {
        return _markets[coin];
    }

    // ── Vault-owner administration ────────────────────────────────────────────

    function setReceiver(address newReceiver) external {
        _requireVaultOwner();
        if (newReceiver == address(0)) revert ZeroAddress();
        emit ReceiverSet(receiver, newReceiver);
        receiver = newReceiver;
    }

    /// Valid values: 2 or 3 (CRE score scale is 0–3; values 0 and 1 are rejected
    /// because they would trigger on any WATCH signal, not just critical ones).
    function setCriticalThreshold(uint8 value) external {
        _requireVaultOwner();
        if (value < 2) revert InvalidThreshold(value);
        emit ThresholdSet(criticalThreshold, value);
        criticalThreshold = value;
    }

    /// Replaces any previously registered markets for this coin.
    /// Reverts if any entry's collateralToken does not equal coin.
    function registerMarkets(address coin, MarketEntry[] calldata entries) external {
        _requireVaultOwner();
        if (coin == address(0)) revert ZeroAddress();
        for (uint256 i = 0; i < entries.length; i++) {
            MarketParams memory p = abi.decode(entries[i].marketData, (MarketParams));
            if (p.collateralToken != coin) revert CollateralMismatch(coin, p.collateralToken);
        }
        delete _markets[coin];
        for (uint256 i = 0; i < entries.length; i++) {
            _markets[coin].push(entries[i]);
        }
        emit MarketsRegistered(coin, entries.length);
    }

    function clearMarkets(address coin) external {
        _requireVaultOwner();
        delete _markets[coin];
        emit MarketsCleared(coin);
    }

    // ── Receiver-callable ─────────────────────────────────────────────────────

    /// Called by StableGuardCREReceiver when score >= criticalThreshold.
    /// Returns the number of markets where at least one cap was successfully zeroed.
    /// A return value of 0 signals the receiver to mark the destination slot FAILED.
    function onDepeg(address coin, uint8 score) external returns (uint256 marketsCapped) {
        _requireReceiver();

        if (score < criticalThreshold) {
            emit MorphoThresholdNotMet(coin, score, criticalThreshold);
            return 0;
        }

        MarketEntry[] storage entries = _markets[coin];
        if (entries.length == 0) {
            emit MorphoMarketsNotRegistered(coin);
            return 0;
        }

        if (!morphoVault.isSentinel(address(this))) {
            emit MorphoNotSentinel(address(this), address(morphoVault));
            return 0;
        }

        for (uint256 i = 0; i < entries.length; i++) {
            bytes memory mData = entries[i].marketData;
            address mAdapter   = entries[i].adapter;
            bytes32 mId        = keccak256(mData);
            bool capSuccess    = false;

            // H-03: read current cap first; skip the call if already 0 (already protected)
            // This avoids a potential revert on vaults that require a strict decrease (< vs <=).
            uint256 absCap = morphoVault.absoluteCap(mId);
            if (absCap == 0) {
                capSuccess = true;
            } else {
                try morphoVault.decreaseAbsoluteCap(mData, 0) {
                    capSuccess = true;
                } catch (bytes memory reason) {
                    emit MorphoCapDecreaseFailed(coin, mId, reason);
                }
            }

            uint256 relCap = morphoVault.relativeCap(mId);
            if (relCap == 0) {
                capSuccess = true;
            } else {
                try morphoVault.decreaseRelativeCap(mData, 0) {
                    capSuccess = true;
                } catch (bytes memory reason) {
                    emit MorphoCapDecreaseFailed(coin, mId, reason);
                }
            }

            uint256 alloc = morphoVault.allocation(mId);
            if (alloc > 0) {
                try morphoVault.deallocate(mAdapter, mData, alloc) { }
                catch (bytes memory reason) {
                    emit MorphoDeallocateFailed(coin, mId, reason);
                }
            }

            if (capSuccess) marketsCapped++;
        }

        emit MorphoCapsZeroed(coin, marketsCapped);
    }

    /// Called by StableGuardCREReceiver on recovery. Morpho caps that were zeroed
    /// on depeg can only be restored by the vault owner; this call is informational.
    function onRecovery(address coin) external {
        _requireReceiver();
        emit MorphoRecoverySignalled(coin);
    }
}
