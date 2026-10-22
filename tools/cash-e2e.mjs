// Real-money end-to-end test on a local anvil chain, using the real server,
// the real escrow bytecode, real co-signer processes and (optionally) Postgres.
//
//   node tools/cash-e2e.mjs            testnet settings (chain 46630)
//   node tools/cash-e2e.mjs --mainnet  mainnet settings (chain 4663, raw-key opt-in, Postgres required)
//
// Scenarios: a 2-crew match settles 90/10 on-chain; a paid player leaves and the
// lobby refunds; an unfilled lobby refunds at its deadline; the server is killed
// mid-match and refunds everyone on restart (needs DATABASE_URL).
// Needs `anvil` on PATH. DATABASE_URL must point at a throwaway database: its
// DECKHAND tables are dropped first.
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import WebSocket from 'ws';
import { Rpc, Sender, deriveKey, addressOf, parseEth, formatEth, signDigest, personalDigest } from '../server/eth.mjs';
import { verifyEvidence } from '../server/verify.mjs';

const MAINNET = process.argv.includes('--mainnet');
const CHAIN_ID = MAINNET ? 4663 : 46630;
const DB = process.env.DATABASE_URL || '';
if (MAINNET && !DB) { console.error('--mainnet needs DATABASE_URL'); process.exit(1); }
const ANVIL_PORT = 18545 + Math.floor(Math.random() * 1000);
const PORT = 11000 + Math.floor(Math.random() * 1000);
const RPC = `http://127.0.0.1:${ANVIL_PORT}`;
const BASE = `http://127.0.0.1:${PORT}`;
const OWNER = '0x9944eaEf8197ee5604C1063c525c71DE5D501a1D';
const ANVIL0 = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const t0 = Date.now();
const log = (...a) => console.log(`[${((Date.now() - t0) / 1000).toFixed(1)}s]`, ...a);
const procs = [];
let srvOut = '';
function die(msg) {
  console.error('FAIL:', msg);
  console.error(srvOut.slice(-4000));
  for (const p of procs) try { p.kill('SIGKILL'); } catch {}
  process.exit(1);
}
const assert = (c, m) => { if (!c) die(m); };
setTimeout(() => die('global timeout'), 8 * 60 * 1000);

// ------------------------------------------------------------------ chain
const anvil = spawn('anvil', ['--port', String(ANVIL_PORT), '--chain-id', String(CHAIN_ID), '--silent', '--block-time', '1'], { stdio: 'ignore' });
procs.push(anvil);
const rpc = new Rpc(RPC);
for (let i = 0; i < 50; i++) { try { await rpc.chainId(); break; } catch { await sleep(200); } }
assert((await rpc.chainId()) === CHAIN_ID, 'anvil chain id');
const funder = new Sender(rpc, ANVIL0, CHAIN_ID);
async function fund(addr, eth) { await funder.wait(await funder.send({ to: addr, value: parseEth(eth), gas: 21000n })); }

// -------------------------------------------------------------------- db
if (DB) {
  if (!/localhost|127\.0\.0\.1|e2e|test/.test(DB) && !process.env.E2E_DB_OK) die('DATABASE_URL does not look like a throwaway test database (set E2E_DB_OK=1 to force)');
  const pg = (await import('pg')).default;
  const c = new pg.Client({ connectionString: DB });
  await c.connect();
  await c.query('drop table if exists kv, consents, matches, evidence');
  await c.end();
}

