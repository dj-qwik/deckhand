// Procedurally painted textures for the diorama: deck plates, steel panels,
// diamond plate, shutters, mesh, foam, corrugated containers, hazard tape.
// Deterministic (seeded) so every client paints the same yard.

const T = 96; // texture size in px

function rng(seed) {
  let s = seed >>> 0 || 1;
  return () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 4294967296);
}
function canvas(w = T, h = T) {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  return c;
}
const hex2rgb = (h) => { const n = parseInt(h.slice(1), 16); return [(n >> 16) & 255, (n >> 8) & 255, n & 255]; };
const rgba = (h, a) => { const [r, g, b] = hex2rgb(h); return `rgba(${r},${g},${b},${a})`; };

function speckle(c, r, n, col, maxA, size = 1.6) {
  for (let i = 0; i < n; i++) {
    c.fillStyle = rgba(col, r() * maxA);
    const s = 0.6 + r() * size;
    c.fillRect(r() * T, r() * T, s, s);
  }
}
function streaks(c, r, n, col, a) {
  for (let i = 0; i < n; i++) {
    const x = r() * T, y = r() * T * 0.6, len = 10 + r() * 40;
    const g = c.createLinearGradient(x, y, x, y + len);
    g.addColorStop(0, rgba(col, a));
    g.addColorStop(1, rgba(col, 0));
    c.fillStyle = g;
    c.fillRect(x, y, 1 + r() * 2.5, len);
  }
}
function rivet(c, x, y, r = 1.8) {
  c.fillStyle = 'rgba(0,0,0,0.45)';
  c.beginPath(); c.arc(x + 0.6, y + 0.8, r, 0, 7); c.fill();
  c.fillStyle = 'rgba(255,255,255,0.35)';
  c.beginPath(); c.arc(x - 0.3, y - 0.3, r * 0.75, 0, 7); c.fill();
}

/** steel wall panel: painted enamel, chipped to bare metal, rust runs, rivets */
function steel(base, seed) {
  const cv = canvas(), c = cv.getContext('2d'), r = rng(seed);
  c.fillStyle = base; c.fillRect(0, 0, T, T);
  const g = c.createLinearGradient(0, 0, T, T);
  g.addColorStop(0, 'rgba(255,255,255,0.08)'); g.addColorStop(1, 'rgba(0,0,0,0.12)');
  c.fillStyle = g; c.fillRect(0, 0, T, T);
  speckle(c, r, 900, '#000000', 0.12);
  speckle(c, r, 500, '#ffffff', 0.08);
  // chipped paint → bare metal
  for (let i = 0; i < 14; i++) {
    c.fillStyle = `rgba(170,170,160,${0.25 + r() * 0.3})`;
    c.beginPath(); c.ellipse(r() * T, r() * T, 1 + r() * 4, 0.6 + r() * 2.2, r() * 3, 0, 7); c.fill();
  }
  streaks(c, r, 7, '#8a4a1e', 0.35);
  // panel seams
  c.fillStyle = 'rgba(0,0,0,0.35)';
  c.fillRect(0, T / 2 - 1, T, 2); c.fillRect(T / 2 - 1, 0, 2, T);
  c.fillStyle = 'rgba(255,255,255,0.12)';
  c.fillRect(0, T / 2 + 1, T, 1); c.fillRect(T / 2 + 1, 0, 1, T);
  for (const x of [6, T / 2 - 6, T / 2 + 6, T - 6]) for (const y of [6, T / 2 - 6, T / 2 + 6, T - 6]) rivet(c, x, y);
  // stencil mark
  c.fillStyle = 'rgba(230,220,190,0.28)';
  c.font = '700 9px sans-serif';
  c.fillText(`${(seed % 90) + 10}-B`, 8, T - 10);
  return cv;
}

