// Animated multi-frame QR: any bytes, split into frames that can be scanned in any order, any number
// of times. Each frame carries its place (i of n), a checksum of its own bytes, and the whole payload
// ends with a hash, so a bad scan, a missing frame or a mixed-up session is caught instead of used.
//
//   BXF1.<session>.<i>.<n>.<crc32>.<chunk>      (chunk is base64url)
//
// There is no back-channel: the sender loops the frames and the receiver keeps what it has, so the
// receiver just keeps pointing the camera until every frame has been seen. Frames already seen are kept
// per session, so a scan that was interrupted carries on where it stopped.

import { b64u, concat, crc32, gunzip, gzip, hex, sha256, unb64u } from './canon.js';

export const FRAME_PREFIX = 'BXF1';
export const MAX_FRAMES = 2000;
export const DEFAULT_CHUNK = 400;   // bytes per frame; keeps each QR scannable on a phone

export async function encodeFrames(bytes, { chunk = DEFAULT_CHUNK, compress = true, sid } = {}) {
  let flag = 0, data = bytes;
  if (compress) { const z = await gzip(bytes); if (z && z.length < bytes.length) { flag = 1; data = z; } }
  const body = concat(Uint8Array.of(flag), data);
  const payload = concat(body, (await sha256(body)).subarray(0, 8));
  const n = Math.max(1, Math.ceil(payload.length / chunk));
  if (n > MAX_FRAMES) throw new Error('That is too much to send as QR frames. Use a bundle file instead.');
  sid = sid || hex(crypto.getRandomValues(new Uint8Array(3)));
  return Array.from({ length: n }, (_, i) => {
    const part = payload.subarray(i * chunk, (i + 1) * chunk);
    return `${FRAME_PREFIX}.${sid}.${i}.${n}.${crc32(part).toString(16).padStart(8, '0')}.${b64u(part)}`;
  });
}

export function parseFrame(text) {
  const p = String(text).trim().split('.');
  if (p.length !== 6 || p[0] !== FRAME_PREFIX) throw new Error('not a Bixxville frame');
  const [, sid, i, n, crc, data] = p;
  if (!/^[0-9a-f]{6}$/.test(sid) || !/^\d{1,4}$/.test(i) || !/^\d{1,4}$/.test(n) || !/^[0-9a-f]{8}$/.test(crc)) throw new Error('bad frame header');
  const idx = +i, total = +n;
  if (total < 1 || total > MAX_FRAMES || idx >= total) throw new Error('bad frame number');
  const part = unb64u(data);
  if (crc32(part).toString(16).padStart(8, '0') !== crc) throw new Error('frame is corrupted, scan it again');
  return { sid, idx, total, part };
}

export class FrameAssembler {
  constructor() { this.sessions = new Map(); this.current = null; }
  // Returns { ok, reason?, sid, have, total, done }.
  add(text) {
    let f; try { f = parseFrame(text); } catch (e) { return { ok: false, reason: e.message }; }
    let s = this.sessions.get(f.sid);
    if (!s) { s = { sid: f.sid, total: f.total, parts: new Map() }; this.sessions.set(f.sid, s); }
    if (s.total !== f.total) return { ok: false, reason: 'frame does not belong to this session' };
    const had = s.parts.has(f.idx);
    if (!had) s.parts.set(f.idx, f.part);
    this.current = s.sid;
    return { ok: true, sid: s.sid, had, have: s.parts.size, total: s.total, done: s.parts.size === s.total };
  }
  progress(sid = this.current) { const s = this.sessions.get(sid); return s ? { sid, have: s.parts.size, total: s.total, missing: [...Array(s.total).keys()].filter((i) => !s.parts.has(i)) } : null; }
  // Joins the frames, checks the whole-payload hash, unpacks. Throws if anything is off.
  async result(sid = this.current) {
    const s = this.sessions.get(sid);
    if (!s || s.parts.size !== s.total) throw new Error('Not every frame has been scanned yet.');
    const payload = concat(...[...Array(s.total).keys()].map((i) => s.parts.get(i)));
    if (payload.length < 9) throw new Error('The scan is too short to be valid.');
    const body = payload.subarray(0, -8), tail = payload.subarray(-8);
    const h = (await sha256(body)).subarray(0, 8);
    if (!h.every((v, i) => v === tail[i])) { this.sessions.delete(sid); throw new Error('The scanned frames do not add up (a frame was misread). Start the scan again.'); }
    const out = body[0] === 1 ? await gunzip(body.subarray(1)) : body.subarray(1);
    this.sessions.delete(sid);
    return out;
  }
  reset() { this.sessions.clear(); this.current = null; }
}
