# Analog

Signed records that move with no internet: by QR, by file, between phones on the same Wi-Fi or hotspot, and
(Phase 2) over a LoRa radio mesh. Money, payments and Care data never travel through it.

**Status.** Phase 1 (QR, bundles, share sheet, local-network sync, files) and Phase 2 (radio) are built and tested.
Phase 3 (native wrapper) is research only, below, waiting for approval. Nothing here was run on real radio hardware.

## Where it lives

`analog/src/*.js` are plain ES modules, no build step. `terminal.html` adds an **Analog** item to the side panel
(`setTermView('analog')` → `renderAnalogPanel()`), which imports `analog/src/ui.js` and hands it four helpers
(`openOverlay`, `closeOverlay`, `toast`, `esc`) plus `operator()`. `index.html` and `v2.html` have a different
left bar (`#d-sidebar`) and were not changed; the same panel can be dropped into them with the same four helpers.

| File | What it does |
|---|---|
| `canon.js` | hex/base64url, SHA-256, sorted-key JSON, the one allowed time spelling, gzip, CRC |
| `schema.js` | the allowlist: record types, payload fields, limits. Care and money cannot pass |
| `keys.js` | ECDSA P-256 keys, encrypted backup/restore, key cards, the keyring of trusted keys |
| `record.js` | create / sign / verify a record; the 101-byte compact form |
| `log.js` | the append-only log; merge; verify badges; stamp-order checks |
| `store.js` | IndexedDB storage and an in-memory twin for tests |
| `bundle.js` | `.bixx` export and import |
| `frames.js` | animated multi-frame QR (any bytes, any order, resume) |
| `qr.js` | draw QR; read QR with the camera (BarcodeDetector, else jsQR) |
| `sync.js` | the have/want sync protocol and file transfer, over any message channel |
| `rtc.js` | WebRTC data channel on the local network, offer/answer passed as QR |
| `radio.js` | the radio bridge: rate limit, private-channel gate, comms check, practice node |
| `meshlink.js` | the real Meshtastic node link over Web Bluetooth (official library) |
| `ui.js` | the panel: Status, Send / Receive, Nearby, Radio, Log |

## The record

```
{ v:1, id, type, author, class, ref, ts, prev, payload, sig }
```
* `type`: `stamp` | `update` | `file_manifest` | `ack`. Nothing else is accepted, written, received, exported or sent.
* `class`: only on a stamp: Started, Delivered, Audited, Authorized, Sealed.
* `author`: SHA-256 of the author's public key (64 hex). `ref`: a checkpoint or item id such as `CP3`.
* `ts`: ISO 8601, whole seconds, always the AyeAye offset: `2026-10-23T09:30:00-04:00`. One spelling per instant; anything else is rejected.
* `prev`: the id of the author's previous record (their own hash chain), or null.
* `payload`: small, strict per type (unknown fields are rejected): stamp `{line?, note?≤140}`, update `{text≤280, topic?}`,
  file_manifest `{name, size≤50 MB, sha256, mime?}`, ack `{of: record id, code?}`.
* Records are immutable. A correction is a new record. Nothing is edited or deleted.

**What is signed.** The signature covers the compact form (below). The body hash inside it covers everything else
(version, class, prev, payload), so one 64-byte signature binds the whole record and can be checked from the compact bytes alone.
`id` = SHA-256 of the signed bytes, so a compact message and its full record always agree on the id.

## Compact form (radio): 101 bytes

```
type(1) | author(8) | ref(8) | ts(4) | body hash(16) | signature(64)
```
`type` is one byte that also carries the stamp class. `author` is the first 8 bytes of the key fingerprint, `ref` the first 8 bytes
of SHA-256(ref), `ts` unix seconds, big-endian. Tested: every valid record encodes to 101 bytes (the limit is 200) and decodes to the same id.
It carries hashes and a code, never text. A compact message proves "this author signed a record of this type, for this ref, at this time"; the
full record travels separately (QR, file, local network) and is matched by id.

## Rules a record must pass

