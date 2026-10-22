// Copy the compiled escrow bytecode into server/escrow-artifact.json.
// `--check` fails if the committed artifact differs from a fresh `forge build`.
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
const out = 'contracts/out/DeckhandEscrow.sol/DeckhandEscrow.json';
const j = JSON.parse(readFileSync(out, 'utf8'));
const art = { contract: 'DeckhandEscrow', solc: '0.8.28', bytecode: j.bytecode.object, deployedBytecode: j.deployedBytecode.object, abi: j.abi };
const path = 'server/escrow-artifact.json';
if (process.argv.includes('--check')) {
  const cur = existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : {};
  if (cur.bytecode !== art.bytecode) { console.error('escrow-artifact.json is stale: run `npm run contracts:export`'); process.exit(1); }
  console.log('escrow artifact matches source');
} else {
  writeFileSync(path, JSON.stringify(art, null, 1) + '\n');
  console.log('wrote', path, (art.bytecode.length - 2) / 2, 'bytes');
}
