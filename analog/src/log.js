// The signed, append-only log.
//
// Records are immutable and held by id. Two logs merge by set union of their verified records, so
// merging is idempotent (A+A = A), commutative (A+B = B+A) and associative ((A+B)+C = A+(B+C)).
// Everything that depends on order (which record is "pending", which stamps have a gap) is worked
// out afterwards from the set, never stored, so every device reaches the same picture from the
// same records. Corrections are new records; nothing is edited or deleted.

import { canonical, parseAye } from './canon.js';
import { createRecord, verifyRecord } from './record.js';
import { STAMP_CLASSES, STAMP_ORDER, STAMP_ROLE } from './schema.js';

const sameContent = (a, b) => { try { if (typeof b.sig !== 'string' || b.sig.length !== 86) return false; const { sig: _a, ...x } = a, { sig: _b, ...y } = b; return canonical(x) === canonical(y); } catch (e) { return false; } };
export const STATES = Object.freeze(['Local', 'Relayed', 'Anchored']);

export class Log {
  constructor(store, keyring) { this.store = store; this.keyring = keyring; this.recs = new Map(); this.meta = new Map(); }

  async load() {
    for (const [id, r] of await this.store.all('records')) this.recs.set(id, r);
    for (const [id, m] of await this.store.all('meta')) this.meta.set(id, m);
    return this;
  }
  get size() { return this.recs.size; }
  has(id) { return this.recs.has(id); }
  get(id) { return this.recs.get(id); }
  ids() { return [...this.recs.keys()]; }

