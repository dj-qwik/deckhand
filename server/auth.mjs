// Wallet sign-in. The player's Privy embedded wallet signs one message that is both
// proof of address and the 21+ / entertainment-only statement. We keep that signed
// record per wallet and hand back a short-lived HMAC session token.
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { recoverPersonal, isAddress, checksum, sameAddr } from './eth.mjs';

const TOKEN_TTL_MS = 7 * 24 * 3600 * 1000;
const CHALLENGE_TTL_MS = 10 * 60 * 1000;

export const CONSENT_LINES = [
  'I confirm I am 21 or older and that paid skill games are legal where I am.',
  'I understand DECKHAND matches are for entertainment, entry fees are at risk, and only the winner is paid.',
];

export class Auth {
  constructor({ secret, chainId, db, appName = 'DECKHAND' }) {
    this.key = createHmac('sha256', 'deckhand-session').update(secret || randomBytes(32)).digest();
    this.chainId = chainId;
    this.db = db;
    this.appName = appName;
    this.challenges = new Map();
  }

  challenge(wallet, host) {
    if (!isAddress(wallet)) throw new Error('bad wallet');
    wallet = checksum(wallet);
    const nonce = randomBytes(12).toString('hex');
    const issued = new Date().toISOString();
    const message = [
      `${this.appName} sign-in${host ? ' at ' + host : ''}`,
      '',
      `Wallet: ${wallet}`,
      `Chain ID: ${this.chainId}`,
      `Nonce: ${nonce}`,
      `Issued: ${issued}`,
      '',
      ...CONSENT_LINES,
    ].join('\n');
    this.challenges.set(nonce, { wallet, message, at: Date.now() });
    for (const [k, v] of this.challenges) if (Date.now() - v.at > CHALLENGE_TTL_MS) this.challenges.delete(k);
    return { message, nonce };
  }

  async verify({ wallet, nonce, signature }) {
    const c = this.challenges.get(nonce);
    if (!c || !sameAddr(c.wallet, wallet)) throw new Error('Sign-in request expired. Try again.');
    this.challenges.delete(nonce);
    let signer;
    try { signer = recoverPersonal(c.message, signature); } catch { throw new Error('Bad signature'); }
    if (!sameAddr(signer, c.wallet)) throw new Error('Signature does not match the wallet');
    const existing = await this.db.getConsent(c.wallet);
    if (!existing) await this.db.saveConsent(c.wallet, { wallet: c.wallet, message: c.message, signature, at: new Date().toISOString() });
    return { token: this.issue(c.wallet), wallet: c.wallet, firstTime: !existing };
  }

  issue(wallet) {
    const body = Buffer.from(JSON.stringify({ w: checksum(wallet), e: Date.now() + TOKEN_TTL_MS })).toString('base64url');
    return body + '.' + createHmac('sha256', this.key).update(body).digest('base64url');
  }

  /** returns the checksummed wallet for a valid token, else null */
  check(token) {
    if (typeof token !== 'string' || !token.includes('.')) return null;
    const [body, mac] = token.split('.');
    const want = createHmac('sha256', this.key).update(body).digest();
    let got;
    try { got = Buffer.from(mac, 'base64url'); } catch { return null; }
    if (got.length !== want.length || !timingSafeEqual(got, want)) return null;
    try {
      const { w, e } = JSON.parse(Buffer.from(body, 'base64url').toString());
      if (Date.now() > e || !isAddress(w)) return null;
      return checksum(w);
    } catch { return null; }
  }
}
