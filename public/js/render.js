// 2.5D tactical diorama renderer (Canvas 2D). Draws the authoritative state the
// server streams; it never decides anything about the game.
import { W, H, FP, PIECE_IDS, PIECES, WEAPONS } from '/sim/rules.js';
import { PROP } from '/sim/arenas.js';

export const PCOL = ['#3fc1b4', '#f08a3a', '#d65fb8', '#e6cf45'];
export const PNAME_COL = ['Teal', 'Orange', 'Magenta', 'Yellow'];
const K = 0.66; // vertical squash of the ground plane
const Z = 0.62; // screen pixels per unit height (× cell size)
const MAT_H = { steel: 0.95, heavy: 1.25, shutter: 1.05, mesh: 0.75, foam: 0.55 };
const ARENA_LOOK = {
  rustdock: { floor: '#22292a', field: '#262321', accent: '#b0552f', haze: 'rgba(180,90,40,0.05)' },
  graveyard: { floor: '#1f2826', field: '#1d2622', accent: '#7bcf6a', haze: 'rgba(110,200,90,0.05)' },
  freightliner: { floor: '#1e2730', field: '#1c242c', accent: '#4c86c8', haze: 'rgba(70,120,200,0.05)' },
  refinery: { floor: '#232722', field: '#25291d', accent: '#c6d13f', haze: 'rgba(190,210,60,0.05)' },
  vacuum: { floor: '#1f262c', field: '#1b2329', accent: '#9fd2ea', haze: 'rgba(150,210,240,0.05)' },
};

const lerp = (a, b, t) => a + (b - a) * t;
const shade = (hex, f) => {
  const n = parseInt(hex.slice(1), 16);
  const r = Math.min(255, Math.max(0, Math.round(((n >> 16) & 255) * f)));
  const g = Math.min(255, Math.max(0, Math.round(((n >> 8) & 255) * f)));
  const b = Math.min(255, Math.max(0, Math.round((n & 255) * f)));
  return `rgb(${r},${g},${b})`;
};
const alpha = (hex, a) => {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
};

export class Renderer {
  constructor(canvas, settings) {
    this.cv = canvas;
    this.ctx = canvas.getContext('2d');
    this.settings = settings;
    this.S = 20;
    this.ox = 0;
    this.oy = 0;
    this.floor = document.createElement('canvas');
    this.decals = document.createElement('canvas');
    this.parts = [];
    this.flashes = [];
    this.lines = [];
    this.warns = [];
    this.shake = 0;
    this.flatten = false;
    this.projMemo = new Map();
    this.t = 0;
    this.state = null;
    this.resize();
  }

  // --------------------------------------------------------------- geometry
  resize() {
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const w = this.cv.clientWidth || window.innerWidth, h = this.cv.clientHeight || window.innerHeight;
    this.cv.width = Math.round(w * dpr);
    this.cv.height = Math.round(h * dpr);
    this.dpr = dpr;
    this.vw = w;
    this.vh = h;
    const sc = (this.settings.uiScale || 100) / 100;
    const topPad = Math.round(84 * sc + 16), botPad = Math.round(150 * sc + 34);
    const S = Math.min((w - 24) / W, (h - topPad - botPad) / (H * K + 1.2));
    this.S = Math.max(8, S);
    this.ox = Math.round((w - W * this.S) / 2);
    this.oy = Math.round(topPad + (h - topPad - botPad - H * K * this.S) / 2 + this.S * 0.9);
    this.floorDirty = true;
    this.decals.width = Math.round(W * this.S * dpr);
    this.decals.height = Math.round(H * K * this.S * dpr);
  }

  /** ground-plane cell coords (float) → screen px */
  sx(x) { return this.ox + x * this.S; }
  sy(y, z = 0) { return this.oy + y * this.S * K - z * this.S * Z; }
  /** screen px → ground cell coords (float) */
  toCell(px, py) { return [(px - this.ox) / this.S, (py - this.oy) / (this.S * K)]; }

  // ------------------------------------------------------------------ setup
  setMatch(state) {
    this.state = state;
    this.floorDirty = true;
    const dc = this.decals.getContext('2d');
    dc.clearRect(0, 0, this.decals.width, this.decals.height);
    this.parts = [];
    this.projMemo.clear();
  }

  buildFloor() {
    const st = this.state;
    const look = ARENA_LOOK[st.arena] || ARENA_LOOK.rustdock;
    const S = this.S, dpr = this.dpr;
    this.floor.width = this.cv.width;
    this.floor.height = this.cv.height;
    const c = this.floor.getContext('2d');
    c.setTransform(dpr, 0, 0, dpr, 0, 0);
    // backdrop: dark hull with soft vignette
    const g = c.createRadialGradient(this.vw / 2, this.vh / 2, 50, this.vw / 2, this.vh / 2, this.vw * 0.75);
    g.addColorStop(0, '#152022');
    g.addColorStop(1, '#070b0c');
    c.fillStyle = g;
    c.fillRect(0, 0, this.vw, this.vh);
    // deck slab with a front lip so it reads as a diorama
    const x0 = this.sx(0), y0 = this.sy(0), x1 = this.sx(W), y1 = this.sy(H);
    c.fillStyle = '#0d1517';
    c.fillRect(x0 - 6, y1, x1 - x0 + 12, S * 0.9);
    for (let i = 0; i < W; i += 2) { c.fillStyle = i % 4 ? '#e49b3c' : '#151515'; c.fillRect(this.sx(i), y1 + S * 0.25, S, S * 0.2); }
    for (let y = 0; y < H; y++)
      for (let x = 0; x < W; x++) {
        const i = y * W + x;
        const yard = st.yard[i];
        let base = yard >= 0 ? look.floor : look.field;
        c.fillStyle = base;
        c.fillRect(this.sx(x), this.sy(y), S + 0.5, S * K + 0.5);
        // plate seams & rivets
        c.fillStyle = 'rgba(255,255,255,0.035)';
        c.fillRect(this.sx(x), this.sy(y), S, 1);
        c.fillStyle = 'rgba(0,0,0,0.25)';
        c.fillRect(this.sx(x), this.sy(y + 1) - 1, S, 1);
        if (((x * 7 + y * 13) % 11) === 0) { c.fillStyle = 'rgba(0,0,0,0.18)'; c.fillRect(this.sx(x + 0.15), this.sy(y + 0.2), S * 0.5, S * K * 0.35); }
        if (yard >= 0) { c.fillStyle = alpha(PCOL[yard], 0.06); c.fillRect(this.sx(x), this.sy(y), S, S * K); }
      }
    // yard borders: hazard tape in crew colour
    for (let s = 0; s < st.n; s++) {
      const [yx, yy] = st.players[s].yard;
      c.save();
      c.strokeStyle = alpha(PCOL[s], 0.55);
      c.setLineDash([S * 0.5, S * 0.35]);
      c.lineWidth = Math.max(1.5, S * 0.08);
      c.strokeRect(this.sx(yx) + 1, this.sy(yy) + 1, 12 * S - 2, 12 * S * K - 2);
      c.restore();
      // painted yard number
      c.fillStyle = alpha(PCOL[s], 0.18);
      c.font = `700 ${Math.round(S * 2.2)}px Chakra Petch, sans-serif`;
      c.textAlign = 'center';
      c.fillText(`Y-0${s + 1}`, this.sx(yx + 6), this.sy(yy + 11.4));
    }
    // centre field grime + arena accent stripes
    c.fillStyle = look.haze;
    c.fillRect(this.sx(13), this.sy(0), S * 18, S * K * H);
    for (let y = 0; y < H; y += 6) {
      c.fillStyle = alpha(look.accent, 0.08);
      c.fillRect(this.sx(13), this.sy(y + 2.5), S * 18, S * K * 0.12);
    }
    // vents (refinery)
    for (let i = 0; i < W * H; i++) if (st.vent[i]) this.drawVent(c, i % W, (i / W) | 0, 0);
    this.floorDirty = false;
  }

