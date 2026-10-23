import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { newNode, trustEachOther } from './_helpers.js';
import { RadioBridge, RateLimiter, PracticeLink, isPrivateChannel, generatePsk, COMMS_REF } from '../src/radio.js';
import { compactEncode, createRecord, COMPACT_BYTES } from '../src/record.js';
import { connectNode, applyPrivateChannel, verifyNodeChannel } from '../src/meshlink.js';
import { enc } from '../src/canon.js';

const until = async (f, ms = 3000) => { const t = Date.now(); while (!f()) { if (Date.now() - t > ms) throw new Error('timed out'); await new Promise((r) => setTimeout(r, 5)); } };
const clock = () => { const c = { t: 1_000_000, now: () => c.t, adv: (ms) => { c.t += ms; } }; return c; };

test('rate limiter: one at a time, and a cap per 10 minutes', () => {
  const c = clock(), l = new RateLimiter({ now: c.now, minGapMs: 15000, maxInWindow: 3, windowMs: 600000 });
  assert.equal(l.take().ok, true);
  assert.deepEqual([l.check().ok, l.check().reason], [false, 'one at a time']);
  c.adv(15000); assert.equal(l.take().ok, true); c.adv(15000); assert.equal(l.take().ok, true);
  c.adv(15000); const r = l.check(); assert.equal(r.ok, false); assert.equal(r.reason, 'too many in 10 minutes'); assert.ok(r.waitMs > 500000);
  c.adv(600000); assert.equal(l.check().ok, true);
});

test('a private channel needs its own name and a full-length, non-trivial key', () => {
  const good = { name: 'bixx-field', psk: generatePsk() };
  assert.equal(isPrivateChannel(good).ok, true);
  for (const bad of [{ name: 'LongFast', psk: generatePsk() }, { name: '', psk: generatePsk() }, { name: 'bixx', psk: Uint8Array.of(1) }, { name: 'bixx', psk: new Uint8Array(32) }, { name: 'bixx', psk: new Uint8Array(16).fill(7) }, { name: ' longfast ', psk: generatePsk() }])
    assert.equal(isPrivateChannel(bad).ok, false, JSON.stringify(bad.name));
});

async function pair() {
  const a = await newNode('a'), b = await newNode('b'); await trustEachOther(a, b);
  const la = new PracticeLink({ delayMs: 1 }), lb = new PracticeLink({ delayMs: 1 });
  // wire the two practice links together as two nodes on one mesh
  la.send = async (bytes) => { la.sentBytes.push(bytes); setTimeout(() => lb.inject(bytes, 'node-a'), 1); };
  lb.send = async (bytes) => { lb.sentBytes.push(bytes); setTimeout(() => la.inject(bytes, 'node-b'), 1); };
  const ev = { a: [], b: [] };
  const ba = new RadioBridge({ log: a.log, keyring: a.keyring, identity: a.identity, link: la, limiter: new RateLimiter({ minGapMs: 0 }), onEvent: (e) => ev.a.push(e), timers: false });
  const bb = new RadioBridge({ log: b.log, keyring: b.keyring, identity: b.identity, link: lb, limiter: new RateLimiter({ minGapMs: 0 }), onEvent: (e) => ev.b.push(e), timers: false });
  return { a, b, la, lb, ba, bb, ev };
}

test('nothing is sent until the channel is verified private', async () => {
  const { a, ba, la } = await pair();
  const rec = await a.log.append(a.identity, { type: 'stamp', class: 'Delivered', ref: 'CP1', payload: {} });
  assert.equal((await ba.send(rec)).ok, false); assert.equal(la.sentBytes.length, 0);
  ba.setChannelOk(true); assert.equal((await ba.send(rec)).ok, true); assert.equal(la.sentBytes.length, 1);
});

