import { describe, it, expect } from "bun:test"
import {
  calcDeviationBps,
  classifySignal,
  medianOf,
  spreadBps,
  agreementLevel,
  applyAgreementCap,
} from "./helpers"

const ONE_USD = 1_000_000_000_000_000_000n

// ── calcDeviationBps ──────────────────────────────────────────────────────────

describe("calcDeviationBps", () => {
  it("returns 0 at peg", () => {
    expect(calcDeviationBps(ONE_USD)).toBe(0n)
  })
  it("returns 5 bps above peg", () => {
    expect(calcDeviationBps(ONE_USD + 500_000_000_000_000n)).toBe(5n)
  })
  it("returns 5 bps below peg (symmetric)", () => {
    expect(calcDeviationBps(ONE_USD - 500_000_000_000_000n)).toBe(5n)
  })
  it("returns 300 bps for 3% depeg stub offset", () => {
    expect(calcDeviationBps(ONE_USD - 30_000_000_000_000_000n)).toBe(300n)
  })
})

// ── classifySignal ────────────────────────────────────────────────────────────

describe("classifySignal", () => {
  it("classifies 0 bps as STABLE (0)", () => expect(classifySignal(0n)).toBe(0))
  it("classifies 19 bps as STABLE (0) — boundary below WATCH", () => expect(classifySignal(19n)).toBe(0))
  it("classifies 20 bps as WATCH (1) — boundary entry", () => expect(classifySignal(20n)).toBe(1))
  it("classifies 49 bps as WATCH (1) — boundary below ELEVATED", () => expect(classifySignal(49n)).toBe(1))
  it("classifies 50 bps as ELEVATED (2) — boundary entry", () => expect(classifySignal(50n)).toBe(2))
  it("classifies 99 bps as ELEVATED (2) — boundary below CRITICAL", () => expect(classifySignal(99n)).toBe(2))
  it("classifies 100 bps as CRITICAL (3) — boundary entry", () => expect(classifySignal(100n)).toBe(3))
  it("classifies 300 bps as CRITICAL (3) — stub depeg scenario", () => expect(classifySignal(300n)).toBe(3))
})

// ── medianOf ──────────────────────────────────────────────────────────────────

describe("medianOf", () => {
  it("throws on empty array", () => {
    expect(() => medianOf([])).toThrow("medianOf: empty array")
  })
  it("returns single value", () => {
    expect(medianOf([500n])).toBe(500n)
  })
  it("returns middle of odd-length sorted array", () => {
    expect(medianOf([300n, 100n, 200n])).toBe(200n)
  })
  it("returns average of two middle values for even-length array", () => {
    // [100, 200] → (100+200)/2 = 150
    expect(medianOf([200n, 100n])).toBe(150n)
  })
  it("returns average of middle pair for even-length (4 values)", () => {
    // [10, 20, 30, 40] → (20+30)/2 = 25
    expect(medianOf([30n, 10n, 40n, 20n])).toBe(25n)
  })
  it("works with 5 DON-node consensus simulation", () => {
    // Five nodes each report a slightly different price; median should be middle value
    const prices = [
      ONE_USD + 100_000_000_000_000n,  // +1 bps
      ONE_USD + 200_000_000_000_000n,  // +2 bps
      ONE_USD + 300_000_000_000_000n,  // +3 bps  ← median
      ONE_USD + 400_000_000_000_000n,  // +4 bps
      ONE_USD + 500_000_000_000_000n,  // +5 bps
    ]
    expect(medianOf(prices)).toBe(ONE_USD + 300_000_000_000_000n)
  })
  it("depeg scenario: median of 3 identical depeg prices", () => {
    const p = ONE_USD - 30_000_000_000_000_000n
    expect(medianOf([p, p, p])).toBe(p)
  })
  it("disagree scenario: median of DS-depeg and CG-normal (2 sources)", () => {
    const ds = ONE_USD - 30_000_000_000_000_000n  // 0.97
    const cg = ONE_USD                             // 1.00
    // median of 2 = average
    expect(medianOf([ds, cg])).toBe((ds + cg) / 2n)
  })
})

// ── spreadBps ─────────────────────────────────────────────────────────────────

describe("spreadBps", () => {
  it("returns 0 for single price", () => {
    expect(spreadBps([ONE_USD])).toBe(0n)
  })
  it("returns 0 for identical prices", () => {
    expect(spreadBps([ONE_USD, ONE_USD, ONE_USD])).toBe(0n)
  })
  it("returns 3 bps for normal scenario spread (5bps-2bps=3bps)", () => {
    const p1 = ONE_USD + 200_000_000_000_000n  // +2 bps
    const p2 = ONE_USD + 300_000_000_000_000n  // +3 bps
    const p3 = ONE_USD + 500_000_000_000_000n  // +5 bps
    expect(spreadBps([p1, p2, p3])).toBe(3n)
  })
  it("returns 300 bps for disagree scenario (DS at -300bps, CG at 0bps)", () => {
    const ds = ONE_USD - 30_000_000_000_000_000n  // 0.97
    const cg = ONE_USD                             // 1.00
    expect(spreadBps([ds, cg])).toBe(300n)
  })
  it("returns 0 for depeg scenario (all sources agree)", () => {
    const p = ONE_USD - 30_000_000_000_000_000n
    expect(spreadBps([p, p, p])).toBe(0n)
  })
})

