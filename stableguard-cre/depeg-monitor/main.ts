import {
  CronCapability,
  EVMClient,
  handler,
  Runner,
  type Runtime,
  prepareReportRequest,
} from "@chainlink/cre-sdk"
import {
  decodeAbiParameters,
  encodeAbiParameters,
  parseAbiParameters,
} from "viem"
import { calcDeviationBps, classifySignal } from "./helpers.js"

// ── Types ──────────────────────────────────────────────────────────────────────

type CoinConfig = {
  symbol:           string
  address:          string   // mainnet address — chain-agnostic coin identifier
  priceFeedAddress?: string  // Chainlink AggregatorV3 (latestRoundData) on target chain
  demoFeedAddress?:  string  // TestPriceFeed override (settable); takes precedence over priceFeedAddress
}

type Config = {
  schedule:          string
  chainSelectorName: string
  consumerAddress:   string
  chainSelector:     string  // CCIP chain selector as decimal string
  coins:             CoinConfig[]
  stubScenario?:     string  // "depeg" → offline stub prices; no on-chain reads
}

type CoinResult = {
  symbol:       string
  address:      `0x${string}`
  price18:      bigint
  deviationBps: bigint
  signalLevel:  number   // 0=STABLE 1=WATCH 2=ELEVATED 3=CRITICAL
}

// ── Constants ─────────────────────────────────────────────────────────────────

const ONE_USD = 1_000_000_000_000_000_000n   // 1e18

// Stub offsets for offline simulation without chain access (all STABLE)
const STUB_OFFSETS: Record<string, bigint> = {
  USDC:   500_000_000_000_000n,   // +5 bps
  USDT:  -300_000_000_000_000n,   // -3 bps
  DAI:    200_000_000_000_000n,   // +2 bps
  USDS:   100_000_000_000_000n,   // +1 bps
}

// Staging depeg scenario: USDC 3% below peg → 300 bps → CRITICAL
const STUB_DEPEG_USDC_OFFSET = -30_000_000_000_000_000n

// latestRoundData() = keccak256("latestRoundData()")[0:4]
const LATEST_ROUND_DATA_SEL = "feaf968c"

// ── Helpers ───────────────────────────────────────────────────────────────────

export function hexToBytes(hex: string): Uint8Array {
  const clean = hex.startsWith("0x") ? hex.slice(2) : hex
  const bytes = new Uint8Array(clean.length / 2)
  for (let i = 0; i < clean.length; i += 2) {
    bytes[i / 2] = parseInt(clean.slice(i, i + 2), 16)
  }
  return bytes
}

function bytesToHexStr(bytes: Uint8Array): `0x${string}` {
  let hex = "0x"
  for (let i = 0; i < bytes.length; i++) {
    hex += bytes[i]!.toString(16).padStart(2, "0")
  }
  return hex as `0x${string}`
}

function hexToBase64(hex: string): string {
  const bytes = hexToBytes(hex)
  let binary = ""
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]!)
  return btoa(binary)
}

/** Returns demoFeedAddress when set, else priceFeedAddress. Used by handler and tests. */
export function selectFeedAddress(coin: CoinConfig): string | undefined {
  return coin.demoFeedAddress ?? coin.priceFeedAddress
}

/**
 * Decodes a latestRoundData() ABI reply (uint80,int256,uint256,uint256,uint80)
 * and scales the 8-decimal USD answer to 18 decimals.
 * Exported for unit tests.
 */
export function decodePriceFeedAnswer(data: Uint8Array): bigint {
  const [, answer] = decodeAbiParameters(
    parseAbiParameters("uint80, int256, uint256, uint256, uint80"),
    bytesToHexStr(data),
  )
  return answer > 0n ? answer * 10_000_000_000n : 0n
}

function readPriceFeed(
  evmClient: EVMClient,
  runtime:   Runtime<Config>,
  feedAddr:  string,
): bigint {
  const reply = evmClient.callContract(runtime, {
    call: {
      from: hexToBase64("00".repeat(20)),
      to:   hexToBase64(feedAddr),
      data: hexToBase64(LATEST_ROUND_DATA_SEL),
    },
  }).result()
  return decodePriceFeedAnswer(reply.data)
}

function uint8ArrayToHex(bytes: Uint8Array): `0x${string}` {
  return bytesToHexStr(bytes)
}

// ── Handler ───────────────────────────────────────────────────────────────────

