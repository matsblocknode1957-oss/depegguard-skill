// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

contract MockVault {
    bool    public paused;
    uint256 public pauseCallCount;

    bool    public depositsFrozen;
    uint256 public depositPauseCallCount;

    function pause() external {
        paused = true;
        pauseCallCount++;
    }

    function unpause() external {
        paused = false;
    }

    function pauseDeposits() external {
        depositsFrozen = true;
        depositPauseCallCount++;
    }

    function unpauseDeposits() external {
        depositsFrozen = false;
    }
}
