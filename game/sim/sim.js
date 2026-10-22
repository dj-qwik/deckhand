// DECKHAND authoritative simulation.
//
// Pure and deterministic: (config, ordered input log) → identical state on the
// server, on each co-signer and in tests. Integer maths only. The browser imports
// this module just for rules/geometry helpers and preview validation; it never
// decides damage, currency, enclosure or victory.
import {
  W, H, FP, HALF, TPS, CYCLES, DUR, YARD, YARDS, RS, RHALF, REACTOR_HP, ENCLOSED_SPLASH_MULT, AUTO_DELAY,
  AUTO_RELOAD_PCT, AUTO_SPREAD_PCT, MAX_GUNS, BASE_GUNS, TERRITORY_PER_GUN, TERRITORY_PER_SCRAP, GUN_HP, ECON, MATERIALS, PIECES, PIECE_IDS, pieceCells,
  WEAPONS, WEAPON_IDS, UPGRADES, UPGRADE_IDS,
} from './rules.js';
import { makeRng, seedWords, isqrt, idiv, clamp, hasher } from './util.js';
import { arenaById, ARENA_IDS } from './arenas.js';

export const SIM_VERSION = 1;
const N = W * H;
const cellCenter = (c) => c * FP + HALF;
const inMap = (x, y) => x >= 0 && y >= 0 && x < W && y < H;

// ===================================================================== setup

/**
 * cfg: { seed: hex string (server secret), arena: id, players: [{name}] (2–4) }
 */
export function createMatch(cfg) {
  const n = cfg.players.length;
  if (n < 2 || n > 4) throw new Error('2–4 players');
  const rng = makeRng(seedWords(cfg.seed));
  const S = {
    v: SIM_VERSION,
    arenaId: arenaById(cfg.arena).id,
    n,
    rng,
    tick: 0,
    phase: 'intro',
    phaseStart: 0,
    phaseEnd: DUR.intro,
    cycle: 0,
    nextId: 1,
    players: [],
    wOwner: new Int8Array(N).fill(-1),
    wKind: new Int8Array(N).fill(-1),
    wHp: new Int32Array(N),
    wMax: new Int32Array(N),
    wBrittle: new Int32Array(N),
    prop: new Uint8Array(N),
    ventCell: new Uint8Array(N),
    yardOf: new Int8Array(N).fill(-1),
    reactorAt: new Int8Array(N).fill(-1),
    gunAt: new Int32Array(N).fill(0), // gun id, 0 = none
    outside: new Uint8Array(N),
    guns: [],
    proj: [],
    fires: [],
    wind: 0,
    arena: {},
    vents: [],
    dirtyEncl: true,
    events: [],
    result: null,
  };
  // seeded seat → yard assignment (and, for 3 players, which corner stays empty)
  const yards = YARDS[n].slice();
  if (n === 3) yards.splice(rng.int(4), 1);
  for (let k = yards.length - 1; k > 0; k--) {
    const j = rng.int(k + 1);
    [yards[k], yards[j]] = [yards[j], yards[k]];
  }
  for (let s = 0; s < n; s++) {
    const [yx, yy] = yards[s];
    // "front" = the axis pointing most toward the middle of the map
    const ddx = W / 2 - (yx + YARD / 2), ddy = H / 2 - (yy + YARD / 2);
    const face = Math.abs(ddx) >= Math.abs(ddy) ? [Math.sign(ddx), 0] : [0, Math.sign(ddy)];
    const p = {
      slot: s,
      name: String(cfg.players[s].name || `Crew ${s + 1}`).slice(0, 18),
      yard: [yx, yy],
      face,
      // reactor sits mid-yard, nudged toward the map centre so mirrored yards match
      rx: yx + (yx + YARD / 2 > W / 2 ? 6 : 5),
      ry: yy + (yy + YARD / 2 > H / 2 ? 6 : 5),
      hp: REACTOR_HP,
      hpPrev: REACTOR_HP,
      alive: true,
      outTick: 0,
      enclosed: false,
      territory: 0,
      target: -1, // which enemy the auto-turrets focus; -1 = spread fire across all enemies
      scrap: 0,
      credits: ECON.creditsStart,
      creditAcc: 0,
      dr: 0, // damage dealt to enemy reactors
      ds: 0, // damage dealt to enemy structures (walls + turrets)
      aim: [cellCenter(W >> 1), cellCenter(H >> 1)],
      firing: false,
      active: 0,
      upgrades: {}, // id → uses left this cycle (0 for passives)
      offer: [],
      boughtThisCycle: false,
      undo: [],
      repairedReactor: 0,
      connected: true,
      warrantyUsed: false,
      forklift: 0,
      capUntil: 0,
      capPending: false,
      salvageAcc: 0,
      tb: 0,
    };
    S.players.push(p);
    for (let y = yy; y < yy + YARD; y++) for (let x = yx; x < yx + YARD; x++) S.yardOf[y * W + x] = s;
    for (let y = p.ry; y < p.ry + RS; y++) for (let x = p.rx; x < p.rx + RS; x++) S.reactorAt[y * W + x] = s;
  }
  // per-player seeded tiebreak, drawn before anything else uses the RNG
  for (const p of S.players) p.tb = rng.u32();
  arenaById(S.arenaId).init(S);
  for (const p of S.players) {
    // starter ring of braced cells around the reactor
    for (let y = p.ry - 1; y <= p.ry + RS; y++)
      for (let x = p.rx - 1; x <= p.rx + RS; x++) {
        if (S.reactorAt[y * W + x] >= 0) continue;
        setWall(S, y * W + x, p.slot, PIECE_IDS.indexOf('brace'), PIECES.brace.hp);
      }
    // starter guns just outside the ring, facing the middle of the map
    const [fx, fy] = p.face;
    // rivet sits on the side nearer the map's centre line so mirrored yards match
    if (fx) {
      const gx = fx > 0 ? p.rx + RS + 1 : p.rx - 2;
      const toCentre = p.ry + 1 < H / 2 ? 2 : 0;
      addGun(S, p.slot, 'rivet', gx, p.ry + 1);
      addGun(S, p.slot, 'mortar', gx, p.ry + toCentre);
    } else {
      const gy = fy > 0 ? p.ry + RS + 1 : p.ry - 2;
      const toCentre = p.rx + 1 < W / 2 ? 2 : 0;
      addGun(S, p.slot, 'rivet', p.rx + 1, gy);
      addGun(S, p.slot, 'mortar', p.rx + toCentre, gy);
    }
    // everyone starts on the lobbing mortar: it arcs over walls onto the other yards
    p.active = S.guns.find((g) => g.owner === p.slot && g.w === 'mortar').id;
  }
  recomputeEnclosure(S);
  return S;
}

function setWall(S, i, owner, kind, hp) {
  S.wOwner[i] = owner;
  S.wKind[i] = kind;
  S.wHp[i] = hp;
  S.wMax[i] = hp;
  S.wBrittle[i] = 0;
  S.dirtyEncl = true;
}
function clearWall(S, i) {
  S.wOwner[i] = -1;
  S.wKind[i] = -1;
  S.wHp[i] = 0;
  S.wMax[i] = 0;
  S.wBrittle[i] = 0;
  S.dirtyEncl = true;
}
const wallMat = (S, i) => PIECES[PIECE_IDS[S.wKind[i]]].mat;

