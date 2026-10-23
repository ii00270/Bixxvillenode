const fmt = (_o, ...a) => a.map((x) => (typeof x === 'string' ? x : (() => { try { return JSON.stringify(x); } catch (e) { return String(x); } })())).join(' ');
export const formatWithOptions = fmt;
export const types = { isNativeError: (e) => e instanceof Error, isDate: (d) => d instanceof Date, isRegExp: (r) => r instanceof RegExp, isPromise: (p) => !!p && typeof p.then === 'function', isMap: (m) => m instanceof Map, isSet: (s) => s instanceof Set };
export default { formatWithOptions, types };