Rejected: not an allowed shape · bad or missing signature · changed content · id not matching content · unknown author key ·
timestamp more than 10 minutes in the future · not the canonical time spelling. A record already held is a **duplicate** (never stored twice;
a record that reuses a held id with different content is rejected, not called a duplicate). A record whose `prev` is not held yet is
**pending**; two records after the same `prev` are a **fork**, both kept and flagged; a stamp with an earlier stamp missing or dated out of
order shows a **gap** note. These are worked out from the set of records, never stored, so every device reaches the same picture.

**Merging** two logs is set union of verified records: idempotent, commutative and associative (property tests).

**Keys.** Signing keys are ECDSA P-256 and non-extractable once on the device. Because a non-extractable key cannot be backed up, a new key
is made extractable once, written to a passphrase-encrypted backup (PBKDF2-SHA-256, 250,000 rounds, AES-GCM), then re-imported
non-extractable. The backup exists only from that moment; a key already on a device cannot be exported later, and the panel says so.
A record is accepted only from a key in the keyring. Keys are added by scanning a **key card** in person (fingerprint shown to compare),
with an optional role (payee / auditor / client / operator) that is used to flag a stamp signed by the wrong role.

**States.** Local (this device only) → Relayed (another device or radio node is known to have it) → Anchored. Nothing here can check a
chain, so Anchored is never set by the panel; the code path needs a chain and a confirmed transaction handed in.

## Carriers and the sync protocol

* **QR.** `BXF1.<session>.<i>.<n>.<crc32>.<chunk>`: 400 bytes per frame, loops until every frame has been seen, any order, repeats fine; the
  payload ends in a hash that is checked after joining (gzip when it helps). Frames already seen are kept per session, so a scan carries on.
  More than 40 frames is flagged as better sent as a file; more than 2,000 is refused.
* **File / share sheet.** `.bixx` is JSON `{format, v, created, from, keys[], records[], sig}`. The bundle signature is checked against a sender
  you trust (a trusted sender whose signature fails imports nothing); every record is verified on its own either way. Import reports accepted /
  already had / rejected with a reason, and offers (never silently adds) keys it does not know. Web Share is used for files where the browser has it.
* **Local network.** A WebRTC data channel with no signalling server and no ICE servers. The offer and answer are passed as QR frames. Messages:
  `hello {fp, keys, have[]}` → `want {ids}` → `records {recs}` → `done`. Records are verified on arrival, whoever sent them. A second hello on the
  same link syncs again.
* **Files.** Only for a signed `file_manifest` already in the log: `file-want {sha, offset}` → `file-meta` → 12 KB `chunk`s → `file-end`.
  The whole file is checked against the manifest's SHA-256; a mismatch discards it. Unrequested chunks are ignored. A dropped transfer resumes from the saved offset.
* **Radio.** Section below.

## Radio (Phase 2)

* Pairs by Web Bluetooth with a Meshtastic node using the **official** library (`@meshtastic/core` 2.6.7 and `@meshtastic/transport-web-bluetooth` 0.1.5).
  The Bluetooth UUIDs were taken from the official client-API page, not from memory: service `6ba1b218-15a8-461f-9fa8-5dcae273eafd`,
  toRadio `f75c76d2-129e-4dad-a1dd-7866124401e7`, fromRadio `2c55e69e-4993-11ed-b878-0242ac120002`, fromNum `ed9da18c-a800-4f66-a670-aa7547e34453`.
* Web Bluetooth works on Chrome and Edge on Android and on a computer. **Not on iPhone** (or Safari/Firefox); the panel says so.
* **Private channel only.** The bridge sends nothing until the node reports its primary channel with its own name (not a public preset) and a
  full 256-bit key (not the one-byte default). The panel can set this up: it replaces the node's primary channel and sets the US region
  (902–928 MHz). The key is typed or pasted, or generated and shown once; it is not stored, not logged and not put in a QR code.
* **What goes out:** only the 101-byte compact form, on the private-app port, to the channel, with no reply requested. No text, names, amounts,
  health data or files (tested: the bytes contain none of them). Sends are paced: one every 15 s, 20 in 10 minutes, queue of 20.
