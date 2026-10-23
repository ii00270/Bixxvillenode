// Sync between two devices over any message channel (a WebRTC data channel on a shared hotspot, or an
// in-memory pair in tests). The channel only moves text; everything it carries is verified here.
//
//   hello  -> who I am, the keys I know, and the ids I have
//   want   -> the ids I am missing (computed from your hello)
//   records-> the records you asked for (each re-verified on arrival, never trusted because of the sender)
//   done   -> I have sent everything you asked for
//
// Files travel separately and only for a SIGNED file_manifest already in the log: the receiver asks for a
// hash it holds a manifest for, in chunks from an offset, and checks the SHA-256 of the whole file on arrival.

import { b64u, concat, hex, sha256, unb64u } from './canon.js';
import { fingerprintOf } from './keys.js';
import { createRecord } from './record.js';
import { unhex } from './canon.js';

export const MAX_HAVE = 20000;
const BATCH = 30;
export const FILE_CHUNK = 12 * 1024;
const HEX64 = /^[0-9a-f]{64}$/;

export class MemoryFileStore {
  constructor() { this.m = new Map(); }
  async get(sha) { return this.m.get(sha) || null; }
  async put(sha, v) { this.m.set(sha, v); }
  async del(sha) { this.m.delete(sha); }
}
export class StoreFiles {            // the same interface over the IndexedDB/memory store's "files" table
  constructor(store) { this.store = store; }
  get(sha) { return this.store.get('files', sha).then((v) => v || null); }
  put(sha, v) { return this.store.put('files', sha, v); }
  del(sha) { return this.store.del('files', sha); }
}

// Adds a file to this device and signs a manifest for it. `file` is { name, mime, bytes }.
export async function publishFile({ log, identity, files, ref }, file) {
  const bytes = file.bytes instanceof Uint8Array ? file.bytes : new Uint8Array(file.bytes);
  const sha = hex(await sha256(bytes));
  await files.put(sha, { name: file.name, size: bytes.length, mime: file.mime || '', bytes });
  return log.append(identity, { type: 'file_manifest', ref, payload: { name: file.name, size: bytes.length, sha256: sha, ...(file.mime ? { mime: file.mime } : {}) } });
}

