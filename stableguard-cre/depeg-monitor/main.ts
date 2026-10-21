import {
  CronCapability,
  EVMClient,
  HTTPClient,
  handler,
  Runner,
  type Runtime,
  type NodeRuntime,
  ConsensusAggregationByFields,
  median,
  prepareReportRequest,
  ok,
  json,
  encodeCallMsg,
  LAST_FINALIZED_BLOCK_NUMBER,
} from "@chainlink/cre-sdk"
import {
  encodeAbiParameters,
  parseAbiParameters,
  encodeFunctionData,
  decodeAbiParameters,
} from "viem"
import { hmacSha256, toHex, encodeUtf8 } from "./hmac.js"
import {
  calcDeviationBps,
  classifySignal,
  medianOf,
  spreadBps,
  agreementLevel,
  applyAgreementCap,
  type AgreementLevel,
} from "./helpers.js"

// ── Types ──────────────────────────────────────────────────────────────────────

type CoinConfig = {
  symbol:        string
  address:       string          // mainnet address used as coin identifier
  feedId:        string          // Data Streams stream ID
  coingeckoId:   string          // CoinGecko coin ID
  defillamaId:   string          // DefiLlama key: "coingecko:<id>"
  clFeedAddress?: string         // Chainlink on-chain price feed (mainnet), optional
}

type Config = {
  schedule:          string
  chainSelectorName: string
  consumerAddress:   string
  chainSelector:     string
  dataStreamsBaseUrl: string
  coins:             CoinConfig[]
  stubScenario?:     string      // "normal" | "depeg" | "disagree" | "live" | undefined
}

type DSReport = {
  feedID:             string
  price:              string    // int192 as decimal string, 18-decimal
  validFromTimestamp: number
  fullReport:         string
}

// Per-coin node output: each node independently computes median price, spread, and source count.
// Fixed field names for the 4 tracked coins — required for typed ConsensusAggregationByFields.
type NodeOutput = {
  usdc_price:   bigint
  usdc_spread:  bigint
  usdc_sources: number
  usdt_price:   bigint
  usdt_spread:  bigint
  usdt_sources: number
  dai_price:    bigint
  dai_spread:   bigint
  dai_sources:  number
  usds_price:   bigint
  usds_spread:  bigint
  usds_sources: number
}

type CoinResult = {
  symbol:       string
  address:      `0x${string}`
  price18:      bigint
  deviationBps: bigint
  signalLevel:  number
  agreement:    AgreementLevel
}

// ── Constants ─────────────────────────────────────────────────────────────────

const ONE_USD = 1_000_000_000_000_000_000n
const MAINNET_CHAIN_SELECTOR = 5009297550715157269n

// Chainlink AggregatorV3Interface latestRoundData() — 8-decimal answers
const CL_LATEST_ROUND_ABI = [
  {
    type:            "function" as const,
    name:            "latestRoundData",
    inputs:          [],
    outputs:         [
      { name: "roundId",          type: "uint80"  as const },
      { name: "answer",           type: "int256"  as const },
      { name: "startedAt",        type: "uint256" as const },
      { name: "updatedAt",        type: "uint256" as const },
      { name: "answeredInRound",  type: "uint80"  as const },
    ],
    stateMutability: "view" as const,
  },
]

// Stub price offsets by scenario and source (delta from ONE_USD, in bigint)
// "disagree" DL is absent — only DS and CG are defined — giving USDC exactly 2 sources
const STUB_NORMAL_OFFSETS: Record<string, bigint> = {
  USDC:  500_000_000_000_000n,
  USDT: -300_000_000_000_000n,
  DAI:   200_000_000_000_000n,
  USDS:  100_000_000_000_000n,
}

type StubSrc = Partial<Record<string, bigint>>

