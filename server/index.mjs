// DECKHAND server: HTTP API + static client + WebSocket match rooms + chain service.
import http from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { WebSocketServer } from 'ws';
import { loadConfig } from './config.mjs';
import { openDb } from './db.mjs';
import { Chain } from './chain.mjs';
import { Auth } from './auth.mjs';
import { Cash } from './cash.mjs';
import { Room } from './room.mjs';
import { formatEth, isAddress, checksum } from './eth.mjs';
import { ARENAS, ARENA_IDS } from '../game/sim/arenas.js';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const log = (...a) => console.log(new Date().toISOString(), ...a);
const cfg = loadConfig();
const db = await openDb(cfg.databaseUrl, log);
const chain = new Chain(cfg, db, log);
const auth = new Auth({ secret: cfg.operatorSecret, chainId: cfg.chainId, db });
const sockets = new Map(); // walletLower → Set<ws>
const practice = new Map(); // room id → Room
const TICK_MS = Number(process.env.ROOM_TICK_MS || 0) || undefined; // tests only

const notify = (w, msg) => {
  const set = sockets.get(w);
  if (!set) return;
  const s = JSON.stringify(msg);
  for (const ws of set) if (ws.readyState === 1) ws.send(s);
};

const cash = new Cash({
  cfg, db, chain, log, notify,
  startRoom(m) {
    const room = new Room({
      id: m.id, mode: 'cash', log, tickMs: TICK_MS,
      simCfg: { seed: m.seed, arena: m.arena, players: m.seatList.map((s) => ({ name: s.name })) },
      seats: m.seatList.map((s) => ({ wallet: s.wallet, name: s.name })),
      onEnd: (r) => cash.finished(m, r),
    });
    room.start();
    m.seatList.forEach((s, slot) => {
      for (const ws of sockets.get(s.wallet.toLowerCase()) || []) attachRoom(ws, room, slot);
    });
    return room;
  },
});

// ===================================================================== HTTP
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.woff2': 'font/woff2', '.txt': 'text/plain; charset=utf-8', '.map': 'application/json' };

async function serveStatic(req, res, url) {
  let base, rel;
  if (url.pathname.startsWith('/sim/')) { base = path.join(ROOT, 'game/sim'); rel = url.pathname.slice(5); }
  else if (url.pathname.startsWith('/wallet/')) { base = path.join(ROOT, 'dist/wallet'); rel = url.pathname.slice(8); }
  else { base = path.join(ROOT, 'public'); rel = url.pathname === '/' ? 'index.html' : url.pathname.slice(1); }
  const file = path.normalize(path.join(base, rel));
  if (!file.startsWith(base)) return send(res, 403, 'forbidden');
  try {
    const st = await stat(file);
    if (!st.isFile()) throw new Error('not a file');
    const body = await readFile(file);
    const hashed = /\/assets\/.+-[A-Za-z0-9_-]{8,}\.(js|css|woff2|png|svg)$/.test(file);
    res.writeHead(200, {
      'content-type': TYPES[path.extname(file)] || 'application/octet-stream',
      'cache-control': hashed ? 'public, max-age=31536000, immutable' : 'no-cache',
      'x-content-type-options': 'nosniff',
    });
    res.end(body);
  } catch {
    send(res, 404, 'not found');
  }
}

function send(res, code, body, type = 'text/plain; charset=utf-8') {
  res.writeHead(code, { 'content-type': type, 'cache-control': 'no-store' });
  res.end(body);
}
const sendJson = (res, code, obj) => send(res, code, JSON.stringify(obj, (_, v) => (typeof v === 'bigint' ? v.toString() : v)), 'application/json');

async function body(req) {
  let s = '';
  for await (const c of req) { s += c; if (s.length > 1e5) throw new Error('body too large'); }
  return s ? JSON.parse(s) : {};
}
const bearer = (req) => auth.check((req.headers.authorization || '').replace(/^Bearer\s+/i, ''));

export function cleanName(n, wallet) {
  const s = String(n || '').replace(/[^A-Za-z0-9 _.\-]/g, '').trim().slice(0, 16);
  return s.length >= 2 ? s : 'Crew ' + (wallet ? wallet.slice(2, 6).toUpperCase() : Math.floor(Math.random() * 9000 + 1000));
}

function publicConfig() {
  return {
    chainId: cfg.chainId, chainName: cfg.chain.name, rpcUrl: cfg.rpcUrl, explorer: cfg.explorer, privyAppId: cfg.privyAppId,
    stakes: cfg.stakes.map((s, i) => ({ i, label: s.label, wei: s.wei.toString(), winner: formatEth((s.wei * 90n) / 100n) })),
    seats: cfg.seatOptions, cashEnabled: cfg.cashEnabled && chain.ready, escrow: chain.escrow?.address || null,
    mainnet: !!cfg.chain.mainnet, arenas: ARENAS.map((a) => ({ id: a.id, name: a.name, blurb: a.blurb, hazard: a.hazard })),
  };
}

