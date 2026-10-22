// Isometric 2.5D diorama renderer (Canvas 2D) with painted textures.
// Draws the authoritative state the server streams; it decides nothing.
import { W, H, FP, RS, PIECE_IDS, PIECES, WEAPONS } from '/sim/rules.js';
import { PROP } from '/sim/arenas.js';
import { textures, rgba } from './textures.js';

export const PCOL = ['#3fc1b4', '#f08a3a', '#d65fb8', '#e6cf45'];
const MAT_H = { steel: 1.0, heavy: 1.3, shutter: 1.12, mesh: 0.85, foam: 0.6 };
const YAW = (23 * Math.PI) / 180; // board yaw on screen (45° would be classic isometric)
const COS = Math.cos(YAW), SIN = Math.sin(YAW);
const KV = 0.52; // vertical squash of the ground plane
const ZS = 0.9; // pixels of height per unit, × cell size
const LOOK = {
  rustdock: { floor: '#3b3a36', field: '#35302b', accent: '#c4642e', container: '#a8522c', container2: '#3f78b8', sky: ['#1a1410', '#05070a'], neb: 'rgba(196,100,46,0.10)' },
  graveyard: { floor: '#343b36', field: '#2e352f', accent: '#7bcf6a', container: '#4f6b3a', container2: '#6a6f60', sky: ['#0d1a12', '#040806'], neb: 'rgba(110,200,90,0.09)' },
  freightliner: { floor: '#333a42', field: '#2c333b', accent: '#4c86c8', container: '#3f78b8', container2: '#b85a2f', sky: ['#0b1424', '#03050a'], neb: 'rgba(70,120,200,0.12)' },
  refinery: { floor: '#3a3c31', field: '#34362a', accent: '#c6d13f', container: '#8a8f2c', container2: '#5c6a3a', sky: ['#14180a', '#050604'], neb: 'rgba(190,210,60,0.09)' },
  vacuum: { floor: '#353d44', field: '#2f373e', accent: '#9fd2ea', container: '#6c8798', container2: '#3f78b8', sky: ['#0c1620', '#020407'], neb: 'rgba(150,210,240,0.10)' },
};

const lerp = (a, b, t) => a + (b - a) * t;
const lerp2 = (a, b, t) => [lerp(a[0], b[0], t), lerp(a[1], b[1], t)];
const shade = (hex, f) => {
  const n = parseInt(hex.slice(1), 16);
  const c = (v) => Math.min(255, Math.max(0, Math.round(v * f)));
  return `rgb(${c((n >> 16) & 255)},${c((n >> 8) & 255)},${c(n & 255)})`;
};

export class Renderer {
  constructor(canvas, settings) {
    this.cv = canvas;
    this.ctx = canvas.getContext('2d');
    this.settings = settings;
    this.TW = 32;
    this.TH = 16;
    this.ox = 0;
    this.oy = 0;
    this.zoom = 1;
    this.pan = [0, 0];
    this.floor = document.createElement('canvas');
    this.decals = document.createElement('canvas');
    this.decalList = [];
    this.sprites = new Map();
    this.parts = [];
    this.flashes = [];
    this.lines = [];
    this.warns = [];
    this.shake = 0;
    this.flatten = false;
    this.t = 0;
    this.state = null;
    this.stars = Array.from({ length: 260 }, () => [Math.random(), Math.random(), Math.random()]);
    this.resize();
  }

  // ================================================================ geometry
  resize() {
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const w = this.cv.clientWidth || window.innerWidth, h = this.cv.clientHeight || window.innerHeight;
    this.cv.width = Math.round(w * dpr);
    this.cv.height = Math.round(h * dpr);
    this.dpr = dpr;
    this.vw = w;
    this.vh = h;
    const sc = (this.settings.uiScale || 100) / 100;
    const top = Math.round(84 * sc + 8), bot = Math.round(140 * sc + 4);
    const availW = w - 8, availH = h - top - bot;
    // projected extents of the board (unit cell size), plus headroom for tall props
    const xs = [0, W * COS, W * COS - H * SIN, -H * SIN];
    const ys = [0, W * SIN * KV, (W * SIN + H * COS) * KV, H * COS * KV];
    const bw = Math.max(...xs) - Math.min(...xs), bh = Math.max(...ys) - Math.min(...ys) + 1.6;
    const fit = Math.min(availW / bw, availH / bh) * 1.04; // corners may tuck under the HUD a little
    this.S = Math.max(6, fit * this.zoom);
    this.K = KV;
    this.TW = this.S * Math.SQRT2; // size reference for details
    this.TH = this.TW / 2;
    this.zpx = this.S * ZS;
    const cx = w / 2 + this.pan[0], cy = top + availH / 2 + this.S * 0.8 + this.pan[1];
    const mx = W / 2, my = H / 2;
    this.ox = cx - (mx * COS - my * SIN) * this.S;
    this.oy = cy - (mx * SIN + my * COS) * this.S * KV;
    this.sprites.clear();
    this.floorDirty = true;
    this.decals.width = this.cv.width;
    this.decals.height = this.cv.height;
  }

  zoomBy(f, px, py) {
    const before = this.toCell(px, py);
    this.zoom = Math.max(1, Math.min(3, this.zoom * f));
    if (this.zoom === 1) this.pan = [0, 0];
    this.resize();
    if (this.zoom > 1) {
      const [ax, ay] = this.iso(before[0], before[1], 0);
      this.pan[0] += px - ax;
      this.pan[1] += py - ay;
      this.clampPan();
      this.resize();
    }
  }
  panBy(dx, dy) { if (this.zoom <= 1) return; this.pan[0] += dx; this.pan[1] += dy; this.clampPan(); this.resize(); }
  resetView() { this.zoom = 1; this.pan = [0, 0]; this.resize(); }
  clampPan() {
    const lim = (this.zoom - 1) * Math.max(this.vw, this.vh) * 0.7 + 40;
    this.pan[0] = Math.max(-lim, Math.min(lim, this.pan[0]));
    this.pan[1] = Math.max(-lim, Math.min(lim, this.pan[1]));
  }

  /** ground cell coords (+ height in cell units) → screen px */
  iso(x, y, z = 0) {
    return [this.ox + (x * COS - y * SIN) * this.S, this.oy + (x * SIN + y * COS) * this.S * KV - z * this.zpx];
  }
  /** screen px → ground cell coords */
  toCell(px, py) {
    const u = (px - this.ox) / this.S, v = (py - this.oy) / (this.S * KV);
    return [u * COS + v * SIN, -u * SIN + v * COS];
  }

  setMatch(state) {
    this.state = state;
    this.look = LOOK[state.arena] || LOOK.rustdock;
    this.tex = textures(this.look);
    this.sprites.clear();
    this.floorDirty = true;
    this.decalList = [];
    this.decals.getContext('2d').clearRect(0, 0, this.decals.width, this.decals.height);
    this.parts = [];
  }

