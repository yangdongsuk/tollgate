// A pay-per-call HTTP API guarded by Tollgate.
//
//   TOLLGATE=0x... PROVIDER_KEY=0x... node examples/paid-api.mjs
//
// Every request to /v1/quote must carry an `x-tollgate-voucher` header worth at least PRICE more
// than the previous one on the same channel. Requests without one get HTTP 402 with the terms.
// Vouchers are redeemed on chain in batches, not per call.
import http from 'node:http';
import { createPublicClient, createWalletClient, http as rpc, parseGwei } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { arc, Gate, HEADER, USDC } from '../sdk/tollgate.mjs';

const RPC = process.env.RPC_URL || arc.rpcUrls.default.http[0];
const chain = { ...arc, id: Number(process.env.CHAIN_ID || arc.id), rpcUrls: { default: { http: [RPC] } } };
const contract = process.env.TOLLGATE;
const providerAccount = privateKeyToAccount(process.env.PROVIDER_KEY);
const PRICE = BigInt(process.env.PRICE || 1_000); // 0.001 USDC (6 decimals)
const REDEEM_AT = BigInt(process.env.REDEEM_AT || 50_000); // batch until 0.05 USDC is owed
const PORT = Number(process.env.PORT || 8787);

const publicClient = createPublicClient({ chain, transport: rpc(RPC) });
const walletClient = createWalletClient({ chain, transport: rpc(RPC), account: providerAccount });
const gate = new Gate({ publicClient, contract, provider: providerAccount.address, chainId: chain.id, token: USDC });
const redeemedUpTo = new Map();

const QUOTES = [
  'Make it work, make it right, make it fast.',
  'Premature optimization is the root of all evil.',
  'Simple things should be simple, complex things should be possible.',
  'The best error message is the one that never shows up.',
  'Programs must be written for people to read.',
];

function send(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json', 'access-control-allow-origin': '*', 'access-control-allow-headers': HEADER });
  res.end(JSON.stringify(body, (_, v) => (typeof v === 'bigint' ? v.toString() : v)));
}

const server = http.createServer(async (req, res) => {
  if (req.method === 'OPTIONS') return send(res, 204, {});
  if (!req.url.startsWith('/v1/quote')) return send(res, 404, { error: 'not found' });
  const result = await gate.check(req.headers[HEADER], PRICE).catch((e) => ({ ok: false, status: 500, error: e.message }));
  if (!result.ok) {
    // HTTP 402: tell the caller how to pay.
    return send(res, result.status, {
      error: result.error,
      payment: { scheme: 'tollgate', chainId: chain.id, contract, provider: providerAccount.address, token: USDC, price: PRICE, header: HEADER },
    });
  }
  send(res, 200, { quote: QUOTES[Math.floor(Math.random() * QUOTES.length)], paidUpTo: result.voucher.cumulative });
});

async function redeemLoop() {
  for (const { channelId, cumulative } of gate.pending()) {
    const done = redeemedUpTo.get(channelId) ?? 0n;
    const channel = await gate.channel(channelId, 0).catch(() => null);
    const closing = channel && channel.closeRequestedAt !== 0n;
    if (cumulative - done < REDEEM_AT && !(closing && cumulative > done)) continue;
    try {
      const fees = { maxFeePerGas: parseGwei('40'), maxPriorityFeePerGas: parseGwei('1') };
      const hash = await gate.redeem(walletClient, channelId, fees);
      await publicClient.waitForTransactionReceipt({ hash });
      redeemedUpTo.set(channelId, cumulative);
      console.log(`redeemed ${channelId.slice(0, 10)}… up to ${cumulative} (${hash})`);
    } catch (e) {
      console.error('redeem failed', e.shortMessage || e.message);
    }
  }
}
setInterval(redeemLoop, 30_000);

server.listen(PORT, () => console.log(`paid API on http://localhost:${PORT}/v1/quote, ${PRICE} per call, provider ${providerAccount.address}`));
