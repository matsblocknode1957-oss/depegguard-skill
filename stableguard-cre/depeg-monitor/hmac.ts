// Pure-TypeScript SHA-256 + HMAC-SHA256.
// Uses only Uint8Array, DataView, and bitwise ops — no Node.js imports.
// Compatible with the CRE QuickJS/WASM runtime.

const K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5,
  0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3,
  0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc,
  0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7,
  0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13,
  0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3,
  0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5,
  0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208,
  0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
])

function rotr32(x: number, n: number): number {
  return ((x >>> n) | (x << (32 - n))) >>> 0
}

export function sha256(data: Uint8Array): Uint8Array {
  const msgLen = data.length
  const bitLen = msgLen * 8

  // Pad: append 0x80, then zeros, then 64-bit big-endian length
  const padLen = ((msgLen + 9 + 63) & ~63) - msgLen
  const padded = new Uint8Array(msgLen + padLen)
  padded.set(data)
  padded[msgLen] = 0x80
  // Write bit length as two 32-bit big-endian words at the end
  const dv = new DataView(padded.buffer)
  dv.setUint32(padded.length - 4, bitLen >>> 0, false)
  dv.setUint32(padded.length - 8, Math.floor(bitLen / 0x100000000), false)

  // Initial hash values
  let h0 = 0x6a09e667 >>> 0
  let h1 = 0xbb67ae85 >>> 0
  let h2 = 0x3c6ef372 >>> 0
  let h3 = 0xa54ff53a >>> 0
  let h4 = 0x510e527f >>> 0
  let h5 = 0x9b05688c >>> 0
  let h6 = 0x1f83d9ab >>> 0
  let h7 = 0x5be0cd19 >>> 0

  const w = new Uint32Array(64)

  for (let offset = 0; offset < padded.length; offset += 64) {
    for (let i = 0; i < 16; i++) {
      w[i] = dv.getUint32(offset + i * 4, false)
    }
    for (let i = 16; i < 64; i++) {
      const s0 = rotr32(w[i - 15]!, 7) ^ rotr32(w[i - 15]!, 18) ^ (w[i - 15]! >>> 3)
      const s1 = rotr32(w[i - 2]!, 17) ^ rotr32(w[i - 2]!, 19) ^ (w[i - 2]! >>> 10)
      w[i] = (w[i - 16]! + s0 + w[i - 7]! + s1) >>> 0
    }

    let a = h0, b = h1, c = h2, d = h3, e = h4, f = h5, g = h6, h = h7

    for (let i = 0; i < 64; i++) {
      const S1 = rotr32(e, 6) ^ rotr32(e, 11) ^ rotr32(e, 25)
      const ch = (e & f) ^ (~e & g)
      const temp1 = (h + S1 + ch + K[i]! + w[i]!) >>> 0
      const S0 = rotr32(a, 2) ^ rotr32(a, 13) ^ rotr32(a, 22)
      const maj = (a & b) ^ (a & c) ^ (b & c)
      const temp2 = (S0 + maj) >>> 0

      h = g; g = f; f = e
      e = (d + temp1) >>> 0
      d = c; c = b; b = a
      a = (temp1 + temp2) >>> 0
    }

    h0 = (h0 + a) >>> 0
    h1 = (h1 + b) >>> 0
    h2 = (h2 + c) >>> 0
    h3 = (h3 + d) >>> 0
    h4 = (h4 + e) >>> 0
    h5 = (h5 + f) >>> 0
    h6 = (h6 + g) >>> 0
    h7 = (h7 + h) >>> 0
  }

  const digest = new Uint8Array(32)
  const out = new DataView(digest.buffer)
  out.setUint32(0,  h0, false)
  out.setUint32(4,  h1, false)
  out.setUint32(8,  h2, false)
  out.setUint32(12, h3, false)
  out.setUint32(16, h4, false)
  out.setUint32(20, h5, false)
  out.setUint32(24, h6, false)
  out.setUint32(28, h7, false)
  return digest
}

export function hmacSha256(key: Uint8Array, data: Uint8Array): Uint8Array {
  const BLOCK = 64
  let k = key.length > BLOCK ? sha256(key) : key
  const kPad = new Uint8Array(BLOCK)
  kPad.set(k)

  const ipad = new Uint8Array(BLOCK)
  const opad = new Uint8Array(BLOCK)
  for (let i = 0; i < BLOCK; i++) {
    ipad[i] = kPad[i]! ^ 0x36
    opad[i] = kPad[i]! ^ 0x5c
  }

  const inner = new Uint8Array(BLOCK + data.length)
  inner.set(ipad)
  inner.set(data, BLOCK)

  const outerData = new Uint8Array(BLOCK + 32)
  outerData.set(opad)
  outerData.set(sha256(inner), BLOCK)

  return sha256(outerData)
}

export function toHex(bytes: Uint8Array): string {
  let s = ""
  for (let i = 0; i < bytes.length; i++) {
    s += (bytes[i]! & 0xff).toString(16).padStart(2, "0")
  }
  return s
}

export function hexToBytes(hex: string): Uint8Array {
  const clean = hex.startsWith("0x") ? hex.slice(2) : hex
  const out = new Uint8Array(clean.length >> 1)
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16)
  }
  return out
}

// Safe UTF-8 encoder (no TextEncoder dependency)
export function encodeUtf8(str: string): Uint8Array {
  const bytes: number[] = []
  for (let i = 0; i < str.length; i++) {
    const c = str.charCodeAt(i)
    if (c < 0x80) {
      bytes.push(c)
    } else if (c < 0x800) {
      bytes.push(0xc0 | (c >> 6), 0x80 | (c & 0x3f))
    } else {
      bytes.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 0x3f), 0x80 | (c & 0x3f))
    }
  }
  return new Uint8Array(bytes)
}
