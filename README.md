# DepegGuard Strategy Skill

## Why This Exists

In May 2022 the UST/Terra collapse wiped out $40 billion in days. There was no early warning system, no automated protection, no structured signal telling people to exit before liquidity dried up. DepegGuard was built because that shouldn't happen again. It turns depeg signals into actionable strategy — before liquidity dries up.

A CMC Agent Hub Strategy Skill that detects stablecoin depeg signals and outputs structured trading strategies — when to exit, hedge, or rotate stablecoin positions.

![DepegGuard Stack Diagram](./stack-diagram.png.jpg)

Built for the BNB HACK: AI Trading Agent Edition hackathon.

## What it does

- Monitors 7 major stablecoins in real time via CMC Agent Hub
- Calculates deviation from $1.00 peg in basis points
- Classifies signals: STABLE / WATCH / HEDGE / EXIT
- Confirms signals via PegCheck multi-source data (Chainlink + CoinGecko + CMC)
- Outputs a structured trading strategy with reasoning and historical context

## Signal Levels

| Deviation | Signal | Action |
|-----------|--------|--------|
| 0-19 bps  | STABLE | HOLD |
| 20-49 bps | WATCH  | MONITOR |
| 50-99 bps | HEDGE  | Reduce exposure 30-50% |
| 100+ bps  | EXIT   | Rotate immediately |

## Powered by

- CoinMarketCap Agent Hub — live stablecoin price data
- PegCheck (pegcheck.uk) — real-world multi-source depeg monitoring with Chainlink Price Feeds
- 19 stablecoins monitored, historical depeg data since 2024

## Installation

See skills/depegguard-strategy/SKILL.md for full integration guide.

## Live Data

PegCheck API: https://pegcheck.uk/api/depeg-status?coin={symbol}

## Hackathon

BNB HACK: AI Trading Agent Edition — Track 2: Strategy Skills
DoraHacks: https://dorahacks.io/hackathon/bnbhack-twt-cmc

## License

MIT
