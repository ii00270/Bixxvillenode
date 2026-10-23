// Storage behind one small interface so the same code runs in the page (IndexedDB) and in tests (memory).
// Stores: records, meta, keyring, identity, settings.

const NAMES = ['records', 'meta', 'keyring', 'identity', 'settings', 'files'];

export class MemoryStore {
  constructor() { this.d = Object.fromEntries(NAMES.map((n) => [n, new Map()])); }
  async get(s, k) { return this.d[s].get(k); }
  async put(s, k, v) { this.d[s].set(k, v); }
  async del(s, k) { this.d[s].delete(k); }
  async all(s) { return [...this.d[s].entries()]; }
  async clear(s) { this.d[s].clear(); }
}

export class IdbStore {
  constructor(name = 'bixx-analog') {
    this.db = new Promise((res, rej) => {
      const r = indexedDB.open(name, 1);
      r.onupgradeneeded = () => { for (const n of NAMES) r.result.createObjectStore(n); };
      r.onsuccess = () => res(r.result);
      r.onerror = () => rej(r.error);
    });
  }
  async #s(name, mode) { return (await this.db).transaction(name, mode).objectStore(name); }
  #req = (r) => new Promise((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
  async get(s, k) { return this.#req((await this.#s(s, 'readonly')).get(k)); }
  async put(s, k, v) { await this.#req((await this.#s(s, 'readwrite')).put(v, k)); }
  async del(s, k) { await this.#req((await this.#s(s, 'readwrite')).delete(k)); }
  async all(s) {
    const st = await this.#s(s, 'readonly');
    const [keys, vals] = await Promise.all([this.#req(st.getAllKeys()), this.#req((await this.#s(s, 'readonly')).getAll())]);
    return keys.map((k, i) => [k, vals[i]]);
  }
  async clear(s) { await this.#req((await this.#s(s, 'readwrite')).clear()); }
}