function diamondPlate(base, seed) {
  const cv = canvas(), c = cv.getContext('2d'), r = rng(seed);
  c.fillStyle = base; c.fillRect(0, 0, T, T);
  for (let y = 0; y < T; y += 8)
    for (let x = (y / 8) % 2 ? 4 : 0; x < T; x += 8) {
      c.save(); c.translate(x + 2, y + 2); c.rotate(((x + y) / 8) % 2 ? 0.7 : -0.7);
      c.fillStyle = 'rgba(255,255,255,0.16)'; c.fillRect(-3, -0.8, 6, 1.4);
      c.fillStyle = 'rgba(0,0,0,0.3)'; c.fillRect(-3, 0.6, 6, 0.9);
      c.restore();
    }
  speckle(c, r, 600, '#000000', 0.15);
  streaks(c, r, 4, '#3c2a1a', 0.3);
  c.strokeStyle = 'rgba(0,0,0,0.5)'; c.lineWidth = 3; c.strokeRect(1.5, 1.5, T - 3, T - 3);
  c.strokeStyle = 'rgba(255,255,255,0.12)'; c.lineWidth = 1; c.strokeRect(4, 4, T - 8, T - 8);
  for (const [x, y] of [[8, 8], [T - 8, 8], [8, T - 8], [T - 8, T - 8]]) rivet(c, x, y, 2.6);
  return cv;
}

function shutter(base, seed) {
  const cv = canvas(), c = cv.getContext('2d'), r = rng(seed);
  c.fillStyle = base; c.fillRect(0, 0, T, T);
  for (let y = 0; y < T; y += 12) {
    const g = c.createLinearGradient(0, y, 0, y + 12);
    g.addColorStop(0, 'rgba(255,255,255,0.18)'); g.addColorStop(0.5, 'rgba(0,0,0,0)'); g.addColorStop(1, 'rgba(0,0,0,0.45)');
    c.fillStyle = g; c.fillRect(0, y, T, 12);
  }
  speckle(c, r, 400, '#000000', 0.18);
  streaks(c, r, 5, '#7a3a14', 0.3);
  c.fillStyle = 'rgba(228,155,60,0.5)'; c.fillRect(0, T - 10, T, 4);
  return cv;
}

function mesh(base, seed) {
  const cv = canvas(), c = cv.getContext('2d');
  c.fillStyle = rgba(base, 0.35); c.fillRect(0, 0, T, T);
  c.strokeStyle = 'rgba(190,235,235,0.7)'; c.lineWidth = 1.2;
  for (let i = -T; i < T * 2; i += 8) {
    c.beginPath(); c.moveTo(i, 0); c.lineTo(i + T, T); c.stroke();
    c.beginPath(); c.moveTo(i, T); c.lineTo(i + T, 0); c.stroke();
  }
  c.strokeStyle = 'rgba(60,90,90,0.95)'; c.lineWidth = 5; c.strokeRect(2.5, 2.5, T - 5, T - 5);
  c.fillStyle = 'rgba(120,220,255,0.6)'; c.fillRect(T / 2 - 6, 5, 12, 3);
  return cv;
}

function foam(seed) {
  const cv = canvas(), c = cv.getContext('2d'), r = rng(seed);
  c.fillStyle = '#c9b25f'; c.fillRect(0, 0, T, T);
  for (let i = 0; i < 70; i++) {
    const x = r() * T, y = r() * T, s = 3 + r() * 9;
    const g = c.createRadialGradient(x - s * 0.3, y - s * 0.3, 0, x, y, s);
    g.addColorStop(0, 'rgba(255,245,200,0.75)'); g.addColorStop(0.6, 'rgba(220,195,110,0.4)'); g.addColorStop(1, 'rgba(120,95,40,0.35)');
    c.fillStyle = g; c.beginPath(); c.arc(x, y, s, 0, 7); c.fill();
  }
  return cv;
}

/** deck floor plate. accent = arena colour for painted guide lines */
function deck(base, accent, seed, opts = {}) {
  const cv = canvas(), c = cv.getContext('2d'), r = rng(seed);
  c.fillStyle = base; c.fillRect(0, 0, T, T);
  speckle(c, r, 1400, '#000000', 0.16, 2.2);
  speckle(c, r, 600, '#ffffff', 0.05, 1.5);
  // oil / grime blotches
  for (let i = 0; i < 3; i++) {
    const x = r() * T, y = r() * T, s = 8 + r() * 22;
    const g = c.createRadialGradient(x, y, 0, x, y, s);
    g.addColorStop(0, `rgba(0,0,0,${0.18 + r() * 0.2})`); g.addColorStop(1, 'rgba(0,0,0,0)');
    c.fillStyle = g; c.beginPath(); c.arc(x, y, s, 0, 7); c.fill();
  }
  // plate seams & bolts
  c.fillStyle = 'rgba(0,0,0,0.55)'; c.fillRect(0, 0, T, 2); c.fillRect(0, 0, 2, T);
  c.fillStyle = 'rgba(255,255,255,0.08)'; c.fillRect(0, 2, T, 1); c.fillRect(2, 0, 1, T);
  for (const [x, y] of [[7, 7], [T - 7, 7], [7, T - 7], [T - 7, T - 7]]) rivet(c, x, y, 2);
  if (opts.grate && r() < 0.5) {
    c.fillStyle = 'rgba(0,0,0,0.45)';
    for (let k = 0; k < 7; k++) c.fillRect(24, 22 + k * 7, T - 48, 3);
  }
  if (opts.line) { c.fillStyle = rgba(accent, 0.35); c.fillRect(0, T / 2 - 3, T, 6); }
  return cv;
}

