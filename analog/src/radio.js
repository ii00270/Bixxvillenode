// Radio: compact signed records over a LoRa mesh. The radio is PUBLIC AIR, so only the 101-byte compact form
// ever goes out: a type, the author's short id, hashes of the ref and the body, a time and a signature.
// Never names, amounts, health data, secrets or file contents. What comes in is checked exactly like a
// scanned QR: unsigned, altered, wrong-size or unknown-key messages are dropped.
//
// This file knows nothing about Bluetooth or any radio library. It talks to a `link`:
//   link = { send(bytes) -> Promise, onBytes(cb(bytes, meta)), close() }
// so the same code runs against a real node (meshlink.js) or the practice node below.

import { COMPACT_BYTES, compactEncode, createRecord, refHash, verifyCompact } from './record.js';
import { hex, nowSec } from './canon.js';

export const COMMS_REF = 'COMMS';            // a comms check
export const COMMS_REPLY_REF = 'COMMSR';     // an answer to one (answers are never answered, so there is no echo storm)
const ZERO_ID = '0'.repeat(64);

export class RateLimiter {
  // Gentle on purpose: the radio's own airtime rules apply on top. 15 s apart, 20 in any 10 minutes, a short queue.
  constructor({ minGapMs = 15000, windowMs = 600000, maxInWindow = 20, maxQueue = 20, now = () => Date.now() } = {}) {
    Object.assign(this, { minGapMs, windowMs, maxInWindow, maxQueue, now, sent: [] });
  }
  check() {
    const t = this.now();
    this.sent = this.sent.filter((x) => t - x < this.windowMs);
    const gap = this.sent.length ? this.minGapMs - (t - this.sent[this.sent.length - 1]) : 0;
    const win = this.sent.length >= this.maxInWindow ? this.windowMs - (t - this.sent[0]) : 0;
    const wait = Math.max(gap, win, 0);
    return wait > 0 ? { ok: false, waitMs: wait, reason: win > gap ? 'too many in 10 minutes' : 'one at a time' } : { ok: true, waitMs: 0 };
  }
  take() { const c = this.check(); if (c.ok) this.sent.push(this.now()); return c; }
}

export class RadioBridge {
  constructor({ log, keyring, identity, link, limiter = new RateLimiter(), onEvent = () => {}, now = () => nowSec(), timers = true, autoAnswer = true }) {
    Object.assign(this, { log, keyring, identity, link, limiter, onEvent, now, timers, autoAnswer });
    this.queue = []; this.heard = []; this.seen = new Set(); this.timer = 0; this.channelOk = false; this.answered = new Map(); this.inbound = []; this.checks = [];
    this.stats = { sent: 0, queued: 0, dropped: 0, heard: 0, rejected: 0 };
    link.onBytes((bytes, meta) => this.onBytes(bytes, meta));
  }
  // The bridge refuses to send until the node's channel has been verified as private (see isPrivateChannel).
  setChannelOk(ok) { this.channelOk = !!ok; }

  async send(rec) {
    if (!this.channelOk) { this.stats.dropped++; this.onEvent({ kind: 'blocked', reason: 'The node is not on a verified private channel, so nothing is sent.' }); return { ok: false, reason: 'no private channel' }; }
    const bytes = await compactEncode(rec);            // throws if the record is not an allowed shape
    if (this.queue.length >= this.limiter.maxQueue) { this.stats.dropped++; this.onEvent({ kind: 'dropped', reason: 'The send queue is full.' }); return { ok: false, reason: 'queue full' }; }
    this.queue.push({ bytes, id: rec.id }); this.stats.queued++;
    this.onEvent({ kind: 'queued', id: rec.id, ahead: this.queue.length - 1 });
    this.pump();
    return { ok: true, queued: this.queue.length };
  }
  // Sends whatever the rate limit allows now; if something is still waiting, comes back when it can.
  async pump() {
    clearTimeout(this.timer);
    while (this.queue.length) {
      const c = this.limiter.check();
      if (!c.ok) { if (this.timers) this.timer = setTimeout(() => this.pump(), c.waitMs + 20); this.onEvent({ kind: 'waiting', waitMs: c.waitMs, reason: c.reason, left: this.queue.length }); return; }
      this.limiter.take();
      const item = this.queue.shift();
      try { await this.link.send(item.bytes); this.stats.sent++; this.onEvent({ kind: 'sent', id: item.id }); }
      catch (e) { this.stats.dropped++; this.onEvent({ kind: 'error', message: 'The node did not accept the message: ' + e.message }); }
    }
  }

  async commsCheck() {
    const rec = await this.log.append(this.identity, { type: 'ack', ref: COMMS_REF, payload: { of: ZERO_ID, code: 'CHECK' } });
    this.checks.push({ id: rec.id, at: Date.now(), answers: new Map() });
    this.checks = this.checks.slice(-5);
    const r = await this.send(rec);
    return { ...r, id: rec.id };
  }

