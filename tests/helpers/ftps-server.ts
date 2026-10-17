import { readFileSync } from 'node:fs';
import net from 'node:net';
import { join } from 'node:path';
import tls from 'node:tls';

// A small implicit-FTPS server (vsftpd-like replies) standing in for a printer's SD card.
// `fault` makes a transfer misbehave the way flaky printers do.

const TLS_DIR = join(import.meta.dirname, '..', 'fixtures', 'tls');
const creds = { key: readFileSync(join(TLS_DIR, 'test-key.pem')), cert: readFileSync(join(TLS_DIR, 'test-cert.pem')) };

export type Fault =
  | 'stall'        // send half the data, then nothing (connection stays open)
  | 'no226'        // send the data, then drop the control connection instead of 226
  | '426'          // send the data, then "426 transfer aborted"
  | 'noGreeting';  // accept the connection but never say 220

export interface FakeFtps {
  port: number;
  commands: string[];
  /** Fault for the n-th RETR (0-based) — or for all when set to a function returning one. */
  fault: (retrIndex: number, path: string) => Fault | undefined;
  close(): Promise<void>;
}

const listLine = (name: string, size: number, dir = false) =>
  `${dir ? 'd' : '-'}rw-r--r--    1 0        0        ${String(size).padStart(8)} Oct 06 12:00 ${name}`;

export async function startFakeFtps(files: Record<string, Buffer>): Promise<FakeFtps> {
  const commands: string[] = [];
  const sockets = new Set<net.Socket>();
  const servers = new Set<net.Server>();
  let retrCount = 0;
  const api: FakeFtps = { port: 0, commands, fault: () => undefined, close: async () => {} };

  const listing = (dir: string) => {
    const prefix = dir.endsWith('/') ? dir : `${dir}/`;
    const names = new Map<string, { size: number; dir: boolean }>();
    for (const [path, buf] of Object.entries(files)) {
      if (!path.startsWith(prefix)) continue;
      const rest = path.slice(prefix.length).split('/');
      names.set(rest[0], rest.length > 1 ? { size: 0, dir: true } : { size: buf.length, dir: false });
    }
    if (!names.size && dir !== '/') return null;
    return [...names].map(([n, e]) => listLine(n, e.size, e.dir)).join('\r\n') + '\r\n';
  };

  const control = tls.createServer(creds, sock => {
    sockets.add(sock);
    sock.on('close', () => sockets.delete(sock));
    sock.on('error', () => {});
    if (api.fault(-1, '') === 'noGreeting') return;
    const say = (l: string) => { if (!sock.destroyed) sock.write(l + '\r\n'); };
    let dataSock: Promise<tls.TLSSocket> | null = null;
    say('220 (vsFTPd 3.0.3)');
    let buf = '';
    sock.on('data', async d => {
      buf += d.toString();
      let i: number;
      while ((i = buf.indexOf('\r\n')) >= 0) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 2);
        commands.push(line);
        const [cmd, ...rest] = line.split(' ');
        const arg = rest.join(' ');
        switch (cmd) {
          case 'USER': say('331 Please specify the password.'); break;
          case 'PASS': say(arg === 'code' ? '230 Login successful.' : '530 Login incorrect.'); break;
          case 'PBSZ': case 'PROT': case 'TYPE': say('200 OK'); break;
          case 'SIZE': files[arg] ? say(`213 ${files[arg].length}`) : say('550 Could not get file size.'); break;
          case 'QUIT': say('221 Goodbye.'); break;
          case 'PASV': {
            const data = tls.createServer(creds);
            servers.add(data);
            dataSock = new Promise(resolve => data.once('secureConnection', s => {
              sockets.add(s); s.on('error', () => {}); s.on('close', () => sockets.delete(s)); resolve(s);
            }));
            await new Promise<void>(r => data.listen(0, '127.0.0.1', r));
            const p = (data.address() as net.AddressInfo).port;
            say(`227 Entering Passive Mode (127,0,0,1,${p >> 8},${p & 255}).`);
            break;
          }
          case 'RETR': case 'LIST': case 'NLST': {
            const pending = dataSock;
            dataSock = null;
            let payload: Buffer | null;
            let fault: Fault | undefined;
            if (cmd === 'RETR') {
              payload = files[arg] ?? null;
              if (payload) fault = api.fault(retrCount++, arg);
            } else {
              const l = listing(arg || '/');
              payload = l == null ? null : Buffer.from(cmd === 'NLST' ? l.split('\r\n').filter(Boolean).map(x => x.split(' ').pop()).join('\r\n') : l);
            }
            if (!payload || !pending) { say('550 Failed to open file.'); break; }
            say('150 Opening BINARY mode data connection.');
            const ds = await pending;
            if (fault === 'stall') { ds.write(payload.subarray(0, Math.floor(payload.length / 2))); break; }
            ds.end(payload);
            await new Promise(r => ds.once('close', r));
            if (fault === 'no226') { sock.destroy(); break; }
            say(fault === '426' ? '426 Failure writing network stream.' : '226 Transfer complete.');
            break;
          }
          default: say('502 Command not implemented.');
        }
      }
    });
  });
  servers.add(control);
  await new Promise<void>(r => control.listen(0, '127.0.0.1', r));
  api.port = (control.address() as net.AddressInfo).port;
  api.close = async () => {
    for (const s of sockets) s.destroy();
    await Promise.all([...servers].map(s => new Promise(r => s.close(() => r(null)))));
  };
  return api;
}
