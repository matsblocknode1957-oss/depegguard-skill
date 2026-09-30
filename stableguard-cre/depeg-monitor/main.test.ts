import { describe, it, expect } from "bun:test"
import { calcDeviationBps, classifySignal } from "./helpers"

const ONE_USD = 1_000_000_000_000_000_000n

describe("calcDeviationBps", () => {
  it("returns 0 at peg", () => {
    expect(calcDeviationBps(ONE_USD)).toBe(0n)
  })

  it("returns 5 bps above peg", () => {
    // 1 bps = 1e14; 5 bps = 500_000_000_000_000n
    expect(calcDeviationBps(ONE_USD + 500_000_000_000_000n)).toBe(5n)
  })

  it("returns 5 bps below peg (symmetric)", () => {
    expect(calcDeviationBps(ONE_USD - 500_000_000_000_000n)).toBe(5n)
  })

  it("returns 300 bps for 3% depeg stub offset", () => {
    // STUB_DEPEG_USDC_OFFSET = -30_000_000_000_000_000n
    expect(calcDeviationBps(ONE_USD - 30_000_000_000_000_000n)).toBe(300n)
  })
})

describe("classifySignal", () => {
  it("classifies 0 bps as STABLE (0)", () => {
    expect(classifySignal(0n)).toBe(0)
  })

  it("classifies 19 bps as STABLE (0) — boundary below WATCH", () => {
    expect(classifySignal(19n)).toBe(0)
  })

  it("classifies 20 bps as WATCH (1) — boundary entry", () => {
    expect(classifySignal(20n)).toBe(1)
  })

  it("classifies 49 bps as WATCH (1) — boundary below ELEVATED", () => {
    expect(classifySignal(49n)).toBe(1)
  })

  it("classifies 50 bps as ELEVATED (2) — boundary entry", () => {
    expect(classifySignal(50n)).toBe(2)
  })

  it("classifies 99 bps as ELEVATED (2) — boundary below CRITICAL", () => {
    expect(classifySignal(99n)).toBe(2)
  })

  it("classifies 100 bps as CRITICAL (3) — boundary entry", () => {
    expect(classifySignal(100n)).toBe(3)
  })

  it("classifies 300 bps as CRITICAL (3) — stub depeg scenario", () => {
    expect(classifySignal(300n)).toBe(3)
  })
})
