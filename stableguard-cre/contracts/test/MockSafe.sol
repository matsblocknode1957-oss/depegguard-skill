// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

interface ICustomerOverrideModule {
    function earlyUnlock(address coin, address vault, bytes32 rootIncidentId) external;
    function cancelHold(address coin, address vault) external;
    function renewHold(address coin, address vault, uint256 newDuration) external;
}

/// @dev Minimal Safe stand-in for tests.  Multiple EOA owners can be added;
///      any single owner may call placeHold/renewHold directly on the module.
///      earlyUnlock and cancelHold route through this contract so that
///      msg.sender == Safe address == overrideAuthority[vault].
contract MockSafe {
    mapping(address => bool) public isOwner;

    constructor(address _owner) {
        isOwner[_owner] = true;
    }

    function addOwner(address owner_) external {
        isOwner[owner_] = true;
    }

    function callEarlyUnlock(
        address module,
        address coin,
        address vault,
        bytes32 rootIncidentId
    ) external {
        require(isOwner[msg.sender], "MockSafe: not owner");
        ICustomerOverrideModule(module).earlyUnlock(coin, vault, rootIncidentId);
    }

    function callCancelHold(
        address module,
        address coin,
        address vault
    ) external {
        require(isOwner[msg.sender], "MockSafe: not owner");
        ICustomerOverrideModule(module).cancelHold(coin, vault);
    }

    function callRenewHold(
        address module,
        address coin,
        address vault,
        uint256 newDuration
    ) external {
        require(isOwner[msg.sender], "MockSafe: not owner");
        ICustomerOverrideModule(module).renewHold(coin, vault, newDuration);
    }
}
