// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

/// A vault stub whose unpause() can be made to revert on demand.
/// Used to test that a failed unpause produces a FAILED destinationCallback
/// even when holdLedger.release() succeeded.
contract MockFlakyVault {
    bool    public paused;
    uint256 public pauseCallCount;
    bool    public unpauseReverts;

    error UnpauseForcedRevert();

    function pause() external {
        paused = true;
        pauseCallCount++;
    }

    function unpause() external {
        if (unpauseReverts) revert UnpauseForcedRevert();
        paused = false;
    }

    function setUnpauseReverts(bool _reverts) external {
        unpauseReverts = _reverts;
    }
}