// ── agreementLevel ────────────────────────────────────────────────────────────

describe("agreementLevel", () => {
  it("zero_source when sourceCount = 0", () => {
    expect(agreementLevel(0, 0n)).toBe("zero_source")
  })
  it("single_source when sourceCount = 1", () => {
    expect(agreementLevel(1, 500n)).toBe("single_source")
  })
  it("confirmed with 3 sources regardless of spread", () => {
    expect(agreementLevel(3, 999n)).toBe("confirmed")
  })
  it("confirmed with 2 sources, spread = 0 bps", () => {
    expect(agreementLevel(2, 0n)).toBe("confirmed")
  })
  it("confirmed with 2 sources, spread = 100 bps (boundary)", () => {
    expect(agreementLevel(2, 100n)).toBe("confirmed")
  })
  it("unconfirmed with 2 sources, spread = 101 bps (just above 1%)", () => {
    expect(agreementLevel(2, 101n)).toBe("unconfirmed")
  })
  it("unconfirmed with 2 sources, spread = 300 bps (disagree scenario)", () => {
    expect(agreementLevel(2, 300n)).toBe("unconfirmed")
  })
})

// ── applyAgreementCap ─────────────────────────────────────────────────────────

describe("applyAgreementCap", () => {
  it("confirmed: CRITICAL stays CRITICAL", () => {
    expect(applyAgreementCap(3, "confirmed")).toBe(3)
  })
  it("confirmed: ELEVATED stays ELEVATED", () => {
    expect(applyAgreementCap(2, "confirmed")).toBe(2)
  })
  it("unconfirmed: CRITICAL capped to WATCH", () => {
    expect(applyAgreementCap(3, "unconfirmed")).toBe(1)
  })
  it("unconfirmed: ELEVATED capped to WATCH", () => {
    expect(applyAgreementCap(2, "unconfirmed")).toBe(1)
  })
  it("unconfirmed: WATCH stays WATCH (cap has no effect)", () => {
    expect(applyAgreementCap(1, "unconfirmed")).toBe(1)
  })
  it("unconfirmed: STABLE stays STABLE (cap at WATCH is ceiling, not floor)", () => {
    expect(applyAgreementCap(0, "unconfirmed")).toBe(0)
  })
  it("single_source: CRITICAL capped to WATCH", () => {
    expect(applyAgreementCap(3, "single_source")).toBe(1)
  })
  it("single_source: STABLE stays STABLE", () => {
    expect(applyAgreementCap(0, "single_source")).toBe(0)
  })

  // Integration: disagree scenario — DS at −300bps, CG at peg
  // median([0.97, 1.00]) = 0.985 → 150bps → CRITICAL (≥100bps)
  // spread = 300bps, 2 sources → unconfirmed → cap CRITICAL → WATCH
  it("disagree integration: CRITICAL + unconfirmed → WATCH", () => {
    const ds = ONE_USD - 30_000_000_000_000_000n
    const cg = ONE_USD
    const medPrice  = (ds + cg) / 2n  // 0.985e18
    const devBps    = calcDeviationBps(medPrice)   // 150bps
    const rawSignal = classifySignal(devBps)        // CRITICAL (3) — 150bps >= 100bps
    const spr       = spreadBps([ds, cg])           // 300bps
    const agree     = agreementLevel(2, spr)        // unconfirmed
    const final     = applyAgreementCap(rawSignal, agree)
    expect(devBps).toBe(150n)
    expect(rawSignal).toBe(3)  // CRITICAL
    expect(spr).toBe(300n)
    expect(agree).toBe("unconfirmed")
    expect(final).toBe(1)  // WATCH
  })

  // Integration: depeg scenario — 3 sources all agree → CRITICAL confirmed
  it("depeg integration: 3 sources all depegged → CRITICAL confirmed", () => {
    const p = ONE_USD - 30_000_000_000_000_000n
    const med    = medianOf([p, p, p])
    const devBps = calcDeviationBps(med)
    const spr    = spreadBps([p, p, p])
    const agree  = agreementLevel(3, spr)
    const raw    = classifySignal(devBps)
    const final  = applyAgreementCap(raw, agree)
    expect(devBps).toBe(300n)
    expect(spr).toBe(0n)
    expect(agree).toBe("confirmed")
    expect(raw).toBe(3)
    expect(final).toBe(3)  // CRITICAL
  })
})
