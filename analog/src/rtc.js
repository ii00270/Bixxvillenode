// Local-network sync over a WebRTC data channel with NO signalling server and no internet.
// The two devices must be on the same Wi-Fi or hotspot. The offer and answer (a few hundred bytes of
// connection details) are carried between them by QR frames, so nothing but the two phones is involved.
// No ICE servers are configured: only addresses on the local network are used.

import { dec, enc, gunzip, gzip, b64u, unb64u } from './canon.js';

export const rtcAvailable = () => typeof RTCPeerConnection !== 'undefined';

function wrap(dc) {
  const ch = {
    onmessage: null, onclose: null,
    async send(t) { while (dc.bufferedAmount > 1 << 20) await new Promise((r) => setTimeout(r, 20)); if (dc.readyState === 'open') dc.send(t); },
    close() { try { dc.close(); } catch (e) { /* already closed */ } },
  };
  dc.onmessage = (e) => ch.onmessage?.(typeof e.data === 'string' ? e.data : dec.decode(e.data));
  dc.onclose = () => ch.onclose?.();
  return ch;
}
function gathered(pc, ms) {
  return new Promise((res) => {
    if (pc.iceGatheringState === 'complete') return res();
    const done = () => { pc.removeEventListener('icegatheringstatechange', on); clearTimeout(t); res(); };
    const on = () => { if (pc.iceGatheringState === 'complete') done(); };
    const t = setTimeout(done, ms);
    pc.addEventListener('icegatheringstatechange', on);
  });
}
const pack = async (o) => { const raw = enc.encode(JSON.stringify(o)); const z = await gzip(raw); return z && z.length < raw.length ? { z: true, bytes: z } : { z: false, bytes: raw }; };

// Device A: makes the offer. Returns the bytes to show as QR frames, and a promise for the open channel.
export async function createOffer({ gatherMs = 4000 } = {}) {
  if (!rtcAvailable()) throw new Error('Local-network sync is not available in this browser.');
  const pc = new RTCPeerConnection({ iceServers: [] });
  const dc = pc.createDataChannel('bixx', { ordered: true });
  const ready = new Promise((res, rej) => {
    dc.onopen = () => res(wrap(dc));
    pc.onconnectionstatechange = () => { if (pc.connectionState === 'failed') rej(new Error('The two devices could not connect. Are they on the same Wi-Fi or hotspot?')); };
  });
  ready.catch(() => {});
  await pc.setLocalDescription(await pc.createOffer());
  await gathered(pc, gatherMs);
  return { pc, ready, payload: await pack({ t: 'offer', sdp: pc.localDescription.sdp }) };
}
// Device B: reads A's offer and makes the answer.
export async function acceptOffer(bytes, { gatherMs = 4000 } = {}) {
  if (!rtcAvailable()) throw new Error('Local-network sync is not available in this browser.');
  const o = JSON.parse(dec.decode(bytes));
  if (o.t !== 'offer' || typeof o.sdp !== 'string') throw new Error('That is not a connection offer.');
  const pc = new RTCPeerConnection({ iceServers: [] });
  const ready = new Promise((res, rej) => {
    pc.ondatachannel = (e) => { if (e.channel.readyState === 'open') res(wrap(e.channel)); else e.channel.onopen = () => res(wrap(e.channel)); };
    pc.onconnectionstatechange = () => { if (pc.connectionState === 'failed') rej(new Error('The two devices could not connect. Are they on the same Wi-Fi or hotspot?')); };
  });
  ready.catch(() => {});
  await pc.setRemoteDescription({ type: 'offer', sdp: o.sdp });
  await pc.setLocalDescription(await pc.createAnswer());
  await gathered(pc, gatherMs);
  return { pc, ready, payload: await pack({ t: 'answer', sdp: pc.localDescription.sdp }) };
}
export async function acceptAnswer(session, bytes) {
  const o = JSON.parse(dec.decode(bytes));
  if (o.t !== 'answer' || typeof o.sdp !== 'string') throw new Error('That is not a connection answer.');
  await session.pc.setRemoteDescription({ type: 'answer', sdp: o.sdp });
}
// QR frames carry raw bytes; a leading flag byte says whether they are gzip.
export const toBytes = (p) => { const out = new Uint8Array(p.bytes.length + 1); out[0] = p.z ? 1 : 0; out.set(p.bytes, 1); return out; };
export const fromBytes = async (b) => (b[0] === 1 ? gunzip(b.subarray(1)) : b.subarray(1));
