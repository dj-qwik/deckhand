// DECKHAND rules data. Every number the simulation uses lives here so balance
// changes are one-line edits. All distances are in FP units (1 cell = 256).

export const W = 48;
export const H = 34;
export const FP = 256;
export const HALF = 128;
export const TPS = 20; // authoritative ticks per second

// Match structure: two cycles of BUILD (weld → arm) followed by a 30 s FIRE.
export const CYCLES = 2;
export const DUR = {
  intro: 4 * TPS,
  weld: 20 * TPS,
  arm: 8 * TPS,
  fire: 30 * TPS,
  cease: 1 * TPS, // projectiles in flight finish; no new shots
};
export const PHASES = ['intro', 'weld', 'arm', 'fire', 'cease', 'done'];

// Winner: most BASE left after two rounds. Base = reactor HP + HP of every wall
// cell and turret still standing. A destroyed reactor = out, whatever else stands.
// Ties: reactor HP, then damage dealt to enemy reactors, then total damage dealt,
// then a seeded draw.
export const YARD = 14;
export const RS = 3; // reactor footprint is RS × RS cells
export const RHALF = (RS * 256) / 2; // FP offset from reactor corner to its centre
export const REACTOR_HP = 1000;
export const ENCLOSED_SPLASH_MULT = 30; // % of splash an enclosed reactor takes (70% mitigation)
export const AUTO_DELAY = Math.round(1.5 * TPS); // auto turrets wait this long into FIRE
export const AUTO_RELOAD_PCT = 160; // auto-fire reload is 1.6× slower than manual
export const AUTO_SPREAD_PCT = 250;
export const MAX_GUNS = 4;
export const BASE_GUNS = 2; // turret cap = BASE_GUNS + enclosed floor / TERRITORY_PER_GUN, up to MAX_GUNS
export const TERRITORY_PER_GUN = 24;
export const TERRITORY_PER_SCRAP = 8; // bonus scrap per this many enclosed cells at the next build round
export const GUN_HP = 220;

// Yard origins (top-left cell) by player count. Yards sit on the map edge.
// Seats are assigned to yards by the hidden match seed, so nobody picks a corner.
export const YARDS = {
  2: [[1, 10], [33, 10]],
  3: [[1, 1], [33, 1], [1, 19], [33, 19]], // three of the four corners; the empty one is seeded
  4: [[1, 1], [33, 1], [1, 19], [33, 19]],
};

export const ECON = {
  scrapStart: 42,
  scrapPerCycle: 20,
  scrapCap: 46,
  creditsStart: 5,
  creditPerDamage: 80, // 1 credit per this much damage dealt
  creditCap: 15,
  repairWallHp: 45, // per scrap
  repairReactorHp: 25, // per scrap
  repairReactorCapPerCycle: 100,
  undoDepth: 3,
  sellRefundPct: 50,
};

// ---------------------------------------------------------------- materials
// damage multipliers (percent) by material × damage type
export const MATERIALS = {
  steel: { kinetic: 100, explosive: 100, heat: 120, electric: 100, cryo: 100, emp: 20 },
  heavy: { kinetic: 55, explosive: 70, heat: 100, electric: 100, cryo: 100, emp: 20 },
  shutter: { kinetic: 50, explosive: 90, heat: 100, electric: 100, cryo: 100, emp: 20 },
  mesh: { kinetic: 110, explosive: 150, heat: 100, electric: 25, cryo: 100, emp: 20 },
  foam: { kinetic: 200, explosive: 120, heat: 150, electric: 100, cryo: 100, emp: 20 },
};