test('over the air: only the 101-byte compact form, never text, names, amounts or notes', async () => {
  const { a, ba, la } = await pair(); ba.setChannelOk(true);
  const secret = 'Alice Smith paid 12000 cents for the stock vending job';
  const recs = [
    await a.log.append(a.identity, { type: 'update', ref: 'CP1', payload: { text: secret, topic: 'pay' } }),
    await a.log.append(a.identity, { type: 'stamp', class: 'Sealed', ref: 'CP1', payload: { note: secret } }),
    await a.log.append(a.identity, { type: 'file_manifest', ref: 'CP2', payload: { name: 'blood-test-results.pdf', size: 10, sha256: 'ab'.repeat(32) } }),
  ];
  for (const r of recs) await ba.send(r);
  assert.equal(la.sentBytes.length, 3);
  for (const bytes of la.sentBytes) {
    assert.equal(bytes.length, COMPACT_BYTES);
    const asText = new TextDecoder('latin1').decode(bytes);
    for (const w of ['Alice', 'Smith', 'paid', '12000', 'blood', 'vending', 'CP1', 'pay']) assert.ok(!asText.includes(w), 'leaked ' + w);
  }
  // and a record outside the allowlist cannot be put on the radio at all
  await assert.rejects(() => ba.send({ v: 1, id: 'a'.repeat(64), type: 'care_entry', author: a.identity.fp, class: null, ref: 'X', ts: '2026-10-23T09:00:00-04:00', prev: null, payload: { flow: 'light' }, sig: 'A'.repeat(86) }));
  assert.equal(la.sentBytes.length, 3);
});

test('a heard message is verified, shown, and proves the other node holds the record', async () => {
  const { a, b, ba, bb, ev } = await pair(); ba.setChannelOk(true); bb.setChannelOk(true);
  const rec = await a.log.append(a.identity, { type: 'stamp', class: 'Delivered', ref: 'CP7', payload: {} });
  await b.log.merge([rec]);                       // B already holds the full record (it came by QR earlier)
  await ba.send(rec);
  await until(() => bb.heard.length === 1);
  assert.equal(bb.heard[0].id, rec.id); assert.equal(bb.heard[0].class, 'Delivered'); assert.equal(bb.heard[0].author, a.identity.fp);
  assert.equal(b.log.stateOf(rec.id), 'Relayed');
  assert.ok(ev.b.some((e) => e.kind === 'heard' && e.haveFull === true));
  // heard twice is ignored
  await ba.send(rec); await new Promise((r) => setTimeout(r, 30));
  assert.equal(bb.heard.length, 1); assert.equal(bb.stats.heard, 1);
});

test('unsigned, altered, wrong-size, unknown-key and far-future messages are dropped', async () => {
  const { a, b, ba, bb } = await pair();
  const stranger = await newNode('stranger');
  const rec = await a.log.append(a.identity, { type: 'update', ref: 'CP1', payload: { text: 'hi' } });
  const good = await compactEncode(rec);
  const flipped = good.slice(); flipped[60] ^= 1;
  const tsFlip = good.slice(); tsFlip[20] ^= 4;
  const unknown = await compactEncode(await createRecord(stranger.identity, { type: 'update', ref: 'CP1', payload: { text: 'who' } }));
  const future = await compactEncode(await createRecord(a.identity, { type: 'update', ref: 'CP1', payload: { text: 'later' }, ts: Math.floor(Date.now() / 1000) + 99999 }));
  for (const bad of [flipped, tsFlip, unknown, future, good.subarray(0, 100), new Uint8Array(0), new Uint8Array(101), enc.encode('hello radio')]) await bb.onBytes(bad, { from: 'x' });
  assert.equal(bb.heard.length, 0); assert.equal(bb.stats.rejected, 8);
  await bb.onBytes(good, { from: 'x' }); assert.equal(bb.heard.length, 1);
});

test('the send queue paces itself and drops when full', async () => {
  const a = await newNode('a'); const la = new PracticeLink({ delayMs: 1 }); const c = clock();
  const evs = []; const br = new RadioBridge({ log: a.log, keyring: a.keyring, identity: a.identity, link: la, limiter: new RateLimiter({ now: c.now, minGapMs: 15000, maxQueue: 3 }), onEvent: (e) => evs.push(e), timers: false });
  br.setChannelOk(true);
  const recs = []; for (let i = 0; i < 6; i++) recs.push(await a.log.append(a.identity, { type: 'update', ref: 'CP1', payload: { text: 'n' + i } }));
  for (const r of recs) await br.send(r);
  assert.equal(la.sentBytes.length, 1);                              // the first goes at once, the rest wait
  assert.ok(evs.some((e) => e.kind === 'waiting' && e.waitMs > 14000));
  assert.ok(evs.some((e) => e.kind === 'dropped'));                    // the queue held 3, the rest were refused
  c.adv(15000); await br.pump(); assert.equal(la.sentBytes.length, 2);
  c.adv(15000); await br.pump(); c.adv(15000); await br.pump(); assert.equal(la.sentBytes.length, 4);
});