async function statusData() {
  let dbOk = false;
  try { dbOk = await db.ping(); } catch {}
  const c = chain;
  return {
    ok: cfg.problems.length === 0 && c.ready && dbOk && (cfg.chain.mainnet ? db.kind === 'postgres' : true),
    chainId: cfg.chainId, chain: cfg.chain.name, rpc: cfg.rpcUrl, rpcChainId: c.rpcChainId,
    problems: cfg.problems, stage: c.state.stage, note: c.state.note,
    operator: c.operator || null, gasBalance: c.balance != null ? formatEth(c.balance) : null,
    escrow: c.escrow?.address || null, roles: c.roles || null, lastBlock: c.lastBlock, headBlock: c.headBlock || null, watchError: c.watchErr || null,
    cosigners: c.cosigners.map((x, i) => ({ role: x?.role, ready: !!x?.ready, address: x?.address || c.cosignerAddrs[i] })),
    db: { kind: db.kind, ok: dbOk }, privyAppId: cfg.privyAppId ? 'set' : 'missing', owner: cfg.owner,
    cashEnabled: cfg.cashEnabled && c.ready, rooms: { practice: practice.size, cash: [...cash.lobbies.values()].filter((m) => m.room).length },
    explorer: cfg.explorer,
  };
}

function statusHtml(s) {
  const row = (ok, label, detail) => `<tr><td class="${ok ? 'g' : 'r'}">${ok ? 'OK' : '!!'}</td><td>${label}</td><td>${detail || ''}</td></tr>`;
  const link = (a) => (a && s.explorer ? `<a href="${s.explorer}/address/${a}">${a}</a>` : a || '');
  const esc = (t) => String(t ?? '').replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c]);
  return `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>DECKHAND status</title>
<meta http-equiv="refresh" content="10">
<style>body{background:#11181a;color:#d7d0b5;font:14px/1.5 ui-monospace,Menlo,monospace;padding:16px;max-width:980px;margin:auto}
h1{color:#e49b3c;font-size:20px;letter-spacing:.2em}td{padding:6px 10px;border-bottom:1px solid #27383c;vertical-align:top;word-break:break-all}
.g{color:#91cba0}.r{color:#d34e3f;font-weight:bold}a{color:#91cba0}</style>
<h1>DECKHAND // STATUS</h1><p>${s.ok ? '<b class="g">ALL GREEN. Cash play is live.</b>' : '<b class="r">Not ready for cash play yet. Fix the red rows.</b>'} (refreshes every 10 s)</p><table>
${row(s.problems.length === 0, 'Configuration', s.problems.length ? s.problems.map(esc).join('<br>') : 'all settings present')}
${row(s.rpcChainId === s.chainId, 'RPC', `${esc(s.rpc)} → chain ${s.rpcChainId ?? '?'} (want ${s.chainId}, ${esc(s.chain)})`)}
${row(!!s.operator && s.stage !== 'needs-gas', 'Gas wallet (server operator)', `${link(s.operator)}<br>balance ${s.gasBalance ?? '?'} ETH`)}
${row(s.stage === 'ready', 'Escrow contract', `${link(s.escrow) || 'not deployed'}<br>${esc(s.stage)} ${esc(s.note)}`)}
${row(!!s.roles && s.roles.isOperator, 'Escrow roles', s.roles ? `operator ${s.roles.isOperator}, co-signers ${s.roles.cosigners.join('/')}, threshold ${s.roles.threshold}<br>treasury ${link(s.roles.treasury)}<br>admin ${link(s.roles.admin)}${s.roles.pendingAdmin !== '0x0000000000000000000000000000000000000000' ? `<br>pending admin ${link(s.roles.pendingAdmin)} (accept after 2 days)` : ''}${s.roles.paused ? '<br><b class="r">PAUSED</b>' : ''}` : '')}
${row(s.cosigners.length === 2 && s.cosigners.every((c) => c.ready), 'Co-signers', s.cosigners.map((c) => `${c.role}: ${c.ready ? 'ready' : 'down'} ${c.address || ''}`).join('<br>'))}
${row(s.db.ok && (s.db.kind === 'postgres' || s.chainId !== 4663), 'Database', s.db.kind + (s.db.kind === 'memory' ? ' (testing only: data is lost on restart)' : ''))}
${row(s.privyAppId === 'set', 'Privy app ID', s.privyAppId)}
${row(!s.watchError, 'Chain watcher', `block ${s.lastBlock}${s.headBlock ? ' / head ' + s.headBlock : ''} ${esc(s.watchError || '')}`)}
${row(true, 'Live rooms', `practice ${s.rooms.practice}, cash ${s.rooms.cash}`)}
</table>`;
}

