// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import "@openzeppelin/contracts/token/ERC20/extensions/ERC4626.sol";
import "@openzeppelin/contracts/access/AccessControl.sol";

/**
 * StableGuardVault
 *
 * ERC-4626 tokenized vault with dual-mode freeze controlled by PAUSE_COORDINATOR_ROLE.
 *
 * Trust boundary: PAUSE_COORDINATOR_ROLE (granted to StableGuardCREReceiver) can only
 * flip the two freeze booleans. It cannot call _transferOut, _withdraw, or any function
 * that moves the underlying asset. This is enforced structurally — the role has no
 * path to asset transfers, only to state variable writes.
 *
 * Freeze modes:
 *   paused=true         — FULL_FREEZE: blocks deposits AND withdrawals
 *   depositsFrozen=true — DEPOSIT_ONLY: blocks deposits, withdrawals remain open
 *   Both may not be set simultaneously; the receiver sets at most one at a time.
 *
 * Inflation-attack mitigation: OZ ERC-4626 v5 applies virtual shares at _decimalsOffset()=0
 * (1 virtual share + 1 virtual asset), making donation attacks unprofitable without
 * requiring a deployer-seeded initial deposit.
 *
 * Constructor args:
 *   asset_      Underlying ERC-20 stablecoin (e.g. USDC)
 *   name_       Vault share token name (e.g. "StableGuard USDC Vault")
 *   symbol_     Vault share token symbol (e.g. "sgUSDC")
 *   governance  Address granted GOVERNANCE_ROLE; should be a multisig
 */
contract StableGuardVault is ERC4626, AccessControl {
    bytes32 public constant GOVERNANCE_ROLE       = keccak256("GOVERNANCE_ROLE");
    bytes32 public constant PAUSE_COORDINATOR_ROLE = keccak256("PAUSE_COORDINATOR_ROLE");

    bool public paused;
    bool public depositsFrozen;

    error VaultFullyFrozen();
    error VaultDepositsFrozen();

    event VaultPaused(address indexed by);
    event VaultUnpaused(address indexed by);
    event DepositsFrozen(address indexed by);
    event DepositsUnfrozen(address indexed by);

    constructor(
        IERC20 asset_,
        string memory name_,
        string memory symbol_,
        address governance
    )
        ERC20(name_, symbol_)
        ERC4626(asset_)
    {
        _grantRole(GOVERNANCE_ROLE, governance);
        // PAUSE_COORDINATOR_ROLE is deliberately NOT granted here.
        // Governance must explicitly grant it to the StableGuardCREReceiver
        // after deployment, so the grant is a tracked, intentional action.
        _setRoleAdmin(PAUSE_COORDINATOR_ROLE, GOVERNANCE_ROLE);
        _setRoleAdmin(GOVERNANCE_ROLE, GOVERNANCE_ROLE);
        // DEFAULT_ADMIN_ROLE (bytes32(0)) is intentionally left ungranted —
        // GOVERNANCE_ROLE manages both roles, and no bypass via the OZ default admin exists.
    }

    // ── Freeze controls — PAUSE_COORDINATOR_ROLE only ────────────────────────

    function pause() external onlyRole(PAUSE_COORDINATOR_ROLE) {
        paused = true;
        emit VaultPaused(msg.sender);
    }

    function unpause() external onlyRole(PAUSE_COORDINATOR_ROLE) {
        paused = false;
        emit VaultUnpaused(msg.sender);
    }

    function pauseDeposits() external onlyRole(PAUSE_COORDINATOR_ROLE) {
        depositsFrozen = true;
        emit DepositsFrozen(msg.sender);
    }

    function unpauseDeposits() external onlyRole(PAUSE_COORDINATOR_ROLE) {
        depositsFrozen = false;
        emit DepositsUnfrozen(msg.sender);
    }

    // ── ERC-4626 public overrides — freeze checks fire before OZ's maxX gate ──
    //
    // OZ 5.x public deposit/withdraw functions check maxX before calling the internal
    // hook, so without these overrides the OZ errors (ERC4626ExceededMaxDeposit etc.)
    // would fire instead of the informative custom errors below. The checks are kept
    // in both layers: here for clear external errors, and in _deposit/_withdraw as
    // defence-in-depth for any future internal callers.

    function deposit(uint256 assets, address receiver) public override returns (uint256) {
        if (paused) revert VaultFullyFrozen();
        if (depositsFrozen) revert VaultDepositsFrozen();
        return super.deposit(assets, receiver);
    }

    function mint(uint256 shares, address receiver) public override returns (uint256) {
        if (paused) revert VaultFullyFrozen();
        if (depositsFrozen) revert VaultDepositsFrozen();
        return super.mint(shares, receiver);
    }

    function withdraw(uint256 assets, address receiver, address owner) public override returns (uint256) {
        if (paused) revert VaultFullyFrozen();
        return super.withdraw(assets, receiver, owner);
    }

    function redeem(uint256 shares, address receiver, address owner) public override returns (uint256) {
        if (paused) revert VaultFullyFrozen();
        return super.redeem(shares, receiver, owner);
    }

    // ── ERC-4626 internal hooks — defence-in-depth freeze checks ─────────────

    function _deposit(address caller, address receiver, uint256 assets, uint256 shares)
        internal override
    {
        if (paused) revert VaultFullyFrozen();
        if (depositsFrozen) revert VaultDepositsFrozen();
        super._deposit(caller, receiver, assets, shares);
    }

    // depositsFrozen does NOT block withdrawals — that is the explicit design of DEPOSIT_ONLY_FREEZE:
    // existing holders can exit during a depeg while new deposits are blocked.
    function _withdraw(
        address caller,
        address receiver,
        address owner,
        uint256 assets,
        uint256 shares
    ) internal override {
        if (paused) revert VaultFullyFrozen();
        super._withdraw(caller, receiver, owner, assets, shares);
    }

    // ── maxX overrides — keep preview functions accurate under freeze ─────────

    function maxDeposit(address receiver) public view override returns (uint256) {
        if (paused || depositsFrozen) return 0;
        return super.maxDeposit(receiver);
    }

    function maxMint(address receiver) public view override returns (uint256) {
        if (paused || depositsFrozen) return 0;
        return super.maxMint(receiver);
    }

    // maxWithdraw is derived from maxRedeem in OZ — overriding maxRedeem is sufficient.
    function maxRedeem(address owner) public view override returns (uint256) {
        if (paused) return 0;
        return super.maxRedeem(owner);
    }
}
