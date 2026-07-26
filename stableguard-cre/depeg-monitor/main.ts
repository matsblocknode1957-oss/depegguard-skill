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
  encodeCallMsg,
  prepareReportRequest,
  ok,
  json,
} from "@chainlink/cre-sdk"
import {
  parseAbi,
  encodeFunctionData,
  decodeFunctionResult,
  encodeAbiParameters,
  parseAbiParameters,
  type Address,
  type Hex,
} from "viem"
import { hmacSha256, toHex, hexToBytes, encodeUtf8 } from "./hmac.js"

// ── Types ──────────────────────────────────────────────────────────────────────

type CoinConfig = {
  symbol: string
  address: string  // mainnet address used as identifier in StableGuardMonitor
  feedId: string   // Data Streams stream ID — NEED: verify at docs.chain.link/data-streams/crypto-feeds
}

type Config = {
  schedule: string
  chainSelectorName: string
  consumerAddress: string   // StableGuardCREReceiver (deploy before testnet use)
  monitorAddress: string    // StableGuardMonitor on Sepolia
  dataStreamsBaseUrl: string
  coins: CoinConfig[]
}

type DSReport = {
  feedID: string
  price: string            // int192 as decimal string, 18-decimal places
  validFromTimestamp: number
  fullReport: string       // hex-encoded signed report bytes for IVerifierProxy.verify()
}

type CoinResult = {
  symbol: string
  address: `0x${string}`
  price18: bigint
  deviationBps: bigint
  signalLevel: number      // 0=STABLE 1=WATCH 2=HEDGE 3=EXIT
  fullReport: `0x${string}`
}

type AllReportsPayload = { reportsJson: string }

// ── ABIs ──────────────────────────────────────────────────────────────────────

// StableGuardMonitor ABI — deployed contract uses COOLDOWN() constant (selector 0xa2724a4d)
const monitorAbi = parseAbi([
  "function COOLDOWN() external view returns (uint256)",
])

// ── Constants ─────────────────────────────────────────────────────────────────

const SEPOLIA_CHAIN_SELECTOR = 16015286601757825753n
const ONE_USD    = 1_000_000_000_000_000_000n   // 1e18: Data Streams 18-decimal parity
const STUB_REPORT = "0x" + "00".repeat(32)       // 32 zero bytes — adapter skips onchain verify
const ZERO_ADDR  = "0x0000000000000000000000000000000000000000" as Address

// Stub offsets for simulation without real DS credentials (all within STABLE range)
const STUB_OFFSETS: Record<string, bigint> = {
  USDC: 5_000_000_000_000_000n,   // +5 bps
  USDT: -3_000_000_000_000_000n,  // -3 bps
  DAI:  2_000_000_000_000_000n,   // +2 bps
  USDS: 1_000_000_000_000_000n,   // +1 bps
}

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
  return toHex(hmacSha256(hexToBytes(clientSecret), encodeUtf8(message)))
}

function calcDeviationBps(price18: bigint): bigint {
  const diff = price18 >= ONE_USD ? price18 - ONE_USD : ONE_USD - price18
  return (diff * 10_000n) / ONE_USD
}

function classifySignal(bps: bigint): number {
  if (bps < 20n)  return 0  // STABLE
  if (bps < 50n)  return 1  // WATCH
  if (bps < 100n) return 2  // HEDGE
  return 3                   // EXIT
}

// ── Handler ───────────────────────────────────────────────────────────────────

const onCronTrigger = (runtime: Runtime<Config>): string => {
  const httpClient = new HTTPClient()
  const evmClient  = new EVMClient(SEPOLIA_CHAIN_SELECTOR)

  const clientId     = runtime.getSecret({ id: "DS_CLIENT_ID" }).result().value
  const clientSecret = runtime.getSecret({ id: "DS_CLIENT_SECRET" }).result().value
  const isStub       = clientId === "stub"
  const nowSec       = Math.floor(runtime.now().getTime() / 1000)
  const baseUrl      = runtime.config.dataStreamsBaseUrl
  const coins        = runtime.config.coins

  // ── Step 1: Fetch all Data Streams reports via node-mode consensus ──

  const { reportsJson } = runtime.runInNodeMode(
    (nodeRuntime: NodeRuntime<Config>): AllReportsPayload => {
      const reports: DSReport[] = []

      for (const coin of coins) {
        if (isStub) {
          const offset = STUB_OFFSETS[coin.symbol] ?? 0n
          reports.push({
            feedID:             coin.feedId,
            price:              (ONE_USD + offset).toString(),
            validFromTimestamp: nowSec,
            fullReport:         STUB_REPORT,
          })
          continue
        }

        const path  = "/v1/reports/single"
        const query = `feedID=${coin.feedId}&timestamp=${nowSec}`
        const sig   = buildDSSignature(clientId, clientSecret, "GET", path, query, nowSec)

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
          throw new Error(`DS ${coin.symbol}: HTTP ${response.statusCode}`)
        }

        const body = json(response) as { report: DSReport }
        reports.push(body.report)
      }

      return { reportsJson: JSON.stringify(reports) }
    },
    ConsensusAggregationByFields<AllReportsPayload>({ reportsJson: identical }),
  )().result()

  const dsReports = JSON.parse(reportsJson) as DSReport[]

  // ── Step 2: Read COOLDOWN constant from StableGuardMonitor ──
  const cooldownCallData = encodeFunctionData({
    abi: monitorAbi, functionName: "COOLDOWN",
  }) as Hex

  const cooldownReply = evmClient.callContract(runtime, {
    call: encodeCallMsg({ from: ZERO_ADDR, to: runtime.config.monitorAddress as Address, data: cooldownCallData }),
  }).result()

  const cooldownSec = decodeFunctionResult({
    abi:          monitorAbi,
    functionName: "COOLDOWN",
    data:         uint8ArrayToHex(cooldownReply.data),
  }) as bigint

  // ── Step 3: Score each coin ──

  const results: CoinResult[] = coins.map((coin, i) => {
    const report  = dsReports[i]!
    const raw     = BigInt(report.price)
    const price18 = raw >= 0n ? raw : -raw   // abs — DS prices are never negative for stablecoins
    const bps     = calcDeviationBps(price18)
    const signal  = classifySignal(bps)

    runtime.log(
      `[DS] ${coin.symbol}: ${bps}bps → ${["STABLE", "WATCH", "HEDGE", "EXIT"][signal]}`
    )

    return {
      symbol:       coin.symbol,
      address:      coin.address as `0x${string}`,
      price18,
      deviationBps: bps,
      signalLevel:  signal,
      fullReport:   report.fullReport as `0x${string}`,
    }
  })

  // ── Step 4: Cooldown filter — HEDGE+ coins only ──
  // lastTriggered is enforced onchain in StableGuardCREReceiver.onReport();
  // we forward all HEDGE+ coins and let the receiver apply the cooldown guard.
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
      signal:       ["STABLE", "WATCH", "HEDGE", "EXIT"][r.signalLevel],
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