// ---------------------------------------------------------------- server
const secrets = { OPERATOR_SECRET: randomBytes(24).toString('hex'), COSIGNER_A_SECRET: randomBytes(24).toString('hex'), COSIGNER_B_SECRET: randomBytes(24).toString('hex') };
const operator = addressOf(deriveKey(secrets.OPERATOR_SECRET, 'operator'));
await fund(operator, '1');
const env = {
  ...process.env, ...secrets, PORT: String(PORT), CHAIN_ID: String(CHAIN_ID), RPC_URL: RPC, OWNER_ADDRESS: OWNER, PRIVY_APP_ID: 'e2e-test',
  DATABASE_URL: DB, ROOM_TICK_MS: '4', LOBBY_SECONDS: '30', CHAIN_POLL_MS: '300', EMBEDDED_COSIGNERS: '2',
  ...(MAINNET ? { ALLOW_RAW_KEYS_ON_MAINNET: 'i-understand' } : {}),
};
let server;
function startServer() {
  server = spawn(process.execPath, ['server/index.mjs'], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  server.stdout.on('data', (d) => (srvOut += d));
  server.stderr.on('data', (d) => (srvOut += d));
  procs.push(server);
}
async function waitReady() {
  for (let i = 0; i < 200; i++) {
    try {
      const s = await (await fetch(BASE + '/api/status')).json();
      if (s.ok && s.cosigners.every((c) => c.ready)) return s;
    } catch {}
    await sleep(250);
  }
  die('server never became ready');
}
startServer();
const status = await waitReady();
log('server ready. escrow', status.escrow, 'roles', JSON.stringify(status.roles));
assert(status.roles.isOperator && status.roles.threshold === 2, 'escrow roles');
assert(status.roles.treasury.toLowerCase() === OWNER.toLowerCase(), 'treasury is owner');
assert(status.roles.pendingAdmin.toLowerCase() === OWNER.toLowerCase(), 'admin transfer to owner started');

// --------------------------------------------------------------- players
class Player {
  constructor(name) {
    this.name = name;
    this.key = '0x' + randomBytes(32).toString('hex');
    this.address = addressOf(this.key);
    this.sender = new Sender(rpc, this.key, CHAIN_ID);
  }
  async api(path, body) {
    const r = await fetch(BASE + path, { method: body ? 'POST' : 'GET', headers: { 'content-type': 'application/json', ...(this.token ? { authorization: 'Bearer ' + this.token } : {}) }, body: body ? JSON.stringify(body) : undefined });
    const j = await r.json();
    if (!r.ok) throw new Error(`${path}: ${j.error}`);
    return j;
  }
  async login() {
    const ch = await this.api('/api/auth/challenge?wallet=' + this.address);
    assert(ch.message.includes('21 or older'), 'consent text in sign-in message');
    const signature = signDigest(this.key, personalDigest(ch.message)).sig;
    const r = await this.api('/api/auth/verify', { wallet: this.address, nonce: ch.nonce, signature });
    this.token = r.token;
  }
  async queue(seats, stake = 0) {
    const r = await this.api('/api/queue', { stake, seats, name: this.name });
    this.lobbyId = r.lobby.id;
    return r;
  }
  async waitLobby(pred, what, ms = 60000) {
    const t = Date.now();
    while (Date.now() - t < ms) {
      const m = await this.api('/api/match/' + this.lobbyId);
      if (pred(m)) return m;
      await sleep(300);
    }
    die(`${this.name}: timed out waiting for ${what}`);
  }
  async deposit() {
    await this.waitLobby((m) => m.status === 'open', 'lobby open');
    const { deposit: d } = await this.api('/api/deposit');
    const h = await this.sender.send({ to: d.escrow, data: d.data, value: BigInt(d.valueWei) });
    await this.sender.wait(h);
    return h;
  }
  connect() {
    this.ws = new WebSocket(BASE.replace('http', 'ws') + '/ws');
    this.snaps = 0;
    this.ws.on('open', () => this.ws.send(JSON.stringify({ t: 'hello', token: this.token })));
    this.ws.on('message', (d) => {
      const m = JSON.parse(d);
      if (m.t === 'start') this.started = m;
      if (m.t === 'snap') { this.snaps++; this.last = m.snap; }
      if (m.t === 'lobby') this.lobby = m.lobby;
    });
    this.ws.on('error', () => {});
  }
}
async function players(names) {
  const ps = names.map((n) => new Player(n));
  for (const p of ps) { await fund(p.address, '0.05'); await p.login(); }
  return ps;
}

// ======================================================= A: full paid match
log('A: two crews, full match, co-signed settlement');
const [a1, a2] = await players(['Alpha', 'Bravo']);
await a1.queue(2);
await a2.queue(2);
assert(a1.lobbyId === a2.lobbyId, 'both crews in one lobby');
a1.connect(); a2.connect();
const before = { a1: await rpc.balance(a1.address), a2: await rpc.balance(a2.address), owner: await rpc.balance(OWNER) };
const g1 = await a1.deposit();
const g2 = await a2.deposit();
const gasOf = async (h) => { const r = await rpc.receipt(h); return BigInt(r.gasUsed) * BigInt(r.effectiveGasPrice); };
const gas = { a1: await gasOf(g1), a2: await gasOf(g2) };
await a1.waitLobby((m) => m.status === 'playing', 'match start', 30000);
log('A: match playing');
const settled = await a1.waitLobby((m) => m.status === 'settled' || m.status === 'failed' || m.status === 'refunded', 'settlement', 120000);
assert(settled.status === 'settled', 'A settled, got ' + settled.status + ' ' + (settled.error || ''));
assert(a1.snaps > 100 && a2.snaps > 100, 'both clients received snapshots');
assert(a1.started && a1.started.room.mode === 'cash', 'client got cash room start');
const winner = settled.payout.winner;
const after = { a1: await rpc.balance(a1.address), a2: await rpc.balance(a2.address), owner: await rpc.balance(OWNER) };
const entry = parseEth('0.001');
const pot = entry * 2n;
const winnerShare = (pot * 90n) / 100n;
const deltaWinner = winner.toLowerCase() === a1.address.toLowerCase() ? after.a1 - before.a1 + gas.a1 : after.a2 - before.a2 + gas.a2;
assert(deltaWinner === winnerShare - entry, `winner net ${formatEth(deltaWinner)} (want ${formatEth(winnerShare - entry)})`);
assert(after.owner - before.owner === pot - winnerShare, `house got ${formatEth(after.owner - before.owner)}`);
const ev = await a1.api(`/api/match/${a1.lobbyId}/evidence`);
const mine = verifyEvidence(ev);
assert(mine.winner.toLowerCase() === winner.toLowerCase(), 'independent replay agrees with on-chain winner');
log(`A: OK. winner ${winner} +${formatEth(winnerShare)} ETH, house +${formatEth(pot - winnerShare)} ETH, settle tx ${settled.settleTx}`);
a1.ws.close(); a2.ws.close();

// ================================================== B: paid player leaves
log('B: paid crew leaves before lock → whole lobby refunds');
const [b1] = await players(['Charlie']);
await b1.queue(3);
const bBefore = await rpc.balance(b1.address);
const bh = await b1.deposit();
const bGas = await gasOf(bh);
await b1.waitLobby((m) => m.seatList.some((s) => s.funded), 'deposit seen');
await b1.api('/api/leave', {});
await b1.waitLobby((m) => m.status === 'refunded', 'refund', 60000);
const bAfter = await rpc.balance(b1.address);
assert(bAfter + bGas === bBefore, `refund exact (diff ${formatEth(bBefore - bAfter - bGas)})`);
log('B: OK, refunded in full');

// ================================================ C: crash mid-match → refund
if (DB) {
  log('C: server killed mid-match → refund on restart');
  const [c1, c2] = await players(['Delta', 'Echo']);
  await c1.queue(2);
  await c2.queue(2);
  const cb = { c1: await rpc.balance(c1.address), c2: await rpc.balance(c2.address) };
  const ch1 = await c1.deposit();
  const ch2 = await c2.deposit();
  const cg = { c1: await gasOf(ch1), c2: await gasOf(ch2) };
  await c1.waitLobby((m) => m.status === 'playing', 'match start', 30000);
  await sleep(1500);
  server.kill('SIGKILL');
  log('C: server killed');
  await sleep(500);
  startServer();
  await waitReady();
  await c1.waitLobby((m) => m.status === 'refunded', 'refund after restart', 60000);
  assert((await rpc.balance(c1.address)) + cg.c1 === cb.c1, 'c1 refunded exactly');
  assert((await rpc.balance(c2.address)) + cg.c2 === cb.c2, 'c2 refunded exactly');
  log('C: OK, both crews refunded after restart');
} else log('C: skipped (no DATABASE_URL)');

// ================================================ D: unfilled lobby expires
log('D: unfilled lobby refunds at its deadline');
const [d1] = await players(['Foxtrot']);
await d1.queue(4);
const dBefore = await rpc.balance(d1.address);
const dh = await d1.deposit();
const dGas = await gasOf(dh);
await d1.waitLobby((m) => m.status === 'refunded', 'deadline refund', 120000);
assert((await rpc.balance(d1.address)) + dGas === dBefore, 'deadline refund exact');
log('D: OK');

// ============================================ E: escrow holds nothing left
const escBal = await rpc.balance(status.escrow);
assert(escBal === 0n, 'escrow is empty at the end, holds ' + formatEth(escBal));
log(`ALL CASH E2E PASSED (${MAINNET ? 'mainnet' : 'testnet'} settings, db ${DB ? 'postgres' : 'memory'})`);
for (const p of procs) try { p.kill('SIGKILL'); } catch {}
process.exit(0);
