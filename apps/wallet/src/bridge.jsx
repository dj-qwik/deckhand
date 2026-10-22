// Privy bridge. A tiny React app that owns the Privy session and exposes a plain
// JavaScript API on window.DHWallet for the (non-React) game. It fires a
// `dhwallet` event on window whenever the session or wallet changes.
//
// Rules learned the hard way:
//  - Only the Privy embedded wallet is used (walletClientType === 'privy'). No external wallets.
//  - Login is Google + email only. Privy pop-ups are off; every money action is
//    confirmed by a button inside the game first.
//  - Effects must return undefined (React 19 treats a returned value as cleanup).
import './polyfills.js';
import React, { useEffect, useRef } from 'react';
import { createRoot } from 'react-dom/client';
import * as Privy from '@privy-io/react-auth';

const { PrivyProvider, usePrivy, useWallets, useCreateWallet, useLogin } = Privy;
// v3 exposes useExportWallet; older builds had exportWallet on usePrivy()
const useExportWalletHook = Privy.useExportWallet || (() => ({ exportWallet: null }));

const state = { ready: false, authenticated: false, address: null, email: null, error: null };
const live = { current: null }; // latest hook values
let pendingLogin = null;
let cfg = null;

function fire() {
  window.dispatchEvent(new Event('dhwallet'));
}

function embedded() {
  const ws = live.current?.wallets || [];
  return ws.find((w) => w.walletClientType === 'privy') || null;
}

async function rpc(method, params = []) {
  const res = await fetch('/api/rpc', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ method, params }) });
  const j = await res.json();
  if (!res.ok || j.error) throw new Error(j.error || `RPC ${method} failed`);
  return j.result;
}

const hex = (n) => '0x' + BigInt(n).toString(16);

async function provider() {
  const w = embedded();
  if (!w) throw new Error('No game wallet yet. Sign in again.');
  try {
    if (w.switchChain) await w.switchChain(cfg.chainId);
  } catch (e) {
    throw new Error(`Could not switch the game wallet to chain ${cfg.chainId}`, { cause: e });
  }
  return { w, p: await w.getEthereumProvider() };
}

async function fees() {
  const gp = BigInt(await rpc('eth_gasPrice'));
  let tip = 0n;
  try { tip = BigInt(await rpc('eth_maxPriorityFeePerGas')); } catch { tip = 0n; }
  if (tip > gp) tip = gp;
  return { maxFeePerGas: gp * 2n + tip, maxPriorityFeePerGas: tip };
}

const api = {
  get ready() { return state.ready; },
  get authenticated() { return state.authenticated; },
  get address() { return state.address; },
  get email() { return state.email; },
  get error() { return state.error; },

  /** open Privy (Google or email). Resolves once there is an embedded wallet. */
  async login() {
    const h = live.current;
    if (!h) throw new Error('Wallet is still loading');
    if (h.authenticated && embedded()) return state.address;
    if (h.authenticated && !embedded()) {
      // stale session without a wallet: try to create one, else start over
      try { await h.createWallet(); return await waitFor(() => embedded(), 20000).then(() => state.address); } catch {}
      try { await h.logout(); } catch {}
      await new Promise((r) => setTimeout(r, 300));
    }
    return new Promise((resolve, reject) => {
      pendingLogin = { resolve, reject };
      try { live.current.login(); } catch (e) { pendingLogin = null; reject(e); }
    });
  },

  async logout() {
    try { await live.current?.logout(); } finally { update(); }
  },

  async signMessage(message) {
    const { w, p } = await provider();
    return p.request({ method: 'personal_sign', params: [message, w.address] });
  },

  async getBalance() {
    if (!state.address) return '0';
    return BigInt(await rpc('eth_getBalance', [state.address, 'latest'])).toString();
  },

  /** largest amount that can be sent while leaving room for gas */
  async maxSendable() {
    const bal = BigInt(await api.getBalance());
    const f = await fees();
    const reserve = 21000n * 3n * f.maxFeePerGas; // generous: L2 gas estimates move around
    return (bal > reserve ? bal - reserve : 0n).toString();
  },

  /** send { to, value (hex wei), data? } from the game wallet; resolves to the tx hash */
  async send({ to, value = '0x0', data = '0x' }) {
    const { w, p } = await provider();
    const est = BigInt(await rpc('eth_estimateGas', [{ from: w.address, to, value, data }]));
    const gas = (est * 12n) / 10n;
    const f = await fees();
    const bal = BigInt(await rpc('eth_getBalance', [w.address, 'latest']));
    if (BigInt(value) + gas * f.maxFeePerGas > bal) throw new Error('Not enough ETH to cover the amount plus gas');
    return p.request({
      method: 'eth_sendTransaction',
      params: [{ from: w.address, to, value, data, gas: hex(gas), maxFeePerGas: hex(f.maxFeePerGas), maxPriorityFeePerGas: hex(f.maxPriorityFeePerGas), chainId: hex(cfg.chainId) }],
    });
  },

  async waitForReceipt(hash, timeoutMs = 120000) {
    const t0 = Date.now();
    while (Date.now() - t0 < timeoutMs) {
      const r = await rpc('eth_getTransactionReceipt', [hash]).catch(() => null);
      if (r) {
        if (r.status !== '0x1') throw new Error('Transaction failed on-chain');
        return r;
      }
      await new Promise((res) => setTimeout(res, 800));
    }
    throw new Error('Still waiting for confirmation. Check the explorer.');
  },

  async exportKey() {
    const fn = live.current?.exportWallet;
    if (!fn) throw new Error('Key export is not available in this wallet build');
    const w = embedded();
    await fn(w ? { address: w.address } : undefined);
  },
};
window.DHWallet = api;

