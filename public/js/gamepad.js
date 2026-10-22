// Gamepad input (standard mapping: Xbox / PlayStation / most USB pads).
// Polled once per frame; exposes edge-triggered presses and dead-zoned sticks.
export const BTN = {
  A: 0, B: 1, X: 2, Y: 3, LB: 4, RB: 5, LT: 6, RT: 7, BACK: 8, START: 9, L3: 10, R3: 11,
  UP: 12, DOWN: 13, LEFT: 14, RIGHT: 15,
};
const DEAD = 0.18;
const dz = (v) => (Math.abs(v) < DEAD ? 0 : (v - Math.sign(v) * DEAD) / (1 - DEAD));

export class Pad {
  constructor() {
    this.prev = [];
    this.cur = [];
    this.axes = [0, 0, 0, 0];
    this.connected = false;
    this.lastActive = 0;
    this.repeatAt = {};
    window.addEventListener('gamepadconnected', () => { this.connected = true; window.dispatchEvent(new CustomEvent('dh-toast', { detail: 'Controller connected' })); });
    window.addEventListener('gamepaddisconnected', () => { this.connected = !!this.pad(); });
  }
  pad() {
    const list = navigator.getGamepads ? navigator.getGamepads() : [];
    for (const g of list) if (g && g.connected) return g;
    return null;
  }
  poll() {
    const g = this.pad();
    this.prev = this.cur;
    if (!g) { this.cur = []; this.axes = [0, 0, 0, 0]; this.connected = false; return false; }
    this.connected = true;
    this.cur = g.buttons.map((b) => b.pressed || b.value > 0.5);
    this.axes = [dz(g.axes[0] || 0), dz(g.axes[1] || 0), dz(g.axes[2] || 0), dz(g.axes[3] || 0)];
    if (this.cur.some(Boolean) || this.axes.some((a) => a !== 0)) this.lastActive = performance.now();
    return true;
  }
  down(b) { return !!this.cur[b]; }
  pressed(b) { return !!this.cur[b] && !this.prev[b]; }
  released(b) { return !this.cur[b] && !!this.prev[b]; }
  /** pressed, then auto-repeat while held (for d-pad stepping) */
  repeat(b, first = 320, every = 90) {
    const now = performance.now();
    if (this.pressed(b)) { this.repeatAt[b] = now + first; return true; }
    if (this.down(b) && now >= (this.repeatAt[b] || Infinity)) { this.repeatAt[b] = now + every; return true; }
    return false;
  }
  get active() { return this.connected && performance.now() - this.lastActive < 8000; }
}

export const pad = new Pad();
