// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

contract MockVault {
    bool public paused;

    function pause() external {
        paused = true;
    }

    function unpause() external {
        paused = false;
    }
}
