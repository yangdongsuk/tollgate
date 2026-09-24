// An "agent" that pays for each API call with a Tollgate voucher signed by its session key.
// The session key holds no funds and never pays gas; its worst case is the channel balance.
//
//   SESSION_KEY=0x... CHANNEL_ID=0x... TOLLGATE=0x... API=http://localhost:8787/v1/quote CALLS=5 node examples/agent.mjs
import { privateKeyToAccount } from 'viem/accounts';
import { arc, Meter, HEADER } from '../sdk/tollgate.mjs';

const api = process.env.API || 'http://localhost:8787/v1/quote';
const calls = Number(process.env.CALLS || 5);
const meter = new Meter({
  account: privateKeyToAccount(process.env.SESSION_KEY),
  contract: process.env.TOLLGATE,
  channelId: process.env.CHANNEL_ID,
  chainId: Number(process.env.CHAIN_ID || arc.id),
  cumulative: BigInt(process.env.START || 0), // resume from the last total you signed
});

// Discover the price from the 402 response instead of hard-coding it.
const probe = await fetch(api);
const terms = (await probe.json()).payment;
if (probe.status !== 402 || !terms) throw new Error(`expected 402 with payment terms, got ${probe.status}`);
console.log(`price ${terms.price} per call, paying ${terms.provider} via ${terms.contract}`);

for (let i = 0; i < calls; i++) {
  const res = await fetch(api, { headers: { [HEADER]: await meter.pay(terms.price) } });
  const body = await res.json();
  console.log(res.status, res.status === 200 ? body.quote : body.error, `(signed total ${meter.cumulative})`);
}