  // ============================================================== primitives
  /** paint `tex` onto the parallelogram p0 → pu (u axis), p0 → pv (v axis) */
  texQuad(c, tex, p0, pu, pv, alpha = 1) {
    c.save();
    c.transform((pu[0] - p0[0]) / tex.width, (pu[1] - p0[1]) / tex.width, (pv[0] - p0[0]) / tex.height, (pv[1] - p0[1]) / tex.height, p0[0], p0[1]);
    c.globalAlpha = alpha;
    c.drawImage(tex, 0, 0);
    c.restore();
  }
  poly(c, pts, fill, stroke, lw = 1) {
    c.beginPath();
    c.moveTo(pts[0][0], pts[0][1]);
    for (let i = 1; i < pts.length; i++) c.lineTo(pts[i][0], pts[i][1]);
    c.closePath();
    if (fill) { c.fillStyle = fill; c.fill(); }
    if (stroke) { c.strokeStyle = stroke; c.lineWidth = lw; c.stroke(); }
  }
  /** iso box over ground rect [x0,x1]×[y0,y1] between heights z0..z1 */
  box(c, x0, y0, x1, y1, z0, z1, tTop, tSide, opts = {}) {
    const N = this.iso(x0, y0, z1), E = this.iso(x1, y0, z1), S = this.iso(x1, y1, z1), Wt = this.iso(x0, y1, z1);
    const Eg = this.iso(x1, y0, z0), Sg = this.iso(x1, y1, z0), Wg = this.iso(x0, y1, z0);
    if (tSide) this.texQuad(c, tSide, Wt, S, Wg); else this.poly(c, [Wt, S, Sg, Wg], opts.side || '#555');
    this.poly(c, [Wt, S, Sg, Wg], `rgba(0,0,0,${opts.leftShade ?? 0.28})`);
    if (tSide) this.texQuad(c, tSide, S, E, Sg); else this.poly(c, [S, E, Eg, Sg], opts.side || '#555');
    this.poly(c, [S, E, Eg, Sg], `rgba(0,0,0,${opts.rightShade ?? 0.5})`);
    if (tTop) this.texQuad(c, tTop, N, E, Wt); else this.poly(c, [N, E, S, Wt], opts.top || '#888');
    c.strokeStyle = 'rgba(255,245,220,0.35)'; c.lineWidth = 1;
    c.beginPath(); c.moveTo(Wt[0], Wt[1]); c.lineTo(N[0], N[1]); c.lineTo(E[0], E[1]); c.stroke();
    c.strokeStyle = 'rgba(0,0,0,0.6)';
    c.beginPath(); c.moveTo(Wt[0], Wt[1]); c.lineTo(S[0], S[1]); c.lineTo(E[0], E[1]); c.moveTo(S[0], S[1]); c.lineTo(Sg[0], Sg[1]); c.stroke();
    return { N, E, S, Wt, Eg, Sg, Wg };
  }
  /** vertical iso cylinder centred on ground point (x,y), radius r in cells */
  cyl(c, x, y, r, z0, z1, side, top, opts = {}) {
    const [cx, cyb] = this.iso(x, y, z0), [, cyt] = this.iso(x, y, z1);
    const rx = r * this.S, ry = rx * KV;
    let fill = opts.fill;
    if (!fill) {
      fill = c.createLinearGradient(cx - rx, 0, cx + rx, 0);
      fill.addColorStop(0, shade(side, 0.55)); fill.addColorStop(0.35, shade(side, 1.15)); fill.addColorStop(0.7, shade(side, 0.85)); fill.addColorStop(1, shade(side, 0.45));
    }
    c.fillStyle = fill;
    c.beginPath();
    c.ellipse(cx, cyb, rx, ry, 0, 0, Math.PI);
    c.lineTo(cx - rx, cyt);
    c.ellipse(cx, cyt, rx, ry, 0, Math.PI, 0, true);
    c.closePath();
    c.fill();
    if (top) { c.fillStyle = top; c.beginPath(); c.ellipse(cx, cyt, rx, ry, 0, 0, 7); c.fill(); }
    c.strokeStyle = 'rgba(0,0,0,0.45)'; c.lineWidth = 1; c.beginPath(); c.ellipse(cx, cyt, rx, ry, 0, 0, 7); c.stroke();
    return { cx, cyb, cyt, rx, ry };
  }

  // ==================================================================== floor
  buildFloor() {
    const st = this.state, d = this.dpr, look = this.look, tex = this.tex;
    this.floor.width = this.cv.width;
    this.floor.height = this.cv.height;
    const c = this.floor.getContext('2d');
    c.setTransform(d, 0, 0, d, 0, 0);
    // space beyond the hull: gradient, nebula, stars
    const g = c.createLinearGradient(0, 0, 0, this.vh);
    g.addColorStop(0, look.sky[0]); g.addColorStop(1, look.sky[1]);
    c.fillStyle = g; c.fillRect(0, 0, this.vw, this.vh);
    for (let k = 0; k < 3; k++) {
      const nx = this.vw * (0.18 + 0.32 * k), ny = this.vh * (0.25 + 0.25 * (k % 2));
      const ng = c.createRadialGradient(nx, ny, 0, nx, ny, this.vw * 0.35);
      ng.addColorStop(0, look.neb); ng.addColorStop(1, 'rgba(0,0,0,0)');
      c.fillStyle = ng; c.fillRect(0, 0, this.vw, this.vh);
    }
    for (const [sx, sy, b] of this.stars) {
      c.fillStyle = `rgba(220,230,255,${0.25 + b * 0.6})`;
      c.fillRect(sx * this.vw, sy * this.vh, b > 0.85 ? 2 : 1, b > 0.85 ? 2 : 1);
    }
    // deck slab: thick hull edges on the two visible sides, hazard tape on the lip
    const slab = 1.6;
    const A = this.iso(0, H), B = this.iso(W, H), C = this.iso(W, 0);
    const dn = (p) => [p[0], p[1] + slab * this.zpx];
    this.poly(c, [A, B, dn(B), dn(A)], '#232a2c');
    this.poly(c, [B, C, dn(C), dn(B)], '#161c1e');
    for (let i = 0; i < W; i++) this.texQuad(c, tex.hazard, this.iso(i, H, -0.05), this.iso(i + 1, H, -0.05), this.iso(i, H, -0.35));
    for (let i = 0; i < H; i++) this.texQuad(c, tex.hazard, this.iso(W, H - i, -0.05), this.iso(W, H - i - 1, -0.05), this.iso(W, H - i, -0.35));
    c.strokeStyle = 'rgba(0,0,0,0.5)'; c.lineWidth = 2;
    for (let i = 2; i < W; i += 4) { const p = this.iso(i, H, -0.4), q = this.iso(i, H, -slab); c.beginPath(); c.moveTo(p[0], p[1]); c.lineTo(q[0], q[1]); c.stroke(); }
    for (let i = 2; i < H; i += 4) { const p = this.iso(W, i, -0.4), q = this.iso(W, i, -slab); c.beginPath(); c.moveTo(p[0], p[1]); c.lineTo(q[0], q[1]); c.stroke(); }
    // textured deck plates
    for (let y = 0; y < H; y++)
      for (let x = 0; x < W; x++) {
        const i = y * W + x;
        const yard = st.yard[i];
        const hsh = ((x * 73856093) ^ (y * 19349663)) >>> 0;
        const t = yard >= 0 ? tex.floor[hsh % 4] : tex.field[hsh % 4];
        this.texQuad(c, t, this.iso(x, y), this.iso(x + 1, y), this.iso(x, y + 1));
        if (yard >= 0) this.poly(c, [this.iso(x, y), this.iso(x + 1, y), this.iso(x + 1, y + 1), this.iso(x, y + 1)], rgba(PCOL[yard], 0.07));
      }
    // yard borders + painted yard IDs
    for (let s = 0; s < st.n; s++) {
      const [yx, yy] = st.players[s].yard;
      const Y = 14;
      c.save();
      c.setLineDash([this.TW * 0.45, this.TW * 0.25]);
      this.poly(c, [this.iso(yx + 0.1, yy + 0.1), this.iso(yx + Y - 0.1, yy + 0.1), this.iso(yx + Y - 0.1, yy + Y - 0.1), this.iso(yx + 0.1, yy + Y - 0.1)], null, rgba(PCOL[s], 0.8), Math.max(1.5, this.TW * 0.08));
      c.restore();
      c.save();
      const [lx, ly] = this.iso(yx + Y / 2, yy + Y - 1.6);
      c.translate(lx, ly);
      c.transform(COS, SIN * KV, -SIN, COS * KV, 0, 0);
      c.scale(this.S / 46, this.S / 46);
      c.fillStyle = rgba(PCOL[s], 0.25);
      c.font = '700 70px Chakra Petch, sans-serif';
      c.textAlign = 'center';
      c.fillText(`Y-0${s + 1}`, 0, 0);
      c.restore();
    }
    c.strokeStyle = rgba(look.accent, 0.2);
    c.lineWidth = Math.max(1, this.TW * 0.06);
    for (const yy of [H / 2 - 4, H / 2 + 4]) { const p = this.iso(16, yy), q = this.iso(W - 16, yy); c.beginPath(); c.moveTo(p[0], p[1]); c.lineTo(q[0], q[1]); c.stroke(); }
    for (let i = 0; i < W * H; i++) if (st.vent[i]) this.drawVent(c, i % W, (i / W) | 0);
    // replay floor decals at the current scale
    const dc = this.decals.getContext('2d');
    dc.setTransform(1, 0, 0, 1, 0, 0);
    dc.clearRect(0, 0, this.decals.width, this.decals.height);
    for (const dcl of this.decalList) this.paintDecal(dcl);
    this.floorDirty = false;
  }

  drawVent(c, x, y, glow = 0) {
    const [cx, cy] = this.iso(x + 0.5, y + 0.5);
    const rx = this.S * 0.5, ry = rx * KV;
    c.save();
    c.fillStyle = '#0d110c';
    c.beginPath(); c.ellipse(cx, cy, rx, ry, 0, 0, 7); c.fill();
    c.strokeStyle = glow ? `rgba(210,240,70,${0.4 + glow * 0.6})` : '#6f7e3c';
    c.lineWidth = 2; c.stroke();
    c.strokeStyle = 'rgba(120,140,60,0.7)'; c.lineWidth = 1;
    for (let k = -2; k <= 2; k++) { c.beginPath(); c.moveTo(cx - rx * 0.75, cy + k * ry * 0.3); c.lineTo(cx + rx * 0.75, cy + k * ry * 0.3); c.stroke(); }
    c.restore();
  }

