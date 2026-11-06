// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

/// @dev Testnet-only settable price feed mimicking AggregatorV3Interface.
///      Price is 8-decimal USD (same scale as Chainlink USD feeds).
///      Deploy once, call setPrice() before each demo run.
contract TestPriceFeed {
    uint8   public constant decimals = 8;
    address public          owner;
    int256  public          price;

    event PriceSet(int256 indexed newPrice, address indexed setter);

    error Unauthorized();
    error InvalidPrice();

    constructor(int256 _initialPrice) {
        if (_initialPrice <= 0) revert InvalidPrice();
        owner = msg.sender;
        price = _initialPrice;
    }

    function setPrice(int256 _price) external {
        if (msg.sender != owner) revert Unauthorized();
        if (_price <= 0) revert InvalidPrice();
        price = _price;
        emit PriceSet(_price, msg.sender);
    }

    function transferOwnership(address newOwner) external {
        if (msg.sender != owner) revert Unauthorized();
        if (newOwner == address(0)) revert Unauthorized();
        owner = newOwner;
    }

    function latestRoundData() external view returns (
        uint80  roundId,
        int256  answer,
        uint256 startedAt,
        uint256 updatedAt,
        uint80  answeredInRound
    ) {
        return (1, price, block.timestamp, block.timestamp, 1);
    }
}
