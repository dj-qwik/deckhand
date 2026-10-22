// Chain service: operator key, escrow deployment, the log watcher and the
// embedded co-signer processes.
import { fork } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { Rpc, Sender, deriveKey, addressOf, formatEth } from './eth.mjs';
import { Escrow } from './escrow.mjs';

export class Chain {
  constructor(cfg, db, log) {
    this.cfg = cfg;
    this.db = db;
    this.log = log;
    this.rpc = new Rpc(cfg.rpcUrl);
    this.state = { stage: 'starting', note: '' };
    this.handlers = [];
    this.cosigners = [];
    this.balance = null;
    this.rpcChainId = null;
    this.lastBlock = 0;
    this.watchErr = '';
    if (cfg.operatorSecret.length >= 16) {
      this.opKey = deriveKey(cfg.operatorSecret, 'operator');
      this.operator = addressOf(this.opKey);
      this.sender = new Sender(this.rpc, this.opKey, cfg.chainId, (...a) => log('[operator]', ...a));
    }
    this.cosignerAddrs = cfg.cosignerSecrets.map((s, i) => (s.length >= 16 ? addressOf(deriveKey(s, i ? 'cosignerB' : 'cosignerA')) : null));
  }

  onLog(fn) { this.handlers.push(fn); }

  get ready() { return this.state.stage === 'ready'; }

  async start() {
    if (!this.operator) { this.state = { stage: 'blocked', note: 'OPERATOR_SECRET missing' }; return; }
    this.startCosigners();
    this.loop().catch((e) => this.log('chain loop crashed', e));
  }

  // --------------------------------------------------------------- startup
  async loop() {
    for (;;) {
      try {
        if (this.state.stage !== 'ready') await this.bootStep();
        else await this.watchStep();
      } catch (e) {
        this.watchErr = String(e.message || e);
        this.log('chain step failed:', this.watchErr);
      }
      await new Promise((r) => setTimeout(r, this.state.stage === 'ready' ? this.cfg.pollMs : 5000));
    }
  }

  async bootStep() {
    const cfg = this.cfg;
    this.rpcChainId = await this.rpc.chainId();
    if (this.rpcChainId !== cfg.chainId) {
      this.state = { stage: 'blocked', note: `RPC is chain ${this.rpcChainId}, expected ${cfg.chainId}` };
      return;
    }
    this.balance = await this.rpc.balance(this.operator);
    let address = cfg.escrowAddress || (await this.db.kvGet(`escrow:${cfg.chainId}`))?.address || null;
    let deployBlock = cfg.escrowDeployBlock || (await this.db.kvGet(`escrow:${cfg.chainId}`))?.block || 0;
    this.escrow = new Escrow(this.rpc, this.sender, cfg.chainId, address);
    if (address && (await this.escrow.isDeployed())) {
      await this.checkRoles();
      if (this.state.stage === 'blocked') return;
      const saved = await this.db.kvGet(`watch:${address.toLowerCase()}`);
      this.lastBlock = saved?.block ?? Math.max(0, deployBlock - 1);
      this.state = { stage: 'ready', note: '' };
      this.log('escrow ready at', address, 'watching from block', this.lastBlock + 1);
      return;
    }
    if (address) {
      this.state = { stage: 'blocked', note: `ESCROW_ADDRESS ${address} has no contract on chain ${cfg.chainId}` };
      return;
    }
    if (!cfg.owner || this.cosignerAddrs.some((a) => !a)) {
      this.state = { stage: 'blocked', note: 'Set OWNER_ADDRESS and both co-signer secrets before the escrow can be deployed' };
      return;
    }
    if (this.balance < cfg.minGasWei) {
      this.state = { stage: 'needs-gas', note: `Send at least ${formatEth(cfg.minGasWei)} ETH to the gas wallet ${this.operator}` };
      return;
    }
    this.state = { stage: 'deploying', note: 'Deploying the escrow contract…' };
    const d = await this.escrow.deploy({
      cosigners: this.cosignerAddrs, threshold: cfg.threshold, treasury: cfg.owner, guardian: cfg.owner,
      futureAdmin: cfg.owner, maxEntry: cfg.maxEntry,
    });
    await this.db.kvSet(`escrow:${cfg.chainId}`, { address: d.address, block: d.block, tx: d.hash, at: new Date().toISOString() });
    this.log(`ESCROW DEPLOYED at ${d.address} (block ${d.block}). Pin ESCROW_ADDRESS=${d.address} ESCROW_DEPLOY_BLOCK=${d.block} in Render.`);
  }

