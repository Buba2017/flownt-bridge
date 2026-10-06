import net from 'node:net';
import { Aedes } from 'aedes';

// In-process MQTT broker standing in for a printer: the test publishes report frames
// and sees what the adapter sends on the request topic.
export interface TestBroker {
  url: string;
  /** Requests the adapter published (parsed JSON), in order. */
  requests: any[];
  publishReport(serial: string, payload: unknown): Promise<void>;
  /** Drops all client connections (simulates a WiFi drop / printer reboot). */
  dropClients(): void;
  clientCount(): number;
  close(): Promise<void>;
}

export async function startBroker(): Promise<TestBroker> {
  const broker = await Aedes.createBroker();
  const server = net.createServer(broker.handle);
  const sockets = new Set<net.Socket>();
  server.on('connection', s => { sockets.add(s); s.on('close', () => sockets.delete(s)); });
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as net.AddressInfo).port;
  const requests: any[] = [];
  broker.on('publish', (packet, client) => {
    if (!client || !packet.topic.endsWith('/request')) return;
    try { requests.push(JSON.parse(packet.payload.toString())); } catch { /* ignore */ }
  });
  return {
    url: `mqtt://127.0.0.1:${port}`,
    requests,
    publishReport: (serial, payload) => new Promise<void>((resolve, reject) => {
      broker.publish({
        cmd: 'publish', topic: `device/${serial}/report`, qos: 0, dup: false, retain: false,
        payload: Buffer.from(typeof payload === 'string' ? payload : JSON.stringify(payload)),
      }, err => (err ? reject(err) : resolve()));
    }),
    dropClients: () => { for (const s of sockets) s.destroy(); },
    clientCount: () => sockets.size,
    close: async () => {
      for (const s of sockets) s.destroy();
      await new Promise<void>(r => broker.close(() => r()));
      await new Promise<void>(r => server.close(() => r()));
    },
  };
}

/** Polls until `fn` returns truthy (or throws after `ms`). */
export async function waitFor<T>(fn: () => T | Promise<T>, ms = 3_000, what = 'condition'): Promise<T> {
  const until = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > until) throw new Error(`timed out waiting for ${what}`);
    await new Promise(r => setTimeout(r, 20));
  }
}
