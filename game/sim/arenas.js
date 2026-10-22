// The five launch arenas. Each one adds a single telegraphed hazard that runs
// during FIRE plus a TWIST at 15 s. Arenas only use integer maths and the
// simulation RNG, and every layout is mirror-symmetric so all yards are equal.
import { W, H, TPS } from './rules.js';

export const PROP = { none: 0, crate: 1, boom: 2, core: 3, vat: 4, container: 5, pillar: 6, vent: 7, bollard: 8 };

const TWIST_AT = 15 * TPS;
const WARN = 2 * TPS;

// helpers -----------------------------------------------------------------
function setProp(S, x, y, kind) {
  if (x < 0 || y < 0 || x >= W || y >= H) return;
  const i = y * W + x;
  if (S.yardOf[i] >= 0) return; // never inside a yard
  S.prop[i] = kind;
}
/** place a prop at (x,y) and at all its mirror images (left/right and top/bottom) */
function mirror4(S, x, y, kind) {
  setProp(S, x, y, kind);
  setProp(S, W - 1 - x, y, kind);
  setProp(S, x, H - 1 - y, kind);
  setProp(S, W - 1 - x, H - 1 - y, kind);
}
function clearKind(S, kind) {
  for (let i = 0; i < S.prop.length; i++) if (S.prop[i] === kind) S.prop[i] = 0;
}

