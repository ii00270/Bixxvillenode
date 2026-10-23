// A record, how it is signed, how it is verified, and its compact form for the radio.
//
// What is signed is the compact form: type (1 byte) | author (8) | ref (8) | time (4) | body hash (16).
// The body hash covers everything else (version, class, prev, payload), so one 64-byte signature
// binds the whole record AND is checkable from the 101 compact bytes alone. A full record, a bundle
// entry and a radio message are the same signed thing in different sizes. A record's id is the
// SHA-256 of its signed bytes, so the compact form and the full record always agree on the id.

import { canonical, concat, eq, fmtAye, hex, nowSec, parseAye, sha256, enc, unhex, b64u, unb64u } from './canon.js';
import { SchemaError, TYPE_CODE, checkDraft, checkShape, typeFromCode, typeKey } from './schema.js';
import { shortId } from './keys.js';

export const COMPACT_BYTES = 101;      // 1 + 8 + 8 + 4 + 16 + 64
export const MAX_FUTURE_SECONDS = 600; // a clock this far ahead is wrong, or the record is forged

const bodyOf = (r) => ({ v: r.v, class: r.class ?? null, prev: r.prev ?? null, payload: r.payload });
export async function bodyHash(r) { return (await sha256(enc.encode(canonical(bodyOf(r))))).subarray(0, 16); }
export async function refHash(ref) { return (await sha256(enc.encode(ref))).subarray(0, 8); }

function u32(n) { return Uint8Array.of((n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255); }
const readU32 = (b, o) => ((b[o] << 24) | (b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3]) >>> 0;

export async function preimageOf(r) {
  const code = TYPE_CODE[typeKey(r.type, r.class)];
  return concat(Uint8Array.of(code), unhex(r.author).subarray(0, 8), await refHash(r.ref), u32(parseAye(r.ts)), await bodyHash(r));
}

// Makes and signs a record. `prev` is the id of this author's previous record (or null).
export async function createRecord(identity, { type, class: cls = null, ref, payload = {}, prev = null, ts = nowSec() }) {
  checkDraft({ type, class: cls, ref, payload });
  const rec = { v: 1, type, author: identity.fp, class: type === 'stamp' ? cls : null, ref, ts: fmtAye(ts), prev: prev ?? null, payload };
  const pre = await preimageOf(rec);
  rec.sig = b64u(new Uint8Array(await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, identity.signKey, pre)));
  rec.id = hex(await sha256(pre));
  checkShape(rec);
  return rec;
}

// Returns { ok: true } or { ok: false, reason }. Never throws for bad input.
export async function verifyRecord(rec, keyring, { now = nowSec() } = {}) {
  try { checkShape(rec); } catch (e) {
    return { ok: false, reason: e instanceof SchemaError ? 'not allowed: ' + e.message : 'malformed' };
  }
  let sec;
  try { sec = parseAye(rec.ts); } catch (e) { return { ok: false, reason: 'bad timestamp' }; }
  if (sec > now + MAX_FUTURE_SECONDS) return { ok: false, reason: 'timestamp is in the future' };
  const key = await keyring.verifyKey(rec.author);
  if (!key) return { ok: false, reason: 'unknown key' };
  const pre = await preimageOf(rec);
  const good = await crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, key, unb64u(rec.sig), pre);
  if (!good) return { ok: false, reason: 'bad signature (changed or forged)' };
  if (hex(await sha256(pre)) !== rec.id) return { ok: false, reason: 'id does not match the content' };
  return { ok: true };
}

// ── compact form: type | author8 | ref8 | ts4 | bodyhash16 | sig64 = 101 bytes ──
export async function compactEncode(rec) {
  checkShape(rec);
  const bytes = concat(await preimageOf(rec), unb64u(rec.sig));
  if (bytes.length !== COMPACT_BYTES) throw new Error('compact record is the wrong size');
  return bytes;
}
export function compactDecode(bytes) {
  if (!(bytes instanceof Uint8Array) || bytes.length !== COMPACT_BYTES) throw new Error('not a compact record');
  const t = typeFromCode(bytes[0]);
  return {
    type: t.type, class: t.class, authorShort: hex(bytes.subarray(1, 9)), refHash: hex(bytes.subarray(9, 17)),
    tsSec: readU32(bytes, 17), ts: fmtAye(readU32(bytes, 17)), bodyHash: hex(bytes.subarray(21, 37)),
    id: null, preimage: bytes.subarray(0, 37), sig: bytes.subarray(37),
  };
}
// Verifies a compact record against the keyring. This is all a radio message can prove:
// "this author signed a record of this type, for this ref, at this time, with this body hash".
export async function verifyCompact(bytes, keyring, { now = nowSec() } = {}) {
  let c;
  try { c = compactDecode(bytes); } catch (e) { return { ok: false, reason: 'malformed' }; }
  if (c.tsSec > now + MAX_FUTURE_SECONDS) return { ok: false, reason: 'timestamp is in the future' };
  const entry = keyring.byShort(c.authorShort);
  if (!entry) return { ok: false, reason: 'unknown key' };
  const key = await keyring.verifyKey(entry.fp);
  if (!(await crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, key, c.sig, c.preimage))) return { ok: false, reason: 'bad signature (changed or forged)' };
  c.id = hex(await sha256(c.preimage));
  c.author = entry.fp;
  return { ok: true, beacon: c };
}
export { shortId };
