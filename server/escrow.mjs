// Typed wrapper around the on-chain DeckhandEscrow.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { calldata, abiEncode, abiDecode, keccakText, hex, bytes, checksum, createAddress, joinDigest, resultDigest, signDigest } from './eth.mjs';
import { concatBytes } from '@noble/hashes/utils';

const ART = JSON.parse(readFileSync(fileURLToPath(new URL('./escrow-artifact.json', import.meta.url)), 'utf8'));
export const ESCROW_BYTECODE = ART.bytecode;

export const STATUS = ['None', 'Open', 'Locked', 'Settled', 'Refunded'];
export const TOPIC = {
  MatchCreated: keccakText('MatchCreated(bytes32,uint128,uint8,uint64)'),
  Deposited: keccakText('Deposited(bytes32,address,uint8)'),
  MatchLocked: keccakText('MatchLocked(bytes32)'),
  Settled: keccakText('Settled(bytes32,address,uint256,uint256,bytes32)'),
  Refunded: keccakText('Refunded(bytes32,uint256,uint8)'),
  PayoutOwed: keccakText('PayoutOwed(address,uint256)'),
};

export class Escrow {
  /** sender: eth.Sender for the operator key */
  constructor(rpc, sender, chainId, address) {
    this.rpc = rpc;
    this.sender = sender;
    this.chainId = chainId;
    this.address = address ? checksum(address) : null;
  }

  async deploy({ cosigners, threshold, treasury, guardian, futureAdmin, maxEntry }) {
    const args = abiEncode(['address', 'address[]', 'uint8', 'address', 'address', 'address', 'uint128'], [this.sender.address, cosigners, threshold, treasury, guardian, futureAdmin, maxEntry]);
    const nonce = await this.rpc.nonce(this.sender.address, 'pending');
    const predicted = createAddress(this.sender.address, nonce);
    const hash = await this.sender.send({ to: null, data: hex(concatBytes(bytes(ESCROW_BYTECODE), args)), gas: 3_000_000n });
    const r = await this.sender.wait(hash);
    this.address = checksum(r.contractAddress || predicted);
    return { address: this.address, block: Number(BigInt(r.blockNumber)), hash };
  }

  async isDeployed() {
    if (!this.address) return false;
    const code = await this.rpc.code(this.address);
    return code && code !== '0x';
  }

  // ------------------------------------------------------------------ writes
  createMatch(matchId, entryWei, seats, deadline) {
    return this.sender.send({ to: this.address, data: calldata('createMatch(bytes32,uint128,uint8,uint64)', [matchId, entryWei, seats, deadline]) });
  }
  cancel(matchId) {
    return this.sender.send({ to: this.address, data: calldata('cancel(bytes32)', [matchId]) });
  }
  refundExpired(matchId) {
    return this.sender.send({ to: this.address, data: calldata('refundExpired(bytes32)', [matchId]) });
  }
  submitResult(matchId, winner, resultHash, sigs) {
    return this.sender.send({ to: this.address, data: calldata('submitResult(bytes32,address,bytes32,bytes[])', [matchId, winner, resultHash, sigs]) });
  }

  // ------------------------------------------------------------------- reads
  async getMatch(matchId) {
    const r = await this.rpc.ethCall(this.address, calldata('matches(bytes32)', [matchId]));
    const [entry, deadline, lockedAt, seats, joined, status] = abiDecode(['uint128', 'uint64', 'uint64', 'uint8', 'uint8', 'uint8'], r);
    return { entry, deadline: Number(deadline), lockedAt: Number(lockedAt), seats: Number(seats), joined: Number(joined), status: STATUS[Number(status)] };
  }
  async players(matchId) {
    return abiDecode(['address[]'], await this.rpc.ethCall(this.address, calldata('players(bytes32)', [matchId])))[0];
  }
  async view(sig, types, values = []) {
    return abiDecode(types, await this.rpc.ethCall(this.address, calldata(sig, values)));
  }

  // -------------------------------------------------------------- signatures
  joinPermit(operatorKey, matchId, player, expiry) {
    return signDigest(operatorKey, joinDigest(this.chainId, this.address, matchId, player, expiry)).sig;
  }
  resultDigest(matchId, winner, resultHash) {
    return resultDigest(this.chainId, this.address, matchId, winner, resultHash);
  }
  /** calldata a player's wallet sends to pay their seat */
  depositData(matchId, expiry, permit) {
    return calldata('deposit(bytes32,uint64,bytes)', [matchId, expiry, permit]);
  }

  // ------------------------------------------------------------------- logs
  async logs(fromBlock, toBlock) {
    const raw = await this.rpc.logs({ address: this.address, fromBlock: '0x' + fromBlock.toString(16), toBlock: '0x' + toBlock.toString(16) });
    return raw.map(decodeLog).filter(Boolean);
  }
}

function decodeLog(l) {
  const t0 = l.topics[0];
  const base = { block: Number(BigInt(l.blockNumber)), tx: l.transactionHash, index: Number(BigInt(l.logIndex)) };
  const addrTopic = (t) => checksum('0x' + t.slice(26));
  if (t0 === TOPIC.Deposited) {
    const [seat] = abiDecode(['uint8'], l.data);
    return { ...base, ev: 'Deposited', matchId: l.topics[1], player: addrTopic(l.topics[2]), seat: Number(seat) };
  }
  if (t0 === TOPIC.MatchLocked) return { ...base, ev: 'MatchLocked', matchId: l.topics[1] };
  if (t0 === TOPIC.MatchCreated) return { ...base, ev: 'MatchCreated', matchId: l.topics[1] };
  if (t0 === TOPIC.Settled) {
    const [w, h, rh] = abiDecode(['uint256', 'uint256', 'bytes32'], l.data);
    return { ...base, ev: 'Settled', matchId: l.topics[1], winner: addrTopic(l.topics[2]), winnerAmount: w, houseAmount: h, resultHash: rh };
  }
  if (t0 === TOPIC.Refunded) return { ...base, ev: 'Refunded', matchId: l.topics[1] };
  if (t0 === TOPIC.PayoutOwed) return { ...base, ev: 'PayoutOwed', to: addrTopic(l.topics[1]) };
  return null;
}
