// Real-money lobbies: on-chain match creation, seat permits, deposit tracking,
// match start, co-signed settlement and refunds.
import { randomBytes } from 'node:crypto';
import { ARENA_IDS } from '../game/sim/arenas.js';
import { formatEth, sameAddr, checksum } from './eth.mjs';
import { verifyEvidence } from './verify.mjs';

const ACTIVE = ['creating', 'open', 'locked', 'playing', 'settling', 'refunding'];
const now = () => Date.now();
const sec = () => Math.floor(Date.now() / 1000);
const lc = (a) => String(a).toLowerCase();

export class Cash {
  constructor({ cfg, db, chain, log, notify, startRoom }) {
    this.cfg = cfg;
    this.db = db;
    this.chain = chain;
    this.log = log;
    this.notify = notify; // (walletLower, msg)
    this.startRoom = startRoom; // (lobby) → Room
    this.lobbies = new Map();
    this.byWallet = new Map();
    this.locks = new Map();
    this.timer = null;
  }

  // ================================================================== boot
  async init() {
    const rows = await this.db.listMatches(ACTIVE);
    for (const m of rows) this.track(m);
    this.chain.onLog((l) => this.onChainLog(l));
    this.timer = setInterval(() => this.sweep().catch((e) => this.log('sweep failed', e.message)), 5000);
    // recovery runs once the chain is ready
    const waitReady = setInterval(async () => {
      if (!this.chain.ready) return;
      clearInterval(waitReady);
      for (const m of [...this.lobbies.values()]) await this.recover(m).catch((e) => this.log('recover failed', m.id, e.message));
    }, 1000);
  }

  track(m) {
    this.lobbies.set(m.id, m);
    for (const s of m.seatList) if (ACTIVE.includes(m.status)) this.byWallet.set(lc(s.wallet), m.id);
  }

  untrackWallets(m) {
    for (const s of m.seatList) if (this.byWallet.get(lc(s.wallet)) === m.id) this.byWallet.delete(lc(s.wallet));
  }

  async save(m) {
    const { room, evidence, ...rest } = m;
    await this.db.saveMatch(rest);
  }

  async recover(m) {
    const onchain = await this.chain.escrow.getMatch(m.id);
    if (m.status === 'creating') {
      if (onchain.status === 'None') return this.setStatus(m, 'failed', { error: 'createMatch never landed' });
      m.status = 'open';
    }
    if (onchain.status === 'Settled') return this.setStatus(m, 'settled');
    if (onchain.status === 'Refunded') return this.setStatus(m, 'refunded');
    if (m.status === 'settling') return this.settle(m);
    if (m.status === 'locked' || m.status === 'playing' || m.status === 'refunding' || (m.status === 'open' && onchain.status === 'Locked')) {
      // server restarted mid-match: void it and refund everyone in full
      return this.refund(m, 'server restarted during the match');
    }
    if (m.status === 'open') {
      // re-sync seats from chain
      const players = await this.chain.escrow.players(m.id);
      players.forEach((w, i) => this.markFunded(m, w, i + 1, null));
      await this.save(m);
    }
  }

  // ================================================================ queue
  bucketKey(stakeIdx, seats) { return `${stakeIdx}:${seats}`; }

  async withLock(key, fn) {
    const prev = this.locks.get(key) || Promise.resolve();
    const p = prev.then(fn, fn);
    this.locks.set(key, p.catch(() => {}));
    return p;
  }

  async queue(wallet, name, stakeIdx, seats) {
    wallet = checksum(wallet);
    if (!this.cfg.cashEnabled) throw new Error('Cash matches are not enabled on this server yet');
    if (!this.chain.ready) throw new Error('The escrow is not ready yet. Check /status');
    if (!this.cfg.stakes[stakeIdx]) throw new Error('Unknown stake');
    if (!this.cfg.seatOptions.includes(seats)) throw new Error('Unknown table size');
    if (this.chain.roles?.paused) throw new Error('Cash play is paused');
    const existing = this.lobbies.get(this.byWallet.get(lc(wallet)));
    if (existing && ACTIVE.includes(existing.status)) return this.permitFor(existing, wallet);
    return this.withLock(this.bucketKey(stakeIdx, seats), async () => {
      let m = [...this.lobbies.values()].find((x) =>
        (x.status === 'open' || x.status === 'creating') && x.stakeIdx === stakeIdx && x.seats === seats &&
        x.seatList.length < seats && x.deadline - sec() > Math.min(90, this.cfg.lobbySeconds / 3));
      if (!m) m = await this.create(stakeIdx, seats);
      const expiry = Math.min(m.deadline, sec() + 180);
      m.seatList.push({ wallet, name, reservedUntil: expiry * 1000, funded: false, seat: 0, tx: null });
      this.byWallet.set(lc(wallet), m.id);
      await this.save(m);
      this.broadcast(m);
      return this.permitFor(m, wallet);
    });
  }

