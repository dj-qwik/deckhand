// App shell: screens, settings, sign-in, wallet, queue/lobby, practice, results.
import { Match } from './match.js';
import { pad, BTN } from './gamepad.js';
import { Audio } from './audio.js';
import { PERSONAS } from './crew.js';
import { PCOL } from './render.js';
import { ARENAS } from '/sim/arenas.js';
import { W } from '/sim/rules.js';

const $ = (s) => document.querySelector(s);
const esc = (t) => String(t ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
const short = (a) => (a ? `${a.slice(0, 6)}…${a.slice(-4)}` : '');
const fmtEth = (wei, d = 6) => {
  wei = BigInt(wei || 0);
  const w = wei / 10n ** 18n, f = (wei % 10n ** 18n).toString().padStart(18, '0').slice(0, d).replace(/0+$/, '');
  return w.toString() + (f ? '.' + f : '');
};
const parseEth = (s) => {
  const [w, f = ''] = String(s).trim().split('.');
  if (!/^\d*$/.test(w) || !/^\d*$/.test(f) || f.length > 18 || (!w && !f)) throw new Error('Enter an amount like 0.01');
  return BigInt(w || '0') * 10n ** 18n + BigInt((f + '0'.repeat(18)).slice(0, 18));
};

// ================================================================ settings
const DEFAULTS = { volume: 70, music: true, profanityFilter: false, shake: 'full', scanlines: true, uiScale: 100, persona: 'rook', name: '' };
const settings = Object.assign({}, DEFAULTS, safeJson(localStorage.getItem('dh.settings')));
function safeJson(s) { try { return JSON.parse(s) || {}; } catch { return {}; } }
function saveSettings() {
  if (window.__dhMatch) window.__dhMatch.r.resize();
  try { localStorage.setItem('dh.settings', JSON.stringify(settings)); } catch {}
  document.body.classList.toggle('no-scan', !settings.scanlines);
  document.documentElement.style.setProperty('--scale', String(settings.uiScale / 100));
  audio.apply();
}
const audio = new Audio(settings);
saveSettings();

// ================================================================== state
const app = {
  config: null,
  token: null,
  wallet: null,
  ws: null,
  wsReady: false,
  match: null,
  lobby: null,
  stake: 0,
  seats: 2,
  mode: null, // 'practice' | 'cash'
  practiceOpts: null,
  queueRetry: null,
};
try { app.token = localStorage.getItem('dh.token'); } catch {}

function show(id) {
  document.querySelectorAll('.screen').forEach((s) => s.classList.toggle('on', s.id === 'scr-' + id));
}
function toast(t) {
  const d = document.createElement('div');
  d.textContent = t;
  $('#toast').appendChild(d);
  setTimeout(() => d.remove(), 3800);
}
window.addEventListener('dh-toast', (e) => toast(e.detail));
function modal(html) {
  $('#modal-body').innerHTML = html;
  $('#modal').classList.remove('hidden');
}
function closeModal() { $('#modal').classList.add('hidden'); }
$('#modal').addEventListener('click', (e) => { if (e.target.id === 'modal' || e.target.dataset.close !== undefined) closeModal(); });

async function api(path, opts = {}) {
  const res = await fetch(path, {
    method: opts.method || 'GET',
    headers: { 'content-type': 'application/json', ...(app.token ? { authorization: 'Bearer ' + app.token } : {}) },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  const j = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(j.error || `Request failed (${res.status})`), { status: res.status });
  return j;
}

// ================================================================= landing
function boot() {
  const lines = ['DECKHAND TERMINAL v1.0', 'ASSET RETENTION COMBAT TRAINING', 'checking reactor seals ....... ok', 'counting overtime ............ none', 'ready.'];
  let i = 0;
  const el = $('#boot');
  const tick = () => { if (i < lines.length) { el.textContent += lines[i++] + '\n'; setTimeout(tick, 260); } };
  tick();
}

async function loadConfig() {
  try {
    app.config = await api('/api/config');
    document.querySelectorAll('[data-chain-name]').forEach((el) => (el.textContent = app.config.chainName));
    $('#landing-fine').textContent = app.config.cashEnabled
      ? `Cash matches settle on ${app.config.chainName}. Practice is free and needs no sign-in.`
      : 'Cash matches are not switched on yet. The practice yard is open.';
  } catch {
    $('#landing-fine').textContent = 'Server unreachable. Retrying…';
    setTimeout(loadConfig, 3000);
  }
}

// ===================================================================== ws
function connect() {
  const ws = new WebSocket((location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + '/ws');
  app.ws = ws;
  ws.onopen = () => {
    app.wsReady = true;
    ws.send(JSON.stringify({ t: 'hello', token: app.token }));
    if (app.mode === 'practice' && app.match && !app.match.ended) toast('Reconnected. Practice rooms do not survive a disconnect.');
  };
  ws.onclose = () => {
    app.wsReady = false;
    setTimeout(connect, 1500);
  };
  ws.onmessage = (ev) => {
    let m;
    try { m = JSON.parse(ev.data); } catch { return; }
    onWs(m);
  };
}
const wsSend = (m) => { if (app.ws && app.wsReady) app.ws.send(JSON.stringify(m)); };

function onWs(m) {
  if (m.t === 'start') return startMatch(m);
  if (m.t === 'snap') return app.match && app.match.onSnap(m.snap);
  if (m.t === 'nope') { if (m.why && !/aim/.test(m.a)) { audio.play('nope'); toast(m.why); } return; }
  if (m.t === 'lobby') return onLobby(m.lobby);
  if (m.t === 'hello') { if (m.lobby) onLobby(m.lobby); return; }
  if (m.t === 'void') { toast(`Match voided: ${m.reason}. Everyone is refunded.`); return; }
  if (m.t === 'error') return toast(m.error);
}

// ================================================================ wallet
function wallet() { return window.DHWallet || null; }
function waitWallet(ms = 12000) {
  return new Promise((resolve, reject) => {
    if (window.DHWalletMissing) return reject(new Error('The wallet module did not load. Refresh the page.'));
    const w = wallet();
    if (w && w.ready) return resolve(w);
    const t0 = Date.now();
    const iv = setInterval(() => {
      const w2 = wallet();
      if (w2 && w2.ready) { clearInterval(iv); resolve(w2); }
      else if (window.DHWalletMissing || Date.now() - t0 > ms) { clearInterval(iv); reject(new Error(w2?.error || 'Wallet is still loading. Try again in a moment.')); }
    }, 150);
  });
}

async function signIn() {
  audio.unlock();
  if (!app.config?.privyAppId) return toast('Sign-in is not configured on this server yet.');
  let w;
  try { w = await waitWallet(); } catch (e) { return toast(e.message); }
  try {
    if (!w.authenticated || !w.address) await w.login();
  } catch (e) { return toast(e.message || 'Sign-in cancelled'); }
  if (!w.address) return toast('No game wallet yet. Try again.');
  app.wallet = w.address;
  // reuse a valid session for this wallet
  if (app.token) {
    try {
      const me = await api('/api/me');
      if (me.wallet.toLowerCase() === app.wallet.toLowerCase() && me.consent) return enterHangar(me);
    } catch {}
  }
  show('consent');
}

async function consentAndSign() {
  const btn = $('#btn-consent');
  btn.disabled = true;
  $('#consent-err').textContent = '';
  try {
    const w = await waitWallet();
    const ch = await api('/api/auth/challenge?wallet=' + w.address);
    const signature = await w.signMessage(ch.message);
    const r = await api('/api/auth/verify', { method: 'POST', body: { wallet: w.address, nonce: ch.nonce, signature } });
    app.token = r.token;
    try { localStorage.setItem('dh.token', r.token); } catch {}
    wsSend({ t: 'hello', token: app.token });
    const me = await api('/api/me');
    enterHangar(me);
  } catch (e) {
    $('#consent-err').textContent = errText(e);
  } finally {
    btn.disabled = !($('#c-age').checked && $('#c-ent').checked);
  }
}

function errText(e) {
  let s = e?.message || String(e);
  let c = e?.cause;
  for (let i = 0; c && i < 3; i++) { if (c.message && !s.includes(c.message)) s += ` (${c.message})`; c = c.cause; }
  if (e?.details && !s.includes(e.details)) s += ` (${e.details})`;
  return s;
}

// ================================================================ hangar
async function enterHangar(me) {
  app.wallet = me.wallet;
  show('hangar');
  $('#w-addr').textContent = me.wallet;
  $('#q-name').value = settings.name || '';
  renderStakes();
  refreshBalance();
  refreshRecent();
  if (me.lobby && ['creating', 'open', 'locked', 'playing', 'settling', 'refunding'].includes(me.lobby.status)) onLobby(me.lobby);
}

function renderStakes() {
  const c = app.config;
  $('#q-stake').innerHTML = c.stakes.map((s) => `<button aria-pressed="${s.i === app.stake}" data-i="${s.i}">${s.label} ETH</button>`).join('');
  $('#q-seats').innerHTML = c.seats.map((n) => `<button aria-pressed="${n === app.seats}" data-n="${n}">${n} crews</button>`).join('');
  const s = c.stakes[app.stake];
  const pot = BigInt(s.wei) * BigInt(app.seats);
  $('#q-pot').textContent = `Winner takes ${fmtEth((pot * 90n) / 100n)} ETH`;
  $('#btn-queue').disabled = !c.cashEnabled;
  if (!c.cashEnabled) $('#q-err').textContent = 'Cash matches are not live on this server yet.';
}
$('#q-stake').addEventListener('click', (e) => { const b = e.target.closest('button'); if (!b) return; app.stake = Number(b.dataset.i); renderStakes(); });
$('#q-seats').addEventListener('click', (e) => { const b = e.target.closest('button'); if (!b) return; app.seats = Number(b.dataset.n); renderStakes(); });

async function refreshBalance() {
  const w = wallet();
  if (!w || !w.address) return;
  try { const b = await w.getBalance(); $('#w-bal').textContent = fmtEth(b, 6); app.balance = BigInt(b); } catch { $('#w-bal').textContent = '?'; }
}
setInterval(() => { if ($('#scr-hangar').classList.contains('on') || $('#scr-lobby').classList.contains('on')) refreshBalance(); }, 10000);

async function refreshRecent() {
  try {
    const rows = await api('/api/recent');
    $('#recent').innerHTML = rows.length ? rows.map((r) => {
      const won = r.payout ? `<b>${fmtEth(r.payout.winnerWei)} ETH</b>` : esc(r.status);
      const link = r.settleTx && app.config.explorer ? ` <a href="${app.config.explorer}/tx/${r.settleTx}" target="_blank" rel="noopener">tx</a>` : '';
      return `<li>${won} · ${esc(r.names.join(' vs '))} · ${esc(arenaName(r.arena))}${link}</li>`;
    }).join('') : '<li>No paid matches yet. Be the first.</li>';
  } catch {}
}
const arenaName = (id) => ARENAS.find((a) => a.id === id)?.name || id;

$('#btn-copy').addEventListener('click', async () => {
  try { await navigator.clipboard.writeText(app.wallet); toast('Address copied'); } catch { toast(app.wallet); }
});
$('#btn-cashout').addEventListener('click', () => $('#cashout').classList.toggle('hidden'));
$('#co-cancel').addEventListener('click', () => $('#cashout').classList.add('hidden'));
$('#co-max').addEventListener('click', async () => {
  try { const m = await wallet().maxSendable(); $('#co-amt').value = fmtEth(m, 18); } catch (e) { $('#co-err').textContent = errText(e); }
});
$('#co-send').addEventListener('click', async () => {
  $('#co-err').textContent = '';
  const to = $('#co-to').value.trim();
  if (!/^0x[0-9a-fA-F]{40}$/.test(to)) return ($('#co-err').textContent = 'Enter a valid 0x address.');
  let value;
  try { value = parseEth($('#co-amt').value); } catch (e) { return ($('#co-err').textContent = e.message); }
  if (value <= 0n) return ($('#co-err').textContent = 'Enter an amount above zero.');
  const ok = await confirmBox(`Send <b>${fmtEth(value, 18)} ETH</b> to <code>${esc(to)}</code> on ${esc(app.config.chainName)}? This cannot be undone.`, 'Send ETH');
  if (!ok) return;
  try {
    const hash = await wallet().send({ to, value: '0x' + value.toString(16) });
    toast('Sent. Waiting for confirmation…');
    await wallet().waitForReceipt(hash);
    toast('Cash-out confirmed');
    $('#cashout').classList.add('hidden');
    refreshBalance();
  } catch (e) { $('#co-err').textContent = errText(e); }
});
$('#btn-export').addEventListener('click', async () => {
  const ok = await confirmBox('Exporting shows your private key. Anyone with it controls your game wallet. Only do this on a private screen.', 'Show export');
  if (ok) try { await wallet().exportKey(); } catch (e) { toast(errText(e)); }
});
$('#btn-signout').addEventListener('click', async () => {
  try { await wallet()?.logout(); } catch {}
  app.token = null; app.wallet = null;
  try { localStorage.removeItem('dh.token'); } catch {}
  show('landing');
});

function confirmBox(html, yes) {
  return new Promise((resolve) => {
    modal(`<p>${html}</p><div class="row"><button class="btn" id="cf-yes">${esc(yes)}</button><button class="btn ghost" id="cf-no">Cancel</button></div>`);
    $('#cf-yes').onclick = () => { closeModal(); resolve(true); };
    $('#cf-no').onclick = () => { closeModal(); resolve(false); };
  });
}

// ================================================================= queue
$('#btn-queue').addEventListener('click', async () => {
  audio.unlock();
  $('#q-err').textContent = '';
  const name = $('#q-name').value.trim();
  settings.name = name;
  saveSettings();
  const s = app.config.stakes[app.stake];
  if (app.balance !== undefined && app.balance < BigInt(s.wei)) return ($('#q-err').textContent = `You need at least ${s.label} ETH plus a little gas. Add ETH to your game wallet first.`);
  try {
    const r = await api('/api/queue', { method: 'POST', body: { stake: app.stake, seats: app.seats, name } });
    app.deposit = r.deposit;
    onLobby(r.lobby);
  } catch (e) { $('#q-err').textContent = errText(e); }
});

function onLobby(l) {
  app.lobby = l;
  if (['settled', 'refunded', 'failed'].includes(l.status)) {
    if ($('#scr-results').classList.contains('on')) renderPayout(l);
    else if ($('#scr-lobby').classList.contains('on')) {
      $('#l-status').textContent = l.status === 'refunded' ? `Lobby closed: ${l.reason || 'refunded'}. Your entry was returned.` : l.status;
      $('#btn-pay').disabled = true;
      $('#btn-leave').textContent = 'Back to hangar';
    } else if (app.match && app.match.ended) renderPayout(l);
    return;
  }
  if (l.status === 'playing' || l.status === 'settling') { if (app.match && app.match.ended) renderPayout(l); return; }
  if (!$('#scr-lobby').classList.contains('on') && !(app.match && app.match.running)) show('lobby');
  $('#l-title').textContent = `${l.stake} ETH · ${l.seats} crews`;
  const arena = ARENAS.find((a) => a.id === l.arena);
  $('#l-arena').textContent = arena ? `Arena: ${arena.name}. ${arena.blurb}` : '';
  const rows = [];
  for (let i = 0; i < l.seats; i++) {
    const s = l.seatList[i];
    rows.push(s ? `<li class="${s.funded ? 'funded' : ''} ${s.you ? 'you' : ''}"><b>${esc(s.name)}</b> <small>${short(s.wallet)}</small><span class="st">${s.funded ? 'Paid' : 'Paying…'}</span></li>` : '<li><span class="hint">Waiting for a crew…</span><span class="st">open</span></li>');
  }
  $('#l-seats').innerHTML = rows.join('');
  $('#l-pot').textContent = `Pot ${fmtEth(l.potWei)} ETH · winner gets ${l.winnerShare} ETH when full`;
  const mine = l.seatList.find((s) => s.you);
  const left = Math.max(0, l.deadline - Math.floor(Date.now() / 1000));
  const statusText = {
    creating: 'Opening the lobby on-chain…',
    open: mine?.funded ? `Paid. Waiting for the other crews. Lobby refunds in ${Math.floor(left / 60)}:${String(left % 60).padStart(2, '0')} if it doesn't fill.` : 'Pay your entry to lock your seat.',
    locked: 'All crews paid. Match starting…',
  }[l.status] || l.status;
  $('#l-status').textContent = statusText;
  $('#btn-pay').disabled = !(l.status === 'open' && mine && !mine.funded) || app.paying;
  $('#btn-pay').textContent = mine?.funded ? 'Paid' : `Pay ${l.stake} ETH`;
  $('#btn-leave').textContent = mine?.funded ? 'Leave and refund lobby' : 'Leave lobby';
  $('#btn-leave').disabled = l.status === 'locked';
  $('#l-err').textContent = l.error || '';
}
setInterval(() => { if ($('#scr-lobby').classList.contains('on') && app.lobby) onLobby(app.lobby); }, 1000);

$('#btn-pay').addEventListener('click', async () => {
  const l = app.lobby;
  if (!l) return;
  $('#l-err').textContent = '';
  const ok = await confirmBox(`Pay <b>${esc(l.stake)} ETH</b> entry into the DECKHAND escrow contract <code>${esc(short(l.escrow))}</code>? Winner takes 90% of the pot. Unfilled lobbies refund in full.`, `Pay ${l.stake} ETH`);
  if (!ok) return;
  app.paying = true;
  $('#btn-pay').disabled = true;
  try {
    const d = (await api('/api/deposit')).deposit;
    if (!d) throw new Error('Seat already paid or expired. Leave and find a new match.');
    $('#l-status').textContent = 'Sending your entry…';
    const hash = await wallet().send({ to: d.escrow, data: d.data, value: '0x' + BigInt(d.valueWei).toString(16) });
    $('#l-status').textContent = 'Entry sent. Waiting for the chain to confirm…';
    await wallet().waitForReceipt(hash);
    refreshBalance();
  } catch (e) {
    $('#l-err').textContent = errText(e);
  } finally {
    app.paying = false;
    if (app.lobby) onLobby(app.lobby);
  }
});
$('#btn-leave').addEventListener('click', async () => {
  const l = app.lobby;
  if (!l || ['refunded', 'settled', 'failed'].includes(l.status)) { app.lobby = null; return show('hangar'); }
  const mine = l.seatList.find((s) => s.you);
  if (mine?.funded) {
    const ok = await confirmBox('You already paid. Leaving now cancels the whole lobby and refunds every crew in full. Continue?', 'Leave and refund');
    if (!ok) return;
  }
  try { await api('/api/leave', { method: 'POST' }); app.lobby = null; show('hangar'); refreshBalance(); } catch (e) { $('#l-err').textContent = errText(e); }
});

// ================================================================ matches
function startMatch(m) {
  if (app.match) app.match.stop();
  app.mode = m.room.mode;
  show('match');
  $('#m-overlay').classList.add('hidden');
  app.match = new Match({
    send: (a) => wsSend({ t: 'in', a }),
    settings, audio,
    tutorial: app.mode === 'practice' && app.practiceOpts?.tutorial ? new Tutorial() : null,
    onEnd: (snap, room) => showResults(snap, room),
  });
  window.__dhMatch = app.match;
  app.match.start(m);
  audio.unlock();
}

function showResults(snap, room) {
  if (app.match) app.match.stop();
  show('results');
  const me = room.you;
  const r = snap.result;
  const win = r && r.winner === me;
  $('#r-title').textContent = win ? 'Last base standing. Paycheck secured.' : r ? `${snap.players[r.winner].name} takes it` : 'Shift over';
  $('#r-sub').textContent = room.mode === 'cash' ? 'Settling on-chain. Payouts are confirmed below.' : 'Practice round. No ETH changed hands.';
  $('#r-table').innerHTML = `<tr><th>#</th><th>Crew</th><th>Base left</th><th>Reactor</th><th>Reactor dmg dealt</th></tr>` + (r ? r.rank : []).map((x, i) => {
    const p = snap.players[x.slot];
    return `<tr class="${i === 0 ? 'win' : ''}"><td>${i + 1}</td><td><span style="color:${PCOL[x.slot]}">■</span> ${esc(p.name)}${x.slot === me ? ' (you)' : ''}</td><td>${x.alive ? x.base.toLocaleString() : 'OUT'}</td><td>${x.hp}</td><td>${x.dr}</td></tr>`;
  }).join('');
  $('#r-pay').innerHTML = '';
  if (room.mode === 'cash' && app.lobby) renderPayout(app.lobby);
  $('#btn-again').textContent = room.mode === 'cash' ? 'Queue again' : 'Practice again';
}

function renderPayout(l) {
  const ex = app.config?.explorer;
  const tx = (h) => (h && ex ? `<a href="${ex}/tx/${h}" target="_blank" rel="noopener">${short(h)}</a>` : h ? short(h) : '');
  let html = '';
  if (l.status === 'settled' && l.payout) {
    html = `<p>Paid out: <b>${fmtEth(l.payout.winnerWei)} ETH</b> to ${short(l.payout.winner)} (90%), house ${fmtEth(l.payout.houseWei)} ETH (10%). Transaction ${tx(l.settleTx)} confirmed.</p>`;
  } else if (l.status === 'settling') {
    html = `<p>Two independent co-signers are replaying the match before payout…${l.settleTx ? ` Transaction ${tx(l.settleTx)} sent, waiting for confirmation.` : ''}</p>${l.error ? `<p class="err">${esc(l.error)}</p>` : ''}`;
  } else if (l.status === 'refunded') html = `<p>This match was voided (${esc(l.reason || 'refund')}). Every entry was refunded in full ${tx(l.refundTx)}.</p>`;
  else if (l.status === 'failed') html = `<p class="err">Settlement needs attention: ${esc(l.error || '')}</p>`;
  $('#r-pay').innerHTML = html;
  refreshBalance();
}

$('#btn-again').addEventListener('click', () => {
  if (app.mode === 'cash') { show('hangar'); $('#btn-queue').click(); }
  else startPractice(app.practiceOpts);
});
$('#btn-home').addEventListener('click', () => { if (app.token && app.wallet) { show('hangar'); refreshRecent(); refreshBalance(); } else show('landing'); });

// =============================================================== practice
function practiceMenu() {
  audio.unlock();
  const o = app.practiceOpts || { arena: '', bots: 1, diff: 'easy', tutorial: !safeJson(localStorage.getItem('dh.seen')).tutorial };
  modal(`<h2>Practice yard</h2><p class="hint">Free and unranked. Nobody pays, nobody gets paid.</p>
  <div class="field"><span>Arena</span><div class="seg" id="p-arena"><button data-v="" aria-pressed="${!o.arena}">Random</button>${ARENAS.map((a) => `<button data-v="${a.id}" aria-pressed="${o.arena === a.id}" title="${esc(a.blurb)}">${esc(a.name.replace('The ', ''))}</button>`).join('')}</div></div>
  <div class="field"><span>Opponents</span><div class="seg" id="p-bots">${[1, 2, 3].map((n) => `<button data-v="${n}" aria-pressed="${o.bots === n}">${n}</button>`).join('')}</div></div>
  <div class="field"><span>Bot crews</span><div class="seg" id="p-diff">${[['frozen', 'Asleep'], ['easy', 'Easy'], ['hard', 'Hard']].map(([v, l]) => `<button data-v="${v}" aria-pressed="${o.diff === v}">${l}</button>`).join('')}</div></div>
  <label class="check"><input type="checkbox" id="p-tut" ${o.tutorial ? 'checked' : ''}> Walk me through it (tutorial)</label>
  <div class="row"><button class="btn big" id="p-go">Clock in</button><button class="btn ghost" data-close>Cancel</button></div>`);
  const seg = (id, key, num) => $(id).addEventListener('click', (e) => {
    const b = e.target.closest('button'); if (!b) return;
    o[key] = num ? Number(b.dataset.v) : b.dataset.v;
    $(id).querySelectorAll('button').forEach((x) => x.setAttribute('aria-pressed', String(x === b)));
  });
  seg('#p-arena', 'arena'); seg('#p-bots', 'bots', true); seg('#p-diff', 'diff');
  $('#p-go').onclick = () => { o.tutorial = $('#p-tut').checked; if (o.tutorial) { o.diff = 'frozen'; o.bots = 1; } closeModal(); startPractice(o); };
}
function startPractice(o) {
  app.practiceOpts = o;
  app.mode = 'practice';
  wsSend({ t: 'practice', arena: o.arena, bots: o.bots, diff: o.diff, name: settings.name || 'Foreman' });
}

// =============================================================== tutorial
class Tutorial {
  constructor() {
    this.step = 0;
    this.text = '';
    this.wallsDown = 0;
    this.steps = [
      { text: 'Step 1 of 5. WELD phase: pick the Straight brace (key 1) and build a ring of wall around your reactor AND your two guns. Right-click rotates.', done: (m, s, me) => me.territory > 0 },
      { text: 'Step 2 of 5. The green floor is enclosed. SEALED on your tile means your reactor is safe from direct hits. Wait for ARM.', done: (m, s) => s.phase === 'arm' || s.phase === 'fire' },
      { text: 'Step 3 of 5. ARM phase: click Rivet Spitter in the shop, then click a green floor cell inside your walls.', done: (m, s, me) => s.guns.filter((g) => g[1] === m.me).length > 2 || s.phase === 'fire' },
      { text: 'Step 4 of 5. FIRE: aim at the enemy wall and hold left click. Knock a wall down. Keys 1–4 switch guns.', done: () => this.wallsDown > 0 },
      { text: 'Step 5 of 5. Damage earns credits. In the next build round, buy one Research upgrade on the left.', done: (m, s, me) => Object.keys(me.upgrades).length > 0 },
    ];
  }
  check(m, snap) {
    const me = snap.players[m.me];
    if (!me) return;
    for (const e of snap.ev || []) if (e.e === 'wallDown' && e.by === m.me) this.wallsDown++;
    while (this.step < this.steps.length && this.steps[this.step].done(m, snap, me)) this.step++;
    this.text = this.step < this.steps.length ? this.steps[this.step].text : '';
    if (this.step >= this.steps.length && !this.finished) {
      this.finished = true;
      m.banner('Tutorial complete. You are cleared for paid shifts.');
      try { localStorage.setItem('dh.seen', JSON.stringify({ tutorial: 1 })); } catch {}
    }
  }
}

// ============================================================ how to / settings
function howTo() {
  modal(`<h2>How DECKHAND works</h2>
  <p>Each match is two rounds. Every round is a <b>build</b> (weld walls for 20 s, then arm turrets for 8 s) followed by <b>30 seconds of fire</b>.</p>
  <p>Your reactor is your castle. Seal it inside an unbroken ring of walls and it shrugs off 70% of splash damage and can't be hit by flat shots. A one-cell gap, or two walls that only touch at a corner, leaves it exposed.</p>
  <p>Enclosed floor is your territory. Turrets can only sit on it, and more floor unlocks more turrets and more scrap next round.</p>
  <p><b>Winning:</b> after two rounds the crew with the most base left wins. Base = reactor HP + every wall and turret HP still standing. Lose your reactor and you're out.</p>
  <p><b>Paid matches:</b> every crew pays the same entry into an on-chain escrow. The winner gets 90% of the pot, the house 10%. Two independent co-signers replay the whole match before the contract pays.</p>
  <h3>Controls</h3>
  <dl><dt>Weld</dt><dd><kbd>1</kbd>–<kbd>8</kbd> or wheel pick a piece, click to place, <kbd>R</kbd>/right-click rotate, <kbd>Z</kbd> undo, <kbd>E</kbd> repair</dd>
  <dt>Arm</dt><dd>Pick a turret in the shop, click green floor. Click your turret, then a cell, to move it. <kbd>X</kbd> sells.</dd>
  <dt>Fire</dt><dd>Aim with the mouse, hold left click. <kbd>1</kbd>–<kbd>4</kbd>/<kbd>Tab</kbd> switch guns. Click a crew tile or <kbd>T</kbd> to focus your auto-turrets.</dd>
  <dt>Abilities</dt><dd><kbd>Q</kbd> capacitor, <kbd>V</kbd> vent, <kbd>G</kbd> foam printer, <kbd>B</kbd> dirty tricks</dd>
  <dt>Controller</dt><dd>Stick or D-pad moves the cursor. Weld: <kbd>A</kbd> place, <kbd>X</kbd> rotate, <kbd>LB</kbd>/<kbd>RB</kbd> piece, <kbd>B</kbd> undo, <kbd>Y</kbd> repair. Arm: <kbd>LB</kbd>/<kbd>RB</kbd> turret, <kbd>A</kbd> place or move, <kbd>Y</kbd> sell. Fire: <kbd>RT</kbd> fire, right stick fine-aim, <kbd>LB</kbd>/<kbd>RB</kbd> switch gun, <kbd>Y</kbd> auto-target, <kbd>LT</kbd> ability. <kbd>L3</kbd>/<kbd>R3</kbd> pick/buy upgrade. <kbd>Back</kbd> flatten, <kbd>Start</kbd> menu.</dd>
  <dt>View</dt><dd><kbd>H</kbd> tactical flatten (low walls for precise clicking). Zoom with the wheel (<kbd>Ctrl</kbd>+wheel while welding) or <kbd>+</kbd>/<kbd>-</kbd>, pan with the middle mouse button or arrow keys, <kbd>0</kbd> resets.</dd></dl>
  <div class="row"><button class="btn" data-close>Got it</button></div>`);
}

function settingsBox() {
  const sel = (k, opts) => `<select data-k="${k}">${opts.map(([v, l]) => `<option value="${v}" ${String(settings[k]) === String(v) ? 'selected' : ''}>${l}</option>`).join('')}</select>`;
  modal(`<h2>Settings</h2>
  <div class="set"><span>Volume</span><input type="range" min="0" max="100" value="${settings.volume}" data-k="volume"></div>
  <div class="set"><span>Music</span><input type="checkbox" data-k="music" ${settings.music ? 'checked' : ''}></div>
  <div class="set"><span>Clean language (filters crew profanity)</span><input type="checkbox" data-k="profanityFilter" ${settings.profanityFilter ? 'checked' : ''}></div>
  <div class="set"><span>Screen shake</span>${sel('shake', [['full', 'Full'], ['low', 'Low'], ['', 'Off']])}</div>
  <div class="set"><span>CRT scanlines</span><input type="checkbox" data-k="scanlines" ${settings.scanlines ? 'checked' : ''}></div>
  <div class="set"><span>Interface size</span>${sel('uiScale', [[85, 'Small'], [100, 'Normal'], [120, 'Large'], [140, 'Huge']])}</div>
  <div class="set"><span>Your crew voice (text)</span>${sel('persona', PERSONAS.map((p) => [p.id, `${p.name}, ${p.role}`]))}</div>
  <p class="fine">Crew colours always come with a shape (circle, triangle, square, diamond) so nothing relies on colour alone.</p>
  <div class="row"><button class="btn" data-close>Done</button></div>`);
  $('#modal-body').querySelectorAll('[data-k]').forEach((el) => el.addEventListener('input', () => {
    const k = el.dataset.k;
    settings[k] = el.type === 'checkbox' ? el.checked : el.type === 'range' ? Number(el.value) : k === 'uiScale' ? Number(el.value) : el.value;
    saveSettings();
  }));
}

// ================================================================== wire up
$('#btn-signin').addEventListener('click', signIn);
$('#btn-practice').addEventListener('click', practiceMenu);
$('#btn-practice2').addEventListener('click', practiceMenu);
$('#btn-howto').addEventListener('click', howTo);
$('#btn-settings').addEventListener('click', settingsBox);
$('#c-age').addEventListener('change', () => ($('#btn-consent').disabled = !($('#c-age').checked && $('#c-ent').checked)));
$('#c-ent').addEventListener('change', () => ($('#btn-consent').disabled = !($('#c-age').checked && $('#c-ent').checked)));
$('#btn-consent').addEventListener('click', consentAndSign);
$('#btn-consent-cancel').addEventListener('click', () => show('landing'));
$('#h-menu').addEventListener('click', () => {
  if (app.mode !== 'practice') return;
  confirmBox('Leave this practice round?', 'Leave').then((ok) => { if (ok) { wsSend({ t: 'leaveRoom' }); app.match?.stop(); show(app.wallet ? 'hangar' : 'landing'); } });
});
window.addEventListener('dhwallet', () => { if (wallet()?.address && $('#scr-hangar').classList.contains('on')) refreshBalance(); });
document.addEventListener('visibilitychange', () => { if (!document.hidden) refreshBalance(); });

// =============================================================== controller in menus
// D-pad / left stick moves focus between buttons and fields, A presses, B backs out.
function focusables() {
  const root = !$('#modal').classList.contains('hidden') ? $('#modal') : document.querySelector('.screen.on');
  if (!root) return [];
  return [...root.querySelectorAll('button, a[href], input, select')].filter((el) => !el.disabled && el.offsetParent !== null);
}
function menuPad() {
  requestAnimationFrame(menuPad);
  if (app.match && app.match.running) return;
  if (!pad.poll()) return;
  const list = focusables();
  if (!list.length) return;
  let i = list.indexOf(document.activeElement);
  const move = (d) => {
    i = i < 0 ? 0 : (i + d + list.length) % list.length;
    document.querySelectorAll('.pad-focus').forEach((el) => el.classList.remove('pad-focus'));
    list[i].focus();
    list[i].classList.add('pad-focus');
    list[i].scrollIntoView?.({ block: 'nearest' });
  };
  const [lx, ly] = pad.axes;
  const now = performance.now();
  const stick = (ly > 0.6 || lx > 0.6) ? 1 : (ly < -0.6 || lx < -0.6) ? -1 : 0;
  if (stick && now > (app.stickAt || 0)) { move(stick); app.stickAt = now + 220; }
  if (pad.repeat(BTN.DOWN) || pad.repeat(BTN.RIGHT)) move(1);
  if (pad.repeat(BTN.UP) || pad.repeat(BTN.LEFT)) move(-1);
  if (pad.pressed(BTN.A)) {
    audio.unlock();
    const el = list[i] || list[0];
    if (el.type === 'checkbox') { el.checked = !el.checked; el.dispatchEvent(new Event('change', { bubbles: true })); el.dispatchEvent(new Event('input', { bubbles: true })); }
    else if (el.tagName === 'INPUT' || el.tagName === 'SELECT') el.focus();
    else el.click();
  }
  if (pad.pressed(BTN.B)) {
    if (!$('#modal').classList.contains('hidden')) closeModal();
    else if ($('#scr-consent').classList.contains('on')) show('landing');
  }
}
requestAnimationFrame(menuPad);

boot();
loadConfig();
connect();
$('#h-menu').style.display = 'block';
export { W };
