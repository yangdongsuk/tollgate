import { createPublicClient, createWalletClient, custom, http, parseUnits, formatUnits, isAddress, getAddress, parseGwei, decodeEventLog, parseAbi } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { arc as arcMainnet, USDC, EURC, TOLLGATE_ABI, signVoucher, encodeVoucher, decodeVoucher } from './tollgate.mjs';
import * as config from './config.js';

// Local testing against `arc-anvil --network arc`: only on localhost, never on the public site.
const params = new URLSearchParams(location.search);
const DEV = ['localhost', '127.0.0.1'].includes(location.hostname) && params.has('dev');
const CONTRACT = DEV ? params.get('contract') : config.CONTRACT;
const arc = DEV ? { ...arcMainnet, id: 31337, name: 'Arc (local)', rpcUrls: { default: { http: ['http://127.0.0.1:8547'] } } } : arcMainnet;
const EXPLORER = arcMainnet.blockExplorers.default.url;
const TOKENS = { USDC: { address: USDC, decimals: 6 }, EURC: { address: EURC, decimals: 6 } };
const ABI = [...TOLLGATE_ABI, ...parseAbi([
  'function open(address provider, address signer, address token, uint128 amount, uint64 grace) returns (bytes32)',
  'function topUp(bytes32 channelId, uint128 amount)',
  'function requestClose(bytes32 channelId)',
  'function finalizeClose(bytes32 channelId)',
  'function closeByProvider(bytes32 channelId, uint256 cumulativeAmount, bytes signature)',
])];
const ERC20 = parseAbi(['function allowance(address,address) view returns (uint256)', 'function approve(address,uint256) returns (bool)']);
const MIN_FEE = parseGwei('25'); // Arc drops transactions below its 20 gwei floor
const ZERO = '0x0000000000000000000000000000000000000000';

const pub = createPublicClient({ chain: arc, transport: http() });
let wallet = null;
let account = null;
let current = null;
let pendingSession = null;

const $ = (id) => document.getElementById(id);
const short = (a) => `${a.slice(0, 6)}…${a.slice(-4)}`;
const addrLink = (a) => `<a href="${EXPLORER}/address/${a}" target="_blank" rel="noopener">${short(a)}</a>`;
const txLink = (h) => `<a href="${EXPLORER}/tx/${h}" target="_blank" rel="noopener">${h.slice(0, 10)}…</a>`;
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const tokenOf = (a) => Object.entries(TOKENS).find(([, t]) => t.address.toLowerCase() === a.toLowerCase()) ?? ['tokens', { decimals: 6 }];

function toast(html, ms = 5000) {
  const t = $('toast');
  t.innerHTML = html;
  t.classList.add('show');
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => t.classList.remove('show'), ms);
}

async function connect() {
  if (!window.ethereum) return toast('No browser wallet found. Install MetaMask, Rabby or similar.');
  wallet = createWalletClient({ chain: arc, transport: custom(window.ethereum) });
  [account] = await wallet.requestAddresses();
  const id = await wallet.getChainId();
  if (id !== arc.id) {
    try { await wallet.switchChain({ id: arc.id }); } catch { await wallet.addChain({ chain: arc }); }
  }
  $('connect').textContent = short(account);
  $('net').textContent = DEV ? 'Arc local (dev)' : 'Arc mainnet';
  $('net').className = 'pill ok';
  window.ethereum.on?.('accountsChanged', ([a]) => { account = a; $('connect').textContent = a ? short(a) : 'Connect wallet'; if (current) load(current); });
  if (current) load(current);
}

async function send(functionName, args, label, address = CONTRACT, abi = ABI) {
  if (!wallet) await connect();
  if (!account) return null;
  const fees = await pub.estimateFeesPerGas().catch(() => ({}));
  const maxFeePerGas = (fees.maxFeePerGas ?? 0n) > MIN_FEE ? fees.maxFeePerGas : MIN_FEE;
  toast(`${label}: confirm in your wallet…`, 60000);
  const hash = await wallet.writeContract({ address, abi, functionName, args, account, maxFeePerGas, maxPriorityFeePerGas: fees.maxPriorityFeePerGas ?? parseGwei('1') });
  toast(`${label}: sent ${txLink(hash)}`, 60000);
  const receipt = await pub.waitForTransactionReceipt({ hash });
  if (receipt.status !== 'success') throw new Error(`${label} reverted`);
  toast(`${label}: confirmed ${txLink(hash)}`);
  return receipt;
}

// ------------------------------------------------------------------ channel view