// ------------------------------------------------------------------- pieces
// cells are [dx, dy] at rotation 0; rotation turns 90° clockwise about the origin.
export const PIECES = {
  brace: { name: 'Straight brace', cells: [[0, 0], [1, 0], [2, 0]], cost: 3, hp: 180, mat: 'steel', key: '1' },
  lbrace: { name: 'L-brace', cells: [[0, 0], [0, 1], [1, 1]], cost: 3, hp: 160, mat: 'steel', key: '2' },
  tjunc: { name: 'T-junction', cells: [[0, 0], [1, 0], [2, 0], [1, 1]], cost: 5, hp: 200, mat: 'steel', key: '3' },
  bulkhead: { name: 'Heavy bulkhead', cells: [[0, 0], [1, 0], [0, 1], [1, 1]], cost: 6, hp: 350, mat: 'heavy', key: '4' },
  shutter: { name: 'Blast shutter', cells: [[0, 0], [1, 0]], cost: 4, hp: 220, mat: 'shutter', key: '5' },
  mesh: { name: 'Conductive mesh', cells: [[0, 0], [1, 0], [2, 0]], cost: 4, hp: 120, mat: 'mesh', key: '6' },
  foam: { name: 'Foam seal', cells: [[0, 0]], cost: 1, hp: 65, mat: 'foam', key: '7' },
  collar: { name: 'Reactor collar', cells: null, cost: 10, hp: 120, mat: 'steel', key: '8' }, // ring around reactor
};
export const PIECE_IDS = Object.keys(PIECES);

export function pieceCells(id, rot) {
  const p = PIECES[id];
  if (!p || !p.cells) return null;
  return p.cells.map(([x, y]) => {
    let a = x, b = y;
    for (let r = 0; r < (rot & 3); r++) [a, b] = [-b, a];
    return [a, b];
  });
}

// ------------------------------------------------------------------ weapons
// kind: direct (travels flat, hits first enemy solid), arc (lobs over walls,
// splashes on landing), beam (continuous line), chain (instant arc welder),
// missile (guided, flies high), flak (anti-projectile + pellet cone)
const c = (x) => Math.round(x * 256);
export const WEAPONS = {
  rivet: {
    name: 'Rivet Spitter', kind: 'direct', cost: 6, dmg: 40, dtype: 'kinetic', speed: c(1.1), reload: 30,
    burst: 3, burstGap: 3, spread: c(0.3), life: 60, prio: 'reactor', light: true,
    blurb: 'Fast 3-round burst. Shreds foam, sulks at bulkheads.',
  },
  harpoon: {
    name: 'Coil Harpoon', kind: 'direct', cost: 10, dmg: 120, dtype: 'kinetic', speed: c(1.6), reload: 80,
    pierce: 2, spread: c(0.1), life: 40, prio: 'reactor', light: true,
    blurb: 'Piercing spike. Punches through two wall cells.',
  },
  cutter: {
    name: 'Plasma Cutter', kind: 'beam', cost: 9, dmg: 12, dmgFar: 6, near: 10, range: 24, dtype: 'heat',
    heatMax: 60, cool: 40, exposePct: 150, prio: 'reactor',
    blurb: 'Continuous cutting arc. Overheats; socket takes extra damage while firing.',
  },
  mortar: {
    name: 'Scrap Mortar', kind: 'arc', cost: 6, dmg: 140, radius: c(1.6), dtype: 'explosive', speed: c(0.55),
    reload: 60, spread: c(0.35), minT: 22, maxT: 46, hp: 1, prio: 'reactor',
    blurb: 'Lobs over walls. Splash. Can be shot down.',
  },
  rail: {
    name: 'Mag-Rail Lance', kind: 'direct', cost: 14, dmg: 260, dtype: 'kinetic', speed: c(2.4), reload: 120,
    windup: 40, pierce: 1, armorPierce: true, spread: 0, life: 30, prio: 'reactor',
    blurb: 'Two-second windup, then a precise armour-piercing slug.',
  },
  flak: {
    name: 'Forklift Flak', kind: 'flak', cost: 8, dmg: 14, dtype: 'kinetic', speed: c(1.2), reload: 26, pellets: 6,
    spread: c(1.2), life: 11, intercept: c(6), interceptReload: 12, prio: 'intercept', light: true,
    blurb: 'Auto-shoots down shells and missiles near your yard. Weak vs walls.',
  },
  cryo: {
    name: 'Cryo Slag Cannon', kind: 'arc', cost: 9, dmg: 40, radius: c(1.8), dtype: 'cryo', speed: c(0.55), reload: 70,
    spread: c(0.35), minT: 22, maxT: 46, hp: 1, brittle: 120, prio: 'reactor',
    blurb: 'Makes structures brittle: kinetic and explosive hits deal +60%.',
  },
  emp: {
    name: 'EMP Nailgun', kind: 'direct', cost: 8, dmg: 15, dtype: 'emp', speed: c(1.4), reload: 50, spread: c(0.2),
    life: 40, stun: 80, stunRadius: c(2), prio: 'guns', light: true,
    blurb: 'Knocks out turrets near the impact for 4 seconds.',
  },
  incin: {
    name: 'Incinerator Drum', kind: 'arc', cost: 9, dmg: 30, radius: c(1.5), dtype: 'heat', speed: c(0.55), reload: 80,
    spread: c(0.4), minT: 22, maxT: 46, hp: 1, fire: 120, fireDmg: 18, prio: 'reactor',
    blurb: 'Burning slag. Blocks repairs and building where it lands.',
  },
  wreck: {
    name: 'Wrecking Ball Launcher', kind: 'direct', cost: 12, dmg: 300, splash: 150, radius: c(1.2), dtype: 'explosive',
    speed: c(0.4), reload: 140, spread: c(0.2), life: 120, hp: 3, prio: 'reactor',
    blurb: 'Huge slow demolition ball. Flak can stop it.',
  },
  welder: {
    name: 'Arc Welder Array', kind: 'chain', cost: 11, dmg: 70, dtype: 'electric', reload: 70, jumps: 3, jumpPct: 75,
    jumpRange: c(2.5), grab: c(1.5), range: c(30), prio: 'reactor',
    blurb: 'Chain lightning. Conductive mesh soaks it up.',
  },
  missile: {
    name: 'Salvage Missile Rack', kind: 'missile', cost: 12, dmg: 110, radius: c(1.1), dtype: 'explosive',
    speed: c(0.6), reload: 150, count: 2, hp: 1, life: 140, prio: 'reactor',
    blurb: 'Two guided missiles. Flak or a vent can stop them.',
  },
};
export const WEAPON_IDS = Object.keys(WEAPONS);

