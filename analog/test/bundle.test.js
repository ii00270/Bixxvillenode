import { test } from 'node:test';
import assert from 'node:assert/strict';
import fc from 'fast-check';
import { newNode, trustEachOther } from './_helpers.js';
import { exportBundle, importBundle } from '../src/bundle.js';
import { encodeFrames, parseFrame, FrameAssembler } from '../src/frames.js';
import { Log } from '../src/log.js';
import { MemoryStore } from '../src/store.js';
import { createRecord } from '../src/record.js';
import { SchemaError } from '../src/schema.js';

test('bundle: export, import elsewhere — accepted, then duplicate on a second import', async () => {
  const a = await newNode('a'), b = await newNode('b'); await trustEachOther(a, b);
  await a.log.append(a.identity, { type: 'stamp', class: 'Delivered', ref: 'CP1', payload: { note: 'ok' } });
  await a.log.append(a.identity, { type: 'update', ref: 'CP1', payload: { text: 'on site' } });
  const text = await exportBundle(a.log, a.identity, { label: 'trip' });
  assert.ok(JSON.parse(text).sig);
  const r1 = await importBundle(text, b.log);
  assert.equal(r1.accepted.length, 2); assert.equal(r1.rejected.length, 0); assert.deepEqual(r1.sender, { fp: a.identity.fp, known: true, sigOk: true });
  assert.equal(b.log.stateOf(r1.accepted[0]), 'Relayed');
  const r2 = await importBundle(text, b.log);
  assert.equal(r2.accepted.length, 0); assert.equal(r2.duplicate.length, 2);
});

test('bundle: a changed bundle from a trusted sender imports nothing', async () => {
  const a = await newNode('a'), b = await newNode('b'); await trustEachOther(a, b);
  await a.log.append(a.identity, { type: 'update', ref: 'CP1', payload: { text: 'one' } });
  const o = JSON.parse(await exportBundle(a.log, a.identity));
  o.records.push(o.records[0]);          // sneak a change into the signed set
  const r = await importBundle(JSON.stringify(o), b.log);
  assert.match(r.error, /does not match/); assert.equal(b.log.size, 0);
});

test('bundle: records from keys we do not trust are rejected, and the key is offered, not added', async () => {
  const a = await newNode('a'), b = await newNode('b');           // not trusting each other
  await a.log.append(a.identity, { type: 'update', ref: 'CP1', payload: { text: 'hi' } });
  const r = await importBundle(await exportBundle(a.log, a.identity), b.log);
  assert.equal(r.accepted.length, 0); assert.equal(r.rejected[0].reason, 'unknown key');
  assert.equal(r.unknownKeys.length, 1); assert.equal(r.unknownKeys[0].fp, a.identity.fp);
  assert.equal(b.keyring.has(a.identity.fp), false);
  // the person chooses to trust it, then imports again
  await b.keyring.add(r.unknownKeys[0]);
  assert.equal((await importBundle(await exportBundle(a.log, a.identity), b.log)).accepted.length, 1);
});

test('bundle: bad files are reported, not crashed on', async () => {
  const a = await newNode('a');
  for (const t of ['', 'nope', '{}', '{"format":"bixx-bundle","v":9}', JSON.stringify({ format: 'bixx-bundle', v: 1, records: 'x', keys: [], sig: 's', from: 'f' })])
    assert.ok((await importBundle(t, a.log)).error, t);
  assert.ok((await importBundle('x'.repeat(11 * 1024 * 1024), a.log)).error);
});

test('bundle: one bad record does not block the good ones, and each is reported with a reason', async () => {
  const a = await newNode('a'), b = await newNode('b'); await trustEachOther(a, b);
  const good = await a.log.append(a.identity, { type: 'update', ref: 'CP1', payload: { text: 'good' } });
  const bad = structuredClone(good); bad.payload.text = 'changed'; bad.id = 'e'.repeat(64);
  const o = JSON.parse(await exportBundle(a.log, a.identity)); o.records.push(bad);
  // re-sign nothing: the sender is not signed in this test, so strip the sender trust by using an unknown 'from'
  o.from = 'f'.repeat(64);
  const r = await importBundle(JSON.stringify(o), b.log);
  assert.equal(r.accepted.length, 1); assert.equal(r.rejected.length, 1); assert.match(r.rejected[0].reason, /bad signature|id does not match/);
});

