// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

/// A minimal hold ledger stub whose acquire() always reverts.
/// Used to test that a failed acquire produces a FAILED destinationCallback
/// even when vault.pause() succeeded.
contract MockHoldLedgerRevertAcquire {
    mapping(address => uint256) public activeHoldCount;

    error AcquireAlwaysFails();

    function acquire(address, bytes32, bytes32) external pure returns (bytes32) {
        revert AcquireAlwaysFails();
    }

    function release(bytes32) external pure returns (bool) {
        return true;
    }
}
