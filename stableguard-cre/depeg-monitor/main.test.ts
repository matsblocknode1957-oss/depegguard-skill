import { describe, it, expect } from "bun:test"
import { encodeAbiParameters, parseAbiParameters } from "viem"
import { calcDeviationBps, classifySignal } from "./helpers"
import { hexToBytes, selectFeedAddress, decodePriceFeedAnswer } from "./helpers"

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

describe("selectFeedAddress", () => {
  it("returns demoFeedAddress when set (DEMO_MODE active)", () => {
    const coin = {
      symbol: "USDC",
      address: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
      priceFeedAddress: "0x1111111111111111111111111111111111111111",
      demoFeedAddress:  "0x2222222222222222222222222222222222222222",
    }
    expect(selectFeedAddress(coin)).toBe("0x2222222222222222222222222222222222222222")
  })

  it("falls back to priceFeedAddress when demoFeedAddress is absent", () => {
    const coin = {
      symbol: "USDC",
      address: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
      priceFeedAddress: "0x1111111111111111111111111111111111111111",
    }
    expect(selectFeedAddress(coin)).toBe("0x1111111111111111111111111111111111111111")
  })

  it("returns undefined when neither address is set", () => {
    const coin = { symbol: "USDC", address: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48" }
    expect(selectFeedAddress(coin)).toBeUndefined()
  })
})

describe("decodePriceFeedAnswer", () => {
  function encodeLatestRoundData(
    roundId: bigint,
    answer: bigint,
    startedAt: bigint,
    updatedAt: bigint,
    answeredInRound: bigint,
  ): Uint8Array {
    const hex = encodeAbiParameters(
      parseAbiParameters("uint80, int256, uint256, uint256, uint80"),
      [roundId, answer, startedAt, updatedAt, answeredInRound],
    )
    return hexToBytes(hex)
  }

  it("decodes $1.00 (100_000_000 × 1e-8) to exactly 1e18", () => {
    const data = encodeLatestRoundData(1n, 100_000_000n, 0n, 0n, 1n)
    const price18 = decodePriceFeedAnswer(data)
    expect(price18).toBe(1_000_000_000_000_000_000n)
    expect(calcDeviationBps(price18)).toBe(0n)
    expect(classifySignal(0n)).toBe(0)  // STABLE
  })

  it("decodes $0.94 to 600 bps deviation → CRITICAL (demo depeg scenario)", () => {
    // $0.94 in 8 decimals
    const data = encodeLatestRoundData(1n, 94_000_000n, 0n, 0n, 1n)
    const price18 = decodePriceFeedAnswer(data)
    expect(price18).toBe(940_000_000_000_000_000n)
    expect(calcDeviationBps(price18)).toBe(600n)
    expect(classifySignal(600n)).toBe(3)  // CRITICAL
  })

  it("decodes $0.9980 (20 bps below peg) → WATCH", () => {
    const data = encodeLatestRoundData(1n, 99_800_000n, 0n, 0n, 1n)
    const price18 = decodePriceFeedAnswer(data)
    expect(calcDeviationBps(price18)).toBe(20n)
    expect(classifySignal(20n)).toBe(1)  // WATCH
  })

  it("decodes $1.0005 (5 bps above peg) → STABLE", () => {
    const data = encodeLatestRoundData(1n, 100_050_000n, 0n, 0n, 1n)
    const price18 = decodePriceFeedAnswer(data)
    expect(calcDeviationBps(price18)).toBe(5n)
    expect(classifySignal(5n)).toBe(0)  // STABLE
  })

  it("returns 0 for non-positive answer", () => {
    const data = encodeLatestRoundData(1n, 0n, 0n, 0n, 1n)
    expect(decodePriceFeedAnswer(data)).toBe(0n)
  })
})