  // ================================================================= sprites
  sprite(key, w, h, ax, ay, paint) {
    let s = this.sprites.get(key);
    if (s) return s;
    const cv = document.createElement('canvas');
    const d = this.dpr;
    cv.width = Math.ceil(w * d);
    cv.height = Math.ceil(h * d);
    const c = cv.getContext('2d');
    c.setTransform(d, 0, 0, d, 0, 0);
    paint(c);
    s = { cv, w: cv.width / d, h: cv.height / d, ax, ay };
    this.sprites.set(key, s);
    return s;
  }
  blit(c, s, x, y) { c.drawImage(s.cv, x - s.ax, y - s.ay, s.w, s.h); }

  /** textured wall block, cached per material × owner × damage tier */
  wallSprite(mat, owner, tier, brittle) {
    const hgt = this.flatten ? 0.18 : MAT_H[mat] || 1;
    const key = `w|${mat}|${owner}|${tier}|${brittle}|${hgt}`;
    const S0 = this.S, zp = this.zpx;
    const top = hgt * zp;
    const left = SIN * S0 + 1, wdt = (COS + SIN) * S0 + 2, hh = (SIN + COS) * S0 * KV + top + 3;
    return this.sprite(key, wdt, hh, left, top + 1, (c) => {
      const o = [left, top + 1];
      const P = (x, y, z) => [o[0] + (x * COS - y * SIN) * S0, o[1] + (x * SIN + y * COS) * S0 * KV - z * zp];
      const N = P(0, 0, hgt), E = P(1, 0, hgt), S = P(1, 1, hgt), Wt = P(0, 1, hgt), Eg = P(1, 0, 0), Sg = P(1, 1, 0), Wg = P(0, 1, 0);
      const tx = this.tex;
      const pick = (arr) => arr[(owner + 1 + tier) % arr.length];
      const tt = mat === 'heavy' ? pick(tx.heavy) : mat === 'shutter' ? tx.shutter[0] : mat === 'mesh' ? tx.mesh[0] : mat === 'foam' ? pick(tx.foam) : pick(tx.steel);
      this.texQuad(c, tt, Wt, S, Wg);
      this.poly(c, [Wt, S, Sg, Wg], 'rgba(10,14,16,0.30)');
      this.texQuad(c, tt, S, E, Sg);
      this.poly(c, [S, E, Eg, Sg], 'rgba(10,14,16,0.52)');
      this.texQuad(c, tt, N, E, Wt);
      if (owner >= 0 && !this.flatten) {
        const b0 = hgt - 0.1, b1 = hgt - 0.26;
        this.poly(c, [P(0, 1, b0), P(1, 1, b0), P(1, 1, b1), P(0, 1, b1)], rgba(PCOL[owner], 0.85));
        this.poly(c, [P(1, 1, b0), P(1, 0, b0), P(1, 0, b1), P(1, 1, b1)], rgba(PCOL[owner], 0.6));
      }
      if (owner >= 0) { c.strokeStyle = PCOL[owner]; c.lineWidth = 1.4; c.beginPath(); c.moveTo(Wt[0], Wt[1]); c.lineTo(N[0], N[1]); c.lineTo(E[0], E[1]); c.stroke(); }
      if (tier >= 1) {
        const soot = c.createLinearGradient(0, Sg[1], 0, N[1]);
        soot.addColorStop(0, 'rgba(15,10,6,0.0)'); soot.addColorStop(1, `rgba(15,10,6,${tier === 1 ? 0.35 : 0.6})`);
        this.poly(c, [N, E, Eg, Sg, Wg, Wt], soot);
        c.strokeStyle = 'rgba(8,6,4,0.85)'; c.lineWidth = 1.2;
        c.beginPath();
        c.moveTo(...lerp2(Wt, S, 0.3)); c.lineTo(lerp(Wt[0], S[0], 0.45), Wg[1] - (Wg[1] - Wt[1]) * 0.4); c.lineTo(...lerp2(Wg, Sg, 0.4));
        c.stroke();
        if (tier === 2) {
          this.poly(c, [E, lerp2(E, N, 0.45), lerp2(E, S, 0.5), lerp2(E, Eg, 0.35)], '#1a1512');
          c.strokeStyle = 'rgba(255,140,50,0.8)'; c.beginPath(); c.moveTo(...lerp2(E, N, 0.45)); c.lineTo(...lerp2(E, S, 0.5)); c.stroke();
        }
      }
      if (brittle) this.poly(c, [N, E, Eg, Sg, Wg, Wt], 'rgba(170,225,255,0.35)');
      c.strokeStyle = 'rgba(255,245,220,0.28)'; c.lineWidth = 1;
      c.beginPath(); c.moveTo(Wt[0], Wt[1]); c.lineTo(S[0], S[1]); c.lineTo(E[0], E[1]); c.stroke();
      c.strokeStyle = 'rgba(0,0,0,0.65)';
      c.beginPath(); c.moveTo(S[0], S[1]); c.lineTo(Sg[0], Sg[1]); c.moveTo(Wt[0], Wt[1]); c.lineTo(Wg[0], Wg[1]); c.lineTo(Sg[0], Sg[1]); c.lineTo(Eg[0], Eg[1]); c.lineTo(E[0], E[1]); c.stroke();
    });
  }

  // =================================================================== frame
  frame(dt, view) {
    const st = this.state;
    if (!st) return;
    this.t += dt;
    if (this.floorDirty) this.buildFloor();
    const c = this.ctx, dpr = this.dpr;
    c.setTransform(1, 0, 0, 1, 0, 0);
    c.drawImage(this.floor, 0, 0);
    let shx = 0, shy = 0;
    if (this.shake > 0 && this.settings.shake) {
      const m = Math.min(7, this.shake) * (this.settings.shake === 'low' ? 0.4 : 1);
      shx = (Math.random() - 0.5) * m; shy = (Math.random() - 0.5) * m;
    }
    this.shake = Math.max(0, this.shake - dt * 30);
    c.setTransform(1, 0, 0, 1, shx * dpr, shy * dpr);
    c.drawImage(this.decals, 0, 0);
    c.setTransform(dpr, 0, 0, dpr, shx * dpr, shy * dpr);
    const snap = view.snapCur;

    if (view.enclosedBy) {
      for (let i = 0; i < W * H; i++) {
        const o = view.enclosedBy[i];
        if (o < 0) continue;
        const x = i % W, y = (i / W) | 0;
        this.poly(c, [this.iso(x, y), this.iso(x + 1, y), this.iso(x + 1, y + 1), this.iso(x, y + 1)], rgba(PCOL[o], o === view.me ? 0.2 : 0.1));
      }
    }
    for (const f of snap.fires) {
      const [x, y, r] = f;
      const [cx, cy] = this.iso(x / FP, y / FP);
      const R = (r / FP) * this.S;
      const flick = 0.75 + 0.25 * Math.sin(this.t * 20 + x);
      const g = c.createRadialGradient(cx, cy, 1, cx, cy, R);
      g.addColorStop(0, `rgba(255,180,70,${0.6 * flick})`); g.addColorStop(1, 'rgba(200,60,20,0)');
      c.fillStyle = g; c.beginPath(); c.ellipse(cx, cy, R, R * KV, 0, 0, 7); c.fill();
      if (Math.random() < 0.5) this.spawn(x / FP + (Math.random() - 0.5) * r / FP, y / FP + (Math.random() - 0.5) * r / FP, 0.1, { kind: 'ember' });
    }
    this.warns = this.warns.filter((w) => w.until > this.t);
    for (const w of this.warns) {
      const p = 0.5 + 0.5 * Math.sin(this.t * 14);
      const [cx, cy] = this.iso(w.x + 0.5, w.y + 0.5);
      const R = w.r * this.S;
      c.strokeStyle = `rgba(228,155,60,${0.4 + 0.5 * p})`; c.lineWidth = 2; c.setLineDash([6, 4]);
      c.beginPath(); c.ellipse(cx, cy, R, R * KV, 0, 0, 7); c.stroke(); c.setLineDash([]);
      if (st.vent[w.y * W + w.x]) this.drawVent(c, w.x, w.y, p);
    }
    if (view.ghost) this.drawGhost(c, view.ghost);

    // depth-sorted structures: back diagonal first
    const guns = new Map();
    for (const g of snap.guns) guns.set(g[4] * W + g[3], g);
    const reactorAt = new Map();
    for (const p of snap.players) reactorAt.set((p.ry + 1) * W + (p.rx + 1), p);
    if (!this.order) {
      this.order = Array.from({ length: W * H }, (_, i) => i).sort((a, b) => {
        const da = (a % W) * SIN + ((a / W) | 0) * COS, db = (b % W) * SIN + ((b / W) | 0) * COS;
        return da - db || a - b;
      });
    }
    for (const i of this.order) {
      const x = i % W, y = (i / W) | 0;
      if (st.prop[i]) this.drawProp(c, x, y, st.prop[i]);
      if (st.hp[i] > 0) {
        const ratio = st.hp[i] / Math.max(1, st.max[i]);
        const tier = ratio > 0.7 ? 0 : ratio > 0.35 ? 1 : 2;
        const mat = PIECES[PIECE_IDS[st.kind[i]] || 'brace'].mat;
        const [sx, sy] = this.iso(x, y);
        this.blit(c, this.wallSprite(mat, st.owner[i], tier, st.brittle?.[i] ? 1 : 0), sx, sy);
        if (tier === 2 && Math.random() < 0.025) this.spawn(x + 0.5, y + 0.5, MAT_H[mat], { kind: 'spark' });
        if (tier === 2 && Math.random() < 0.01) this.spawn(x + 0.5, y + 0.5, MAT_H[mat], { kind: 'smoke', small: true });
      }
      const g = guns.get(i);
      if (g) this.drawGun(c, g, snap, view);
      const p = reactorAt.get(i);
      if (p) this.drawReactor(c, p, view);
    }
    for (const g of snap.guns) if (g[12]) this.drawBeam(c, g);
    this.drawProjectiles(c, view);
    this.lines = this.lines.filter((l) => l.until > this.t);
    for (const l of this.lines) this.drawLine(c, l);
    this.stepParticles(c, dt);
    this.flashes = this.flashes.filter((f) => f.until > this.t);
    for (const f of this.flashes) this.drawFlash(c, f);
    if (view.aim) this.drawAim(c, view.aim, snap);
    if (view.hover && !view.ghost) {
      const [x, y] = view.hover;
      this.poly(c, [this.iso(x, y), this.iso(x + 1, y), this.iso(x + 1, y + 1), this.iso(x, y + 1)], null, 'rgba(215,208,181,0.55)', 1);
    }
  }

