import {
  CronCapability,
  EVMClient,
  handler,
  Runner,
  type Runtime,
  prepareReportRequest,
} from "@chainlink/cre-sdk"
import {
  encodeAbiParameters,
  parseAbiParameters,
} from "viem"
import {
  type CoinConfig,
  calcDeviationBps,
  classifySignal,
  hexToBytes,
  bytesToHexStr,
  decodePriceFeedAnswer,
  selectFeedAddress,
} from "./helpers.js"

// ── Types ──────────────────────────────────────────────────────────────────────

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

const ONE_USD = 1_000_000_000_000_000_000n

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

function hexToBase64(hex: string): string {
  const bytes = hexToBytes(hex)
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/"
  let out = ""
  for (let i = 0; i < bytes.length; i += 3) {
    const a = bytes[i]!
    const b = i + 1 < bytes.length ? bytes[i + 1]! : 0
    const c = i + 2 < bytes.length ? bytes[i + 2]! : 0
    out += chars[a >> 2]!
    out += chars[((a & 3) << 4) | (b >> 4)]!
    out += i + 1 < bytes.length ? chars[((b & 15) << 2) | (c >> 6)]! : "="
    out += i + 2 < bytes.length ? chars[c & 63]! : "="
  }
  return out
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