  async checkRoles() {
    const e = this.escrow;
    const [isOp] = await e.view('isOperator(address)', ['bool'], [this.operator]);
    const [threshold] = await e.view('threshold()', ['uint8']);
    const cos = await Promise.all(this.cosignerAddrs.map((a) => (a ? e.view('isCosigner(address)', ['bool'], [a]).then((r) => r[0]) : false)));
    this.roles = { isOperator: isOp, threshold: Number(threshold), cosigners: cos };
    const [treasury] = await e.view('treasury()', ['address']);
    const [admin] = await e.view('admin()', ['address']);
    const [pendingAdmin] = await e.view('pendingAdmin()', ['address']);
    const [paused] = await e.view('paused()', ['bool']);
    this.roles = { ...this.roles, treasury, admin, pendingAdmin, paused };
    if (!isOp) this.state = { stage: 'blocked', note: `This server's operator ${this.operator} is not an operator on the escrow` };
    else if (cos.filter(Boolean).length < Number(threshold)) this.state = { stage: 'blocked', note: 'Co-signer keys do not match the escrow' };
  }

  async watchStep() {
    const head = await this.rpc.blockNumber();
    this.balance = await this.rpc.balance(this.operator).catch(() => this.balance);
    if (head <= this.lastBlock) return;
    const to = Math.min(head, this.lastBlock + 2000);
    const logs = await this.escrow.logs(this.lastBlock + 1, to);
    for (const l of logs) for (const h of this.handlers) await h(l);
    this.lastBlock = to;
    this.headBlock = head;
    this.watchErr = '';
    await this.db.kvSet(`watch:${this.escrow.address.toLowerCase()}`, { block: to });
  }

  // ------------------------------------------------------------ co-signers
  startCosigners() {
    if (this.cfg.embeddedCosigners < 2) return;
    const script = fileURLToPath(new URL('./cosigner.mjs', import.meta.url));
    ['cosignerA', 'cosignerB'].forEach((role, i) => {
      const spawn = () => {
        const child = fork(script, [], {
          env: { COSIGNER_SECRET: this.cfg.cosignerSecrets[i], COSIGNER_ROLE: role, CHAIN_ID: String(this.cfg.chainId), PATH: process.env.PATH },
          serialization: 'advanced',
        });
        const slot = { role, child, ready: false, address: null, waiting: new Map() };
        this.cosigners[i] = slot;
        child.on('message', (m) => {
          if (m.t === 'ready') { slot.ready = true; slot.address = m.address; }
          if (m.t === 'signed') { const w = slot.waiting.get(m.id); if (w) { slot.waiting.delete(m.id); w(m); } }
        });
        child.on('exit', (code) => {
          this.log(`co-signer ${role} exited (${code}); restarting`);
          for (const w of slot.waiting.values()) w({ ok: false, error: 'co-signer restarted' });
          setTimeout(spawn, 1000);
        });
      };
      spawn();
    });
  }

  /** ask every co-signer to independently verify and sign; returns their replies */
  async collectSignatures(evidence, timeoutMs = 120000) {
    let id = Date.now();
    return Promise.all(this.cosigners.map((c) => new Promise((resolve) => {
      if (!c || !c.ready) return resolve({ ok: false, error: `${c?.role || 'co-signer'} not ready` });
      const myId = ++id;
      const t = setTimeout(() => { c.waiting.delete(myId); resolve({ ok: false, error: 'co-signer timeout' }); }, timeoutMs);
      c.waiting.set(myId, (m) => { clearTimeout(t); resolve(m); });
      c.child.send({ t: 'sign', id: myId, evidence });
    })));
  }

  stop() {
    for (const c of this.cosigners) c?.child.removeAllListeners('exit'), c?.child.kill();
  }
}
