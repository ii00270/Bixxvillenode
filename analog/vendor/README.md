# vendor

`meshtastic-core-2.6.7.js` is the official Meshtastic JavaScript library, built into one browser file by
`npm run build` in `../vendor-src` (pinned: @meshtastic/core 2.6.7, @meshtastic/transport-web-bluetooth 0.1.5,
@bufbuild/protobuf 2.16.0). Three Node-only imports in the library (`os`, `path`, `util`) are replaced by
the small shims in `../vendor-src/shim`.

**License: GPL-3.0-only** (the Meshtastic JavaScript packages). The file is NOT committed until the
Executive Operator has decided how to handle that (see ANALOG.md, "Decision needed: the Meshtastic license").
Until then the Radio tab says the radio library is not installed, and everything else in Analog works.
The file is loaded only when someone taps "Pair a node"; no other part of Analog imports it.
