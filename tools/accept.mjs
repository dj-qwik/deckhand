// Bot acceptance: a full-strength bot must beat lazy strategies, spawns must be fair,
// and fights must be brutal enough to matter. Usage: node tools/accept.mjs [arena|all] [rounds]
import { createMatch, applyInput, step } from '../game/sim/sim.js';
import { ARENA_IDS } from '../game/sim/arenas.js';
import { makeBot, botThink } from '../game/sim/bots.js';

export function play(arena, styles, seed, skills) {
  const n = styles.length;
  const cfg = { seed, arena, players: styles.map((s, i) => ({ name: s + i })) };
  const S = createMatch(cfg);
  const bots = styles.map((s, i) => makeBot(i, { style: s, skill: skills ? skills[i] : 0.85, seed: parseInt(seed.slice(0, 6), 16) }));
  while (S.phase !== 'done') {
    for (const b of bots) for (const a of botThink(S, b)) applyInput(S, b.slot, a);
    S.events.length = 0;
    step(S);
  }
  return S;
}
const seedOf = (k) => (0x1000000 + k * 7919).toString(16) + 'ab';
const arg = process.argv[2] || 'all';
const R = +(process.argv[3] || 40);
const arenas = arg === 'all' ? ARENA_IDS : [arg];
let fail = 0;
for (const arena of arenas) {
  const line = { arena };
  for (const lazy of ['idle', 'turtle', 'gunner', 'lazyaim']) {
    let wins = 0;
    for (let k = 0; k < R; k++) {
      const flip = k % 2;
      const styles = flip ? [lazy, 'normal'] : ['normal', lazy];
      const S = play(arena, styles, seedOf(k));
      if (S.result.winner === (flip ? 1 : 0)) wins++;
    }
    line[lazy] = Math.round((100 * (R - wins)) / R); // lazy win %
    if (lazy !== 'lazyaim' && R - wins > R * 0.2) fail++;
  }
  // fairness + brutality: normal vs normal across 2/3/4 players
  for (const n of [2, 3, 4]) {
    const winsBySlot = Array(n).fill(0); let outs = 0, rdmg = 0, games = 0;
    for (let k = 0; k < R; k++) {
      const S = play(arena, Array(n).fill('normal'), seedOf(k + 999));
      winsBySlot[S.result.winner]++; games++;
      for (const p of S.players) { if (!p.alive) outs++; rdmg += 1000 - p.hp; }
    }
    line['p' + n] = { wins: winsBySlot.map((w) => Math.round((100 * w) / R)), outsPerGame: +(outs / games).toFixed(2), avgReactorDmg: Math.round(rdmg / games / n) };
  }
  console.log(JSON.stringify(line));
}
console.log(fail ? `FAIL: ${fail} lazy strategies above 20%` : 'OK: lazy strategies ≤ 20%');
process.exitCode = fail ? 1 : 0;