function waitFor(fn, ms) {
  return new Promise((resolve, reject) => {
    const t0 = Date.now();
    const iv = setInterval(() => {
      const v = fn();
      if (v) { clearInterval(iv); resolve(v); } else if (Date.now() - t0 > ms) { clearInterval(iv); reject(new Error('timed out')); }
    }, 150);
  });
}

function update() {
  const h = live.current;
  const w = embedded();
  state.ready = !!h?.ready;
  state.authenticated = !!h?.authenticated;
  state.address = w ? w.address : null;
  state.email = h?.user?.email?.address || h?.user?.google?.email || null;
  if (pendingLogin && state.authenticated && state.address) {
    pendingLogin.resolve(state.address);
    pendingLogin = null;
  }
  fire();
}

function Bridge() {
  const priv = usePrivy();
  const { ready, authenticated, user, logout } = priv;
  const exp = useExportWalletHook();
  const exportWallet = exp.exportWallet || priv.exportWallet;
  const { wallets } = useWallets();
  const { createWallet } = useCreateWallet();
  const { login } = useLogin({
    onComplete: () => { setTimeout(update, 0); },
    onError: (err) => {
      if (pendingLogin) { pendingLogin.reject(new Error(err === 'exited_auth_flow' ? 'Sign-in cancelled' : `Sign-in failed: ${err}`)); pendingLogin = null; }
    },
  });
  const ref = useRef(null);
  ref.current = { ready, authenticated, user, login, logout, exportWallet, wallets, createWallet };
  live.current = ref.current;

  useEffect(() => {
    update();
    // an authenticated user with no embedded wallet yet: create one quietly
    if (ready && authenticated && !embedded()) {
      createWallet().catch(() => {});
    }
  }, [ready, authenticated, user, wallets]);

  return null;
}

async function main() {
  try {
    cfg = await fetch('/api/config').then((r) => r.json());
  } catch (e) {
    state.error = 'Could not load server config';
    fire();
    return;
  }
  if (!cfg.privyAppId) {
    state.error = 'Sign-in is not configured on this server yet';
    fire();
    return;
  }
  const chain = {
    id: cfg.chainId,
    name: cfg.chainName,
    network: `chain-${cfg.chainId}`,
    nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
    rpcUrls: { default: { http: [cfg.rpcUrl] }, public: { http: [cfg.rpcUrl] } },
    blockExplorers: cfg.explorer ? { default: { name: 'Explorer', url: cfg.explorer } } : undefined,
    testnet: !cfg.mainnet,
  };
  const el = document.createElement('div');
  el.id = 'dh-privy-root';
  document.body.appendChild(el);
  createRoot(el).render(
    <PrivyProvider
      appId={cfg.privyAppId}
      config={{
        loginMethods: ['google', 'email'],
        appearance: { theme: 'dark', accentColor: '#E49B3C', landingHeader: 'Sign in to play', showWalletLoginFirst: false },
        embeddedWallets: {
          createOnLogin: 'all-users',
          ethereum: { createOnLogin: 'all-users' },
          showWalletUIs: false,
          noPromptOnSignature: true,
        },
        defaultChain: chain,
        supportedChains: [chain],
      }}
    >
      <Bridge />
    </PrivyProvider>,
  );
}

main();