  async create(stakeIdx, seats) {
    const id = '0x' + randomBytes(32).toString('hex');
    const stake = this.cfg.stakes[stakeIdx];
    const seed = randomBytes(16).toString('hex');
    const arena = ARENA_IDS[randomBytes(1)[0] % ARENA_IDS.length];
    const m = {
      id, status: 'creating', stakeIdx, stakeWei: stake.wei.toString(), stakeLabel: stake.label, seats,
      deadline: sec() + this.cfg.lobbySeconds + 30, createdAt: now(), seatList: [], arena, seed,
      createTx: null, settleTx: null, refundTx: null, result: null, error: null,
    };
    this.lobbies.set(id, m);
    await this.save(m);
    // fire the on-chain create; players can reserve meanwhile
    (async () => {
      try {
        m.createTx = await this.chain.escrow.createMatch(id, stake.wei, seats, m.deadline);
        await this.save(m);
        await this.chain.sender.wait(m.createTx);
        if (m.status === 'creating') m.status = 'open';
        await this.save(m);
        this.broadcast(m);
      } catch (e) {
        this.log('createMatch failed', e.message);
        await this.setStatus(m, 'failed', { error: 'Could not open the lobby on-chain: ' + e.message });
      }
    })();
    return m;
  }

  permitFor(m, wallet) {
    const seat = m.seatList.find((s) => sameAddr(s.wallet, wallet));
    const expiry = Math.floor((seat?.reservedUntil || 0) / 1000);
    return {
      lobby: this.view(m, wallet),
      deposit: seat && !seat.funded ? this.depositFor(m, wallet, expiry) : null,
    };
  }

  depositFor(m, wallet, expiry) {
    const permit = this.chain.escrow.joinPermit(this.chain.opKey, m.id, wallet, expiry);
    return { escrow: this.chain.escrow.address, matchId: m.id, expiry, valueWei: m.stakeWei, permit, data: this.chain.escrow.depositData(m.id, expiry, permit) };
  }

  async leave(wallet) {
    const m = this.lobbies.get(this.byWallet.get(lc(wallet)));
    if (!m) return { ok: true };
    const seat = m.seatList.find((s) => sameAddr(s.wallet, wallet));
    if (!seat) return { ok: true };
    if (!['open', 'creating'].includes(m.status)) throw new Error('This match is already locked in');
    if (!seat.funded) {
      m.seatList = m.seatList.filter((s) => s !== seat);
      this.byWallet.delete(lc(wallet));
      await this.save(m);
      this.broadcast(m);
      return { ok: true };
    }
    // someone who paid wants out before lock: void the lobby and refund everyone
    await this.refund(m, `${seat.name} left before the match locked`);
    return { ok: true, refunded: true };
  }

  // =========================================================== chain events
  markFunded(m, wallet, seatNo, tx) {
    let s = m.seatList.find((x) => sameAddr(x.wallet, wallet));
    if (!s) {
      s = { wallet: checksum(wallet), name: 'Crew ' + wallet.slice(2, 6), reservedUntil: 0, funded: false, seat: 0, tx: null };
      m.seatList.push(s);
    }
    s.funded = true;
    s.seat = seatNo;
    if (tx) s.tx = tx;
    this.byWallet.set(lc(wallet), m.id);
  }

