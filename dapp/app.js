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
  $('switch-hedera').onclick = () => switchTo('hedera-testnet');
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
    if (key === 'hedera-testnet') {
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
    S.info = { addr, token, symbol, decimals, status: Number(sum._status), price: sum._price, labor: sum._laborTotal, reserve: sum._reserve,
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
const button = (key, label, enabled, note) =>
  `<div class="act"><span>${esc(label)}<br><small>${esc(note)}</small></span><button class="btn small" data-act="${key}" ${enabled ? '' : 'disabled'}>Go</button></div>`;

function render() {
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
    wrong.innerHTML = `Your wallet is on <b>${esc(nameOf(S.chainId))}</b>. This engagement is on <b>${esc(net().name)}</b>. Actions are blocked until you switch.<br>
      <button class="btn small" id="switch-target">Switch to ${esc(net().name)}</button>`;
    $('switch-target').onclick = () => switchTo(S.target);
  }
  if (!S.info) return;
  const I = S.info, R = I.roles, me = S.account;
  const live = onRightNetwork() && !S.busy;
  const funded = I.status === 1;
  const u = v => `${fmt(v, I.decimals)} ${esc(I.symbol)}`;
  const gate = (isRole, ok, roleName, why) => [live && isRole && ok, !onRightNetwork() ? 'Wrong network' : !isRole ? `Only the ${roleName}` : !ok ? why : why];

  $('state').textContent = `${STATUSES[I.status]} · ${I.sealed} of ${I.lines.length} line${I.lines.length === 1 ? '' : 's'} sealed`
    + (I.status === 3 ? ' · reserve released' : '');

  // Engagement-wide actions
  const isClient = same(me, R.client), isOp = same(me, R.operator);
  const canCancel = (I.status === 0 || funded) && ((isClient && !I.anyDelivered) || (isOp && I.sealed === 0));
  const acts = [
    ['mint', `Get test ${I.symbol}`, ...gate(isClient, I.status === 0 && I.symbol === 'mUSDC', 'client', 'Test token only, before funding')],
    ['fund', `Fund escrow (${u(I.price)})`, ...gate(isClient, I.status === 0, 'client', 'Client, before funding')],
    ['release', 'Release reserve to treasury', ...gate(isOp, funded && I.sealed === I.lines.length, 'operator', 'Operator, after every line is sealed')],
    ['cancel', 'Cancel and refund client', live && (isClient || isOp) && canCancel,
      !onRightNetwork() ? 'Wrong network' : 'Client before any Delivered; operator before any Sealed'],
  ];
  $('eng-actions').innerHTML = acts.map(([k, l, en, note]) => button(k, l, en, note)).join('');

  // Lines
  const names = ['Started', 'Delivered', 'Audited', 'Authorized', 'Sealed'];
  const by = ['payee', 'payee', 'auditor', 'client', 'operator'];
  $('lines').innerHTML = I.lines.map(l => {
    const isPayee = same(me, l.payee);
    const chips = names.map((n, k) => {
      const done = l.times[k] > 0;
      const next = funded && ((k === 0 && l.stage === 0 && !done) || (k > 0 && l.stage === k - 1));
      return `<li class="${done ? 'done' : ''} ${next ? 'next' : ''} ${k === 0 ? 'opt' : ''}" data-stamp="${n}"><b>${n}</b><small>${by[k]}${k === 0 ? ' · optional' : ''}${done ? '<br>' + new Date(l.times[k] * 1000).toLocaleString() : ''}</small></li>`;
    }).join('');
    const la = [
      [`start:${l.i}`, 'Stamp Started (optional)', ...gate(isPayee, funded && l.stage === 0 && !l.times[0], 'payee', 'Payee, before Delivered')],
      [`deliver:${l.i}`, 'Stamp Delivered', ...gate(isPayee, funded && l.stage === 0, 'payee', 'Payee, after funding')],
      [`audit:${l.i}`, 'Stamp Audited', ...gate(same(me, R.auditor), funded && l.stage === 1, 'auditor', 'Auditor, after Delivered')],
      [`authorize:${l.i}`, 'Stamp Authorized', ...gate(isClient, funded && l.stage === 2, 'client', 'Client, after Audited')],
      [`seal:${l.i}`, `Seal and pay ${u(l.labor)}`, ...gate(isOp, funded && l.stage === 3, 'operator', 'Operator, after Authorized')],
    ];
    return `<div class="lineCard" data-line="${l.i}">
      <div class="lineHead"><span><b>Line ${l.i + 1}</b> · ${u(l.labor)}</span><span>payee ${addrLink(l.payee)}${isPayee ? '<span class="you">YOU</span>' : ''}</span></div>
      <ol class="stamps">${chips}</ol>
      <div class="actions">${la.map(([k, lb, en, note]) => button(k, lb, en, note)).join('')}</div></div>`;
  }).join('');

  $('money').innerHTML = `
    <dt>Price (client pays)</dt><dd>${u(I.price)}</dd>
    <dt>Labor, all lines</dt><dd>${u(I.labor)}</dd>
    <dt>Reserve (25%, to treasury)</dt><dd>${u(I.reserve)}${I.status === 3 ? ' — released' : ''}</dd>
    <dt>Held in contract now</dt><dd id="held">${u(I.held)}</dd>
    <dt>Token</dt><dd>${addrLink(I.token)}</dd>`;
  const tag = a => (same(me, a) ? '<span class="you">YOU</span>' : '');
  $('people').innerHTML = Object.entries(R).map(([r, a]) => `<dt>${r}</dt><dd>${addrLink(a)}${tag(a)}</dd>`).join('');

  const mine = Object.entries(R).filter(([, a]) => same(me, a)).map(([r]) => r);
  const myLines = I.lines.filter(l => same(me, l.payee)).map(l => l.i + 1);
  if (myLines.length) mine.push(`payee on line ${myLines.join(', ')}`);
  $('you').textContent = !me ? 'Connect your wallet to act.' : mine.length ? `You are the ${mine.join(' and ')}.` : 'Your wallet has no role on this engagement.';
  document.querySelectorAll('[data-act]').forEach(b => b.onclick = () => act(b.dataset.act));
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
  S.busy = true; render();
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
