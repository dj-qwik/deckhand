// Environment → config. Secrets come only from the environment (Render env group).
import { parseEth, isAddress, checksum } from './eth.mjs';

const env = process.env;

export const CHAINS = {
  4663: {
    name: 'Robinhood Chain',
    rpc: 'https://rpc.mainnet.chain.robinhood.com',
    explorer: 'https://robinhoodchain.blockscout.com',
    mainnet: true,
  },
  46630: {
    name: 'Robinhood Chain Testnet',
    rpc: 'https://rpc.testnet.chain.robinhood.com',
    explorer: 'https://explorer.testnet.chain.robinhood.com',
    mainnet: false,
  },
  31337: { name: 'Local anvil', rpc: 'http://127.0.0.1:8545', explorer: '', mainnet: false },
};

function list(s, def) {
  return String(s || def).split(',').map((x) => x.trim()).filter(Boolean);
}

export function loadConfig() {
  const chainId = Number(env.CHAIN_ID || 46630);
  const chain = CHAINS[chainId] || { name: `Chain ${chainId}`, rpc: '', explorer: '', mainnet: true };
  const owner = env.OWNER_ADDRESS && isAddress(env.OWNER_ADDRESS) ? checksum(env.OWNER_ADDRESS) : null;
  const stakes = list(env.STAKES, '0.001,0.005,0.01').map((s) => ({ label: s, wei: parseEth(s) }));
  const cfg = {
    port: Number(env.PORT || 10000),
    publicUrl: env.PUBLIC_URL || env.RENDER_EXTERNAL_URL || '',
    chainId,
    chain,
    rpcUrl: env.RPC_URL || chain.rpc,
    explorer: env.EXPLORER_URL || chain.explorer,
    owner,
    operatorSecret: env.OPERATOR_SECRET || '',
    cosignerSecrets: [env.COSIGNER_A_SECRET || '', env.COSIGNER_B_SECRET || ''],
    embeddedCosigners: Number(env.EMBEDDED_COSIGNERS ?? 2),
    threshold: 2,
    databaseUrl: env.DATABASE_URL || '',
    privyAppId: env.PRIVY_APP_ID || '',
    escrowAddress: env.ESCROW_ADDRESS && isAddress(env.ESCROW_ADDRESS) ? checksum(env.ESCROW_ADDRESS) : null,
    escrowDeployBlock: Number(env.ESCROW_DEPLOY_BLOCK || 0),
    allowMainnet: env.ALLOW_RAW_KEYS_ON_MAINNET === 'i-understand',
    stakes,
    seatOptions: list(env.SEATS, '2,3,4').map(Number).filter((n) => n >= 2 && n <= 4),
    maxEntry: parseEth(env.MAX_ENTRY || '0.05'),
    minGasWei: parseEth(env.MIN_GAS_ETH || '0.0005'),
    lobbySeconds: Number(env.LOBBY_SECONDS || 300),
    pollMs: Number(env.CHAIN_POLL_MS || 2500),
  };
  cfg.problems = [];
  if (!cfg.owner) cfg.problems.push('OWNER_ADDRESS is not set');
  if (cfg.operatorSecret.length < 16) cfg.problems.push('OPERATOR_SECRET is not set');
  if (cfg.cosignerSecrets.some((s) => s.length < 16)) cfg.problems.push('COSIGNER_A_SECRET / COSIGNER_B_SECRET are not set');
  if (!cfg.privyAppId) cfg.problems.push('PRIVY_APP_ID is not set');
  if (!cfg.rpcUrl) cfg.problems.push('RPC_URL is not set');
  if (chain.mainnet && !cfg.allowMainnet) cfg.problems.push('Mainnet needs ALLOW_RAW_KEYS_ON_MAINNET=i-understand');
  if (chain.mainnet && !cfg.databaseUrl) cfg.problems.push('Mainnet needs DATABASE_URL (Postgres)');
  cfg.cashEnabled = cfg.problems.length === 0;
  return cfg;
}
