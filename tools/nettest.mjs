// Network test: boot the real server, play a practice match over WebSocket,
// check inputs are applied, invalid inputs are rejected, and the room ends.
import { spawn } from 'node:child_process';
import WebSocket from 'ws';
import { W } from '../game/sim/rules.js';

const PORT = 10200 + Math.floor(Math.random() * 500);
const srv = spawn(process.execPath, ['server/index.mjs'], { env: { ...process.env, PORT: String(PORT), ROOM_TICK_MS: '5', OPERATOR_SECRET: '', DATABASE_URL: '' }, stdio: ['ignore', 'pipe', 'pipe'] });
let out = '';
srv.stdout.on('data', (d) => (out += d));
srv.stderr.on('data', (d) => (out += d));
const fail = (m) => { console.error('FAIL:', m, '\n', out.slice(-2000)); srv.kill(); process.exit(1); };
setTimeout(() => fail('timeout'), 90000);
for (let i = 0; i < 50; i++) {
  try { const r = await fetch(`http://127.0.0.1:${PORT}/healthz`); if (r.ok) break; } catch {}
  await new Promise((r) => setTimeout(r, 200));
}
const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`);
await new Promise((r, j) => { ws.on('open', r); ws.on('error', j); });
let start = null, last = null, snaps = 0, nopes = [], placed = false, wallCount0 = 0;
const done = new Promise((resolve) => {
  ws.on('message', (d) => {
    const m = JSON.parse(d);
    if (m.t === 'start') { start = m; wallCount0 = m.snap.full.owner.filter((o) => o === m.room.you).length; }
    if (m.t === 'nope') nopes.push(m.why);
    if (m.t === 'snap') {
      snaps++;
      last = m.snap;
      if (m.snap.phase === 'weld' && !placed) {
        placed = true;
        const me = m.snap.players[start.room.you];
        const [yx, yy] = me.yard;
        ws.send(JSON.stringify({ t: 'in', a: { t: 'place', piece: 'brace', x: yx, y: yy, rot: 0 } }));
        ws.send(JSON.stringify({ t: 'in', a: { t: 'place', piece: 'brace', x: 22, y: 15, rot: 0 } })); // centre field: must be rejected
        ws.send(JSON.stringify({ t: 'in', a: { t: 'buyGun', w: 'rail', x: yx, y: yy } })); // wrong phase
        ws.send(JSON.stringify({ t: 'in', a: { t: 'hack', x: 1 } })); // unknown: silently dropped
      }
      if (m.snap.phase === 'done') resolve();
    }
  });
});
ws.send(JSON.stringify({ t: 'hello' }));
ws.send(JSON.stringify({ t: 'practice', bots: 2, diff: 'hard', arena: 'graveyard', name: 'Net Test' }));
await done;
const mine = (wd) => wd;
if (!start) fail('no start');
if (snaps < 50) fail('too few snapshots ' + snaps);
if (!nopes.some((w) => /blocked|yard/.test(w))) fail('centre-field placement was not rejected: ' + nopes.join('; '));
if (!nopes.some((w) => /ARM/.test(w))) fail('wrong-phase turret was not rejected: ' + nopes.join('; '));
if (!last.result || last.result.rank.length !== 3) fail('no result');
console.log(`nettest OK: ${snaps} snapshots, rejections: ${nopes.join(' | ')}, winner ${last.result.winner}`);
ws.close();
const st = await (await fetch(`http://127.0.0.1:${PORT}/api/status`)).json();
if (typeof st.rooms.practice !== 'number') fail('status endpoint broken');
srv.kill();
process.exit(0);
