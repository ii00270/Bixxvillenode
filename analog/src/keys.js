// Keys. ECDSA P-256 through WebCrypto, the widest-supported option.
//
// The signing key that lives on the device is NON-EXTRACTABLE: nothing, including this app, can
// read it back out. That would make a backup impossible, so a new key is generated extractable
// once, written to an encrypted backup file, and then re-imported as non-extractable. The backup
// is made at that moment or never; a key already living on a device cannot be exported later.

import { b64u, concat, enc, dec, hex, sha256, unb64u, unhex } from './canon.js';

const ECDSA = { name: 'ECDSA', namedCurve: 'P-256' };
export const BACKUP_WARNING =
  'This file is the only way to get your signing key back if this device is lost, wiped or replaced. ' +
  'Anyone who has the file and the passphrase can sign as you. Keep it offline, and do not email it or store it in a chat.';

export async function fingerprintOf(pubRaw) { return hex(await sha256(pubRaw)); }
export const shortId = (fp) => fp.slice(0, 16);   // 8 bytes, as hex

export async function importPublic(pubRaw) {
  if (!(pubRaw instanceof Uint8Array) || pubRaw.length !== 65 || pubRaw[0] !== 4) throw new Error('not a P-256 public key');
  return crypto.subtle.importKey('raw', pubRaw, ECDSA, true, ['verify']);
}

async function passKey(passphrase, salt, iterations) {
  const base = await crypto.subtle.importKey('raw', enc.encode(passphrase), 'PBKDF2', false, ['deriveKey']);
  return crypto.subtle.deriveKey({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations }, base, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
}

// Makes a new identity. Returns the live identity (non-extractable key) and the encrypted backup.
export async function createIdentity(passphrase, { iterations = 250000 } = {}) {
  if (typeof passphrase !== 'string' || passphrase.length < 8) throw new Error('Choose a passphrase of at least 8 characters for the backup.');
  const pair = await crypto.subtle.generateKey(ECDSA, true, ['sign', 'verify']);
  const jwk = await crypto.subtle.exportKey('jwk', pair.privateKey);
  const pubRaw = new Uint8Array(await crypto.subtle.exportKey('raw', pair.publicKey));
  const fp = await fingerprintOf(pubRaw);
  const salt = crypto.getRandomValues(new Uint8Array(16)), iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: enc.encode(fp) }, await passKey(passphrase, salt, iterations), enc.encode(JSON.stringify(jwk))));
  const backup = { format: 'bixx-key-backup', v: 1, fp, kdf: 'PBKDF2-SHA256', iter: iterations, salt: b64u(salt), iv: b64u(iv), ct: b64u(ct), warning: BACKUP_WARNING };
  const signKey = await crypto.subtle.importKey('jwk', jwk, ECDSA, false, ['sign']);   // the copy that stays: non-extractable
  return { identity: { signKey, pubRaw, fp }, backup };
}

// Restores an identity from a backup file and its passphrase.
export async function restoreIdentity(backup, passphrase) {
  if (!backup || backup.format !== 'bixx-key-backup' || backup.v !== 1) throw new Error('That is not a Bixxville key backup.');
  let jwk;
  try {
    const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: unb64u(backup.iv), additionalData: enc.encode(backup.fp) }, await passKey(passphrase, unb64u(backup.salt), backup.iter), unb64u(backup.ct));
    jwk = JSON.parse(dec.decode(pt));
  } catch (e) { throw new Error('Wrong passphrase, or the backup file is damaged.'); }
  const pubRaw = concat(Uint8Array.of(4), unb64u(jwk.x), unb64u(jwk.y));
  if ((await fingerprintOf(pubRaw)) !== backup.fp) throw new Error('The backup does not match its fingerprint.');
  const signKey = await crypto.subtle.importKey('jwk', jwk, ECDSA, false, ['sign']);
  return { signKey, pubRaw, fp: backup.fp };
}

// A key card is what you show another person so they can trust your key.
export const keyCard = (identity, label = '') => ({ format: 'bixx-key-card', v: 1, fp: identity.fp, pub: hex(identity.pubRaw), label: String(label).slice(0, 40) });
export async function readKeyCard(card) {
  if (!card || card.format !== 'bixx-key-card' || card.v !== 1) throw new Error('That is not a Bixxville key card.');
  const pubRaw = unhex(card.pub);
  if ((await fingerprintOf(pubRaw)) !== card.fp) throw new Error('The key card does not match its own fingerprint.');
  await importPublic(pubRaw);
  return { fp: card.fp, pub: card.pub, label: String(card.label || '').slice(0, 40) };
}

// The keys this device trusts. A record is only accepted from an author listed here.
export class Keyring {
  constructor(store) { this.store = store; this.map = new Map(); this.keys = new Map(); }
  async load() { for (const [fp, e] of await this.store.all('keyring')) this.map.set(fp, e); return this; }
  has(fp) { return this.map.has(fp); }
  get(fp) { return this.map.get(fp); }
  byShort(short) { for (const [fp, e] of this.map) if (fp.startsWith(short)) return e; return null; }
  all() { return [...this.map.values()]; }
  async add({ fp, pub, label = '', role = '', trust = 'trusted' }) {
    const card = await readKeyCard({ format: 'bixx-key-card', v: 1, fp, pub, label });
    const e = { fp, pub, label: card.label, role, trust, addedAt: Date.now() };
    this.map.set(fp, e); await this.store.put('keyring', fp, e); return e;
  }
  async remove(fp) { if (this.map.get(fp)?.trust === 'self') throw new Error('You cannot remove your own key.'); this.map.delete(fp); this.keys.delete(fp); await this.store.del('keyring', fp); }
  async verifyKey(fp) {
    if (!this.keys.has(fp)) { const e = this.map.get(fp); if (!e) return null; this.keys.set(fp, await importPublic(unhex(e.pub))); }
    return this.keys.get(fp);
  }
}
