import {
  CronCapability,
  EVMClient,
  HTTPClient,
  handler,
  Runner,
  type Runtime,
  type NodeRuntime,
  ConsensusAggregationByFields,
  identical,
  prepareReportRequest,
  ok,
  json,
} from "@chainlink/cre-sdk"
import {
  encodeAbiParameters,
  parseAbiParameters,
} from "viem"
import { hmacSha256, toHex, encodeUtf8 } from "./hmac.js"
import { calcDeviationBps, classifySignal } from "./helpers.js"

// ── Types ──────────────────────────────────────────────────────────────────────

type CoinConfig = {
  symbol: string
  address: string  // mainnet address used as coin identifier (chain-agnostic key)
  feedId: string   // Data Streams stream ID
}

type Config = {
  schedule: string
  chainSelectorName: string
  consumerAddress: string
  chainSelector: string        // CCIP chain selector as decimal string (JSON-safe)
  dataStreamsBaseUrl: string
  coins: CoinConfig[]
  stubScenario?: string        // staging-only: "depeg" exercises CRITICAL→freeze path
}

type DSReport = {
  feedID: string
  price: string            // int192 as decimal string, 18-decimal places
  validFromTimestamp: number
  fullReport: string       // hex-encoded signed report bytes for IVerifierProxy.verify()
}

// CoinReport bundles coin identity with its DS report so that when a fetch is
// skipped (coin not in subscription, HTTP error, etc.) the indices between
// coins[] and reports[] never go out of sync.
type CoinReport = {
  symbol:  string
  address: string
  report:  DSReport
}

type CoinResult = {
  symbol: string
  address: `0x${string}`
  price18: bigint
  deviationBps: bigint
  signalLevel: number      // 0=STABLE 1=WATCH 2=ELEVATED 3=CRITICAL
  fullReport: `0x${string}`
}

type AllReportsPayload = { reportsJson: string; skipsJson: string }

// ── Constants ─────────────────────────────────────────────────────────────────

const ONE_USD    = 1_000_000_000_000_000_000n   // 1e18: Data Streams 18-decimal parity
const STUB_REPORT = "0x" + "00".repeat(32)       // 32 zero bytes — adapter skips onchain verify

// Stub offsets for simulation without real DS credentials (all within STABLE range)
// 1 bps = 1e14; values must stay < 20 bps (< 2e15) to avoid spurious WATCH/ELEVATED signals
const STUB_OFFSETS: Record<string, bigint> = {
  USDC:   500_000_000_000_000n,   // +5 bps
  USDT:  -300_000_000_000_000n,   // -3 bps
  DAI:    200_000_000_000_000n,   // +2 bps
  USDS:   100_000_000_000_000n,   // +1 bps
}

// Staging depeg scenario: USDC 3% below peg → 300 bps → CRITICAL
const STUB_DEPEG_USDC_OFFSET = -30_000_000_000_000_000n

// ── Helpers ───────────────────────────────────────────────────────────────────

function uint8ArrayToHex(bytes: Uint8Array): `0x${string}` {
  let hex = "0x"
  for (let i = 0; i < bytes.length; i++) {
    hex += bytes[i]!.toString(16).padStart(2, "0")
  }
  return hex as `0x${string}`
}

function buildDSSignature(
  clientId: string,
  clientSecret: string,
  method: string,
  path: string,
  query: string,
  ts: number,
): string {
  // HMAC-SHA256 over: METHOD + PATH + QUERY + CLIENT_ID + TIMESTAMP
  // See: https://docs.chain.link/data-streams/reference/authentication
  const message = `${method}${path}${query}${clientId}${ts}`
  return toHex(hmacSha256(encodeUtf8(clientSecret), encodeUtf8(message)))
}

// ── Handler ───────────────────────────────────────────────────────────────────