// ----------------------------------------------------------------- upgrades
export const UPGRADES = {
  printer: { name: 'Emergency Bulkhead Printer', cost: 3, uses: 2, active: true, blurb: 'During FIRE: drop a foam seal anywhere in your yard. 2 per cycle.' },
  armor: { name: 'Union-Grade Armor', cost: 5, blurb: 'Your walls take 20% less explosive damage.' },
  capacitor: { name: 'Questionable Capacitor', cost: 3, uses: 1, active: true, blurb: 'Guns reload 30% faster for 8 s, then each takes 10% self-damage.' },
  crane: { name: 'Magnet Crane', cost: 3, uses: 3, active: true, blurb: 'During WELD: drag a wall cell one tile, keeping its HP. 3 per cycle.' },
  hounds: { name: 'Salvage Hounds', cost: 4, blurb: 'Drones patch your most damaged wall during FIRE and salvage scrap from losses.' },
  forklift: { name: 'Forklift of Doom', cost: 4, blurb: 'Once per cycle, blocks the first shot that would land on your reactor.' },
  spite: { name: 'Spite Protocol', cost: 3, blurb: 'Below 30% reactor, every mortar fires two shells.' },
  coffee: { name: 'Coffee-Fueled Crew', cost: 3, blurb: '+6 scrap at the start of each build round.' },
  warranty: { name: 'Corporate Warranty', cost: 5, blurb: 'Once per match, a lethal reactor hit leaves 1 HP. CLAIM DENIED.' },
  vent: { name: 'Overpressure Vent', cost: 4, uses: 1, active: true, blurb: 'During FIRE: blast every hostile projectile within 4 cells of your reactor.' },
  dirty: { name: 'Dirty Tricks Relay', cost: 3, uses: 1, active: true, blurb: 'During FIRE: scramble an enemy turret for 3 s.' },
  paycheck: { name: 'Final Paycheck', cost: 4, blurb: 'Final FIRE round: if your reactor is enclosed, guns reload 15% faster.' },
};
export const UPGRADE_IDS = Object.keys(UPGRADES);
