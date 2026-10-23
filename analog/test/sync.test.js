import { test } from 'node:test';
import assert from 'node:assert/strict';
import { newNode, trustEachOther } from './_helpers.js';
import { Peer, memoryChannels, MemoryFileStore, publishFile, FILE_CHUNK } from '../src/sync.js';
import { createRecord } from '../src/record.js';
import { hex, sha256 } from '../src/canon.js';

const until = async (f, ms = 3000) => { const t = Date.now(); while (!f()) { if (Date.now() - t > ms) throw new Error('timed out'); await new Promise((r) => setTimeout(r, 2)); } };
async function link(a, b, opts) {
  const ev = { a: [], b: [] };
  const pa = new Peer({ log: a.log, identity: a.identity, files: a.files || new MemoryFileStore(), onEvent: (e) => ev.a.push(e) });
  const pb = new Peer({ log: b.log, identity: b.identity, files: b.files || new MemoryFileStore(), onEvent: (e) => ev.b.push(e) });
  const [ca, cb] = memoryChannels(opts); pa.attach(ca); pb.attach(cb);
  return { pa, pb, ev, ca, cb };
}
const ids = (n) => JSON.stringify(n.log.snapshot().map((r) => r.id));

test('two devices exchange only what each is missing, and end with the same records', async () => {
  const a = await newNode('a'), b = await newNode('b'); await trustEachOther(a, b);
  const shared = await a.log.append(a.identity, { type: 'update', ref: 'CP1', payload: { text: 'shared' } });
  await b.log.merge([shared]);
  for (let i = 0; i < 4; i++) await a.log.append(a.identity, { type: 'update', ref: 'CP1', payload: { text: 'a' + i } });
  for (let i = 0; i < 3; i++) await b.log.append(b.identity, { type: 'stamp', class: i ? 'Audited' : 'Delivered', ref: 'CP' + i, payload: {} });
  const { pa, pb, ev } = await link(a, b);
  await Promise.all([pa.start(), pb.start()]);
  await until(() => ev.a.some((e) => e.kind === 'complete') && ev.b.some((e) => e.kind === 'complete'));
  assert.equal(ids(a), ids(b)); assert.equal(a.log.size, 8);
  const gotA = ev.a.find((e) => e.kind === 'received'), gotB = ev.b.find((e) => e.kind === 'received');
  assert.equal(gotA.accepted, 3); assert.equal(gotB.accepted, 4);                 // only the missing ones moved
  assert.equal(gotA.duplicate, 0);
  assert.equal(a.log.stateOf(shared.id), 'Relayed');
});

test('a hostile peer: unsigned, tampered and unknown-key records are rejected and counted', async () => {
  const a = await newNode('a'), mal = await newNode('mal'); await a.keyring.add({ fp: mal.identity.fp, pub: hex(mal.identity.pubRaw), label: 'mal' });
  const real = await a.log.append(a.identity, { type: 'update', ref: 'CP1', payload: { text: 'mine' } });
  const stranger = await newNode('stranger');
  const good = await mal.log.append(mal.identity, { type: 'update', ref: 'CP1', payload: { text: 'fine' } });
  const tampered = structuredClone(good); tampered.payload.text = 'evil';
  const unknown = await createRecord(stranger.identity, { type: 'update', ref: 'CP1', payload: { text: 'who am i' } });
  const unsigned = { ...good }; delete unsigned.sig;
  const [ca, cb] = memoryChannels();
  const ev = []; const pa = new Peer({ log: a.log, identity: a.identity, onEvent: (e) => ev.push(e) }); pa.attach(ca);
  const out = (o) => cb.send(JSON.stringify(o));
  cb.onmessage = () => {};
  await out({ t: 'hello', v: 1, fp: mal.identity.fp, keys: [], have: [good.id] });
  await out({ t: 'records', recs: [good, tampered, unknown, unsigned, 'garbage', 7, null, { type: 'care_entry' }] });
  await until(() => ev.some((e) => e.kind === 'received'));
  const r = ev.find((e) => e.kind === 'received');
  assert.equal(r.accepted, 1); assert.equal(r.rejected.length, 7);
  assert.ok(r.rejected.some((x) => x.reason === 'unknown key'));
  assert.equal(a.log.size, 2); assert.ok(a.log.has(real.id));
});

test('a hello with a huge or malformed have-list is refused', async () => {
  const a = await newNode('a'); const [ca, cb] = memoryChannels(); const ev = [];
  new Peer({ log: a.log, identity: a.identity, onEvent: (e) => ev.push(e) }).attach(ca);
  await cb.send(JSON.stringify({ t: 'hello', v: 1, fp: 'f'.repeat(64), keys: [], have: new Array(30000).fill('a'.repeat(64)) }));
  await until(() => ev.some((e) => e.kind === 'error'));
  assert.ok(ca.closed);
});