const RPC_ALLOW = new Set(['eth_chainId', 'eth_blockNumber', 'eth_getBalance', 'eth_getTransactionReceipt', 'eth_gasPrice', 'eth_maxPriorityFeePerGas', 'eth_estimateGas', 'eth_getTransactionCount', 'eth_getTransactionByHash']);
const rpcHits = new Map();
function rpcBudget(req) {
  const ip = String(req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();
  const now = Date.now();
  const h = rpcHits.get(ip) || { n: 0, t: now };
  if (now - h.t > 10000) { h.n = 0; h.t = now; }
  h.n++;
  rpcHits.set(ip, h);
  if (rpcHits.size > 5000) rpcHits.clear();
  return h.n <= 60;
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  try {
    if (url.pathname === '/healthz') return send(res, 200, 'ok');
    if (url.pathname === '/status') return send(res, 200, statusHtml(await statusData()), 'text/html; charset=utf-8');
    if (url.pathname === '/api/status') return sendJson(res, 200, await statusData());
    if (url.pathname === '/api/config') return sendJson(res, 200, publicConfig());
    if (url.pathname === '/api/auth/challenge') {
      const w = url.searchParams.get('wallet');
      if (!isAddress(w)) return sendJson(res, 400, { error: 'bad wallet' });
      return sendJson(res, 200, auth.challenge(w, req.headers.host));
    }
    if (url.pathname === '/api/auth/verify' && req.method === 'POST') {
      const b = await body(req);
      try { return sendJson(res, 200, await auth.verify(b)); } catch (e) { return sendJson(res, 401, { error: e.message }); }
    }
    if (url.pathname === '/api/rpc' && req.method === 'POST') {
      const b = await body(req);
      if (!RPC_ALLOW.has(b.method) || !Array.isArray(b.params || [])) return sendJson(res, 400, { error: 'method not allowed' });
      if (!rpcBudget(req)) return sendJson(res, 429, { error: 'slow down' });
      try { return sendJson(res, 200, { result: await chain.rpc.call(b.method, b.params || [], { retries: 1 }) }); } catch (e) { return sendJson(res, 502, { error: e.message }); }
    }
    if (url.pathname.startsWith('/api/consent/')) {
      const w = url.pathname.split('/').pop();
      if (!isAddress(w)) return sendJson(res, 400, { error: 'bad wallet' });
      const rec = await db.getConsent(w);
      return sendJson(res, rec ? 200 : 404, rec || { error: 'no consent on record' });
    }
    if (url.pathname === '/api/recent') {
      const rows = await db.recentMatches(15);
      return sendJson(res, 200, rows.map((m) => ({ id: m.id, status: m.status, stake: m.stakeLabel, seats: m.seats, arena: m.arena, winner: m.payout?.winner || m.result?.winner || null, names: m.seatList.map((s) => s.name), settleTx: m.settleTx, payout: m.payout || null })));
    }
    if (url.pathname.startsWith('/api/match/')) {
      const [, , , id, extra] = url.pathname.split('/');
      const m = cash.lobbies.get(id) || (await db.getMatch(id));
      if (!m) return sendJson(res, 404, { error: 'unknown match' });
      if (extra === 'evidence') {
        if (!['settled', 'refunded', 'failed'].includes(m.status)) return sendJson(res, 403, { error: 'evidence is published after settlement' });
        return sendJson(res, 200, await db.getEvidence(id));
      }
      return sendJson(res, 200, cash.view(m));
    }
    if (url.pathname.startsWith('/api/')) {
      const wallet = bearer(req);
      if (!wallet) return sendJson(res, 401, { error: 'sign in first' });
      if (url.pathname === '/api/me') return sendJson(res, 200, { wallet, lobby: cash.lobbyOf(wallet), consent: !!(await db.getConsent(wallet)) });
      if (url.pathname === '/api/queue' && req.method === 'POST') {
        const b = await body(req);
        if (!(await db.getConsent(wallet))) return sendJson(res, 403, { error: 'sign the 21+ consent first' });
        try { return sendJson(res, 200, await cash.queue(wallet, cleanName(b.name, wallet), Number(b.stake), Number(b.seats))); } catch (e) { return sendJson(res, 400, { error: e.message }); }
      }
      if (url.pathname === '/api/deposit' && req.method === 'GET') {
        const r = cash.lobbyOf(wallet);
        if (!r) return sendJson(res, 404, { error: 'not in a lobby' });
        const m = cash.lobbies.get(r.id);
        const seat = m.seatList.find((s) => s.wallet.toLowerCase() === wallet.toLowerCase());
        return sendJson(res, 200, cash.permitFor(m, wallet, seat));
      }
      if (url.pathname === '/api/leave' && req.method === 'POST') {
        try { return sendJson(res, 200, await cash.leave(wallet)); } catch (e) { return sendJson(res, 400, { error: e.message }); }
      }
      return sendJson(res, 404, { error: 'unknown endpoint' });
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, 'method not allowed');
    return serveStatic(req, res, url);
  } catch (e) {
    log('http error', req.url, e);
    return sendJson(res, 500, { error: 'server error' });
  }
});

