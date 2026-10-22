// Minimal Ethereum toolkit for the game server and co-signers.
// Built on @noble/curves + @noble/hashes only: keys, EIP-191/EIP-712 signing,
// RLP + EIP-1559 transactions, a tiny ABI codec and a JSON-RPC client.
import { secp256k1 } from '@noble/curves/secp256k1';
import { keccak_256 } from '@noble/hashes/sha3';
import { bytesToHex as b2h, hexToBytes as h2b, utf8ToBytes, concatBytes } from '@noble/hashes/utils';

// ------------------------------------------------------------------ bytes
export const hex = (b) => '0x' + b2h(b);
export const bytes = (h) => {
  if (h instanceof Uint8Array) return h;
  let s = String(h).replace(/^0x/, '');
  if (s.length % 2) s = '0' + s;
  return h2b(s);
};
export const keccak = (data) => hex(keccak_256(typeof data === 'string' && !data.startsWith('0x') ? utf8ToBytes(data) : bytes(data)));
export const keccakText = (s) => hex(keccak_256(utf8ToBytes(s)));
const pad32 = (b) => {
  if (b.length > 32) throw new Error('pad32 overflow');
  const o = new Uint8Array(32);
  o.set(b, 32 - b.length);
  return o;
};
const bigToBytes = (v) => {
  v = BigInt(v);
  if (v < 0n) throw new Error('negative');
  if (v === 0n) return new Uint8Array();
  let s = v.toString(16);
  if (s.length % 2) s = '0' + s;
  return h2b(s);
};
const bytesToBig = (b) => (b.length ? BigInt('0x' + b2h(b)) : 0n);

// ------------------------------------------------------------------- keys
const N = secp256k1.CURVE.n;

/** Derive a private key from a long random secret and a role label. */
export function deriveKey(secret, role) {
  if (!secret || String(secret).length < 16) throw new Error(`secret for ${role} missing or too short`);
  let k = bytesToBig(keccak_256(utf8ToBytes(`deckhand:${role}:${secret}`))) % N;
  if (k === 0n) k = 1n;
  return hex(pad32(bigToBytes(k)));
}

export function addressOf(privKey) {
  const pub = secp256k1.getPublicKey(bytes(privKey), false);
  return checksum(hex(keccak_256(pub.slice(1)).slice(12)));
}

export function checksum(addr) {
  const a = String(addr).toLowerCase().replace(/^0x/, '');
  if (!/^[0-9a-f]{40}$/.test(a)) throw new Error('bad address ' + addr);
  const h = b2h(keccak_256(utf8ToBytes(a)));
  let out = '0x';
  for (let i = 0; i < 40; i++) out += parseInt(h[i], 16) >= 8 ? a[i].toUpperCase() : a[i];
  return out;
}
export const isAddress = (a) => /^0x[0-9a-fA-F]{40}$/.test(String(a || ''));
export const sameAddr = (a, b) => isAddress(a) && isAddress(b) && a.toLowerCase() === b.toLowerCase();

/** sign a 32-byte digest → { r, s, v (27/28), sig: 65-byte hex } (low-s) */
export function signDigest(privKey, digest) {
  const sig = secp256k1.sign(bytes(digest), bytes(privKey), { lowS: true });
  const r = pad32(bigToBytes(sig.r)), s = pad32(bigToBytes(sig.s));
  const v = 27 + sig.recovery;
  return { r: hex(r), s: hex(s), v, yParity: sig.recovery, sig: hex(concatBytes(r, s, new Uint8Array([v]))) };
}

export function recoverDigest(digest, sigHex) {
  const b = bytes(sigHex);
  if (b.length !== 65) throw new Error('bad signature length');
  let v = b[64];
  if (v < 27) v += 27;
  const sig = secp256k1.Signature.fromCompact(b.slice(0, 64)).addRecoveryBit(v - 27);
  const pub = sig.recoverPublicKey(bytes(digest)).toRawBytes(false);
  return checksum(hex(keccak_256(pub.slice(1)).slice(12)));
}

