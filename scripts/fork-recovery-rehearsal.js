"use strict";
// Run with: $env:FORK="1"; npx hardhat run scripts/fork-recovery-rehearsal.js --network hardhat

/**
 * Fork Recovery Rehearsal
 *
 * Forks Arbitrum Sepolia at latest block, impersonates the KeystoneForwarder,
 * and sends healthy USDC reports until the full recovery sequence completes:
 *   Tick 1: G13 expires the stale PROTECTED event → EXPIRED
 *   Tick 2: resumeProtectionTracking fires → fresh PROTECTED event created
 *   Ticks 3-5: stableCount accumulates (stabilityWindow = 3)
 *   Tick 5: auto-recovery → RECOVERY_PENDING, vault unpaused, hold released
 *   +1800s: finalizeRecovery → NORMAL (called by next tick's try-catch)
 */

const hre = require("hardhat");
const { ethers, AbiCoder, keccak256, toUtf8Bytes } = require("ethers");

// ── Addresses ──────────────────────────────────────────────────────────────
const FORWARDER        = "0x76c9cf548b4179F8901cda1f8623568b58215E62";
const RECEIVER_ADDR    = "0xac83a85Ee4dF1FfF44DFdEF055e95Db4886a9aD8";
const REGISTRY_ADDR    = "0xAa940C87f3D3251fD297894b5cef7dC7e71b3665";
const VAULT_ADDR       = "0x86602cDeC52Df65Bc8D66528De429EB11A9E0497";
const HOLD_LEDGER_ADDR = "0xA3175824EEF5964bA5A839CdBc01e6F8F1F3444b";

// Mainnet addresses used as chain-agnostic coin keys (matches CRE workflow)
const USDC = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48";
const USDT = "0xdAC17F958D2ee523a2206206994597C13D831ec7";
const DAI  = "0x6B175474E89094C44Da98b954EedeAC495271d0F";
const USDS = "0xdC035D45d973E3EC169d2276DDab16f1e407384F";

// ONE_USD = 1e18 (price unit used by the CRE workflow)
const ONE_USD = 1_000_000_000_000_000_000n;

// STUB_OFFSETS: +5 bps, -3 bps, +2 bps, +1 bps → all STABLE (score 0, < 20 bps)
const STUBS = [
  { coin: USDC, offsetBps: 5n,  signalLevel: 0 },
  { coin: USDT, offsetBps: -3n, signalLevel: 0 },
  { coin: DAI,  offsetBps: 2n,  signalLevel: 0 },
  { coin: USDS, offsetBps: 1n,  signalLevel: 0 },
];

const STATE_NAMES = [
  "WATCH", "CONFIRMED_DEPEG", "PROTECTION_PENDING", "PROTECTED",
  "PARTIALLY_PROTECTED", "RECOVERY_PENDING", "PARTIALLY_RECOVERED",
  "NORMAL", "FAILED", "EXPIRED", "SUPERSEDED",
];

// ── Minimal ABIs ────────────────────────────────────────────────────────────
const RECEIVER_ABI = [
  "function onReport(bytes calldata metadata, bytes calldata report) external",
  "event DepegReport(uint256 indexed reportIndex, uint8 compositeScore, uint8 marketStress, uint256 observedAt)",
  "event RegistryUpdateFailed(address indexed coin, bytes reason)",
  "event RecoveryResumeFailed(address indexed coin, bytes reason)",
  "event VaultUnpaused(address indexed vault)",
  "event HoldReleased(bytes32 indexed holdId, address indexed vault)",
];

const REGISTRY_ABI = [
  "function getDepegEvent(bytes32 eventId) external view returns (tuple(address coin, bytes32 rootIncidentId, uint8 state, uint8 compositeScore, bytes32 evidenceRoot, uint256 createdAt, uint256 observedAt, uint256 protectionInitiatedAt, uint256 recoveryInitiatedAt, uint8 stableCount, tuple(uint64 chainSelector, address vault, uint8 state)[] destinations))",
  "function getActiveEventId(address coin) external view returns (bytes32)",
  "event EventAdvanced(bytes32 indexed eventId, address indexed coin, uint8 fromState, uint8 toState)",
  "event EventTerminated(bytes32 indexed eventId, address indexed coin, uint8 state)",
  "event RecoveryTrackingResumed(bytes32 indexed eventId, address indexed coin, uint256 destCount)",
  "event RecoveryInitiated(bytes32 indexed eventId, address indexed coin)",
];

const VAULT_ABI = [
  "function paused() external view returns (bool)",
  "function depositsFrozen() external view returns (bool)",
];

const HOLD_LEDGER_ABI = [
  "function activeHoldCount(address vault) external view returns (uint256)",
  "event HoldAcquired(bytes32 indexed holdId, address indexed vault, bytes32 assetId)",
  "event HoldReleased(bytes32 indexed holdId, address indexed vault)",
];