* **Incoming** messages are verified like a scanned QR: wrong size, changed, unsigned, far-future or unknown-key messages are dropped and counted;
  a flood past 60 a minute is ignored. A good one is listed as heard; if the full record is held it becomes **Relayed**.
* **Comms check.** Sends a signed ack. Every other node that hears it answers once (answers use a different ref and are never answered, so there is no
  echo storm; one answer per author per minute). The answers shown are the authors heard in the next two minutes.
* **Practice node.** Same interface, no hardware: whatever is sent is heard again a moment later, and "Send test noise" injects four bad messages.
* The **Radio plan** card is plain notes (service, channel, CTCSS/DCS code, repeater, offset, check-in time), editable by the Operator, stored on the
  device. It does not control any radio.

### Decision needed: the Meshtastic license

The Meshtastic JavaScript packages are **GPL-3.0-only**. Distributing them inside a web app generally means the app's own code that links to them
must also be available under the GPL. For that reason the library is **not committed**: `analog/vendor/` holds only a README, `*.js` there is git-ignored,
and nothing in Analog imports it except `meshlink.js`, which loads it only when someone taps "Pair a node". To build it for local testing:
`cd analog/vendor-src && npm install && npm run build`. Options: (1) accept GPL for Analog and publish the library with its source; (2) get advice from a
lawyer first; (3) keep the radio as a separate, optional GPL add-on file; (4) skip the library and talk to the node's protocol directly (a larger piece of work, and
the instruction was to use the official library). Everything except pairing a real node works without it.

## Tests

`cd analog && npm install && npm test` → 51 tests (Node): signing and tampering, unknown keys, replay, future times, key backup, allowlist and
Care/money isolation (written, received, exported, sent), compact encoding (property test), radio rejection, merge properties, out-of-order and forks,
bundles, frames (property test, resume, corruption), sync (hostile peer, unknown keys, files, resume, re-sync), the radio bridge, the pacing, and the
**real Meshtastic library** driven against a fake node (our bytes on the private-app port; incoming bytes back; the channel write). That last test is
skipped if the library has not been built.
`npm run test:browser` → 36 checks in two real Chrome instances (needs Google Chrome): key creation, QR frames drawn and decoded, a **fake camera**
playing the frames while the receiver is **offline**, the key-card trust prompt, WebRTC between the two with the offer/answer passed as pasted frames,
a 70,000-byte file, and the practice radio. `care/tests/isolation.test.mjs` still passes (Analog imports no Care code and names no Care table).

### Manual checklist with the network disabled (two phones)

