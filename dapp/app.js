// Escrow page. Talks to the wallet (window.ethereum) only; every action is
// blocked unless the wallet is on the network this engagement lives on.
import { ENGAGEMENT_ABI, TOKEN_ABI, STATUSES } from './abi.js';

const { ethers } = window;
const $ = id => document.getElementById(id);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const hex = n => '0x' + Number(n).toString(16);
const fmt = (v, d = 6) => Number(ethers.formatUnits(v, d)).toLocaleString(undefined, { maximumFractionDigits: d });

const params = new URLSearchParams(location.search);
const S = { nets: null, target: params.get('net') || 'hedera-testnet', chainId: null, account: null, info: null, busy: false };

// Plain words for the contract's refusals.
const REASONS = {
  NotAllowed: "Your wallet isn't the person for this step.",
  WrongStatus: "This isn't available while the engagement is in its current status.",
  WrongStage: "This step isn't available at this line's current stage.",
  AlreadyStarted: 'This line is already marked Started.',
  NotAllSealed: 'Every line must be sealed before the reserve is released.',
  NoSuchLine: 'That line does not exist.',
  AlreadyReleased: 'The reserve has already been released.',
  TransferFailed: 'The token transfer failed (check the balance and approval).',
  RolesOverlap: 'The same person holds two roles that must be separate.',
};

const net = () => S.nets[S.target];
const onRightNetwork = () => S.chainId === net().chainId;
const nameOf = id => Object.values(S.nets).find(n => n.chainId === id)?.name || `chain ${id}`;
const txLink = h => (net().explorer ? `<a href="${net().explorer}/transaction/${h}" target="_blank" rel="noopener">${h.slice(0, 10)}…${h.slice(-6)}</a>` : esc(h));
const addrLink = a => (net().explorer ? `<a href="${net().explorer}/account/${a}" target="_blank" rel="noopener">${a}</a>` : esc(a));

async function init() {
  S.nets = await (await fetch('networks.json')).json();
  if (!S.nets[S.target]) S.target = 'hedera-testnet';
  $('target').innerHTML = Object.entries(S.nets).map(([k, n]) => `<option value="${k}" ${k === S.target ? 'selected' : ''}>${esc(n.name)}</option>`).join('');
  $('target').onchange = () => { S.target = $('target').value; S.info = null; $('view').hidden = true; prefill().then(render); };
  $('switch-hedera').onclick = () => switchTo(S.target);
  $('connect').onclick = connect;
  $('load').onclick = load;
  if (!window.ethereum) { $('no-wallet').hidden = false; $('connect').disabled = true; $('switch-hedera').disabled = true; }
  else {
    window.ethereum.on?.('chainChanged', c => { S.chainId = Number(c); refresh(); });
    window.ethereum.on?.('accountsChanged', a => { S.account = a[0] ? ethers.getAddress(a[0]) : null; refresh(); });
    S.chainId = Number(await window.ethereum.request({ method: 'eth_chainId' }));
    const accts = await window.ethereum.request({ method: 'eth_accounts' });
    S.account = accts[0] ? ethers.getAddress(accts[0]) : null;
  }
  await prefill();
  if ($('engagement').value) await load(); else render();
}

// Use ?engagement=0x… if given, otherwise the last deploy for this network.
async function prefill() {
  const given = params.get('engagement');
  if (given && ethers.isAddress(given)) { $('engagement').value = given; return; }
  try {
    const d = await (await fetch(`deployments/${S.target}.json`, { cache: 'no-store' })).json();
    if (d.engagement) $('engagement').value = d.engagement;
  } catch { /* no deployment recorded for this network */ }
}

async function connect() {
  try {
    const a = await window.ethereum.request({ method: 'eth_requestAccounts' });
    S.account = a[0] ? ethers.getAddress(a[0]) : null;
    S.chainId = Number(await window.ethereum.request({ method: 'eth_chainId' }));
    refresh();
  } catch (e) { $('err').textContent = e.message; }
}