function addGun(S, owner, w, x, y) {
  const g = {
    id: S.nextId++, owner, w, x, y, hp: GUN_HP, max: GUN_HP, ready: 0, burst: 0, burstAt: 0, tx: 0, ty: 0,
    heat: 0, over: 0, stun: 0, wind: 0, beam: 0, bx: 0, by: 0, icd: 0, rr: 0,
  };
  S.guns.push(g);
  S.gunAt[y * W + x] = g.id;
  return g;
}
const gunById = (S, id) => S.guns.find((g) => g.id === id);
function removeGun(S, g) {
  S.gunAt[g.y * W + g.x] = 0;
  S.guns.splice(S.guns.indexOf(g), 1);
  for (const p of S.players) if (p.active === g.id) p.active = (S.guns.find((q) => q.owner === p.slot) || { id: 0 }).id;
}

// ================================================================= enclosure

/** 8-connected flood from the map border. Walls with HP and reactor cells block;
 *  corner-touching walls therefore leak, as do one-cell gaps. */
export function recomputeEnclosure(S) {
  const out = S.outside;
  out.fill(0);
  const stack = [];
  const passable = (i) => S.wHp[i] <= 0 && S.reactorAt[i] < 0;
  const push = (x, y) => {
    const i = y * W + x;
    if (!out[i] && passable(i)) {
      out[i] = 1;
      stack.push(i);
    }
  };
  for (let x = 0; x < W; x++) { push(x, 0); push(x, H - 1); }
  for (let y = 0; y < H; y++) { push(0, y); push(W - 1, y); }
  while (stack.length) {
    const i = stack.pop();
    const x = i % W, y = (i - x) / W;
    for (let dy = -1; dy <= 1; dy++)
      for (let dx = -1; dx <= 1; dx++) {
        if (!dx && !dy) continue;
        const nx = x + dx, ny = y + dy;
        if (inMap(nx, ny)) push(nx, ny);
      }
  }
  for (const p of S.players) {
    let t = 0;
    const [yx, yy] = p.yard;
    for (let y = yy; y < yy + YARD; y++)
      for (let x = yx; x < yx + YARD; x++) {
        const i = y * W + x;
        if (!out[i] && S.wHp[i] <= 0 && S.reactorAt[i] < 0) t++;
      }
    p.territory = t;
    let exposed = false;
    for (let y = p.ry - 1; y <= p.ry + RS && !exposed; y++)
      for (let x = p.rx - 1; x <= p.rx + RS; x++) if (inMap(x, y) && out[y * W + x]) { exposed = true; break; }
    p.enclosed = !exposed;
  }
  S.dirtyEncl = false;
}
export const gunEnclosed = (S, g) => !S.outside[g.y * W + g.x];
export const gunCap = (p) => Math.min(MAX_GUNS, BASE_GUNS + Math.floor(p.territory / TERRITORY_PER_GUN));

// ==================================================================== inputs

const BUILD_PHASES = new Set(['weld', 'arm']);

function cellFree(S, i, slot) {
  if (S.wHp[i] > 0 || S.prop[i] || S.ventCell[i] || S.reactorAt[i] >= 0 || S.gunAt[i]) return false;
  if (S.yardOf[i] !== slot) return false;
  if (inFire(S, i)) return false;
  return true;
}
function inFire(S, i) {
  const cx = cellCenter(i % W), cy = cellCenter((i / W) | 0);
  for (const f of S.fires) {
    const dx = cx - f.x, dy = cy - f.y;
    if (dx * dx + dy * dy <= f.r * f.r) return true;
  }
  return false;
}

/** Cells a piece would occupy (absolute indices) or null if off-map. */
export function placementCells(S, slot, piece, x, y, rot) {
  if (piece === 'collar') {
    const p = S.players[slot];
    const cells = [];
    for (let yy = p.ry - 1; yy <= p.ry + RS; yy++)
      for (let xx = p.rx - 1; xx <= p.rx + RS; xx++) if (S.reactorAt[yy * W + xx] < 0) cells.push(yy * W + xx);
    return cells;
  }
  const rel = pieceCells(piece, rot);
  if (!rel) return null;
  const out = [];
  for (const [dx, dy] of rel) {
    const cx = x + dx, cy = y + dy;
    if (!inMap(cx, cy)) return null;
    out.push(cy * W + cx);
  }
  return out;
}

/** returns null if legal, or a short reason */
export function checkPlacement(S, slot, piece, x, y, rot) {
  const def = PIECES[piece];
  if (!def) return 'unknown piece';
  const p = S.players[slot];
  if (S.phase !== 'weld') return 'walls go up during WELD';
  if (p.scrap < def.cost) return 'not enough scrap';
  const cells = placementCells(S, slot, piece, x, y, rot);
  if (!cells) return 'off the map';
  if (piece === 'collar') {
    const free = cells.filter((i) => cellFree(S, i, slot));
    return free.length ? null : 'collar ring already full';
  }
  for (const i of cells) if (!cellFree(S, i, slot)) return 'blocked';
  return null;
}

const int = (v, lo, hi) => (Number.isInteger(v) && v >= lo && v <= hi ? v : null);

/**
 * Apply one player action. Returns null when applied, otherwise a reason string
 * (the action is ignored). Validation depends only on simulation state.
 */