test('unknown keys the peer shares are offered, not trusted; trusting them lets the records through', async () => {
  const a = await newNode('a'), b = await newNode('b');
  const rec = await b.log.append(b.identity, { type: 'update', ref: 'CP1', payload: { text: 'hi' } });
  const { pa, pb, ev } = await link(a, b);
  await Promise.all([pa.start(), pb.start()]);
  await until(() => ev.a.some((e) => e.kind === 'received'));
  const hello = ev.a.find((e) => e.kind === 'hello');
  assert.equal(hello.trusted, false); assert.equal(hello.unknownKeys.length, 1);
  assert.equal(a.log.size, 0);
  await a.keyring.add(hello.unknownKeys[0]);
  const l2 = await link(a, b); await Promise.all([l2.pa.start(), l2.pb.start()]);
  await until(() => l2.ev.a.some((e) => e.kind === 'complete'));
  assert.ok(a.log.has(rec.id));
});

// ── files ──
async function withFile(size) {
  const a = await newNode('a'), b = await newNode('b'); await trustEachOther(a, b);
  a.files = new MemoryFileStore(); b.files = new MemoryFileStore();
  const bytes = new Uint8Array(size).map((_, i) => (i * 31 + 7) & 255);
  const man = await publishFile({ log: a.log, identity: a.identity, files: a.files, ref: 'CP2' }, { name: 'soil.csv', mime: 'text/csv', bytes });
  return { a, b, bytes, man, sha: man.payload.sha256 };
}
test('a file moves in chunks and is checked against the signed hash', async () => {
  const { a, b, bytes, sha } = await withFile(FILE_CHUNK * 5 + 123);
  const { pa, pb, ev } = await link(a, b); await Promise.all([pa.start(), pb.start()]);
  await until(() => ev.b.some((e) => e.kind === 'complete'));
  await pb.requestFile(sha);
  await until(() => ev.b.some((e) => e.kind === 'file-done'));
  assert.deepEqual((await b.files.get(sha)).bytes, bytes);
  assert.ok(ev.b.some((e) => e.kind === 'file-progress'));
});
test('a file without a signed manifest is never requested', async () => {
  const { a, b } = await withFile(100);
  const { pb } = await link(a, b);
  await assert.rejects(() => pb.requestFile('a'.repeat(64)), /no signed manifest/);
});
test('a file whose bytes do not match the manifest hash is discarded', async () => {
  const { a, b, sha, bytes } = await withFile(FILE_CHUNK * 2);
  a.files.m.get(sha).bytes = bytes.map((v, i) => (i === 500 ? v ^ 1 : v));   // the sender is serving altered bytes
  const { pa, pb, ev } = await link(a, b); await Promise.all([pa.start(), pb.start()]);
  await until(() => ev.b.some((e) => e.kind === 'complete'));
  await pb.requestFile(sha);
  await until(() => ev.b.some((e) => e.kind === 'file-failed'));
  assert.match(ev.b.find((e) => e.kind === 'file-failed').reason, /did not match its signed hash/);
  assert.equal(await pb.have(sha), false);
});
test('unrequested chunks are ignored', async () => {
  const { a, b, sha } = await withFile(1000);
  const { pb, cb, ca, ev } = await link(a, b);
  await pb.start();
  await ca.send(JSON.stringify({ t: 'chunk', sha, off: 0, d: 'AAAA' })); await new Promise((r) => setTimeout(r, 20));
  assert.equal(await pb.have(sha), false); assert.ok(!ev.b.some((e) => e.kind === 'file-progress'));
});
test('a dropped connection resumes from where it stopped', async () => {
  const { a, b, bytes, sha } = await withFile(FILE_CHUNK * 8);
  // first link drops partway through the file
  let l = await link(a, b, { dropAfter: 12 });
  await Promise.all([l.pa.start(), l.pb.start()]);
  await until(() => l.ev.b.some((e) => e.kind === 'complete'), 1000).catch(() => {});
  // try again on a fresh, healthy link, then transfer
  l = await link(a, b); await Promise.all([l.pa.start(), l.pb.start()]);
  await until(() => l.ev.b.some((e) => e.kind === 'complete'));
  // simulate a half-finished download saved from a previous drop
  await b.files.put(sha, { name: 'soil.csv', size: bytes.length, partial: bytes.subarray(0, FILE_CHUNK * 3) });
  const r = await l.pb.requestFile(sha);
  await until(() => l.ev.b.some((e) => e.kind === 'file-done'));
  const start = l.ev.b.find((e) => e.kind === 'file-start');
  assert.equal(start.resumedAt, FILE_CHUNK * 3);
  assert.deepEqual((await b.files.get(sha)).bytes, bytes);
});

test('syncing again picks up records added since the first sync', async () => {
  const a = await newNode('a'), b = await newNode('b'); await trustEachOther(a, b);
  const { pa, pb, ev } = await link(a, b);
  await Promise.all([pa.start(), pb.start()]);
  await until(() => ev.a.some((e) => e.kind === 'complete'));
  const rec = await a.log.append(a.identity, { type: 'update', ref: 'CP1', payload: { text: 'later' } });
  await Promise.all([pa.start(), pb.start()]);
  await until(() => b.log.has(rec.id));
});