  // Verified records in a fixed order (time, then id), the same on every device that holds the same set.
  snapshot() {
    return [...this.recs.values()].sort((a, b) => parseAye(a.ts) - parseAye(b.ts) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  }

  // status: accepted | duplicate | rejected. `via` is the key fingerprint (or a label) of a node we got it from.
  async add(rec, { via = null, now } = {}) {
    const held = rec && typeof rec.id === 'string' ? this.recs.get(rec.id) : null;
    if (held && sameContent(held, rec)) {
      // The same id and the same content is the same signed record; a second copy changes nothing but who has seen it.
      if (via) await this.markRelayed(rec.id, via);
      return { status: 'duplicate', id: rec.id };
    }   // a record that reuses a held id with different content falls through and is checked (and rejected) like any other
    const v = await verifyRecord(rec, this.keyring, now === undefined ? undefined : { now });
    if (!v.ok) return { status: 'rejected', id: rec?.id ?? null, reason: v.reason };
    this.recs.set(rec.id, rec);
    const m = { state: via ? 'Relayed' : 'Local', via: via ? [via] : [], addedAt: Date.now() };
    this.meta.set(rec.id, m);
    await this.store.put('records', rec.id, rec);
    await this.store.put('meta', rec.id, m);
    return { status: 'accepted', id: rec.id };
  }

  async merge(records, opts = {}) {
    const out = { accepted: [], duplicate: [], rejected: [] };
    for (const r of records) {
      const x = await this.add(r, opts);
      if (x.status === 'accepted') out.accepted.push(x.id);
      else if (x.status === 'duplicate') out.duplicate.push(x.id);
      else out.rejected.push({ id: x.id, reason: x.reason });
    }
    return out;
  }

  // The latest record this author has signed: the one nothing else of theirs points back to.
  tipOf(fp) {
    const mine = [...this.recs.values()].filter((r) => r.author === fp);
    const pointed = new Set(mine.map((r) => r.prev).filter(Boolean));
    const tips = mine.filter((r) => !pointed.has(r.id)).sort((a, b) => parseAye(b.ts) - parseAye(a.ts) || (a.id < b.id ? -1 : 1));
    return tips[0]?.id ?? null;
  }

  async append(identity, draft) {
    const rec = await createRecord(identity, { ...draft, prev: this.tipOf(identity.fp) });
    const x = await this.add(rec);
    if (x.status !== 'accepted') throw new Error('Could not add your own record: ' + (x.reason || x.status));
    return rec;
  }

  async markRelayed(id, nodeId) {
    const m = this.meta.get(id); if (!m) return;
    if (!m.via.includes(nodeId)) m.via.push(nodeId);
    if (m.state === 'Local') m.state = 'Relayed';
    await this.store.put('meta', id, m);
  }
  // Anchored means a real on-chain confirmation exists. Nothing in Analog can check a chain, so the
  // caller has to hand over the chain and the transaction it saw confirmed; the panel never offers this itself.
  async markAnchored(id, { chain, tx }) {
    if (!this.meta.has(id)) throw new Error('No such record.');
    if (typeof chain !== 'string' || typeof tx !== 'string' || !chain || !tx) throw new Error('Anchored needs the chain and the confirmed transaction.');
    const m = this.meta.get(id); m.state = 'Anchored'; m.anchor = { chain, tx };
    await this.store.put('meta', id, m);
  }
  stateOf(id) { return this.meta.get(id)?.state ?? 'Local'; }

  // Per-line stamp picture: which of the four stamps are present, which are missing, and out-of-order times.
  stampsFor(ref) {
    const st = [...this.recs.values()].filter((r) => r.type === 'stamp' && r.ref === ref);
    const by = {}; for (const c of STAMP_CLASSES) by[c] = st.filter((r) => r.class === c).sort((a, b) => (a.id < b.id ? -1 : 1));
    const present = STAMP_ORDER.filter((c) => by[c].length);
    const required = STAMP_ORDER.filter((c) => c !== 'Started');
    const last = Math.max(-1, ...required.map((c, i) => (by[c].length ? i : -1)));
    const missing = required.filter((c, i) => i < last && !by[c].length);       // something later exists but this one does not
    const outOfOrder = [];
    for (let i = 1; i < required.length; i++) {
      const a = by[required[i - 1]][0], b = by[required[i]][0];
      if (a && b && parseAye(b.ts) < parseAye(a.ts)) outOfOrder.push(`${required[i]} is dated before ${required[i - 1]}`);
    }
    return { ref, present, missing, outOfOrder, complete: required.every((c) => by[c].length) };
  }

  // The list the panel shows: each record with a badge (verified / pending / fork / gap) and notes.
  view() {
    const heads = new Map();                       // author|prev -> records, to spot forks
    for (const r of this.recs.values()) { const k = r.author + '|' + (r.prev || ''); (heads.get(k) || heads.set(k, []).get(k)).push(r); }
    const byRef = new Map();
    return this.snapshot().map((r) => {
      const notes = []; let badge = 'verified';
      if ((heads.get(r.author + '|' + (r.prev || '')) || []).length > 1) { badge = 'fork'; notes.push('This author signed two different records after the same one.'); }
      if (r.prev && !this.recs.has(r.prev)) { if (badge === 'verified') badge = 'pending'; notes.push('Waiting for an earlier record from this author.'); }
      if (r.type === 'stamp') {
        if (!byRef.has(r.ref)) byRef.set(r.ref, this.stampsFor(r.ref));
        const s = byRef.get(r.ref);
        if (s.missing.length) { if (badge === 'verified') badge = 'gap'; notes.push(`Missing stamp before this one: ${s.missing.join(', ')}.`); }
        s.outOfOrder.forEach((n) => notes.push(n + '.'));
        const want = STAMP_ROLE[r.class], role = this.keyring.get(r.author)?.role;
        if (want && role && role !== want) notes.push(`${r.class} is meant to be signed by a ${want}; this key is marked ${role}.`);
      }
      return { rec: r, badge, notes, state: this.stateOf(r.id) };
    });
  }
  counts() {
    const c = { Local: 0, Relayed: 0, Anchored: 0 };
    for (const id of this.recs.keys()) c[this.stateOf(id)]++;
    return c;
  }
}