export function applyInput(S, slot, a) {
  const p = S.players[slot];
  if (!p || !a || typeof a.t !== 'string') return 'bad input';
  if (S.phase === 'done') return 'match over';
  if (a.t === 'conn') {
    p.connected = !!a.on;
    if (!p.connected) p.firing = false;
    return null;
  }
  if (!p.alive) return 'eliminated';
  switch (a.t) {
    case 'place': {
      const x = int(a.x, 0, W - 1), y = int(a.y, 0, H - 1), rot = int(a.rot, 0, 3);
      if (x === null || y === null || rot === null || typeof a.piece !== 'string') return 'bad input';
      const why = checkPlacement(S, slot, a.piece, x, y, rot);
      if (why) return why;
      const def = PIECES[a.piece];
      let cells = placementCells(S, slot, a.piece, x, y, rot);
      if (a.piece === 'collar') cells = cells.filter((i) => cellFree(S, i, slot));
      const k = PIECE_IDS.indexOf(a.piece);
      for (const i of cells) setWall(S, i, slot, k, def.hp);
      p.scrap -= def.cost;
      p.undo.push({ cells, cost: def.cost });
      if (p.undo.length > ECON.undoDepth) p.undo.shift();
      ev(S, { e: 'place', s: slot, cells });
      return null;
    }
    case 'undo': {
      if (S.phase !== 'weld') return 'undo only during WELD';
      const u = p.undo.pop();
      if (!u) return 'nothing to undo';
      if (u.cells.some((i) => S.wOwner[i] !== slot || S.wHp[i] !== S.wMax[i])) return 'piece changed';
      for (const i of u.cells) clearWall(S, i);
      p.scrap += u.cost;
      ev(S, { e: 'undo', s: slot, cells: u.cells });
      return null;
    }
    case 'repair': {
      if (S.phase !== 'weld') return 'repairs happen during WELD';
      const x = int(a.x, 0, W - 1), y = int(a.y, 0, H - 1);
      if (x === null || y === null) return 'bad input';
      const i = y * W + x;
      if (p.scrap < 1) return 'not enough scrap';
      if (inFire(S, i)) return 'still burning';
      if (S.reactorAt[i] === slot) {
        const room = Math.min(REACTOR_HP - p.hp, ECON.repairReactorCapPerCycle - p.repairedReactor);
        if (room <= 0) return 'reactor repair limit';
        const amt = Math.min(room, ECON.repairReactorHp);
        p.hp += amt;
        p.repairedReactor += amt;
        p.scrap -= 1;
        ev(S, { e: 'repair', s: slot, i, amt });
        return null;
      }
      if (S.wOwner[i] !== slot || S.wHp[i] <= 0) return 'not your wall';
      if (S.wHp[i] >= S.wMax[i]) return 'already fine';
      const amt = Math.min(ECON.repairWallHp, S.wMax[i] - S.wHp[i]);
      S.wHp[i] += amt;
      p.scrap -= 1;
      ev(S, { e: 'repair', s: slot, i, amt });
      return null;
    }
    case 'crane': {
      if (S.phase !== 'weld') return 'crane works during WELD';
      if (!(p.upgrades.crane > 0)) return 'no crane uses';
      const fx = int(a.x, 0, W - 1), fy = int(a.y, 0, H - 1), tx = int(a.x2, 0, W - 1), ty = int(a.y2, 0, H - 1);
      if ([fx, fy, tx, ty].includes(null)) return 'bad input';
      if (Math.abs(fx - tx) + Math.abs(fy - ty) !== 1) return 'one tile only';
      const i = fy * W + fx, j = ty * W + tx;
      if (S.wOwner[i] !== slot || S.wHp[i] <= 0) return 'not your wall';
      if (!cellFree(S, j, slot)) return 'blocked';
      const kind = S.wKind[i], hp = S.wHp[i], max = S.wMax[i];
      clearWall(S, i);
      setWall(S, j, slot, kind, max);
      S.wHp[j] = hp;
      p.upgrades.crane -= 1;
      p.undo = [];
      ev(S, { e: 'crane', s: slot, from: i, to: j });
      return null;
    }
    case 'buyGun': {
      if (S.phase !== 'arm') return 'turrets go in during ARM';
      const w = WEAPONS[a.w];
      const x = int(a.x, 0, W - 1), y = int(a.y, 0, H - 1);
      if (!w || x === null || y === null) return 'bad input';
      if (S.guns.filter((g) => g.owner === slot).length >= gunCap(p)) return 'enclose more floor for another turret';
      if (p.scrap < w.cost) return 'not enough scrap';
      if (!cellFree(S, y * W + x, slot)) return 'blocked';
      if (S.outside[y * W + x]) return 'turrets must sit inside your walls';
      const g = addGun(S, slot, a.w, x, y);
      p.scrap -= w.cost;
      if (!p.active) p.active = g.id;
      ev(S, { e: 'gun', s: slot, id: g.id });
      return null;
    }
    case 'moveGun': {
      if (S.phase !== 'arm') return 'move turrets during ARM';
      const g = gunById(S, a.id);
      const x = int(a.x, 0, W - 1), y = int(a.y, 0, H - 1);
      if (!g || g.owner !== slot || x === null || y === null) return 'bad input';
      if (!cellFree(S, y * W + x, slot)) return 'blocked';
      if (S.outside[y * W + x]) return 'turrets must sit inside your walls';
      S.gunAt[g.y * W + g.x] = 0;
      g.x = x;
      g.y = y;
      S.gunAt[y * W + x] = g.id;
      return null;
    }
    case 'sellGun': {
      if (S.phase !== 'arm') return 'sell turrets during ARM';
      const g = gunById(S, a.id);
      if (!g || g.owner !== slot) return 'bad input';
      const refund = idiv(WEAPONS[g.w].cost * ECON.sellRefundPct * g.hp, 100 * g.max);
      p.scrap = Math.min(ECON.scrapCap, p.scrap + refund);
      removeGun(S, g);
      return null;
    }
    case 'research': {
      if (!BUILD_PHASES.has(S.phase)) return 'research between rounds';
      if (p.boughtThisCycle) return 'one upgrade per round';
      const id = a.id;
      if (!p.offer.includes(id)) return 'not offered';
      const u = UPGRADES[id];
      if (p.credits < u.cost) return 'not enough credits';
      p.credits -= u.cost;
      p.upgrades[id] = u.uses || 0;
      p.boughtThisCycle = true;
      if (id === 'forklift') p.forklift = 1;
      ev(S, { e: 'upgrade', s: slot, id });
      return null;
    }
    case 'active': {
      const g = gunById(S, a.id);
      if (!g || g.owner !== slot) return 'bad input';
      p.active = g.id;
      return null;
    }
    case 'aim': {
      const x = int(a.x, 0, W * FP - 1), y = int(a.y, 0, H * FP - 1);
      if (x === null || y === null) return 'bad input';
      p.aim = [x, y];
      return null;
    }
    case 'fire': {
      p.firing = !!a.on;
      return null;
    }
    case 'target': {
      if (a.s === -1) { p.target = -1; return null; }
      const q = S.players[a.s];
      if (!q || q.slot === slot) return 'bad input';
      p.target = q.slot;
      return null;
    }
    case 'ability':
      return ability(S, p, a);
    default:
      return 'unknown action';
  }
}

function ability(S, p, a) {
  const id = a.id;
  if (!(id in p.upgrades) || !UPGRADES[id] || !UPGRADES[id].active) return 'not owned';
  if (id === 'crane') return 'use the crane by dragging a wall';
  if (S.phase !== 'fire') return 'abilities fire during FIRE';
  if (!(p.upgrades[id] > 0)) return 'used up';
  const x = int(a.x, 0, W - 1), y = int(a.y, 0, H - 1);
  if (id === 'printer') {
    if (x === null || y === null) return 'bad input';
    const i = y * W + x;
    if (!cellFree(S, i, p.slot)) return 'blocked';
    setWall(S, i, p.slot, PIECE_IDS.indexOf('foam'), PIECES.foam.hp);
    ev(S, { e: 'place', s: p.slot, cells: [i] });
  } else if (id === 'capacitor') {
    p.capUntil = S.tick + 8 * TPS;
    p.capPending = true;
    ev(S, { e: 'ability', s: p.slot, id });
  } else if (id === 'vent') {
    const cx = p.rx * FP + RHALF, cy = p.ry * FP + RHALF;
    const r = 4 * FP;
    let n = 0;
    for (const q of S.proj.slice()) {
      if (q.owner === p.slot) continue;
      const dx = q.x - cx, dy = q.y - cy;
      if (dx * dx + dy * dy <= r * r) { killProj(S, q, 'vented'); n++; }
    }
    ev(S, { e: 'ability', s: p.slot, id, n });
  } else if (id === 'dirty') {
    if (x === null || y === null) return 'bad input';
    let best = null, bd = 0;
    for (const g of S.guns) {
      if (g.owner === p.slot) continue;
      const d = Math.abs(g.x - x) + Math.abs(g.y - y);
      if (d <= 2 && (!best || d < bd)) { best = g; bd = d; }
    }
    if (!best) return 'no enemy turret there';
    best.stun = Math.max(best.stun, S.tick + 3 * TPS);
    ev(S, { e: 'scramble', s: p.slot, id: best.id });
  }
  p.upgrades[id] -= 1;
  return null;
}

