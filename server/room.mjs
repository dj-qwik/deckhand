// One live match: authoritative 20 Hz simulation, 10 Hz snapshots to clients,
// an evidence log of every accepted input, and optional practice bots.
import { createMatch, applyInput, step, baseScore, gunCap, SIM_VERSION } from '../game/sim/sim.js';
import { makeBot, botThink } from '../game/sim/bots.js';
import { W, H, TPS, WEAPONS } from '../game/sim/rules.js';

const SEND_EVERY = 2; // ticks between snapshots (10 Hz)
const MAX_MSGS_PER_SEC = 150; // held build strokes send one placement per cell

const ALLOWED = {
  place: ['piece', 'x', 'y', 'rot'], undo: [], repair: ['x', 'y'], crane: ['x', 'y', 'x2', 'y2'], buyGun: ['w', 'x', 'y'],
  moveGun: ['id', 'x', 'y'], sellGun: ['id'], research: ['id'], active: ['id'], aim: ['x', 'y'], fire: ['on'],
  ability: ['id', 'x', 'y'], target: ['s'],
};

/** keep only known fields of a client action, with primitive values */
export function cleanAction(a) {
  if (!a || typeof a !== 'object' || typeof a.t !== 'string' || !(a.t in ALLOWED)) return null;
  const out = { t: a.t };
  for (const k of ALLOWED[a.t]) {
    const v = a[k];
    if (v === undefined) continue;
    if (typeof v === 'number' && Number.isFinite(v)) out[k] = Math.trunc(v);
    else if (typeof v === 'string' && v.length <= 24) out[k] = v;
    else if (typeof v === 'boolean') out[k] = v;
    else return null;
  }
  return out;
}

export class Room {
  /**
   * opts: { id, mode: 'practice'|'cash', simCfg, seats: [{ wallet?, name, bot? }], onEnd(room), log }
   */
  constructor(opts) {
    this.id = opts.id;
    this.mode = opts.mode;
    this.simCfg = opts.simCfg;
    this.seats = opts.seats;
    this.onEnd = opts.onEnd || (() => {});
    this.tickMs = opts.tickMs || 1000 / TPS; // tests may run the clock faster; the sim is identical
    this.log = opts.log || (() => {});
    this.S = createMatch(this.simCfg);
    this.evidence = []; // [tick, slot, action]
    this.queue = [];
    this.conns = new Map(); // ws → { slot (or -1 spectator) }
    this.bots = this.seats.map((s, i) => (s.bot ? makeBot(i, s.bot) : null));
    this.pending = [];
    this.lastWalls = null;
    this.lastProps = null;
    this.timer = null;
    this.startedAt = 0;
    this.ended = false;
    // a cash seat with nobody connected counts as disconnected from the start
    if (this.mode === 'cash') for (let i = 0; i < this.seats.length; i++) this.enqueue(i, { t: 'conn', on: false }, true);
  }

  start() {
    this.startedAt = Date.now();
    let next = Date.now();
    const loop = () => {
      const now = Date.now();
      let n = 0;
      while (now >= next && n < 5 && !this.ended) {
        this.tick();
        next += this.tickMs;
        n++;
      }
      if (now - next > 1000) next = now; // fell far behind: don't spiral
      if (!this.ended) this.timer = setTimeout(loop, Math.max(1, next - Date.now()));
    };
    loop();
  }

  stop() {
    this.ended = true;
    clearTimeout(this.timer);
  }

  // ------------------------------------------------------------- connections
  attach(ws, slot) {
    this.conns.set(ws, { slot, msgs: 0, window: Date.now() });
    if (slot >= 0) this.enqueue(slot, { t: 'conn', on: true }, true);
    this.sendTo(ws, { t: 'start', room: this.info(slot), snap: this.snapshot(true) });
  }

  detach(ws) {
    const c = this.conns.get(ws);
    if (!c) return;
    this.conns.delete(ws);
    if (c.slot >= 0 && ![...this.conns.values()].some((o) => o.slot === c.slot)) this.enqueue(c.slot, { t: 'conn', on: false }, true);
  }

  input(ws, raw) {
    const c = this.conns.get(ws);
    if (!c || c.slot < 0) return;
    const now = Date.now();
    if (now - c.window > 1000) { c.window = now; c.msgs = 0; }
    if (++c.msgs > MAX_MSGS_PER_SEC) return;
    const a = cleanAction(raw);
    if (a) this.enqueue(c.slot, a, false, ws);
  }

  enqueue(slot, a, system, ws) {
    this.queue.push({ slot, a, ws, system });
  }

  info(slot) {
    return {
      id: this.id, mode: this.mode, you: slot, arena: this.S.arenaId, n: this.S.n,
      seats: this.seats.map((s, i) => ({ slot: i, name: s.name, wallet: s.wallet || null, bot: !!s.bot })),
    };
  }