const STUB_DS: Record<string, StubSrc> = {
  normal:   { USDC:  500_000_000_000_000n, USDT: -300_000_000_000_000n, DAI:  200_000_000_000_000n, USDS:  100_000_000_000_000n },
  depeg:    { USDC: -30_000_000_000_000_000n, USDT: 0n, DAI: 0n, USDS: 0n },
  disagree: { USDC: -30_000_000_000_000_000n, USDT: 0n, DAI: 0n, USDS: 0n },
}
const STUB_CG: Record<string, StubSrc> = {
  normal:   { USDC:  200_000_000_000_000n, USDT: -100_000_000_000_000n, DAI:  100_000_000_000_000n, USDS:   0n },
  depeg:    { USDC: -30_000_000_000_000_000n, USDT: 0n, DAI: 0n, USDS: 0n },
  disagree: { USDC: 0n, USDT: 0n, DAI: 0n, USDS: 0n },  // CG sees healthy
}
const STUB_DL: Record<string, StubSrc> = {
  normal:   { USDC:  300_000_000_000_000n, USDT: -200_000_000_000_000n, DAI:  150_000_000_000_000n, USDS:  50_000_000_000_000n },
  depeg:    { USDC: -30_000_000_000_000_000n, USDT: 0n, DAI: 0n, USDS: 0n },
  disagree: {},  // DL absent in disagree — simulates timeout for all coins
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
  const message = `${method}${path}${query}${clientId}${ts}`
  return toHex(hmacSha256(encodeUtf8(clientSecret), encodeUtf8(message)))
}

function floatToPrice18(price: number): bigint {
  // Split: price * 1e10 (fits in float53) * 1e8 = price * 1e18
  return BigInt(Math.round(price * 1e10)) * 100_000_000n
}

function fmtPrice(p: bigint): string {
  const s = p.toString().padStart(19, "0")
  return `${s.slice(0, -18) || "0"}.${s.slice(-18, -13)}`
}

// ── Handler ───────────────────────────────────────────────────────────────────