// ====================================================================== step

const ev = (S, e) => { e.t = S.tick; S.events.push(e); };

/** Advance one tick (inputs for this tick must already be applied). */
export function step(S) {
  if (S.phase === 'done') return;
  S.tick += 1;
  for (const p of S.players) p.hpPrev = p.hp;
  if (S.tick >= S.phaseEnd) nextPhase(S);
  if (S.phase === 'done') return;

  if (S.phase === 'fire') {
    const f = S.tick - S.phaseStart;
    arenaById(S.arenaId).fire(S, f, arenaApi(S));
    for (const p of S.players) {
      if (p.capPending && p.capUntil && S.tick >= p.capUntil) {
        p.capPending = false;
        for (const g of S.guns.slice()) if (g.owner === p.slot) dmgGun(S, g, idiv(g.max, 10), 'kinetic', -1);
      }
    }
    for (const g of S.guns.slice()) if (S.guns.includes(g)) gunTick(S, g, f);
    hounds(S);
  }
  if (S.phase === 'fire' || S.phase === 'cease') {
    for (const g of S.guns) if (WEAPONS[g.w].kind === 'flak') flakIntercept(S, g);
    projTick(S);
  }
  firesTick(S);
  if (S.dirtyEncl) recomputeEnclosure(S);
  checkEnd(S);
}

function nextPhase(S) {
  const from = S.phase;
  let to;
  if (from === 'intro') to = 'weld';
  else if (from === 'weld') to = 'arm';
  else if (from === 'arm') to = 'fire';
  else if (from === 'fire') to = 'cease';
  else if (from === 'cease') to = S.cycle < CYCLES ? 'weld' : 'done';
  else to = 'done';
  if (from === 'fire') {
    arenaById(S.arenaId).endFire(S);
    for (const p of S.players) p.firing = false;
    for (const g of S.guns) { g.wind = 0; g.beam = 0; g.burst = 0; }
  }
  if (to === 'done') return finish(S);
  S.phase = to;
  S.phaseStart = S.tick;
  S.phaseEnd = S.tick + DUR[to];
  if (to === 'weld') startBuild(S);
  if (to === 'fire') startFire(S);
  ev(S, { e: 'phase', phase: to, cycle: S.cycle });
}

function startBuild(S) {
  S.cycle += 1;
  for (const p of S.players) {
    if (!p.alive) continue;
    const gain = S.cycle === 1 ? ECON.scrapStart : ECON.scrapPerCycle + Math.floor(p.territory / TERRITORY_PER_SCRAP);
    p.scrap = Math.min(ECON.scrapCap, p.scrap + gain + ('coffee' in p.upgrades ? 6 : 0));
    p.undo = [];
    p.repairedReactor = 0;
    p.boughtThisCycle = false;
    // three research offers, no duplicates of what they own
    const pool = UPGRADE_IDS.filter((id) => !(id in p.upgrades));
    p.offer = [];
    for (let k = 0; k < 3 && pool.length; k++) p.offer.push(pool.splice(S.rng.int(pool.length), 1)[0]);
    for (const id of Object.keys(p.upgrades)) if (UPGRADES[id].uses) p.upgrades[id] = UPGRADES[id].uses;
    if ('forklift' in p.upgrades) p.forklift = 1;
  }
}

function startFire(S) {
  for (const g of S.guns) {
    g.ready = S.tick + 4;
    g.icd = S.tick;
    g.heat = 0;
    g.over = 0;
  }
  for (const p of S.players) {
    p.undo = [];
    p.paycheck = S.cycle === CYCLES && 'paycheck' in p.upgrades && p.enclosed;
  }
}

// =================================================================== damage

function credit(S, attacker, amt, reactor) {
  if (attacker < 0 || amt <= 0) return;
  const a = S.players[attacker];
  if (reactor) a.dr += amt; else a.ds += amt;
  a.creditAcc += amt * (reactor ? 2 : 1);
  while (a.creditAcc >= ECON.creditPerDamage) {
    a.creditAcc -= ECON.creditPerDamage;
    if (a.credits < ECON.creditCap) a.credits += 1;
  }
}

function dmgWall(S, i, amount, dtype, attacker, armorPierce) {
  if (S.wHp[i] <= 0) return 0;
  const owner = S.wOwner[i];
  let mult = MATERIALS[wallMat(S, i)][dtype];
  if (armorPierce && mult < 100) mult = 100;
  if ((dtype === 'kinetic' || dtype === 'explosive') && S.wBrittle[i] > S.tick) mult = idiv(mult * 160, 100);
  if (dtype === 'explosive' && owner >= 0 && 'armor' in S.players[owner].upgrades) mult = idiv(mult * 80, 100);
  const dmg = Math.min(S.wHp[i], Math.max(1, idiv(amount * mult, 100)));
  S.wHp[i] -= dmg;
  if (attacker !== owner) credit(S, attacker, dmg, false);
  if (S.wHp[i] <= 0) {
    ev(S, { e: 'wallDown', i, s: owner, by: attacker });
    clearWall(S, i);
    if (owner >= 0 && 'hounds' in S.players[owner].upgrades) {
      const o = S.players[owner];
      o.salvageAcc += 1;
      if (o.salvageAcc >= 2) { o.salvageAcc = 0; o.scrap = Math.min(ECON.scrapCap, o.scrap + 1); }
    }
  }
  return dmg;
}

function dmgGun(S, g, amount, dtype, attacker) {
  let mult = dtype === 'emp' ? 100 : 100;
  if (g.beam && g.beam >= S.tick - 1) mult = WEAPONS.cutter.exposePct;
  const dmg = Math.min(g.hp, Math.max(1, idiv(amount * mult, 100)));
  g.hp -= dmg;
  if (attacker !== g.owner) credit(S, attacker, dmg, false);
  if (g.hp <= 0) {
    ev(S, { e: 'gunDown', id: g.id, s: g.owner, x: g.x, y: g.y, by: attacker });
    removeGun(S, g);
  }
  return dmg;
}