// -------------------------------------------------------------------------
export const ARENAS = [
  {
    id: 'rustdock',
    name: 'The Rust Dock',
    blurb: 'Corroded gantries and a cargo crane that never stops. Its boom eats flat shots.',
    hazard: 'Crane boom sweeps the field and blocks direct fire.',
    twist: 'TWIST: Crane drops cargo containers into the field.',
    palette: 'rust',
    init(S) {
      for (const [x, y] of [[16, 3], [19, 7], [15, 12], [20, 13]]) mirror4(S, x, y, PROP.bollard);
      S.arena = { boomX: 15, boomDir: 1, dropX: 0, dropY: 0, dropped: 0 };
    },
    fire(S, f, api) {
      const a = S.arena;
      if (f % 8 === 0) {
        clearKind(S, PROP.boom);
        a.boomX += a.boomDir;
        if (a.boomX >= 28 || a.boomX <= 15) a.boomDir = -a.boomDir;
        for (let y = 9; y <= 20; y++) setProp(S, a.boomX, y, PROP.boom);
      }
      if (f === TWIST_AT - WARN && !a.dropped) {
        a.dropX = 16 + S.rng.int(5);
        a.dropY = 4 + S.rng.int(6);
        api.warn('Cargo drop incoming', a.dropX, a.dropY, 2);
        api.warn('Cargo drop incoming', W - 2 - a.dropX, H - 1 - a.dropY, 2);
      }
      if (f === TWIST_AT && !a.dropped) {
        a.dropped = 1;
        api.announce(this.twist);
        for (const [x, y] of [[a.dropX, a.dropY], [W - 2 - a.dropX, H - 1 - a.dropY]]) {
          setProp(S, x, y, PROP.container);
          setProp(S, x + 1, y, PROP.container);
        }
      }
    },
    endFire(S) {
      clearKind(S, PROP.boom);
    },
  },
  {
    id: 'graveyard',
    name: 'Reactor Graveyard',
    blurb: 'Decommissioned cores leak. Radiation surges knock out any turret left outside a wall.',
    hazard: 'Radiation surges stun turrets that are not enclosed.',
    twist: 'TWIST: Surges speed up and burn naked reactors.',
    palette: 'green',
    init(S) {
      for (const [x, y] of [[17, 4], [20, 10]]) {
        mirror4(S, x, y, PROP.core); mirror4(S, x + 1, y, PROP.core);
        mirror4(S, x, y + 1, PROP.core); mirror4(S, x + 1, y + 1, PROP.core);
      }
      S.arena = { next: 100 };
    },
    fire(S, f, api) {
      const a = S.arena;
      if (f === a.next - WARN) api.announce('Radiation surge in 2 s. Get your guns behind a wall.');
      if (f === a.next) {
        api.surge(f >= TWIST_AT ? 40 : 0);
        a.next += f >= TWIST_AT ? 120 : 180;
      }
      if (f === TWIST_AT) api.announce(this.twist);
    },
    endFire(S) {
      S.arena.next = 100;
    },
  },
  {
    id: 'freightliner',
    name: 'Freightliner Nine',
    blurb: 'A container maze on a colossal cargo deck. The stacks slide and firing lanes open and shut.',
    hazard: 'Sliding container rows block direct fire.',
    twist: 'TWIST: The deck crew panics. Containers slide twice as fast.',
    palette: 'blue',
    init(S) {
      S.arena = { shift: 0 };
      this.layout(S);
    },
    layout(S) {
      clearKind(S, PROP.container);
      const a = S.arena;
      // three rows in the top half, mirrored left↔right and top↔bottom so every yard sees the same lanes
      [4, 9, 14].forEach((y, r) => {
        for (let k = 0; k < 8; k++) {
          const phase = (((k - a.shift + r * 2) % 5) + 5) % 5; // 3 on, 2 off, sliding outward
          if (phase < 3) mirror4(S, 14 + k, y, PROP.container);
        }
      });
    },
    fire(S, f, api) {
      const every = f >= TWIST_AT ? 15 : 30;
      if (f > 0 && f % every === 0) {
        S.arena.shift += 1;
        this.layout(S);
      }
      if (f === TWIST_AT) api.announce(this.twist);
    },
    endFire() {},
  },
  {
    id: 'refinery',
    name: 'The Acid Refinery',
    blurb: 'Yellow-green vats and corroded vents. Acid bursts eat any wall built too close.',
    hazard: 'Vents in every yard burst acid on nearby walls and turrets.',
    twist: 'TWIST: Pressure spike. Vents burst twice as often.',
    palette: 'acid',
    init(S) {
      for (const [x, y] of [[17, 5], [21, 11], [17, 13]]) mirror4(S, x, y, PROP.vat);
      // two vents per yard, mirrored by yard orientation
      S.vents = [];
      for (const p of S.players) {
        const flipX = p.face[0] < 0 ? 1 : 0, flipY = p.face[1] < 0 ? 1 : 0;
        for (const [lx, ly] of [[2, 2], [8, 9]]) {
          const x = p.yard[0] + (flipX ? 11 - lx : lx);
          const y = p.yard[1] + (flipY ? 11 - ly : ly);
          S.vents.push(y * W + x);
          S.ventCell[y * W + x] = 1;
        }
      }
      S.arena = { next: 120 };
    },
    fire(S, f, api) {
      const a = S.arena;
      if (f === a.next - WARN) for (const v of S.vents) api.warn('Vent pressure', v % W, Math.floor(v / W), 2);
      if (f === a.next) {
        for (const v of S.vents) api.envBlast(v % W, Math.floor(v / W), 384, 45);
        a.next += f >= TWIST_AT ? 80 : 160;
      }
      if (f === TWIST_AT) api.announce(this.twist);
    },
    endFire(S) {
      S.arena.next = 120;
    },
  },
  {
    id: 'vacuum',
    name: 'Vacuum Bay 6',
    blurb: 'An airlock bay that keeps decompressing. Light rounds drift toward whichever vent is open.',
    hazard: 'Decompression pulls light projectiles toward the open vent.',
    twist: 'TWIST: Seals failing. Vents alternate and the pull doubles.',
    palette: 'cold',
    init(S) {
      for (const [x, y] of [[18, 6], [21, 2], [16, 11]]) mirror4(S, x, y, PROP.pillar);
      S.arena = { next: 80, open: 0, until: 0, side: 1, pull: 0 };
    },
    fire(S, f, api) {
      const a = S.arena;
      if (f === TWIST_AT) api.announce(this.twist);
      if (f === a.next - WARN) {
        a.side = f >= TWIST_AT ? -a.side : S.rng.int(2) ? 1 : -1;
        api.announce(a.side > 0 ? 'Decompression: south vent opening' : 'Decompression: north vent opening');
      }
      if (f === a.next) {
        a.open = a.side;
        a.until = f + 80;
        a.next += f >= TWIST_AT ? 120 : 200;
      }
      if (a.open && f >= a.until) a.open = 0;
      S.wind = a.open ? a.open * (f >= TWIST_AT ? 10 : 5) : 0;
    },
    endFire(S) {
      S.arena.open = 0;
      S.arena.next = 80;
      S.wind = 0;
    },
  },
];

export const ARENA_IDS = ARENAS.map((a) => a.id); // append-only: ids are stored with match results
export const arenaById = (id) => ARENAS.find((a) => a.id === id) || ARENAS[0];