const onCronTrigger = (runtime: Runtime<Config>): string => {
  const httpClient  = new HTTPClient()
  const evmClient   = new EVMClient(BigInt(runtime.config.chainSelector))
  const evmMainnet  = new EVMClient(MAINNET_CHAIN_SELECTOR)

  const clientId     = runtime.getSecret({ id: "DS_CLIENT_ID" }).result().value
  const clientSecret = runtime.getSecret({ id: "DS_CLIENT_SECRET" }).result().value
  const isStub       = clientId === "stub"
  const scenario     = runtime.config.stubScenario ?? "live"
  const isLive       = scenario === "live"
  const nowSec       = Math.floor(runtime.now().getTime() / 1000)
  const baseUrl      = runtime.config.dataStreamsBaseUrl
  const coins        = runtime.config.coins

  // ── Step 1a: Chainlink on-chain reads (handler level — callContract requires Runtime) ──
  // Each DON node independently executes the full handler, so these reads ARE per-node.
  // Results flow into runInNodeMode via the closure below.
  const clPrices: Record<string, bigint> = {}
  if (isLive) {
    const clCallData = encodeFunctionData({
      abi:          CL_LATEST_ROUND_ABI,
      functionName: "latestRoundData",
    })
    for (const c of coins) {
      if (!c.clFeedAddress) continue
      try {
        const reply = evmMainnet.callContract(runtime, {
          call:        encodeCallMsg({
            from: "0x0000000000000000000000000000000000000000",
            to:   c.clFeedAddress as `0x${string}`,
            data: clCallData,
          }),
          blockNumber: LAST_FINALIZED_BLOCK_NUMBER,
        }).result()
        const hex     = uint8ArrayToHex(reply.data)
        const decoded = decodeAbiParameters(
          [
            { name: "roundId",         type: "uint80"  },
            { name: "answer",          type: "int256"  },
            { name: "startedAt",       type: "uint256" },
            { name: "updatedAt",       type: "uint256" },
            { name: "answeredInRound", type: "uint80"  },
          ],
          hex,
        )
        const answer = decoded[1] as bigint
        if (answer > 0n) {
          clPrices[c.symbol] = answer * 10_000_000_000n  // 8→18 decimals
          runtime.log(`[CL] ${c.symbol}: answer=${answer} (8dec)`)
        }
      } catch (err) {
        runtime.log(`[CL SKIP] ${c.symbol}: ${err instanceof Error ? err.message : String(err)}`)
      }
    }
  }

  // ── Step 1b: Per-node multi-source price collection ──

  const consensus = runtime.runInNodeMode(
    (nodeRuntime: NodeRuntime<Config>): NodeOutput => {

      // Per-coin named-source lists — {name, price} per contributing source
      const sourcesPerCoin: Record<string, { name: string; price: bigint }[]> = {}
      for (const c of coins) sourcesPerCoin[c.symbol] = []

      // ── Source: Chainlink on-chain (pre-fetched at handler level, live mode only) ──
      for (const [sym, price] of Object.entries(clPrices)) {
        sourcesPerCoin[sym]?.push({ name: "chainlink", price })
      }

      // ── Source: Data Streams ──
      // Stub DS only in named stub scenarios (normal/depeg/disagree).
      // When isLive (stub credentials + live scenario), skip DS entirely — stub must not count.
      if (isStub && !isLive) {
        const dsSrcs = STUB_DS[scenario] ?? {}
        for (const c of coins) {
          const offset = dsSrcs[c.symbol] ?? STUB_NORMAL_OFFSETS[c.symbol] ?? 0n
          sourcesPerCoin[c.symbol]!.push({ name: "datastreams", price: ONE_USD + offset })
        }
      } else if (!isStub) {
        for (const c of coins) {
          const path  = "/v1/reports/single"
          const query = `feedID=${c.feedId}&timestamp=${nowSec}`
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
            if (!ok(response)) throw new Error(`HTTP ${response.statusCode}`)
            const body  = json(response) as { report: DSReport }
            const raw   = BigInt(body.report.price)
            const price = raw >= 0n ? raw : -raw
            sourcesPerCoin[c.symbol]!.push({ name: "datastreams", price })
          } catch (err) {
            nodeRuntime.log(`[DS SKIP] ${c.symbol}: ${err instanceof Error ? err.message : String(err)}`)
          }
        }
      }

      // ── Source: CoinGecko (batch) ──
      const cgIds = coins.map(c => c.coingeckoId).join(",")
      const useCgStub = isStub && !isLive && (STUB_CG[scenario] !== undefined)

      if (useCgStub) {
        const cgSrcs = STUB_CG[scenario]!
        for (const c of coins) {
          const offset = cgSrcs[c.symbol]
          if (offset !== undefined) sourcesPerCoin[c.symbol]!.push({ name: "coingecko", price: ONE_USD + offset })
        }
      } else {
        try {
          const cgResp = httpClient.sendRequest(nodeRuntime, {
            url:    `https://api.coingecko.com/api/v3/simple/price?ids=${cgIds}&vs_currencies=usd`,
            method: "GET",
          }).result()
          if (!ok(cgResp)) throw new Error(`CoinGecko HTTP ${cgResp.statusCode}`)
          const cgBody = json(cgResp) as Record<string, { usd: number }>
          for (const c of coins) {
            const p = cgBody[c.coingeckoId]?.usd
            if (p !== undefined) sourcesPerCoin[c.symbol]!.push({ name: "coingecko", price: floatToPrice18(p) })
          }
        } catch (err) {
          nodeRuntime.log(`[CG SKIP] ${err instanceof Error ? err.message : String(err)}`)
        }
      }

      // ── Source: DefiLlama (batch) ──
      const dlKeys = coins.map(c => c.defillamaId).join(",")
      const useDlStub = isStub && !isLive && (STUB_DL[scenario] !== undefined)

      if (useDlStub) {
        const dlSrcs = STUB_DL[scenario]!
        for (const c of coins) {
          const offset = dlSrcs[c.symbol]
          if (offset !== undefined) sourcesPerCoin[c.symbol]!.push({ name: "defillama", price: ONE_USD + offset })
        }
      } else {
        try {
          const dlResp = httpClient.sendRequest(nodeRuntime, {
            url:    `https://coins.llama.fi/prices/current/${dlKeys}`,
            method: "GET",
          }).result()
          if (!ok(dlResp)) throw new Error(`DefiLlama HTTP ${dlResp.statusCode}`)
          const dlBody = json(dlResp) as { coins: Record<string, { price: number }> }
          for (const c of coins) {
            const p = dlBody.coins[c.defillamaId]?.price
            if (p !== undefined) sourcesPerCoin[c.symbol]!.push({ name: "defillama", price: floatToPrice18(p) })
          }
        } catch (err) {
          nodeRuntime.log(`[DL SKIP] ${err instanceof Error ? err.message : String(err)}`)
        }
      }

      // ── Build NodeOutput: per-coin median price, spread, source count + named log ──
      const buildCoinNode = (sym: string): { price: bigint; spread: bigint; sources: number } => {
        const srcs = sourcesPerCoin[sym] ?? []
        if (srcs.length === 0) return { price: 0n, spread: 0n, sources: 0 }
        const prices  = srcs.map(s => s.price)
        const price   = medianOf(prices)
        const spread  = spreadBps(prices)
        const srcLine = srcs.map(s => `${s.name}=${fmtPrice(s.price)}`).join(" ")
        nodeRuntime.log(`[NODE] ${sym} sources: ${srcLine} → median ${fmtPrice(price)}, spread ${spread}bps`)
        return { price, spread, sources: srcs.length }
      }

      const usdc = buildCoinNode("USDC")
      const usdt = buildCoinNode("USDT")
      const dai  = buildCoinNode("DAI")
      const usds = buildCoinNode("USDS")

      return {
        usdc_price: usdc.price, usdc_spread: usdc.spread, usdc_sources: usdc.sources,
        usdt_price: usdt.price, usdt_spread: usdt.spread, usdt_sources: usdt.sources,
        dai_price:  dai.price,  dai_spread:  dai.spread,  dai_sources:  dai.sources,
        usds_price: usds.price, usds_spread: usds.spread, usds_sources: usds.sources,
      }
    },
    ConsensusAggregationByFields<NodeOutput>({
      usdc_price:   median,
      usdc_spread:  median,
      usdc_sources: median,
      usdt_price:   median,
      usdt_spread:  median,
      usdt_sources: median,
      dai_price:    median,
      dai_spread:   median,
      dai_sources:  median,
      usds_price:   median,
      usds_spread:  median,
      usds_sources: median,
    }),
  )().result()

  // ── Step 2: Post-consensus scoring ──
  // Deviation, agreement, and signal level are computed ONCE from consensus values
  // so every node in the DON ends up with identical classification.

  type ConsensusKey = "usdc" | "usdt" | "dai" | "usds"
  const results: CoinResult[] = []
  const cooldownSec = 300n

  for (const coin of coins) {
    const key = coin.symbol.toLowerCase() as ConsensusKey

    const price   = consensus[`${key}_price`   as keyof NodeOutput] as bigint
    const spread  = consensus[`${key}_spread`  as keyof NodeOutput] as bigint
    const sources = consensus[`${key}_sources` as keyof NodeOutput] as number

    if (sources === 0) {
      runtime.log(`[SKIP] ${coin.symbol}: zero sources after consensus`)
      continue
    }

    const devBps    = calcDeviationBps(price)
    const rawSignal = classifySignal(devBps)
    const agree     = agreementLevel(sources, spread)
    const signal    = applyAgreementCap(rawSignal, agree)

    if (signal !== rawSignal) {
      runtime.log(
        `[CAP] ${coin.symbol}: ${["STABLE","WATCH","ELEVATED","CRITICAL"][rawSignal]} → WATCH` +
        ` (${agree}, ${sources} src, spread=${spread}bps)`
      )
    }

    runtime.log(
      `[SCORE] ${coin.symbol}: price=${price} dev=${devBps}bps ` +
      `src=${sources} spread=${spread}bps ` +
      `agree=${agree} signal=${["STABLE","WATCH","ELEVATED","CRITICAL"][signal]}`
    )

    results.push({
      symbol:       coin.symbol,
      address:      coin.address as `0x${string}`,
      price18:      price,
      deviationBps: devBps,
      signalLevel:  signal,
      agreement:    agree,
    })
  }

  // ── Step 3: Composite risk score ──
  const compositeScore = results.reduce((m, r) => Math.max(m, r.signalLevel), 0)
  const atWatch        = results.filter(r => r.signalLevel >= 1).length
  const marketStress   = atWatch >= 4 ? 2 : atWatch >= 2 ? 1 : 0

  runtime.log(`Composite=${compositeScore} stress=${marketStress} cooldownSec=${cooldownSec}`)

  // ── Step 4: ABI-encode payload — format unchanged from v1 ──
  // fullReports is empty bytes per coin (receiver decodes but discards this field)
  const emptyReport = "0x" as `0x${string}`

  const encoded = encodeAbiParameters(
    parseAbiParameters(
      "address[] coins, uint256[] prices, uint256[] deviationsBps, uint8[] signalLevels, bytes[] fullReports, uint8 compositeScore, uint8 marketStress, uint256 observedAt"
    ),
    [
      results.map(r => r.address),
      results.map(r => r.price18),
      results.map(r => r.deviationBps),
      results.map(r => r.signalLevel),
      results.map(_ => emptyReport),
      compositeScore,
      marketStress,
      BigInt(nowSec),
    ]
  )

  // ── Step 5: Sign and write onchain ──
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
      agreement:    r.agreement,
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