/** EIP-191 personal_sign digest */
export function personalDigest(message) {
  const m = utf8ToBytes(message);
  return hex(keccak_256(concatBytes(utf8ToBytes(`\x19Ethereum Signed Message:\n${m.length}`), m)));
}
export const recoverPersonal = (message, sig) => recoverDigest(personalDigest(message), sig);

// -------------------------------------------------------------------- ABI
// Supported types: uint*, int (non-negative only), address, bool, bytes32, bytes, string, T[] of static/dynamic above.
const isDynamic = (t) => t === 'bytes' || t === 'string' || t.endsWith('[]');

function encodeStatic(t, v) {
  if (t === 'address') return pad32(bytes(v));
  if (t === 'bool') return pad32(bigToBytes(v ? 1 : 0));
  if (t === 'bytes32') { const b = bytes(v); if (b.length !== 32) throw new Error('bytes32 length'); return b; }
  if (t.startsWith('uint')) return pad32(bigToBytes(v));
  throw new Error('unsupported abi type ' + t);
}

export function abiEncode(types, values) {
  const heads = [], tails = [];
  let tailLen = 0;
  const headSize = types.length * 32;
  for (let i = 0; i < types.length; i++) {
    const t = types[i], v = values[i];
    if (!isDynamic(t)) { heads.push(encodeStatic(t, v)); continue; }
    let enc;
    if (t === 'bytes' || t === 'string') {
      const b = t === 'string' ? utf8ToBytes(v) : bytes(v);
      const padded = new Uint8Array(Math.ceil(b.length / 32) * 32);
      padded.set(b);
      enc = concatBytes(pad32(bigToBytes(b.length)), padded);
    } else {
      const inner = t.slice(0, -2);
      enc = concatBytes(pad32(bigToBytes(v.length)), abiEncode(v.map(() => inner), v));
    }
    heads.push(pad32(bigToBytes(headSize + tailLen)));
    tails.push(enc);
    tailLen += enc.length;
  }
  return concatBytes(...heads, ...tails);
}

export function abiDecode(types, data) {
  const b = bytes(data);
  const word = (o) => b.slice(o, o + 32);
  const out = [];
  const read = (t, o, base) => {
    if (t === 'address') return checksum(hex(word(o).slice(12)));
    if (t === 'bool') return bytesToBig(word(o)) !== 0n;
    if (t === 'bytes32') return hex(word(o));
    if (t.startsWith('uint')) return bytesToBig(word(o));
    const off = base + Number(bytesToBig(word(o)));
    if (t === 'bytes' || t === 'string') {
      const len = Number(bytesToBig(word(off)));
      const raw = b.slice(off + 32, off + 32 + len);
      return t === 'string' ? new TextDecoder().decode(raw) : hex(raw);
    }
    const inner = t.slice(0, -2);
    const len = Number(bytesToBig(word(off)));
    const arr = [];
    for (let i = 0; i < len; i++) arr.push(read(inner, off + 32 + i * 32, off + 32));
    return arr;
  };
  for (let i = 0; i < types.length; i++) out.push(read(types[i], i * 32, 0));
  return out;
}

export const selector = (sig) => keccakText(sig).slice(0, 10);
export function calldata(sig, values) {
  const types = sig.slice(sig.indexOf('(') + 1, -1).split(',').filter(Boolean);
  return hex(concatBytes(bytes(selector(sig)), abiEncode(types, values)));
}

