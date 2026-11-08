import { decodeAbiParameters, parseAbiParameters } from "viem"

const ONE_USD = 1_000_000_000_000_000_000n

export function calcDeviationBps(price18: bigint): bigint {
  const diff = price18 >= ONE_USD ? price18 - ONE_USD : ONE_USD - price18
  return (diff * 10_000n) / ONE_USD
}

export function classifySignal(bps: bigint): number {
  if (bps < 20n)  return 0  // STABLE
  if (bps < 50n)  return 1  // WATCH
  if (bps < 100n) return 2  // ELEVATED
  return 3                   // CRITICAL
}

// ── Utilities moved here so main.ts has no exported functions with parameters
// (Javy v8.1.0 does not support WASM-exported functions with parameters) ──────

export type CoinConfig = {
  symbol:            string
  address:           string
  priceFeedAddress?: string
  demoFeedAddress?:  string
}

export function hexToBytes(hex: string): Uint8Array {
  const clean = hex.startsWith("0x") ? hex.slice(2) : hex
  const bytes = new Uint8Array(clean.length / 2)
  for (let i = 0; i < clean.length; i += 2) {
    bytes[i / 2] = parseInt(clean.slice(i, i + 2), 16)
  }
  return bytes
}

export function bytesToHexStr(bytes: Uint8Array): `0x${string}` {
  let hex = "0x"
  for (let i = 0; i < bytes.length; i++) {
    hex += bytes[i]!.toString(16).padStart(2, "0")
  }
  return hex as `0x${string}`
}

export function decodePriceFeedAnswer(data: Uint8Array): bigint {
  const [, answer] = decodeAbiParameters(
    parseAbiParameters("uint80, int256, uint256, uint256, uint80"),
    bytesToHexStr(data),
  )
  return answer > 0n ? answer * 10_000_000_000n : 0n
}

/** Returns demoFeedAddress when set, else priceFeedAddress. Used by handler and tests. */
export function selectFeedAddress(coin: CoinConfig): string | undefined {
  return coin.demoFeedAddress ?? coin.priceFeedAddress
}