function dmgReactor(S, p, amount, attacker, splash) {
  if (!p.alive || amount <= 0) return 0;
  let dmg = splash && p.enclosed ? idiv(amount * ENCLOSED_SPLASH_MULT, 100) : amount;
  dmg = Math.max(1, dmg);
  if (dmg >= p.hp && 'warranty' in p.upgrades && !p.warrantyUsed) {
    p.warrantyUsed = true;
    dmg = p.hp - 1;
    ev(S, { e: 'warranty', s: p.slot });
  }
  dmg = Math.min(dmg, p.hp);
  p.hp -= dmg;
  credit(S, attacker, dmg, true);
  ev(S, { e: 'reactorHit', s: p.slot, by: attacker, dmg, splash: !!splash });
  if (p.hp <= 0) eliminate(S, p, attacker);
  return dmg;
}

function eliminate(S, p, by) {
  p.hp = 0;
  p.alive = false;
  p.outTick = S.tick;
  p.firing = false;
  ev(S, { e: 'out', s: p.slot, by });
}

/** splash damage with linear falloff 100% → 25% at the edge */
function splash(S, x, y, r, amount, dtype, attacker, extra) {
  const c0x = Math.max(0, idiv(x - r, FP)), c1x = Math.min(W - 1, idiv(x + r, FP));
  const c0y = Math.max(0, idiv(y - r, FP)), c1y = Math.min(H - 1, idiv(y + r, FP));
  const fall = (d) => amount - idiv(amount * 75 * d, 100 * r);
  for (let cy = c0y; cy <= c1y; cy++)
    for (let cx = c0x; cx <= c1x; cx++) {
      const i = cy * W + cx;
      const dx = cellCenter(cx) - x, dy = cellCenter(cy) - y;
      const d = isqrt(dx * dx + dy * dy);
      if (d > r) continue;
      const hit = fall(d);
      if (S.wHp[i] > 0 && S.wOwner[i] !== attacker) {
        if (extra && extra.brittle) S.wBrittle[i] = S.tick + extra.brittle;
        dmgWall(S, i, hit, dtype, attacker, false);
      }
      const gid = S.gunAt[i];
      if (gid) {
        const g = gunById(S, gid);
        if (g && g.owner !== attacker) dmgGun(S, g, hit, dtype, attacker);
      }
    }
  for (const p of S.players) {
    if (p.slot === attacker || !p.alive) continue;
    let best = -1;
    for (let k = 0; k < RS * RS; k++) {
      const dx = cellCenter(p.rx + (k % RS)) - x, dy = cellCenter(p.ry + Math.floor(k / RS)) - y;
      const d = isqrt(dx * dx + dy * dy);
      if (best < 0 || d < best) best = d;
    }
    if (best <= r) dmgReactor(S, p, fall(best), attacker, true);
  }
}

// ===================================================================== guns

function enemyAlive(S, slot) {
  return S.players.filter((q) => q.slot !== slot && q.alive);
}

function autoTarget(S, g) {
  const w = WEAPONS[g.w];
  const gx = cellCenter(g.x), gy = cellCenter(g.y);
  let best = null, bd = 0;
  if (w.prio === 'guns') {
    for (const q of S.guns) {
      if (q.owner === g.owner || !S.players[q.owner].alive) continue;
      const dx = cellCenter(q.x) - gx, dy = cellCenter(q.y) - gy;
      const d = dx * dx + dy * dy;
      if (!best || d < bd) { best = [cellCenter(q.x), cellCenter(q.y)]; bd = d; }
    }
    if (best) return best;
  }
  const mine = S.players[g.owner];
  const chosen = S.players[mine.target];
  if (chosen && chosen.alive && chosen.slot !== g.owner) return [chosen.rx * FP + RHALF, chosen.ry * FP + RHALF];
  // spread fire: rotate through every enemy still standing, one shot each
  // cyclic order starting after our own seat, so no seat is everyone's first target
  const foes = enemyAlive(S, g.owner).sort((a, b) => ((a.slot - g.owner + S.n) % S.n) - ((b.slot - g.owner + S.n) % S.n));
  if (!foes.length) return null;
  const q = foes[g.rr % foes.length];
  g.rr += 1;
  return [q.rx * FP + RHALF, q.ry * FP + RHALF];
}

function reloadTicks(S, g, auto) {
  const p = S.players[g.owner];
  let r = WEAPONS[g.w].reload;
  if (auto) r = idiv(r * AUTO_RELOAD_PCT, 100);
  if (p.capUntil > S.tick) r = idiv(r * 70, 100);
  if (p.paycheck) r = idiv(r * 85, 100);
  return Math.max(2, r);
}

function gunTick(S, g, f) {
  const p = S.players[g.owner];
  const w = WEAPONS[g.w];
  if (!p.alive) return;
  if (g.stun > S.tick) { g.wind = 0; return; }
  const isActive = g.id === p.active && p.connected;
  const manual = isActive && p.firing;
  const auto = !isActive && f >= AUTO_DELAY;

  // bursts already in progress keep going
  if (g.burst > 0 && S.tick >= g.burstAt) {
    g.burst -= 1;
    g.burstAt = S.tick + w.burstGap;
    fireDirect(S, g, g.tx, g.ty, 0);
  }

  if (w.kind === 'beam') return beamTick(S, g, manual, auto);
  if (w.kind === 'flak' && !manual) return; // flak auto-mode is interception only

  // rail windup completes regardless of trigger (committed shot)
  if (g.wind) {
    if (S.tick >= g.wind) {
      g.wind = 0;
      const [tx, ty] = g.windAuto ? autoTarget(S, g) || [g.tx, g.ty] : p.aim;
      fireDirect(S, g, tx, ty, g.windAuto ? idiv(w.spread * AUTO_SPREAD_PCT, 100) : w.spread);
      g.ready = S.tick + reloadTicks(S, g, g.windAuto);
    }
    return;
  }
  if (!manual && !auto) return;
  if (S.tick < g.ready) return;
  let target = manual ? p.aim : autoTarget(S, g);
  if (!target) return;
  const spread = manual ? w.spread || 0 : idiv((w.spread || FP / 4) * AUTO_SPREAD_PCT, 100);

  if (w.windup) {
    g.wind = S.tick + w.windup;
    g.windAuto = !manual;
    g.tx = target[0]; g.ty = target[1];
    ev(S, { e: 'charge', id: g.id, x: target[0], y: target[1] });
    return;
  }
  g.ready = S.tick + reloadTicks(S, g, auto);
  if (w.kind === 'direct') {
    const [tx, ty] = jitter(S, target, spread);
    g.tx = tx; g.ty = ty;
    fireDirect(S, g, tx, ty, 0);
    if (w.burst) { g.burst = w.burst - 1; g.burstAt = S.tick + w.burstGap; }
  } else if (w.kind === 'arc') {
    fireArc(S, g, jitter(S, target, spread));
    if (g.w === 'mortar' && 'spite' in p.upgrades && p.hp * 100 < REACTOR_HP * 30) fireArc(S, g, jitter(S, target, spread + FP));
  } else if (w.kind === 'missile') {
    for (let k = 0; k < w.count; k++) fireMissile(S, g, target, k);
  } else if (w.kind === 'chain') {
    chainZap(S, g, target);
  } else if (w.kind === 'flak') {
    for (let k = 0; k < w.pellets; k++) fireDirect(S, g, ...jitter(S, target, w.spread), 0);
  }
}

