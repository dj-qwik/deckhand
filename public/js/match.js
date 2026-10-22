// Match controller: receives server snapshots, drives the renderer, the HUD and
// the player's controls, and sends inputs. The server stays authoritative.
import { W, H, FP, RS, TPS, DUR, CYCLES, PIECES, PIECE_IDS, pieceCells, WEAPONS, WEAPON_IDS, UPGRADES, MAX_GUNS, REACTOR_HP, ECON } from '/sim/rules.js';
import { ARENAS } from '/sim/arenas.js';
import { Renderer, PCOL, glyph } from './render.js';
import { Crew } from './crew.js';
import { pad, BTN } from './gamepad.js';

const $ = (s) => document.querySelector(s);
const esc = (t) => String(t ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
const PHASE_LABEL = { intro: 'Stand by', weld: 'Build: weld', arm: 'Build: arm', fire: 'Fire', cease: 'Cease fire', done: 'Shift over' };
const ABILITY_KEYS = { printer: 'G', capacitor: 'Q', vent: 'V', dirty: 'B' };
const SHORT = { rivet: 'Rivets', harpoon: 'Harpoon', rail: 'Mag-Rail', mortar: 'Mortar', cryo: 'Cryo', incin: 'Incinerator', missile: 'Missiles', flak: 'Flak', emp: 'EMP', wreck: 'Wrecker', welder: 'Arc Welder', cutter: 'Cutter' };
const SHOP = ['rivet', 'harpoon', 'rail', 'mortar', 'cryo', 'incin', 'missile', 'flak', 'emp', 'wreck', 'welder', 'cutter'];

export class Match {
  constructor({ send, settings, audio, onEnd, tutorial }) {
    this.send = send;
    this.settings = settings;
    this.audio = audio;
    this.onEnd = onEnd;
    this.tutorial = tutorial || null;
    this.cv = $('#view');
    this.r = new Renderer(this.cv, settings);
    this.crew = new Crew($('#h-crew'), settings);
    this.st = null;
    this.snapPrev = null;
    this.snapCur = null;
    this.tCur = 0;
    this.me = -1;
    this.tool = { mode: 'piece', piece: 'brace', rot: 0, weapon: null, gun: null, ability: null, crane: null };
    this.mouse = { x: 0, y: 0, cell: null, down: false, fx: 0, fy: 0 };
    this.lastAimSent = 0;
    this.lastAim = null;
    this.enclosedBy = new Int8Array(W * H).fill(-1);
    this.hudAt = 0;
    this.running = false;
    this.ended = false;
    this.lastPhase = '';
    this.handlers = [];
  }

  // =========================================================== lifecycle
  start(msg) {
    const f = msg.snap.full;
    this.room = msg.room;
    this.me = msg.room.you;
    this.st = {
      arena: f.arena, n: f.n, owner: f.owner, kind: f.kind, hp: f.hp, max: f.max, prop: f.prop, vent: f.vent, yard: f.yard,
      reactor: f.reactor, brittle: new Uint8Array(W * H), players: msg.snap.players,
    };
    this.snapPrev = null;
    this.snapCur = msg.snap;
    this.tCur = performance.now();
    this.r.resize();
    this.r.setMatch(this.st);
    this.computeEnclosure();
    this.ended = false;
    this.lastPhase = '';
    this.buildHudStatic();
    this.bind();
    this.running = true;
    this.audio.startMusic();
    let last = performance.now();
    const loop = (t) => {
      if (!this.running) return;
      const dt = Math.min(0.1, (t - last) / 1000);
      last = t;
      this.frame(dt);
      requestAnimationFrame(loop);
    };
    requestAnimationFrame(loop);
    this.onSnap(msg.snap, true);
  }

  stop() {
    this.running = false;
    this.unbind();
    this.audio.setIntensity(0);
    this.crew.clear();
  }

  onSnap(snap, first) {
    const st = this.st;
    if (snap.wd) {
      for (const [i, o, k, hp, mx, br] of snap.wd) { st.owner[i] = o; st.kind[i] = k; st.hp[i] = hp; st.max[i] = mx; st.brittle[i] = br; }
      this.computeEnclosure();
    }
    if (snap.pd) for (const [i, k] of snap.pd) st.prop[i] = k;
    st.players = snap.players;
    if (!first) { this.snapPrev = this.snapCur; this.snapCur = snap; this.tCur = performance.now(); }
    for (const e of snap.ev || []) this.onEvent(e, snap);
    if (snap.phase !== this.lastPhase) this.onPhase(snap);
    if (snap.phase === 'done' && !this.ended) {
      this.ended = true;
      const winner = snap.result?.winner;
      if (winner === this.me) { this.audio.play('win'); this.crew.say('win', { force: true }); }
      setTimeout(() => this.onEnd && this.onEnd(snap, this.room), 2600);
    }
    this.tutorial?.check(this, snap);
  }

  onPhase(snap) {
    const p = snap.phase;
    this.lastPhase = p;
    this.audio.setIntensity(p === 'fire' ? 1 : 0);
    if (p === 'weld') { this.setTool({ mode: 'piece', piece: this.tool.piece || 'brace' }); this.banner(`Round ${snap.cycle}: weld your walls`); this.crew.say('weld'); this.audio.play('klaxon'); }
    if (p === 'arm') { this.setTool({ mode: 'buy', weapon: null }); this.banner('Arm up: bolt turrets inside your walls'); this.crew.say('arm'); }
    if (p === 'fire') { this.setTool({ mode: 'aim' }); this.banner(`Round ${snap.cycle}: FIRE`, true); this.crew.say('fire', { force: true }); this.audio.play('klaxon'); }
    if (p === 'cease') { this.setTool({ mode: 'none' }); this.send({ t: 'fire', on: false }); this.mouse.down = false; }
    if (p === 'done') this.setTool({ mode: 'none' });
    this.renderTools();
  }

  onEvent(e, snap) {
    this.r.event(e, snap);
    const me = this.me;
    const meP = snap.players[me];
    const near = (x, y) => {
      if (!meP) return 0.6;
      const d = Math.hypot(x / FP - meP.rx, y / FP - meP.ry);
      return Math.max(0.2, 1 - d / 40);
    };
    switch (e.e) {
      case 'shot': {
        const g = snap.guns.find((q) => q[0] === e.id);
        if (g) this.audio.play(e.w, g[1] === me ? 1 : 0.4);
        break;
      }
      case 'boom': this.audio.play('boom', near(e.x, e.y)); break;
      case 'hit': this.audio.play('hit', near(e.x, e.y)); if (e.w === 'wreck') this.audio.play('wreck'); break;
      case 'charge': this.audio.play('charge'); break;
      case 'flak': this.audio.play('flak', 0.5); break;
      case 'zap': this.audio.play('welder'); break;
      case 'wallDown':
        this.audio.play('wallDown', 0.6);
        if (e.s === me) this.crew.say('myWallDown');
        else if (e.by === me) this.crew.say('hitThem');
        break;
      case 'gunDown': if (e.s === me) this.crew.say('gunDown'); break;
      case 'reactorHit': if (e.s === me) { this.crew.say('reactorHit'); this.audio.play('alarm'); } break;
      case 'out':
        this.audio.play('out');
        if (e.s === me) { this.crew.say('meOut', { force: true }); this.banner('Your reactor is gone. You are out. Spectating.', true); }
        else { this.crew.say('enemyOut', { force: true }); this.banner(`${snap.players[e.s].name} is out`); }
        break;
      case 'warranty': if (e.s === me) this.crew.say('warranty', { force: true }); this.banner('CLAIM DENIED. Warranty saved a reactor.'); break;
      case 'announce': this.banner(e.text); break;
      case 'surge': this.banner('Radiation surge', true); break;
      case 'place': if (e.s === me) this.audio.play('place'); break;
      case 'upgrade': if (e.s === me) this.toast(`Installed: ${UPGRADES[e.id].name}`); break;
      case 'forklift': this.banner('Forklift of Doom blocked a shot'); break;
      case 'scramble': this.banner('Turret scrambled'); break;
      default: break;
    }
  }

  // ===================================================================== HUD
  buildHudStatic() {
    const arena = ARENAS.find((a) => a.id === this.st.arena);
    this.banner(`${arena ? arena.name : ''}: ${arena ? arena.hazard : ''}`);
    const top = $('#h-top'), clock = $('#h-clock');
    top.querySelectorAll('.ptile').forEach((el) => el.remove());
    const tile = (p) => {
      const d = document.createElement('div');
      d.className = 'ptile';
      d.dataset.s = p.slot;
      d.style.setProperty('--c', PCOL[p.slot]);
      d.title = 'Click to point your auto-turrets at this crew (click again for spread fire)';
      d.innerHTML = `<div class="nm"><canvas width="14" height="14"></canvas><span></span><span class="tag"></span></div><div class="bar2"><b></b></div><div class="meta"><span>Base <em class="b"></em></span><span>Core <em class="h"></em></span></div>`;
      glyph(d.querySelector('canvas').getContext('2d'), p.slot, 7, 7, 5.5, PCOL[p.slot]);
      return d;
    };
    const ps = this.snapCur.players, half = Math.ceil(ps.length / 2);
    ps.forEach((p, i) => top.insertBefore(tile(p), i < half ? clock : null));
    document.querySelectorAll('.ptile').forEach((el) => el.addEventListener('click', () => {
      const s = Number(el.dataset.s);
      if (s === this.me) return;
      const p = this.snapCur.players[this.me];
      this.send({ t: 'target', s: p && p.target === s ? -1 : s });
      this.audio.play('ui');
    }));
  }

  updateHud() {
    const snap = this.snapCur, me = snap.players[this.me];
    snap.players.forEach((p) => {
      const el = document.querySelector(`.ptile[data-s="${p.slot}"]`);
      if (!el) return;
      el.querySelector('.nm span').textContent = p.name + (p.slot === this.me ? ' (you)' : '');
      const tag = el.querySelector('.tag');
      if (!p.alive) { tag.className = 'tag out'; tag.textContent = 'OUT'; }
      else if (!p.connected) { tag.className = 'tag dc'; tag.textContent = 'OFFLINE'; }
      else if (p.enclosed) { tag.className = 'tag ok'; tag.textContent = 'SEALED'; }
      else { tag.className = 'tag bad'; tag.textContent = 'BREACH'; }
      el.querySelector('.bar2 b').style.width = `${(100 * p.hp) / REACTOR_HP}%`;
      el.querySelector('.b').textContent = p.base.toLocaleString();
      el.querySelector('.h').textContent = p.hp;
      el.classList.toggle('me', p.slot === this.me);
      el.classList.toggle('out', !p.alive);
      el.classList.toggle('targeted', !!me && me.target === p.slot);
    });
    if (!me) return;
    $('#h-scrap').textContent = me.scrap;
    $('#h-cred').textContent = me.credits;
    $('#h-floor').textContent = `${me.territory}`;
    this.renderTools();
  }

  clock() {
    const snap = this.snapCur;
    const est = snap.tick + (performance.now() - this.tCur) / (1000 / TPS);
    const left = Math.max(0, (snap.phaseEnd - est) / TPS);
    $('#h-phase').textContent = PHASE_LABEL[snap.phase] || snap.phase;
    const t = $('#h-time');
    t.textContent = snap.phase === 'done' ? '--' : Math.ceil(left).toString();
    t.classList.toggle('hot', left <= 5 && snap.phase !== 'intro');
    $('#h-round').textContent = snap.cycle ? `Round ${snap.cycle} of ${CYCLES}` : 'Clocking in';
  }

  renderTools() {
    const snap = this.snapCur;
    const me = snap?.players[this.me];
    const L = $('#h-tools'), R = $('#h-right'), RS = $('#h-research');
    if (!me || !me.alive) { L.innerHTML = me && !me.alive ? '<p class="hint">Reactor destroyed. You are spectating.</p>' : ''; R.innerHTML = ''; RS.innerHTML = ''; return; }
    const ph = snap.phase;
    const key = JSON.stringify([this.padRes, pad.active, ph, me.scrap, me.credits, me.offer, me.bought, me.upgrades, me.undo, this.tool, me.cap, me.active, me.territory,
      snap.guns.filter((g) => g[1] === this.me).map((g) => [g[0], g[2], Math.round(g[7] / 3), g[8] > 0, g[10]])]);
    if (key === this.toolKey) return;
    this.toolKey = key;
    // ---- left: build tools / abilities
    if (ph === 'weld') {
      L.innerHTML = `<div class="tools">${PIECE_IDS.map((id) => {
        const p = PIECES[id];
        return `<button class="tool" data-piece="${id}" aria-pressed="${this.tool.mode === 'piece' && this.tool.piece === id}" ${me.scrap < p.cost ? 'disabled' : ''} title="${esc(p.name)}: ${p.cost} scrap, ${p.hp} HP per cell"><span class="k">${p.key}</span><span class="c">${p.cost}</span><canvas width="34" height="22" data-shape="${id}"></canvas>${esc(p.name.split(' ').slice(-1)[0])}</button>`;
      }).join('')}</div>
      <div class="abil"><button data-tool="repair" aria-pressed="${this.tool.mode === 'repair'}">Repair (E)</button>${'crane' in me.upgrades ? `<button data-tool="crane" ${me.upgrades.crane > 0 ? '' : 'disabled'}>Crane ×${me.upgrades.crane} (C)</button>` : ''}<button data-tool="undo" ${me.undo ? '' : 'disabled'}>Undo ×${me.undo} (Z)</button><button data-tool="rot">Rotate (R)</button></div>`;
      L.querySelectorAll('canvas[data-shape]').forEach((cv) => drawShape(cv, cv.dataset.shape, PCOL[this.me]));
    } else if (ph === 'arm') {
      L.innerHTML = `<p class="hint">Click a turret below, then a floor cell inside your walls (green). Click one of your turrets to move it, then click its new spot. Turrets: ${snap.guns.filter((g) => g[1] === this.me).length}/${me.cap}.</p>${this.tool.gun ? `<div class="abil"><button data-tool="sell">Sell selected (X)</button><button data-tool="cancel">Cancel (Esc)</button></div>` : ''}`;
    } else if (ph === 'fire' || ph === 'cease') {
      const act = Object.keys(me.upgrades).filter((id) => UPGRADES[id].active && id !== 'crane');
      L.innerHTML = `<p class="hint">Hold left click to fire the selected gun. Your other turrets fire on their own at ${me.target >= 0 ? esc(snap.players[me.target]?.name) : 'every crew in turn'}. Click a crew tile to focus them.</p>${act.length ? `<div class="abil">${act.map((id) => `<button data-ability="${id}" ${me.upgrades[id] > 0 ? '' : 'disabled'} aria-pressed="${this.tool.ability === id}">${esc(UPGRADES[id].name.split(' ').slice(-1)[0])} (${ABILITY_KEYS[id]}) ×${me.upgrades[id]}</button>`).join('')}</div>` : ''}`;
    } else L.innerHTML = '<p class="hint">Get ready. Your yard is the one marked (you).</p>';
    // ---- research (build rounds)
    if ((ph === 'weld' || ph === 'arm') && me.offer.length) {
      RS.innerHTML = `<div class="ttl"><span>Research: one upgrade per round</span><span>${me.bought ? 'installed' : ''}</span></div><div class="cards">${me.offer.map((id) => {
        const u = UPGRADES[id];
        const owned = id in me.upgrades;
        const k = me.offer.indexOf(id);
        return `<button class="card ${owned ? 'owned' : ''} ${pad.active && k === (this.padRes || 0) % me.offer.length ? 'padsel' : ''}" data-research="${id}" ${me.bought || owned || me.credits < u.cost ? 'disabled' : ''}><span class="c">${u.cost} cr</span><b>${esc(u.name)}</b><br>${esc(u.blurb)}</button>`;
      }).join('')}</div>`;
    } else if (Object.keys(me.upgrades).length) {
      RS.innerHTML = `<div class="ttl"><span>Upgrades</span></div><div class="fine">${Object.keys(me.upgrades).map((id) => esc(UPGRADES[id].name)).join(', ')}</div>`;
    } else RS.innerHTML = '';
    // ---- right: shop or guns
    const mine = snap.guns.filter((g) => g[1] === this.me);
    if (ph === 'arm') {
      R.innerHTML = `<div class="ttl"><span>Turret shop</span><span>${mine.length}/${me.cap}</span></div><div class="cards">${SHOP.map((w) => {
        const d = WEAPONS[w];
        return `<button class="card" data-weapon="${w}" aria-pressed="${this.tool.weapon === w}" ${me.scrap < d.cost || mine.length >= me.cap ? 'disabled' : ''} title="${esc(d.name)}: ${esc(d.blurb)}"><b>${esc(SHORT[w] || d.name)}</b><span class="c">${d.cost}</span></button>`;
      }).join('')}</div>${this.tool.weapon ? `<p class="fine">${esc(WEAPONS[this.tool.weapon].blurb)}</p>` : me.cap < MAX_GUNS ? `<p class="fine">Enclose more floor to unlock turret ${me.cap + 1}.</p>` : ''}`;
    } else if (ph === 'fire' || ph === 'cease' || ph === 'weld' || ph === 'intro') {
      R.innerHTML = `<div class="ttl"><span>Your turrets</span><span>${ph === 'fire' ? '1–4 / Tab to switch' : ''}</span></div><div class="guns2">${mine.map((g, k) => {
        const d = WEAPONS[g[2]];
        const rl = d.reload ? 1 - Math.min(1, g[7] / d.reload) : g[10] ? 0 : 1;
        return `<div class="gunrow ${me.active === g[0] ? 'act' : ''}" data-gun="${g[0]}"><span class="k">${k + 1}</span>${esc(d.name)}<span class="rl ${g[8] ? 'stun' : ''}"><b style="width:${Math.round(rl * 100)}%"></b></span></div>`;
      }).join('') || '<p class="hint">No turrets standing.</p>'}</div>`;
    } else R.innerHTML = '';
  }

  banner(text, red) {
    const el = $('#h-banner');
    el.textContent = text;
    el.classList.toggle('red', !!red);
    clearTimeout(this.bannerT);
    this.bannerT = setTimeout(() => (el.textContent = ''), 2600);
  }
  tip(text) { $('#h-tip').textContent = text || ''; }
  toast(t) { window.dispatchEvent(new CustomEvent('dh-toast', { detail: t })); }

  // ================================================================= frame
  // ============================================================== controller
  padTick(dt) {
    if (!pad.poll()) { this.padEl && (this.padEl.style.display = 'none'); return; }
    const snap = this.snapCur, me = snap?.players[this.me];
    const r = this.r;
    if (!this.padCur) {
      const p = me || snap.players[0];
      this.padCur = r.iso(p.rx + 1.5, p.ry + 1.5);
    }
    // left stick moves the cursor; right stick is a slower fine-aim
    const [lx, ly, rx, ry] = pad.axes;
    const fast = Math.max(r.vw, r.vh) * 0.9, fine = fast * 0.35;
    let moved = false;
    if (lx || ly) { this.padCur[0] += lx * fast * dt; this.padCur[1] += ly * fast * dt; moved = true; }
    if (rx || ry) { this.padCur[0] += rx * fine * dt; this.padCur[1] += ry * fine * dt; moved = true; }
    // d-pad steps one cell at a time (precise building)
    const step = (dx, dy) => {
      const [fx, fy] = r.toCell(this.padCur[0], this.padCur[1]);
      const cx = Math.max(0, Math.min(W - 1, Math.floor(fx) + dx)), cy = Math.max(0, Math.min(H - 1, Math.floor(fy) + dy));
      this.padCur = r.iso(cx + 0.5, cy + 0.5);
      moved = true;
    };
    if (pad.repeat(BTN.UP)) step(0, -1);
    if (pad.repeat(BTN.DOWN)) step(0, 1);
    if (pad.repeat(BTN.LEFT)) step(-1, 0);
    if (pad.repeat(BTN.RIGHT)) step(1, 0);
    this.padCur[0] = Math.max(0, Math.min(r.vw, this.padCur[0]));
    this.padCur[1] = Math.max(0, Math.min(r.vh, this.padCur[1]));
    if (moved || pad.active) {
      const rect = this.cv.getBoundingClientRect();
      this.onMove({ clientX: rect.left + this.padCur[0], clientY: rect.top + this.padCur[1] });
    }
    if (!this.padEl) {
      this.padEl = document.createElement('div');
      this.padEl.id = 'pad-cursor';
      $('#hud').appendChild(this.padEl);
    }
    this.padEl.style.display = pad.active ? 'block' : 'none';
    this.padEl.style.transform = `translate(${this.padCur[0]}px, ${this.padCur[1]}px)`;

    if (pad.pressed(BTN.START)) $('#h-menu').click();
    if (pad.pressed(BTN.BACK)) this.onKey({ key: 'h', target: null, preventDefault() {} });
    if (!snap || !me || !me.alive) return;
    const ph = snap.phase;
    const click = () => this.onDown({ button: 0, preventDefault() {} });
    const unclick = () => this.onUp({ button: 0 });
    // research: L3 picks the card, R3 buys it
    if ((ph === 'weld' || ph === 'arm') && me.offer.length) {
      if (pad.pressed(BTN.L3)) { this.padRes = ((this.padRes || 0) + 1) % me.offer.length; this.toolKey = null; }
      if (pad.pressed(BTN.R3)) this.send({ t: 'research', id: me.offer[(this.padRes || 0) % me.offer.length] });
    }
    if (ph === 'weld') {
      if (pad.pressed(BTN.A) || pad.pressed(BTN.RT)) click();
      if (pad.released(BTN.A) || pad.released(BTN.RT)) unclick();
      if (pad.pressed(BTN.X)) this.rotate();
      if (pad.pressed(BTN.B)) this.send({ t: 'undo' });
      if (pad.pressed(BTN.Y)) this.setTool({ mode: this.tool.mode === 'repair' ? 'piece' : 'repair' });
      if (pad.pressed(BTN.LB) || pad.pressed(BTN.RB)) {
        const i = PIECE_IDS.indexOf(this.tool.piece);
        this.setTool({ mode: 'piece', piece: PIECE_IDS[(i + (pad.pressed(BTN.RB) ? 1 : PIECE_IDS.length - 1)) % PIECE_IDS.length] });
      }
    } else if (ph === 'arm') {
      if (pad.pressed(BTN.A) || pad.pressed(BTN.RT)) click();
      if (pad.pressed(BTN.B)) this.setTool({ mode: 'buy', weapon: null, gun: null });
      if (pad.pressed(BTN.Y) && this.tool.gun) { this.send({ t: 'sellGun', id: this.tool.gun }); this.setTool({ mode: 'buy', gun: null }); }
      if (pad.pressed(BTN.LB) || pad.pressed(BTN.RB)) {
        const i = SHOP.indexOf(this.tool.weapon);
        const n = pad.pressed(BTN.RB) ? (i + 1) % SHOP.length : (i <= 0 ? SHOP.length - 1 : i - 1);
        this.setTool({ mode: 'buy', weapon: SHOP[n], gun: null });
      }
    } else if (ph === 'fire') {
      if (this.tool.ability) {
        if (pad.pressed(BTN.A) || pad.pressed(BTN.RT)) click();
        if (pad.pressed(BTN.B)) this.setTool({ mode: 'aim', ability: null });
      } else {
        if (pad.pressed(BTN.RT) || pad.pressed(BTN.A)) click();
        if ((pad.released(BTN.RT) || pad.released(BTN.A)) && !pad.down(BTN.RT) && !pad.down(BTN.A)) unclick();
      }
      if (pad.pressed(BTN.LB) || pad.pressed(BTN.RB)) {
        const mine = snap.guns.filter((g) => g[1] === this.me);
        if (mine.length) {
          const i = mine.findIndex((g) => g[0] === me.active);
          const g = mine[(i + (pad.pressed(BTN.RB) ? 1 : mine.length - 1)) % mine.length];
          this.send({ t: 'active', id: g[0] });
        }
      }
      if (pad.pressed(BTN.Y)) this.onKey({ key: 't', target: null, preventDefault() {} });
      if (pad.pressed(BTN.LT)) {
        const ready = Object.keys(me.upgrades).filter((id) => UPGRADES[id].active && id !== 'crane' && me.upgrades[id] > 0);
        if (ready.length) {
          this.padAb = ((this.padAb ?? -1) + 1) % ready.length;
          const ab = ready[this.padAb];
          if (ab === 'printer' || ab === 'dirty') { this.setTool({ mode: 'ability', ability: ab }); this.toast(`${UPGRADES[ab].name}: aim and press A`); }
          else this.send({ t: 'ability', id: ab });
        }
      }
    }
  }

  frame(dt) {
    this.padTick(dt);
    if (!this.snapCur) return;
    const alphaT = Math.min(1, (performance.now() - this.tCur) / 100);
    const snap = this.snapCur;
    const me = snap.players[this.me];
    const view = {
      me: this.me, snapPrev: this.snapPrev, snapCur: snap, alpha: alphaT, hover: this.mouse.cell, ghost: null, aim: null,
      enclosedBy: this.enclosedBy, selectedGun: this.tool.gun,
    };
    if (me && me.alive) {
      if (snap.phase === 'weld' && this.mouse.cell) view.ghost = this.ghostFor(this.mouse.cell);
      if (snap.phase === 'arm' && this.mouse.cell && (this.tool.weapon || this.tool.gun)) view.ghost = this.gunGhost(this.mouse.cell);
      if (snap.phase === 'fire') {
        const [fx, fy] = this.mouse.f || [0, 0];
        view.aim = { x: fx, y: fy, gun: me.active };
        this.sendAim();
        if (this.tool.ability === 'printer' && this.mouse.cell) view.ghost = { cells: [this.mouse.cell], ok: this.cellFreeMine(this.mouse.cell[1] * W + this.mouse.cell[0]), label: 'Foam seal' };
      }
    }
    this.r.frame(dt, view);
    this.clock();
    const now = performance.now();
    if (now - this.hudAt > 200) { this.hudAt = now; this.updateHud(); this.contextTip(); }
  }

  contextTip() {
    const snap = this.snapCur, me = snap.players[this.me];
    if (pad.active && me && me.alive && !this.tutorial?.text) {
      const t = {
        weld: 'Stick/D-pad: move · A: place · X: rotate · LB/RB: piece · B: undo · Y: repair · L3/R3: pick/buy upgrade',
        arm: 'LB/RB: pick turret · A: place, or select one of yours then A to move it · Y: sell · B: cancel · L3/R3: upgrade',
        fire: 'Stick: aim · RT/A: fire · LB/RB: switch gun · Y: auto-target · LT: ability · Back: flatten view',
      }[snap.phase];
      if (t) return this.tip(t);
    }
    if (this.tutorial?.text) return this.tip(this.tutorial.text);
    if (!me || !me.alive || snap.phase === 'done') return this.tip('');
    if (snap.phase === 'weld') {
      if (me.territory === 0) return this.tip('Wall in some floor around your reactor and guns. Enclosed floor (green) is where turrets can go.');
      if (!me.enclosed) return this.tip('Your reactor is exposed. Close every gap; corners must touch edge to edge.');
      return this.tip('Right-click or R rotates. Z undoes. E then click repairs a damaged wall or your reactor.');
    }
    if (snap.phase === 'arm') return this.tip(me.scrap >= 6 ? 'Buy a turret and drop it on green floor inside your walls.' : 'Low on scrap. Move your guns inside the walls or buy an upgrade.');
    if (snap.phase === 'fire') return this.tip(me.enclosed ? '' : 'BREACH: your reactor takes full damage until the next weld.');
    return this.tip('');
  }

  // ============================================================ enclosure
  computeEnclosure() {
    const st = this.st;
    const out = new Uint8Array(W * H);
    const pass = (i) => !(st.hp[i] > 0) && st.reactor[i] < 0;
    const stack = [];
    const push = (x, y) => { const i = y * W + x; if (!out[i] && pass(i)) { out[i] = 1; stack.push(i); } };
    for (let x = 0; x < W; x++) { push(x, 0); push(x, H - 1); }
    for (let y = 0; y < H; y++) { push(0, y); push(W - 1, y); }
    while (stack.length) {
      const i = stack.pop(), x = i % W, y = (i / W) | 0;
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        const nx = x + dx, ny = y + dy;
        if ((dx || dy) && nx >= 0 && ny >= 0 && nx < W && ny < H) push(nx, ny);
      }
    }
    this.outside = out;
    for (let i = 0; i < W * H; i++) this.enclosedBy[i] = !out[i] && pass(i) && st.yard[i] >= 0 ? st.yard[i] : -1;
  }

  cellFreeMine(i) {
    const st = this.st, snap = this.snapCur;
    if (st.hp[i] > 0 || st.prop[i] || st.vent[i] || st.reactor[i] >= 0 || st.yard[i] !== this.me) return false;
    if (snap.guns.some((g) => g[4] * W + g[3] === i)) return false;
    const cx = (i % W) * FP + 128, cy = ((i / W) | 0) * FP + 128;
    for (const f of snap.fires) { const dx = cx - f[0], dy = cy - f[1]; if (dx * dx + dy * dy <= f[2] * f[2]) return false; }
    return true;
  }

  ghostFor([x, y]) {
    const me = this.snapCur.players[this.me];
    if (this.tool.mode === 'repair') {
      const i = y * W + x;
      const ok = (this.st.owner[i] === this.me && this.st.hp[i] > 0 && this.st.hp[i] < this.st.max[i]) || (this.st.reactor[i] === this.me && me.hp < REACTOR_HP);
      return { cells: [[x, y]], ok: ok && me.scrap >= 1, label: 'Repair' };
    }
    if (this.tool.mode === 'crane') {
      const from = this.tool.crane;
      if (!from) return { cells: [[x, y]], ok: this.st.owner[y * W + x] === this.me && this.st.hp[y * W + x] > 0, label: 'Pick a wall cell' };
      const ok = Math.abs(from[0] - x) + Math.abs(from[1] - y) === 1 && this.cellFreeMine(y * W + x);
      return { cells: [[x, y]], ok, label: 'Drop it here' };
    }
    if (this.tool.mode !== 'piece') return null;
    const id = this.tool.piece;
    let cells;
    if (id === 'collar') {
      cells = [];
      for (let yy = me.ry - 1; yy <= me.ry + RS; yy++) for (let xx = me.rx - 1; xx <= me.rx + RS; xx++) if (this.st.reactor[yy * W + xx] < 0) cells.push([xx, yy]);
      const free = cells.filter(([a, b]) => this.cellFreeMine(b * W + a));
      return { cells: free.length ? free : cells, ok: free.length > 0 && me.scrap >= PIECES.collar.cost, label: `${PIECES.collar.name} ${PIECES.collar.cost}` };
    }
    cells = pieceCells(id, this.tool.rot).map(([dx, dy]) => [x + dx, y + dy]);
    const inMap = cells.every(([a, b]) => a >= 0 && b >= 0 && a < W && b < H);
    const ok = inMap && cells.every(([a, b]) => this.cellFreeMine(b * W + a)) && me.scrap >= PIECES[id].cost;
    return { cells: cells.filter(([a, b]) => a >= 0 && b >= 0 && a < W && b < H), ok, label: '', block: true };
  }

  gunGhost([x, y]) {
    const i = y * W + x;
    const ok = this.cellFreeMine(i) && this.enclosedBy[i] === this.me;
    return { cells: [[x, y]], ok, label: ok ? '' : this.enclosedBy[i] === this.me ? 'blocked' : 'must be inside your walls' };
  }

  // ================================================================= input
  bind() {
    const on = (el, ev, fn, opt) => { el.addEventListener(ev, fn, opt); this.handlers.push([el, ev, fn, opt]); };
    on(window, 'resize', () => this.r.resize());
    on(this.cv, 'mousemove', (e) => this.onMove(e));
    on(this.cv, 'mousedown', (e) => this.onDown(e));
    on(window, 'mouseup', (e) => this.onUp(e));
    on(this.cv, 'contextmenu', (e) => { e.preventDefault(); });
    on(this.cv, 'wheel', (e) => this.onWheel(e), { passive: false });
    on(window, 'keydown', (e) => this.onKey(e));
    on($('#hud'), 'click', (e) => this.onHudClick(e));
    on(this.cv, 'mouseleave', () => (this.mouse.cell = null));
    on(this.cv, 'touchstart', (e) => { const t = e.touches[0]; this.onMove(t); this.onDown({ button: 0, clientX: t.clientX, clientY: t.clientY, preventDefault() {} }); e.preventDefault(); }, { passive: false });
    on(this.cv, 'touchmove', (e) => { this.onMove(e.touches[0]); e.preventDefault(); }, { passive: false });
    on(this.cv, 'touchend', (e) => { this.onUp({ button: 0 }); e.preventDefault(); }, { passive: false });
  }
  unbind() {
    for (const [el, ev, fn, opt] of this.handlers) el.removeEventListener(ev, fn, opt);
    this.handlers = [];
  }

  onMove(e) {
    if (this.drag && e.clientX !== undefined) {
      this.r.panBy(e.clientX - this.drag[0], e.clientY - this.drag[1]);
      this.drag = [e.clientX, e.clientY];
    }
    const rect = this.cv.getBoundingClientRect();
    const [fx, fy] = this.r.toCell(e.clientX - rect.left, e.clientY - rect.top);
    this.mouse.f = [fx, fy];
    const cx = Math.floor(fx), cy = Math.floor(fy);
    this.mouse.cell = cx >= 0 && cy >= 0 && cx < W && cy < H ? [cx, cy] : null;
  }

  sendAim(force) {
    const now = performance.now();
    if (!this.mouse.f) return;
    const x = Math.max(0, Math.min(W * FP - 1, Math.round(this.mouse.f[0] * FP)));
    const y = Math.max(0, Math.min(H * FP - 1, Math.round(this.mouse.f[1] * FP)));
    if (!force && (now - this.lastAimSent < 60 || (this.lastAim && this.lastAim[0] === x && this.lastAim[1] === y))) return;
    this.lastAimSent = now;
    this.lastAim = [x, y];
    this.send({ t: 'aim', x, y });
  }

  onDown(e) {
    this.audio.unlock();
    if (e.button === 1) { e.preventDefault?.(); this.drag = [e.clientX, e.clientY]; return; }
    const snap = this.snapCur, me = snap?.players[this.me];
    if (!me || !me.alive) return;
    const c = this.mouse.cell;
    if (e.button === 2) {
      if (snap.phase === 'weld') this.rotate();
      if (snap.phase === 'arm') this.setTool({ mode: 'buy', weapon: null, gun: null });
      if (snap.phase === 'fire' && this.tool.ability) this.setTool({ mode: 'aim', ability: null });
      return;
    }
    if (e.button !== 0) return;
    if (snap.phase === 'weld' && c) {
      const [x, y] = c;
      if (this.tool.mode === 'piece') this.send({ t: 'place', piece: this.tool.piece, x, y, rot: this.tool.rot });
      else if (this.tool.mode === 'repair') {
        this.send({ t: 'repair', x, y });
        this.mouse.down = true;
        this.repairRepeat = setInterval(() => this.mouse.cell && this.send({ t: 'repair', x: this.mouse.cell[0], y: this.mouse.cell[1] }), 160);
      } else if (this.tool.mode === 'crane') {
        if (!this.tool.crane) this.tool.crane = [x, y];
        else { this.send({ t: 'crane', x: this.tool.crane[0], y: this.tool.crane[1], x2: x, y2: y }); this.tool.crane = null; }
      }
    } else if (snap.phase === 'arm' && c) {
      const [x, y] = c;
      const g = snap.guns.find((q) => q[3] === x && q[4] === y && q[1] === this.me);
      if (g) { this.setTool({ mode: 'move', gun: g[0], weapon: null }); return; }
      if (this.tool.gun) { this.send({ t: 'moveGun', id: this.tool.gun, x, y }); this.setTool({ mode: 'buy', gun: null }); }
      else if (this.tool.weapon) this.send({ t: 'buyGun', w: this.tool.weapon, x, y });
    } else if (snap.phase === 'fire') {
      if (this.tool.ability && c) {
        this.send({ t: 'ability', id: this.tool.ability, x: c[0], y: c[1] });
        this.setTool({ mode: 'aim', ability: null });
        return;
      }
      this.sendAim(true);
      this.send({ t: 'fire', on: true });
      this.mouse.down = true;
    }
  }

  onUp(e) {
    if (e.button === 1) { this.drag = null; return; }
    if (e.button !== 0) return;
    clearInterval(this.repairRepeat);
    if (this.mouse.down && this.snapCur?.phase === 'fire') this.send({ t: 'fire', on: false });
    this.mouse.down = false;
  }

  onWheel(e) {
    e.preventDefault();
    if (this.snapCur?.phase !== 'weld' || e.ctrlKey || e.metaKey) {
      const rect = this.cv.getBoundingClientRect();
      this.r.zoomBy(e.deltaY < 0 ? 1.12 : 1 / 1.12, e.clientX - rect.left, e.clientY - rect.top);
      return;
    }
    const i = PIECE_IDS.indexOf(this.tool.piece);
    const n = PIECE_IDS[(i + (e.deltaY > 0 ? 1 : PIECE_IDS.length - 1)) % PIECE_IDS.length];
    this.setTool({ mode: 'piece', piece: n });
  }

  rotate() { this.tool.rot = (this.tool.rot + 1) & 3; this.toolKey = null; }

  onKey(e) {
    if (e.target && (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA')) return;
    const snap = this.snapCur, me = snap?.players[this.me];
    const k = e.key.toLowerCase();
    if (k === 'h') { this.r.flatten = !this.r.flatten; this.r.sprites.clear(); this.toast(this.r.flatten ? 'Tactical flatten on' : 'Tactical flatten off'); return; }
    if (k === '=' || k === '+') return this.r.zoomBy(1.15, this.r.vw / 2, this.r.vh / 2);
    if (k === '-' || k === '_') return this.r.zoomBy(1 / 1.15, this.r.vw / 2, this.r.vh / 2);
    if (k === '0') return this.r.resetView();
    if (k.startsWith('arrow')) { const d = 40; this.r.panBy(k === 'arrowleft' ? d : k === 'arrowright' ? -d : 0, k === 'arrowup' ? d : k === 'arrowdown' ? -d : 0); e.preventDefault(); return; }
    if (k === 'escape') { this.setTool({ ability: null, gun: null, weapon: null, crane: null, mode: snap?.phase === 'weld' ? 'piece' : snap?.phase === 'fire' ? 'aim' : 'buy' }); return; }
    if (!me || !me.alive) return;
    if (snap.phase === 'weld') {
      const p = PIECE_IDS.find((id) => PIECES[id].key === k);
      if (p) return this.setTool({ mode: 'piece', piece: p });
      if (k === 'r') return this.rotate();
      if (k === 'z') return this.send({ t: 'undo' });
      if (k === 'e') return this.setTool({ mode: this.tool.mode === 'repair' ? 'piece' : 'repair' });
      if (k === 'c' && me.upgrades.crane > 0) return this.setTool({ mode: 'crane', crane: null });
    }
    if (snap.phase === 'arm') {
      if ((k === 'x' || k === 'delete') && this.tool.gun) { this.send({ t: 'sellGun', id: this.tool.gun }); this.setTool({ mode: 'buy', gun: null }); }
    }
    if (snap.phase === 'fire' || snap.phase === 'weld' || snap.phase === 'intro') {
      const mine = snap.guns.filter((g) => g[1] === this.me);
      if (/^[1-4]$/.test(k) && snap.phase !== 'weld') { const g = mine[Number(k) - 1]; if (g) this.send({ t: 'active', id: g[0] }); return; }
      if (k === 'tab') {
        e.preventDefault();
        const i = mine.findIndex((g) => g[0] === me.active);
        const g = mine[(i + 1) % Math.max(1, mine.length)];
        if (g) this.send({ t: 'active', id: g[0] });
        return;
      }
      if (k === 't') {
        const foes = snap.players.filter((p) => p.slot !== this.me && p.alive).map((p) => p.slot);
        const order = [-1, ...foes];
        const n = order[(order.indexOf(me.target) + 1) % order.length];
        this.send({ t: 'target', s: n });
        this.toast(n < 0 ? 'Auto-turrets: spread fire' : `Auto-turrets: focus ${snap.players[n].name}`);
        return;
      }
    }
    if (snap.phase === 'fire') {
      const ab = Object.entries(ABILITY_KEYS).find(([, key]) => key.toLowerCase() === k)?.[0];
      if (ab && me.upgrades[ab] > 0) {
        if (ab === 'printer' || ab === 'dirty') return this.setTool({ mode: 'ability', ability: ab });
        this.send({ t: 'ability', id: ab });
      }
    }
  }

  onHudClick(e) {
    const b = e.target.closest('button, .gunrow');
    if (!b) return;
    this.audio.unlock();
    this.audio.play('ui');
    if (b.dataset.piece) this.setTool({ mode: 'piece', piece: b.dataset.piece });
    else if (b.dataset.tool === 'repair') this.setTool({ mode: this.tool.mode === 'repair' ? 'piece' : 'repair' });
    else if (b.dataset.tool === 'crane') this.setTool({ mode: 'crane', crane: null });
    else if (b.dataset.tool === 'undo') this.send({ t: 'undo' });
    else if (b.dataset.tool === 'rot') this.rotate();
    else if (b.dataset.tool === 'sell' && this.tool.gun) { this.send({ t: 'sellGun', id: this.tool.gun }); this.setTool({ mode: 'buy', gun: null }); }
    else if (b.dataset.tool === 'cancel') this.setTool({ mode: 'buy', gun: null, weapon: null });
    else if (b.dataset.weapon) this.setTool({ mode: 'buy', weapon: this.tool.weapon === b.dataset.weapon ? null : b.dataset.weapon, gun: null });
    else if (b.dataset.research) this.send({ t: 'research', id: b.dataset.research });
    else if (b.dataset.gun) this.send({ t: 'active', id: Number(b.dataset.gun) });
    else if (b.dataset.ability) {
      const ab = b.dataset.ability;
      if (ab === 'printer' || ab === 'dirty') this.setTool({ mode: 'ability', ability: ab });
      else this.send({ t: 'ability', id: ab });
    }
  }

  setTool(t) {
    Object.assign(this.tool, t);
    this.toolKey = null;
  }
}

function drawShape(cv, id, col) {
  const c = cv.getContext('2d');
  c.clearRect(0, 0, cv.width, cv.height);
  const cells = id === 'collar' ? [[0, 0], [1, 0], [2, 0], [3, 0], [0, 1], [3, 1], [0, 2], [1, 2], [2, 2], [3, 2]] : pieceCells(id, 0);
  const s = id === 'collar' ? 5 : 7;
  const xs = cells.map((p) => p[0]), ys = cells.map((p) => p[1]);
  const w = (Math.max(...xs) - Math.min(...xs) + 1) * s, h = (Math.max(...ys) - Math.min(...ys) + 1) * s;
  const ox = (cv.width - w) / 2 - Math.min(...xs) * s, oy = (cv.height - h) / 2 - Math.min(...ys) * s;
  const mat = PIECES[id].mat;
  c.fillStyle = mat === 'foam' ? '#c8b46a' : mat === 'heavy' ? '#7e8b8c' : mat === 'mesh' ? '#5e8a8c' : '#a3aaa5';
  for (const [x, y] of cells) { c.fillRect(ox + x * s, oy + y * s, s - 1, s - 1); }
  c.fillStyle = col;
  for (const [x, y] of cells) c.fillRect(ox + x * s, oy + y * s, s - 1, 1.5);
}

export { DUR, ECON, WEAPON_IDS };
