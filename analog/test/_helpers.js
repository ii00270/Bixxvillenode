import { createIdentity, Keyring, keyCard } from '../src/keys.js';
import { MemoryStore } from '../src/store.js';
import { Log } from '../src/log.js';

// A fast identity for tests (few PBKDF2 rounds; the real default is 250000).
export async function newNode(label = 'node', trust = []) {
  const { identity, backup } = await createIdentity('test-passphrase', { iterations: 1000 });
  const store = new MemoryStore();
  const keyring = new Keyring(store);
  await keyring.add({ fp: identity.fp, pub: keyCard(identity).pub, label, trust: 'self' });
  const log = new Log(store, keyring);
  return { identity, backup, store, keyring, log, label };
}
export async function trustEachOther(...nodes) {
  for (const a of nodes) for (const b of nodes) if (a !== b) await a.keyring.add({ fp: b.identity.fp, pub: keyCard(b.identity).pub, label: b.label });
}