  async onBytes(bytes, meta = {}) {
    const t = Date.now();
    this.inbound = this.inbound.filter((x) => t - x < 60000); this.inbound.push(t);
    if (this.inbound.length > 60) { this.stats.rejected++; return; }                 // a flood: ignore the rest of this minute
    if (!(bytes instanceof Uint8Array) || bytes.length !== COMPACT_BYTES) { this.stats.rejected++; this.onEvent({ kind: 'rejected', reason: 'not a Bixxville message' }); return; }
    const v = await verifyCompact(bytes, this.keyring, { now: this.now() });
    if (!v.ok) { this.stats.rejected++; this.onEvent({ kind: 'rejected', reason: v.reason }); return; }
    const b = v.beacon;
    if (this.seen.has(b.id)) return;                                                 // heard before (or relayed twice): ignore
    this.seen.add(b.id); if (this.seen.size > 1000) this.seen.delete(this.seen.values().next().value);
    this.stats.heard++;
    const entry = { id: b.id, type: b.type, class: b.class, author: b.author, ts: b.ts, refHash: b.refHash, bodyHash: b.bodyHash, heardAt: Date.now(), from: meta.from ?? null, mine: b.author === this.identity.fp };
    this.heard.unshift(entry); this.heard = this.heard.slice(0, 100);
    // If we already hold the full record, this is proof another node has it.
    if (this.log.has(b.id)) await this.log.markRelayed(b.id, 'radio:' + b.author.slice(0, 8));
    this.onEvent({ kind: 'heard', entry, haveFull: this.log.has(b.id) });
    await this.#commsLogic(b, entry);
  }

  async #commsLogic(b, entry) {
    if (b.author === this.identity.fp || b.type !== 'ack') return;
    const rh = hex(await refHash(COMMS_REF)), rr = hex(await refHash(COMMS_REPLY_REF));
    if (b.refHash === rr) {                                                           // an answer: credit it to a check of ours still waiting
      const chk = this.checks.find((c) => Date.now() - c.at < 120000);
      if (chk && !chk.answers.has(b.author)) { chk.answers.set(b.author, entry); this.onEvent({ kind: 'answer', author: b.author, name: this.keyring.get(b.author)?.label || b.author.slice(0, 8), at: entry.ts }); }
    } else if (b.refHash === rh && this.autoAnswer && this.channelOk) {               // someone's check: answer it, at most once a minute per author
      const last = this.answered.get(b.author) || 0;
      if (Date.now() - last < 60000) return;
      this.answered.set(b.author, Date.now());
      const rec = await this.log.append(this.identity, { type: 'ack', ref: COMMS_REPLY_REF, payload: { of: b.id, code: 'HERE' } });
      await this.send(rec);
    }
  }
  close() { clearTimeout(this.timer); this.link.close?.(); }
}

// "Private" means: a channel name that is not one of Meshtastic's public presets, and a full-length (256-bit) key,
// not the one-byte default. Anything else is treated as public air and the bridge will not send.
const PUBLIC_NAMES = new Set(['', 'longfast', 'longslow', 'longmoderate', 'longturbo', 'mediumfast', 'mediumslow', 'shortfast', 'shortslow', 'shortturbo', 'default']);
export function isPrivateChannel({ name, psk }) {
  if (typeof name !== 'string' || PUBLIC_NAMES.has(name.trim().toLowerCase())) return { ok: false, reason: 'The channel name is a public preset. Choose your own name.' };
  if (!(psk instanceof Uint8Array) || psk.length !== 32) return { ok: false, reason: 'The channel needs its own 256-bit key (the default key is public).' };
  if (psk.every((b) => b === psk[0])) return { ok: false, reason: 'That key is too simple.' };
  return { ok: true };
}
export const generatePsk = () => crypto.getRandomValues(new Uint8Array(32));

// ── the practice node: no hardware, same interface ──
// Anything sent is heard again a moment later, as if another node on the mesh had repeated it, so the
// panel can be tried end to end. `noise()` injects the kinds of message a real mesh can deliver.
export class PracticeLink {
  constructor({ delayMs = 200 } = {}) { this.delayMs = delayMs; this.cbs = []; this.sentBytes = []; }
  onBytes(cb) { this.cbs.push(cb); }
  async send(bytes) { this.sentBytes.push(bytes); setTimeout(() => this.cbs.forEach((cb) => cb(bytes, { from: 'practice node' })), this.delayMs); }
  inject(bytes, from = 'practice node') { this.cbs.forEach((cb) => cb(bytes, { from })); }
  close() {}
}