test('export refuses anything outside the allowlist even if it got into storage', async () => {
  const a = await newNode('a');
  await a.log.append(a.identity, { type: 'update', ref: 'CP1', payload: { text: 'fine' } });
  const sneaky = { v: 1, id: 'a'.repeat(64), type: 'care_entry', author: a.identity.fp, class: null, ref: 'X1', ts: '2026-10-23T09:00:00-04:00', prev: null, payload: { flow: 'light' }, sig: 'A'.repeat(86) };
  a.log.recs.set(sneaky.id, sneaky);
  await assert.rejects(() => exportBundle(a.log, a.identity), SchemaError);
});

// ── frames ──
const bytesArb = fc.uint8Array({ minLength: 0, maxLength: 6000 });

test('frames: round trip, in any order, with repeats', async () => {
  await fc.assert(fc.asyncProperty(bytesArb, fc.integer(), async (bytes, seed) => {
    const frames = await encodeFrames(bytes, { chunk: 120 });
    const order = frames.map((f, i) => [Math.sin(seed + i), f]).sort((p, q) => p[0] - q[0]).map((p) => p[1]);
    const asm = new FrameAssembler();
    for (const f of [...order, order[0]]) asm.add(f);
    const out = await asm.result();
    return out.length === bytes.length && out.every((v, i) => v === bytes[i]);
  }), { numRuns: 40 });
});
test('frames: a single small record is one frame', async () => {
  const f = await encodeFrames(new TextEncoder().encode('hello'));
  assert.equal(f.length, 1); assert.ok(f[0].length < 100);
});
test('frames: resume — scan some, stop, carry on later with the rest', async () => {
  const bytes = crypto.getRandomValues(new Uint8Array(3000));
  const frames = await encodeFrames(bytes, { chunk: 200, compress: false });
  const asm = new FrameAssembler();
  frames.slice(0, 5).forEach((f) => asm.add(f));
  assert.deepEqual(asm.progress().missing.slice(0, 3), [5, 6, 7]);
  await assert.rejects(() => asm.result(), /Not every frame/);
  frames.slice(5).forEach((f) => asm.add(f));
  assert.deepEqual(await asm.result(), bytes);
});
test('frames: corrupted, truncated and foreign frames are refused; a misread that passes the frame check is caught by the payload hash', async () => {
  const frames = await encodeFrames(crypto.getRandomValues(new Uint8Array(900)), { chunk: 200, compress: false });
  const asm = new FrameAssembler();
  const flipped = frames[1].slice(0, -3) + (frames[1].slice(-3) === 'AAA' ? 'BBB' : 'AAA');
  assert.match(asm.add(flipped).reason, /corrupted|bad/);
  assert.equal(asm.add('BXF1.zzz').ok, false); assert.equal(asm.add('hello').ok, false);
  const other = await encodeFrames(crypto.getRandomValues(new Uint8Array(900)), { chunk: 200, compress: false });
  frames.forEach((f) => asm.add(f));
  // swap one frame for a different session's frame forged to the same session id and number
  const f = parseFrame(frames[0]), g = parseFrame(other[2]);
  const forged = `BXF1.${f.sid}.2.${f.total}.${parseFrame(other[2]).part.length ? other[2].split('.')[4] : ''}.${other[2].split('.')[5]}`;
  const asm2 = new FrameAssembler();
  frames.forEach((fr, i) => asm2.add(i === 2 ? forged : fr));
  await assert.rejects(() => asm2.result(), /do not add up/);
});
test('frames: too big for QR is refused with advice', async () => {
  await assert.rejects(() => encodeFrames(new Uint8Array(900000).map((_, i) => (i * 2654435761) >>> 24), { compress: false }), /bundle file/);
});
test('frames: a whole signed bundle goes through frames and imports', async () => {
  const a = await newNode('a'), b = await newNode('b'); await trustEachOther(a, b);
  for (let i = 0; i < 8; i++) await a.log.append(a.identity, { type: 'update', ref: 'CP1', payload: { text: 'message number ' + i } });
  const text = await exportBundle(a.log, a.identity);
  const frames = await encodeFrames(new TextEncoder().encode(text));
  const asm = new FrameAssembler(); frames.reverse().forEach((f) => asm.add(f));
  const r = await importBundle(new TextDecoder().decode(await asm.result()), b.log);
  assert.equal(r.accepted.length, 8);
});
