// The Analog panel. It is handed the host app's small helpers, so the same panel can sit in any of the apps.
//   host = { openOverlay(title, bodyFn, actionLabel, actionFn, push), closeOverlay(), toast(msg), esc(text), operator() }

import { IdbStore, MemoryStore } from './store.js';
import { Keyring, createIdentity, restoreIdentity, keyCard, readKeyCard, BACKUP_WARNING } from './keys.js';
import { Log } from './log.js';
import { exportBundle, importBundle } from './bundle.js';
import { encodeFrames, FrameAssembler } from './frames.js';
import { Peer, StoreFiles, publishFile } from './sync.js';
import { rtcAvailable, createOffer, acceptOffer, acceptAnswer, toBytes, fromBytes } from './rtc.js';
import { QrPlayer, QrScanner, cameraAvailable, loadQr, qrSvg } from './qr.js';
import { enc, dec, hex, sha256, fmtAye } from './canon.js';
import { STAMP_CLASSES, TYPES } from './schema.js';
import { compactEncode, refHash, verifyCompact, createRecord } from './record.js';
import { RadioBridge, PracticeLink, RateLimiter, generatePsk, isPrivateChannel } from './radio.js';
import { webBluetoothAvailable, loadMeshLibrary, connectNode, applyPrivateChannel, verifyNodeChannel } from './meshlink.js';
import { b64u, unb64u, unhex } from './canon.js';

const A = { ready: null, tab: 'status', host: null };
const ROLES = ['', 'payee', 'auditor', 'client', 'operator'];

async function ensure(host) {
  A.host = host;
  if (!A.ready) A.ready = (async () => {
    let store; try { store = new IdbStore(); await store.get('settings', 'x'); } catch (e) { store = new MemoryStore(); A.volatile = true; }
    A.store = store; A.keyring = await new Keyring(store).load();
    A.log = await new Log(store, A.keyring).load();
    A.files = new StoreFiles(store);
    A.identity = (await store.get('identity', 'me')) || null;
    A.settings = (await store.get('settings', 'main')) || {};
    A.asm = new FrameAssembler();
  })();
  await A.ready;
  return A;
}
const saveSettings = () => A.store.put('settings', 'main', A.settings);
const $ = (s, r = document) => r.querySelector(s);
const esc = (t) => A.host.esc(String(t ?? ''));
const short = (fp) => (fp ? fp.slice(0, 8) + '…' + fp.slice(-4) : '—');
const ago = (t) => { if (!t) return 'never'; const m = Math.round((Date.now() - t) / 60000); return m < 1 ? 'just now' : m < 60 ? m + ' min ago' : m < 1440 ? Math.round(m / 60) + ' h ago' : Math.round(m / 1440) + ' d ago'; };
const nameOf = (fp) => A.keyring.get(fp)?.label || short(fp);

export async function renderAnalog(panel, host) {
  await ensure(host);
  A.panel = panel;
  draw();
}
function draw() {
  const tabs = [['status', 'Status'], ['send', 'Send / Receive'], ['nearby', 'Nearby'], ['radio', 'Radio'], ['log', 'Log']];
  A.panel.innerHTML = `<div class="an-wrap">
    <div class="pp-head"><div><h2>Analog</h2><p>Work and stamps that move with no internet: by QR, by file, and between phones on the same Wi-Fi.</p></div></div>
    <div class="term-tabs an-tabs">${tabs.map(([k, l]) => `<button class="term-tab ${A.tab === k ? 'active' : ''}" data-tab="${k}"><i class="tdot"></i>${l}</button>`).join('')}</div>
    <div id="an-body"></div></div>`;
  A.panel.querySelectorAll('[data-tab]').forEach((b) => { b.onclick = () => { A.tab = b.dataset.tab; draw(); }; });
  ({ status: tabStatus, send: tabSend, nearby: tabNearby, radio: tabRadio, log: tabLog })[A.tab]($('#an-body', A.panel));
}
const refresh = () => { if (A.panel?.isConnected) draw(); };