// ── Encode a healthy report payload ────────────────────────────────────────
function buildReport(observedAt) {
  const coins       = STUBS.map(s => s.coin);
  const prices      = STUBS.map(s => ONE_USD + s.offsetBps * (ONE_USD / 10_000n));
  const devsBps     = STUBS.map(s => s.offsetBps < 0n ? -s.offsetBps : s.offsetBps);
  const signals     = STUBS.map(s => s.signalLevel);
  const fullReports = STUBS.map(() => "0x" + "00".repeat(32));

  const coder = AbiCoder.defaultAbiCoder();
  return coder.encode(
    ["address[]", "uint256[]", "uint256[]", "uint8[]", "bytes[]", "uint8", "uint8", "uint256"],
    [coins, prices, devsBps, signals, fullReports, 0, 0, observedAt]
  );
}

// ── Print state after each tick ─────────────────────────────────────────────
async function printState(registry, vault, holdLedger, tick, receipt) {
  console.log(`\n${"═".repeat(60)}`);
  console.log(`TICK ${tick}`);
  console.log(`${"═".repeat(60)}`);

  const activeId = await registry.getActiveEventId(USDC);
  console.log(`activeEventId (USDC): ${activeId}`);

  if (activeId !== ethers.ZeroHash) {
    const ev = await registry.getDepegEvent(activeId);
    console.log(`  state:       ${STATE_NAMES[ev.state] ?? ev.state} (${ev.state})`);
    console.log(`  stableCount: ${ev.stableCount}`);
    console.log(`  createdAt:   ${new Date(Number(ev.createdAt) * 1000).toISOString()}`);
    if (ev.recoveryInitiatedAt > 0n)
      console.log(`  recoveryInitiatedAt: ${new Date(Number(ev.recoveryInitiatedAt) * 1000).toISOString()}`);
  } else {
    console.log(`  (no active event)`);
  }

  const holdCount = await holdLedger.activeHoldCount(VAULT_ADDR);
  const isPaused  = await vault.paused();
  console.log(`activeHoldCount: ${holdCount}`);
  console.log(`vault.paused():  ${isPaused}`);

  if (receipt) {
    // Decode log topics using known event fragments
    const registryIface  = new ethers.Interface(REGISTRY_ABI);
    const receiverIface  = new ethers.Interface(RECEIVER_ABI);
    const holdIface      = new ethers.Interface(HOLD_LEDGER_ABI);
    const knownIfaces    = [registryIface, receiverIface, holdIface];

    const emitted = [];
    for (const log of receipt.logs) {
      for (const iface of knownIfaces) {
        try {
          const parsed = iface.parseLog({ topics: [...log.topics], data: log.data });
          if (parsed) { emitted.push(parsed.name + ": " + formatArgs(parsed)); break; }
        } catch { /* not this iface */ }
      }
    }
    if (emitted.length) {
      console.log(`Events emitted:`);
      emitted.forEach(e => console.log(`  » ${e}`));
    } else {
      console.log(`Events emitted: (none decoded)`);
    }
  }
}

function formatArgs(parsed) {
  const parts = [];
  for (const [k, v] of Object.entries(parsed.args.toObject?.() ?? {})) {
    const val = typeof v === "bigint" ? `0x${v.toString(16)}` : String(v);
    parts.push(`${k}=${val}`);
  }
  return parts.length ? parts.join(", ") : parsed.args.join(", ");
}