  drawGhost(c, gh) {
    for (const [x, y] of gh.cells) {
      const pts = [this.iso(x, y), this.iso(x + 1, y), this.iso(x + 1, y + 1), this.iso(x, y + 1)];
      this.poly(c, pts, gh.ok ? 'rgba(145,203,160,0.38)' : 'rgba(211,78,63,0.38)', gh.ok ? '#91cba0' : '#d34e3f', 1.5);
      if (gh.ok && gh.block) {
        const up = pts.map(([a, b]) => [a, b - this.zpx]);
        c.strokeStyle = 'rgba(145,203,160,0.6)'; c.lineWidth = 1;
        for (let k = 0; k < 4; k++) { c.beginPath(); c.moveTo(pts[k][0], pts[k][1]); c.lineTo(up[k][0], up[k][1]); c.stroke(); }
        this.poly(c, up, 'rgba(145,203,160,0.12)', 'rgba(145,203,160,0.6)', 1);
      }
    }
    if (gh.label && gh.cells.length) {
      const [x, y] = gh.cells[0];
      const [sx, sy] = this.iso(x + 0.5, y + 0.5, 1.6);
      c.font = `600 ${Math.max(11, this.TW * 0.42)}px Chakra Petch, sans-serif`;
      c.textAlign = 'center';
      c.lineWidth = 3; c.strokeStyle = 'rgba(0,0,0,0.8)'; c.strokeText(gh.label, sx, sy);
      c.fillStyle = gh.ok ? '#91cba0' : '#ff8a7a'; c.fillText(gh.label, sx, sy);
    }
  }

  // ==================================================================== props
  drawProp(c, x, y, kind) {
    const tx = this.tex, f = this.flatten;
    const hh = (h) => (f ? 0.2 : h);
    if (kind === PROP.container) {
      const t = tx.container[(y >> 1) % 2];
      this.box(c, x, y, x + 1, y + 1, 0, hh(1.35), t, t, { leftShade: 0.2, rightShade: 0.45 });
    } else if (kind === PROP.crate) {
      this.box(c, x + 0.1, y + 0.1, x + 0.9, y + 0.9, 0, hh(0.8), tx.planks, tx.planks);
    } else if (kind === PROP.boom) {
      const b = this.box(c, x + 0.22, y + 0.22, x + 0.78, y + 0.78, 0, hh(2.8), null, null, { top: '#d9a933', side: '#b3871f', leftShade: 0.15, rightShade: 0.4 });
      c.strokeStyle = 'rgba(30,22,6,0.8)'; c.lineWidth = 1;
      for (let k = 0; k < 6; k++) {
        const z0 = (k * hh(2.8)) / 6, z1 = ((k + 1) * hh(2.8)) / 6;
        const a = this.iso(x + 0.22, y + 0.78, z0), bb = this.iso(x + 0.78, y + 0.78, z1);
        c.beginPath(); c.moveTo(a[0], a[1]); c.lineTo(bb[0], bb[1]); c.stroke();
      }
      if (!f && Math.sin(this.t * 6 + x) > 0.6) { c.fillStyle = 'rgba(255,80,40,0.95)'; c.beginPath(); c.arc(b.N[0], b.N[1] - 2, 3, 0, 7); c.fill(); }
    } else if (kind === PROP.core) {
      const r = this.cyl(c, x + 0.5, y + 0.5, 0.48, 0, hh(1.7), '#56645a', '#3a463e');
      if (!f) { c.fillStyle = `rgba(120,230,100,${0.35 + 0.2 * Math.sin(this.t * 3 + x)})`; c.fillRect(r.cx - r.rx * 0.25, r.cyt, r.rx * 0.5, r.cyb - r.cyt); }
    } else if (kind === PROP.vat) {
      const r = this.cyl(c, x + 0.5, y + 0.5, 0.47, 0, hh(1.6), '#9da53a', '#c8d24e');
      c.fillStyle = 'rgba(0,0,0,0.35)'; c.fillRect(r.cx - r.rx, lerp(r.cyt, r.cyb, 0.35), r.rx * 2, 2); c.fillRect(r.cx - r.rx, lerp(r.cyt, r.cyb, 0.7), r.rx * 2, 2);
      c.fillStyle = 'rgba(215,240,70,0.6)'; c.beginPath(); c.ellipse(r.cx, r.cyt, r.rx * 0.7, r.ry * 0.7, 0, 0, 7); c.fill();
    } else if (kind === PROP.pillar) {
      this.box(c, x + 0.15, y + 0.15, x + 0.85, y + 0.85, 0, hh(3.2), tx.heavy[1], tx.steel[1]);
    } else if (kind === PROP.bollard) {
      this.cyl(c, x + 0.5, y + 0.5, 0.22, 0, hh(0.6), '#d2a23c', '#e8c060');
    } else {
      this.box(c, x, y, x + 1, y + 1, 0, hh(1), null, null);
    }
  }

