// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

contract MockVault {
    bool    public paused;
    uint256 public pauseCallCount;

    function pause() external {
        paused = true;
        pauseCallCount++;
    }

    function unpause() external {
        paused = false;
    }
}