// Adds the network to the wallet if needed and switches to it.
async function switchTo(key) {
  const n = S.nets[key];
  const params = {
    chainId: hex(n.chainId), chainName: n.name, nativeCurrency: n.currency, rpcUrls: [n.rpc],
    ...(n.explorer ? { blockExplorerUrls: [n.explorer] } : {}),
  };
  try {
    if (key.startsWith('hedera')) {
      await window.ethereum.request({ method: 'wallet_addEthereumChain', params: [params] });
    } else {
      try { await window.ethereum.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: params.chainId }] }); }
      catch (e) { if (e.code === 4902) await window.ethereum.request({ method: 'wallet_addEthereumChain', params: [params] }); else throw e; }
    }
    S.chainId = Number(await window.ethereum.request({ method: 'eth_chainId' }));
    if (S.target !== key) { S.target = key; $('target').value = key; S.info = null; await prefill(); await load(); return; }
    refresh();
  } catch (e) { $('err').textContent = `Couldn't switch network: ${e.message}`; }
}

// Reads go through the network's own RPC on the right network, so the page
// shows the engagement even before the wallet is switched.
function reader() {
  return onRightNetwork() && window.ethereum ? new ethers.BrowserProvider(window.ethereum)
    : new ethers.JsonRpcProvider(net().rpc, net().chainId, { staticNetwork: true });
}

async function load() {
  const addr = $('engagement').value.trim();
  $('load-msg').textContent = '';
  if (!ethers.isAddress(addr)) { $('load-msg').textContent = 'Enter the engagement contract address.'; render(); return; }
  try {
    const p = reader();
    if (!(await p.getCode(addr)).replace(/^0x$/, '')) throw new Error(`No contract at that address on ${net().name}.`);
    const e = new ethers.Contract(addr, ENGAGEMENT_ABI, p);
    const [sum, client, auditor, operator, treasury, token] = await Promise.all([
      e.summary(), e.client(), e.auditor(), e.operator(), e.treasury(), e.token()]);
    const t = new ethers.Contract(token, TOKEN_ABI, p);
    const [symbol, decimals] = await Promise.all([t.symbol().catch(() => 'TOKEN'), t.decimals().then(Number).catch(() => 6)]);
    const lines = await Promise.all(Array.from({ length: Number(sum._lineCount) }, (_, i) => e.line(i).then(l => ({
      i, payee: l.payee, labor: l.labor, stage: Number(l.stage),
      times: [l.startedAt, l.deliveredAt, l.auditedAt, l.authorizedAt, l.sealedAt].map(Number),
    }))));
    let balances = null;
    if (S.account) {
      const [tb, gb] = await Promise.all([t.balanceOf(S.account).catch(() => 0n), p.getBalance(S.account).catch(() => 0n)]);
      balances = { token: tb, gas: Number(ethers.formatEther(gb)) };
    }
    S.info = { addr, token, symbol, decimals, balances, status: Number(sum._status), price: sum._price, labor: sum._laborTotal, reserve: sum._reserve,
      sealed: Number(sum._sealedCount), anyDelivered: sum._anyDelivered, held: sum._held, roles: { client, auditor, operator, treasury }, lines };
    $('view').hidden = false;
  } catch (e) {
    S.info = null; $('view').hidden = true;
    $('load-msg').textContent = e.shortMessage || e.message;
  }
  render();
}

async function refresh() { if (S.info) await load(); else render(); }

const same = (a, b) => !!a && !!b && a.toLowerCase() === b.toLowerCase();
const FAUCET = 'https://faucet.circle.com';

