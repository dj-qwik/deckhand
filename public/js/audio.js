// Synthesised sound: mechanical one-shots and a small reactive percussion loop
// that strips down while building and kicks in during FIRE. No samples needed.
export class Audio {
  constructor(settings) {
    this.settings = settings;
    this.ctx = null;
    this.master = null;
    this.musicGain = null;
    this.intensity = 0;
    this.step = 0;
    this.loop = null;
    this.last = new Map();
  }
  unlock() {
    if (this.ctx) { if (this.ctx.state === 'suspended') this.ctx.resume(); return; }
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    this.ctx = new AC();
    this.master = this.ctx.createGain();
    this.master.connect(this.ctx.destination);
    this.musicGain = this.ctx.createGain();
    this.musicGain.connect(this.master);
    this.noiseBuf = this.ctx.createBuffer(1, this.ctx.sampleRate * 0.6, this.ctx.sampleRate);
    const d = this.noiseBuf.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
    this.apply();
  }
  apply() {
    if (!this.ctx) return;
    this.master.gain.value = (this.settings.volume ?? 70) / 100;
    this.musicGain.gain.value = this.settings.music ? 0.35 : 0;
  }
  noise(dur, { f = 1200, q = 1, type = 'bandpass', vol = 0.4, decay = dur } = {}) {
    const c = this.ctx, t = c.currentTime;
    const s = c.createBufferSource(); s.buffer = this.noiseBuf;
    const fl = c.createBiquadFilter(); fl.type = type; fl.frequency.value = f; fl.Q.value = q;
    const g = c.createGain(); g.gain.setValueAtTime(vol, t); g.gain.exponentialRampToValueAtTime(0.001, t + decay);
    s.connect(fl).connect(g).connect(this.master);
    s.start(t); s.stop(t + dur);
  }
  tone(f0, f1, dur, { type = 'square', vol = 0.15, out } = {}) {
    const c = this.ctx, t = c.currentTime;
    const o = c.createOscillator(); o.type = type;
    o.frequency.setValueAtTime(f0, t); o.frequency.exponentialRampToValueAtTime(Math.max(20, f1), t + dur);
    const g = c.createGain(); g.gain.setValueAtTime(vol, t); g.gain.exponentialRampToValueAtTime(0.001, t + dur);
    o.connect(g).connect(out || this.master);
    o.start(t); o.stop(t + dur + 0.02);
  }
  play(name, near = 1) {
    if (!this.ctx || !(this.settings.volume > 0)) return;
    const now = performance.now();
    if (now - (this.last.get(name) || 0) < 45) return;
    this.last.set(name, now);
    const v = Math.max(0.15, Math.min(1, near));
    switch (name) {
      case 'rivet': this.noise(0.06, { f: 2500, q: 3, vol: 0.25 * v }); this.tone(900, 300, 0.05, { vol: 0.05 * v }); break;
      case 'harpoon': this.tone(1600, 200, 0.18, { type: 'sawtooth', vol: 0.12 * v }); this.noise(0.12, { f: 3000, vol: 0.2 * v }); break;
      case 'mortar': case 'cryo': case 'incin': this.noise(0.25, { f: 300, q: 0.7, type: 'lowpass', vol: 0.5 * v }); this.tone(120, 50, 0.2, { type: 'sine', vol: 0.3 * v }); break;
      case 'rail': this.tone(200, 2400, 0.25, { type: 'sawtooth', vol: 0.12 * v }); this.noise(0.15, { f: 5000, vol: 0.25 * v }); break;
      case 'charge': this.tone(150, 1800, 1.9, { type: 'sine', vol: 0.06 * v }); break;
      case 'flak': this.noise(0.05, { f: 1800, q: 1, vol: 0.18 * v }); break;
      case 'emp': this.tone(2400, 600, 0.12, { type: 'square', vol: 0.06 * v }); break;
      case 'wreck': this.tone(90, 40, 0.4, { type: 'triangle', vol: 0.35 * v }); break;
      case 'welder': this.noise(0.2, { f: 4000, q: 6, vol: 0.25 * v }); this.tone(60, 55, 0.2, { type: 'square', vol: 0.05 * v }); break;
      case 'missile': this.noise(0.5, { f: 900, q: 0.5, vol: 0.2 * v, decay: 0.5 }); break;
      case 'cutter': this.noise(0.08, { f: 3500, q: 8, vol: 0.06 * v }); break;
      case 'boom': this.noise(0.6, { f: 220, q: 0.6, type: 'lowpass', vol: 0.7 * v, decay: 0.55 }); this.tone(80, 30, 0.4, { type: 'sine', vol: 0.4 * v }); break;
      case 'hit': this.noise(0.08, { f: 1400, q: 2, vol: 0.25 * v }); this.tone(500, 180, 0.08, { type: 'triangle', vol: 0.06 * v }); break;
      case 'wallDown': this.noise(0.35, { f: 600, q: 0.8, vol: 0.4 * v }); this.tone(220, 70, 0.3, { type: 'square', vol: 0.06 * v }); break;
      case 'place': this.tone(320, 260, 0.06, { type: 'square', vol: 0.08 }); this.noise(0.04, { f: 4000, q: 4, vol: 0.12 }); break;
      case 'nope': this.tone(180, 140, 0.12, { type: 'square', vol: 0.08 }); break;
      case 'ui': this.tone(900, 1200, 0.04, { type: 'square', vol: 0.04 }); break;
      case 'klaxon': this.tone(440, 330, 0.5, { type: 'sawtooth', vol: 0.1 }); setTimeout(() => this.tone(440, 330, 0.5, { type: 'sawtooth', vol: 0.1 }), 550); break;
      case 'alarm': this.tone(880, 660, 0.25, { type: 'square', vol: 0.08 }); break;
      case 'out': this.noise(1.6, { f: 160, q: 0.4, type: 'lowpass', vol: 0.9, decay: 1.5 }); this.tone(60, 20, 1.4, { type: 'sine', vol: 0.5 }); break;
      case 'win': [523, 659, 784, 1046].forEach((f, i) => setTimeout(() => this.tone(f, f, 0.22, { type: 'square', vol: 0.07 }), i * 140)); break;
      default: break;
    }
  }
  /** intensity 0 = build (sparse), 1 = fire (full) */
  setIntensity(k) { this.intensity = k; }
  startMusic() {
    if (!this.ctx || this.loop) return;
    const bpm = 132, stepMs = 60000 / bpm / 4;
    this.loop = setInterval(() => {
      if (!this.settings.music || !this.ctx) return;
      const s = this.step++ % 16;
      const hot = this.intensity > 0.5;
      const out = this.musicGain;
      if (s % 4 === 0 && (hot || s === 0 || s === 8)) this.tone(110, 40, 0.18, { type: 'sine', vol: 0.5, out });
      if (hot && (s === 4 || s === 12)) { const c = this.ctx, t = c.currentTime; const src = c.createBufferSource(); src.buffer = this.noiseBuf; const g = c.createGain(); g.gain.setValueAtTime(0.25, t); g.gain.exponentialRampToValueAtTime(0.001, t + 0.12); const f = c.createBiquadFilter(); f.type = 'highpass'; f.frequency.value = 1500; src.connect(f).connect(g).connect(out); src.start(t); src.stop(t + 0.15); }
      if (s % 2 === 1 && hot) { const c = this.ctx, t = c.currentTime; const src = c.createBufferSource(); src.buffer = this.noiseBuf; const g = c.createGain(); g.gain.setValueAtTime(0.06, t); g.gain.exponentialRampToValueAtTime(0.001, t + 0.04); const f = c.createBiquadFilter(); f.type = 'highpass'; f.frequency.value = 7000; src.connect(f).connect(g).connect(out); src.start(t); src.stop(t + 0.05); }
      const bass = [55, 55, 0, 55, 65, 0, 55, 0, 49, 49, 0, 49, 58, 0, 49, 0][s];
      if (bass && (hot || s % 8 === 0)) this.tone(bass, bass, 0.14, { type: 'sawtooth', vol: hot ? 0.09 : 0.05, out });
    }, stepMs);
  }
  stopMusic() { clearInterval(this.loop); this.loop = null; }
}