// ───────────────────────── Status ─────────────────────────
function carrierRows() {
  const bt = !!navigator.bluetooth;
  return [
    ['Local', true, `Saved on this device${A.volatile ? ' (private browsing: lost when this tab closes)' : ''}.`],
    ['QR', cameraAvailable(), cameraAvailable() ? 'Camera available. Codes can also be pasted.' : 'No camera access in this browser. Paste codes instead.'],
    ['Hotspot', rtcAvailable(), rtcAvailable() ? 'Two phones on the same Wi-Fi or hotspot can sync with no internet.' : 'Local-network sync is not available in this browser.'],
    ['Bluetooth', bt, bt ? 'Web Bluetooth is available (needed for the radio node).' : 'Web Bluetooth is not available in this browser (iPhone has none; use Android Chrome or desktop Chrome).'],
    ['Radio', false, 'Not built yet. It needs a Meshtastic LoRa node (Phase 2).'],
  ];
}
function tabStatus(el) {
  const c = A.log.counts(), v = A.log.view();
  const n = (b) => v.filter((x) => x.badge === b).length;
  el.innerHTML = `
    ${A.identity ? `<div class="an-card"><h4>Your signing key</h4>
      <div class="an-kv"><span>Fingerprint</span><code>${esc(A.identity.fp)}</code></div>
      <div class="an-kv"><span>Backup</span><b>${A.settings.backupAt ? 'saved ' + esc(ago(A.settings.backupAt)) : '<span class="ck-bad">not saved</span>'}</b></div>
      ${A.settings.backupAt ? '' : `<p class="pp-muted">${esc(BACKUP_WARNING)} A key already on this device cannot be exported, so if you skipped the backup, the only fix is a new key.</p>`}
      <div class="ck-acts"><button class="pp-btn" id="an-card">Show my key card</button><button class="pp-btn" id="an-scancard">Scan someone's key card</button></div></div>`
    : `<div class="an-card"><h4>Create your signing key</h4>
      <p>Records are signed with a key that stays on this device and cannot be read back out of it. Making the key also makes an encrypted backup file. ${esc(BACKUP_WARNING)}</p>
      <label class="ck-fld"><span>Backup passphrase (8 or more characters)</span><input id="an-pass" type="password" class="sch-in" autocomplete="new-password"></label>
      <div class="pp-form-msg" id="an-kmsg"></div>
      <div class="ck-acts"><button class="pp-btn solid" id="an-make">Create key and download backup</button>
      <label class="pp-btn">Restore from a backup file<input id="an-restore" type="file" accept=".json,application/json" hidden></label></div></div>`}
    <div class="an-card"><h4>Carriers</h4>${carrierRows().map(([k, ok, t]) => `<div class="an-row"><i class="an-dot ${ok ? 'on' : ''}"></i><b>${k}</b><span>${esc(t)}</span></div>`).join('')}</div>
    <div class="an-card"><h4>Records</h4>
      <div class="an-stats"><div><b>${c.Local}</b><small>Local</small></div><div><b>${c.Relayed}</b><small>Relayed</small></div><div><b>${c.Anchored}</b><small>Anchored</small></div>
      <div><b>${n('pending')}</b><small>Pending</small></div><div><b>${n('gap') + n('fork')}</b><small>Need a look</small></div></div>
      <p class="pp-muted">Last sync with another device: ${esc(ago(A.settings.lastSync))}. Local is only on this device; Relayed was seen by another device; Anchored needs a confirmed on-chain record, and nothing here can confirm one yet.</p></div>
    <div class="an-card"><h4>Keys this device trusts</h4>
      ${A.keyring.all().map((k) => `<div class="an-row"><b>${esc(k.label || 'Unnamed')}</b><code>${esc(short(k.fp))}</code>
        ${k.trust === 'self' ? '<span>you</span>' : `<select data-role="${esc(k.fp)}" class="sch-in sm">${ROLES.map((r) => `<option value="${r}" ${k.role === r ? 'selected' : ''}>${r || 'role…'}</option>`).join('')}</select><button class="term-card-btn" data-rm="${esc(k.fp)}">Remove</button>`}</div>`).join('') || '<div class="pp-muted">None.</div>'}
      <p class="pp-muted">A record is accepted only from a key listed here. Add a key by scanning its card in person.</p></div>`;
  $('#an-make', el)?.addEventListener('click', makeKey);
  $('#an-restore', el)?.addEventListener('change', restoreKey);
  $('#an-card', el)?.addEventListener('click', showKeyCard);
  $('#an-scancard', el)?.addEventListener('click', () => scanDialog({ title: "Scan a key card", hint: 'Ask the other person to open Status → Show my key card.', onBytes: onKeyCardBytes }));
  el.querySelectorAll('[data-role]').forEach((s) => { s.onchange = async () => { const e = A.keyring.get(s.dataset.role); e.role = s.value; await A.store.put('keyring', e.fp, e); refresh(); }; });
  el.querySelectorAll('[data-rm]').forEach((b) => { b.onclick = async () => { if (confirm('Stop trusting this key? New records from it will be refused. Records already held stay.')) { await A.keyring.remove(b.dataset.rm); refresh(); } }; });
}
function download(name, text, type = 'application/json') {
  const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([text], { type })); a.download = name; document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 4000);
}
async function makeKey() {
  const msg = $('#an-kmsg'), pass = $('#an-pass').value;
  try {
    msg.textContent = 'Making the key…';
    const { identity, backup } = await createIdentity(pass);
    A.identity = identity; await A.store.put('identity', 'me', identity);
    await A.keyring.add({ fp: identity.fp, pub: hex(identity.pubRaw), label: A.host.operator()?.peer_name || 'Me', trust: 'self' });
    download(`bixxville-key-backup-${identity.fp.slice(0, 8)}.json`, JSON.stringify(backup, null, 1));
    A.settings.backupAt = Date.now(); await saveSettings();
    A.host.toast('Key created. Keep the backup file safe and offline.'); refresh();
  } catch (e) { msg.textContent = e.message; }
}
async function restoreKey(ev) {
  const f = ev.target.files[0]; if (!f) return;
  const pass = prompt('Passphrase for this backup:'); if (!pass) return;
  try {
    const identity = await restoreIdentity(JSON.parse(await f.text()), pass);
    A.identity = identity; await A.store.put('identity', 'me', identity);
    if (!A.keyring.has(identity.fp)) await A.keyring.add({ fp: identity.fp, pub: hex(identity.pubRaw), label: A.host.operator()?.peer_name || 'Me', trust: 'self' });
    A.settings.backupAt = Date.now(); await saveSettings(); A.host.toast('Key restored.'); refresh();
  } catch (e) { A.host.toast(e.message); }
}
async function showKeyCard() {
  const bytes = enc.encode(JSON.stringify(keyCard(A.identity, A.host.operator()?.peer_name || '')));
  showFrames('My key card', bytes, 'The other person scans this to trust your key. Check the fingerprint matches before they confirm.', short(A.identity.fp));
}
async function onKeyCardBytes(bytes) {
  let j; try { j = JSON.parse(dec.decode(bytes)); } catch (e) { j = null; }
  if (j?.format !== 'bixx-key-card') { const st = $('#an-sst'); if (st) st.textContent = 'That code is not a key card. Keep looking.'; return false; }
  const card = await readKeyCard(j);
  if (A.keyring.has(card.fp)) { A.host.toast('You already trust that key.'); A.scanner?.stop(); A.host.closeOverlay(); return false; }
  A.host.openOverlay('Trust this key?', (body) => {
    body.innerHTML = `<div class="term-wf"><p>Only trust a key if you scanned it from the person's own phone. Anyone who holds this key can sign records that this device will accept.</p>
      <div class="an-kv"><span>Name on the card</span><b>${esc(card.label || '—')}</b></div><div class="an-kv"><span>Fingerprint</span><code>${esc(card.fp)}</code></div>
      <label class="ck-fld"><span>Name to show</span><input id="an-tn" class="sch-in" value="${esc(card.label)}" maxlength="40"></label>
      <label class="ck-fld"><span>Role</span><select id="an-tr" class="sch-in">${ROLES.map((r) => `<option value="${r}">${r || 'none yet'}</option>`).join('')}</select></label>
      <button class="pp-btn solid big" id="an-tok">Trust this key</button></div>`;
    $('#an-tok', body).onclick = async () => { await A.keyring.add({ fp: card.fp, pub: card.pub, label: $('#an-tn', body).value, role: $('#an-tr', body).value }); A.host.closeOverlay(); A.host.toast('Key trusted.'); refresh(); };
  }, null, null, true);
  A.scanner?.stop();      // the trust question is on top now; do not close it from under the person
  return false;
}

// ───────────────────────── QR dialogs ─────────────────────────
async function showFrames(title, bytes, hint = '', tag = '') {
  let frames;
  try { frames = await encodeFrames(bytes); } catch (e) { A.host.toast(e.message); return; }
  A.host.openOverlay(title, (body) => {
    body.innerHTML = `<div class="term-wf" style="text-align:center"><div id="an-qr" class="an-qr"></div>
      <div class="pp-muted" id="an-qrn">${frames.length === 1 ? 'One code' : `${frames.length} frames`}${tag ? ' · ' + esc(tag) : ''}</div>
      <p class="pp-muted">${esc(hint)}${frames.length > 1 ? ' Hold it steady while the other phone scans; the frames repeat until every one has been seen.' : ''}</p>
      ${frames.length > 40 ? '<p class="ck-bad">That is a lot of frames. A .bixx file will be faster.</p>' : ''}
      ${frames.length > 1 ? '<button class="pp-btn" id="an-pause">Pause</button>' : ''}</div>`;
    const player = new QrPlayer($('#an-qr', body), frames); A.player = player;
    player.onTick = (i, n) => { const x = $('#an-qrn'); if (x && n > 1) x.textContent = `Frame ${i} of ${n}${tag ? ' · ' + tag : ''}`; };
    player.start().catch((e) => { body.innerHTML = `<div class="term-panel-empty">${esc(e.message)}</div>`; });
    $('#an-pause', body)?.addEventListener('click', (e) => { if (player.timer) { player.stop(); e.target.textContent = 'Resume'; } else { player.start(); e.target.textContent = 'Pause'; } });
  }, null, null, true);
}
// A scanner with a paste box. `onBytes(bytes)` gets the assembled payload; return true to close the dialog.
function scanDialog({ title, hint, onBytes, inline = false }) {
  const asm = new FrameAssembler();
  const handle = async (text) => {
    for (const line of String(text).split(/\s+/).filter(Boolean)) {
      const r = asm.add(line);
      const st = $('#an-sst'); 
      if (!r.ok) { if (st) st.textContent = r.reason; continue; }
      if (st) st.textContent = r.total === 1 ? 'Reading…' : `Frames ${r.have} of ${r.total}`;
      if (r.done) {
        try {
          const bytes = await asm.result(), close = await onBytes(bytes);
          if (close !== false) { scanner?.stop(); if (!inline) A.host.closeOverlay(); }
        } catch (e) { if (st) st.textContent = e.message; asm.reset(); }
        return;
      }
    }
  };
  let scanner = null;
  A.host.openOverlay(title, (body) => {
    body.innerHTML = `<div class="term-wf"><div class="ck-cam"><video id="an-video" playsinline muted></video><div class="ck-frame"></div></div>
      <div class="pp-form-msg" id="an-sst">${cameraAvailable() ? 'Starting the camera…' : 'No camera here. Paste the code below.'}</div>
      <p class="pp-muted">${esc(hint || '')}</p>
      <textarea id="an-paste" class="sch-in" rows="2" placeholder="…or paste the code (BXF1…)" style="width:100%;box-sizing:border-box"></textarea>
      <button class="pp-btn" id="an-pgo">Use pasted code</button></div>`;
    $('#an-pgo', body).onclick = () => handle($('#an-paste', body).value);
    if (cameraAvailable()) { scanner = new QrScanner($('#an-video', body), handle); A.scanner = scanner; scanner.start().then(() => { const s = $('#an-sst'); if (s && !asm.current) s.textContent = 'Point the camera at the code.'; }).catch((e) => { const s = $('#an-sst'); if (s) s.textContent = e.name === 'NotAllowedError' ? 'Camera permission was declined. Paste the code instead.' : e.message; }); }
  }, null, null, true);
  return { handle, stop: () => scanner?.stop() };
}
document.addEventListener('visibilitychange', () => { if (document.hidden) A.scanner?.stop(); });

// ───────────────────────── Send / Receive ─────────────────────────
function tabSend(el) {
  const can = !!A.identity;
  el.innerHTML = `${can ? '' : '<div class="an-card"><b>Create your signing key first</b> (Status tab). Bundles are signed with it.</div>'}
    <div class="an-card"><h4>Send</h4>
      <div class="ck-acts"><button class="pp-btn solid" id="an-s-qr" ${can ? '' : 'disabled'}>Show all as QR</button>
      <button class="pp-btn" id="an-s-file" ${can ? '' : 'disabled'}>Save as .bixx file</button>
      <button class="pp-btn" id="an-s-share" ${can ? '' : 'disabled'}>Share…</button></div>
      <p class="pp-muted">${A.log.size} record${A.log.size === 1 ? '' : 's'} on this device. Pick single records in the Log tab to send just those.</p></div>
    <div class="an-card"><h4>Receive</h4>
      <div class="ck-acts"><button class="pp-btn solid" id="an-r-scan">Scan QR</button>
      <label class="pp-btn">Open a .bixx file<input id="an-r-file" type="file" accept=".bixx,.json,application/json" hidden></label></div>
      <div id="an-result"></div></div>`;
  $('#an-s-qr', el).onclick = async () => { try { showFrames('Records as QR', enc.encode(await exportBundle(A.log, A.identity)), 'The other device scans this with Send / Receive → Scan QR.', `${A.log.size} records`); } catch (e) { A.host.toast(e.message); } };
  $('#an-s-file', el).onclick = async () => { try { download(`bixxville-${fmtAye(Math.floor(Date.now() / 1000)).slice(0, 10)}.bixx`, await exportBundle(A.log, A.identity), 'application/json'); } catch (e) { A.host.toast(e.message); } };
  $('#an-s-share', el).onclick = () => shareBundle();
  $('#an-r-scan', el).onclick = () => scanDialog({ title: 'Scan records', hint: 'Scan a bundle or a single record shown by another phone.', onBytes: (b) => { const t = dec.decode(b); if (t.includes('"bixx-key-card"')) { const st = $('#an-sst'); if (st) st.textContent = 'That is a key card, not records. Keep looking.'; return false; } return doImport(t); } });
  $('#an-r-file', el).onchange = async (e) => { const f = e.target.files[0]; if (f) await doImport(await f.text()); e.target.value = ''; };
}
async function shareBundle(ids) {
  try {
    const text = await exportBundle(A.log, A.identity, { ids });
    const file = new File([text], 'bixxville.bixx', { type: 'application/json' });
    if (navigator.canShare?.({ files: [file] })) await navigator.share({ files: [file], title: 'Bixxville records' });
    else { download('bixxville.bixx', text); A.host.toast('Sharing files is not available here, so the file was saved instead.'); }
  } catch (e) { if (e.name !== 'AbortError') A.host.toast(e.message); }
}
async function doImport(text) {
  const r = await importBundle(text, A.log);
  const box = $('#an-result');
  const html = r.error ? `<p class="ck-bad">${esc(r.error)}</p>` : `
    <div class="an-stats"><div><b>${r.accepted.length}</b><small>Accepted</small></div><div><b>${r.duplicate.length}</b><small>Already had</small></div><div><b>${r.rejected.length}</b><small>Rejected</small></div></div>
    ${r.sender && !r.sender.known ? `<p class="pp-muted">The sender (${esc(short(r.sender.fp))}) is not a key you trust, so the bundle's own signature could not be checked. Each record was still checked on its own.</p>` : ''}
    ${r.rejected.map((x) => `<div class="an-row"><i class="an-dot bad"></i><code>${esc(String(x.id || '').slice(0, 8) || '—')}</code><span>${esc(x.reason)}</span></div>`).join('')}
    ${r.unknownKeys.map((k) => `<div class="an-row"><b>${esc(k.label || 'Unknown')}</b><code>${esc(short(k.fp))}</code><button class="term-card-btn" data-trust="${esc(k.fp)}">Trust this key and import again</button></div>`).join('')}`;
  if (!r.error && r.accepted.length) { A.settings.lastSync = Date.now(); await saveSettings(); }
  if (box && A.panel.isConnected) {
    box.innerHTML = html;
    box.querySelectorAll('[data-trust]').forEach((b) => { b.onclick = async () => { const k = r.unknownKeys.find((x) => x.fp === b.dataset.trust); await A.keyring.add(k); await doImport(text); }; });
  } else A.host.toast(r.error || `${r.accepted.length} accepted, ${r.duplicate.length} already had, ${r.rejected.length} rejected.`);
  refreshCountsSoon();
  return true;
}
const refreshCountsSoon = () => setTimeout(() => { if (A.tab === 'status' || A.tab === 'log') refresh(); }, 50);

// ───────────────────────── Nearby (local network) ─────────────────────────
function tabNearby(el) {
  const N = A.nearby || (A.nearby = { log: [], files: {}, state: 'idle' });
  const can = !!A.identity && rtcAvailable();
  const manifests = A.log.snapshot().filter((r) => r.type === 'file_manifest');
  el.innerHTML = `<div class="an-card"><h4>Phone to phone on the same Wi-Fi or hotspot</h4>
    <p>No internet is needed, only that both phones are on the same Wi-Fi or one phone's hotspot. One phone starts, the other joins; each shows a code and the other scans it. Then the two logs match.</p>
    ${can ? '' : `<p class="ck-bad">${A.identity ? 'Local-network sync is not available in this browser.' : 'Create your signing key first (Status tab).'}</p>`}
    <div class="ck-acts"><button class="pp-btn solid" id="an-host" ${can ? '' : 'disabled'}>Start (show a code)</button><button class="pp-btn" id="an-join" ${can ? '' : 'disabled'}>Join (scan a code)</button>
    ${N.state === 'connected' ? '<button class="pp-btn" id="an-sync">Sync again</button><button class="pp-btn" id="an-close">Disconnect</button>' : ''}</div>
    <div class="pp-form-msg" id="an-nmsg">${esc(N.status || (N.state === 'connected' ? 'Connected.' : ''))}</div>
    ${N.log.slice(-8).map((l) => `<div class="an-row"><i class="an-dot ${l.bad ? 'bad' : 'on'}"></i><span>${esc(l.text)}</span></div>`).join('')}
    ${(N.unknown || []).map((k) => `<div class="an-row"><b>${esc(k.label || 'Unknown')}</b><code>${esc(short(k.fp))}</code><button class="term-card-btn" data-trust="${esc(k.fp)}">Trust this key</button></div>`).join('')}</div>
    <div class="an-card"><h4>Files</h4>${manifests.map((m) => `<div class="an-row"><b>${esc(m.payload.name)}</b><span>${(m.payload.size / 1024).toFixed(1)} KB · from ${esc(nameOf(m.author))}</span>
      <span data-held="${esc(m.payload.sha256)}">…</span></div>`).join('') || '<div class="pp-muted">No file manifests yet. Add a file in the Log tab.</div>'}
      <p class="pp-muted">A file is only requested when a signed manifest for it is in the log, and it is checked against the manifest's hash when it arrives.</p></div>`;
  $('#an-host', el)?.addEventListener('click', hostFlow); $('#an-join', el)?.addEventListener('click', joinFlow);
  $('#an-close', el)?.addEventListener('click', () => { A.peer?.ch?.close(); });
  $('#an-sync', el)?.addEventListener('click', () => A.peer?.start());
  el.querySelectorAll('[data-trust]').forEach((b) => { b.onclick = async () => { const k = N.unknown.find((x) => x.fp === b.dataset.trust); await A.keyring.add(k); N.unknown = N.unknown.filter((x) => x !== k); A.peer?.start(); refresh(); }; });
  el.querySelectorAll('[data-held]').forEach(async (s) => {
    const sha = s.dataset.held, held = await A.peer?.have(sha) ?? await (async () => !!(await A.files.get(sha))?.bytes)();
    s.innerHTML = held ? `<button class="term-card-btn" data-save="${esc(sha)}">Save</button>` : (N.state === 'connected' ? `<button class="term-card-btn" data-get="${esc(sha)}">Get</button>` : 'not on this device');
    s.querySelector('[data-get]')?.addEventListener('click', () => A.peer.requestFile(sha).catch((e) => A.host.toast(e.message)));
    s.querySelector('[data-save]')?.addEventListener('click', () => saveFile(sha));
  });
}
async function saveFile(sha) {
  const f = await A.files.get(sha); if (!f?.bytes) return;
  const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([f.bytes])); a.download = f.name; document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 4000);
}
function note(text, bad = false) { const N = A.nearby; N.log.push({ text, bad }); if (A.tab === 'nearby') refresh(); }
function startPeer(channel) {
  const N = A.nearby;
  A.peer = new Peer({ log: A.log, identity: A.identity, files: A.files, onEvent: async (e) => {
    if (e.kind === 'hello') { N.unknown = e.unknownKeys; note(`Connected to ${nameOf(e.fp)}${e.trusted ? '' : ' (a key you do not trust yet)'}.`, !e.trusted); }
    else if (e.kind === 'received') { note(`Received ${e.accepted} new, ${e.duplicate} already had${e.rejected.length ? `, ${e.rejected.length} rejected (${[...new Set(e.rejected.map((r) => r.reason))].join('; ')})` : ''}.`, !!e.rejected.length); }
    else if (e.kind === 'complete') { A.settings.lastSync = Date.now(); await saveSettings(); note('Both logs are up to date.'); }
    else if (e.kind === 'file-progress') { N.status = `Receiving… ${Math.round(e.got / e.size * 100)}%`; if (A.tab === 'nearby') { const m = $('#an-nmsg'); if (m) m.textContent = N.status; } }
    else if (e.kind === 'file-done') { N.status = ''; note(`File received: ${e.name}`); }
    else if (e.kind === 'file-failed') note(e.reason, true);
    else if (e.kind === 'closed') { N.state = 'idle'; N.status = 'Disconnected.'; refresh(); }
    else if (e.kind === 'error') note(e.message, true);
  } });
  A.peer.attach(channel); N.state = 'connected'; N.status = 'Connected. Syncing…';
  A.host.closeOverlay(); A.peer.start(); refresh();
}
async function hostFlow() {
  A.nearby.state = 'hosting';
  try {
    const sess = await createOffer(); const frames = await encodeFrames(toBytes(sess.payload), { compress: false });
    A.host.openOverlay('Start: show this code', (body) => {
      body.innerHTML = `<div class="term-wf" style="text-align:center"><div id="an-qr" class="an-qr"></div><div class="pp-muted" id="an-qrn"></div>
        <p class="pp-muted">1. The other phone taps <b>Join</b> and scans this. 2. It then shows a code; tap the button below and scan that.</p>
        <button class="pp-btn solid big" id="an-gotans">Scan their answer</button></div>`;
      const player = new QrPlayer($('#an-qr', body), frames); player.onTick = (i, n) => { const x = $('#an-qrn'); if (x) x.textContent = n > 1 ? `Frame ${i} of ${n}` : 'One code'; };
      player.start(); A.player = player;
      $('#an-gotans', body).onclick = () => { player.stop(); scanDialog({ title: 'Scan their answer', hint: 'Scan the code shown on the joining phone.', inline: true, onBytes: async (b) => { await acceptAnswer(sess, await fromBytes(b)); A.nearby.status = 'Connecting…'; A.host.closeOverlay(); refresh(); return false; } }); };
    }, null, null, true);
    sess.ready.then(startPeer).catch((e) => note(e.message, true));
  } catch (e) { note(e.message, true); }
}
async function joinFlow() {
  scanDialog({ title: 'Join: scan the other phone', hint: 'Scan the code shown after they tap Start.', inline: true, onBytes: async (b) => {
    try {
      const sess = await acceptOffer(await fromBytes(b)); const frames = await encodeFrames(toBytes(sess.payload), { compress: false });
      A.host.openOverlay('Show this code to the other phone', (body) => {
        body.innerHTML = `<div class="term-wf" style="text-align:center"><div id="an-qr" class="an-qr"></div><div class="pp-muted" id="an-qrn"></div><p class="pp-muted">Keep this on screen until the other phone has scanned it. The two phones connect by themselves.</p></div>`;
        const player = new QrPlayer($('#an-qr', body), frames); player.onTick = (i, n) => { const x = $('#an-qrn'); if (x) x.textContent = n > 1 ? `Frame ${i} of ${n}` : 'One code'; };
        player.start(); A.player = player;
      }, null, null, true);
      sess.ready.then(startPeer).catch((e) => note(e.message, true));
    } catch (e) { note(e.message, true); }
    return false;
  } });
}