  // -------------------------------------------------------------------- loop
  tick() {
    const S = this.S;
    if (S.phase === 'done') return;
    const q = this.queue;
    this.queue = [];
    for (const { slot, a, ws } of q) {
      const why = applyInput(S, slot, a);
      if (why === null) this.evidence.push([S.tick, slot, a]);
      else if (ws && a.t !== 'aim') this.sendTo(ws, { t: 'nope', a: a.t, why });
    }
    for (const b of this.bots) {
      if (!b) continue;
      for (const a of botThink(S, b)) if (applyInput(S, b.slot, a) === null) this.evidence.push([S.tick, b.slot, a]);
    }
    S.events.length = 0;
    step(S);
    if (S.events.length) this.pending.push(...S.events);
    if (S.tick % SEND_EVERY === 0 || S.phase === 'done') this.broadcast({ t: 'snap', snap: this.snapshot(false) });
    if (S.phase === 'done' && !this.ended) {
      this.stop();
      Promise.resolve().then(() => this.onEnd(this)).catch((e) => this.log('room onEnd failed', e));
    }
  }

  // --------------------------------------------------------------- snapshots
  snapshot(full) {
    const S = this.S;
    const players = S.players.map((p) => ({
      slot: p.slot, name: p.name, hp: p.hp, alive: p.alive, enclosed: p.enclosed, territory: p.territory, cap: gunCap(p),
      scrap: p.scrap, credits: p.credits, upgrades: p.upgrades, offer: p.offer, bought: p.boughtThisCycle,
      base: baseScore(S, p), active: p.active, target: p.target, firing: p.firing, connected: p.connected, dr: p.dr, ds: p.ds,
      rx: p.rx, ry: p.ry, yard: p.yard, face: p.face, forklift: p.forklift, warranty: p.warrantyUsed, cap8: p.capUntil > S.tick,
      undo: p.undo.length, repaired: p.repairedReactor, aim: p.aim,
    }));
    const guns = S.guns.map((g) => [g.id, g.owner, g.w, g.x, g.y, g.hp, g.max,
      Math.max(0, g.ready - S.tick), g.stun > S.tick ? g.stun - S.tick : 0, g.heat, g.over > S.tick ? 1 : 0,
      g.wind ? g.wind - S.tick : 0, g.beam === S.tick ? 1 : 0, g.bx, g.by]);
    const proj = S.proj.map((q) => [q.id, q.owner, q.w, q.x, q.y, q.z || 0, q.k === 'arc' ? 1 : q.k === 'missile' ? 2 : 0]);
    const snap = {
      tick: S.tick, phase: S.phase, phaseStart: S.phaseStart, phaseEnd: S.phaseEnd, cycle: S.cycle, players, guns, proj,
      fires: S.fires.map((f) => [f.x, f.y, f.r, f.until - S.tick, f.owner]), wind: S.wind, ev: full ? [] : this.pending,
      result: S.result ? { winner: S.result.winner, rank: S.result.rank } : null,
    };
    if (!full) this.pending = [];
    // walls + props: full arrays on attach, diffs otherwise
    const cur = [S.wOwner, S.wKind, S.wHp, S.wMax];
    if (full) {
      snap.full = {
        arena: S.arenaId, n: S.n, w: W, h: H,
        owner: Array.from(S.wOwner), kind: Array.from(S.wKind), hp: Array.from(S.wHp), max: Array.from(S.wMax),
        prop: Array.from(S.prop), vent: Array.from(S.ventCell), yard: Array.from(S.yardOf), reactor: Array.from(S.reactorAt),
        brittle: [],
      };
    }
    if (!this.lastWalls) {
      this.lastWalls = cur.map((a) => a.slice());
      this.lastProps = S.prop.slice();
    } else if (!full) {
      const d = [];
      const [o, k, hp, mx] = this.lastWalls;
      for (let i = 0; i < W * H; i++) {
        if (o[i] !== S.wOwner[i] || k[i] !== S.wKind[i] || hp[i] !== S.wHp[i] || mx[i] !== S.wMax[i]) {
          d.push([i, S.wOwner[i], S.wKind[i], S.wHp[i], S.wMax[i], S.wBrittle[i] > S.tick ? 1 : 0]);
          o[i] = S.wOwner[i]; k[i] = S.wKind[i]; hp[i] = S.wHp[i]; mx[i] = S.wMax[i];
        }
      }
      if (d.length) snap.wd = d;
      const pd = [];
      for (let i = 0; i < W * H; i++) if (this.lastProps[i] !== S.prop[i]) { pd.push([i, S.prop[i]]); this.lastProps[i] = S.prop[i]; }
      if (pd.length) snap.pd = pd;
    }
    return snap;
  }

  broadcast(msg) {
    const s = JSON.stringify(msg);
    for (const ws of this.conns.keys()) if (ws.readyState === 1) ws.send(s);
  }
  sendTo(ws, msg) {
    if (ws.readyState === 1) ws.send(JSON.stringify(msg));
  }

  /** everything a co-signer needs to replay this match (seed included) */
  evidenceBundle(extra = {}) {
    return { v: 1, simVersion: SIM_VERSION, cfg: this.simCfg, log: this.evidence, ...extra };
  }
}

export { WEAPONS };
