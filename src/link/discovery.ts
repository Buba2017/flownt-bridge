import dgram from 'dgram';
import type { DiscoveredDevice } from '../contract.js';

// Passive LAN discovery of Bambu printers: they announce themselves via SSDP NOTIFY on
// UDP 2021 (broadcast) and 1990 (multicast 239.255.255.250) with serial, model code,
// name and IP. Nothing is sent; the access code is never part of the announcement.
const devices = new Map<string, DiscoveredDevice>();
const MAX_AGE_MS = 10 * 60 * 1000;
let started = false;

function header(text: string, name: string): string | null {
  const m = new RegExp(`^${name.replace(/\./g, '\\.')}:\\s*(.*?)\\r?$`, 'im').exec(text);
  return m ? m[1].trim() : null;
}

function handle(msg: Buffer, rinfo: dgram.RemoteInfo): void {
  const text = msg.toString('utf-8');
  if (!/bambu/i.test(text)) return;
  const serial = header(text, 'USN');
  if (!serial) return;
  const location = header(text, 'Location');
  devices.set(serial, {
    serial,
    model_code: header(text, 'DevModel.bambu.com'),
    name: header(text, 'DevName.bambu.com'),
    ip: location && /^\d+\.\d+\.\d+\.\d+$/.test(location) ? location : rinfo.address,
    vendor: 'bambu',
    seen_at: new Date().toISOString(),
  });
}

export function startDiscovery(): void {
  if (started) return;
  started = true;
  for (const port of [2021, 1990]) {
    const sock = dgram.createSocket({ type: 'udp4', reuseAddr: true });
    sock.on('message', handle);
    sock.on('error', (e) => {
      console.warn(`[discovery] UDP ${port}: ${e.message} — LAN-Erkennung auf diesem Port aus`);
      sock.close();
    });
    sock.bind(port, () => {
      if (port === 1990) {
        try { sock.addMembership('239.255.255.250'); } catch (e) { console.warn('[discovery] multicast:', (e as Error).message); }
      }
    });
  }
  console.log('[discovery] Lausche auf Bambu-Ankündigungen (UDP 2021/1990)');
}

export function discoveredDevices(): DiscoveredDevice[] {
  const now = Date.now();
  for (const [k, d] of devices) if (now - Date.parse(d.seen_at) > MAX_AGE_MS) devices.delete(k);
  return [...devices.values()];
}

export function discoveredIp(serial: string): string | null {
  return devices.get(serial)?.ip ?? null;
}
