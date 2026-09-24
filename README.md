# Tollgate

Prepaid **USDC payment channels for pay-per-call APIs and AI agents on Arc**.

Deposit once, pay per request with off-chain vouchers, settle thousands of calls in one transaction. The agent only ever holds a session key, so the most it can spend is the channel balance.

**Live app:** https://yangdongsuk.github.io/tollgate/ · **Contract:** see [Deployment](#deployment)

**Demo video (1:35):** [tollgate-demo.mp4](https://github.com/yangdongsuk/tollgate/releases/download/v0.1.0-demo/tollgate-demo.mp4) ([release](https://github.com/yangdongsuk/tollgate/releases/tag/v0.1.0-demo)), recorded before the mainnet deploy on a local Arc node (`arc-anvil --network arc`) with test accounts, plus the live Arbitrum Sepolia app

## The problem

AI agents increasingly need to buy things per call: an API request, a search, a model inference worth a fraction of a cent. Two bad options exist today:

- **Pay on chain per call.** Even at a cent per transaction, fees exceed the price of the call, and every call waits for a block.
- **Give the agent a funded wallet key or an API credit card.** One prompt injection or leaked key and the whole balance is gone.

## How Tollgate works

```
payer ── open(provider, sessionSigner, USDC, deposit, grace) ─► channel (funds locked)
agent ── HTTP request + header x-tollgate-voucher: <channelId>:<runningTotal>:<EIP-712 sig>
provider verifies off chain (signature, total ≥ last + price, total ≤ deposit) and serves it
provider ── redeem(channelId, latestTotal, sig) whenever it's worth the gas ─► paid the difference
payer ── requestClose → provider has `grace` to redeem → finalizeClose returns the rest
```

- **Cumulative vouchers.** Each voucher states the total owed so far, so only the latest one matters. Replaying or submitting an older voucher pays nothing.
- **Session keys.** The voucher signer is a separate key chosen at open. It holds no funds and never pays gas. Worst case if it leaks: the channel balance, not the wallet.
- **HTTP 402 discovery.** A request without a voucher gets `402 Payment Required` with the price, contract, provider and token, so agents can pay without hard-coded terms.
- **Safe exit for both sides.** The payer can always get unspent funds back; the provider always gets a grace window to redeem before that happens. A provider can also close cooperatively and refund immediately.
- **EIP-712 with malleability checks**, bound to chain ID and contract address. No owner, no fees, no upgrades.

## Why Arc

- **Gas is paid in USDC.** The provider's redemption fee comes out of the same USDC it earns, and payers never need a second token. The agent's session key needs no balance at all.
- **Sub-second deterministic finality.** A channel is usable the moment `open` is mined, and a redemption is final on inclusion.
- **Stable pricing.** Prices are quoted and settled in USDC or EURC, so a "0.001 per call" API stays 0.001.

## Try it (5 minutes)

```bash
npm install
# provider: a paid API that returns 402 without a valid voucher
TOLLGATE=<contract> PROVIDER_KEY=<provider key> node examples/paid-api.mjs
# agent: discovers the price from the 402, then pays per call with its session key
SESSION_KEY=<session key> CHANNEL_ID=<channel id> TOLLGATE=<contract> CALLS=5 node examples/agent.mjs
```

Open the channel in the [web app](https://yangdongsuk.github.io/tollgate/) first (it generates the session key in your browser).

## SDK

`sdk/tollgate.mjs` (depends only on viem, runs in Node and browsers):

| Export | Use |
| --- | --- |
| `Meter` | Payer side. Tracks the running total and returns the header for the next call. |
| `Gate` | Provider side. Validates a header against on-chain state, remembers the best voucher, redeems it. |
| `signVoucher`, `recoverVoucherSigner`, `encodeVoucher`, `decodeVoucher` | Low-level helpers. |

```js
const meter = new Meter({ account: privateKeyToAccount(SESSION_KEY), contract, channelId });
await fetch(url, { headers: { 'x-tollgate-voucher': await meter.pay(1000n) } }); // 0.001 USDC

const gate = new Gate({ publicClient, contract, provider: myAddress });
const r = await gate.check(req.headers['x-tollgate-voucher'], 1000n); // { ok } or { status: 402, error }
```

## Arc-specific details handled

- USDC is used through its ERC-20 interface at `0x3600…0000` (6 decimals). The contract never touches native value, so Arc's 18-decimal native balance and native-transfer rules don't affect channel accounting.
- Deposits are checked by balance delta, so fee-on-transfer tokens can't under-fund a channel.
- The web app and example server set `maxFeePerGas` above Arc's 20 gwei floor; lower-fee transactions are silently dropped by the mempool.

## Develop

```bash
forge test   # 13 tests: replay, over-deposit, wrong signer, cross-channel, malleable signatures, grace window, fuzzed conservation
```

The full flow (contract, example server, agent and web app) was also run against `arc-anvil --network arc` from [Arc Foundry](https://github.com/circlefin/arc-foundry), which reproduces Arc's USDC semantics.

## Deployment

| Network | Address |
| --- | --- |
| Arc mainnet (5042) | [`0xEF2B3226f14Bd201bF90C3bc489ebE829b39483F`](https://explorer.arc.io/address/0xEF2B3226f14Bd201bF90C3bc489ebE829b39483F) ([deploy tx](https://explorer.arc.io/tx/0x0689d7245028b601ef92c007270db591536c42f8eda30960ba43ebe74b1cad27)) · [source verified (Sourcify)](https://repo.sourcify.dev/5042/0xEF2B3226f14Bd201bF90C3bc489ebE829b39483F) |
| Arbitrum Sepolia (421614) | [`0xEF2B3226f14Bd201bF90C3bc489ebE829b39483F`](https://sepolia.arbiscan.io/address/0xEF2B3226f14Bd201bF90C3bc489ebE829b39483F) · app: [?net=arbitrum-sepolia](https://yangdongsuk.github.io/tollgate/?net=arbitrum-sepolia) · channels in **USDG** or USDC |

A real channel on mainnet, [view it](https://yangdongsuk.github.io/tollgate/?channel=0xf84e1d9bc9e08709c720e606926b671ac8234a24f5fd37d7be62de52ad697330): [opened with 0.2 USDC](https://explorer.arc.io/tx/0x9035a84580624b6282c9f57a177de06f846baa043b759cd2eeed732912d9a4a7) → a voucher signed by an unfunded session key → [redeemed by the provider](https://explorer.arc.io/tx/0x296fe88cc1f864802e7983d4a263ee270c6c5538032b09a65fe71a3f82735aa0).

## Limitations

- One provider per channel (like a tab at one shop). Open several channels for several providers.
- The provider must redeem within the grace period after a close request, so it should watch `CloseRequested` events (the example server does).
- Unaudited. Keep deposits small.

MIT licensed.