  async onChainLog(l) {
    const m = this.lobbies.get(l.matchId) || (l.matchId ? await this.db.getMatch(l.matchId) : null);
    if (!m) return;
    if (!this.lobbies.has(m.id)) this.track(m);
    if (l.ev === 'Deposited') {
      if (m.status === 'creating') m.status = 'open';
      this.markFunded(m, l.player, l.seat, l.tx);
      await this.save(m);
      this.broadcast(m);
    } else if (l.ev === 'MatchLocked') {
      if (m.status === 'open' || m.status === 'creating') {
        m.status = 'locked';
        m.lockedAt = now();
        m.seatList = m.seatList.filter((s) => s.funded).sort((a, b) => a.seat - b.seat);
        await this.save(m);
        this.broadcast(m);
        setTimeout(() => this.begin(m).catch((e) => this.log('begin failed', e.message)), 4000);
      }
    } else if (l.ev === 'Settled') {
      m.settleTx = m.settleTx || l.tx;
      m.payout = { winner: l.winner, winnerWei: l.winnerAmount.toString(), houseWei: l.houseAmount.toString() };
      await this.setStatus(m, 'settled');
    } else if (l.ev === 'Refunded') {
      m.refundTx = m.refundTx || l.tx;
      await this.setStatus(m, 'refunded');
    }
  }

  async begin(m) {
    if (m.status !== 'locked') return;
    m.status = 'playing';
    m.startedAt = now();
    await this.save(m);
    m.room = this.startRoom(m);
    this.broadcast(m);
  }

  // ============================================================= settlement
  /** called by the room when the simulation reaches `done` */
  async finished(m, room) {
    m.evidence = room.evidenceBundle({
      matchId: m.id, chainId: this.cfg.chainId, escrow: this.chain.escrow.address, wallets: m.seatList.map((s) => s.wallet),
    });
    await this.db.saveEvidence(m.id, m.evidence);
    m.status = 'settling';
    await this.save(m);
    await this.settle(m);
  }

  async settle(m) {
    const evidence = m.evidence || (await this.db.getEvidence(m.id));
    if (!evidence) return this.refund(m, 'evidence missing');
    let mine;
    try {
      mine = verifyEvidence(evidence);
    } catch (e) {
      this.log('own replay failed', m.id, e.message);
      return this.refund(m, 'result could not be verified');
    }
    m.result = { winner: mine.winner, winnerSlot: mine.winnerSlot, rank: mine.rank, resultHash: mine.resultHash, simHash: mine.simHash };
    await this.save(m);
    this.broadcast(m);
    for (let attempt = 1; attempt <= 30; attempt++) {
      try {
        const st = await this.chain.escrow.getMatch(m.id);
        if (st.status === 'Settled') return this.setStatus(m, 'settled');
        if (st.status === 'Refunded') return this.setStatus(m, 'refunded');
        const replies = await this.chain.collectSignatures(evidence);
        const good = replies.filter((r) => r.ok && sameAddr(r.winner, mine.winner) && r.resultHash === mine.resultHash);
        const bad = replies.filter((r) => !good.includes(r));
        if (bad.length) this.log('co-signer disagreement', m.id, bad.map((b) => b.error || `${b.winner}/${b.resultHash}`).join('; '));
        if (good.length < this.cfg.threshold) throw new Error('not enough co-signatures');
        const sigs = good.sort((a, b) => (BigInt(a.address) < BigInt(b.address) ? -1 : 1)).slice(0, Math.max(this.cfg.threshold, good.length)).map((r) => r.sig);
        const hash = await this.chain.escrow.submitResult(m.id, mine.winner, mine.resultHash, sigs);
        m.settleTx = hash;
        await this.save(m);
        this.broadcast(m);
        await this.chain.sender.wait(hash);
        const pot = BigInt(m.stakeWei) * BigInt(m.seatList.length);
        const winnerWei = (pot * 90n) / 100n;
        m.payout = { winner: mine.winner, winnerWei: winnerWei.toString(), houseWei: (pot - winnerWei).toString() };
        return this.setStatus(m, 'settled');
      } catch (e) {
        m.error = `Settlement attempt ${attempt}: ${e.message}`;
        this.log(m.error);
        this.broadcast(m);
        await new Promise((r) => setTimeout(r, Math.min(60000, 3000 * attempt)));
      }
    }
    await this.setStatus(m, 'failed', { error: 'Settlement failed repeatedly; the guardian can refund this match' });
  }