// ================================================================ WebSocket
const wss = new WebSocketServer({ noServer: true, maxPayload: 16 * 1024 });
server.on('upgrade', (req, socket, head) => {
  if (new URL(req.url, 'http://x').pathname !== '/ws') return socket.destroy();
  wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
});

function attachRoom(ws, room, slot) {
  if (ws.room && ws.room !== room) detachRoom(ws);
  ws.room = room;
  room.attach(ws, slot);
}
function detachRoom(ws) {
  const r = ws.room;
  if (!r) return;
  r.detach(ws);
  ws.room = null;
  if (r.mode === 'practice' && r.conns.size === 0) { r.stop(); practice.delete(r.id); }
}

wss.on('connection', (ws) => {
  ws.wallet = null;
  ws.room = null;
  ws.alive = true;
  ws.on('pong', () => (ws.alive = true));
  ws.on('message', (raw) => {
    let m;
    try { m = JSON.parse(raw); } catch { return; }
    if (!m || typeof m.t !== 'string') return;
    if (m.t === 'in') { if (ws.room) ws.room.input(ws, m.a); return; }
    if (m.t === 'ping') return ws.send(JSON.stringify({ t: 'pong', at: m.at }));
    if (m.t === 'hello') {
      const w = m.token ? auth.check(m.token) : null;
      if (w) {
        ws.wallet = w;
        const k = w.toLowerCase();
        if (!sockets.has(k)) sockets.set(k, new Set());
        sockets.get(k).add(ws);
      }
      ws.send(JSON.stringify({ t: 'hello', wallet: ws.wallet, lobby: ws.wallet ? cash.lobbyOf(ws.wallet) : null }));
      if (ws.wallet) {
        const r = cash.roomOf(ws.wallet);
        if (r) attachRoom(ws, r.room, r.slot);
      }
      return;
    }
    if (m.t === 'practice') {
      if (practice.size >= 300) return ws.send(JSON.stringify({ t: 'error', error: 'Practice yard is full. Try again in a minute.' }));
      const arena = ARENA_IDS.includes(m.arena) ? m.arena : ARENA_IDS[Math.floor(Math.random() * ARENA_IDS.length)];
      const nBots = Math.max(1, Math.min(3, Number(m.bots) || 1));
      const skill = m.diff === 'hard' ? 0.82 : m.diff === 'frozen' ? 0 : 0.55;
      const style = m.diff === 'frozen' ? 'idle' : 'normal';
      const id = 'p-' + randomBytes(6).toString('hex');
      const BOT_NAMES = ['Forklift Gary', 'Nightshift Ana', 'Union Rep Dee', 'Temp #4411', 'Old Man Voss', 'Weld-O'];
      const seats = [{ name: cleanName(m.name, ws.wallet) }];
      const names = BOT_NAMES.slice().sort(() => Math.random() - 0.5);
      for (let i = 0; i < nBots; i++) seats.push({ name: names[i], bot: { skill, style, seed: Math.floor(Math.random() * 1e9) } });
      const room = new Room({
        id, mode: 'practice', log, seats, tickMs: TICK_MS,
        simCfg: { seed: randomBytes(16).toString('hex'), arena, players: seats.map((s) => ({ name: s.name })) },
        onEnd: (r) => setTimeout(() => { if (practice.get(r.id) === r) { practice.delete(r.id); } }, 120000),
      });
      practice.set(id, room);
      room.start();
      attachRoom(ws, room, 0);
      return;
    }
    if (m.t === 'leaveRoom') return detachRoom(ws);
  });
  ws.on('close', () => {
    detachRoom(ws);
    if (ws.wallet) sockets.get(ws.wallet.toLowerCase())?.delete(ws);
  });
});
setInterval(() => {
  for (const ws of wss.clients) {
    if (!ws.alive) { ws.terminate(); continue; }
    ws.alive = false;
    try { ws.ping(); } catch {}
  }
}, 20000);

// ===================================================================== boot
await chain.start();
await cash.init();
server.listen(cfg.port, () => log(`DECKHAND listening on :${cfg.port} (chain ${cfg.chainId}, db ${db.kind}${cfg.problems.length ? ', problems: ' + cfg.problems.join('; ') : ''})`));
const shutdown = () => { log('shutting down'); chain.stop(); server.close(); setTimeout(() => process.exit(0), 500); };
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
export { checksum };
