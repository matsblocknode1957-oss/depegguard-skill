// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

/// @dev Test mock implementing the Morpho Vault V2 sentinel interface,
///      verified against morpho-org/vault-v2.  Used by morpho-sentinel.test.js.
contract MockMorphoVaultV2 {

    address private _owner;

    mapping(address => bool) public isSentinel;

    mapping(bytes32 => uint256) private _allocation;
    mapping(bytes32 => uint128) private _absoluteCap;
    mapping(bytes32 => uint128) private _relativeCap;

    // Per-cap revert flags
    mapping(bytes32 => bool) public deallocateShouldRevert;
    mapping(bytes32 => bool) public capDecreaseShouldRevert;

    struct DeallocCall { address adapter; bytes data; uint256 assets; }
    DeallocCall[] internal _deallocCalls;

    constructor(address owner_) { _owner = owner_; }

    // ── Morpho V2 getters ─────────────────────────────────────────────────────

    function owner() external view returns (address) { return _owner; }

    function setIsSentinel(address account, bool val) external {
        require(msg.sender == _owner, "MockMorpho: not owner");
        isSentinel[account] = val;
    }

    function transferOwnership(address newOwner) external {
        require(msg.sender == _owner, "MockMorpho: not owner");
        require(newOwner != address(0), "MockMorpho: zero address");
        _owner = newOwner;
    }

    function allocation(bytes32 id) external view returns (uint256) { return _allocation[id]; }
    function absoluteCap(bytes32 id) external view returns (uint256) { return _absoluteCap[id]; }
    function relativeCap(bytes32 id) external view returns (uint256) { return _relativeCap[id]; }

    // ── Morpho V2 sentinel actions ────────────────────────────────────────────

    function decreaseAbsoluteCap(bytes memory idData, uint256 newCap) external {
        require(isSentinel[msg.sender] || msg.sender == _owner, "MockMorpho: unauthorized");
        bytes32 id = keccak256(idData);
        if (capDecreaseShouldRevert[id]) revert("MockMorpho: stuck cap");
        require(newCap <= _absoluteCap[id], "MockMorpho: cap must decrease");
        _absoluteCap[id] = uint128(newCap);
    }

    function decreaseRelativeCap(bytes memory idData, uint256 newCap) external {
        require(isSentinel[msg.sender] || msg.sender == _owner, "MockMorpho: unauthorized");
        bytes32 id = keccak256(idData);
        if (capDecreaseShouldRevert[id]) revert("MockMorpho: stuck cap");
        require(newCap <= _relativeCap[id], "MockMorpho: cap must decrease");
        _relativeCap[id] = uint128(newCap);
    }

    function deallocate(address adapter, bytes memory data, uint256 assets) external {
        require(isSentinel[msg.sender], "MockMorpho: not sentinel");
        bytes32 id = keccak256(data);
        if (deallocateShouldRevert[id]) revert("MockMorpho: stuck market");
        if (_allocation[id] >= assets) _allocation[id] -= assets;
        _deallocCalls.push(DeallocCall({ adapter: adapter, data: data, assets: assets }));
    }

    // ── Test setup helpers ────────────────────────────────────────────────────

    /// @dev Set allocation for a cap id derived from idData.
    function setAllocation(bytes memory idData, uint256 amount) external {
        _allocation[keccak256(idData)] = amount;
    }

    /// @dev Set absolute and relative caps for a cap id derived from idData.
    function setCap(bytes memory idData, uint128 absCap, uint128 relCap) external {
        bytes32 id = keccak256(idData);
        _absoluteCap[id] = absCap;
        _relativeCap[id] = relCap;
    }

    /// @dev Make deallocate revert for the cap id derived from idData.
    function setDeallocateReverts(bytes memory idData, bool val) external {
        deallocateShouldRevert[keccak256(idData)] = val;
    }

    /// @dev Make decreaseAbsoluteCap/decreaseRelativeCap revert for the cap id derived from idData.
    function setCapDecreaseReverts(bytes memory idData, bool val) external {
        capDecreaseShouldRevert[keccak256(idData)] = val;
    }

    function getDeallocCallCount() external view returns (uint256) { return _deallocCalls.length; }

    function getDeallocCall(uint256 i)
        external view
        returns (address adapter, bytes memory data, uint256 assets)
    {
        DeallocCall storage c = _deallocCalls[i];
        return (c.adapter, c.data, c.assets);
    }
}