  // ===================================================================== guns
  drawGun(c, g, snap, view) {
    const [id, owner, w, x, y, hp, max, reload, stun, heat, over, wind] = g;
    const col = PCOL[owner];
    const f = this.flatten;
    const ph = f ? 0.12 : 0.32;
    this.box(c, x + 0.1, y + 0.1, x + 0.9, y + 0.9, 0, ph, this.tex.heavy[0], this.tex.steel[2], { leftShade: 0.3, rightShade: 0.5 });
    const ring = [this.iso(x + 0.1, y + 0.9, ph), this.iso(x + 0.9, y + 0.9, ph), this.iso(x + 0.9, y + 0.1, ph)];
    c.strokeStyle = col; c.lineWidth = 2; c.beginPath(); c.moveTo(...ring[0]); c.lineTo(...ring[1]); c.lineTo(...ring[2]); c.stroke();
    const z = f ? 0.2 : 0.55;
    const p = snap.players[owner];
    let ax, ay;
    if (p && p.active === id && p.aim && (view.me === owner || p.firing)) { ax = p.aim[0] / FP; ay = p.aim[1] / FP; }
    else {
      const foes = snap.players.filter((q) => q.slot !== owner && q.alive);
      const t = foes.find((q) => q.slot === p?.target) || foes[0];
      if (t) { ax = t.rx + RS / 2; ay = t.ry + RS / 2; } else { ax = x + 1; ay = y; }
    }
    const gx = x + 0.5, gy = y + 0.5;
    let dx = ax - gx, dy = ay - gy;
    const m = Math.hypot(dx, dy) || 1;
    dx /= m; dy /= m;
    const P = (along, side, zz) => this.iso(gx + dx * along - dy * side, gy + dy * along + dx * side, z + zz);
    const TWs = this.TW;
    const barrel = (len, side, zz, wdt, colr) => {
      const a = P(0.05, side, zz), b = P(len, side, zz);
      c.lineCap = 'round';
      c.strokeStyle = shade(colr, 0.5); c.lineWidth = wdt + 2;
      c.beginPath(); c.moveTo(a[0], a[1]); c.lineTo(b[0], b[1]); c.stroke();
      c.strokeStyle = colr; c.lineWidth = wdt;
      c.beginPath(); c.moveTo(a[0], a[1] - 0.6); c.lineTo(b[0], b[1] - 0.6); c.stroke();
      c.lineCap = 'butt';
    };
    const bodyCyl = (r, h, colr, topc) => this.cyl(c, gx, gy, r, z - 0.05, z + h, colr, topc || shade(colr, 1.25));
    switch (w) {
      case 'rivet': bodyCyl(0.28, 0.22, '#6b746f'); for (const s of [-0.1, 0, 0.1]) barrel(0.62, s, 0.12, TWs * 0.07, '#b9c0b8'); break;
      case 'harpoon': { bodyCyl(0.27, 0.25, '#56625f'); barrel(1.0, 0, 0.16, TWs * 0.06, '#d7dacd'); const tip = P(1.12, 0, 0.16); c.fillStyle = '#f0ead0'; c.beginPath(); c.arc(tip[0], tip[1], TWs * 0.06, 0, 7); c.fill(); break; }
      case 'cutter': { bodyCyl(0.3, 0.3, '#6c5a46'); barrel(0.5, 0, 0.18, TWs * 0.12, '#8a7458'); const tip = P(0.52, 0, 0.18); c.fillStyle = `rgba(255,${Math.max(60, 180 - heat * 2)},80,0.95)`; c.beginPath(); c.arc(tip[0], tip[1], TWs * 0.07, 0, 7); c.fill(); break; }
      case 'mortar': { const r = bodyCyl(0.33, 0.18, '#5c6561'); c.fillStyle = '#1d2222'; c.beginPath(); c.ellipse(r.cx, r.cyt, r.rx * 0.55, r.ry * 0.55, 0, 0, 7); c.fill(); this.cyl(c, gx, gy, 0.18, z + 0.18, z + 0.6, '#8b948c', '#202424'); break; }
      case 'rail': { bodyCyl(0.27, 0.22, '#47525c'); barrel(1.1, -0.09, 0.14, TWs * 0.045, '#b4c4d0'); barrel(1.1, 0.09, 0.14, TWs * 0.045, '#b4c4d0'); if (wind > 0) { const a = P(0.1, 0, 0.14), b = P(0.1 + 1.0 * (1 - wind / 40), 0, 0.14); c.strokeStyle = 'rgba(150,230,255,0.95)'; c.lineWidth = TWs * 0.05; c.beginPath(); c.moveTo(a[0], a[1]); c.lineTo(b[0], b[1]); c.stroke(); } break; }
      case 'flak': bodyCyl(0.3, 0.2, '#6d6c52'); for (const s of [-0.15, -0.05, 0.05, 0.15]) barrel(0.5, s, 0.14, TWs * 0.045, '#b0b39f'); break;
      case 'cryo': bodyCyl(0.3, 0.26, '#4f7684'); barrel(0.6, 0, 0.15, TWs * 0.11, '#86bccf'); this.cyl(c, gx - dx * 0.15, gy - dy * 0.15, 0.13, z + 0.26, z + 0.5, '#cbeefa', '#eaffff'); break;
      case 'emp': { bodyCyl(0.26, 0.22, '#3f4c6c'); barrel(0.58, 0, 0.13, TWs * 0.06, '#93a8cc'); const r = this.iso(gx, gy, z + 0.3); c.strokeStyle = 'rgba(160,210,255,0.85)'; c.lineWidth = 1.5; c.beginPath(); c.ellipse(r[0], r[1], TWs * 0.2, TWs * 0.2 * KV, 0, 0, 7); c.stroke(); break; }
      case 'incin': { this.cyl(c, gx, gy, 0.34, z - 0.05, z + 0.32, '#7e4b2b', '#a86a3c'); barrel(0.48, 0, 0.16, TWs * 0.12, '#a46a3c'); const tip = P(0.5, 0, 0.16); c.fillStyle = 'rgba(255,140,40,0.85)'; c.beginPath(); c.arc(tip[0], tip[1], TWs * 0.05, 0, 7); c.fill(); break; }
      case 'wreck': { bodyCyl(0.3, 0.2, '#555b58'); barrel(0.62, 0, 0.12, TWs * 0.08, '#6f6f6f'); const b = P(0.7, 0, 0.12); c.fillStyle = '#242424'; c.beginPath(); c.arc(b[0], b[1], TWs * 0.17, 0, 7); c.fill(); c.strokeStyle = '#888'; c.lineWidth = 1; c.stroke(); break; }
      case 'welder': { bodyCyl(0.26, 0.2, '#4c5658'); this.cyl(c, gx, gy, 0.07, z + 0.2, z + 0.85, '#7d8a8c'); const top = this.iso(gx, gy, z + 0.92); c.fillStyle = '#d6e4ff'; c.beginPath(); c.arc(top[0], top[1], TWs * 0.12, 0, 7); c.fill(); if (reload < 6) { c.strokeStyle = 'rgba(180,210,255,0.85)'; c.lineWidth = 1.2; c.beginPath(); c.moveTo(top[0], top[1]); c.lineTo(top[0] + (Math.random() - 0.5) * TWs * 0.6, top[1] - TWs * 0.25); c.stroke(); } break; }
      case 'missile': { const r = this.box(c, gx - 0.28, gy - 0.28, gx + 0.28, gy + 0.28, z - 0.05, z + 0.32, null, null, { top: '#6a7258', side: '#5c6450' }); c.fillStyle = '#d6c070'; for (const [u, v] of [[0.3, 0.3], [0.7, 0.3], [0.3, 0.7], [0.7, 0.7]]) { const q = lerp2(lerp2(r.N, r.E, u), lerp2(r.Wt, r.S, u), v); c.beginPath(); c.arc(q[0], q[1], TWs * 0.045, 0, 7); c.fill(); } break; }
      default: bodyCyl(0.3, 0.25, '#777');
    }
    const [lx, ly] = this.iso(x + 0.15, y + 0.15, ph + 0.05);
    c.fillStyle = col; c.beginPath(); c.arc(lx, ly, Math.max(2, TWs * 0.06), 0, 7); c.fill();
    const [hx, hy] = this.iso(x + 0.5, y + 0.5, z + 0.9);
    if (hp < max) {
      c.fillStyle = 'rgba(0,0,0,0.7)'; c.fillRect(hx - TWs * 0.3, hy, TWs * 0.6, 4);
      c.fillStyle = hp / max > 0.4 ? '#91cba0' : '#d34e3f'; c.fillRect(hx - TWs * 0.3, hy, (TWs * 0.6 * hp) / max, 4);
    }
    if (stun > 0) {
      c.strokeStyle = 'rgba(140,200,255,0.9)'; c.lineWidth = 1.5; c.beginPath();
      for (let k = 0; k < 3; k++) { const a = this.t * 9 + k * 2.1; c.moveTo(hx + Math.cos(a) * TWs * 0.25, hy + 6 + Math.sin(a) * TWs * 0.12); c.lineTo(hx + Math.cos(a + 0.6) * TWs * 0.4, hy + 6 + Math.sin(a + 0.6) * TWs * 0.2); }
      c.stroke();
    }
    if (over) { c.font = `700 ${Math.max(9, TWs * 0.3)}px Chakra Petch`; c.fillStyle = '#ff7a4a'; c.textAlign = 'center'; c.fillText('HOT', hx, hy - 2); }
    if (view.selectedGun === id) this.poly(c, [this.iso(x, y), this.iso(x + 1, y), this.iso(x + 1, y + 1), this.iso(x, y + 1)], null, '#e49b3c', 2);
  }

