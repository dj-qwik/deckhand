// A DECKHAND co-signer. It never trusts the game server's result: it replays the
// full evidence itself and signs Result(matchId, winner, resultHash) only for
// what its own replay produced.
//
// Embedded mode (default on Render): forked by the server, talks over IPC.
//   env: COSIGNER_SECRET, COSIGNER_ROLE (cosignerA|cosignerB), CHAIN_ID, [COSIGNER_ESCROW]
// Standalone mode (hardened setup on another host):
//   node server/cosigner.mjs --http   env: PORT, COSIGNER_AUTH_TOKEN, plus the above
import http from 'node:http';
import { deriveKey, addressOf, signDigest, resultDigest, sameAddr } from './eth.mjs';
import { verifyEvidence } from './verify.mjs';

const role = process.env.COSIGNER_ROLE || 'cosignerA';
const key = deriveKey(process.env.COSIGNER_SECRET, role);
const address = addressOf(key);
const chainId = Number(process.env.CHAIN_ID || 46630);
const pinnedEscrow = process.env.COSIGNER_ESCROW || '';

export function sign(evidence) {
  if (Number(evidence.chainId) !== chainId) throw new Error(`evidence is for chain ${evidence.chainId}, I sign for ${chainId}`);
  if (pinnedEscrow && !sameAddr(pinnedEscrow, evidence.escrow)) throw new Error('evidence is for a different escrow');
  const r = verifyEvidence(evidence);
  const digest = resultDigest(chainId, evidence.escrow, evidence.matchId, r.winner, r.resultHash);
  return { address, sig: signDigest(key, digest).sig, winner: r.winner, resultHash: r.resultHash, simHash: r.simHash };
}

if (process.send) {
  process.on('message', (m) => {
    if (m && m.t === 'ping') return process.send({ t: 'pong', id: m.id, address });
    if (!m || m.t !== 'sign') return;
    try {
      process.send({ t: 'signed', id: m.id, ok: true, ...sign(m.evidence) });
    } catch (e) {
      process.send({ t: 'signed', id: m.id, ok: false, error: String(e.message || e), address });
    }
  });
  process.send({ t: 'ready', address, role });
} else if (process.argv.includes('--http')) {
  const token = process.env.COSIGNER_AUTH_TOKEN || '';
  if (token.length < 16) throw new Error('COSIGNER_AUTH_TOKEN required');
  http.createServer((req, res) => {
    const done = (code, body) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
    if (req.url === '/healthz') return done(200, { ok: true, address, role, chainId });
    if (req.method !== 'POST' || req.url !== '/sign') return done(404, { error: 'not found' });
    if (req.headers.authorization !== `Bearer ${token}`) return done(401, { error: 'unauthorized' });
    let body = '';
    req.on('data', (c) => { body += c; if (body.length > 20e6) req.destroy(); });
    req.on('end', () => {
      try { done(200, { ok: true, ...sign(JSON.parse(body).evidence) }); } catch (e) { done(400, { ok: false, error: String(e.message || e) }); }
    });
  }).listen(Number(process.env.PORT || 10001), () => console.log(`co-signer ${role} ${address} listening`));
}
