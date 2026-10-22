// Practice-yard AI. Bots produce ordinary inputs (logged like a human's), so they
// never touch simulation internals except to read state. They use their own RNG.
import { W, H, FP, HALF, YARD, PIECES, WEAPONS, UPGRADES, MAX_GUNS, REACTOR_HP } from './rules.js';
import { checkPlacement, placementCells, gunEnclosed, gunCap } from './sim.js';
import { makeRng } from './util.js';

const cc = (c) => c * FP + HALF;

/**
 * style: 'normal' (default), 'idle', 'turtle' (builds, never aims), 'gunner'
 * (never builds walls, buys guns, aims), 'lazyaim' (builds, aims straight at a
 * reactor with no breach logic).
 * skill 0..1 shapes reaction time and aim error.
 */
export function makeBot(slot, opts = {}) {
  return {
    slot,
    style: opts.style || 'normal',
    skill: opts.skill ?? 0.7,
    rng: makeRng([0xb07 + slot * 977, opts.seed || 7, 0x51ab, 0x77 + slot]),
    next: 0,
    lastAim: 0,
    target: -1,
  };
}

export function botThink(S, bot) {
  const p = S.players[bot.slot];
  if (!p.alive || S.phase === 'done' || S.phase === 'intro' || bot.style === 'idle') return [];
  if (S.tick < bot.next) return [];
  const slow = Math.round(2 + (1 - bot.skill) * 10);
  bot.next = S.tick + slow + bot.rng.int(4);
  if (S.phase === 'weld') return weld(S, bot, p);
  if (S.phase === 'arm') return arm(S, bot, p);
  if (S.phase === 'fire') return fire(S, bot, p);
  return [];
}

// ---------------------------------------------------------------- building

function perimeter(S, p) {
  const [yx, yy] = p.yard;
  let bx0 = p.rx - 1, by0 = p.ry - 1, bx1 = p.rx + 2, by1 = p.ry + 2;
  for (const g of S.guns) if (g.owner === p.slot) {
    bx0 = Math.min(bx0, g.x); by0 = Math.min(by0, g.y); bx1 = Math.max(bx1, g.x); by1 = Math.max(by1, g.y);
  }
  // try a few margins and keep the first ring whose cells are all buildable (vents, props…)
  let first = null;
  for (const m of [2, 1, 3, 4]) {
    const x0 = Math.max(yx, bx0 - m), y0 = Math.max(yy, by0 - m);
    const x1 = Math.min(yx + YARD - 1, bx1 + m), y1 = Math.min(yy + YARD - 1, by1 + m);
    const cells = [];
    for (let x = x0; x <= x1; x++) { cells.push([x, y0]); cells.push([x, y1]); }
    for (let y = y0 + 1; y < y1; y++) { cells.push([x0, y]); cells.push([x1, y]); }
    const ring = { cells, x0, y0, x1, y1 };
    if (!first) first = ring;
    const ok = cells.every(([x, y]) => {
      const i = y * W + x;
      return !S.ventCell[i] && !S.prop[i] && !S.gunAt[i] && S.reactorAt[i] < 0;
    });
    if (ok) return ring;
  }
  return first;
}

const own = (S, p, x, y) => S.wOwner[y * W + x] === p.slot && S.wHp[y * W + x] > 0;

function weld(S, bot, p) {
  if (bot.style === 'gunner') return [];
  const reserve = bot.style === 'turtle' ? 0 : 7;
  const per = perimeter(S, p);
  const gaps = per.cells.filter(([x, y]) => !own(S, p, x, y));
  const gapSet = new Set(gaps.map(([x, y]) => y * W + x));
  if (gaps.length && p.scrap > Math.min(reserve, 3)) {
    // prefer a brace that covers three gap cells, else foam
    for (const [x, y] of gaps) {
      for (const rot of [0, 1]) for (const off of [0, -1, -2]) {
        const sx = rot === 0 ? x + off : x, sy = rot === 0 ? y : y + off;
        if (checkPlacement(S, p.slot, 'brace', sx, sy, rot)) continue;
        const cells = placementCells(S, p.slot, 'brace', sx, sy, rot);
        if (cells.every((i) => gapSet.has(i)) && p.scrap - 3 >= reserve - 4) return [{ t: 'place', piece: 'brace', x: sx, y: sy, rot }];
      }
    }
    for (const [x, y] of gaps) if (!checkPlacement(S, p.slot, 'foam', x, y, 0)) return [{ t: 'place', piece: 'foam', x, y, rot: 0 }];
  }
  // repairs: reactor first, then the most damaged wall
  if (p.scrap > reserve) {
    if (p.hp < REACTOR_HP && p.repairedReactor < 100) return [{ t: 'repair', x: p.rx, y: p.ry }];
    let best = -1, ratio = 1;
    for (let i = 0; i < W * H; i++) {
      if (S.wOwner[i] !== p.slot || S.wHp[i] <= 0) continue;
      const r = S.wHp[i] / S.wMax[i];
      if (r < ratio - 0.05) { ratio = r; best = i; }
    }
    if (best >= 0 && ratio < 0.8) return [{ t: 'repair', x: best % W, y: (best / W) | 0 }];
  }
  return research(S, bot, p);
}

function research(S, bot, p) {
  if (p.boughtThisCycle || !p.offer.length) return [];
  const pick = p.offer.filter((id) => UPGRADES[id].cost <= p.credits);
  if (!pick.length) return [];
  return [{ t: 'research', id: pick[bot.rng.int(pick.length)] }];
}

const BUY_ORDER = ['harpoon', 'flak', 'missile', 'rail', 'cryo', 'welder', 'wreck', 'emp', 'incin', 'rivet', 'mortar'];

