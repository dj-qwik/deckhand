// Determinism check: play N bot matches through the real Room code path, then
// replay each evidence log twice (once in this process, once in a fresh child
// process) and require identical result hashes and winners.
// Usage: node tools/determinism.mjs [N]
import { fork } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { Room } from '../server/room.mjs';
import { replay } from '../game/sim/sim.js';
import { ARENA_IDS } from '../game/sim/arenas.js';

const N = Number(process.argv[2] || 4);

if (process.argv[2] === '--child') {
  process.on('message', ({ cfg, log }) => {
    const S = replay(cfg, log);
    process.send({ hash: S.result.hash, winner: S.result.winner });
  });
} else {
  let bad = 0;
  for (let k = 0; k < N; k++) {
    const n = 2 + (k % 3);
    const arena = ARENA_IDS[k % ARENA_IDS.length];
    const seats = Array.from({ length: n }, (_, i) => ({ name: `Bot ${i}`, bot: { skill: 0.5 + 0.1 * i, seed: 1000 + k * 17 + i } }));
    const simCfg = { seed: (0xabc0000 + k * 977).toString(16).padStart(32, '0'), arena, players: seats.map((s) => ({ name: s.name })) };
    const room = new Room({ id: 'det' + k, mode: 'practice', simCfg, seats });
    while (room.S.phase !== 'done') room.tick();
    const a = room.S.result;
    const r1 = replay(simCfg, room.evidence).result;
    const child = fork(fileURLToPath(import.meta.url), ['--child']);
    const r2 = await new Promise((res) => { child.on('message', (m) => { child.kill(); res(m); }); child.send({ cfg: simCfg, log: room.evidence }); });
    const ok = a.hash === r1.hash && a.hash === r2.hash && a.winner === r1.winner && a.winner === r2.winner;
    if (!ok) bad++;
    console.log(`${ok ? 'OK ' : 'BAD'} ${arena} ${n}p ticks=${room.S.tick} inputs=${room.evidence.length} hash=${a.hash} replay=${r1.hash} child=${r2.hash} winner=${a.winner}`);
  }
  if (bad) { console.error(`${bad} non-deterministic matches`); process.exit(1); }
  console.log('determinism OK');
}
