import { createMatch, applyInput, step, replay, ranking, baseScore } from '../game/sim/sim.js';
import { makeBot, botThink } from '../game/sim/bots.js';
const arena = process.argv[2] || 'rustdock', n = +(process.argv[3] || 2), seed = process.argv[4] || 'abc123';
const styles = (process.argv[5] || '').split(',').filter(Boolean);
const cfg = { seed, arena, players: Array.from({ length: n }, (_, i) => ({ name: 'B' + i })) };
const S = createMatch(cfg);
const bots = cfg.players.map((_, i) => makeBot(i, { style: styles[i] || 'normal', skill: 0.8, seed: 3 }));
const log = []; const rej = {};
const t0 = Date.now();
while (S.phase !== 'done') {
  for (const b of bots) for (const a of botThink(S, b)) { const r = applyInput(S, b.slot, a); if (r) rej[r] = (rej[r] || 0) + 1; else log.push([S.tick, b.slot, a]); }
  S.events.length = 0; step(S);
}
const ms = Date.now() - t0;
const R = replay(cfg, log);
console.log(JSON.stringify({ arena, n, ticks: S.tick, ms, inputs: log.length, hash: S.result.hash, replayHash: R.result.hash, match: S.result.hash === R.result.hash,
  rank: S.result.rank.map(r => ({ s: r.slot, alive: r.alive, base: r.base, hp: r.hp, dr: r.dr, ds: r.ds })), rej }, null, 0));
