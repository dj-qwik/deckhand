// Integer-only helpers shared by the server, the co-signers and the browser.
// Nothing in the simulation may use floating point for game logic.

/** sfc32 PRNG over four uint32 words. State is a plain array so it can be hashed/serialised. */
export function makeRng(seedWords) {
  const s = seedWords.slice(0, 4).map((v) => v >>> 0);
  const rng = {
    s,
    u32() {
      let [a, b, c, d] = s;
      const t = (((a + b) | 0) + d) | 0;
      d = (d + 1) | 0;
      a = b ^ (b >>> 9);
      b = (c + (c << 3)) | 0;
      c = (c << 21) | (c >>> 11);
      c = (c + t) | 0;
      s[0] = a; s[1] = b; s[2] = c; s[3] = d;
      return t >>> 0;
    },
    /** uniform integer in [0, n) */
    int(n) {
      if (n <= 1) return 0;
      // rejection-free enough for small n; deterministic either way
      return rng.u32() % n;
    },
    /** uniform integer in [lo, hi] */
    range(lo, hi) {
      return lo + rng.int(hi - lo + 1);
    },
  };
  for (let i = 0; i < 12; i++) rng.u32();
  return rng;
}

/** seed string (hex) → four uint32 words */
export function seedWords(hex) {
  const h = String(hex).replace(/^0x/, '').padEnd(32, '0');
  const out = [];
  for (let i = 0; i < 4; i++) out.push(parseInt(h.slice(i * 8, i * 8 + 8), 16) >>> 0);
  return out;
}

/** floor(sqrt(n)) for non-negative safe integers */
export function isqrt(n) {
  if (n <= 0) return 0;
  if (n < 4503599627370496) {
    // exact for the magnitudes we use (≤ 2^52): correct the double estimate
    let x = Math.floor(Math.sqrt(n));
    while (x * x > n) x--;
    while ((x + 1) * (x + 1) <= n) x++;
    return x;
  }
  throw new Error('isqrt overflow');
}

export const idiv = (a, b) => Math.trunc(a / b);
export const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);

/** FNV-1a 32-bit hasher over integers / strings */
export function hasher() {
  let h = 0x811c9dc5;
  const api = {
    int(v) {
      v = Math.trunc(v);
      // fold to two 32-bit halves so large ints hash stably
      const lo = v | 0;
      const hi = Math.floor(v / 4294967296) | 0;
      for (const w of [lo, hi]) {
        for (let i = 0; i < 4; i++) {
          h ^= (w >>> (i * 8)) & 0xff;
          h = Math.imul(h, 0x01000193);
        }
      }
      return api;
    },
    str(s) {
      for (let i = 0; i < s.length; i++) {
        h ^= s.charCodeAt(i) & 0xff;
        h = Math.imul(h, 0x01000193);
      }
      return api;
    },
    arr(a) {
      for (let i = 0; i < a.length; i++) api.int(a[i]);
      return api;
    },
    value() {
      return (h >>> 0).toString(16).padStart(8, '0');
    },
  };
  return api;
}