const onCronTrigger = (runtime: Runtime<Config>): string => {
  const evmClient = new EVMClient(BigInt(runtime.config.chainSelector))
  const nowSec    = Math.floor(runtime.now().getTime() / 1000)
  const coins     = runtime.config.coins
  const isStub    = !!runtime.config.stubScenario

  const results:    CoinResult[]              = []
  const skipErrors: Record<string, string>    = {}

  for (const coin of coins) {
    let price18: bigint

    if (isStub) {
      let offset = STUB_OFFSETS[coin.symbol] ?? 0n
      if (runtime.config.stubScenario === "depeg" && coin.symbol === "USDC") {
        offset = STUB_DEPEG_USDC_OFFSET
      }
      price18 = ONE_USD + offset

    } else {
      const feedAddress = selectFeedAddress(coin)
      if (!feedAddress || feedAddress.startsWith("REPLACE_")) {
        skipErrors[coin.symbol] = "priceFeedAddress not configured"
        continue
      }
      try {
        price18 = readPriceFeed(evmClient, runtime, feedAddress)
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        skipErrors[coin.symbol] = msg
        runtime.log(`[FEED] ${coin.symbol}: callContract failed (${msg}) — skipped`)
        continue
      }
    }

    const bps    = calcDeviationBps(price18)
    const signal = classifySignal(bps)
    runtime.log(
      `[PRICE] ${coin.symbol}: ${bps}bps → ${["STABLE", "WATCH", "ELEVATED", "CRITICAL"][signal]}`
    )

    results.push({
      symbol:       coin.symbol,
      address:      coin.address as `0x${string}`,
      price18,
      deviationBps: bps,
      signalLevel:  signal,
    })
  }

  for (const [sym, reason] of Object.entries(skipErrors)) {
    runtime.log(`[SKIP] ${sym}: ${reason}`)
  }

  if (results.length === 0) {
    runtime.log("No coins with valid prices — aborting report")
    return JSON.stringify({ error: "no coins with valid prices" })
  }

  // ── Composite risk score ────────────────────────────────────────────────────

  const compositeScore = results.reduce((m, r) => Math.max(m, r.signalLevel), 0)
  const atWatch        = results.filter(r => r.signalLevel >= 1).length
  const marketStress   = atWatch >= 4 ? 2 : atWatch >= 2 ? 1 : 0

  runtime.log(`Composite=${compositeScore} stress=${marketStress}`)

  // ── ABI-encode payload for StableGuardCREReceiver.onReport() ───────────────

  const encoded = encodeAbiParameters(
    parseAbiParameters(
      "address[] coins, uint256[] prices, uint256[] deviationsBps, uint8[] signalLevels, bytes[] fullReports, uint8 compositeScore, uint8 marketStress, uint256 observedAt"
    ),
    [
      results.map(r => r.address),
      results.map(r => r.price18),
      results.map(r => r.deviationBps),
      results.map(r => r.signalLevel),
      results.map(r => "0x" as `0x${string}`),
      compositeScore,
      marketStress,
      BigInt(nowSec),
    ]
  )

  // ── Sign via DON consensus and write on-chain ───────────────────────────────

  const signedReport = runtime.report(prepareReportRequest(encoded)).result()

  const tx = evmClient.writeReport(runtime, {
    receiver:  runtime.config.consumerAddress,
    report:    signedReport,
    gasConfig: { gasLimit: "2000000" },
  }).result()

  const txHashHex = tx.txHash ? uint8ArrayToHex(tx.txHash) : "none"
  runtime.log(`TX: ${txHashHex} status: ${tx.txStatus}`)

  return JSON.stringify({
    txHash:        txHashHex,
    txStatus:      tx.txStatus,
    compositeScore,
    marketStress,
    coins: results.map(r => ({
      symbol:       r.symbol,
      deviationBps: r.deviationBps.toString(),
      signal:       ["STABLE", "WATCH", "ELEVATED", "CRITICAL"][r.signalLevel],
    })),
  })
}

// ── Workflow registration ──────────────────────────────────────────────────────

const initWorkflow = (config: Config) => {
  const cron = new CronCapability()
  return [handler(cron.trigger({ schedule: config.schedule }), onCronTrigger)]
}

export async function main() {
  const runner = await Runner.newRunner<Config>()
  await runner.run(initWorkflow)
}
