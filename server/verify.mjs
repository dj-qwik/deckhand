// Independent result verification: replay the evidence and derive the result hash
// that the escrow's co-signers sign. Used by the server and by every co-signer.
import { replay, SIM_VERSION } from '../game/sim/sim.js';
import { ARENA_IDS } from '../game/sim/arenas.js';
import { keccakText, isAddress, checksum } from './eth.mjs';

export function canonical(v) {
  if (Array.isArray(v)) return '[' + v.map(canonical).join(',') + ']';
  if (v && typeof v === 'object') return '{' + Object.keys(v).sort().map((k) => JSON.stringify(k) + ':' + canonical(v[k])).join(',') + '}';
  return JSON.stringify(v);
}

const MAX_LOG = 200000;
const MAX_TICKS = 20 * 60 * 10;

/** throws on malformed evidence; returns the verified result */
export function verifyEvidence(ev) {
  if (!ev || ev.v !== 1) throw new Error('unknown evidence version');
  if (ev.simVersion !== SIM_VERSION) throw new Error(`sim version ${ev.simVersion} ≠ ${SIM_VERSION}`);
  if (!/^0x[0-9a-f]{64}$/i.test(ev.matchId || '')) throw new Error('bad matchId');
  const { cfg, log, wallets } = ev;
  if (!cfg || !Array.isArray(cfg.players) || cfg.players.length < 2 || cfg.players.length > 4) throw new Error('bad player list');
  if (!ARENA_IDS.includes(cfg.arena)) throw new Error('unknown arena');
  if (typeof cfg.seed !== 'string' || !/^[0-9a-f]{32,64}$/i.test(cfg.seed)) throw new Error('bad seed');
  if (!Array.isArray(wallets) || wallets.length !== cfg.players.length || !wallets.every(isAddress)) throw new Error('bad wallets');
  if (new Set(wallets.map((w) => w.toLowerCase())).size !== wallets.length) throw new Error('duplicate wallets');
  if (!Array.isArray(log) || log.length > MAX_LOG) throw new Error('bad log');
  let last = 0;
  for (const e of log) {
    if (!Array.isArray(e) || e.length !== 3) throw new Error('bad log entry');
    const [t, s, a] = e;
    if (!Number.isInteger(t) || t < last) throw new Error('log out of order');
    if (!Number.isInteger(s) || s < 0 || s >= cfg.players.length) throw new Error('bad slot');
    if (!a || typeof a !== 'object' || typeof a.t !== 'string') throw new Error('bad action');
    last = t;
  }
  const S = replay(cfg, log, { maxTicks: MAX_TICKS });
  if (S.phase !== 'done' || !S.result) throw new Error('match did not finish');
  const winnerSlot = S.result.winner;
  const winner = checksum(wallets[winnerSlot]);
  const evidenceHash = keccakText(canonical(ev));
  const simHash = S.result.hash;
  const resultHash = keccakText(`deckhand:v1:${ev.matchId.toLowerCase()}:${winner.toLowerCase()}:${simHash}:${evidenceHash}`);
  return { winnerSlot, winner, simHash, evidenceHash, resultHash, rank: S.result.rank, ticks: S.tick };
}