async function load(id) {
  current = id;
  const qs = new URLSearchParams(location.search);
  qs.set('channel', id);
  history.replaceState(null, '', `?${qs}`);
  const box = $('channel');
  box.innerHTML = '<p class="muted">Loading…</p>';
  try {
    const [payer, provider, signer, token, deposit, redeemed, grace, closeRequestedAt, closed] =
      await pub.readContract({ address: CONTRACT, abi: ABI, functionName: 'channels', args: [id] });
    if (payer === ZERO) { box.innerHTML = '<p class="muted">No channel with this ID.</p>'; return; }
    const now = Number((await pub.getBlock({ blockTag: 'latest' })).timestamp);
    const [sym, tok] = tokenOf(token);
    const amt = (v) => `${formatUnits(v, tok.decimals)} ${sym}`;
    const me = account?.toLowerCase();
    const isPayer = me === payer.toLowerCase();
    const isProvider = me === provider.toLowerCase();
    const closableAt = Number(closeRequestedAt) + Number(grace);
    const state = closed ? 'Closed' : closeRequestedAt ? (now >= closableAt ? 'Closable' : 'Closing') : 'Open';
    const pct = deposit ? Number((redeemed * 10000n) / deposit) / 100 : 0;

    const acts = [];
    if (isPayer && !closed) {
      acts.push(btn('topup', 'Top up'));
      if (!closeRequestedAt) acts.push(btn('requestClose', 'Request close'));
      else if (now >= closableAt) acts.push(btn('finalize', 'Take back the rest', 'primary'));
    }
    if (isProvider && !closed) {
      acts.push(btn('redeem', 'Redeem a voucher', 'primary'));
      acts.push(btn('providerClose', 'Close & refund payer'));
    }

    box.innerHTML = `<div class="card">
      <div class="facts">
        <div><span>Status</span><b>${state}</b></div>
        <div><span>Payer</span><b>${addrLink(payer)}</b></div>
        <div><span>Provider</span><b>${addrLink(provider)}</b></div>
        <div><span>Voucher signer</span><b>${addrLink(signer)}</b></div>
        <div><span>Deposited</span><b>${amt(deposit)}</b></div>
        <div><span>Paid to provider</span><b>${amt(redeemed)}</b></div>
        <div><span>Available</span><b>${closed ? amt(0n) : amt(deposit - redeemed)}</b></div>
        <div><span>Grace period</span><b>${(Number(grace) / 3600).toFixed(2).replace(/\.00$/, '')} h</b></div>
      </div>
      <div class="bar" title="${pct}% redeemed"><i style="width:${pct}%"></i></div>
      ${closeRequestedAt && !closed ? `<p class="muted">Close requested. Provider can redeem until ${new Date(closableAt * 1000).toLocaleString()}.</p>` : ''}
      <p class="muted">${isPayer ? 'You are the payer.' : isProvider ? 'You are the provider.' : account ? 'Viewing as a third party.' : 'Connect a wallet to manage this channel.'}</p>
      <div class="actions">${acts.join('')}</div>
    </div>`;
    box.querySelectorAll('[data-act]').forEach((b) => { b.onclick = () => act(b.dataset.act, tok); });
  } catch (e) {
    box.innerHTML = `<p class="muted">Could not load channel: ${esc(e.shortMessage || e.message)}</p>`;
  }
}

const btn = (a, label, kind = '') => `<button class="btn small ${kind}" data-act="${a}">${label}</button>`;

async function act(kind, tok) {
  try {
    if (kind === 'topup') {
      const v = prompt('Amount to add:');
      if (!v || Number.isNaN(Number(v))) return;
      const amount = parseUnits(v, tok.decimals);
      const [, , , token] = await pub.readContract({ address: CONTRACT, abi: ABI, functionName: 'channels', args: [current] });
      await ensureAllowance(token, amount);
      await send('topUp', [current, amount], 'Top up');
    } else if (kind === 'requestClose') {
      if (!confirm('Start closing? The provider keeps the grace period to redeem its last voucher.')) return;
      await send('requestClose', [current], 'Request close');
    } else if (kind === 'finalize') await send('finalizeClose', [current], 'Close');
    else if (kind === 'redeem' || kind === 'providerClose') {
      const h = prompt(kind === 'redeem' ? 'Paste the latest voucher header (channelId:total:signature):' : 'Paste a final voucher to redeem first, or leave empty to just refund:');
      if (h == null) return;
      const v = h.trim() ? decodeVoucher(h.trim()) : null;
      if (h.trim() && (!v || v.channelId.toLowerCase() !== current.toLowerCase())) return toast('That voucher is malformed or for another channel.');
      if (kind === 'redeem') await send('redeem', [current, v.cumulative, v.signature], 'Redeem');
      else await send('closeByProvider', [current, v ? v.cumulative : 0n, v ? v.signature : '0x'], 'Close');
    }
    await load(current);
  } catch (e) {
    toast(`Failed: ${esc(e.shortMessage || e.message)}`, 8000);
  }
}