// What the connected wallet can do right now, in the order a person would do it.
function myActions(I) {
  const me = S.account, R = I.roles, funded = I.status === 1;
  const isClient = same(me, R.client), isOp = same(me, R.operator), isAud = same(me, R.auditor);
  const u = v => `${fmt(v, I.decimals)} ${I.symbol}`;
  const out = [];
  if (isClient && I.status === 0 && I.symbol === 'mUSDC') out.push(['mint', `Get test ${I.symbol}`, 'Free test tokens for this demo.', true]);
  if (isClient && I.status === 0) out.push(['fund', `Fund the escrow (${u(I.price)})`, 'MetaMask asks twice: allow the amount, then send it. The money stays in the contract until work is approved.']);
  if (isOp && funded && I.sealed === I.lines.length) out.push(['release', 'Release the reserve to the treasury', `${u(I.reserve)} — the last step.`]);
  for (const l of I.lines) {
    const n = l.i + 1;
    if (funded && same(me, l.payee) && l.stage === 0) {
      if (!l.times[0]) out.push([`start:${l.i}`, `Start line ${n}`, 'Optional: records when you began. Moves no money.', true]);
      out.push([`deliver:${l.i}`, `Mark line ${n} delivered`, 'Tell the auditor your work is ready to check.']);
    }
    if (funded && isAud && l.stage === 1) out.push([`audit:${l.i}`, `Audit line ${n}`, 'You checked the work and it meets the scope.']);
    if (funded && isClient && l.stage === 2) out.push([`authorize:${l.i}`, `Authorize line ${n}`, 'You approve the work. Next, the operator pays it.']);
    if (funded && isOp && l.stage === 3) out.push([`seal:${l.i}`, `Seal line ${n} and pay ${u(l.labor)}`, 'Pays the worker from the escrow.']);
  }
  const canCancel = (I.status === 0 || funded) && ((isClient && !I.anyDelivered) || (isOp && I.sealed === 0));
  if (canCancel) out.push(['cancel', 'Cancel and refund the client', I.status === 0 ? 'Nothing has been paid in yet.' : `Returns all ${u(I.price)} to the client.`, true]);
  return out;
}

// Who everyone is waiting on, in plain words.
function waitingOn(I) {
  if (I.status === 0) return 'Waiting for the client to fund the escrow.';
  if (I.status === 2) return 'Cancelled. The client was refunded.';
  if (I.status === 3) return 'Complete. Every line is paid and the reserve is released.';
  const who = [];
  for (const l of I.lines) {
    if (l.stage === 0) who.push(`the worker to deliver line ${l.i + 1}`);
    if (l.stage === 1) who.push(`the auditor on line ${l.i + 1}`);
    if (l.stage === 2) who.push(`the client to authorize line ${l.i + 1}`);
    if (l.stage === 3) who.push(`the operator to seal line ${l.i + 1}`);
  }
  if (!who.length) return 'Waiting for the operator to release the reserve.';
  return `Waiting for ${who.slice(0, 3).join(', ')}${who.length > 3 ? ` and ${who.length - 3} more` : ''}.`;
}