  drawBeam(c, g) {
    const [, , , x, y, , , , , , , , , bx, by] = g;
    const [x0, y0] = this.iso(x + 0.5, y + 0.5, 0.75), [x1, y1] = this.iso(bx / FP, by / FP, 0.6);
    c.save();
    c.globalCompositeOperation = 'lighter';
    c.lineCap = 'round';
    c.strokeStyle = 'rgba(255,140,60,0.35)'; c.lineWidth = this.TW * 0.3;
    c.beginPath(); c.moveTo(x0, y0); c.lineTo(x1, y1); c.stroke();
    c.strokeStyle = 'rgba(255,240,200,0.95)'; c.lineWidth = Math.max(1.5, this.TW * 0.07);
    c.beginPath(); c.moveTo(x0, y0);
    for (let k = 1; k <= 8; k++) c.lineTo(lerp(x0, x1, k / 8) + (Math.random() - 0.5) * 3, lerp(y0, y1, k / 8) + (Math.random() - 0.5) * 3);
    c.stroke();
    c.restore();
    if (Math.random() < 0.6) this.spawn(bx / FP, by / FP, 0.5, { kind: 'spark', col: '#ffb060' });
  }

  // ================================================================== reactor
  drawReactor(c, p, view) {
    const cx0 = p.rx + RS / 2, cy0 = p.ry + RS / 2;
    const col = PCOL[p.slot];
    const f = this.flatten;
    const tx = this.tex;
    this.box(c, p.rx, p.ry, p.rx + RS, p.ry + RS, 0, 0.22, tx.heavy[1], tx.hazard, { leftShade: 0.2, rightShade: 0.45 });
    if (!p.alive) {
      const [cx, cy] = this.iso(cx0, cy0, 0.22);
      const R = this.TW * 1.2;
      const g = c.createRadialGradient(cx, cy, 0, cx, cy, R);
      g.addColorStop(0, '#050505'); g.addColorStop(0.6, '#1d1612'); g.addColorStop(1, 'rgba(30,20,15,0)');
      c.fillStyle = g; c.beginPath(); c.ellipse(cx, cy, R, R * KV, 0, 0, 7); c.fill();
      for (let k = 0; k < 5; k++) { const a = k * 1.3; this.cyl(c, cx0 + Math.cos(a) * 0.9, cy0 + Math.sin(a) * 0.9, 0.1, 0.2, 0.4 + (k % 3) * 0.15, '#3a3330'); }
      if (Math.random() < 0.35) this.spawn(cx0 + (Math.random() - 0.5) * 1.5, cy0 + (Math.random() - 0.5) * 1.5, 0.3, { kind: 'smoke' });
      return;
    }
    const hpK = p.hp / 1000;
    const pulse = 0.5 + 0.5 * Math.sin(this.t * (2 + (1 - hpK) * 9));
    const glow = hpK > 0.5 ? col : hpK > 0.25 ? '#e49b3c' : '#d34e3f';
    const H1 = f ? 0.5 : 2.7;
    for (const [u, v] of [[0.35, 0.35], [RS - 0.35, 0.35], [0.35, RS - 0.35], [RS - 0.35, RS - 0.35]]) {
      this.cyl(c, p.rx + u, p.ry + v, 0.16, 0.22, f ? 0.4 : 1.15, '#8a9088', '#b9beb3');
      if (!f) {
        const a = this.iso(p.rx + u, p.ry + v, 1.0), b = this.iso(cx0, cy0, 1.6);
        c.strokeStyle = '#6d746c'; c.lineWidth = this.TW * 0.08;
        c.beginPath(); c.moveTo(a[0], a[1]); c.quadraticCurveTo((a[0] + b[0]) / 2, a[1] - this.TW * 0.3, b[0], b[1]); c.stroke();
      }
    }
    this.cyl(c, cx0, cy0, 1.15, 0.22, 0.75, '#5f6862', '#7c857e');
    const [gx] = this.iso(cx0, cy0);
    const rxc = 0.72 * this.S;
    const gr = c.createLinearGradient(gx - rxc, 0, gx + rxc, 0);
    gr.addColorStop(0, shade(glow, 0.35)); gr.addColorStop(0.45, rgba(glow, 0.75 + 0.25 * pulse)); gr.addColorStop(0.6, '#fff8e0'); gr.addColorStop(1, shade(glow, 0.3));
    const core = this.cyl(c, cx0, cy0, 0.72, 0.75, H1 - 0.35, glow, null, { fill: gr });
    if (!f) for (const zz of [1.15, 1.65, 2.1]) {
      const [rx0, ry0] = this.iso(cx0, cy0, zz);
      c.strokeStyle = '#c9cec6'; c.lineWidth = this.TW * 0.09;
      c.beginPath(); c.ellipse(rx0, ry0, core.rx * 1.08, core.ry * 1.08, 0, 0, Math.PI); c.stroke();
    }
    const cap = this.cyl(c, cx0, cy0, 0.85, H1 - 0.35, H1, '#6b736d', '#8a928b');
    glyph(c, p.slot, cap.cx, cap.cyt, this.TW * 0.2, col);
    c.save();
    c.globalCompositeOperation = 'lighter';
    const [hx, hy] = this.iso(cx0, cy0, H1 * 0.55);
    const hg = c.createRadialGradient(hx, hy, 0, hx, hy, this.TW * 2.2);
    hg.addColorStop(0, rgba(glow, 0.22 + 0.12 * pulse)); hg.addColorStop(1, 'rgba(0,0,0,0)');
    c.fillStyle = hg; c.beginPath(); c.arc(hx, hy, this.TW * 2.2, 0, 7); c.fill();
    c.restore();
    if (!p.enclosed) {
      const [bx, by] = this.iso(cx0, cy0, H1 + 0.2);
      const a = this.t * 6;
      c.save();
      c.globalCompositeOperation = 'lighter';
      c.fillStyle = 'rgba(255,60,40,0.35)';
      c.beginPath(); c.moveTo(bx, by); c.arc(bx, by, this.TW * 2.5, a, a + 0.5); c.closePath(); c.fill();
      c.beginPath(); c.moveTo(bx, by); c.arc(bx, by, this.TW * 2.5, a + Math.PI, a + Math.PI + 0.5); c.closePath(); c.fill();
      c.restore();
      c.fillStyle = '#ff4a3a'; c.beginPath(); c.arc(bx, by, this.TW * 0.09, 0, 7); c.fill();
      const [fx, fy] = this.iso(cx0, cy0, 0.05);
      c.strokeStyle = `rgba(211,78,63,${0.4 + 0.6 * pulse})`; c.lineWidth = 3;
      c.beginPath(); c.ellipse(fx, fy, this.S * 2.6, this.S * 2.6 * KV, 0, 0, 7); c.stroke();
      if (p.slot === view.me) {
        c.font = `700 ${Math.max(12, this.TW * 0.5)}px Chakra Petch, sans-serif`;
        c.textAlign = 'center'; c.lineWidth = 3; c.strokeStyle = 'rgba(0,0,0,0.85)';
        c.strokeText('BREACH', bx, by - this.TW * 0.5);
        c.fillStyle = '#ff6a5a'; c.fillText('BREACH', bx, by - this.TW * 0.5);
      }
    } else if (!f) {
      const [bx, by] = this.iso(cx0, cy0, H1 + 0.15);
      c.fillStyle = Math.sin(this.t * 3) > 0 ? '#91cba0' : '#3c6b4a'; c.beginPath(); c.arc(bx, by, this.TW * 0.07, 0, 7); c.fill();
    }
  }