test('comms check: others answer once, answers are not answered, and we see who answered', async () => {
  const { a, b, ba, bb, ev } = await pair(); ba.setChannelOk(true); bb.setChannelOk(true);
  const r = await ba.commsCheck(); assert.equal(r.ok, true);
  await until(() => ev.a.some((e) => e.kind === 'answer'));
  const ans = ev.a.find((e) => e.kind === 'answer'); assert.equal(ans.author, b.identity.fp); assert.equal(ans.name, 'b');
  await new Promise((r2) => setTimeout(r2, 100));
  assert.equal(bb.stats.sent, 1); assert.equal(ba.stats.sent, 1);       // exactly one check and one answer: no echo storm
  // a second check inside a minute from the same author is not answered again
  await ba.commsCheck(); await new Promise((r2) => setTimeout(r2, 100));
  assert.equal(bb.stats.sent, 1);
});

test('a flood of messages is ignored after the first 60 in a minute', async () => {
  const { a, bb } = await pair();
  const rec = await a.log.append(a.identity, { type: 'update', ref: 'CP1', payload: { text: 'x' } }); const good = await compactEncode(rec);
  for (let i = 0; i < 80; i++) await bb.onBytes(good.subarray(0, 50));
  assert.equal(bb.stats.rejected, 80);
});