export class Peer {
  // channel: { send(text) -> void|Promise, close(), onmessage, onclose }  (set by attach)
  constructor({ log, identity, files = new MemoryFileStore(), onEvent = () => {} }) {
    Object.assign(this, { log, identity, files, onEvent });
    this.remote = null; this.sentDone = false; this.gotDone = false; this.incoming = new Map(); this.closed = false; this.busy = Promise.resolve();
  }
  attach(channel) {
    this.ch = channel;
    channel.onmessage = (text) => { this.busy = this.busy.then(() => this.#handle(text)).catch((e) => this.onEvent({ kind: 'error', message: e.message })); };
    channel.onclose = () => { this.closed = true; this.#savePartials(); this.onEvent({ kind: 'closed' }); };
    return this;
  }
  async #send(obj) { await this.ch.send(JSON.stringify(obj)); }
  keysToShare() { return this.log.keyring.all().map((e) => ({ fp: e.fp, pub: e.pub, label: e.label || '' })); }

  async start() {
    const have = this.log.ids().slice(0, MAX_HAVE);
    await this.#send({ t: 'hello', v: 1, fp: this.identity.fp, keys: this.keysToShare(), have });
  }

  async #handle(text) {
    let m; try { m = JSON.parse(text); } catch (e) { return this.onEvent({ kind: 'ignored', reason: 'not JSON' }); }
    if (!m || typeof m.t !== 'string') return;
    switch (m.t) {
      case 'hello': return this.#onHello(m);
      case 'want': return this.#onWant(m);
      case 'records': return this.#onRecords(m);
      case 'done': this.gotDone = true; return this.#maybeComplete();
      case 'file-want': return this.#onFileWant(m);
      case 'file-meta': return this.#onFileMeta(m);
      case 'chunk': return this.#onChunk(m);
      case 'file-end': return this.#onFileEnd(m);
      case 'file-none': this.incoming.delete(m.sha); return this.onEvent({ kind: 'file-failed', sha: m.sha, reason: 'The other device does not have that file.' });
      default: return this.onEvent({ kind: 'ignored', reason: 'unknown message ' + String(m.t).slice(0, 20) });
    }
  }

  async #onHello(m) {
    if (this.remote && m.fp !== this.remote.fp) return;      // one peer per link; the same peer may say hello again to sync again
    this.sentDone = false; this.gotDone = false;
    if (m.v !== 1 || typeof m.fp !== 'string' || !HEX64.test(m.fp) || !Array.isArray(m.have) || m.have.length > MAX_HAVE) { this.onEvent({ kind: 'error', message: 'The other device sent an invalid hello.' }); return this.ch.close(); }
    const unknownKeys = [];
    for (const k of Array.isArray(m.keys) ? m.keys.slice(0, 500) : []) {
      if (!k || typeof k.fp !== 'string' || typeof k.pub !== 'string' || this.log.keyring.has(k.fp)) continue;
      try { if ((await fingerprintOf(unhex(k.pub))) === k.fp) unknownKeys.push({ fp: k.fp, pub: k.pub, label: String(k.label || '').slice(0, 40) }); } catch (e) { /* skip */ }
    }
    const trusted = this.log.keyring.has(m.fp);
    this.remote = { fp: m.fp, trusted, have: new Set(m.have.filter((x) => HEX64.test(x))) };
    this.onEvent({ kind: 'hello', fp: m.fp, trusted, unknownKeys, theyHave: this.remote.have.size, weHave: this.log.size });
    // What they have that we are missing.
    const want = [...this.remote.have].filter((id) => !this.log.has(id));
    // What they already have of ours counts as relayed (only believed from a key we trust).
    if (trusted) for (const id of this.log.ids()) if (this.remote.have.has(id)) await this.log.markRelayed(id, m.fp);
    await this.#send({ t: 'want', ids: want.slice(0, MAX_HAVE) });
  }

  async #onWant(m) {
    if (!this.remote || !Array.isArray(m.ids)) return;
    const recs = m.ids.filter((id) => HEX64.test(id)).map((id) => this.log.get(id)).filter(Boolean);
    for (let i = 0; i < recs.length; i += BATCH) await this.#send({ t: 'records', recs: recs.slice(i, i + BATCH) });
    await this.#send({ t: 'done', sent: recs.length });
    this.sentDone = true; this.onEvent({ kind: 'sent', n: recs.length });
    this.#maybeComplete();
  }

