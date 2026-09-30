// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

/// Vault mock that reverts on pause() if already paused, mirroring OZ Pausable.
/// Used to prove that the acquire()-first ordering prevents the orphaned-freeze
/// state that would otherwise trigger a double-pause revert on the next report.
contract MockVaultRevertDoublePause {
    bool public paused;
    bool public depositsFrozen;

    error AlreadyPaused();

    function pause()           external { if (paused) revert AlreadyPaused(); paused = true; }
    function unpause()         external { paused = false; }
    function pauseDeposits()   external { depositsFrozen = true; }
    function unpauseDeposits() external { depositsFrozen = false; }
}