// ── the real Meshtastic library, against a fake node (no hardware): checks what we really put on the wire ──
const VENDOR = new URL('../vendor/meshtastic-core-2.6.7.js', import.meta.url);
test('real library: our compact record goes out on the private-app port, and incoming ones come back', { skip: !existsSync(VENDOR) && 'radio library not built (analog/vendor-src: npm run build)', timeout: 30000 }, async () => {
  const lib = await import(VENDOR.href), P = lib.Protobuf;
  const toDevice = []; let push;
  const reply = (v) => push(lib.toBinary(P.Mesh.FromRadioSchema, lib.create(P.Mesh.FromRadioSchema, { payloadVariant: v })));
  const transport = {
    toDevice: new WritableStream({ write(chunk) {
      toDevice.push(chunk);
      const t = lib.fromBinary(P.Mesh.ToRadioSchema, chunk);
      if (t.payloadVariant.case === 'wantConfigId') {            // what a node does when a phone connects
        reply({ case: 'myInfo', value: lib.create(P.Mesh.MyNodeInfoSchema, { myNodeNum: 4242 }) });
        reply({ case: 'channel', value: lib.create(P.Channel.ChannelSchema, { index: 0, role: P.Channel.Channel_Role.PRIMARY, settings: lib.create(P.Channel.ChannelSettingsSchema, { name: 'LongFast', psk: Uint8Array.of(1) }) }) });
        reply({ case: 'configCompleteId', value: t.payloadVariant.value });
      }
      if (t.payloadVariant.case === 'packet' && t.payloadVariant.value.payloadVariant.value.portnum === P.Portnums.PortNum.ADMIN_APP) {   // a node acknowledges what it applies
        reply({ case: 'packet', value: lib.create(P.Mesh.MeshPacketSchema, { from: 4242, to: 4242, id: 7, payloadVariant: { case: 'decoded', value: lib.create(P.Mesh.DataSchema, {
          portnum: P.Portnums.PortNum.ROUTING_APP, requestId: t.payloadVariant.value.id, payload: lib.toBinary(P.Mesh.RoutingSchema, lib.create(P.Mesh.RoutingSchema, { variant: { case: 'errorReason', value: P.Mesh.Routing_Error.NONE } })) }) } }) });
      }
    } }),
    fromDevice: new ReadableStream({ start(ctrl) { push = (data) => ctrl.enqueue({ type: 'packet', data }); } }),
    async disconnect() {},
  };
  const { link, device, channels } = await connectNode(lib, { transport });
  assert.equal(verifyNodeChannel(channels).ok, false, 'a node still on the public default channel is not private');
  const heard = []; link.onBytes((b, m) => heard.push([b, m]));
  const a = await newNode('a');
  const bytes = await compactEncode(await a.log.append(a.identity, { type: 'stamp', class: 'Delivered', ref: 'CP1', payload: {} }));
  await link.send(bytes);
  const sent = toDevice.map((c) => { try { return lib.fromBinary(P.Mesh.ToRadioSchema, c); } catch (e) { return null; } }).filter(Boolean);
  const pkt = sent.find((s) => s.payloadVariant.case === 'packet' && s.payloadVariant.value.payloadVariant.value.portnum === 256);
  assert.ok(pkt, 'a private-app packet was written to the node');
  const mp = pkt.payloadVariant.value;
  assert.deepEqual(new Uint8Array(mp.payloadVariant.value.payload), bytes);
  assert.equal(mp.to, 0xffffffff); assert.equal(mp.channel, 0); assert.equal(mp.wantAck, false);
  // an incoming private-app packet reaches the bridge as bytes
  const incoming = lib.create(P.Mesh.FromRadioSchema, { payloadVariant: { case: 'packet', value: lib.create(P.Mesh.MeshPacketSchema, { from: 1234, to: 0xffffffff, channel: 0, id: 99,
    payloadVariant: { case: 'decoded', value: lib.create(P.Mesh.DataSchema, { portnum: 256, payload: bytes }) } }) } });
  push(lib.toBinary(P.Mesh.FromRadioSchema, incoming));
  await until(() => heard.length === 1);
  assert.deepEqual(new Uint8Array(heard[0][0]), bytes); assert.equal(heard[0][1].from, 1234);
  // a text message (a different port) is not handed to us
  const text = lib.create(P.Mesh.FromRadioSchema, { payloadVariant: { case: 'packet', value: lib.create(P.Mesh.MeshPacketSchema, { from: 5, to: 0xffffffff, channel: 0, id: 100,
    payloadVariant: { case: 'decoded', value: lib.create(P.Mesh.DataSchema, { portnum: 1, payload: enc.encode('hi') }) } }) } });
  push(lib.toBinary(P.Mesh.FromRadioSchema, text)); await new Promise((r) => setTimeout(r, 50));
  assert.equal(heard.length, 1);
  // setting up the private channel writes a primary channel with our name and a 32-byte key, region US, and never the default
  const name = 'bixx-test', psk = generatePsk(); toDevice.length = 0;
  await assert.rejects(() => applyPrivateChannel({ lib, device }, { name: 'LongFast', psk }), /public preset/);
  await assert.rejects(() => applyPrivateChannel({ lib, device }, { name, psk: Uint8Array.of(1) }), /256-bit/);
  await applyPrivateChannel({ lib, device }, { name, psk });
  const admin = toDevice.map((c) => { try { return lib.fromBinary(P.Mesh.ToRadioSchema, c); } catch (e) { return null; } }).filter(Boolean)
    .map((s) => s.payloadVariant.value?.payloadVariant?.value).filter((d) => d && d.portnum === P.Portnums.PortNum.ADMIN_APP)
    .map((d) => lib.fromBinary(P.Admin.AdminMessageSchema, d.payload));
  const ch = admin.find((m) => m.payloadVariant.case === 'setChannel')?.payloadVariant.value;
  assert.ok(ch, 'a setChannel message was sent'); assert.equal(ch.index, 0); assert.equal(ch.role, P.Channel.Channel_Role.PRIMARY);
  assert.equal(ch.settings.name, name); assert.deepEqual(new Uint8Array(ch.settings.psk), psk);
  const cfg = admin.find((m) => m.payloadVariant.case === 'setConfig')?.payloadVariant.value;
  assert.equal(cfg.payloadVariant.value.region, P.Config.Config_LoRaConfig_RegionCode.US);
  // the app checks what the node reports back before it will send
  channels.set(0, ch); assert.equal(verifyNodeChannel(channels).ok, true);
  channels.set(0, { settings: { name: 'LongFast', psk: Uint8Array.of(1) } }); assert.equal(verifyNodeChannel(channels).ok, false);
});