function render() {
  $('net-label').textContent = net().live ? 'live' : 'testnet';
  $('net-label').className = net().live ? 'live' : '';
  $('switch-hedera').textContent = `Switch to ${net().name}`;
  document.title = `Engagement Escrow — Bixxville (${net().live ? net().name : 'testnet'})`;
  const badge = $('net-badge');
  if (!window.ethereum) { badge.textContent = 'No wallet'; badge.className = 'badge'; }
  else {
    badge.textContent = `Wallet on: ${nameOf(S.chainId)}`;
    badge.className = 'badge ' + (onRightNetwork() ? 'ok' : 'bad');
  }
  $('connect').textContent = S.account ? `${S.account.slice(0, 6)}…${S.account.slice(-4)}` : 'Connect wallet';

  const wrong = $('wrong-net');
  wrong.hidden = !window.ethereum || onRightNetwork();
  if (!wrong.hidden) {
    wrong.innerHTML = `Your wallet is on <b>${esc(nameOf(S.chainId))}</b>. This escrow is on <b>${esc(net().name)}</b>.<br>
      <button class="btn small" id="switch-target">Switch to ${esc(net().name)}</button>`;
    $('switch-target').onclick = () => switchTo(S.target);
  }
  if (!S.info) return;
  const I = S.info, R = I.roles, me = S.account;
  const u = v => `${fmt(v, I.decimals)} ${esc(I.symbol)}`;

  // ── your next step ──
  const mine = Object.entries(R).filter(([, a]) => same(me, a)).map(([r]) => r);
  const myLines = I.lines.filter(l => same(me, l.payee)).map(l => l.i + 1);
  if (myLines.length) mine.push(`worker on line ${myLines.join(', ')}`);
  $('you').textContent = !me ? 'Connect your wallet to see what you can do.' : mine.length ? `You are the ${mine.join(' and ')}.` : 'This wallet has no part in this escrow. Switch accounts in MetaMask if you have another.';
  const acts = onRightNetwork() && me ? myActions(I) : [];
  $('next').innerHTML = !me ? `<button class="btn" id="connect-2">Connect wallet</button>`
    : !onRightNetwork() ? `<p class="nothing">Switch your wallet to ${esc(net().name)} first (button above).</p>`
    : acts.length ? acts.map(([k, label, why, minor]) => `
        <div class="step ${minor ? 'minor' : ''}"><span><b>${esc(label)}</b><small>${esc(why)}</small></span>
        <button class="btn" data-act="${k}" ${S.busy ? 'disabled' : ''}>${S.busy === k ? 'Working…' : minor ? 'Do it' : 'Go'}</button></div>`).join('')
    : I.status >= 2 ? `<p class="nothing">${esc(waitingOn(I))}</p>`
    : mine.length ? `<p class="nothing">Nothing for you right now. ${esc(waitingOn(I))}</p>` : '';
  const c2 = $('connect-2'); if (c2) c2.onclick = connect;

  // Wallet help: USDC for the client, HBAR for fees.
  const help = [];
  if (me && onRightNetwork() && I.balances) {
    if (same(me, R.client) && I.status === 0 && I.balances.token < I.price) {
      help.push(`You have <b>${u(I.balances.token)}</b>; funding needs <b>${u(I.price)}</b>.
        ${net().key === 'hedera-testnet' && I.symbol === 'USDC' ? `Get free test USDC from Circle (choose <b>Hedera Testnet</b> and paste <code>${esc(me)}</code>).<br><a class="btn small" href="${FAUCET}" target="_blank" rel="noopener">Get test USDC</a>` : ''}`);
    }
    if (I.symbol === 'USDC' && (same(me, R.client) || myLines.length || same(me, R.treasury))) {
      help.push(`<button class="btn small ghost" id="watch-usdc">Show USDC in MetaMask</button>`);
    }
    if (mine.length && I.balances.gas < 0.5 && I.status < 2) {
      help.push(`Your wallet has ${I.balances.gas.toFixed(2)} ${esc(net().currency.symbol)}. Each step costs a small network fee, so add a few ${esc(net().currency.symbol)}${net().faucet ? ` (free on testnet: <a href="${net().faucet}" target="_blank" rel="noopener">Hedera faucet</a>)` : ''}.`);
    }
  }
  $('wallet-help').innerHTML = help.map(h => `<div class="help">${h}</div>`).join('');
  const w = $('watch-usdc'); if (w) w.onclick = watchToken;

  // ── engagement ──
  $('state').textContent = `${STATUSES[I.status]} · ${I.sealed} of ${I.lines.length} line${I.lines.length === 1 ? '' : 's'} paid`;
  // Arrived by link: the contract is known, so the loader box is just noise.
  const viaLink = params.get('engagement') && same(params.get('engagement'), I.addr);
  $('load-card').hidden = !!viaLink;
  $('contract-line').innerHTML = `Escrow ${addrLink(I.addr)}${viaLink ? ` · <a href="#" id="show-loader">open a different one</a>` : ''}`;
  const sl = $('show-loader'); if (sl) sl.onclick = ev => { ev.preventDefault(); $('load-card').hidden = false; sl.remove(); };
  $('waiting').textContent = waitingOn(I);
  const names = ['Started', 'Delivered', 'Audited', 'Authorized', 'Sealed'];
  const by = ['worker', 'worker', 'auditor', 'client', 'operator'];
  $('lines').innerHTML = I.lines.map(l => {
    const chips = names.map((n, k) => {
      const done = l.times[k] > 0;
      const next = I.status === 1 && ((k === 0 && l.stage === 0 && !done) || (k > 0 && l.stage === k - 1));
      return `<li class="${done ? 'done' : ''} ${next ? 'next' : ''} ${k === 0 ? 'opt' : ''}" data-stamp="${n}"><b>${n}</b><small>${by[k]}${k === 0 ? ' · optional' : ''}${done ? '<br>' + new Date(l.times[k] * 1000).toLocaleString() : ''}</small></li>`;
    }).join('');
    return `<div class="lineCard" data-line="${l.i}">
      <div class="lineHead"><span><b>Line ${l.i + 1}</b> · ${u(l.labor)}</span><span>worker ${addrLink(l.payee)}${same(me, l.payee) ? '<span class="you">YOU</span>' : ''}</span></div>
      <ol class="stamps">${chips}</ol></div>`;
  }).join('');

  $('money').innerHTML = `
    <dt>Price (client pays)</dt><dd>${u(I.price)}</dd>
    <dt>Labor, all lines</dt><dd>${u(I.labor)}</dd>
    <dt>Reserve (25%, to treasury)</dt><dd>${u(I.reserve)}${I.status === 3 ? ' — released' : ''}</dd>
    <dt>Held in contract now</dt><dd id="held">${u(I.held)}</dd>
    <dt>Token</dt><dd>${addrLink(I.token)}</dd>`;
  const tag = a => (same(me, a) ? '<span class="you">YOU</span>' : '');
  $('people').innerHTML = Object.entries(R).map(([r, a]) => `<dt>${r}</dt><dd>${addrLink(a)}${tag(a)}</dd>`).join('');
  document.querySelectorAll('[data-act]').forEach(b => b.onclick = () => act(b.dataset.act));
}