function jitter(S, [x, y], s) {
  if (!s) return [x, y];
  return [clamp(x + S.rng.range(-s, s), 0, W * FP - 1), clamp(y + S.rng.range(-s, s), 0, H * FP - 1)];
}

function fireDirect(S, g, tx, ty, spread) {
  const w = WEAPONS[g.w];
  if (spread) [tx, ty] = jitter(S, [tx, ty], spread);
  const sx = cellCenter(g.x), sy = cellCenter(g.y);
  let dx = tx - sx, dy = ty - sy;
  let d = isqrt(dx * dx + dy * dy);
  if (d < 16) { const f = S.players[g.owner].face; dx = f[0] * FP; dy = f[1] * FP || (f[0] ? 0 : FP); d = FP; }
  const q = {
    id: S.nextId++, owner: g.owner, w: g.w, k: 'direct', x: sx, y: sy,
    vx: idiv(dx * w.speed, d), vy: idiv(dy * w.speed, d),
    life: w.life, pierce: w.pierce || 0, hp: w.hp || 0, last: g.y * W + g.x, born: S.tick,
  };
  S.proj.push(q);
  ev(S, { e: 'shot', id: g.id, w: g.w });
}

function fireArc(S, g, [tx, ty]) {
  const w = WEAPONS[g.w];
  const sx = cellCenter(g.x), sy = cellCenter(g.y);
  const dx = tx - sx, dy = ty - sy;
  const d = isqrt(dx * dx + dy * dy);
  const T = clamp(idiv(d, w.speed), w.minT, w.maxT);
  S.proj.push({ id: S.nextId++, owner: g.owner, w: g.w, k: 'arc', x: sx, y: sy, sx, sy, tx, ty, t0: S.tick, T, hp: w.hp || 1 });
  ev(S, { e: 'shot', id: g.id, w: g.w });
}

function fireMissile(S, g, [tx, ty], k) {
  const w = WEAPONS[g.w];
  const sx = cellCenter(g.x), sy = cellCenter(g.y);
  const side = k % 2 === 0 ? 1 : -1;
  S.proj.push({
    id: S.nextId++, owner: g.owner, w: g.w, k: 'missile', x: sx, y: sy, tx, ty,
    vx: side * idiv(w.speed, 2), vy: -side * idiv(w.speed, 2), life: w.life, hp: w.hp, born: S.tick,
  });
  ev(S, { e: 'shot', id: g.id, w: g.w });
}

function beamTick(S, g, manual, auto) {
  const w = WEAPONS.cutter;
  const p = S.players[g.owner];
  if (g.over > S.tick) { g.beam = 0; return; }
  if (!manual && !auto) { g.heat = Math.max(0, g.heat - 2); g.beam = 0; return; }
  const target = manual ? p.aim : autoTarget(S, g);
  if (!target) return;
  g.heat += 1;
  if (g.heat >= w.heatMax) { g.over = S.tick + w.cool; g.heat = 0; g.beam = 0; ev(S, { e: 'overheat', id: g.id }); return; }
  g.beam = S.tick;
  const sx = cellCenter(g.x), sy = cellCenter(g.y);
  let dx = target[0] - sx, dy = target[1] - sy;
  const d = Math.max(1, isqrt(dx * dx + dy * dy));
  const stepX = idiv(dx * 64, d), stepY = idiv(dy * 64, d); // quarter-cell march
  let x = sx, y = sy, last = g.y * W + g.x;
  const maxSteps = w.range * 4;
  for (let s = 1; s <= maxSteps; s++) {
    x += stepX; y += stepY;
    const cx = Math.floor(x / FP), cy = Math.floor(y / FP);
    if (!inMap(cx, cy)) break;
    const i = cy * W + cx;
    if (i === last) continue;
    last = i;
    const dist = idiv(s, 4);
    const dmg = dist <= w.near ? w.dmg : w.dmgFar;
    const hit = solidAt(S, i, g.owner);
    if (hit) {
      if (hit !== 'prop' && (manual || S.tick % 2 === 0)) applyHit(S, i, hit, dmg, 'heat', g.owner, false);
      break;
    }
  }
  g.bx = x; g.by = y;
}

function chainZap(S, g, [tx, ty]) {
  const w = WEAPONS.welder;
  const gx = cellCenter(g.x), gy = cellCenter(g.y);
  const dx0 = tx - gx, dy0 = ty - gy;
  if (dx0 * dx0 + dy0 * dy0 > w.range * w.range) return;
  const hitCells = [];
  let cur = nearestEnemyCell(S, tx, ty, w.grab, g.owner, hitCells);
  let dmg = w.dmg;
  const path = [[gx, gy]];
  for (let j = 0; j <= w.jumps && cur !== null; j++) {
    hitCells.push(cur);
    const kind = solidAt(S, cur, g.owner);
    path.push([cellCenter(cur % W), cellCenter((cur / W) | 0)]);
    applyHit(S, cur, kind, dmg, 'electric', g.owner, false);
    if (kind === 'wall' && S.wKind[cur] === PIECE_IDS.indexOf('mesh')) break; // mesh soaks the chain
    if (kind === 'wall' && S.wHp[cur] <= 0 && false) break;
    dmg = idiv(dmg * w.jumpPct, 100);
    const [cx, cy] = path[path.length - 1];
    cur = nearestEnemyCell(S, cx, cy, w.jumpRange, g.owner, hitCells, true);
  }
  ev(S, { e: 'zap', id: g.id, path });
}

/** nearest enemy wall/gun/reactor cell to a point; prefers mesh when `preferMesh` */
function nearestEnemyCell(S, x, y, r, owner, exclude, preferMesh) {
  const c0x = Math.max(0, idiv(x - r, FP)), c1x = Math.min(W - 1, idiv(x + r, FP));
  const c0y = Math.max(0, idiv(y - r, FP)), c1y = Math.min(H - 1, idiv(y + r, FP));
  let best = null, bd = 0;
  const mesh = PIECE_IDS.indexOf('mesh');
  for (let cy = c0y; cy <= c1y; cy++)
    for (let cx = c0x; cx <= c1x; cx++) {
      const i = cy * W + cx;
      if (exclude.includes(i)) continue;
      const k = solidAt(S, i, owner);
      if (!k || k === 'prop') continue;
      const dx = cellCenter(cx) - x, dy = cellCenter(cy) - y;
      let d = dx * dx + dy * dy;
      if (d > r * r) continue;
      if (preferMesh && k === 'wall' && S.wKind[i] === mesh) d = -1;
      if (best === null || d < bd) { best = i; bd = d; }
    }
  return best;
}

/** what blocks a projectile from `owner` at cell i */
function solidAt(S, i, owner) {
  if (S.prop[i]) return 'prop';
  if (S.wHp[i] > 0 && S.wOwner[i] !== owner) return 'wall';
  const gid = S.gunAt[i];
  if (gid) { const g = gunById(S, gid); if (g && g.owner !== owner) return 'gun'; }
  const r = S.reactorAt[i];
  if (r >= 0 && r !== owner && S.players[r].alive) return 'reactor';
  return null;
}

