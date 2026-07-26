// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

/**
 * StableGuardCREReceiver
 *
 * Receives ABI-encoded depeg reports from the StableGuard CRE workflow via
 * the KeystoneForwarder. Decodes and stores the latest composite signal state,
 * emitting events for offchain indexers.
 *
 * Constructor arg (forwarder):
 *   Broadcast simulation : 0x15fC6ae953E024d975e77382eEeC56A9101f9F88  (MockKeystoneForwarder, Sepolia)
 *   Production           : 0xF8344CFd5c43616a4366C34E3EEE75af79a74482  (KeystoneForwarder, Sepolia)
 *
 * Payload schema (matches main.ts encodeAbiParameters call):
 *   address[] coins, uint256[] prices, uint256[] deviationsBps,
 *   uint8[] signalLevels, bytes[] fullReports,
 *   uint8 compositeScore, uint8 marketStress, uint256 observedAt
 */
contract StableGuardCREReceiver {
    address public immutable forwarder;

    uint8   public lastCompositeScore;
    uint8   public lastMarketStress;
    uint256 public lastObservedAt;
    uint256 public reportCount;

    struct CoinSignal {
        address coin;
        uint256 price;
        uint256 deviationBps;
        uint8   signalLevel;
    }

    CoinSignal[] public lastCoins;

    event DepegReport(
        uint256 indexed reportIndex,
        uint8   compositeScore,
        uint8   marketStress,
        uint256 observedAt
    );

    event CoinAlert(
        uint256 indexed reportIndex,
        address indexed coin,
        uint256 deviationBps,
        uint8   signalLevel
    );

    error UnauthorizedForwarder(address caller);

    constructor(address _forwarder) {
        forwarder = _forwarder;
    }

    function onReport(bytes calldata metadata, bytes calldata report) external {
        if (msg.sender != forwarder) revert UnauthorizedForwarder(msg.sender);
        // metadata intentionally unused — forwarder check is the access control boundary

        (
            address[] memory coins,
            uint256[] memory prices,
            uint256[] memory deviationsBps,
            uint8[]   memory signalLevels,
            bytes[]   memory fullReports,   // decoded but not stored (gas efficiency)
            uint8  compositeScore,
            uint8  marketStress,
            uint256 observedAt
        ) = abi.decode(
            report,
            (address[], uint256[], uint256[], uint8[], bytes[], uint8, uint8, uint256)
        );

        // suppress unused-var warning for fullReports
        fullReports;

        uint256 idx = reportCount++;
        lastCompositeScore = compositeScore;
        lastMarketStress   = marketStress;
        lastObservedAt     = observedAt;

        delete lastCoins;
        for (uint256 i = 0; i < coins.length; i++) {
            lastCoins.push(CoinSignal({
                coin:         coins[i],
                price:        prices[i],
                deviationBps: deviationsBps[i],
                signalLevel:  signalLevels[i]
            }));
            if (signalLevels[i] >= 1) {
                emit CoinAlert(idx, coins[i], deviationsBps[i], signalLevels[i]);
            }
        }

        emit DepegReport(idx, compositeScore, marketStress, observedAt);
    }

    function getLastCoins() external view returns (CoinSignal[] memory) {
        return lastCoins;
    }
}
