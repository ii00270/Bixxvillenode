// Byte, hex, base64url, hashing and timestamp helpers shared by every Analog module.
// Nothing here touches the network or the page, so the same code runs in Node tests.

export const enc = new TextEncoder();
export const dec = new TextDecoder();

export const hex = (u8) => Array.from(u8, (b) => b.toString(16).padStart(2, '0')).join('');
export function unhex(s) {
  if (typeof s !== 'string' || s.length % 2 || !/^[0-9a-f]*$/i.test(s)) throw new Error('bad hex');
  const out = new Uint8Array(s.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(s.substr(i * 2, 2), 16);
  return out;
}

export function b64u(u8) {
  let s = '';
  for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode(...u8.subarray(i, i + 0x8000));
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
export function unb64u(s) {
  if (typeof s !== 'string' || !/^[A-Za-z0-9_-]*$/.test(s)) throw new Error('bad base64url');
  const p = s.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (s.length % 4)) % 4);
  const bin = atob(p);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export const concat = (...parts) => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
};
export const eq = (a, b) => a.length === b.length && a.every((v, i) => v === b[i]);

export async function sha256(u8) {
  return new Uint8Array(await crypto.subtle.digest('SHA-256', u8));
}

// JSON with sorted keys and no whitespace: the same value always gives the same bytes.
export function canonical(v) {
  if (v === null) return 'null';
  const t = typeof v;
  if (t === 'string' || t === 'boolean') return JSON.stringify(v);
  if (t === 'number') {
    if (!Number.isFinite(v)) throw new Error('canonical: number is not finite');
    return JSON.stringify(v);
  }
  if (Array.isArray(v)) return '[' + v.map(canonical).join(',') + ']';
  if (t === 'object') {
    const keys = Object.keys(v).filter((k) => v[k] !== undefined).sort();
    return '{' + keys.map((k) => JSON.stringify(k) + ':' + canonical(v[k])).join(',') + '}';
  }
  throw new Error('canonical: unsupported value');
}

// ── timestamps ──
// Every record time is ISO 8601 at second precision with the AyeAye offset (-04:00), nothing else.
// One spelling per instant means the signature covers exactly one string.
export const AYE_OFFSET = '-04:00';
const AYE_SECONDS = -4 * 3600;
const TS_RE = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})-04:00$/;

export function fmtAye(epochSec) {
  const d = new Date((epochSec + AYE_SECONDS) * 1000);
  const p = (n, w = 2) => String(n).padStart(w, '0');
  return `${p(d.getUTCFullYear(), 4)}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())}T${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())}${AYE_OFFSET}`;
}
export function parseAye(str) {
  const m = TS_RE.exec(String(str));
  if (!m) throw new Error('timestamp must look like 2026-10-23T09:30:00-04:00');
  const sec = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]) / 1000 - AYE_SECONDS;
  if (!Number.isInteger(sec) || sec < 0 || sec > 0xffffffff || fmtAye(sec) !== str) throw new Error('not a real date and time');
  return sec;
}
export const nowSec = () => Math.floor(Date.now() / 1000);

// ── gzip, where the platform has it ──
export async function gzip(u8) {
  if (typeof CompressionStream === 'undefined') return null;
  const s = new Blob([u8]).stream().pipeThrough(new CompressionStream('gzip'));
  return new Uint8Array(await new Response(s).arrayBuffer());
}
export async function gunzip(u8) {
  if (typeof DecompressionStream === 'undefined') throw new Error('This browser cannot unpack compressed data.');
  const s = new Blob([u8]).stream().pipeThrough(new DecompressionStream('gzip'));
  return new Uint8Array(await new Response(s).arrayBuffer());
}

export function crc32(u8) {
  let c, crc = 0xffffffff;
  for (let i = 0; i < u8.length; i++) {
    c = (crc ^ u8[i]) & 0xff;
    for (let k = 0; k < 8; k++) c = c & 1 ? (c >>> 1) ^ 0xedb88320 : c >>> 1;
    crc = (crc >>> 8) ^ c;
  }
  return (crc ^ 0xffffffff) >>> 0;
}