  drawVent(c, x, y, glow) {
    const S = this.S;
    const cx = this.sx(x + 0.5), cy = this.sy(y + 0.5);
    c.save();
    c.fillStyle = '#0b0f0c';
    c.beginPath(); c.ellipse(cx, cy, S * 0.45, S * 0.45 * K, 0, 0, Math.PI * 2); c.fill();
    c.strokeStyle = glow ? `rgba(200,230,60,${0.5 + glow * 0.5})` : '#5b6a3a';
    c.lineWidth = 2;
    c.stroke();
    for (let k = -2; k <= 2; k++) { c.beginPath(); c.moveTo(cx - S * 0.3, cy + k * S * 0.07); c.lineTo(cx + S * 0.3, cy + k * S * 0.07); c.stroke(); }
    c.restore();
  }

  // ------------------------------------------------------------------ frame
  /**
   * view: { me, snapPrev, snapCur, alpha, hover, ghost, aim, mode, enclosedBy }
   */
  frame(dt, view) {
    const st = this.state;
    if (!st) return;
    this.t += dt;
    if (this.floorDirty) this.buildFloor();
    const c = this.ctx, dpr = this.dpr, S = this.S;
    c.setTransform(1, 0, 0, 1, 0, 0);
    c.drawImage(this.floor, 0, 0);
    let shx = 0, shy = 0;
    if (this.shake > 0 && this.settings.shake) {
      const m = Math.min(6, this.shake) * (this.settings.shake === 'low' ? 0.4 : 1);
      shx = (Math.random() - 0.5) * m;
      shy = (Math.random() - 0.5) * m;
    }
    this.shake = Math.max(0, this.shake - dt * 30);
    c.setTransform(dpr, 0, 0, dpr, shx * dpr, shy * dpr);
    c.drawImage(this.decals, this.sx(0), this.sy(0), W * S, H * K * S);

    const snap = view.snapCur;
    // enclosed floor tint per crew
    if (view.enclosedBy) {
      for (let i = 0; i < W * H; i++) {
        const o = view.enclosedBy[i];
        if (o < 0) continue;
        c.fillStyle = alpha(PCOL[o], o === view.me ? 0.16 : 0.08);
        c.fillRect(this.sx(i % W), this.sy((i / W) | 0), S + 0.5, S * K + 0.5);
      }
    }
    // fires
    for (const f of snap.fires) {
      const [x, y, r, left] = f;
      const R = (r / FP) * S;
      const flick = 0.75 + 0.25 * Math.sin(this.t * 20 + x);
      const g = c.createRadialGradient(this.sx(x / FP), this.sy(y / FP), 1, this.sx(x / FP), this.sy(y / FP), R);
      g.addColorStop(0, `rgba(255,170,60,${0.55 * flick})`);
      g.addColorStop(1, 'rgba(200,60,20,0)');
      c.fillStyle = g;
      c.beginPath(); c.ellipse(this.sx(x / FP), this.sy(y / FP), R, R * K, 0, 0, Math.PI * 2); c.fill();
      if (Math.random() < 0.4) this.spawn(x / FP + (Math.random() - 0.5) * r / FP, y / FP + (Math.random() - 0.5) * r / FP, 0.1, { kind: 'ember' });
    }
    // telegraph warnings
    this.warns = this.warns.filter((w) => w.until > this.t);
    for (const w of this.warns) {
      const p = 0.5 + 0.5 * Math.sin(this.t * 14);
      c.strokeStyle = `rgba(228,155,60,${0.4 + 0.5 * p})`;
      c.lineWidth = 2;
      c.setLineDash([6, 4]);
      c.beginPath(); c.ellipse(this.sx(w.x + 0.5), this.sy(w.y + 0.5), w.r * S, w.r * S * K, 0, 0, Math.PI * 2); c.stroke();
      c.setLineDash([]);
    }
    // ghost / placement preview on the floor
    if (view.ghost) this.drawGhost(c, view.ghost);

    // ----- depth-sorted objects, back row first
    const gunsByCell = new Map();
    for (const g of snap.guns) gunsByCell.set(g[4] * W + g[3], g);
    const playersBySlot = snap.players;
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const i = y * W + x;
        const prop = st.prop[i];
        if (prop) this.drawProp(c, x, y, prop);
        if (st.hp[i] > 0) this.drawWall(c, x, y, i);
        const g = gunsByCell.get(i);
        if (g) this.drawGun(c, g, snap, view);
        const r = st.reactor[i];
        if (r >= 0) {
          const p = playersBySlot[r];
          if (x === p.rx + 1 && y === p.ry + 1) this.drawReactor(c, p, view);
        }
      }
    }
    // beams
    for (const g of snap.guns) if (g[12]) this.drawBeam(c, g);
    // projectiles
    this.drawProjectiles(c, view);
    // transient lines (zaps, flak tracers, rail charge)
    this.lines = this.lines.filter((l) => l.until > this.t);
    for (const l of this.lines) this.drawLine(c, l);
    // particles
    this.stepParticles(c, dt);
    // flashes
    this.flashes = this.flashes.filter((f) => f.until > this.t);
    for (const f of this.flashes) {
      const k = (f.until - this.t) / f.dur;
      const R = f.r * S * (1.3 - k * 0.3);
      const g = c.createRadialGradient(this.sx(f.x), this.sy(f.y, 0.3), 1, this.sx(f.x), this.sy(f.y, 0.3), R);
      g.addColorStop(0, `rgba(255,240,200,${0.9 * k})`);
      g.addColorStop(0.4, alpha(f.col || '#e49b3c', 0.6 * k));
      g.addColorStop(1, 'rgba(0,0,0,0)');
      c.save();
      c.globalCompositeOperation = 'lighter';
      c.fillStyle = g;
      c.beginPath(); c.ellipse(this.sx(f.x), this.sy(f.y, 0.3), R, R * 0.8, 0, 0, Math.PI * 2); c.fill();
      c.restore();
      if (f.r >= 1) {
        c.strokeStyle = `rgba(255,220,170,${0.5 * k})`;
        c.lineWidth = 2;
        const Rw = f.r * S * (1.8 - k);
        c.beginPath(); c.ellipse(this.sx(f.x), this.sy(f.y), Rw, Rw * K, 0, 0, Math.PI * 2); c.stroke();
      }
    }
    // aim overlay
    if (view.aim) this.drawAim(c, view.aim, snap, view);
    // hover cell outline
    if (view.hover && !view.ghost) {
      c.strokeStyle = 'rgba(215,208,181,0.5)';
      c.lineWidth = 1;
      c.strokeRect(this.sx(view.hover[0]) + 0.5, this.sy(view.hover[1]) + 0.5, S - 1, S * K - 1);
    }
  }

  // ------------------------------------------------------------------ walls
  wallHeight(mat) { return this.flatten ? 0.18 : MAT_H[mat] || 1; }

  drawWall(c, x, y, i) {
    const st = this.state, S = this.S;
    const kind = PIECE_IDS[st.kind[i]] || 'brace';
    const mat = PIECES[kind].mat;
    const owner = st.owner[i];
    const h = this.wallHeight(mat);
    const ratio = st.hp[i] / Math.max(1, st.max[i]);
    const X = this.sx(x), Yt = this.sy(y, h), Yb = this.sy(y), D = S * K;
    const base = mat === 'heavy' ? '#56666a' : mat === 'shutter' ? '#646b63' : mat === 'mesh' ? '#46686a' : mat === 'foam' ? '#cdb86c' : '#727c77';
    const dmg = 0.55 + 0.45 * ratio;
    // contact shadow on the floor in front
    c.fillStyle = 'rgba(0,0,0,0.28)';
    c.fillRect(X + 1, Yb + D, S, Math.max(2, S * 0.18));
    // front face: vertical gradient, darker at the foot
    const fh = Yb - Yt;
    const g = c.createLinearGradient(0, Yt + D, 0, Yb + D);
    g.addColorStop(0, shade(base, 0.78 * dmg));
    g.addColorStop(1, shade(base, 0.42 * dmg));
    c.fillStyle = g;
    c.fillRect(X, Yt + D, S, fh);
    // top face with a lit back edge
    c.fillStyle = shade(base, 1.08 * dmg);
    c.fillRect(X, Yt, S, D);
    c.fillStyle = 'rgba(255,255,255,0.10)';
    c.fillRect(X, Yt, S, Math.max(1, D * 0.18));
    // crew band across the front face + stripe on the top lip
    if (owner >= 0) {
      c.fillStyle = alpha(PCOL[owner], 0.85);
      c.fillRect(X, Yt + D + 1, S, Math.max(1.5, fh * 0.12));
      c.fillStyle = PCOL[owner];
      c.fillRect(X, Yt, S, Math.max(1, S * 0.06));
    }
    // material detail
    if (mat === 'mesh') {
      c.strokeStyle = 'rgba(170,230,230,0.35)';
      c.lineWidth = 1;
      c.beginPath();
      for (let k = 0; k <= 4; k++) { c.moveTo(X + (k * S) / 4, Yt + D); c.lineTo(X + (k * S) / 4, Yb + D); }
      c.moveTo(X, Yt + D + fh * 0.55); c.lineTo(X + S, Yt + D + fh * 0.55);
      c.stroke();
    } else if (mat === 'heavy') {
      c.fillStyle = 'rgba(0,0,0,0.3)';
      c.fillRect(X + S * 0.08, Yt + D + fh * 0.5, S * 0.84, Math.max(1, S * 0.06));
      c.fillStyle = 'rgba(255,230,160,0.35)';
      for (const fx of [0.2, 0.8]) c.fillRect(X + S * fx - 1, Yt + D + fh * 0.7, 2, 2);
      c.fillStyle = 'rgba(228,155,60,0.55)';
      c.fillRect(X + S * 0.3, Yt + D * 0.35, S * 0.4, Math.max(1, D * 0.2));
    } else if (mat === 'shutter') {
      c.fillStyle = 'rgba(0,0,0,0.32)';
      for (let k = 1; k < 5; k++) c.fillRect(X, Yt + D + (fh * k) / 5, S, 1);
    } else if (mat === 'foam') {
      c.fillStyle = 'rgba(255,255,255,0.25)';
      c.beginPath(); c.ellipse(X + S * 0.4, Yt + D * 0.4, S * 0.2, D * 0.22, 0, 0, Math.PI * 2); c.fill();
      c.beginPath(); c.ellipse(X + S * 0.7, Yt + D + fh * 0.4, S * 0.12, fh * 0.15, 0, 0, Math.PI * 2); c.fill();
    } else {
      c.fillStyle = 'rgba(255,255,255,0.28)';
      for (const fx of [0.15, 0.5, 0.85]) c.fillRect(X + S * fx - 1, Yt + D + fh * 0.62, 2, 2);
    }
    c.strokeStyle = 'rgba(0,0,0,0.5)';
    c.lineWidth = 1;
    c.strokeRect(X + 0.5, Yt + 0.5, S - 1, fh + D - 1);
    // damage: soot, cracks, sparks
    if (ratio < 0.75) {
      c.fillStyle = `rgba(15,10,6,${0.45 * (1 - ratio)})`;
      c.fillRect(X, Yt, S, fh + D);
      c.strokeStyle = `rgba(10,8,6,${0.9 - ratio * 0.6})`;
      c.beginPath();
      const s1 = (i * 2654435761) >>> 0;
      c.moveTo(X + S * ((s1 % 7) / 10 + 0.15), Yt);
      c.lineTo(X + S * (((s1 >> 3) % 7) / 10 + 0.1), Yt + D + fh * 0.5);
      c.lineTo(X + S * (((s1 >> 6) % 7) / 10 + 0.2), Yb + D);
      c.stroke();
    }
    if (ratio < 0.35 && Math.random() < 0.03) this.spawn(x + 0.5, y + 0.5, h, { kind: 'spark' });
    if (st.brittle && st.brittle[i]) {
      c.fillStyle = 'rgba(170,225,255,0.38)';
      c.fillRect(X, Yt, S, fh + D);
    }
  }

  drawGhost(c, gh) {
    const S = this.S;
    for (const [x, y] of gh.cells) {
      c.fillStyle = gh.ok ? 'rgba(145,203,160,0.35)' : 'rgba(211,78,63,0.35)';
      c.fillRect(this.sx(x), this.sy(y), S, S * K);
      c.strokeStyle = gh.ok ? '#91cba0' : '#d34e3f';
      c.lineWidth = 1.5;
      c.strokeRect(this.sx(x) + 0.75, this.sy(y) + 0.75, S - 1.5, S * K - 1.5);
    }
    if (gh.label) {
      const [x, y] = gh.cells[0];
      c.font = `600 ${Math.max(11, S * 0.55)}px Chakra Petch, sans-serif`;
      c.fillStyle = gh.ok ? '#91cba0' : '#d34e3f';
      c.textAlign = 'left';
      c.fillText(gh.label, this.sx(x), this.sy(y) - 4);
    }
  }

  // ------------------------------------------------------------------ props
  drawProp(c, x, y, kind) {
    const S = this.S;
    const box = (h, top, front, inset = 0) => {
      h = this.flatten ? 0.2 : h;
      const X = this.sx(x) + inset * S, w = S * (1 - 2 * inset);
      const Yt = this.sy(y, h), Yb = this.sy(y), D = S * K;
      c.fillStyle = front; c.fillRect(X, Yt + D, w, Yb - Yt);
      c.fillStyle = top; c.fillRect(X, Yt, w, D);
      c.strokeStyle = 'rgba(0,0,0,0.5)'; c.lineWidth = 1; c.strokeRect(X + 0.5, Yt + 0.5, w - 1, Yb - Yt + D - 1);
      return [X, Yt, w, D, Yb];
    };
    if (kind === PROP.container) {
      const [X, Yt, w, D] = box(1.3, '#4c86c8', '#2f557f');
      c.fillStyle = 'rgba(255,255,255,0.12)';
      for (let k = 1; k < 4; k++) c.fillRect(X + (w * k) / 4, Yt + D, 1, S * Z * 1.3);
    } else if (kind === PROP.crate) box(0.8, '#8a6a3c', '#5c4526', 0.08);
    else if (kind === PROP.boom) {
      const [X, Yt, w, D] = box(2.2, '#e0b23a', '#8d6c1d', 0.18);
      c.strokeStyle = 'rgba(0,0,0,0.5)';
      c.beginPath(); c.moveTo(X, Yt + D); c.lineTo(X + w, Yt + D + S * Z * 2.2); c.stroke();
    } else if (kind === PROP.core) {
      const [X, Yt, w, D] = box(1.6, '#58665a', '#36403a', 0.05);
      c.fillStyle = `rgba(120,220,100,${0.25 + 0.15 * Math.sin(this.t * 3 + x)})`;
      c.fillRect(X + w * 0.3, Yt + D, w * 0.4, S * Z * 1.2);
    } else if (kind === PROP.vat) {
      const [X, Yt, w, D] = box(1.5, '#a8b13c', '#6c7226', 0.06);
      c.fillStyle = 'rgba(0,0,0,0.25)'; c.fillRect(X, Yt + D + S * Z * 0.5, w, 2);
    } else if (kind === PROP.pillar) box(2.6, '#7a8a94', '#4b5960', 0.15);
    else if (kind === PROP.bollard) box(0.6, '#d0a03c', '#7a5d22', 0.3);
    else box(1, '#555', '#333');
  }

  // ------------------------------------------------------------------- guns
  drawGun(c, g, snap, view) {
    const [id, owner, w, x, y, hp, max, reload, stun, heat, over, wind] = g;
    const S = this.S;
    const col = PCOL[owner];
    const cx = this.sx(x + 0.5), cy = this.sy(y + 0.5);
    const h = this.flatten ? 0.1 : 0.55;
    const top = this.sy(y + 0.5, h);
    // plinth
    c.fillStyle = '#2b3335';
    c.fillRect(this.sx(x + 0.08), this.sy(y + 0.1, h * 0.5), S * 0.84, this.sy(y + 0.9) - this.sy(y + 0.1, h * 0.5));
    c.fillStyle = '#3c4749';
    c.fillRect(this.sx(x + 0.08), this.sy(y + 0.1, h * 0.5), S * 0.84, S * K * 0.8);
    c.fillStyle = col;
    c.fillRect(this.sx(x + 0.08), this.sy(y + 0.9) - 2, S * 0.84, 2);
    // aim direction
    const p = snap.players[owner];
    let ax, ay;
    if (p && p.active === id && p.aim && (view.me === owner || p.firing)) { ax = p.aim[0] / FP; ay = p.aim[1] / FP; }
    else {
      const foes = snap.players.filter((q) => q.slot !== owner && q.alive);
      const t = foes.find((q) => q.slot === p.target) || foes[0];
      if (t) { ax = t.rx + 1; ay = t.ry + 1; } else { ax = x + 1; ay = y; }
    }
    const ang = Math.atan2((ay - y - 0.5) * K, ax - x - 0.5);
    c.save();
    c.translate(cx, top);
    const body = (r, f) => { c.fillStyle = f; c.beginPath(); c.ellipse(0, 0, r * S, r * S * 0.75, 0, 0, Math.PI * 2); c.fill(); };
    c.rotate(ang);
    const bar = (len, wd, f, off = 0) => { c.fillStyle = f; c.fillRect(0, off - (wd * S) / 2, len * S, wd * S); };
    switch (w) {
      case 'rivet': bar(0.55, 0.09, '#9aa29c', -0.11); bar(0.6, 0.09, '#b7bdb5', 0); bar(0.55, 0.09, '#9aa29c', 0.11); body(0.26, '#646d69'); break;
      case 'harpoon': bar(0.95, 0.07, '#c8ccc2'); c.fillStyle = '#e8e2c8'; c.beginPath(); c.moveTo(0.95 * S, -0.1 * S); c.lineTo(1.15 * S, 0); c.lineTo(0.95 * S, 0.1 * S); c.fill(); body(0.28, '#55615f'); break;
      case 'cutter': bar(0.5, 0.16, '#7d6a52'); c.fillStyle = `rgba(255,${180 - heat * 2},80,0.9)`; c.fillRect(0.45 * S, -0.06 * S, 0.12 * S, 0.12 * S); body(0.3, '#6a5a48'); break;
      case 'mortar': body(0.34, '#59625e'); c.rotate(-ang); c.fillStyle = '#2a3132'; c.beginPath(); c.ellipse(0, -0.12 * S, 0.2 * S, 0.14 * S, 0, 0, Math.PI * 2); c.fill(); c.fillStyle = '#879088'; c.fillRect(-0.2 * S, -0.12 * S, 0.4 * S, 0.22 * S); break;
      case 'rail': bar(1.05, 0.05, '#a9b8c4', -0.09); bar(1.05, 0.05, '#a9b8c4', 0.09); if (wind > 0) { c.fillStyle = 'rgba(140,220,255,0.9)'; c.fillRect(0, -0.04 * S, 1.05 * S * (1 - wind / 40), 0.08 * S); } body(0.27, '#47525c'); break;
      case 'flak': for (const o of [-0.14, -0.05, 0.05, 0.14]) bar(0.5, 0.05, '#a7ab9a', o); body(0.3, '#6b6a50'); break;
      case 'cryo': bar(0.55, 0.13, '#7fb6c9'); body(0.3, '#4e7584'); c.fillStyle = '#cbeefa'; c.beginPath(); c.arc(-0.05 * S, 0, 0.12 * S, 0, 7); c.fill(); break;
      case 'emp': bar(0.55, 0.08, '#8ea4c8'); body(0.26, '#3f4c6c'); c.strokeStyle = '#a8d4ff'; c.lineWidth = 1.5; c.beginPath(); c.arc(0, 0, 0.18 * S, 0, 7); c.stroke(); break;
      case 'incin': body(0.33, '#7b4a2c'); bar(0.45, 0.16, '#a46a3c'); c.fillStyle = 'rgba(255,140,40,0.8)'; c.fillRect(0.38 * S, -0.05 * S, 0.08 * S, 0.1 * S); break;
      case 'wreck': bar(0.6, 0.1, '#6f6f6f'); c.fillStyle = '#2b2b2b'; c.beginPath(); c.arc(0.68 * S, 0, 0.2 * S, 0, 7); c.fill(); body(0.3, '#555b58'); break;
      case 'welder': c.rotate(-ang); c.fillStyle = '#4c5658'; c.fillRect(-0.08 * S, -0.55 * S, 0.16 * S, 0.55 * S); c.fillStyle = '#c9d9ff'; c.beginPath(); c.arc(0, -0.6 * S, 0.16 * S, 0, 7); c.fill(); if (reload < 4) { c.strokeStyle = 'rgba(180,210,255,0.8)'; c.beginPath(); c.moveTo(0, -0.6 * S); c.lineTo((Math.random() - 0.5) * S * 0.6, -0.9 * S); c.stroke(); } break;
      case 'missile': c.fillStyle = '#5c6450'; c.fillRect(-0.3 * S, -0.22 * S, 0.62 * S, 0.44 * S); c.fillStyle = '#c9b46a'; c.fillRect(0.1 * S, -0.16 * S, 0.22 * S, 0.12 * S); c.fillRect(0.1 * S, 0.04 * S, 0.22 * S, 0.12 * S); break;
      default: body(0.3, '#777');
    }
    c.restore();
    // crew dot + status
    c.fillStyle = col;
    c.beginPath(); c.arc(cx - S * 0.32, top - S * 0.3, Math.max(2, S * 0.09), 0, 7); c.fill();
    if (hp < max) {
      c.fillStyle = '#0b1213'; c.fillRect(this.sx(x + 0.1), this.sy(y + 0.95) + 2, S * 0.8, 3);
      c.fillStyle = hp / max > 0.4 ? '#91cba0' : '#d34e3f'; c.fillRect(this.sx(x + 0.1), this.sy(y + 0.95) + 2, (S * 0.8 * hp) / max, 3);
    }
    if (stun > 0) {
      c.strokeStyle = 'rgba(140,200,255,0.9)';
      c.beginPath();
      for (let k = 0; k < 3; k++) { const a = this.t * 9 + k * 2.1; c.moveTo(cx + Math.cos(a) * S * 0.3, top + Math.sin(a) * S * 0.2); c.lineTo(cx + Math.cos(a + 0.6) * S * 0.45, top + Math.sin(a + 0.6) * S * 0.3); }
      c.stroke();
    }
    if (over) { c.fillStyle = 'rgba(255,90,40,0.7)'; c.fillText && (c.font = `600 ${Math.max(9, S * 0.4)}px Chakra Petch`, c.fillText('HOT', cx - S * 0.3, top - S * 0.4)); }
    if (view.selectedGun === id) {
      c.strokeStyle = '#e49b3c'; c.lineWidth = 2;
      c.strokeRect(this.sx(x) + 1, this.sy(y) + 1, S - 2, S * K - 2);
    }
  }

  drawBeam(c, g) {
    const [, owner, , x, y, , , , , , , , , bx, by] = g;
    const x0 = this.sx(x + 0.5), y0 = this.sy(y + 0.5, 0.55), x1 = this.sx(bx / FP), y1 = this.sy(by / FP, 0.5);
    c.save();
    c.lineCap = 'round';
    c.strokeStyle = 'rgba(255,150,60,0.35)'; c.lineWidth = this.S * 0.35;
    c.beginPath(); c.moveTo(x0, y0); c.lineTo(x1, y1); c.stroke();
    c.strokeStyle = 'rgba(255,240,200,0.95)'; c.lineWidth = Math.max(1.5, this.S * 0.08);
    c.beginPath(); c.moveTo(x0, y0);
    const n = 8;
    for (let k = 1; k <= n; k++) c.lineTo(lerp(x0, x1, k / n) + (Math.random() - 0.5) * 3, lerp(y0, y1, k / n) + (Math.random() - 0.5) * 3);
    c.stroke();
    c.restore();
    if (Math.random() < 0.5) this.spawn(bx / FP, by / FP, 0.4, { kind: 'spark', col: '#ffb060' });
  }

  // ---------------------------------------------------------------- reactor
  drawReactor(c, p, view) {
    const S = this.S;
    const cx = this.sx(p.rx + 1), cyb = this.sy(p.ry + 1), col = PCOL[p.slot];
    if (!p.alive) {
      c.fillStyle = '#0a0c0c';
      c.beginPath(); c.ellipse(cx, cyb, S * 1.0, S * 0.9 * K, 0, 0, Math.PI * 2); c.fill();
      c.strokeStyle = '#3a2a22'; c.lineWidth = 2; c.stroke();
      if (Math.random() < 0.3) this.spawn(p.rx + 1 + (Math.random() - 0.5), p.ry + 1 + (Math.random() - 0.5) * 0.6, 0.2, { kind: 'smoke' });
      return;
    }
    const h = this.flatten ? 0.25 : 1.9;
    const hpK = p.hp / 1000;
    const pulse = 0.5 + 0.5 * Math.sin(this.t * (2 + (1 - hpK) * 8));
    // base ring
    c.fillStyle = '#2d3537';
    c.beginPath(); c.ellipse(cx, cyb, S * 0.95, S * 0.95 * K, 0, 0, Math.PI * 2); c.fill();
    c.strokeStyle = col; c.lineWidth = 2; c.stroke();
    // glass column
    const top = this.sy(p.ry + 1, h);
    const glow = hpK > 0.5 ? col : hpK > 0.25 ? '#e49b3c' : '#d34e3f';
    const grd = c.createLinearGradient(cx - S * 0.6, 0, cx + S * 0.6, 0);
    grd.addColorStop(0, shade(glow, 0.35));
    grd.addColorStop(0.5, alpha(glow, 0.65 + 0.3 * pulse));
    grd.addColorStop(1, shade(glow, 0.3));
    c.fillStyle = grd;
    c.fillRect(cx - S * 0.6, top, S * 1.2, cyb - top);
    c.fillStyle = alpha(glow, 0.9);
    c.beginPath(); c.ellipse(cx, top, S * 0.6, S * 0.6 * K, 0, 0, Math.PI * 2); c.fill();
    c.fillStyle = '#c9cdc6';
    c.fillRect(cx - S * 0.65, cyb - (cyb - top) * 0.35, S * 1.3, Math.max(2, S * 0.12));
    c.fillRect(cx - S * 0.65, cyb - (cyb - top) * 0.75, S * 1.3, Math.max(2, S * 0.12));
    // crew glyph (colour-blind safe shape)
    glyph(c, p.slot, cx, top - S * 0.5, S * 0.32, col);
    // breach warning
    if (!p.enclosed) {
      c.strokeStyle = `rgba(211,78,63,${0.4 + 0.6 * pulse})`;
      c.lineWidth = 3;
      c.beginPath(); c.ellipse(cx, cyb, S * 1.6, S * 1.6 * K, 0, 0, Math.PI * 2); c.stroke();
      if (p.slot === view.me) {
        c.font = `700 ${Math.max(11, S * 0.6)}px Chakra Petch, sans-serif`;
        c.fillStyle = '#d34e3f'; c.textAlign = 'center';
        c.fillText('BREACH', cx, top - S * 1.1);
      }
    }
  }

  // ------------------------------------------------------------ projectiles
  drawProjectiles(c, view) {
    const snap = view.snapCur, prev = view.snapPrev, a = view.alpha;
    const pm = new Map();
    if (prev) for (const q of prev.proj) pm.set(q[0], q);
    const S = this.S;
    for (const q of snap.proj) {
      const [id, owner, w, x1, y1, z1, kind] = q;
      const p0 = pm.get(id) || q;
      const x = lerp(p0[3], x1, a) / FP, y = lerp(p0[4], y1, a) / FP, z = lerp(p0[5], z1, a) / FP;
      const X = this.sx(x), Yg = this.sy(y), Y = this.sy(y, kind ? z : 0.45);
      const col = PCOL[owner];
      if (kind) {
        c.fillStyle = 'rgba(0,0,0,0.4)';
        c.beginPath(); c.ellipse(X, Yg, S * 0.24, S * 0.13, 0, 0, Math.PI * 2); c.fill();
      }
      const glow = (r, rgba) => {
        const g = c.createRadialGradient(X, Y, 0, X, Y, r);
        g.addColorStop(0, rgba);
        g.addColorStop(1, 'rgba(0,0,0,0)');
        c.fillStyle = g;
        c.beginPath(); c.arc(X, Y, r, 0, 7); c.fill();
      };
      c.save();
      if (w === 'mortar' || w === 'incin' || w === 'cryo') {
        c.globalCompositeOperation = 'lighter';
        glow(S * 0.7, w === 'cryo' ? 'rgba(120,200,255,0.5)' : w === 'incin' ? 'rgba(255,120,30,0.6)' : 'rgba(255,170,80,0.35)');
        c.globalCompositeOperation = 'source-over';
        c.fillStyle = w === 'cryo' ? '#cfefff' : w === 'incin' ? '#ffb05c' : '#4a504e';
        c.beginPath(); c.arc(X, Y, S * 0.22, 0, 7); c.fill();
        c.strokeStyle = col; c.lineWidth = 2; c.stroke();
        if (Math.random() < 0.6) this.spawn(x, y, z, { kind: 'smoke', small: true });
      } else if (w === 'missile') {
        c.globalCompositeOperation = 'lighter';
        glow(S * 0.6, 'rgba(255,160,60,0.7)');
        c.globalCompositeOperation = 'source-over';
        c.fillStyle = '#e8e4d0';
        c.beginPath(); c.arc(X, Y, S * 0.14, 0, 7); c.fill();
        this.spawn(x, y, z, { kind: 'smoke', small: true });
      } else if (w === 'wreck') {
        c.fillStyle = '#1c1c1c'; c.beginPath(); c.arc(X, Y, S * 0.4, 0, 7); c.fill();
        c.strokeStyle = col; c.lineWidth = 2; c.stroke();
        c.fillStyle = 'rgba(255,255,255,0.25)'; c.beginPath(); c.arc(X - S * 0.12, Y - S * 0.12, S * 0.1, 0, 7); c.fill();
      } else {
        const len = w === 'harpoon' || w === 'rail' ? 1.3 : w === 'flak' ? 0.25 : 0.7;
        const vx = x1 - p0[3], vy = y1 - p0[4];
        const m = Math.hypot(vx, vy) || 1;
        const tx = X - (vx / m) * len * S, ty = Y - (vy / m) * len * S * K;
        const tint = w === 'rail' ? [170, 230, 255] : w === 'emp' ? [150, 190, 255] : [255, 215, 140];
        c.globalCompositeOperation = 'lighter';
        const lg = c.createLinearGradient(X, Y, tx, ty);
        lg.addColorStop(0, `rgba(${tint},1)`);
        lg.addColorStop(1, `rgba(${tint},0)`);
        c.strokeStyle = lg;
        c.lineCap = 'round';
        c.lineWidth = w === 'rail' ? S * 0.22 : w === 'flak' ? 2 : S * 0.12;
        c.beginPath(); c.moveTo(X, Y); c.lineTo(tx, ty); c.stroke();
        glow(S * (w === 'rail' ? 0.6 : 0.35), `rgba(${tint},0.5)`);
      }
      c.restore();
    }
  }

  // ------------------------------------------------------------------ aim UI
  drawAim(c, aim, snap, view) {
    const S = this.S;
    const g = snap.guns.find((x) => x[0] === aim.gun);
    const X = this.sx(aim.x), Y = this.sy(aim.y);
    c.strokeStyle = '#e49b3c'; c.lineWidth = 1.5;
    c.beginPath(); c.arc(X, Y, S * 0.45, 0, 7); c.stroke();
    c.beginPath(); c.moveTo(X - S * 0.7, Y); c.lineTo(X - S * 0.25, Y); c.moveTo(X + S * 0.25, Y); c.lineTo(X + S * 0.7, Y); c.moveTo(X, Y - S * 0.7); c.lineTo(X, Y - S * 0.25); c.moveTo(X, Y + S * 0.25); c.lineTo(X, Y + S * 0.7); c.stroke();
    if (!g) return;
    const w = WEAPONS[g[2]];
    const gx = this.sx(g[3] + 0.5), gy = this.sy(g[4] + 0.5, 0.55);
    c.setLineDash([4, 5]);
    c.strokeStyle = 'rgba(228,155,60,0.6)';
    c.beginPath();
    if (w.kind === 'arc') {
      const mx = (gx + X) / 2, my = Math.min(gy, Y) - S * 3;
      c.moveTo(gx, gy); c.quadraticCurveTo(mx, my, X, Y);
    } else { c.moveTo(gx, gy); c.lineTo(X, Y); }
    c.stroke();
    c.setLineDash([]);
    if (w.radius) {
      const R = (w.radius / FP) * S;
      c.strokeStyle = 'rgba(211,78,63,0.5)';
      c.beginPath(); c.ellipse(X, Y, R, R * K, 0, 0, Math.PI * 2); c.stroke();
    }
  }

  // --------------------------------------------------------------- effects
  spawn(x, y, z, o) {
    if (this.parts.length > 900) return;
    const k = o.kind;
    const p = { x, y, z, vx: 0, vy: 0, vz: 0, life: 1, max: 1, kind: k, col: o.col, size: 1 };
    if (k === 'spark') { p.vx = (Math.random() - 0.5) * 4; p.vy = (Math.random() - 0.5) * 4; p.vz = Math.random() * 3; p.max = p.life = 0.35; }
    else if (k === 'debris') { p.vx = (Math.random() - 0.5) * 6; p.vy = (Math.random() - 0.5) * 6; p.vz = 2 + Math.random() * 4; p.max = p.life = 0.9; p.size = 0.6 + Math.random(); p.col = o.col || '#5a6260'; }
    else if (k === 'smoke') { p.vx = (Math.random() - 0.5) * 0.4; p.vy = (Math.random() - 0.5) * 0.4; p.vz = 0.6; p.max = p.life = o.small ? 0.6 : 1.6; p.size = o.small ? 0.3 : 0.8 + Math.random() * 0.6; }
    else if (k === 'ember') { p.vz = 1.2; p.vx = (Math.random() - 0.5) * 0.5; p.max = p.life = 0.7; }
    else if (k === 'frost') { p.vx = (Math.random() - 0.5) * 2; p.vy = (Math.random() - 0.5) * 2; p.vz = 1; p.max = p.life = 0.8; }
    this.parts.push(p);
  }

  stepParticles(c, dt) {
    const S = this.S;
    const keep = [];
    for (const p of this.parts) {
      p.life -= dt;
      if (p.life <= 0) continue;
      p.x += p.vx * dt; p.y += p.vy * dt; p.z += p.vz * dt;
      if (p.kind === 'debris' || p.kind === 'spark') { p.vz -= 12 * dt; if (p.z < 0) { p.z = 0; p.vz *= -0.3; p.vx *= 0.6; p.vy *= 0.6; } }
      const k = p.life / p.max;
      const X = this.sx(p.x), Y = this.sy(p.y, p.z);
      if (p.kind === 'spark') { c.fillStyle = p.col || `rgba(255,${200 + 55 * k | 0},120,${k})`; c.fillRect(X, Y, 2, 2); }
      else if (p.kind === 'ember') { c.fillStyle = `rgba(255,${120 + 100 * k | 0},40,${k})`; c.fillRect(X, Y, 2, 2); }
      else if (p.kind === 'frost') { c.fillStyle = `rgba(200,240,255,${k})`; c.fillRect(X, Y, 2, 2); }
      else if (p.kind === 'debris') { c.fillStyle = p.col; c.globalAlpha = Math.min(1, k * 2); c.fillRect(X, Y, S * 0.14 * p.size, S * 0.1 * p.size); c.globalAlpha = 1; }
      else if (p.kind === 'smoke') {
        const r = S * p.size * (1.4 - k);
        c.fillStyle = `rgba(60,64,62,${0.35 * k})`;
        c.beginPath(); c.arc(X, Y, r, 0, 7); c.fill();
      }
      keep.push(p);
    }
    this.parts = keep;
  }

  drawLine(c, l) {
    const k = (l.until - this.t) / l.dur;
    c.save();
    if (l.kind === 'zap') {
      c.strokeStyle = `rgba(190,215,255,${k})`; c.lineWidth = 2;
      c.beginPath();
      l.path.forEach(([x, y], i) => {
        const X = this.sx(x / FP), Y = this.sy(y / FP, 0.5);
        if (i === 0) c.moveTo(X, Y); else {
          const [px, py] = l.path[i - 1];
          const PX = this.sx(px / FP), PY = this.sy(py / FP, 0.5);
          for (let s = 1; s <= 4; s++) c.lineTo(lerp(PX, X, s / 4) + (Math.random() - 0.5) * 8, lerp(PY, Y, s / 4) + (Math.random() - 0.5) * 8);
        }
      });
      c.stroke();
    } else if (l.kind === 'flak') {
      c.strokeStyle = `rgba(255,230,150,${k})`; c.lineWidth = 1;
      c.beginPath(); c.moveTo(this.sx(l.x0), this.sy(l.y0, 0.6)); c.lineTo(this.sx(l.x1), this.sy(l.y1, l.z1)); c.stroke();
    } else if (l.kind === 'charge') {
      c.strokeStyle = `rgba(140,220,255,${0.3 + 0.5 * (1 - k)})`; c.lineWidth = 1 + 2 * (1 - k);
      c.setLineDash([8, 6]);
      c.beginPath(); c.moveTo(this.sx(l.x0), this.sy(l.y0, 0.55)); c.lineTo(this.sx(l.x1), this.sy(l.y1, 0.4)); c.stroke();
    }
    c.restore();
  }

  scorch(x, y, r, col = 'rgba(10,8,6,0.45)') {
    const d = this.decals.getContext('2d');
    const S = this.S * this.dpr;
    d.fillStyle = col;
    d.beginPath(); d.ellipse(x * S, y * S * K, r * S, r * S * K, 0, 0, Math.PI * 2); d.fill();
  }

  /** translate a server event into visuals */
  event(e, snap) {
    const S = this.S;
    switch (e.e) {
      case 'boom': {
        const x = e.x / FP, y = e.y / FP, r = (WEAPONS[e.w]?.radius || 256) / FP;
        this.flashes.push({ x, y, r: r * 1.5, until: this.t + 0.45, dur: 0.45, col: e.w === 'cryo' ? '#9fd8ff' : e.w === 'incin' ? '#ff7a2a' : '#e49b3c' });
        for (let k = 0; k < 18; k++) this.spawn(x, y, 0.2, { kind: e.w === 'cryo' ? 'frost' : 'spark' });
        for (let k = 0; k < 6; k++) this.spawn(x, y, 0.3, { kind: 'debris', col: '#3a3632' });
        for (let k = 0; k < 5; k++) this.spawn(x + (Math.random() - 0.5) * r, y + (Math.random() - 0.5) * r, 0.2, { kind: 'smoke' });
        this.scorch(x, y, r * 0.55, e.w === 'cryo' ? 'rgba(150,200,230,0.18)' : undefined);
        this.shake += 3;
        break;
      }
      case 'hit': {
        const x = e.x / FP, y = e.y / FP;
        for (let k = 0; k < 6; k++) this.spawn(x, y, 0.5, { kind: 'spark', col: e.w === 'emp' ? '#9fc4ff' : undefined });
        if (e.w === 'wreck' || e.w === 'rail') { this.shake += 4; this.flashes.push({ x, y, r: 1, until: this.t + 0.2, dur: 0.2 }); }
        break;
      }
      case 'wallDown': {
        const x = (e.i % W) + 0.5, y = Math.floor(e.i / W) + 0.5;
        for (let k = 0; k < 9; k++) this.spawn(x, y, 0.6, { kind: 'debris', col: e.s >= 0 ? (k % 3 ? '#626a66' : PCOL[e.s]) : '#626a66' });
        this.spawn(x, y, 0.5, { kind: 'smoke' });
        this.scorch(x - 0.5 + 0.5, y, 0.45, 'rgba(20,18,16,0.35)');
        break;
      }
      case 'gunDown':
        for (let k = 0; k < 14; k++) this.spawn(e.x + 0.5, e.y + 0.5, 0.6, { kind: 'debris', col: k % 2 ? '#555' : PCOL[e.s] });
        this.flashes.push({ x: e.x + 0.5, y: e.y + 0.5, r: 1.2, until: this.t + 0.4, dur: 0.4 });
        this.shake += 4;
        break;
      case 'reactorHit': {
        const p = snap.players[e.s];
        if (p) { this.flashes.push({ x: p.rx + 1, y: p.ry + 1, r: 1.3, until: this.t + 0.25, dur: 0.25, col: '#d34e3f' }); this.shake += Math.min(6, e.dmg / 25); }
        break;
      }
      case 'out': {
        const p = snap.players[e.s];
        if (!p) break;
        for (let k = 0; k < 60; k++) this.spawn(p.rx + 1, p.ry + 1, 1, { kind: k % 3 ? 'debris' : 'spark', col: k % 2 ? PCOL[e.s] : '#ffcf80' });
        for (let k = 0; k < 12; k++) this.spawn(p.rx + 1 + (Math.random() - 0.5) * 3, p.ry + 1 + (Math.random() - 0.5) * 3, 0.5, { kind: 'smoke' });
        this.flashes.push({ x: p.rx + 1, y: p.ry + 1, r: 4, until: this.t + 0.9, dur: 0.9, col: '#ffb060' });
        this.scorch(p.rx + 1, p.ry + 1, 2.4);
        this.shake += 12;
        break;
      }
      case 'zap': this.lines.push({ kind: 'zap', path: e.path, until: this.t + 0.18, dur: 0.18 }); break;
      case 'flak': {
        const g = snap.guns.find((q) => q[0] === e.id);
        if (g) this.lines.push({ kind: 'flak', x0: g[3] + 0.5, y0: g[4] + 0.5, x1: e.x / FP, y1: e.y / FP, z1: 1.5, until: this.t + 0.12, dur: 0.12 });
        break;
      }
      case 'pop': this.flashes.push({ x: e.x / FP, y: e.y / FP, r: 0.5, until: this.t + 0.2, dur: 0.2, col: '#ffe0a0' }); break;
      case 'charge': {
        const g = snap.guns.find((q) => q[0] === e.id);
        if (g) this.lines.push({ kind: 'charge', x0: g[3] + 0.5, y0: g[4] + 0.5, x1: e.x / FP, y1: e.y / FP, until: this.t + 2, dur: 2 });
        break;
      }
      case 'warn': this.warns.push({ x: e.x, y: e.y, r: e.r || 2, until: this.t + 2 }); break;
      case 'acid': {
        const x = e.x / FP, y = e.y / FP;
        this.flashes.push({ x, y, r: e.r / FP, until: this.t + 0.5, dur: 0.5, col: '#c6d13f' });
        for (let k = 0; k < 12; k++) this.spawn(x, y, 0.2, { kind: 'spark', col: '#d8f04a' });
        break;
      }
      case 'forklift': this.flashes.push({ x: e.x / FP, y: e.y / FP, r: 1.5, until: this.t + 0.5, dur: 0.5, col: '#e6cf45' }); this.shake += 3; break;
      case 'place': for (const i of e.cells) this.spawn((i % W) + 0.5, Math.floor(i / W) + 0.5, 0.9, { kind: 'spark', col: '#ffe9a0' }); break;
      default: break;
    }
  }
}

/** colour-blind safe crew glyphs: circle, triangle, square, diamond */
export function glyph(c, slot, x, y, r, col) {
  c.save();
  c.fillStyle = col;
  c.strokeStyle = '#0b1213';
  c.lineWidth = 1.5;
  c.beginPath();
  if (slot === 0) c.arc(x, y, r, 0, 7);
  else if (slot === 1) { c.moveTo(x, y - r); c.lineTo(x + r, y + r * 0.8); c.lineTo(x - r, y + r * 0.8); c.closePath(); }
  else if (slot === 2) c.rect(x - r * 0.85, y - r * 0.85, r * 1.7, r * 1.7);
  else { c.moveTo(x, y - r * 1.1); c.lineTo(x + r, y); c.lineTo(x, y + r * 1.1); c.lineTo(x - r, y); c.closePath(); }
  c.fill();
  c.stroke();
  c.restore();
}