// Lets MetaMask show the escrow's token (Circle USDC) in the wallet.
async function watchToken() {
  try {
    await window.ethereum.request({ method: 'wallet_watchAsset', params: { type: 'ERC20', options: { address: S.info.token, symbol: S.info.symbol, decimals: S.info.decimals } } });
  } catch (e) { $('err').textContent = e.message; }
}

async function act(key) {
  $('err').textContent = '';
  // Check the network again right before signing; the wallet may have changed.
  S.chainId = Number(await window.ethereum.request({ method: 'eth_chainId' }));
  if (!onRightNetwork()) { render(); $('err').textContent = `Blocked: switch your wallet to ${net().name} first.`; return; }
  const I = S.info;
  const [name, arg] = key.split(':');
  const i = arg == null ? null : Number(arg);
  const signer = await new ethers.BrowserProvider(window.ethereum).getSigner();
  const e = new ethers.Contract(I.addr, ENGAGEMENT_ABI, signer);
  const t = new ethers.Contract(I.token, TOKEN_ABI, signer);
  // Each contract call is tried as a read first, so a refusal shows its reason
  // in plain words before the wallet asks to sign anything.
  const call = (fn, ...a) => () => e[fn].staticCall(...a).then(() => e[fn](...a));
  const L = i == null ? '' : `line ${i + 1} `;
  const steps = {
    mint: [['mint test tokens', () => t.mint(S.account, I.price)]],
    fund: [['approve', () => t.approve(I.addr, I.price)], ['fund', call('fund')]],
    start: [[`${L}Started`, call('markStarted', i)]],
    deliver: [[`${L}Delivered`, call('markDelivered', i)]],
    audit: [[`${L}Audited`, call('markAudited', i)]],
    authorize: [[`${L}Authorized`, call('authorize', i)]],
    seal: [[`${L}Sealed`, call('seal', i)]],
    release: [['release reserve', call('releaseReserve')]],
    cancel: [['cancel', call('cancel')]],
  }[name];
  S.busy = key; render();
  try {
    for (const [label, send] of steps) {
      const tx = await send();
      const rc = await tx.wait();
      logTx(label, tx.hash, rc.status === 1);
      if (rc.status !== 1) throw new Error(`${label} failed on-chain.`);
    }
  } catch (err) {
    const data = err.data || err.info?.error?.data?.result || err.info?.error?.data;
    let reason = err.shortMessage || err.message;
    try { if (typeof data === 'string') reason = REASONS[e.interface.parseError(data).name] || reason; } catch {}
    $('err').textContent = reason;
  } finally {
    S.busy = false;
    await load();
  }
}

function logTx(label, hash, ok) {
  $('logcard').hidden = false;
  const li = document.createElement('li');
  if (!ok) li.className = 'fail';
  li.dataset.step = label;
  li.innerHTML = `${ok ? '✓' : '✗'} <b>${esc(label)}</b> ${txLink(hash)}`;
  $('log').prepend(li);
}

init().catch(e => { $('load-msg').textContent = e.message; });
