// What may be written to the log, and nothing else.
//
// Money never travels offline and health data never enters Analog. Both rules live here as an
// allowlist: a record type that is not listed, a field that is not listed, or a value of the wrong
// shape is rejected, whether it is being written, received, exported or put on the radio.

export const TYPES = Object.freeze(['stamp', 'update', 'file_manifest', 'ack']);
export const STAMP_CLASSES = Object.freeze(['Started', 'Delivered', 'Audited', 'Authorized', 'Sealed']);
// The order a line's stamps are expected in. Started is optional.
export const STAMP_ORDER = Object.freeze(['Started', 'Delivered', 'Audited', 'Authorized', 'Sealed']);
export const STAMP_ROLE = Object.freeze({ Delivered: 'payee', Audited: 'auditor', Authorized: 'client', Sealed: 'operator' });

// One byte on the wire says which type (and which stamp class) a record is.
export const TYPE_CODE = Object.freeze({
  'stamp:Started': 0x01, 'stamp:Delivered': 0x02, 'stamp:Audited': 0x03, 'stamp:Authorized': 0x04, 'stamp:Sealed': 0x05,
  update: 0x10, file_manifest: 0x20, ack: 0x30,
});
const CODE_TYPE = Object.fromEntries(Object.entries(TYPE_CODE).map(([k, v]) => [v, k]));
export const typeKey = (type, cls) => (type === 'stamp' ? `stamp:${cls}` : type);
export function typeFromCode(code) {
  const k = CODE_TYPE[code];
  if (!k) throw new SchemaError('unknown record type code');
  return k.startsWith('stamp:') ? { type: 'stamp', class: k.slice(6) } : { type: k, class: null };
}

export class SchemaError extends Error {}

const CTRL = /[\u0000-\u001f\u007f]/;
const HEX64 = /^[0-9a-f]{64}$/;
const REF = /^[A-Za-z0-9][A-Za-z0-9_.:\/-]{0,63}$/;

const str = (v, max, name, { min = 0, multiline = false } = {}) => {
  if (typeof v !== 'string') throw new SchemaError(`${name} must be text`);
  if (v.length < min || v.length > max) throw new SchemaError(`${name} must be ${min ? `${min} to ` : 'up to '}${max} characters`);
  if (multiline ? /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(v) : CTRL.test(v)) throw new SchemaError(`${name} has control characters`);
  return v;
};
const int = (v, lo, hi, name) => {
  if (!Number.isInteger(v) || v < lo || v > hi) throw new SchemaError(`${name} must be a whole number from ${lo} to ${hi}`);
  return v;
};

// Each payload: the only keys allowed, which are required, and how each is checked.
const PAYLOADS = {
  stamp: { keys: { line: (v) => int(v, 0, 1000, 'line'), note: (v) => str(v, 140, 'note') }, required: [] },
  update: { keys: { text: (v) => str(v, 280, 'text', { min: 1, multiline: true }), topic: (v) => str(v, 40, 'topic') }, required: ['text'] },
  file_manifest: {
    keys: {
      name: (v) => str(v, 120, 'name', { min: 1 }),
      size: (v) => int(v, 0, 50 * 1024 * 1024, 'size'),
      sha256: (v) => { if (!HEX64.test(v)) throw new SchemaError('sha256 must be 64 hex characters'); return v; },
      mime: (v) => str(v, 60, 'mime'),
    },
    required: ['name', 'size', 'sha256'],
  },
  ack: { keys: { of: (v) => { if (!HEX64.test(v)) throw new SchemaError('of must be a record id'); return v; }, code: (v) => str(v, 16, 'code') }, required: ['of'] },
};

export function checkPayload(type, payload) {
  const spec = PAYLOADS[type];
  if (!spec) throw new SchemaError(`"${type}" is not a record type Analog carries`);
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) throw new SchemaError('payload must be an object');
  for (const k of Object.keys(payload)) if (!(k in spec.keys)) throw new SchemaError(`payload field "${k}" is not allowed on a ${type}`);
  for (const k of spec.required) if (payload[k] === undefined) throw new SchemaError(`payload needs "${k}"`);
  for (const [k, v] of Object.entries(payload)) spec.keys[k](v);
}

// The fields a record may have at all.
const RECORD_KEYS = new Set(['v', 'id', 'type', 'author', 'class', 'ref', 'ts', 'prev', 'payload', 'sig']);

// Throws SchemaError if the record is not an allowed shape. Does not check signatures.
export function checkShape(rec) {
  if (rec === null || typeof rec !== 'object' || Array.isArray(rec)) throw new SchemaError('record must be an object');
  for (const k of Object.keys(rec)) if (!RECORD_KEYS.has(k)) throw new SchemaError(`record field "${k}" is not allowed`);
  if (rec.v !== 1) throw new SchemaError('unsupported record version');
  if (!TYPES.includes(rec.type)) throw new SchemaError(`"${rec.type}" is not a record type Analog carries`);
  if (rec.type === 'stamp') {
    if (!STAMP_CLASSES.includes(rec.class)) throw new SchemaError('a stamp needs a class: Started, Delivered, Audited, Authorized or Sealed');
  } else if (rec.class != null) throw new SchemaError('only a stamp has a class');
  if (typeof rec.ref !== 'string' || !REF.test(rec.ref)) throw new SchemaError('ref must be a short checkpoint or item id');
  if (typeof rec.author !== 'string' || !HEX64.test(rec.author)) throw new SchemaError('author must be a key fingerprint');
  if (rec.prev != null && !HEX64.test(rec.prev)) throw new SchemaError('prev must be a record id');
  if (typeof rec.id !== 'string' || !HEX64.test(rec.id)) throw new SchemaError('id must be 64 hex characters');
  if (typeof rec.sig !== 'string' || !/^[A-Za-z0-9_-]{86}$/.test(rec.sig)) throw new SchemaError('sig must be a 64-byte signature');
  if (typeof rec.ts !== 'string') throw new SchemaError('ts must be a timestamp');
  checkPayload(rec.type, rec.payload);
  return true;
}

// What goes into a record's signed body for a new record (before it is signed).
export function checkDraft({ type, class: cls, ref, payload }) {
  if (!TYPES.includes(type)) throw new SchemaError(`"${type}" is not a record type Analog carries`);
  if (type === 'stamp' && !STAMP_CLASSES.includes(cls)) throw new SchemaError('a stamp needs a class');
  if (type !== 'stamp' && cls != null) throw new SchemaError('only a stamp has a class');
  if (typeof ref !== 'string' || !REF.test(ref)) throw new SchemaError('ref must be a short checkpoint or item id');
  checkPayload(type, payload ?? {});
}
