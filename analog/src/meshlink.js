// The real link: a Meshtastic node over Web Bluetooth, using the OFFICIAL Meshtastic JavaScript library
// (@meshtastic/core + @meshtastic/transport-web-bluetooth, GPL-3.0-only), loaded only when someone pairs a node.
//
// The Bluetooth service and characteristic UUIDs below are from the official Meshtastic client-API page
// (meshtastic.org/docs/development/device/client-api/); the transport package uses the same ones:
//   service  6ba1b218-15a8-461f-9fa8-5dcae273eafd
//   toRadio  f75c76d2-129e-4dad-a1dd-7866124401e7  (write)
//   fromRadio 2c55e69e-4993-11ed-b878-0242ac120002 (read until empty)
//   fromNum  ed9da18c-a800-4f66-a670-aa7547e34453  (notify: a packet is waiting)

import { isPrivateChannel } from './radio.js';

export const MESH_SERVICE_UUID = '6ba1b218-15a8-461f-9fa8-5dcae273eafd';
export const MESH_LIB_URL = new URL('../vendor/meshtastic-core-2.6.7.js', import.meta.url).href;
export const webBluetoothAvailable = () => typeof navigator !== 'undefined' && !!navigator.bluetooth;

export async function loadMeshLibrary(url = MESH_LIB_URL) {
  try { return await import(/* @vite-ignore */ url); }
  catch (e) { throw new Error('The radio library is not installed on this copy of the app (see analog/vendor/README.md).'); }
}

// Connects to a node and returns { link, device, lib, channels }. `transport` is only passed in tests.
export async function connectNode(lib, { transport, onStatus = () => {} } = {}) {
  if (!transport) {
    if (!webBluetoothAvailable()) throw new Error('Web Bluetooth is not available in this browser. It works in Chrome or Edge on Android and on a computer, not on iPhone.');
    transport = await lib.TransportWebBluetooth.create();      // asks the person to pick the node
  }
  const device = new lib.MeshDevice(transport);
  const channels = new Map();
  device.events.onChannelPacket.subscribe((c) => channels.set(c.index, c));
  device.events.onDeviceStatus.subscribe((s) => onStatus(s));
  const cbs = [];
  device.events.onPrivatePacket.subscribe((p) => cbs.forEach((cb) => cb(p.data, { from: p.from })));
  // The library resolves a send only when the node reports an acknowledgement. A broadcast with no
  // acknowledgement requested never gets one (the library gives up after 60 s), so a send is finished
  // when the packet has been written to the node, and that late timeout is ignored.
  const link = {
    onBytes: (cb) => cbs.push(cb),
    async send(bytes) {
      device.sendPacket(bytes, lib.Protobuf.Portnums.PortNum.PRIVATE_APP, 'broadcast', 0, false, false).catch(() => {});
      const t0 = Date.now();
      while (device.queue.getState().some((i) => !i.sent)) { if (Date.now() - t0 > 8000) throw new Error('the node did not take the message'); await new Promise((r) => setTimeout(r, 25)); }
    },
    close: () => device.disconnect(),
  };
  // configure() only resolves on an acknowledgement too, so wait for the node to say it is configured instead.
  const DEVICE_CONFIGURED = 7;
  const ready = new Promise((res, rej) => {
    const t = setTimeout(() => rej(new Error('The node did not finish starting up. Is it a Meshtastic node, switched on and close by?')), 25000);
    device.events.onDeviceStatus.subscribe((s) => { if (s === DEVICE_CONFIGURED) { clearTimeout(t); res(); } });
  });
  device.configure().catch(() => {});
  await ready;
  return { link, device, lib, channels };
}

// Makes our private channel the node's primary channel and sets the US region. The key is passed in,
// handed to the node and not kept or logged by the app.
export async function applyPrivateChannel({ lib, device }, { name, psk }) {
  const ok = isPrivateChannel({ name, psk }); if (!ok.ok) throw new Error(ok.reason);
  const { create, Protobuf: P } = lib;
  await device.setConfig(create(P.Config.ConfigSchema, { payloadVariant: { case: 'lora', value: create(P.Config.Config_LoRaConfigSchema, {
    region: P.Config.Config_LoRaConfig_RegionCode.US, usePreset: true, modemPreset: P.Config.Config_LoRaConfig_ModemPreset.LONG_FAST, txEnabled: true, hopLimit: 3 }) } }));
  await device.setChannel(create(P.Channel.ChannelSchema, { index: 0, role: P.Channel.Channel_Role.PRIMARY,
    settings: create(P.Channel.ChannelSettingsSchema, { name, psk, uplinkEnabled: false, downlinkEnabled: false }) }));
  return true;
}
// Reads back what the node actually has on its primary channel and says whether it is private.
export function verifyNodeChannel(channels) {
  const c = channels.get(0);
  if (!c || !c.settings) return { ok: false, reason: 'The node has not reported its channel yet.' };
  return isPrivateChannel({ name: c.settings.name, psk: c.settings.psk });
}