  // ============================================================== projectiles
  drawProjectiles(c, view) {
    const snap = view.snapCur, prev = view.snapPrev, a = view.alpha;
    const pm = new Map();
    if (prev) for (const q of prev.proj) pm.set(q[0], q);
    const TW = this.TW;
    for (const q of snap.proj) {
      const [id, owner, w, x1, y1, z1, kind] = q;
      const p0 = pm.get(id) || q;
      const x = lerp(p0[3], x1, a) / FP, y = lerp(p0[4], y1, a) / FP, z = lerp(p0[5], z1, a) / FP;
      const zz = kind ? z * 1.1 : 0.6;
      const [X, Y] = this.iso(x, y, zz);
      const [Xg, Yg] = this.iso(x, y, 0);
      const col = PCOL[owner];
      if (kind) { c.fillStyle = 'rgba(0,0,0,0.4)'; c.beginPath(); c.ellipse(Xg, Yg, TW * 0.2, TW * 0.2 * KV, 0, 0, 7); c.fill(); }
      const glow = (r, s) => { const g = c.createRadialGradient(X, Y, 0, X, Y, r); g.addColorStop(0, s); g.addColorStop(1, 'rgba(0,0,0,0)'); c.fillStyle = g; c.beginPath(); c.arc(X, Y, r, 0, 7); c.fill(); };
      c.save();
      if (w === 'mortar' || w === 'incin' || w === 'cryo') {
        c.globalCompositeOperation = 'lighter';
        glow(TW * 0.6, w === 'cryo' ? 'rgba(120,200,255,0.55)' : w === 'incin' ? 'rgba(255,120,30,0.6)' : 'rgba(255,170,80,0.4)');
        c.globalCompositeOperation = 'source-over';
        c.fillStyle = w === 'cryo' ? '#cfefff' : w === 'incin' ? '#ffb05c' : '#4a504e';
        c.beginPath(); c.arc(X, Y, TW * 0.17, 0, 7); c.fill();
        c.strokeStyle = col; c.lineWidth = 2; c.stroke();
        if (Math.random() < 0.6) this.spawn(x, y, zz, { kind: 'smoke', small: true });
      } else if (w === 'missile') {
        c.globalCompositeOperation = 'lighter';
        glow(TW * 0.55, 'rgba(255,160,60,0.75)');
        c.globalCompositeOperation = 'source-over';
        c.fillStyle = '#e8e4d0'; c.beginPath(); c.arc(X, Y, TW * 0.11, 0, 7); c.fill();
        this.spawn(x, y, zz, { kind: 'smoke', small: true });
      } else if (w === 'wreck') {
        c.fillStyle = '#1c1c1c'; c.beginPath(); c.arc(X, Y, TW * 0.32, 0, 7); c.fill();
        c.strokeStyle = col; c.lineWidth = 2; c.stroke();
        c.fillStyle = 'rgba(255,255,255,0.3)'; c.beginPath(); c.arc(X - TW * 0.1, Y - TW * 0.1, TW * 0.08, 0, 7); c.fill();
      } else {
        const len = w === 'harpoon' || w === 'rail' ? 1.4 : w === 'flak' ? 0.3 : 0.8;
        const vx = x1 - p0[3], vy = y1 - p0[4];
        const mm = Math.hypot(vx, vy) || 1;
        const [tx, ty] = this.iso(x - (vx / mm) * len, y - (vy / mm) * len, zz);
        const tint = w === 'rail' ? '170,230,255' : w === 'emp' ? '150,190,255' : '255,215,140';
        c.globalCompositeOperation = 'lighter';
        const lg = c.createLinearGradient(X, Y, tx, ty);
        lg.addColorStop(0, `rgba(${tint},1)`); lg.addColorStop(1, `rgba(${tint},0)`);
        c.strokeStyle = lg; c.lineCap = 'round';
        c.lineWidth = w === 'rail' ? TW * 0.18 : w === 'flak' ? 2 : TW * 0.1;
        c.beginPath(); c.moveTo(X, Y); c.lineTo(tx, ty); c.stroke();
        glow(TW * (w === 'rail' ? 0.55 : 0.3), `rgba(${tint},0.55)`);
      }
      c.restore();
    }
  }

  drawAim(c, aim, snap) {
    const [X, Y] = this.iso(aim.x, aim.y);
    const r = this.TW * 0.45;
    c.strokeStyle = '#e49b3c'; c.lineWidth = 1.5;
    c.beginPath(); c.ellipse(X, Y, r, r * KV, 0, 0, 7); c.stroke();
    c.beginPath(); c.moveTo(X - r * 1.5, Y); c.lineTo(X - r * 0.6, Y); c.moveTo(X + r * 0.6, Y); c.lineTo(X + r * 1.5, Y); c.moveTo(X, Y - r * 0.9); c.lineTo(X, Y - r * 0.35); c.moveTo(X, Y + r * 0.35); c.lineTo(X, Y + r * 0.9); c.stroke();
    const g = snap.guns.find((q) => q[0] === aim.gun);
    if (!g) return;
    const w = WEAPONS[g[2]];
    const [gx, gy] = this.iso(g[3] + 0.5, g[4] + 0.5, 0.75);
    c.setLineDash([4, 5]);
    c.strokeStyle = 'rgba(228,155,60,0.65)';
    c.beginPath();
    if (w.kind === 'arc' || w.kind === 'missile') { c.moveTo(gx, gy); c.quadraticCurveTo((gx + X) / 2, Math.min(gy, Y) - this.TW * 3, X, Y); }
    else { c.moveTo(gx, gy); c.lineTo(X, Y); }
    c.stroke();
    c.setLineDash([]);
    if (w.radius) {
      const R = (w.radius / FP) * this.S;
      c.strokeStyle = 'rgba(211,78,63,0.55)';
      c.beginPath(); c.ellipse(X, Y, R, R * KV, 0, 0, 7); c.stroke();
    }
  }

  // ================================================================= effects
  spawn(x, y, z, o) {
    if (this.parts.length > 1100) return;
    const k = o.kind;
    const p = { x, y, z, vx: 0, vy: 0, vz: 0, life: 1, max: 1, kind: k, col: o.col, size: 1, rot: 0 };
    if (k === 'spark') { p.vx = (Math.random() - 0.5) * 4; p.vy = (Math.random() - 0.5) * 4; p.vz = Math.random() * 3; p.max = p.life = 0.4; }
    else if (k === 'debris') { p.vx = (Math.random() - 0.5) * 6; p.vy = (Math.random() - 0.5) * 6; p.vz = 2 + Math.random() * 4; p.max = p.life = 1.1; p.size = 0.6 + Math.random(); p.col = o.col || '#5a6260'; p.rot = Math.random() * 6; }
    else if (k === 'smoke') { p.vx = (Math.random() - 0.5) * 0.4; p.vy = (Math.random() - 0.5) * 0.4; p.vz = 0.7; p.max = p.life = o.small ? 0.7 : 1.8; p.size = o.small ? 0.25 : 0.7 + Math.random() * 0.6; }
    else if (k === 'ember') { p.vz = 1.2; p.vx = (Math.random() - 0.5) * 0.5; p.max = p.life = 0.8; }
    else if (k === 'frost') { p.vx = (Math.random() - 0.5) * 2; p.vy = (Math.random() - 0.5) * 2; p.vz = 1; p.max = p.life = 0.9; }
    this.parts.push(p);
  }

  stepParticles(c, dt) {
    const TW = this.TW;
    const keep = [];
    for (const p of this.parts) {
      p.life -= dt;
      if (p.life <= 0) continue;
      p.x += p.vx * dt; p.y += p.vy * dt; p.z += p.vz * dt;
      if (p.kind === 'debris' || p.kind === 'spark') { p.vz -= 12 * dt; if (p.z < 0) { p.z = 0; p.vz *= -0.3; p.vx *= 0.6; p.vy *= 0.6; } }
      const k = p.life / p.max;
      const [X, Y] = this.iso(p.x, p.y, p.z);
      if (p.kind === 'spark') { c.fillStyle = p.col || `rgba(255,${(200 + 55 * k) | 0},120,${k})`; c.fillRect(X, Y, 2, 2); }
      else if (p.kind === 'ember') { c.fillStyle = `rgba(255,${(120 + 100 * k) | 0},40,${k})`; c.fillRect(X, Y, 2, 2); }
      else if (p.kind === 'frost') { c.fillStyle = `rgba(200,240,255,${k})`; c.fillRect(X, Y, 2, 2); }
      else if (p.kind === 'debris') {
        c.save(); c.translate(X, Y); c.rotate(p.rot + this.t * 6); c.globalAlpha = Math.min(1, k * 2);
        c.fillStyle = p.col; c.fillRect(-TW * 0.06 * p.size, -TW * 0.04 * p.size, TW * 0.12 * p.size, TW * 0.08 * p.size);
        c.restore();
      } else if (p.kind === 'smoke') {
        const r = TW * p.size * (1.4 - k);
        c.fillStyle = `rgba(58,62,60,${0.38 * k})`;
        c.beginPath(); c.arc(X, Y, r, 0, 7); c.fill();
      }
      keep.push(p);
    }
    this.parts = keep;
  }

  drawFlash(c, f) {
    const k = (f.until - this.t) / f.dur;
    const [X, Y] = this.iso(f.x, f.y, 0.4);
    const R = f.r * this.TW * 0.8 * (1.3 - k * 0.3);
    c.save();
    c.globalCompositeOperation = 'lighter';
    const g = c.createRadialGradient(X, Y, 1, X, Y, R);
    g.addColorStop(0, `rgba(255,240,200,${0.95 * k})`); g.addColorStop(0.4, rgba(f.col || '#e49b3c', 0.6 * k)); g.addColorStop(1, 'rgba(0,0,0,0)');
    c.fillStyle = g; c.beginPath(); c.ellipse(X, Y, R, R * 0.75, 0, 0, 7); c.fill();
    c.restore();
    if (f.r >= 1) {
      const [gx, gy] = this.iso(f.x, f.y, 0);
      const Rw = f.r * this.TW * 0.8 * (1.8 - k);
      c.strokeStyle = `rgba(255,220,170,${0.5 * k})`; c.lineWidth = 2;
      c.beginPath(); c.ellipse(gx, gy, Rw, Rw * KV, 0, 0, 7); c.stroke();
    }
  }

