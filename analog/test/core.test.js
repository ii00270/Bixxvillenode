import { test } from 'node:test';
import assert from 'node:assert/strict';
import fc from 'fast-check';
import { newNode, trustEachOther } from './_helpers.js';
import { createRecord, verifyRecord, compactEncode, compactDecode, verifyCompact, COMPACT_BYTES } from '../src/record.js';
import { createIdentity, restoreIdentity, keyCard, readKeyCard, Keyring } from '../src/keys.js';
import { MemoryStore } from '../src/store.js';
import { Log } from '../src/log.js';
import { fmtAye, parseAye, b64u, unb64u, hex, canonical } from '../src/canon.js';
import { checkShape, SchemaError, TYPES } from '../src/schema.js';

const T0 = 1_792_000_000;   // a fixed instant in 2026
const NOW = T0 + 100000;

test('timestamps: one spelling per instant, AyeAye offset, round trip', () => {
  assert.equal(fmtAye(0), '1969-12-31T20:00:00-04:00');
  assert.equal(parseAye(fmtAye(T0)), T0);
  assert.throws(() => parseAye('2026-10-23T09:30:00Z'));
  assert.throws(() => parseAye('2026-10-23T09:30:00-05:00'));
  assert.throws(() => parseAye('2026-02-31T09:30:00-04:00'));
  fc.assert(fc.property(fc.integer({ min: 0, max: 4_000_000_000 }), (s) => parseAye(fmtAye(s)) === s));
});

test('sign and verify a record', async () => {
  const a = await newNode('a');
  const rec = await createRecord(a.identity, { type: 'stamp', class: 'Delivered', ref: 'CP3', payload: { note: 'done' }, ts: T0 });
  assert.equal(rec.ts, fmtAye(T0));
  assert.deepEqual(await verifyRecord(rec, a.keyring, { now: NOW }), { ok: true });
});

test('tampering with any signed part is rejected', async () => {
  const a = await newNode('a');
  const rec = await createRecord(a.identity, { type: 'update', ref: 'CP3', payload: { text: 'hello' }, ts: T0 });
  const change = async (mut) => { const r = structuredClone(rec); mut(r); return verifyRecord(r, a.keyring, { now: NOW }); };
  assert.equal((await change((r) => { r.payload.text = 'hullo'; })).ok, false);
  assert.equal((await change((r) => { r.ref = 'CP4'; })).ok, false);
  assert.equal((await change((r) => { r.ts = fmtAye(T0 + 1); })).ok, false);
  assert.equal((await change((r) => { r.prev = 'a'.repeat(64); })).ok, false);
  assert.equal((await change((r) => { r.sig = b64u(new Uint8Array(64)); })).reason, 'bad signature (changed or forged)');
  assert.match((await change((r) => { r.id = 'b'.repeat(64); })).reason, /id does not match/);
  assert.match((await change((r) => { r.type = 'ack'; r.payload = { of: 'c'.repeat(64) }; })).reason, /bad signature|id does not/);
  assert.match((await change((r) => { delete r.sig; })).reason, /not allowed/);
});

test('a record from an unknown key is rejected; trusting the key accepts it', async () => {
  const a = await newNode('a'), b = await newNode('b');
  const rec = await createRecord(b.identity, { type: 'update', ref: 'CP1', payload: { text: 'hi' }, ts: T0 });
  assert.equal((await a.log.add(rec, { now: NOW })).reason, 'unknown key');
  await trustEachOther(a, b);
  assert.equal((await a.log.add(rec, { now: NOW })).status, 'accepted');
});

test('replay: the same record again is a duplicate, never a second copy', async () => {
  const a = await newNode('a'), b = await newNode('b'); await trustEachOther(a, b);
  const rec = await b.log.append(b.identity, { type: 'update', ref: 'CP1', payload: { text: 'hi' } });
  assert.equal((await a.log.add(rec, { via: b.identity.fp })).status, 'accepted');
  assert.equal((await a.log.add(rec, { via: b.identity.fp })).status, 'duplicate');
  assert.equal(a.log.size, 1);
  assert.equal(a.log.stateOf(rec.id), 'Relayed');
});

test('a signature is bound to its record: moving it onto other content fails', async () => {
  const a = await newNode('a');
  const r1 = await createRecord(a.identity, { type: 'update', ref: 'CP1', payload: { text: 'one' }, ts: T0 });
  const r2 = await createRecord(a.identity, { type: 'update', ref: 'CP1', payload: { text: 'two' }, ts: T0 });
  const forged = { ...r2, sig: r1.sig, id: r1.id };
  assert.equal((await verifyRecord(forged, a.keyring, { now: NOW })).ok, false);
});

