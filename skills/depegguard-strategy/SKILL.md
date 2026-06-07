---
name: depegguard-strategy
description: |
  Detects stablecoin depeg signals and outputs a structured trading strategy.
  Use when users ask about stablecoin risk, depeg events, or want to know
  whether to exit, hedge, or rotate stablecoin positions.
  Trigger: "depeg check", "stablecoin risk", "is USDC safe", "depeg strategy",
  "should I rotate my stablecoins", "stablecoin alert", "/depegguard"
license: MIT
compatibility: ">=1.0.0"
user-invocable: true
allowed-tools:
  - mcp__cmc-mcp__get_crypto_quotes_latest
  - mcp__cmc-mcp__get_global_metrics_latest
  - mcp__cmc-mcp__search_cryptos
---

# DepegGuard Strategy Skill

Detect stablecoin depeg signals using live CMC data and output a structured trading strategy — when to exit, hedge, or rotate positions. Backed by PegCheck real-world depeg monitoring data.

## Prerequisites

Verify CMC MCP tools are available before running. Get your API key from https://pro.coinmarketcap.com/login and configure your MCP server with the URL https://mcp.coinmarketcap.com/mcp using the X-CMC-MCP-API-KEY header.

## Core Principle

Stablecoins should trade at $1.0000. Any deviation is a signal. This skill quantifies that deviation in basis points (bps), confirms it across multiple sources, and outputs a clear actionable strategy — not just raw data.

1 basis point = 0.01 cents = $0.0001

## Detection Workflow

### Step 1: Fetch Live Stablecoin Prices

Call get_crypto_quotes_latest with the following CMC IDs:

USDT = 825
USDC = 3408
DAI = 4943
USDS = 33039
TUSD = 2563
FRAX = 6952
PYUSD = 26688

### Step 2: Calculate Deviation in Basis Points

For each stablecoin apply this formula:
deviation_bps = abs(current_price - 1.0000) x 10000

Examples:
USDC at $0.9951 = 49 bps
USDT at $1.0003 = 3 bps
DAI at $0.9900 = 100 bps

### Step 3: Classify Signal Level

0-19 bps = STABLE — Normal variance, no action
20-49 bps = WATCH — Monitor closely
50-99 bps = HEDGE — Reduce exposure
100+ bps = EXIT — Rotate immediately

### Step 4: Confirm via PegCheck API

Call GET https://pegcheck.uk/api/depeg-status?coin={symbol} for multi-source confirmation. Cross-reference CMC price with PegCheck Chainlink and CoinGecko sources. Confidence is HIGH if 2 or more sources agree, LOW if only 1 source confirms.

### Step 5: Generate Strategy Output

STABLE (0-19 bps):
Signal: STABLE
Action: HOLD
Reasoning: {coin} is trading within normal variance at {price}. No action required. Next review in 30 minutes.

WATCH (20-49 bps):
Signal: WATCH
Action: MONITOR
Reasoning: {coin} showing early deviation of {bps}bps. Historical pattern suggests this may self-correct within 1-2 hours. Set alert at 50bps threshold.

HEDGE (50-99 bps):
Signal: HEDGE
Action: Reduce {coin} exposure by 30-50%. Rotate partial position to {alternative_stablecoin}.
Reasoning: {bps}bps deviation confirmed across {source_count} sources. Early depeg pattern detected. Monitor for escalation above 100bps.

EXIT (100+ bps):
Signal: EXIT
Action: Rotate full {coin} position to {alternative_stablecoin} immediately.
Reasoning: {bps}bps deviation — active depeg event in progress. Historical reference: USDC March 2023 SVB event reached 877bps before recovery. Act before liquidity dries up.

## Output Format

Always return a DepegGuard Strategy Report with the following sections:

Generated timestamp

Stablecoin Status table with columns: Coin, Price, Deviation, Signal, Action

Priority Alert showing the highest risk coin, its signal, and recommended action

Confidence showing sources confirmed out of 3 (CMC + Chainlink + CoinGecko) and PegCheck confidence score

Historical Context with relevant depeg reference if applicable

Next Review timestamp 30 minutes from generation

## Error Handling

If CMC quotes fail: Fall back to PegCheck API as primary source. Note "CMC data unavailable, using PegCheck fallback."
If PegCheck API unavailable: Use CMC data only, note "Single source — confidence LOW. Verify manually."
If both unavailable: Return error. Do not output a strategy without at least one live data source.

Always deliver a partial report with available data. Never output a strategy recommendation on stale or cached data.