function arm(S, bot, p) {
  const r = research(S, bot, p);
  if (r.length) return r;
  if (bot.style === 'turtle') return [];
  const mine = S.guns.filter((g) => g.owner === p.slot);
  if (mine.length >= gunCap(p)) return [];
  const per = perimeter(S, p);
  const options = BUY_ORDER.filter((w) => WEAPONS[w].cost <= p.scrap && !mine.some((g) => g.w === w));
  if (!options.length) return [];
  const w = options[bot.rng.int(Math.min(3, options.length))];
  // free interior cell nearest the front of the yard
  let best = null, bd = 1e9;
  for (let y = per.y0 + 1; y < per.y1; y++)
    for (let x = per.x0 + 1; x < per.x1; x++) {
      const i = y * W + x;
      if (S.wHp[i] > 0 || S.gunAt[i] || S.reactorAt[i] >= 0 || S.ventCell[i] || S.prop[i] || S.outside[i]) continue;
      const [fx, fy] = p.face;
      const d = fx > 0 ? per.x1 - x : fx < 0 ? x - per.x0 : fy > 0 ? per.y1 - y : y - per.y0;
      if (d < bd) { bd = d; best = [x, y]; }
    }
  if (!best && bot.style === 'gunner') {
    for (let k = 0; k < 40 && !best; k++) {
      const x = p.yard[0] + bot.rng.int(YARD), y = p.yard[1] + bot.rng.int(YARD);
      const i = y * W + x;
      if (!(S.wHp[i] > 0 || S.gunAt[i] || S.reactorAt[i] >= 0 || S.ventCell[i] || S.prop[i] || S.outside[i])) best = [x, y];
    }
  }
  if (!best) return [];
  return [{ t: 'buyGun', w, x: best[0], y: best[1] }];
}

// ----------------------------------------------------------------- firing

function fire(S, bot, p) {
  const out = [];
  if (bot.style === 'turtle') return p.firing ? [{ t: 'fire', on: false }] : [];
  const mine = S.guns.filter((g) => g.owner === p.slot);
  if (!mine.length) return [];
  // manual gun: the hardest hitter that is not flak
  const pref = ['rail', 'harpoon', 'wreck', 'rivet', 'cutter', 'emp', 'welder', 'missile', 'mortar', 'cryo', 'incin'];
  const pick = pref.map((w) => mine.find((g) => g.w === w)).find(Boolean) || mine[0];
  if (p.active !== pick.id) out.push({ t: 'active', id: pick.id });

  const foes = S.players.filter((q) => q.slot !== p.slot && q.alive);
  if (!foes.length) return out;
  // manual gun focuses the weakest reactor; ties broken by the bot's own dice
  let tgt = foes.find((q) => q.slot === bot.target);
  if (!tgt || bot.rng.int(40) === 0) {
    const low = Math.min(...foes.map((q) => q.hp));
    const pool = foes.filter((q) => q.hp - low < 60);
    tgt = pool[bot.rng.int(pool.length)];
    bot.target = tgt.slot;
  }
  let ax = tgt.rx * FP + FP, ay = tgt.ry * FP + FP;
  if (bot.style !== 'lazyaim' && WEAPONS[pick.w].kind === 'direct') {
    // breach logic: aim at the weakest enemy wall cell on the way in
    const gx = cc(pick.x), gy = cc(pick.y);
    let best = null, bh = 1e9;
    for (let s = 1; s < 120; s++) {
      const x = gx + Math.trunc(((ax - gx) * s) / 120), y = gy + Math.trunc(((ay - gy) * s) / 120);
      const i = Math.floor(y / FP) * W + Math.floor(x / FP);
      if (S.wOwner[i] === tgt.slot && S.wHp[i] > 0 && S.wHp[i] < bh) { bh = S.wHp[i]; best = [x, y]; break; }
    }
    if (best && !tgt.enclosed) best = null; // already open: go for the reactor
    if (best) [ax, ay] = best;
  }
  const err = Math.round((1 - bot.skill) * 2.2 * FP);
  ax += bot.rng.range(-err, err);
  ay += bot.rng.range(-err, err);
  ax = Math.max(0, Math.min(W * FP - 1, ax));
  ay = Math.max(0, Math.min(H * FP - 1, ay));
  out.push({ t: 'aim', x: ax, y: ay });
  if (!p.firing) out.push({ t: 'fire', on: true });

  // abilities
  if (p.upgrades.vent > 0 && S.proj.some((q) => q.owner !== p.slot && Math.abs(q.x - (p.rx * FP + FP)) < 3 * FP && Math.abs(q.y - (p.ry * FP + FP)) < 3 * FP))
    out.push({ t: 'ability', id: 'vent' });
  if (p.upgrades.capacitor > 0 && bot.rng.int(10) === 0) out.push({ t: 'ability', id: 'capacitor' });
  if (p.upgrades.dirty > 0) {
    const g = S.guns.find((q) => q.owner === tgt.slot);
    if (g) out.push({ t: 'ability', id: 'dirty', x: g.x, y: g.y });
  }
  if (p.upgrades.printer > 0 && !p.enclosed) {
    const per = perimeter(S, p);
    const gap = per.cells.find(([x, y]) => !own(S, p, x, y) && !checkPlacementFoamFire(S, p, x, y));
    if (gap) out.push({ t: 'ability', id: 'printer', x: gap[0], y: gap[1] });
  }
  return out;
}

function checkPlacementFoamFire(S, p, x, y) {
  const i = y * W + x;
  return S.wHp[i] > 0 || S.prop[i] || S.ventCell[i] || S.reactorAt[i] >= 0 || S.gunAt[i] || S.yardOf[i] !== p.slot;
}

export { gunEnclosed };