// ───────────────────────── Radio ─────────────────────────
const PLAN_FIELDS = [['service', 'Service (FRS or GMRS)'], ['channel', 'Channel'], ['code', 'CTCSS / DCS code'], ['repeater', 'Repeater name'], ['offset', 'Repeater offset'], ['checkin', 'Check-in time']];
const R = () => (A.radio ||= { mode: 'none', heard: [], notes: [], answers: [], status: '', channelOk: false, keyShown: null });
function rnote(text, bad = false) { const r = R(); r.notes.push({ text, bad }); r.notes = r.notes.slice(-8); if (A.tab === 'radio') refresh(); }
function tabRadio(el) {
  const r = R(), plan = A.settings.radioPlan || {}, isOp = !!A.host.operator()?.is_genesis, br = r.bridge;
  const connected = r.mode !== 'none';
  el.innerHTML = `
    <div class="an-card"><h4>Radio (LoRa mesh)</h4>
      <p>Pairs by Bluetooth with a separate Meshtastic LoRa node and sends the short signed codes for records over the air, on a private channel. Over the air goes only a code, never names, amounts, health information or files.</p>
      <div class="an-kv"><span>Web Bluetooth</span><b>${webBluetoothAvailable() ? 'available' : 'not available in this browser'}</b></div>
      ${webBluetoothAvailable() ? '' : '<p class="ck-bad">Web Bluetooth does not work on iPhone or in Safari or Firefox. Use Chrome or Edge on Android or a computer. The practice node below works anywhere.</p>'}
      <div class="an-kv"><span>Node</span><b>${r.mode === 'node' ? esc(r.nodeName || 'paired') : r.mode === 'practice' ? 'practice node (no hardware)' : 'none'}</b></div>
      <div class="an-kv"><span>Private channel</span><b>${connected ? (r.channelOk ? '<span style="color:#2E9D6B">verified</span>' : '<span class="ck-bad">not verified, so nothing is sent</span>') : '—'}</b></div>
      <div class="ck-acts">${connected ? '<button class="pp-btn" id="an-rdis">Disconnect</button>' : `<button class="pp-btn solid" id="an-rpair" ${A.identity ? '' : 'disabled'}>Pair a node</button><button class="pp-btn" id="an-rprac" ${A.identity ? '' : 'disabled'}>Use the practice node</button>`}</div>
      ${A.identity ? '' : '<p class="pp-muted">Create your signing key first (Status tab).</p>'}
      <div class="pp-form-msg" id="an-rmsg">${esc(r.status)}</div>
      ${r.notes.map((n) => `<div class="an-row"><i class="an-dot ${n.bad ? 'bad' : 'on'}"></i><span>${esc(n.text)}</span></div>`).join('')}</div>
    ${r.mode === 'node' ? `<div class="an-card"><h4>Private channel</h4>
      <p>Your node must be on its own channel with its own key, never the public default. This <b>replaces the node's primary channel</b> and sets the US region (902–928 MHz), so the node leaves any public mesh it was on. Every Bixxville node needs the same name and key. <b>The key is not shown again, stored or put in a QR code.</b> Write it down or pass it on in person.</p>
      <label class="ck-fld"><span>Channel name</span><input id="an-cname" class="sch-in" maxlength="11" placeholder="bixx-field"></label>
      <label class="ck-fld"><span>Key (64 hex characters or base64 of 32 bytes)</span><input id="an-ckey" class="sch-in" autocomplete="off" spellcheck="false" type="password"></label>
      ${r.keyShown ? `<div class="an-row"><code style="word-break:break-all">${esc(r.keyShown)}</code><button class="term-card-btn" id="an-kcopy">Copy</button></div><p class="ck-bad">Write this down now. It is not saved anywhere.</p>` : '<button class="pp-btn" id="an-kgen">Make a new key</button>'}
      <div class="ck-acts"><button class="pp-btn solid" id="an-capply">Apply to the node</button><button class="pp-btn" id="an-ccheck">Check the node's channel</button></div></div>` : ''}
    ${connected ? `<div class="an-card"><h4>On the air</h4>
      <div class="ck-acts"><button class="pp-btn solid" id="an-rcheck" ${r.channelOk ? '' : 'disabled'}>Comms check</button>${r.mode === 'practice' ? '<button class="pp-btn" id="an-rnoise">Send test noise</button>' : ''}</div>
      <p class="pp-muted">A comms check sends a signed acknowledgement; every other node that hears it answers once, and the answers show up here. Sends are paced (one every 15 seconds, 20 in 10 minutes). Sent ${br?.stats.sent ?? 0} · queued ${br?.queue.length ?? 0} · heard ${br?.stats.heard ?? 0} · dropped ${br?.stats.rejected ?? 0}.</p>
      ${r.answers.length ? `<div class="form-block"><div class="form-lbl">Answered the last check</div>${r.answers.map((a) => `<div class="an-row"><i class="an-dot on"></i><b>${esc(a.name)}</b><span>${esc(a.at.replace('T', ' '))}</span></div>`).join('')}</div>` : ''}
      <div class="form-block"><div class="form-lbl">Heard on the radio (checked and signed)</div>
      ${(br?.heard || []).slice(0, 12).map((h) => `<div class="an-row"><i class="an-dot ${h.mine ? '' : 'on'}"></i><b>${esc(h.type === 'stamp' ? h.class + ' stamp' : h.type.replace('_', ' '))}</b><span>${h.mine ? 'you' : esc(nameOf(h.author))} · ${esc(h.ts.replace('T', ' '))}${A.log.has(h.id) ? ' · full record held' : ' · code only'}</span></div>`).join('') || '<div class="pp-muted">Nothing yet.</div>'}</div></div>` : ''}
    <div class="an-card"><h4>Radio plan</h4><p class="pp-muted">Written down so everyone knows where to be. It is plain notes: the app does not tune or control any radio. ${isOp ? '' : 'Only the Operator edits it.'}</p>
    ${PLAN_FIELDS.map(([k, l]) => `<label class="ck-fld"><span>${l}</span><input class="sch-in" data-plan="${k}" value="${esc(plan[k] || '')}" maxlength="60" ${isOp ? '' : 'disabled'}></label>`).join('')}
    ${isOp ? '<button class="pp-btn solid" id="an-plan-save">Save plan</button>' : ''}</div>`;
  $('#an-plan-save', el)?.addEventListener('click', async () => {
    A.settings.radioPlan = Object.fromEntries(PLAN_FIELDS.map(([k]) => [k, $(`[data-plan="${k}"]`, el).value.trim()]));
    await saveSettings(); A.host.toast('Radio plan saved on this device.');
  });
  $('#an-rprac', el)?.addEventListener('click', startPractice);
  $('#an-rpair', el)?.addEventListener('click', pairNode);
  $('#an-rdis', el)?.addEventListener('click', disconnectRadio);
  $('#an-kgen', el)?.addEventListener('click', () => { r.keyShown = b64u(generatePsk()); refresh(); $('#an-ckey').value = r.keyShown; });
  $('#an-kcopy', el)?.addEventListener('click', () => navigator.clipboard?.writeText(r.keyShown).then(() => A.host.toast('Copied. Paste it somewhere safe, offline.')));
  $('#an-capply', el)?.addEventListener('click', applyChannel);
  $('#an-ccheck', el)?.addEventListener('click', checkChannel);
  $('#an-rcheck', el)?.addEventListener('click', async () => { const x = await r.bridge.commsCheck(); r.answers = []; rnote(x.ok ? 'Comms check queued.' : 'Not sent: ' + x.reason, !x.ok); });
  $('#an-rnoise', el)?.addEventListener('click', sendNoise);
}
function newBridge(link, channelOk) {
  const r = R();
  r.bridge = new RadioBridge({ log: A.log, keyring: A.keyring, identity: A.identity, link, limiter: new RateLimiter(), autoAnswer: true, onEvent: (e) => {
    if (e.kind === 'heard') { rnote(`Heard ${e.entry.type === 'stamp' ? e.entry.class + ' stamp' : e.entry.type}${e.entry.mine ? ' (echo of yours)' : ' from ' + nameOf(e.entry.author)}.`); refreshCountsSoon(); }
    else if (e.kind === 'rejected') rnote('Dropped a message: ' + e.reason, true);
    else if (e.kind === 'blocked' || e.kind === 'dropped' || e.kind === 'error') rnote(e.reason || e.message, true);
    else if (e.kind === 'waiting') { R().status = `Next send in ${Math.ceil(e.waitMs / 1000)} s (${e.left} waiting).`; if (A.tab === 'radio') { const m = $('#an-rmsg'); if (m) m.textContent = R().status; } }
    else if (e.kind === 'answer') { R().answers.push({ name: e.name, at: e.at }); if (A.tab === 'radio') refresh(); }
  } });
  r.bridge.setChannelOk(channelOk); r.channelOk = channelOk;
}
function startPractice() {
  const r = R(); r.mode = 'practice'; r.link = new PracticeLink(); newBridge(r.link, true); r.status = 'Practice node: whatever you send is heard again a moment later, as if another node repeated it.'; refresh();
}
async function pairNode() {
  const r = R(); r.status = 'Loading the radio library…'; refresh();
  try {
    const lib = await loadMeshLibrary();
    r.status = 'Choose your node in the Bluetooth list…'; refresh();
    const node = await connectNode(lib, { onStatus: () => {} });
    Object.assign(r, node, { mode: 'node', nodeName: 'Meshtastic node' }); newBridge(node.link, false);
    r.status = 'Paired. Set up or check the private channel below.'; await checkChannel(true);
  } catch (e) { r.status = e.name === 'NotFoundError' ? 'No node was chosen.' : e.message; r.mode = 'none'; refresh(); }
}
async function disconnectRadio() { const r = R(); try { await r.link?.close?.(); } catch (e) { /* already gone */ } r.bridge?.close(); Object.assign(r, { mode: 'none', bridge: null, link: null, device: null, channelOk: false, keyShown: null, status: 'Disconnected.' }); refresh(); }
function parseKey(text) {
  const t = text.trim();
  if (/^[0-9a-fA-F]{64}$/.test(t)) return unhex(t);
  try { const b = unb64u(t.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')); if (b.length === 32) return b; } catch (e) { /* fall through */ }
  throw new Error('The key must be 64 hex characters or base64 of exactly 32 bytes.');
}
async function applyChannel() {
  const r = R(), name = $('#an-cname').value.trim();
  try {
    const psk = parseKey($('#an-ckey').value);
    const ok = isPrivateChannel({ name, psk }); if (!ok.ok) throw new Error(ok.reason);
    if (!confirm(`Replace this node's primary channel with "${name}" and set the US region? It will leave any public mesh it was on.`)) return;
    r.status = 'Writing the channel to the node…'; refresh();
    await applyPrivateChannel({ lib: r.lib, device: r.device }, { name, psk });
    $('#an-ckey') && ($('#an-ckey').value = ''); r.keyShown = null;
    await new Promise((res) => setTimeout(res, 800)); await checkChannel(true);
  } catch (e) { r.status = e.message; refresh(); }
}
async function checkChannel(quiet) {
  const r = R(); if (r.mode !== 'node') return;
  try { r.channels.delete(0); r.device.configure().catch(() => {}); } catch (e) { /* the node re-reports its channels */ }
  const t0 = Date.now(); while (!r.channels.has(0) && Date.now() - t0 < 6000) await new Promise((res) => setTimeout(res, 150));
  const v = verifyNodeChannel(r.channels);
  r.channelOk = v.ok; r.bridge?.setChannelOk(v.ok);
  r.status = v.ok ? 'The node is on a private channel. Radio is ready.' : v.reason;
  if (!quiet || true) refresh();
}
async function sendNoise() {
  const r = R(), l = r.link; if (!l) return;
  const rec = await createRecord(A.identity, { type: 'update', ref: 'NOISE', payload: { text: 'test' }, prev: null });
  const good = await compactEncode(rec);
  const flipped = good.slice(); flipped[60] ^= 1;
  l.inject(flipped); l.inject(new Uint8Array(40)); l.inject(good.subarray(0, 100)); l.inject(enc.encode('hello from a different radio app'));
  rnote('Injected four bad messages: a changed signature, junk, a short one and plain text. All should be dropped.');
}
async function radioSend(id) {
  const r = R(); if (!r.bridge) { A.host.toast('Connect a node (or the practice node) in the Radio tab first.'); return; }
  const x = await r.bridge.send(A.log.get(id)); A.host.toast(x.ok ? 'Queued to send by radio (a code only, no text).' : 'Not sent: ' + x.reason);
}