function hazard() {
  const cv = canvas(T, 24), c = cv.getContext('2d');
  c.fillStyle = '#1b1b18'; c.fillRect(0, 0, T, 24);
  c.fillStyle = '#e49b3c';
  for (let x = -24; x < T + 24; x += 16) { c.beginPath(); c.moveTo(x, 24); c.lineTo(x + 8, 24); c.lineTo(x + 32, 0); c.lineTo(x + 24, 0); c.closePath(); c.fill(); }
  c.fillStyle = 'rgba(0,0,0,0.3)'; for (let i = 0; i < 200; i++) c.fillRect(Math.random() * T, Math.random() * 24, 1.5, 1.5);
  return cv;
}

function corrugated(base, seed) {
  const cv = canvas(), c = cv.getContext('2d'), r = rng(seed);
  c.fillStyle = base; c.fillRect(0, 0, T, T);
  for (let x = 0; x < T; x += 6) {
    const g = c.createLinearGradient(x, 0, x + 6, 0);
    g.addColorStop(0, 'rgba(255,255,255,0.2)'); g.addColorStop(0.5, 'rgba(0,0,0,0.05)'); g.addColorStop(1, 'rgba(0,0,0,0.35)');
    c.fillStyle = g; c.fillRect(x, 0, 6, T);
  }
  speckle(c, r, 500, '#000000', 0.2);
  streaks(c, r, 9, '#6a3412', 0.4);
  c.fillStyle = 'rgba(240,235,220,0.55)'; c.font = '700 13px sans-serif';
  c.fillText(['DKH', 'SALV', 'RHC', 'FRT9'][seed % 4], 10, 22);
  return cv;
}

function planks(seed) {
  const cv = canvas(), c = cv.getContext('2d'), r = rng(seed);
  c.fillStyle = '#7a5a32'; c.fillRect(0, 0, T, T);
  for (let y = 0; y < T; y += 16) { c.fillStyle = `rgba(0,0,0,${0.15 + r() * 0.15})`; c.fillRect(0, y, T, 2); }
  speckle(c, r, 400, '#2a1a0a', 0.3);
  c.strokeStyle = 'rgba(40,25,10,0.7)'; c.lineWidth = 5; c.strokeRect(2.5, 2.5, T - 5, T - 5);
  c.beginPath(); c.moveTo(4, 4); c.lineTo(T - 4, T - 4); c.stroke();
  return cv;
}

let cache = null;
/** build every texture once */
export function textures(arenaLook) {
  const key = arenaLook.floor + arenaLook.accent;
  if (cache && cache.key === key) return cache;
  const t = {
    key,
    size: T,
    steel: [steel('#7c8580', 11), steel('#768079', 23), steel('#828a84', 37)],
    heavy: [diamondPlate('#5d6b6d', 5), diamondPlate('#566466', 9)],
    shutter: [shutter('#6d7468', 3)],
    mesh: [mesh('#2f5254', 4)],
    foam: [foam(7), foam(8)],
    floor: [0, 1, 2, 3].map((k) => deck(arenaLook.floor, arenaLook.accent, 100 + k, { grate: k === 2 })),
    field: [0, 1, 2, 3].map((k) => deck(arenaLook.field, arenaLook.accent, 200 + k, { grate: k % 2 === 0, line: k === 3 })),
    hazard: hazard(),
    container: [corrugated(arenaLook.container || '#3f78b8', 1), corrugated(arenaLook.container2 || '#b85a2f', 2), corrugated('#4f7d3a', 3)],
    planks: planks(5),
  };
  cache = t;
  return t;
}

export { rgba, hex2rgb };