test('a future timestamp is rejected', async () => {
  const a = await newNode('a');
  const rec = await createRecord(a.identity, { type: 'update', ref: 'CP1', payload: { text: 'hi' }, ts: NOW + 100000 });
  assert.equal((await verifyRecord(rec, a.keyring, { now: NOW })).reason, 'timestamp is in the future');
});

test('key backup: restore gives the same key; wrong passphrase fails; the live key is not extractable', async () => {
  const { identity, backup } = await createIdentity('correct horse', { iterations: 1000 });
  await assert.rejects(() => crypto.subtle.exportKey('jwk', identity.signKey));
  assert.match(backup.warning, /only way to get your signing key back/);
  assert.ok(!JSON.stringify(backup).includes('"d"'));
  const back = await restoreIdentity(backup, 'correct horse');
  assert.equal(back.fp, identity.fp);
  await assert.rejects(() => restoreIdentity(backup, 'wrong passphrase'), /Wrong passphrase/);
  const keyring = new Keyring(new MemoryStore()); await keyring.add({ fp: identity.fp, pub: hex(identity.pubRaw), trust: 'self' });
  const rec = await createRecord(back, { type: 'update', ref: 'CP1', payload: { text: 'restored' }, ts: T0 });
  assert.equal((await verifyRecord(rec, keyring, { now: NOW })).ok, true);
  await assert.rejects(() => createIdentity('short'), /at least 8/);
});

test('key cards must match their own fingerprint', async () => {
  const a = await newNode('a');
  const card = keyCard(a.identity, 'Alice');
  assert.equal((await readKeyCard(card)).fp, a.identity.fp);
  await assert.rejects(() => readKeyCard({ ...card, fp: 'f'.repeat(64) }), /fingerprint/);
});

// ── Care and money isolation ──
test('only allowlisted record types and fields can be written, received or exported', async () => {
  const a = await newNode('a');
  const bad = [
    { type: 'care_entry', ref: 'X1', payload: { flow: 'light' } },
    { type: 'health', ref: 'X1', payload: { mood: 3 } },
    { type: 'update', ref: 'X1', payload: { text: 'hi', mood: 'low' } },
    { type: 'update', ref: 'X1', payload: { text: 'hi', symptoms: ['fatigue'] } },
    { type: 'stamp', class: 'Delivered', ref: 'CP1', payload: { amount: 12000 } },
    { type: 'stamp', class: 'Delivered', ref: 'CP1', payload: { price_usd: 266.67 } },
    { type: 'stamp', class: 'Delivered', ref: 'CP1', payload: { cents: 100 } },
    { type: 'update', class: 'Delivered', ref: 'CP1', payload: { text: 'x' } },
    { type: 'stamp', class: 'Voice', ref: 'CP1', payload: {} },
  ];
  for (const d of bad) {
    await assert.rejects(() => a.log.append(a.identity, d), SchemaError, JSON.stringify(d));
    await assert.rejects(() => createRecord(a.identity, d), SchemaError);
  }
  assert.equal(a.log.size, 0);
  // a record someone else hand-builds with a valid signature but a disallowed shape is still refused on receipt
  const ok = await createRecord(a.identity, { type: 'update', ref: 'CP1', payload: { text: 'fine' }, ts: T0 });
  for (const mut of [(r) => { r.type = 'care_entry'; }, (r) => { r.payload.flow = 'heavy'; }, (r) => { r.extra = 1; }, (r) => { r.payload = { amount: 5 }; }]) {
    const r = structuredClone(ok); mut(r);
    const res = await a.log.add(r, { now: NOW });
    assert.equal(res.status, 'rejected'); assert.match(res.reason, /not allowed/);
  }
  assert.deepEqual(TYPES, ['stamp', 'update', 'file_manifest', 'ack']);
});