function applyHit(S, i, kind, dmg, dtype, attacker, armorPierce) {
  if (kind === 'wall') return dmgWall(S, i, dmg, dtype, attacker, armorPierce);
  if (kind === 'gun') return dmgGun(S, gunById(S, S.gunAt[i]), dmg, dtype, attacker);
  if (kind === 'reactor') return dmgReactor(S, S.players[S.reactorAt[i]], dmg, attacker, false);
  return 0;
}

function flakIntercept(S, g) {
  const p = S.players[g.owner];
  if (!p.alive || g.stun > S.tick || S.tick < g.icd) return;
  const w = WEAPONS.flak;
  const gx = cellCenter(g.x), gy = cellCenter(g.y);
  let best = null, bd = 0;
  for (const q of S.proj) {
    if (q.owner === g.owner || !q.hp) continue;
    const dx = q.x - gx, dy = q.y - gy;
    const d = dx * dx + dy * dy;
    if (d <= w.intercept * w.intercept && (!best || d < bd)) { best = q; bd = d; }
  }
  if (!best) return;
  g.icd = S.tick + w.interceptReload;
  best.hp -= 1;
  ev(S, { e: 'flak', id: g.id, x: best.x, y: best.y });
  if (best.hp <= 0) killProj(S, best, 'intercepted');
}

function killProj(S, q, why) {
  const k = S.proj.indexOf(q);
  if (k >= 0) S.proj.splice(k, 1);
  ev(S, { e: 'pop', w: q.w, x: q.x, y: q.y, why });
}

// =============================================================== projectiles

function forkliftBlocks(S, x, y, attacker) {
  for (const p of S.players) {
    if (p.slot === attacker || !p.alive || !p.forklift) continue;
    const dx = x - (p.rx * FP + RHALF), dy = y - (p.ry * FP + RHALF);
    if (dx * dx + dy * dy <= (6 * HALF) * (6 * HALF)) {
      p.forklift = 0;
      ev(S, { e: 'forklift', s: p.slot, x, y });
      return true;
    }
  }
  return false;
}

function projTick(S) {
  for (const q of S.proj.slice()) {
    if (!S.proj.includes(q)) continue;
    if (q.k === 'arc') arcTick(S, q);
    else if (q.k === 'missile') missileTick(S, q);
    else directTick(S, q);
  }
}

function arcTick(S, q) {
  const k = S.tick - q.t0;
  q.x = q.sx + idiv((q.tx - q.sx) * k, q.T);
  q.y = q.sy + idiv((q.ty - q.sy) * k, q.T);
  q.z = idiv(4 * 6 * FP * k * (q.T - k), q.T * q.T); // peak ~6 cells, visual only
  if (k < q.T) return;
  land(S, q, q.tx, q.ty);
}

function land(S, q, x, y) {
  const w = WEAPONS[q.w];
  const k = S.proj.indexOf(q);
  if (k >= 0) S.proj.splice(k, 1);
  if (forkliftBlocks(S, x, y, q.owner)) return;
  ev(S, { e: 'boom', w: q.w, x, y, r: w.radius || w.radius });
  splash(S, x, y, w.radius, w.dmg, w.dtype, q.owner, { brittle: w.brittle });
  if (w.fire) S.fires.push({ x, y, r: w.radius, until: S.tick + w.fire, owner: q.owner, dmg: w.fireDmg });
}

function missileTick(S, q) {
  const w = WEAPONS.missile;
  q.life -= 1;
  const dx = q.tx - q.x, dy = q.ty - q.y;
  const d = isqrt(dx * dx + dy * dy);
  if (d <= 96 || q.life <= 0) return land(S, q, q.x, q.y);
  const ax = idiv(dx * w.speed, Math.max(1, d)), ay = idiv(dy * w.speed, Math.max(1, d));
  q.vx = idiv(q.vx * 3 + ax, 4);
  q.vy = idiv(q.vy * 3 + ay, 4);
  q.x += q.vx;
  q.y += q.vy;
  q.z = Math.min(3 * FP, (S.tick - q.born) * 40);
}

function directTick(S, q) {
  const w = WEAPONS[q.w];
  if (w.light && S.wind) q.vy += S.wind;
  q.life -= 1;
  if (q.life < 0) { killProj(S, q, 'fizzle'); return; }
  const steps = Math.max(1, Math.ceil(Math.max(Math.abs(q.vx), Math.abs(q.vy)) / 96));
  const x0 = q.x, y0 = q.y;
  for (let s = 1; s <= steps; s++) {
    q.x = x0 + idiv(q.vx * s, steps);
    q.y = y0 + idiv(q.vy * s, steps);
    if (q.x < 0 || q.y < 0 || q.x >= W * FP || q.y >= H * FP) { killProj(S, q, 'out'); return; }
    const i = Math.floor(q.y / FP) * W + Math.floor(q.x / FP);
    if (i === q.last) continue;
    q.last = i;
    const kind = solidAt(S, i, q.owner);
    if (!kind) continue;
    if (kind === 'prop') { killProj(S, q, 'clank'); return; }
    if (kind === 'reactor' && forkliftBlocks(S, q.x, q.y, q.owner)) { const k = S.proj.indexOf(q); if (k >= 0) S.proj.splice(k, 1); return; }
    applyHit(S, i, kind, w.dmg, w.dtype, q.owner, !!w.armorPierce);
    ev(S, { e: 'hit', w: q.w, x: q.x, y: q.y });
    if (q.w === 'emp') stunAround(S, q.x, q.y, w.stunRadius, w.stun, q.owner);
    if (q.w === 'wreck') splash(S, q.x, q.y, w.radius, w.splash, w.dtype, q.owner);
    if (kind !== 'reactor' && q.pierce > 0) { q.pierce -= 1; continue; }
    const k = S.proj.indexOf(q);
    if (k >= 0) S.proj.splice(k, 1);
    return;
  }
}

function stunAround(S, x, y, r, ticks, attacker) {
  for (const g of S.guns) {
    if (g.owner === attacker) continue;
    const dx = cellCenter(g.x) - x, dy = cellCenter(g.y) - y;
    if (dx * dx + dy * dy <= r * r) { g.stun = Math.max(g.stun, S.tick + ticks); ev(S, { e: 'stun', id: g.id }); }
  }
}