// ───────────────────────── Log ─────────────────────────
function tabLog(el) {
  const rows = A.log.view().reverse();
  el.innerHTML = `<div class="ck-acts"><button class="pp-btn solid" id="an-new" ${A.identity ? '' : 'disabled'}>New record</button></div>
    ${A.identity ? '' : '<p class="pp-muted">Create your signing key first (Status tab).</p>'}
    ${rows.map(({ rec: r, badge, notes, state }) => `<div class="an-rec" data-id="${esc(r.id)}">
      <div class="an-rec-h"><span class="an-badge ${badge}">${badge === 'verified' ? '✓ verified' : badge}</span><b>${esc(r.type === 'stamp' ? r.class + ' stamp' : r.type.replace('_', ' '))}</b><code>${esc(r.ref)}</code><span class="ck-pill s-${state === 'Local' ? 'issued' : 'measured'}">${esc(state)}</span></div>
      <div class="pp-muted">${esc(nameOf(r.author))} · ${esc(r.ts.replace('T', ' '))}</div>
      ${r.type === 'update' ? `<div>${esc(r.payload.text)}</div>` : r.type === 'file_manifest' ? `<div>${esc(r.payload.name)} · ${(r.payload.size / 1024).toFixed(1)} KB</div>` : r.payload.note ? `<div>${esc(r.payload.note)}</div>` : ''}
      ${notes.map((n) => `<div class="ck-bad" style="font-size:12px">${esc(n)}</div>`).join('')}
      <div class="ck-acts"><button class="term-card-btn" data-qr="${esc(r.id)}">QR</button><button class="term-card-btn" data-share="${esc(r.id)}">Share</button>
        ${r.type === 'stamp' || r.type === 'update' || r.type === 'ack' ? `<button class="term-card-btn" data-compact="${esc(r.id)}">Radio code</button>` : ''}</div></div>`).join('') || '<div class="term-panel-empty">No records yet.</div>'}`;
  $('#an-new', el)?.addEventListener('click', newRecord);
  el.querySelectorAll('[data-qr]').forEach((b) => { b.onclick = async () => { const text = await exportBundle(A.log, A.identity, { ids: [b.dataset.qr] }); showFrames('Record as QR', enc.encode(text), 'The other device scans this with Send / Receive → Scan QR.'); }; });
  el.querySelectorAll('[data-share]').forEach((b) => { b.onclick = () => shareBundle([b.dataset.share]); });
  el.querySelectorAll('[data-compact]').forEach((b) => { b.onclick = () => radioSend(b.dataset.compact); });
}
function newRecord() {
  const refs = [...new Set(((typeof window !== 'undefined' && window.trackerState?.branches) || []).map((b) => b.code))];
  A.host.openOverlay('New record', (body) => {
    body.innerHTML = `<div class="term-wf"><form class="pp-form flat" id="an-form">
      <label class="ck-fld"><span>Type</span><select id="an-t" class="sch-in">${TYPES.map((t) => `<option value="${t}">${t.replace('_', ' ')}</option>`).join('')}</select></label>
      <label class="ck-fld" id="an-cl-w"><span>Stamp</span><select id="an-cl" class="sch-in">${STAMP_CLASSES.map((c) => `<option>${c}</option>`).join('')}</select></label>
      <label class="ck-fld"><span>Checkpoint or item</span><input id="an-ref" class="sch-in" list="an-refs" placeholder="CP3 or BIX_00271" maxlength="64"><datalist id="an-refs">${refs.map((r) => `<option value="${esc(r)}">`).join('')}</datalist></label>
      <div id="an-fields"></div><div class="pp-form-msg" id="an-fmsg"></div><button class="pp-btn solid big" type="submit">Sign and add</button></form></div>`;
    const fields = () => {
      const t = $('#an-t', body).value; $('#an-cl-w', body).style.display = t === 'stamp' ? '' : 'none';
      $('#an-fields', body).innerHTML = t === 'stamp' ? '<label class="ck-fld"><span>Note (optional)</span><input id="an-note" class="sch-in" maxlength="140"></label>'
        : t === 'update' ? '<label class="ck-fld"><span>Message</span><textarea id="an-text" class="sch-in" rows="3" maxlength="280"></textarea></label>'
        : t === 'ack' ? `<label class="ck-fld"><span>Acknowledge which record</span><select id="an-of" class="sch-in">${A.log.snapshot().slice(-40).reverse().map((r) => `<option value="${esc(r.id)}">${esc(r.type)} ${esc(r.ref)} · ${esc(r.id.slice(0, 8))}</option>`).join('')}</select></label>`
        : '<label class="ck-fld"><span>File (up to 50 MB)</span><input id="an-file" type="file" class="sch-in"></label>';
    };
    $('#an-t', body).onchange = fields; fields();
    $('#an-form', body).onsubmit = async (e) => {
      e.preventDefault(); const msg = $('#an-fmsg', body), t = $('#an-t', body).value, ref = $('#an-ref', body).value.trim();
      try {
        msg.textContent = 'Signing…';
        if (t === 'file_manifest') {
          const f = $('#an-file', body).files[0]; if (!f) throw new Error('Pick a file.'); if (f.size > 50 * 1024 * 1024) throw new Error('Files are limited to 50 MB.');
          await publishFile({ log: A.log, identity: A.identity, files: A.files, ref }, { name: f.name, mime: f.type, bytes: new Uint8Array(await f.arrayBuffer()) });
        } else {
          const payload = t === 'stamp' ? ($('#an-note', body).value ? { note: $('#an-note', body).value } : {}) : t === 'update' ? { text: $('#an-text', body).value } : { of: $('#an-of', body).value };
          await A.log.append(A.identity, { type: t, class: t === 'stamp' ? $('#an-cl', body).value : null, ref, payload });
        }
        A.host.closeOverlay(); A.host.toast('Record signed and saved.'); refresh();
      } catch (err) { msg.textContent = err.message; }
    };
  });
}

// For tests and for other panels: the live state.
export const _state = A;