  drawLine(c, l) {
    const k = (l.until - this.t) / l.dur;
    c.save();
    c.globalCompositeOperation = 'lighter';
    if (l.kind === 'zap') {
      c.strokeStyle = `rgba(190,215,255,${k})`; c.lineWidth = 2;
      c.beginPath();
      l.path.forEach(([x, y], i) => {
        const [X, Y] = this.iso(x / FP, y / FP, 0.8);
        if (i === 0) c.moveTo(X, Y);
        else {
          const [PX, PY] = this.iso(l.path[i - 1][0] / FP, l.path[i - 1][1] / FP, 0.8);
          for (let s = 1; s <= 4; s++) c.lineTo(lerp(PX, X, s / 4) + (Math.random() - 0.5) * 8, lerp(PY, Y, s / 4) + (Math.random() - 0.5) * 8);
        }
      });
      c.stroke();
    } else if (l.kind === 'flak') {
      c.strokeStyle = `rgba(255,230,150,${k})`; c.lineWidth = 1.2;
      const a = this.iso(l.x0, l.y0, 0.8), b = this.iso(l.x1, l.y1, l.z1);
      c.beginPath(); c.moveTo(a[0], a[1]); c.lineTo(b[0], b[1]); c.stroke();
    } else if (l.kind === 'charge') {
      c.strokeStyle = `rgba(140,220,255,${0.3 + 0.5 * (1 - k)})`; c.lineWidth = 1 + 2 * (1 - k); c.setLineDash([8, 6]);
      const a = this.iso(l.x0, l.y0, 0.7), b = this.iso(l.x1, l.y1, 0.5);
      c.beginPath(); c.moveTo(a[0], a[1]); c.lineTo(b[0], b[1]); c.stroke();
    }
    c.restore();
  }

  decal(x, y, r, col = 'rgba(10,8,6,0.5)') {
    const dcl = { x, y, r, col };
    this.decalList.push(dcl);
    if (this.decalList.length > 400) this.decalList.shift();
    this.paintDecal(dcl);
  }
  paintDecal({ x, y, r, col }) {
    const d = this.decals.getContext('2d');
    d.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    const [X, Y] = this.iso(x, y);
    const R = r * this.S;
    const g = d.createRadialGradient(X, Y, 0, X, Y, R);
    g.addColorStop(0, col); g.addColorStop(1, 'rgba(0,0,0,0)');
    d.fillStyle = g;
    d.beginPath(); d.ellipse(X, Y, R, R * KV, 0, 0, 7); d.fill();
  }

  /** translate a server event into visuals */
  event(e, snap) {
    switch (e.e) {
      case 'boom': {
        const x = e.x / FP, y = e.y / FP, r = (WEAPONS[e.w]?.radius || 256) / FP;
        this.flashes.push({ x, y, r: r * 1.5, until: this.t + 0.45, dur: 0.45, col: e.w === 'cryo' ? '#9fd8ff' : e.w === 'incin' ? '#ff7a2a' : '#e49b3c' });
        for (let k = 0; k < 18; k++) this.spawn(x, y, 0.2, { kind: e.w === 'cryo' ? 'frost' : 'spark' });
        for (let k = 0; k < 6; k++) this.spawn(x, y, 0.3, { kind: 'debris', col: '#3a3632' });
        for (let k = 0; k < 5; k++) this.spawn(x + (Math.random() - 0.5) * r, y + (Math.random() - 0.5) * r, 0.2, { kind: 'smoke' });
        this.decal(x, y, r * 0.75, e.w === 'cryo' ? 'rgba(150,200,230,0.3)' : undefined);
        this.shake += 3;
        break;
      }
      case 'hit': {
        const x = e.x / FP, y = e.y / FP;
        for (let k = 0; k < 7; k++) this.spawn(x, y, 0.6, { kind: 'spark', col: e.w === 'emp' ? '#9fc4ff' : undefined });
        if (e.w === 'wreck' || e.w === 'rail') { this.shake += 4; this.flashes.push({ x, y, r: 1, until: this.t + 0.2, dur: 0.2 }); }
        break;
      }
      case 'wallDown': {
        const x = (e.i % W) + 0.5, y = Math.floor(e.i / W) + 0.5;
        for (let k = 0; k < 11; k++) this.spawn(x, y, 0.7, { kind: 'debris', col: e.s >= 0 && k % 3 === 0 ? PCOL[e.s] : '#6a726d' });
        this.spawn(x, y, 0.5, { kind: 'smoke' });
        this.decal(x, y, 0.7, 'rgba(25,22,18,0.55)');
        break;
      }
      case 'gunDown':
        for (let k = 0; k < 16; k++) this.spawn(e.x + 0.5, e.y + 0.5, 0.7, { kind: 'debris', col: k % 2 ? '#555' : PCOL[e.s] });
        this.flashes.push({ x: e.x + 0.5, y: e.y + 0.5, r: 1.2, until: this.t + 0.4, dur: 0.4 });
        this.decal(e.x + 0.5, e.y + 0.5, 0.9);
        this.shake += 4;
        break;
      case 'reactorHit': {
        const p = snap.players[e.s];
        if (p) { this.flashes.push({ x: p.rx + RS / 2, y: p.ry + RS / 2, r: 1.6, until: this.t + 0.25, dur: 0.25, col: '#d34e3f' }); this.shake += Math.min(6, e.dmg / 25); }
        break;
      }
      case 'out': {
        const p = snap.players[e.s];
        if (!p) break;
        const x = p.rx + RS / 2, y = p.ry + RS / 2;
        for (let k = 0; k < 80; k++) this.spawn(x, y, 1.5, { kind: k % 3 ? 'debris' : 'spark', col: k % 2 ? PCOL[e.s] : '#ffcf80' });
        for (let k = 0; k < 14; k++) this.spawn(x + (Math.random() - 0.5) * 3, y + (Math.random() - 0.5) * 3, 0.5, { kind: 'smoke' });
        this.flashes.push({ x, y, r: 5, until: this.t + 1, dur: 1, col: '#ffb060' });
        this.decal(x, y, 3);
        this.shake += 12;
        break;
      }
      case 'zap': this.lines.push({ kind: 'zap', path: e.path, until: this.t + 0.18, dur: 0.18 }); break;
      case 'flak': {
        const g = snap.guns.find((q) => q[0] === e.id);
        if (g) this.lines.push({ kind: 'flak', x0: g[3] + 0.5, y0: g[4] + 0.5, x1: e.x / FP, y1: e.y / FP, z1: 1.8, until: this.t + 0.12, dur: 0.12 });
        break;
      }
      case 'pop': this.flashes.push({ x: e.x / FP, y: e.y / FP, r: 0.6, until: this.t + 0.2, dur: 0.2, col: '#ffe0a0' }); break;
      case 'charge': {
        const g = snap.guns.find((q) => q[0] === e.id);
        if (g) this.lines.push({ kind: 'charge', x0: g[3] + 0.5, y0: g[4] + 0.5, x1: e.x / FP, y1: e.y / FP, until: this.t + 2, dur: 2 });
        break;
      }
      case 'warn': this.warns.push({ x: e.x, y: e.y, r: e.r || 2, until: this.t + 2 }); break;
      case 'acid': {
        const x = e.x / FP, y = e.y / FP;
        this.flashes.push({ x, y, r: e.r / FP, until: this.t + 0.5, dur: 0.5, col: '#c6d13f' });
        for (let k = 0; k < 14; k++) this.spawn(x, y, 0.2, { kind: 'spark', col: '#d8f04a' });
        this.decal(x, y, e.r / FP, 'rgba(160,190,40,0.25)');
        break;
      }
      case 'forklift': this.flashes.push({ x: e.x / FP, y: e.y / FP, r: 1.5, until: this.t + 0.5, dur: 0.5, col: '#e6cf45' }); this.shake += 3; break;
      case 'place': for (const i of e.cells) for (let k = 0; k < 3; k++) this.spawn((i % W) + 0.5, Math.floor(i / W) + 0.5, 1, { kind: 'spark', col: '#ffe9a0' }); break;
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
