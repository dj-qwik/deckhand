// Crew chatter: short, sarcastic text callouts. No voice. One line at a time,
// never more often than every few seconds, and a filter swaps the profanity out.
export const PERSONAS = [
  { id: 'rook', name: 'Rook Okafor', role: 'Shift foreman' },
  { id: 'dee', name: 'Dee Marchetti', role: 'Union steward' },
  { id: 'vosk', name: 'Old Man Vosk', role: 'Welder, 31 years' },
  { id: 'tamsin', name: 'Tamsin Pell', role: 'Night-shift rigger' },
  { id: 'hal', name: 'Hal Brandt', role: 'Crane operator' },
  { id: 'nix', name: 'Nix Arroyo', role: 'Apprentice, unpaid' },
  { id: 'margo', name: 'Margo Szabo', role: 'Safety officer (ironic)' },
  { id: 'temp', name: 'Temp #4411', role: 'Contract labour' },
];

const LINES = {
  weld: ['Weld it shut. Management bought cheap steel again.', 'Close the ring or we are all getting written up.', 'Walls first, heroics later.', 'Somebody fix that gap before it fixes us.'],
  arm: ['Bolt the guns inside the walls. Outside is for idiots.', 'Pick a gun. Any gun. Preferably the loud one.', 'Turrets in. Hands off the red button. For now.'],
  fire: ['Light them up.', 'Fire at will. Will is on break, so you do it.', 'Time to earn that hazard pay.', 'Shoot the hell out of them.'],
  breach: ['Reactor is naked. Put a damn wall on it.', 'HULL BREACH. FIX YOUR SHIT.', 'Who left the front door open?', 'We have a hole. A big, stupid hole.'],
  sealed: ['Ring is sealed. Nice welding, boss.', 'Locked up tight. For now.'],
  myWallDown: ['That was a load-bearing wall, asshole.', 'There goes the lunchroom.', 'Who signed off on this bullshit?', 'Patch it! Patch it!'],
  hitThem: ['Nice shot, asshole. Do it again.', 'Right in the paperwork.', 'Their foreman is crying. I can hear it.', 'Direct hit. Somebody is getting fired.'],
  reactorHit: ['Core is taking hits. My coffee is spilling.', 'Reactor at risk. So is my pension.', 'That hurt. That really hurt.'],
  enemyOut: ['Scratch one yard. Drinks are on them.', 'They are out. Somebody tell their supervisor.', 'Reactor down! Not ours, for once.'],
  meOut: ['We are toast. Clock out, everyone.', 'Well. That is a write-up.'],
  gunDown: ['Lost a turret. Put it on the incident report.', 'Gun is scrap. Again.'],
  warranty: ['CLAIM DENIED. We are still alive, somehow.'],
  idle: ['Management says this is a team-building exercise.', 'I fixed it with spite and a welding torch.', 'Is it lunch yet?'],
  win: ['Paycheck secured. Do not tell accounting.', 'Last yard standing. Union rules, baby.'],
};

const SWEARS = [
  [/\bhell\b/gi, 'heck'], [/\bdamn\b/gi, 'darn'], [/\bshit\b/gi, 'stuff'], [/\bbullshit\b/gi, 'nonsense'],
  [/\basshole\b/gi, 'pal'], [/\bass\b/gi, 'rear'], [/\bfuck\w*/gi, 'flip'],
];

export class Crew {
  constructor(el, settings) {
    this.el = el;
    this.settings = settings;
    this.next = 0;
    this.timer = null;
    this.used = new Map();
  }
  clean(s) {
    if (!this.settings.profanityFilter) return s;
    for (const [re, rep] of SWEARS) s = s.replace(re, rep);
    return s;
  }
  say(key, { force = false } = {}) {
    const now = performance.now();
    if (!force && now < this.next) return;
    const pool = LINES[key];
    if (!pool) return;
    const n = this.used.get(key) || 0;
    this.used.set(key, n + 1);
    const line = pool[(n + Math.floor(Math.random() * pool.length)) % pool.length];
    const who = PERSONAS.find((p) => p.id === this.settings.persona) || PERSONAS[0];
    this.el.textContent = `${who.name.split(' ')[0]}: ${this.clean(line)}`;
    this.next = now + 7000;
    clearTimeout(this.timer);
    this.timer = setTimeout(() => (this.el.textContent = ''), 4200);
  }
  clear() { this.el.textContent = ''; }
}