// ------------------------------------------------------------------ EIP-712
const DOMAIN_TYPEHASH = keccakText('EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)');
export function domainSeparator(chainId, verifyingContract, name = 'DeckhandEscrow', version = '1') {
  return keccak(abiEncode(['bytes32', 'bytes32', 'bytes32', 'uint256', 'address'], [DOMAIN_TYPEHASH, keccakText(name), keccakText(version), chainId, verifyingContract]));
}
export function typedDigest(domainSep, structHash) {
  return keccak(concatBytes(new Uint8Array([0x19, 0x01]), bytes(domainSep), bytes(structHash)));
}
export const RESULT_TYPEHASH = keccakText('Result(bytes32 matchId,address winner,bytes32 resultHash)');
export const JOIN_TYPEHASH = keccakText('Join(bytes32 matchId,address player,uint64 expiry)');
export function resultDigest(chainId, escrow, matchId, winner, resultHash) {
  return typedDigest(domainSeparator(chainId, escrow), keccak(abiEncode(['bytes32', 'bytes32', 'address', 'bytes32'], [RESULT_TYPEHASH, matchId, winner, resultHash])));
}
export function joinDigest(chainId, escrow, matchId, player, expiry) {
  return typedDigest(domainSeparator(chainId, escrow), keccak(abiEncode(['bytes32', 'bytes32', 'address', 'uint64'], [JOIN_TYPEHASH, matchId, player, expiry])));
}

// -------------------------------------------------------------------- RLP
function rlp(item) {
  if (Array.isArray(item)) {
    const body = concatBytes(...item.map(rlp));
    return concatBytes(rlpLen(body.length, 0xc0), body);
  }
  const b = item instanceof Uint8Array ? item : bytes(item);
  if (b.length === 1 && b[0] < 0x80) return b;
  return concatBytes(rlpLen(b.length, 0x80), b);
}
function rlpLen(len, offset) {
  if (len < 56) return new Uint8Array([offset + len]);
  const lb = bigToBytes(len);
  return concatBytes(new Uint8Array([offset + 55 + lb.length]), lb);
}

/** sign an EIP-1559 transaction; returns raw hex and tx hash */
export function signTx(privKey, tx) {
  const fields = [
    bigToBytes(tx.chainId), bigToBytes(tx.nonce), bigToBytes(tx.maxPriorityFeePerGas), bigToBytes(tx.maxFeePerGas),
    bigToBytes(tx.gas), tx.to ? bytes(tx.to) : new Uint8Array(), bigToBytes(tx.value || 0), bytes(tx.data || '0x'), [],
  ];
  const unsigned = concatBytes(new Uint8Array([2]), rlp(fields));
  const sig = secp256k1.sign(keccak_256(unsigned), bytes(privKey), { lowS: true });
  const signed = concatBytes(new Uint8Array([2]), rlp([...fields, bigToBytes(sig.recovery), bigToBytes(sig.r), bigToBytes(sig.s)]));
  return { raw: hex(signed), hash: hex(keccak_256(signed)) };
}

/** address of a contract deployed by `from` at `nonce` */
export function createAddress(from, nonce) {
  return checksum(hex(keccak_256(rlp([bytes(from), bigToBytes(nonce)])).slice(12)));
}

// -------------------------------------------------------------------- RPC
export class Rpc {
  constructor(url, { timeoutMs = 15000 } = {}) {
    this.url = url;
    this.timeoutMs = timeoutMs;
    this.id = 0;
  }
  async call(method, params = [], { retries = 3 } = {}) {
    let lastErr;
    for (let k = 0; k <= retries; k++) {
      try {
        const ctl = new AbortController();
        const timer = setTimeout(() => ctl.abort(), this.timeoutMs);
        const res = await fetch(this.url, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ jsonrpc: '2.0', id: ++this.id, method, params }),
          signal: ctl.signal,
        }).finally(() => clearTimeout(timer));
        if (res.status === 429 || res.status >= 500) throw Object.assign(new Error(`rpc http ${res.status}`), { retry: true });
        const j = await res.json();
        if (j.error) {
          const e = new Error(`${method}: ${j.error.message || JSON.stringify(j.error)}`);
          e.rpc = j.error;
          throw e;
        }
        return j.result;
      } catch (e) {
        lastErr = e;
        if (e.rpc) throw e; // node answered: do not retry
        await new Promise((r) => setTimeout(r, 400 * (k + 1)));
      }
    }
    throw lastErr;
  }
  chainId() { return this.call('eth_chainId').then((h) => Number(BigInt(h))); }
  blockNumber() { return this.call('eth_blockNumber').then((h) => Number(BigInt(h))); }
  balance(a) { return this.call('eth_getBalance', [a, 'latest']).then(BigInt); }
  nonce(a, tag = 'pending') { return this.call('eth_getTransactionCount', [a, tag]).then((h) => Number(BigInt(h))); }
  ethCall(to, data, from) { return this.call('eth_call', [{ to, data, ...(from ? { from } : {}) }, 'latest']); }
  receipt(h) { return this.call('eth_getTransactionReceipt', [h]); }
  logs(filter) { return this.call('eth_getLogs', [filter]); }
  code(a) { return this.call('eth_getCode', [a, 'latest']); }
  async fees() {
    const base = BigInt(await this.call('eth_gasPrice'));
    let tip = 0n;
    try { tip = BigInt(await this.call('eth_maxPriorityFeePerGas', [], { retries: 0 })); } catch { tip = 0n; }
    if (tip > base) tip = base;
    return { maxFeePerGas: base * 2n + tip, maxPriorityFeePerGas: tip };
  }
}

