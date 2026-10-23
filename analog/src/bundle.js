// .bixx bundles: a signed, versioned file of records that can be moved by any carrier
// (a file, a share sheet, a QR animation). Every record inside still carries its own signature,
// so a bundle is only a convenient envelope; importing re-verifies every record.

import { canonical, enc, dec, fmtAye, hex, nowSec, b64u, unb64u, sha256 } from './canon.js';
import { checkShape, SchemaError } from './schema.js';
import { fingerprintOf } from './keys.js';
import { unhex } from './canon.js';

export const BUNDLE_FORMAT = 'bixx-bundle';
export const MAX_BUNDLE_RECORDS = 5000;
export const MAX_BUNDLE_BYTES = 10 * 1024 * 1024;

const signedBytes = (b) => enc.encode(canonical({ format: b.format, v: b.v, created: b.created, from: b.from, keys: b.keys.map((k) => k.fp), records: b.records.map((r) => r.id) }));

export async function exportBundle(log, identity, { ids = null, label = '' } = {}) {
  const records = ids ? ids.map((id) => log.get(id)).filter(Boolean) : log.snapshot();
  // The allowlist is checked again on the way out, so nothing outside it can leave the device even if it got into storage.
  for (const r of records) {
    try { checkShape(r); } catch (e) { throw new SchemaError(`Not exported: record ${String(r?.id).slice(0, 8)} is not an allowed Analog record (${e.message}).`); }
  }
  const authors = new Set([identity.fp, ...records.map((r) => r.author)]);
  const keys = [...authors].map((fp) => log.keyring.get(fp)).filter(Boolean).map((e) => ({ fp: e.fp, pub: e.pub, label: e.label || '' }));
  const b = { format: BUNDLE_FORMAT, v: 1, created: fmtAye(nowSec()), from: identity.fp, label: String(label).slice(0, 60), keys, records };
  b.sig = b64u(new Uint8Array(await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, identity.signKey, signedBytes(b))));
  return JSON.stringify(b);
}

export async function importBundle(text, log, { now } = {}) {
  const rep = { accepted: [], duplicate: [], rejected: [], unknownKeys: [], sender: null, error: null };
  let b;
  try {
    if (typeof text !== 'string' || text.length > MAX_BUNDLE_BYTES) throw new Error('too large');
    b = JSON.parse(text);
    if (!b || b.format !== BUNDLE_FORMAT) throw new Error('not a bundle');
    if (b.v !== 1) throw new Error('This bundle was made by a newer version. Update the app first.');
    if (!Array.isArray(b.records) || !Array.isArray(b.keys) || typeof b.sig !== 'string' || typeof b.from !== 'string') throw new Error('incomplete');
    if (b.records.length > MAX_BUNDLE_RECORDS) throw new Error('too many records');
  } catch (e) { rep.error = e.message === 'not a bundle' ? 'That file is not a Bixxville bundle.' : e.message.startsWith('This bundle') ? e.message : 'That bundle is damaged or too large.'; return rep; }

  // Who sent it. If we trust the sender, the bundle signature has to check out; a bad one means it was altered.
  const known = log.keyring.get(b.from);
  let sigOk = null;
  if (known) {
    const key = await log.keyring.verifyKey(b.from);
    try { sigOk = await crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, key, unb64u(b.sig), signedBytes(b)); } catch (e) { sigOk = false; }
    if (!sigOk) { rep.error = 'The bundle signature does not match, so it was changed after it was made. Nothing was imported.'; rep.sender = { fp: b.from, known: true, sigOk: false }; return rep; }
  }
  rep.sender = { fp: b.from, known: !!known, sigOk };

  // Keys we do not trust yet. They are offered to the person, never added silently.
  for (const k of b.keys) {
    if (!k || typeof k.fp !== 'string' || typeof k.pub !== 'string' || log.keyring.has(k.fp)) continue;
    try { if ((await fingerprintOf(unhex(k.pub))) === k.fp) rep.unknownKeys.push({ fp: k.fp, pub: k.pub, label: String(k.label || '').slice(0, 40) }); } catch (e) { /* skip a bad key */ }
  }
  const r = await log.merge(b.records, { via: known ? b.from : 'bundle', now });
  Object.assign(rep, r);
  return rep;
}