// ── Main ────────────────────────────────────────────────────────────────────
async function main() {
  const provider = hre.ethers.provider;

  // ── 1. Use the pre-configured Arbitrum Sepolia fork ──
  // forking is enabled in hardhat.config.js; chain 421614 hardfork history set to cancun:0.
  // Mine one block first so eth_call runs on a locally-produced block (past the fork point),
  // avoiding the "no hardfork history" error for calls at the exact fork block.
  const forkBlock = await provider.getBlockNumber();
  await provider.send("evm_mine", []);
  const startBlock = await provider.getBlockNumber();
  console.log(`Forked Arbitrum Sepolia at block ${forkBlock} (now mining from ${startBlock})`);

  // ── 2. Impersonate KeystoneForwarder ──
  await provider.send("hardhat_impersonateAccount", [FORWARDER]);
  await provider.send("hardhat_setBalance", [FORWARDER, "0x" + (10n ** 19n).toString(16)]);
  const signer = await hre.ethers.getSigner(FORWARDER);

  // ── 3. Connect contracts ──
  const registry  = new ethers.Contract(REGISTRY_ADDR,    REGISTRY_ABI,    provider);
  const vault     = new ethers.Contract(VAULT_ADDR,       VAULT_ABI,       provider);
  const holdLedger = new ethers.Contract(HOLD_LEDGER_ADDR, HOLD_LEDGER_ABI, provider);
  const receiver  = new ethers.Contract(RECEIVER_ADDR,    RECEIVER_ABI,    signer);

  // ── 4. Print pre-fork state ──
  console.log("\n── Pre-fork state ──────────────────────────────────────");
  const preActiveId = await registry.getActiveEventId(USDC);
  if (preActiveId !== ethers.ZeroHash) {
    const ev = await registry.getDepegEvent(preActiveId);
    console.log(`USDC event: ${preActiveId}`);
    console.log(`  state: ${STATE_NAMES[ev.state] ?? ev.state}`);
    console.log(`  stableCount: ${ev.stableCount}`);
    console.log(`  createdAt: ${new Date(Number(ev.createdAt) * 1000).toISOString()}`);
  } else {
    console.log("USDC: no active event");
  }
  console.log(`vault.paused(): ${await vault.paused()}`);
  console.log(`activeHoldCount: ${await holdLedger.activeHoldCount(VAULT_ADDR)}`);

  // ── 5. Tick loop ──────────────────────────────────────────────────────────
  const MAX_TICKS = 15;
  let finalStateReached = false;
  let lastObservedAt = (await provider.getBlock("latest")).timestamp;

  for (let tick = 1; tick <= MAX_TICKS; tick++) {
    // Advance time 30s and mine a block
    await provider.send("evm_increaseTime", [30]);
    await provider.send("evm_mine", []);

    const block = await provider.getBlock("latest");
    const observedAt = BigInt(block.timestamp);

    // Must be strictly newer than lastObservedAt
    if (observedAt <= BigInt(lastObservedAt)) {
      await provider.send("evm_increaseTime", [1]);
      await provider.send("evm_mine", []);
      const b2 = await provider.getBlock("latest");
      lastObservedAt = b2.timestamp;
    } else {
      lastObservedAt = Number(observedAt);
    }

    const report = buildReport(BigInt(lastObservedAt));

    let receipt;
    try {
      const tx = await receiver.onReport("0x", report);
      receipt = await tx.wait();
    } catch (err) {
      console.log(`\nTick ${tick}: onReport REVERTED — ${err.message?.split("\n")[0]}`);
      break;
    }

    await printState(registry, vault, holdLedger, tick, receipt);

    // Check if we reached NORMAL (no active event)
    const activeId = await registry.getActiveEventId(USDC);
    const isPaused = await vault.paused();

    if (activeId === ethers.ZeroHash && !isPaused) {
      console.log(`\n✓ NORMAL reached and vault unpaused at tick ${tick}`);
      finalStateReached = true;
      break;
    }

    // If RECOVERY_PENDING: advance past recoveryCooldown (1800s) then do one more tick
    if (activeId !== ethers.ZeroHash) {
      const ev = await registry.getDepegEvent(activeId);
      if (ev.state === 5n || ev.state === 5) { // RECOVERY_PENDING
        console.log(`\n  >> RECOVERY_PENDING detected — advancing 1810s past recoveryCooldown`);
        await provider.send("evm_increaseTime", [1810]);
        await provider.send("evm_mine", []);

        const block2 = await provider.getBlock("latest");
        lastObservedAt = block2.timestamp;
        const report2 = buildReport(BigInt(lastObservedAt));

        let receipt2;
        try {
          const tx2 = await receiver.onReport("0x", report2);
          receipt2 = await tx2.wait();
        } catch (err) {
          console.log(`  finalizeRecovery tick REVERTED — ${err.message?.split("\n")[0]}`);
          break;
        }

        await printState(registry, vault, holdLedger, `${tick}+cool`, receipt2);

        const activeId2 = await registry.getActiveEventId(USDC);
        const isPaused2 = await vault.paused();
        if (activeId2 === ethers.ZeroHash && !isPaused2) {
          finalStateReached = true;
        }
        break;
      }
    }
  }

  // ── 6. Final summary ─────────────────────────────────────────────────────
  console.log(`\n${"═".repeat(60)}`);
  console.log("SUMMARY");
  console.log(`${"═".repeat(60)}`);
  const finalActiveId = await registry.getActiveEventId(USDC);
  const finalPaused   = await vault.paused();
  const finalHolds    = await holdLedger.activeHoldCount(VAULT_ADDR);

  console.log(`vault.paused():   ${finalPaused}`);
  console.log(`activeHoldCount:  ${finalHolds}`);

  if (finalActiveId !== ethers.ZeroHash) {
    const finalEv = await registry.getDepegEvent(finalActiveId);
    console.log(`USDC event state: ${STATE_NAMES[finalEv.state] ?? finalEv.state}`);
  } else {
    console.log(`USDC event state: (none — terminal)`);
  }

  console.log();
  if (finalStateReached) {
    console.log("Recovery rehearsal PASSED:");
    console.log("  Vault was unpaused, USDC event reached NORMAL, hold released.");
    console.log("  The CRE workflow restart will complete recovery automatically.");
  } else {
    console.log("Recovery rehearsal did NOT reach NORMAL. Check the tick output above.");
    console.log("The script may need more ticks, or a contract revert blocked progress.");
  }
}

main().catch(err => { console.error(err); process.exit(1); });