  async refund(m, reason) {
    if (['refunded', 'settled'].includes(m.status)) return;
    m.status = 'refunding';
    m.reason = reason;
    if (m.room) { m.room.stop(); m.room.broadcast({ t: 'void', reason }); }
    await this.save(m);
    this.broadcast(m);
    for (let attempt = 1; attempt <= 20; attempt++) {
      try {
        const st = await this.chain.escrow.getMatch(m.id);
        if (st.status === 'Refunded') return this.setStatus(m, 'refunded');
        if (st.status === 'Settled') return this.setStatus(m, 'settled');
        if (st.status === 'None') return this.setStatus(m, 'failed', { error: reason });
        m.refundTx = await this.chain.escrow.cancel(m.id);
        await this.save(m);
        await this.chain.sender.wait(m.refundTx);
        return this.setStatus(m, 'refunded');
      } catch (e) {
        this.log('refund attempt failed', m.id, e.message);
        await new Promise((r) => setTimeout(r, Math.min(60000, 3000 * attempt)));
      }
    }
    await this.setStatus(m, 'failed', { error: 'Refund failed repeatedly. After the deadline anyone can call refundExpired.' });
  }

  async setStatus(m, status, extra = {}) {
    Object.assign(m, extra);
    m.status = status;
    if (!ACTIVE.includes(status)) {
      this.untrackWallets(m);
      m.room = null;
      setTimeout(() => this.lobbies.delete(m.id), 10 * 60 * 1000);
    }
    await this.save(m);
    this.broadcast(m);
  }

  // ================================================================ upkeep
  async sweep() {
    const t = now();
    for (const m of [...this.lobbies.values()]) {
      if (m.status !== 'open' && m.status !== 'creating') continue;
      const before = m.seatList.length;
      m.seatList = m.seatList.filter((s) => {
        if (s.funded || s.reservedUntil > t) return true;
        if (this.byWallet.get(lc(s.wallet)) === m.id) this.byWallet.delete(lc(s.wallet));
        return false;
      });
      if (m.seatList.length !== before) { await this.save(m); this.broadcast(m); }
      if (m.status === 'open' && sec() > m.deadline + 5) {
        const anyFunded = m.seatList.some((s) => s.funded);
        await this.refund(m, anyFunded ? 'The lobby did not fill in time' : 'Lobby expired');
      }
    }
  }

  // ================================================================== views
  view(m, forWallet) {
    return {
      id: m.id, status: m.status, stake: m.stakeLabel, stakeWei: m.stakeWei, seats: m.seats, deadline: m.deadline,
      arena: m.arena, potWei: (BigInt(m.stakeWei) * BigInt(m.seatList.filter((s) => s.funded).length)).toString(),
      winnerShare: formatEth((BigInt(m.stakeWei) * BigInt(m.seats) * 90n) / 100n),
      seatList: m.seatList.map((s) => ({ wallet: s.wallet, name: s.name, funded: s.funded, seat: s.seat, you: forWallet ? sameAddr(s.wallet, forWallet) : false })),
      createTx: m.createTx, settleTx: m.settleTx, refundTx: m.refundTx, reason: m.reason || null, error: m.error || null,
      result: m.result ? { winner: m.result.winner, winnerSlot: m.result.winnerSlot, rank: m.result.rank } : null,
      payout: m.payout || null,
      escrow: this.chain.escrow?.address || null, explorer: this.cfg.explorer,
    };
  }

  broadcast(m) {
    for (const s of m.seatList) this.notify(lc(s.wallet), { t: 'lobby', lobby: this.view(m, s.wallet) });
  }

  lobbyOf(wallet) {
    const m = this.lobbies.get(this.byWallet.get(lc(wallet)));
    return m ? this.view(m, wallet) : null;
  }

  roomOf(wallet) {
    const m = this.lobbies.get(this.byWallet.get(lc(wallet)));
    if (!m || !m.room) return null;
    const slot = m.seatList.findIndex((s) => sameAddr(s.wallet, wallet));
    return { room: m.room, slot };
  }
}