1. Phone A and B: open the app once online (so it saves itself), then switch both to airplane mode, then turn Wi-Fi back on (or use one phone's hotspot with mobile data off).
2. Each: Analog → Status → create key → save the backup file. A: Show my key card. B: Scan someone's key card, check the fingerprint, trust it. Repeat the other way.
3. A: Log → New record (stamp Delivered, ref CP1). Send / Receive → Show all as QR. B: Scan QR. B's Log shows the record, verified, Relayed.
4. A: Nearby → Start. B: Nearby → Join, scan A's code; B shows its code; A: Scan their answer. Both show Connected and "Both logs are up to date".
5. A: Log → New record → file. B: Nearby → Files → Get. Check the size and open the file.
6. Tamper test: edit a `.bixx` file in a text editor, change one letter of a note, import it on B. It must be rejected.

### Hardware test steps (when a Meshtastic node is available; not done)

1. Two nodes, each flashed with current firmware; Android Chrome. Analog → Radio → Pair a node, choose the node.
2. Enter the same channel name and key on both (type it, do not photograph or QR it); Apply to the node; "Check the node's channel" must say private.
3. Comms check on one phone: the other node's author should appear under "Answered the last check" within a minute or two.
4. Radio code on a record: the other phone lists it under "Heard on the radio"; if it holds the full record the state turns Relayed.
5. Walk out of range and back; confirm sends queue and drain at one per 15 s.

## Limits and assumptions (stated plainly)

* Not tested on real phones, a real Bluetooth stack, or radio hardware. The browser test uses a fake camera and two desktop Chrome instances; the radio test uses a fake node that answers like one.
* Local-network sync needs both phones on one Wi-Fi or hotspot that lets them reach each other. Some hotspots isolate clients and block this; Chrome hides local
  addresses unless the camera permission has been granted, which scanning grants. If it will not connect, use QR or a file.
* Key cards are the trust model: a key is trusted because someone scanned it from the other person's phone. There is no link to the Supabase member account yet.
* Offline clock: records are timestamped by the device clock; a wrong clock is only caught if it is more than 10 minutes fast.
* A record's `ref` is free text within a safe pattern; it is not checked against real checkpoints.
* Files are limited to 50 MB, held whole in memory. Large QR bundles are slow; use a file.
* Anchored is never set by the panel. The Started stamp is accepted but the spec says it moves no money; nothing in Analog moves money.
* The browser key store is only as safe as the device. The non-extractable key cannot be copied out, but anyone using the unlocked device can sign.
* Hedera or any chain is not touched. `escrow`, `test-vectors.json` and payment code are unchanged and not imported.

## Phase 3 research: native wrapper (no code written; waiting for approval)

**Why a wrapper.** A web page cannot act as a Bluetooth device, and iOS Safari has no Web Bluetooth, so true phone-to-phone transfer with no Wi-Fi at all, and any
iPhone radio pairing, need a native app. The native layer would only move bytes: the same log, record format and verify-and-merge code run unchanged inside it
(Capacitor loads the same web app).

**What I checked**
* `@capacitor-community/bluetooth-le`: its own README says it supports only the **central** role, on web, Android and iOS. It cannot advertise or serve, so it cannot be the
  phone-to-phone link on its own. It points to two Cordova plugins for the peripheral role. It could, however, pair an iPhone with a Meshtastic node (the node is the peripheral).
* **Android Nearby Connections** (Google Play services): fully offline peer-to-peer using Bluetooth, BLE and Wi-Fi, automatic upgrade to faster transports; byte payloads up to 32 KB and
  **files of any size**, streams, full duplex. I found no maintained Capacitor plugin for it.
* **iOS:** Google now documents a Nearby Connections SDK for iOS (Swift package `google/nearby`, Xcode 14+, uses BLE, local network and Wi-Fi hotspot; needs Info.plist keys and location
  permission). Its docs do not say whether it interoperates with the Android SDK; that needs a test on two real devices before anyone relies on it. Apple's MultipeerConnectivity does **not**
  interoperate with Android by design.
* Bluetooth is slow (tens of KB/s). Nearby Connections hides that by moving to Wi-Fi when it can.

**Recommendation.**
1. **Android first:** Capacitor shell + a small custom Capacitor plugin (Kotlin) wrapping Nearby Connections, exposing `advertise / discover / connect / sendBytes / sendFile`. It reuses the
   `sync.js` message protocol unchanged (a Nearby channel is just another `{send, onmessage, close}` like the WebRTC one). Effort: roughly 1–2 weeks including permissions and a direct-APK install guide.
2. **iPhone:** two parts. (a) Radio: `bluetooth-le` (central role) talking to the Meshtastic node, same compact records, since the node is the peripheral. Low effort once the Android shell exists.
   (b) Phone-to-phone: try Google's iOS Nearby SDK in a custom plugin and **test it against the Android build first**; if it does not interoperate, fall back to local-network sync (Bonjour plus the
   existing WebRTC path, which already works in iOS Safari) between iPhones and keep iPhone-to-Android on the hotspot/QR paths. Effort: 2–3 weeks with uncertainty on interop.
3. Distribution: Android direct APK (no store); iOS needs an Apple developer account and TestFlight, since there is no direct install.
4. Do not hand-roll a BLE GATT peripheral protocol across both platforms; it would be slow and fragile compared with Nearby Connections.

**Decision needed from you before any build:** approve Android-first with the custom Nearby plugin, and say whether iPhone needs phone-to-phone with no Wi-Fi (the uncertain part) or whether the iPhone radio
pairing plus local-network sync is enough.