const onCronTrigger = (runtime: Runtime<Config>): string => {
  const httpClient = new HTTPClient()
  const evmClient  = new EVMClient(BigInt(runtime.config.chainSelector))

  const clientId     = runtime.getSecret({ id: "DS_CLIENT_ID" }).result().value
  const clientSecret = runtime.getSecret({ id: "DS_CLIENT_SECRET" }).result().value
  const isStub       = clientId === "stub"
  const nowSec       = Math.floor(runtime.now().getTime() / 1000)
  const baseUrl      = runtime.config.dataStreamsBaseUrl
  const coins        = runtime.config.coins

  // ── Step 1: Fetch all Data Streams reports via node-mode consensus ──
  // Per-coin try/catch: a missing subscription or transient HTTP error skips
  // that coin entirely — the run continues with whatever coins did respond.
  // We never push a fake price or default to STABLE for a failed fetch.

  const { reportsJson, skipsJson } = runtime.runInNodeMode(
    (nodeRuntime: NodeRuntime<Config>): AllReportsPayload => {
      const coinReports: CoinReport[] = []
      const skipErrors: Record<string, string> = {}

      for (const coin of coins) {
        if (isStub) {
          let offset = STUB_OFFSETS[coin.symbol] ?? 0n
          if (runtime.config.stubScenario === "depeg" && coin.symbol === "USDC") {
            offset = STUB_DEPEG_USDC_OFFSET
          }
          coinReports.push({
            symbol:  coin.symbol,
            address: coin.address,
            report:  {
              feedID:             coin.feedId,
              price:              (ONE_USD + offset).toString(),
              validFromTimestamp: nowSec,
              fullReport:         STUB_REPORT,
            },
          })
          continue
        }

        const path  = "/v1/reports/single"
        const query = `feedID=${coin.feedId}&timestamp=${nowSec}`
        const sig   = buildDSSignature(clientId, clientSecret, "GET", path, query, nowSec)

        try {
          const response = httpClient.sendRequest(nodeRuntime, {
            url:    `${baseUrl}${path}?${query}`,
            method: "GET",
            multiHeaders: {
              "Authorization":                    { values: [clientId] },
              "X-Authorization-Timestamp":        { values: [nowSec.toString()] },
              "X-Authorization-Signature-SHA256": { values: [sig] },
            },
          }).result()

          if (!ok(response)) {
            throw new Error(`HTTP ${response.statusCode}`)
          }

          const body = json(response) as { report: DSReport }
          coinReports.push({
            symbol:  coin.symbol,
            address: coin.address,
            report:  body.report,
          })
        } catch (err) {
          skipErrors[coin.symbol] = err instanceof Error ? err.message : String(err)
        }
      }

      return { reportsJson: JSON.stringify(coinReports), skipsJson: JSON.stringify(skipErrors) }
    },
    ConsensusAggregationByFields<AllReportsPayload>({ reportsJson: identical, skipsJson: identical }),
  )().result()

  const coinReports = JSON.parse(reportsJson) as CoinReport[]
  const skipErrors  = JSON.parse(skipsJson) as Record<string, string>

  // Log any coins that were skipped due to fetch failures
  const fetched = new Set(coinReports.map(cr => cr.symbol))
  for (const coin of coins) {
    if (!fetched.has(coin.symbol)) {
      const reason = skipErrors[coin.symbol] ?? "unknown error"
      runtime.log(`[DS SKIP] ${coin.symbol}: fetch failed (${reason}) — excluded from this report`)
    }
  }

  // ── Step 2: Cooldown constant (was an on-chain read; hardcoded to match deployed contract) ──
  const cooldownSec = 300n

  // ── Step 3: Score each coin ──

  const results: CoinResult[] = coinReports.map(({ symbol, address, report }) => {
    const raw     = BigInt(report.price)
    const price18 = raw >= 0n ? raw : -raw   // abs — DS prices are never negative for stablecoins
    const bps     = calcDeviationBps(price18)
    const signal  = classifySignal(bps)

    runtime.log(
      `[DS] ${symbol}: ${bps}bps → ${["STABLE", "WATCH", "ELEVATED", "CRITICAL"][signal]}`
    )

    return {
      symbol,
      address:      address as `0x${string}`,
      price18,
      deviationBps: bps,
      signalLevel:  signal,
      fullReport:   report.fullReport as `0x${string}`,
    }
  })

  // ── Step 4: Cooldown filter — ELEVATED+ coins only ──
  const triggerable = results.filter(r => r.signalLevel >= 2)

  runtime.log(`cooldownSec=${cooldownSec} triggerable=${triggerable.length}`)

  // ── Step 5: Composite risk score (SKILL.md signal ladder) ──

  const compositeScore = results.reduce((m, r) => Math.max(m, r.signalLevel), 0)
  const atWatch        = results.filter(r => r.signalLevel >= 1).length
  const marketStress   = atWatch >= 4 ? 2 : atWatch >= 2 ? 1 : 0

  runtime.log(`Composite=${compositeScore} stress=${marketStress}`)

  // ── Step 6: ABI-encode payload for StableGuardCREReceiver.onReport() ──

  const encoded = encodeAbiParameters(
    parseAbiParameters(
      "address[] coins, uint256[] prices, uint256[] deviationsBps, uint8[] signalLevels, bytes[] fullReports, uint8 compositeScore, uint8 marketStress, uint256 observedAt"
    ),
    [
      results.map(r => r.address),
      results.map(r => r.price18),
      results.map(r => r.deviationBps),
      results.map(r => r.signalLevel),
      results.map(r => r.fullReport),
      compositeScore,
      marketStress,
      BigInt(nowSec),
    ]
  )

  // ── Step 7: Sign via DON consensus and write onchain ──

  const signedReport = runtime.report(prepareReportRequest(encoded)).result()

  const tx = evmClient.writeReport(runtime, {
    receiver:  runtime.config.consumerAddress,
    report:    signedReport,
    gasConfig: { gasLimit: "900000" },
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
