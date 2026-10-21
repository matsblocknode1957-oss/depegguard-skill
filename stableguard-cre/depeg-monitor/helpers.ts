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

export function medianOf(values: bigint[]): bigint {
  if (values.length === 0) throw new Error("medianOf: empty array")
  const sorted = [...values].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
  const mid = Math.floor(sorted.length / 2)
  if (sorted.length % 2 === 1) return sorted[mid]!
  return (sorted[mid - 1]! + sorted[mid]!) / 2n
}

export function spreadBps(prices: bigint[]): bigint {
  if (prices.length < 2) return 0n
  const sorted = [...prices].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
  const min = sorted[0]!
  const max = sorted[sorted.length - 1]!
  return ((max - min) * 10_000n) / ONE_USD
}

export type AgreementLevel = "confirmed" | "unconfirmed" | "single_source" | "zero_source"

// Rule: confirmed = 3+ sources, OR exactly 2 sources with spread <= 100 bps (1%)
//       unconfirmed = exactly 2 sources with spread > 100 bps
//       single_source = 1 source
//       zero_source = 0 sources (skip)
export function agreementLevel(sourceCount: number, spread: bigint): AgreementLevel {
  if (sourceCount === 0) return "zero_source"
  if (sourceCount === 1) return "single_source"
  if (sourceCount >= 3)  return "confirmed"
  // exactly 2 sources
  return spread <= 100n ? "confirmed" : "unconfirmed"
}

// Cap: unconfirmed and single_source may not exceed WATCH (1)
export function applyAgreementCap(rawSignal: number, agreement: AgreementLevel): number {
  if (agreement === "confirmed") return rawSignal
  return Math.min(rawSignal, 1)
}