  async #onRecords(m) {
    if (!this.remote || !Array.isArray(m.recs)) return;
    // Anything the other device sends is verified like any import. Where it came from earns it nothing.
    const r = await this.log.merge(m.recs.slice(0, BATCH * 2), { via: this.remote.trusted ? this.remote.fp : 'unverified-peer' });
    this.onEvent({ kind: 'received', accepted: r.accepted.length, duplicate: r.duplicate.length, rejected: r.rejected });
  }
  #maybeComplete() { if (this.sentDone && this.gotDone) this.onEvent({ kind: 'complete' }); }

  // ── files ──
  manifestFor(sha) { return this.log.snapshot().find((r) => r.type === 'file_manifest' && r.payload.sha256 === sha) || null; }
  async have(sha) { const f = await this.files.get(sha); return !!(f && f.bytes); }

  async requestFile(sha) {
    const man = this.manifestFor(sha);
    if (!man) throw new Error('There is no signed manifest for that file, so it will not be requested.');
    if (await this.have(sha)) return { already: true };
    const part = (await this.files.get(sha))?.partial || new Uint8Array(0);
    this.incoming.set(sha, { size: man.payload.size, name: man.payload.name, chunks: part.length ? [part] : [], got: part.length });
    await this.#send({ t: 'file-want', sha, offset: part.length });
    this.onEvent({ kind: 'file-start', sha, name: man.payload.name, size: man.payload.size, resumedAt: part.length });
    return { requested: true };
  }
  async #onFileWant(m) {
    if (!this.remote || !HEX64.test(m.sha || '')) return;
    const f = await this.files.get(m.sha);
    if (!f?.bytes) return this.#send({ t: 'file-none', sha: m.sha });
    const off = Number.isInteger(m.offset) && m.offset >= 0 && m.offset <= f.bytes.length ? m.offset : 0;
    await this.#send({ t: 'file-meta', sha: m.sha, size: f.bytes.length, offset: off });
    for (let o = off; o < f.bytes.length; o += FILE_CHUNK) {
      if (this.closed) return;
      await this.#send({ t: 'chunk', sha: m.sha, off: o, d: b64u(f.bytes.subarray(o, o + FILE_CHUNK)) });
    }
    await this.#send({ t: 'file-end', sha: m.sha });
  }
  #onFileMeta(m) {
    const inc = this.incoming.get(m.sha); if (!inc) return;                    // never asked for it: ignore
    if (m.size !== inc.size) { this.incoming.delete(m.sha); return this.onEvent({ kind: 'file-failed', sha: m.sha, reason: 'The file is not the size the signed manifest says.' }); }
    if (m.offset !== inc.got) { inc.chunks = []; inc.got = 0; if (m.offset !== 0) { this.incoming.delete(m.sha); return this.onEvent({ kind: 'file-failed', sha: m.sha, reason: 'The other device could not resume.' }); } }
  }
  #onChunk(m) {
    const inc = this.incoming.get(m.sha); if (!inc) return;
    if (m.off !== inc.got) return;                                            // out of place: ignore (resume will refetch)
    let part; try { part = unb64u(m.d); } catch (e) { return; }
    if (inc.got + part.length > inc.size) { this.incoming.delete(m.sha); return this.onEvent({ kind: 'file-failed', sha: m.sha, reason: 'More data than the manifest allows.' }); }
    inc.chunks.push(part); inc.got += part.length;
    this.onEvent({ kind: 'file-progress', sha: m.sha, got: inc.got, size: inc.size });
  }
  async #onFileEnd(m) {
    const inc = this.incoming.get(m.sha); if (!inc) return;
    const bytes = concat(...inc.chunks);
    if (bytes.length !== inc.size || hex(await sha256(bytes)) !== m.sha) {
      this.incoming.delete(m.sha); await this.files.del(m.sha);
      return this.onEvent({ kind: 'file-failed', sha: m.sha, reason: 'The file did not match its signed hash, so it was discarded.' });
    }
    await this.files.put(m.sha, { name: inc.name, size: inc.size, mime: '', bytes });
    this.incoming.delete(m.sha);
    this.onEvent({ kind: 'file-done', sha: m.sha, name: inc.name, size: inc.size });
  }
  async #savePartials() {
    for (const [sha, inc] of this.incoming) if (inc.got) await this.files.put(sha, { name: inc.name, size: inc.size, partial: concat(...inc.chunks) });
  }
}

// Two connected in-memory channels, for tests and for the Nearby tab's self-check.
export function memoryChannels({ dropAfter = Infinity } = {}) {
  const mk = () => ({ onmessage: null, onclose: null, closed: false });
  const a = mk(), b = mk(); let sent = 0;
  const wire = (from, to) => { from.send = async (t) => { if (from.closed) return; if (++sent > dropAfter) { a.close(); b.close(); return; } queueMicrotask(() => { if (!to.closed) to.onmessage?.(t); }); }; };
  const close = (c) => () => { if (c.closed) return; a.closed = b.closed = true; queueMicrotask(() => { a.onclose?.(); b.onclose?.(); }); };
  wire(a, b); wire(b, a); a.close = close(a); b.close = close(b);
  return [a, b];
}
