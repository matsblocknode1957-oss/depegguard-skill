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