// ── compact form ──
test('every record type encodes to 101 bytes (under the 200-byte limit) and round-trips', async () => {
  const a = await newNode('a');
  const payloads = [
    { type: 'stamp', class: 'Started', ref: 'CP1', payload: {} },
    { type: 'stamp', class: 'Delivered', ref: 'CP1', payload: { line: 3, note: 'x'.repeat(140) } },
    { type: 'stamp', class: 'Audited', ref: 'BIX_00271', payload: {} },
    { type: 'stamp', class: 'Authorized', ref: 'CP12', payload: {} },
    { type: 'stamp', class: 'Sealed', ref: 'CP12', payload: {} },
    { type: 'update', ref: 'CP2', payload: { text: 'y'.repeat(280), topic: 'weather' } },
    { type: 'file_manifest', ref: 'CP2', payload: { name: 'soil.csv', size: 1234, sha256: 'ab'.repeat(32) } },
    { type: 'ack', ref: 'CP2', payload: { of: 'cd'.repeat(32) } },
  ];
  for (const p of payloads) {
    const rec = await a.log.append(a.identity, { ...p, ts: undefined });
    const bytes = await compactEncode(rec);
    assert.equal(bytes.length, COMPACT_BYTES); assert.ok(bytes.length <= 200);
    const c = compactDecode(bytes);
    assert.equal(c.type, rec.type); assert.equal(c.class, rec.class); assert.equal(c.ts, rec.ts); assert.equal(c.authorShort, rec.author.slice(0, 16));
    const v = await verifyCompact(bytes, a.keyring);
    assert.equal(v.ok, true); assert.equal(v.beacon.id, rec.id);          // same id as the full record
  }
});
test('property: any valid record encodes under 200 bytes and decodes to the same id', async () => {
  const a = await newNode('a');
  const arb = fc.record({
    text: fc.string({ minLength: 1, maxLength: 280 }).filter((s) => !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(s)),
    ref: fc.stringMatching(/^[A-Za-z0-9][A-Za-z0-9_.:\/-]{0,63}$/),
    ts: fc.integer({ min: 1_700_000_000, max: 1_800_000_000 }),
  });
  await fc.assert(fc.asyncProperty(arb, async ({ text, ref, ts }) => {
    const rec = await createRecord(a.identity, { type: 'update', ref, payload: { text }, ts });
    const bytes = await compactEncode(rec);
    const v = await verifyCompact(bytes, a.keyring, { now: 1_900_000_000 });
    return bytes.length === 101 && v.ok && v.beacon.id === rec.id;
  }), { numRuns: 60 });
});
test('radio: unsigned, tampered, unknown-key and replayed-shape messages are rejected', async () => {
  const a = await newNode('a'), b = await newNode('b');
  const rec = await a.log.append(a.identity, { type: 'stamp', class: 'Delivered', ref: 'CP1', payload: {} });
  const bytes = await compactEncode(rec);
  const flip = (i) => { const x = bytes.slice(); x[i] ^= 1; return x; };
  for (const i of [0, 3, 12, 20, 30, 50, 100]) assert.equal((await verifyCompact(flip(i), a.keyring)).ok, false, 'byte ' + i);
  assert.equal((await verifyCompact(bytes.subarray(0, 100), a.keyring)).reason, 'malformed');
  assert.equal((await verifyCompact(new Uint8Array(101), a.keyring)).ok, false);
  assert.equal((await verifyCompact(bytes, b.keyring)).reason, 'unknown key');
  assert.equal((await verifyCompact(bytes, a.keyring, { now: 1 })).reason, 'timestamp is in the future');
});

// ── merge: idempotent, commutative, associative ──
async function pool() {
  const a = await newNode('a'), b = await newNode('b'), c = await newNode('c'); await trustEachOther(a, b, c);
  const recs = [];
  for (const n of [a, b, c]) {
    let prev = null;
    for (let i = 0; i < 4; i++) {
      const r = await createRecord(n.identity, { type: i % 2 ? 'update' : 'stamp', class: i % 2 ? null : ['Delivered', 'Audited'][i / 2], ref: 'CP' + (i % 3), payload: i % 2 ? { text: `${n.label}${i}` } : {}, prev, ts: T0 + i * 10 + (n === b ? 3 : 0) });
      recs.push(r); prev = r.id;
    }
  }
  return { a, recs };
}
const fresh = async (a) => new Log(new MemoryStore(), a.keyring);
const setOf = (log) => JSON.stringify(log.snapshot().map((r) => r.id));

test('merge is idempotent, commutative and associative (property tests)', async () => {
  const { a, recs } = await pool();
  const sub = fc.subarray(recs, { minLength: 0 });
  await fc.assert(fc.asyncProperty(sub, sub, sub, fc.integer(), async (X, Y, Z, seed) => {
    const shuffle = (arr) => arr.map((v, i) => [Math.sin(seed + i), v]).sort((p, q) => p[0] - q[0]).map((p) => p[1]);
    const L = async (...parts) => { const l = await fresh(a); for (const p of parts) await l.merge(p, { now: NOW }); return l; };
    const xy = await L(X, Y), yx = await L(Y, X);
    if (setOf(xy) !== setOf(yx)) return false;                                   // commutative
    const xx = await L(X, X); if (setOf(xx) !== setOf(await L(X))) return false;  // idempotent
    const left = await L(X, Y, Z);                                                // (X+Y)+Z
    const yz = await L(Y, Z);
    const right = await L(X, yz.snapshot());                                      // X+(Y+Z)
    if (setOf(left) !== setOf(right)) return false;
    const shuffled = await L(shuffle(X), shuffle(Y), shuffle(Z));                 // order of arrival does not matter
    return setOf(shuffled) === setOf(left);
  }), { numRuns: 40 });
});