/** One key that sends transactions in order with its own nonce bookkeeping. */
export class Sender {
  constructor(rpc, privKey, chainId, log = () => {}) {
    this.rpc = rpc;
    this.key = privKey;
    this.address = addressOf(privKey);
    this.chainId = chainId;
    this.queue = Promise.resolve();
    this.nextNonce = null;
    this.log = log;
  }
  /** send {to, data, value, gas?}; resolves to tx hash once accepted by the node */
  send(tx) {
    const run = async () => {
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          if (this.nextNonce === null) this.nextNonce = await this.rpc.nonce(this.address, 'pending');
          const fees = await this.rpc.fees();
          let gas = tx.gas;
          if (!gas) {
            const est = await this.rpc.call('eth_estimateGas', [{ from: this.address, to: tx.to, data: tx.data, value: '0x' + BigInt(tx.value || 0).toString(16) }]);
            gas = (BigInt(est) * 12n) / 10n + 10000n;
          }
          const signed = signTx(this.key, { chainId: this.chainId, nonce: this.nextNonce, gas, ...fees, to: tx.to, value: tx.value || 0n, data: tx.data });
          await this.rpc.call('eth_sendRawTransaction', [signed.raw], { retries: 1 });
          this.nextNonce += 1;
          return signed.hash;
        } catch (e) {
          const msg = String(e.message || e);
          this.log('tx send failed', msg);
          if (/nonce|underpriced|already known/i.test(msg)) { this.nextNonce = null; continue; }
          throw e;
        }
      }
      throw new Error('could not send transaction');
    };
    const p = this.queue.then(run, run);
    this.queue = p.catch(() => {});
    return p;
  }
  async wait(hash, { timeoutMs = 120000 } = {}) {
    const t0 = Date.now();
    while (Date.now() - t0 < timeoutMs) {
      const r = await this.rpc.receipt(hash).catch(() => null);
      if (r) {
        if (r.status !== '0x1') throw Object.assign(new Error('transaction reverted ' + hash), { receipt: r });
        return r;
      }
      await new Promise((res) => setTimeout(res, 700));
    }
    throw new Error('timed out waiting for ' + hash);
  }
}

export const ETH = 10n ** 18n;
export function parseEth(s) {
  const [w, f = ''] = String(s).trim().split('.');
  if (!/^\d+$/.test(w || '0') || !/^\d*$/.test(f) || f.length > 18) throw new Error('bad ETH amount ' + s);
  return BigInt(w || '0') * ETH + BigInt((f + '0'.repeat(18)).slice(0, 18));
}
export function formatEth(wei, digits = 6) {
  wei = BigInt(wei);
  const neg = wei < 0n;
  if (neg) wei = -wei;
  const w = wei / ETH, f = (wei % ETH).toString().padStart(18, '0').slice(0, digits).replace(/0+$/, '');
  return (neg ? '-' : '') + w.toString() + (f ? '.' + f : '');
}
