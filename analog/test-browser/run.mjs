// Browser test: two real Chrome instances run the Analog panel from the repo.
//   * the camera path: a fake camera plays QR frames and the panel reads them
//   * the phone-to-phone path: WebRTC between the two instances, offer/answer passed as pasted QR frames
//   * offline: the second instance has its network switched off for the QR import
// Run: npm run test:browser   (needs Google Chrome; no internet is needed once the libraries are saved)
import { spawn } from 'node:child_process';
import { writeFileSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import WebSocket from 'ws';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
let pass = 0, fail = 0;
const ok = (c, m) => { c ? pass++ : fail++; console.log(c ? '  ✓' : '  ✗ FAIL:', m); };
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

async function launch(port, extra = []) {
  rmSync(`/tmp/_analog_${port}`, { recursive: true, force: true });   // a fresh browser profile every run
  const proc = spawn(CHROME, ['--headless=new', `--remote-debugging-port=${port}`, `--user-data-dir=/tmp/_analog_${port}`, '--no-first-run', '--window-size=480,1000',
    '--disable-features=WebRtcHideLocalIpsWithMdns', ...extra, 'about:blank'], { stdio: 'ignore' });
  await wait(2500);
  const tabs = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
  const ws = new WebSocket(tabs.find((t) => t.type === 'page').webSocketDebuggerUrl); await new Promise((r) => ws.on('open', r));
  let n = 0; const pend = new Map(), errs = [];
  ws.on('message', (m) => { const d = JSON.parse(m); if (d.id && pend.has(d.id)) { pend.get(d.id)(d); pend.delete(d.id); }
    if (d.method === 'Runtime.exceptionThrown') errs.push(d.params.exceptionDetails.exception?.description || d.params.exceptionDetails.text); });
  const send = (method, params = {}) => new Promise((r) => { const id = ++n; pend.set(id, r); ws.send(JSON.stringify({ id, method, params })); });
  const ev = async (e) => { const r = await send('Runtime.evaluate', { expression: e, awaitPromise: true, returnByValue: true }); if (r.result.exceptionDetails) throw new Error(r.result.exceptionDetails.exception?.description || r.result.exceptionDetails.text); return r.result.result.value; };
  await send('Runtime.enable'); await send('Page.enable'); await send('Network.enable');
  return { proc, send, ev, errs, kill: () => proc.kill() };
}
const until = async (b, expr, ms = 20000) => { const t = Date.now(); while (Date.now() - t < ms) { try { if (await b.ev(expr)) return true; } catch (e) { /* page still loading */ } await wait(300); } return false; };

// opens the Analog panel on a page, with a stand-in signed-in member (the panel only needs a name and a role)
const open = async (b, name, isOp = false) => {
  await b.send('Page.navigate', { url: 'http://localhost:8099/terminal.html' });
  await until(b, `typeof setTermView === 'function' && !!document.getElementById('term-panel')`, 20000);
  await b.ev(`(operator = { id: 'x', peer_name: '${name}', is_genesis: ${isOp} }, document.getElementById('terminal-shell').classList.add('in'), setTermView('analog'), true)`);
  await until(b, `!!document.querySelector('.an-wrap')`);
};
const mod = (b) => b.ev(`import('/analog/src/ui.js').then(m => { window.AN = m._state; return true; })`);
const text = (b, sel) => b.ev(`document.querySelector(${JSON.stringify(sel)})?.textContent || ''`);

let server, A, B;
try {
  server = spawn('python3', ['-m', 'http.server', '8099', '--bind', '127.0.0.1'], { cwd: ROOT, stdio: 'ignore' });
  await wait(800);

  console.log('A: key, records, bundle');
  A = await launch(9341);
  await open(A, 'Alice', true); await mod(A);
  ok(await A.ev(`document.body.textContent.toLowerCase().includes('create your signing key')`), 'asks for a signing key first');
  await A.ev(`(document.getElementById('an-pass').value = 'short', document.getElementById('an-make').click(), true)`); await wait(500);
  ok((await text(A, '#an-kmsg')).includes('at least 8'), 'a short backup passphrase is refused');
  await A.ev(`(document.getElementById('an-pass').value = 'a long passphrase', document.getElementById('an-make').click(), true)`);
  ok(await until(A, `!!AN.identity`), 'key created');
  ok(await A.ev(`AN.settings.backupAt > 0 && !!AN.identity.signKey && AN.identity.signKey.extractable === false`), 'backup made and the live key is not extractable');
  await A.ev(`(async () => { for (let i = 0; i < 12; i++) await AN.log.append(AN.identity, { type: i % 3 ? 'update' : 'stamp', class: i % 3 ? null : 'Delivered', ref: 'CP' + (i % 4), payload: i % 3 ? { text: 'field note number ' + i + ' ' + 'x'.repeat(60) } : {} }); return true; })()`);
  ok(await A.ev(`AN.log.size === 12 && AN.log.view().every(v => v.badge === 'verified' || v.badge === 'gap')`), '12 signed records');
  await A.ev(`(document.querySelector('[data-tab=log]').click(), true)`);
  ok((await A.ev(`document.querySelectorAll('.an-rec').length`)) === 12, 'the log lists each record with a verify badge');
  ok((await A.ev(`document.querySelectorAll('.an-badge').length`)) === 12, 'every record shows a badge');

  console.log('QR images decode back to the exact frames');
  const framesB64 = await A.ev(`(async () => {
    const { exportBundle } = await import('/analog/src/bundle.js'); const { encodeFrames } = await import('/analog/src/frames.js'); const qr = await import('/analog/src/qr.js');
    await qr.loadQr(); await qr.loadScan();
    const card = JSON.stringify((await import('/analog/src/keys.js')).keyCard(AN.identity, 'Alice'));
    const bundle = await exportBundle(AN.log, AN.identity);
    const kf = await encodeFrames(new TextEncoder().encode(card)), bf = await encodeFrames(new TextEncoder().encode(bundle));
    window.__bundleText = bundle;
    const lumas = [], decoded = [];
    for (const f of [...kf, ...bf]) {
      const img = new Image(); img.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(qr.qrSvg(f, 420)); await img.decode();
      const c = document.createElement('canvas'); c.width = 640; c.height = 480; const x = c.getContext('2d', { willReadFrequently: true });
      x.fillStyle = '#888'; x.fillRect(0, 0, 640, 480); x.drawImage(img, 110, 30, 420, 420);
      const d = x.getImageData(0, 0, 640, 480).data; const y = new Uint8Array(640 * 480);
      for (let i = 0; i < y.length; i++) y[i] = (d[i * 4] * 299 + d[i * 4 + 1] * 587 + d[i * 4 + 2] * 114) / 1000;
      lumas.push(btoa(String.fromCharCode(...y.subarray(0, 0x8000))) && Array.from(y));
      const q = jsQR(d, 640, 480); decoded.push(q && q.data);
    }
    return { n: kf.length + bf.length, kf: kf.length, bf: bf.length, same: decoded.every((t, i) => t === [...kf, ...bf][i]), size: bundle.length, lumas };
  })()`);
  ok(framesB64.same, `all ${framesB64.n} QR frames decode to exactly what was encoded (${framesB64.kf} for the key card, ${framesB64.bf} for ${framesB64.size} bytes of records)`);
  // y4m for the fake camera: key card frames, then bundle frames, looping
  const W = 640, H = 480; const chunks = [Buffer.from(`YUV4MPEG2 W${W} H${H} F4:1 Ip A1:1 C420jpeg\n`)];
  for (const y of framesB64.lumas) { chunks.push(Buffer.from('FRAME\n'), Buffer.from(Uint8Array.from(y)), Buffer.alloc(W * H / 2, 128)); }
  writeFileSync('/tmp/_analog_qr.y4m', Buffer.concat(chunks));

  console.log('B: a second phone with a camera, offline');
  B = await launch(9342, ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', '--use-file-for-fake-video-capture=/tmp/_analog_qr.y4m']);
  await open(B, 'Bob'); await mod(B);
  await B.ev(`(document.getElementById('an-pass').value = 'another long passphrase', document.getElementById('an-make').click(), true)`);
  ok(await until(B, `!!AN.identity`), 'B has a key');
  await wait(3000);   // let the service worker save the libraries
  await B.send('Network.emulateNetworkConditions', { offline: true, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });
  ok(await B.ev(`navigator.onLine === false`), 'B is offline');
  await B.ev(`(document.getElementById('an-scancard').click(), true)`);
  ok(await until(B, `!!document.querySelector('.ck-cam') && !!document.getElementById('an-sst')`), 'scan dialog opens');
  const read = await until(B, `document.body.textContent.includes('Trust this key?')`, 30000);
  if (!read) console.log('   scan status:', await text(B, '#an-sst'), '| jsQR:', await B.ev(`typeof window.jsQR`), '| camera:', await B.ev(`navigator.mediaDevices.getUserMedia({video:true}).then(s => s.getVideoTracks()[0].label, e => e.name)`));
  ok(read, 'the camera read Alice\'s key card');
  ok((await B.ev(`document.body.textContent`)).includes(await A.ev(`AN.identity.fp`)), 'it shows her full fingerprint to compare');
  await B.ev(`(document.getElementById('an-tn').value = 'Alice', document.getElementById('an-tr').value = 'payee', document.getElementById('an-tok').click(), true)`);
  ok(await until(B, `AN.keyring.has('${await A.ev(`AN.identity.fp`)}')`), 'B now trusts Alice\'s key');
  // receive the records through the camera
  await B.ev(`(document.querySelector('[data-tab=send]').click(), true)`);
  await B.ev(`(document.getElementById('an-r-scan').click(), true)`);
  ok(await until(B, `AN.log.size === 12`, 45000), 'the camera read the animated QR and imported all 12 records, offline');
  ok(await B.ev(`AN.log.view().every(v => v.badge === 'verified' || v.badge === 'gap') && AN.log.counts().Relayed === 12`), 'all verified, all marked Relayed');
  ok(await until(B, `!document.querySelector('.ck-cam')`, 5000), 'the scan dialog closed itself when done');

  console.log('Phone to phone on the local network (offer and answer passed as QR frames)');
  await B.send('Network.emulateNetworkConditions', { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });
  await A.ev(`(async () => { AN.nearby = null; await AN.log.append(AN.identity, { type: 'update', ref: 'CP9', payload: { text: 'only on A' } }); return true; })()`);
  await B.ev(`(async () => { await AN.log.append(AN.identity, { type: 'update', ref: 'CP9', payload: { text: 'only on B' } }); return true; })()`);
  // A trusts B so records from B are accepted (key cards in person)
  await A.ev(`(async () => { const { keyCard } = await import('/analog/src/keys.js'); return true; })()`);
  const bCard = await B.ev(`import('/analog/src/keys.js').then(k => JSON.stringify(k.keyCard(AN.identity, 'Bob')))`);
  await A.ev(`AN.keyring.add(${JSON.stringify(JSON.parse(bCard))}).then(() => true)`);
  await A.ev(`(document.querySelector('[data-tab=nearby]').click(), true)`);
  await B.ev(`(document.querySelector('[data-tab=nearby]').click(), true)`);
  await A.ev(`(document.getElementById('an-host').click(), true)`);
  ok(await until(A, `!!AN.player && AN.player.frames.length > 0`, 15000), 'A shows a connection code');
  const offerFrames = await A.ev(`AN.player.frames`);
  await B.ev(`(document.getElementById('an-join').click(), true)`);
  await until(B, `!!document.getElementById('an-paste')`);
  await B.ev(`(document.getElementById('an-paste').value = ${JSON.stringify(offerFrames.join('\n'))}, document.getElementById('an-pgo').click(), true)`);
  ok(await until(B, `!!AN.player && AN.player.frames.length > 0 && AN.player.frames[0] !== ${JSON.stringify(offerFrames[0])}`, 20000), 'B answers with its own code');
  const answerFrames = await B.ev(`AN.player.frames`);
  await A.ev(`(document.getElementById('an-gotans').click(), true)`);
  await until(A, `!!document.getElementById('an-paste')`);
  await A.ev(`(document.getElementById('an-paste').value = ${JSON.stringify(answerFrames.join('\n'))}, document.getElementById('an-pgo').click(), true)`);
  ok(await until(A, `AN.nearby.state === 'connected'`, 25000), 'A connected over WebRTC with no signalling server');
  ok(await until(B, `AN.nearby.state === 'connected'`, 25000), 'B connected');
  ok(await until(A, `AN.log.size === 14 && AN.nearby.log.some(l => l.text.includes('up to date'))`, 20000), 'A received B\'s record and both logs are up to date');
  ok(await until(B, `AN.log.size === 14`, 20000), 'B received A\'s record');
  ok((await A.ev(`JSON.stringify(AN.log.snapshot().map(r => r.id))`)) === (await B.ev(`JSON.stringify(AN.log.snapshot().map(r => r.id))`)), 'both devices hold exactly the same records');
  ok(await A.ev(`AN.settings.lastSync > 0`), 'last sync time recorded');

  console.log('A file over the same link');
  await A.ev(`(async () => { const { publishFile } = await import('/analog/src/sync.js'); const bytes = new Uint8Array(70000).map((_, i) => (i * 7) & 255); const m = await publishFile({ log: AN.log, identity: AN.identity, files: AN.files, ref: 'CP2' }, { name: 'soil.csv', mime: 'text/csv', bytes }); window.__sha = m.payload.sha256; return true; })()`);
  await A.ev(`AN.peer.start().then(() => true)`);
  ok(await until(B, `AN.log.snapshot().some(r => r.type === 'file_manifest')`, 15000), 'B got the signed manifest');
  const sha = await A.ev(`window.__sha`);
  await B.ev(`AN.peer.requestFile('${sha}').then(() => true)`);
  ok(await until(B, `AN.files.get('${sha}').then(f => !!(f && f.bytes && f.bytes.length === 70000))`, 20000), 'B received all 70,000 bytes, hash checked');


  console.log('Radio tab with the practice node (no hardware)');
  await A.ev(`(document.querySelector('[data-tab=radio]').click(), true)`);
  ok((await text(A, '.an-wrap')).includes('Radio plan') && (await text(A, '.an-wrap')).includes('Private channel'), 'radio tab shows the channel state and the plan card');
  await A.ev(`(document.getElementById('an-rprac').click(), true)`);
  ok(await until(A, `AN.radio.mode === 'practice' && AN.radio.channelOk`), 'practice node connected');
  await A.ev(`(document.querySelector('[data-tab=log]').click(), true)`);
  await A.ev(`(document.querySelector('[data-compact]').click(), true)`);
  ok(await until(A, `AN.radio.bridge.stats.sent === 1`), 'a record was sent by radio');
  ok(await until(A, `AN.radio.bridge.heard.length === 1 && AN.log.has(AN.radio.bridge.heard[0].id)`), 'its echo was heard, verified, and matched to the full record we hold');
  ok(await A.ev(`AN.radio.link.sentBytes.every(b => b.length === 101)`), 'only the 101-byte compact form went out');
  await A.ev(`(document.querySelector('[data-tab=radio]').click(), true)`);
  await A.ev(`(document.getElementById('an-rnoise').click(), true)`);
  ok(await until(A, `AN.radio.bridge.stats.rejected === 4`), 'four bad messages were dropped');
  ok(await A.ev(`AN.radio.bridge.heard.length === 1`), 'and none of them reached the heard list');
  await A.ev(`(document.getElementById('an-rcheck').click(), true)`);
  ok(await until(A, `AN.radio.bridge.checks.length === 1`), 'a comms check was made');

  console.log('Errors:', [...A.errs, ...B.errs].slice(0, 4).join(' | ') || 'none');
  ok(![...A.errs, ...B.errs].some((e) => !/ResizeObserver/.test(e)), 'no uncaught exceptions');
} catch (e) { fail++; console.log('✗ CRASH', e.stack || e.message); }
finally { try { A?.kill(); B?.kill(); server?.kill(); } catch {} console.log(`\n${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0); }