function firesTick(S) {
  if (!S.fires.length) return;
  for (const f of S.fires.slice()) {
    if (S.tick >= f.until) { S.fires.splice(S.fires.indexOf(f), 1); continue; }
    if ((S.tick - f.until) % 10 !== 0) continue;
    splashFlat(S, f);
  }
}
function splashFlat(S, f) {
  const c0x = Math.max(0, idiv(f.x - f.r, FP)), c1x = Math.min(W - 1, idiv(f.x + f.r, FP));
  const c0y = Math.max(0, idiv(f.y - f.r, FP)), c1y = Math.min(H - 1, idiv(f.y + f.r, FP));
  for (let cy = c0y; cy <= c1y; cy++)
    for (let cx = c0x; cx <= c1x; cx++) {
      const i = cy * W + cx;
      const dx = cellCenter(cx) - f.x, dy = cellCenter(cy) - f.y;
      if (dx * dx + dy * dy > f.r * f.r) continue;
      if (S.wHp[i] > 0 && S.wOwner[i] !== f.owner) dmgWall(S, i, f.dmg, 'heat', f.owner, false);
      const gid = S.gunAt[i];
      if (gid) { const g = gunById(S, gid); if (g && g.owner !== f.owner) dmgGun(S, g, f.dmg, 'heat', f.owner); }
    }
}

function hounds(S) {
  if (S.tick % 20 !== 0) return;
  for (const p of S.players) {
    if (!p.alive || !('hounds' in p.upgrades)) continue;
    let best = -1, gap = 0;
    for (let i = 0; i < N; i++) {
      if (S.wOwner[i] !== p.slot || S.wHp[i] <= 0) continue;
      const g = S.wMax[i] - S.wHp[i];
      if (g > gap) { gap = g; best = i; }
    }
    if (best >= 0) { S.wHp[best] += Math.min(15, gap); ev(S, { e: 'repair', s: p.slot, i: best, amt: Math.min(15, gap), hound: 1 }); }
  }
}

// ============================================================ arena helpers

function arenaApi(S) {
  return {
    announce(text) { ev(S, { e: 'announce', text }); },
    warn(text, x, y, r) { ev(S, { e: 'warn', text, x, y, r }); },
    surge(reactorDmg) {
      for (const g of S.guns) if (!gunEnclosed(S, g)) { g.stun = Math.max(g.stun, S.tick + 3 * TPS); ev(S, { e: 'stun', id: g.id }); }
      if (reactorDmg) for (const p of S.players) if (p.alive && !p.enclosed) dmgReactor(S, p, reactorDmg, -1, false);
      ev(S, { e: 'surge' });
    },
    envBlast(cx, cy, r, dmg) {
      const x = cellCenter(cx), y = cellCenter(cy);
      ev(S, { e: 'acid', x, y, r });
      const c0x = Math.max(0, idiv(x - r, FP)), c1x = Math.min(W - 1, idiv(x + r, FP));
      const c0y = Math.max(0, idiv(y - r, FP)), c1y = Math.min(H - 1, idiv(y + r, FP));
      for (let yy = c0y; yy <= c1y; yy++)
        for (let xx = c0x; xx <= c1x; xx++) {
          const i = yy * W + xx;
          const dx = cellCenter(xx) - x, dy = cellCenter(yy) - y;
          if (dx * dx + dy * dy > r * r) continue;
          if (S.wHp[i] > 0) dmgWall(S, i, dmg, 'kinetic', -1, true);
          const gid = S.gunAt[i];
          if (gid) dmgGun(S, gunById(S, gid), dmg, 'kinetic', -1);
        }
    },
  };
}

// ==================================================================== result

/** Base left = reactor HP + HP of every standing wall cell and turret. 0 when out. */
export function baseScore(S, p) {
  if (!p.alive) return 0;
  let s = p.hp;
  for (let i = 0; i < N; i++) if (S.wOwner[i] === p.slot && S.wHp[i] > 0) s += S.wHp[i];
  for (const g of S.guns) if (g.owner === p.slot) s += g.hp;
  return s;
}

function checkEnd(S) {
  if (S.phase === 'done' || S.phase === 'intro') return;
  const alive = S.players.filter((p) => p.alive).length;
  if (alive <= 1) finish(S);
}

export function ranking(S) {
  const rows = S.players.map((p) => ({
    slot: p.slot, alive: p.alive, base: baseScore(S, p), hp: p.hp, hpPrev: p.hpPrev, outTick: p.outTick,
    dr: p.dr, ds: p.ds, tb: p.tb,
  }));
  rows.sort((a, b) => {
    if (a.alive !== b.alive) return a.alive ? -1 : 1;
    if (a.alive) {
      if (a.base !== b.base) return b.base - a.base;
      if (a.hp !== b.hp) return b.hp - a.hp;
    } else {
      if (a.outTick !== b.outTick) return b.outTick - a.outTick;
      if (a.hpPrev !== b.hpPrev) return b.hpPrev - a.hpPrev;
    }
    if (a.dr !== b.dr) return b.dr - a.dr;
    if (a.ds !== b.ds) return b.ds - a.ds;
    if (a.tb !== b.tb) return b.tb - a.tb;
    return a.slot - b.slot;
  });
  return rows;
}

function finish(S) {
  if (S.phase === 'done') return;
  if (S.dirtyEncl) recomputeEnclosure(S);
  S.phase = 'done';
  S.phaseStart = S.tick;
  S.phaseEnd = S.tick;
  S.proj = [];
  const rank = ranking(S);
  S.result = { winner: rank[0].slot, rank, tick: S.tick, hash: hashState(S) };
  ev(S, { e: 'phase', phase: 'done', cycle: S.cycle });
  ev(S, { e: 'result', winner: rank[0].slot, rank });
}

// ====================================================================== hash

export function hashState(S) {
  const h = hasher();
  h.int(S.v).str(S.arenaId).int(S.tick).str(S.phase).int(S.cycle).int(S.phaseEnd).arr(S.rng.s);
  for (const p of S.players) {
    h.int(p.hp).int(p.alive ? 1 : 0).int(p.scrap).int(p.credits).int(p.creditAcc).int(p.dr).int(p.ds)
      .int(p.enclosed ? 1 : 0).int(p.territory).int(p.target).int(p.outTick).arr(p.aim).int(p.firing ? 1 : 0).int(p.active)
      .str(Object.keys(p.upgrades).sort().join(',')).str(p.offer.join(','));
  }
  h.arr(S.wOwner).arr(S.wHp).arr(S.wKind).arr(S.prop);
  for (const g of S.guns) h.int(g.id).str(g.w).int(g.x).int(g.y).int(g.hp).int(g.ready).int(g.stun).int(g.heat);
  for (const q of S.proj) h.int(q.id).int(q.x).int(q.y).int(q.hp || 0);
  for (const f of S.fires) h.int(f.x).int(f.y).int(f.until);
  return h.value();
}

// ==================================================================== replay

/**
 * Re-run a whole match from its evidence: cfg + list of [tick, slot, action].
 * Inputs for tick t are applied before step() advances from t to t+1.
 */
export function replay(cfg, log, opts = {}) {
  const S = createMatch(cfg);
  let k = 0;
  const maxTicks = opts.maxTicks || 20 * 60 * 10;
  while (S.phase !== 'done' && S.tick < maxTicks) {
    while (k < log.length && log[k][0] === S.tick) {
      applyInput(S, log[k][1], log[k][2]);
      k++;
    }
    if (k < log.length && log[k][0] < S.tick) throw new Error('evidence out of order at ' + k);
    S.events.length = 0;
    step(S);
  }
  return S;
}

export { ARENA_IDS, W, H, FP, TPS };