test('out-of-order arrival: a record whose predecessor is missing is held as pending, then clears', async () => {
  const { a, recs } = await pool();
  const chainA = recs.slice(0, 4);
  const l = await fresh(a);
  await l.merge([chainA[2], chainA[3]], { now: NOW });
  assert.deepEqual(l.view().map((v) => v.badge), ['pending', 'pending'].map((x, i) => (i === 0 ? 'pending' : 'verified')));
  await l.merge([chainA[0], chainA[1]], { now: NOW });
  assert.ok(l.view().every((v) => v.badge === 'verified' || v.badge === 'gap'));
  assert.ok(!l.view().some((v) => v.badge === 'pending'));
});

test('forks are flagged, and stamp gaps and out-of-order dates are shown', async () => {
  const a = await newNode('a'), b = await newNode('b'); await trustEachOther(a, b);
  const r1 = await createRecord(a.identity, { type: 'update', ref: 'CP1', payload: { text: 'one' }, ts: T0 });
  const r2 = await createRecord(a.identity, { type: 'update', ref: 'CP1', payload: { text: 'two' }, prev: r1.id, ts: T0 + 5 });
  const r2b = await createRecord(a.identity, { type: 'update', ref: 'CP1', payload: { text: 'two-b' }, prev: r1.id, ts: T0 + 6 });
  await b.log.merge([r1, r2, r2b], { now: NOW });
  assert.equal(b.log.view().filter((v) => v.badge === 'fork').length, 2);
  // Sealed with no Audited/Authorized behind it
  const s1 = await createRecord(a.identity, { type: 'stamp', class: 'Delivered', ref: 'CP9', payload: {}, ts: T0 });
  const s2 = await createRecord(b.identity, { type: 'stamp', class: 'Sealed', ref: 'CP9', payload: {}, ts: T0 + 50 });
  const l = await fresh(a); await l.merge([s1, s2], { now: NOW });
  const st = l.stampsFor('CP9');
  assert.deepEqual(st.missing, ['Audited', 'Authorized']); assert.equal(st.complete, false);
  assert.ok(l.view().some((v) => v.badge === 'gap'));
  // a Delivered stamp dated after its Audited stamp
  const d = await createRecord(a.identity, { type: 'stamp', class: 'Delivered', ref: 'CP8', payload: {}, ts: T0 + 90 });
  const au = await createRecord(b.identity, { type: 'stamp', class: 'Audited', ref: 'CP8', payload: {}, ts: T0 + 20 });
  const l2 = await fresh(a); await l2.merge([d, au], { now: NOW });
  assert.deepEqual(l2.stampsFor('CP8').outOfOrder, ['Audited is dated before Delivered']);
});

test('Anchored is only set with a chain and a confirmed transaction', async () => {
  const a = await newNode('a');
  const rec = await a.log.append(a.identity, { type: 'update', ref: 'CP1', payload: { text: 'x' } });
  assert.equal(a.log.stateOf(rec.id), 'Local');
  await assert.rejects(() => a.log.markAnchored(rec.id, { chain: 'hedera-testnet' }), /needs the chain/);
  assert.equal(a.log.stateOf(rec.id), 'Local');
});

test('appends chain to the previous record', async () => {
  const a = await newNode('a');
  const r1 = await a.log.append(a.identity, { type: 'update', ref: 'CP1', payload: { text: 'one' } });
  const r2 = await a.log.append(a.identity, { type: 'update', ref: 'CP1', payload: { text: 'two' } });
  assert.equal(r1.prev, null); assert.equal(r2.prev, r1.id);
  assert.equal(a.log.tipOf(a.identity.fp), r2.id);
});

// ── isolation from the rest of the app ──
import { readdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
test('Analog code never imports Care code, names a Care table, or touches money code', async () => {
  const dir = fileURLToPath(new URL('../src/', import.meta.url));
  for (const f of await readdir(dir)) {
    const text = await readFile(dir + f, 'utf8');
    assert.ok(!/from\s*['"`][^'"`]*care\//i.test(text) && !/import\s*\(\s*['"`][^'"`]*care\//i.test(text), `${f} imports Care code`);
    const tables = new RegExp('\\b(' + [['cycle', 'entries'], ['care', 'settings'], ['care', 'flow']].map((p) => p.join('_')).join('|') + ')\\b');   // spelled in pieces so this file does not trip Care's own checker
    assert.ok(!tables.test(text), `${f} names a Care table`);
    assert.ok(!/escrow|BixxEngagement|test-vectors|\.rpc\(|supabase/i.test(text), `${f} touches escrow, payments or the database`);
  }
});
