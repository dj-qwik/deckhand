// Fairness probe: normal bots only, many seeds. node tools/fair.mjs arena n rounds
import { createMatch, applyInput, step } from '../game/sim/sim.js';
import { makeBot, botThink } from '../game/sim/bots.js';
const [arena = 'refinery', n = 2, R = 200] = process.argv.slice(2).map((v, i) => (i ? +v : v));
const wins = Array(n).fill(0), hp = Array(n).fill(0), base = Array(n).fill(0);
for (let k = 0; k < R; k++) {
  const seed = (0x2000000 + k * 104729).toString(16);
  const S = createMatch({ seed, arena, players: Array.from({ length: n }, () => ({})) });
  const bots = S.players.map((p) => makeBot(p.slot, { skill: 0.85, seed: k * 31 + 1 }));
  while (S.phase !== 'done') { for (const b of bots) for (const a of botThink(S, b)) applyInput(S, b.slot, a); S.events.length = 0; step(S); }
  wins[S.result.winner]++;
  for (const r of S.result.rank) { hp[r.slot] += r.hp; base[r.slot] += r.base; }
}
console.log(arena, n, 'wins%', wins.map((w) => Math.round(100 * w / R)), 'avgHp', hp.map((v) => Math.round(v / R)), 'avgBase', base.map((v) => Math.round(v / R)));