async function ensureAllowance(token, amount) {
  if (!wallet) await connect();
  const allowance = await pub.readContract({ address: token, abi: ERC20, functionName: 'allowance', args: [account, CONTRACT] });
  if (allowance < amount) await send('approve', [CONTRACT, amount], 'Approve', token, ERC20);
}

// -------------------------------------------------------------------- open

function renderSession() {
  const useSession = document.querySelector('input[name="o-signer"]:checked').value === 'session';
  const el = $('o-session');
  if (!useSession) { el.innerHTML = '<span>Vouchers must be signed by your connected wallet (one signature prompt per call).</span>'; return; }
  if (!pendingSession) {
    const key = generatePrivateKey();
    pendingSession = { key, address: privateKeyToAccount(key).address };
  }
  el.innerHTML = `<span>Session key generated in this browser. Give the private key to your agent; it holds no funds and never pays gas.</span>
    <span>Address <code>${pendingSession.address}</code></span>
    <button type="button" class="btn small" id="copy-key">Copy private key</button>`;
  $('copy-key').onclick = async () => { await navigator.clipboard.writeText(pendingSession.key); toast('Private key copied. Store it with your agent; it is not saved anywhere else.'); };
}

async function openChannel(ev) {
  ev.preventDefault();
  const provider = $('o-provider').value.trim();
  if (!isAddress(provider)) return toast('Enter a valid provider address.');
  const sym = $('o-token').value;
  const tok = TOKENS[sym];
  const amount = parseUnits($('o-amount').value, tok.decimals);
  const grace = BigInt(Math.round(Number($('o-grace').value) * 3600));
  $('o-submit').disabled = true;
  try {
    if (!wallet) await connect();
    const useSession = document.querySelector('input[name="o-signer"]:checked').value === 'session';
    const signer = useSession ? pendingSession.address : account;
    await ensureAllowance(tok.address, amount);
    const receipt = await send('open', [getAddress(provider), signer, tok.address, amount, grace], 'Open channel');
    const opened = receipt.logs.map((l) => { try { return decodeEventLog({ abi: ABI, data: l.data, topics: l.topics }); } catch { return null; } })
      .find((e) => e?.eventName === 'ChannelOpened');
    const id = opened?.args.channelId;
    $('open-result').innerHTML = `<div class="card"><b>Channel open with ${formatUnits(amount, tok.decimals)} ${sym}.</b>
      <p class="mono">CHANNEL_ID=${id}<br>TOLLGATE=${CONTRACT}${useSession ? `<br>SESSION_KEY=(the key you copied)` : ''}</p>
      <p class="muted">Share the channel ID with the provider. <a href="?channel=${id}">View channel</a></p></div>`;
    if (useSession) pendingSession = null;
  } catch (e) {
    toast(`Failed: ${esc(e.shortMessage || e.message)}`, 8000);
  } finally {
    $('o-submit').disabled = false;
  }
}

// -------------------------------------------------------------------- sign

async function signForm(ev) {
  ev.preventDefault();
  try {
    const acct = privateKeyToAccount($('s-key').value.trim());
    const cumulative = parseUnits($('s-total').value, 6);
    const v = await signVoucher({ account: acct, contract: CONTRACT, chainId: arc.id, channelId: $('s-channel').value.trim(), cumulative });
    $('s-out').value = encodeVoucher(v);
  } catch (e) {
    toast(`Failed: ${esc(e.shortMessage || e.message)}`);
  }
}

// -------------------------------------------------------------------- boot

function showTab(name) {
  document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('active', t.dataset.tab === name));
  for (const n of ['lookup', 'open', 'sign']) $(`tab-${n}`).hidden = n !== name;
}
document.querySelectorAll('.tab').forEach((t) => { t.onclick = () => showTab(t.dataset.tab); });
document.querySelectorAll('input[name="o-signer"]').forEach((r) => { r.onchange = renderSession; });
$('connect').onclick = () => connect().catch((e) => toast(esc(e.shortMessage || e.message)));
$('lookup-form').onsubmit = (e) => { e.preventDefault(); load($('ch-id').value.trim()); };
$('open-form').onsubmit = openChannel;
$('sign-form').onsubmit = signForm;
$('contract-link').href = `${EXPLORER}/address/${CONTRACT}`;
$('contract-link').textContent = short(CONTRACT);
if (DEV) $('net').textContent = 'Arc local (dev)';
renderSession();
const q = params.get('channel');
if (q) { $('ch-id').value = q; load(q); }
