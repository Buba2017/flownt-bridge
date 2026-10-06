import net from 'node:net';
import tls from 'node:tls';

// Minimal implicit-FTPS client for Bambu printers (port 990, user bblp).
//
// Newer Bambu firmware (X1C 01.09+, X2D, H2C, …) runs vsftpd with
// require_ssl_reuse: the TLS data connection must resume the control connection's
// session, otherwise it answers "522 SSL connection failed: session reuse required".
// basic-ftp's data connection is not accepted by these printers, so downloads fall back
// to this client, which resumes the session captured from the control connection.
//
// Model quirks handled here:
// - TLS is capped at 1.2 (P2S only accepts 1.2; all others negotiate 1.2 anyway, and
//   session reuse is reliable there).
// - A1 / A1 mini reject the encrypted data channel: if it fails, the transfer is retried
//   once with a plain data channel (PROT C, control channel stays encrypted) and that mode
//   is remembered per printer.
// - Some X2D firmware answers port 990 with garbage after a failed handshake; after a
//   connection-level failure the printer is left alone for a few minutes.

interface Reply { code: number; text: string }

class Control {
  private buf = '';
  private waiters: Array<(r: Reply) => void> = [];
  private replies: Reply[] = [];
  session: Buffer | undefined;

  constructor(readonly socket: tls.TLSSocket) {
    socket.on('session', s => { this.session = s; });
    socket.on('data', d => {
      this.buf += d.toString('utf8');
      let i: number;
      while ((i = this.buf.indexOf('\r\n')) >= 0) {
        const line = this.buf.slice(0, i);
        this.buf = this.buf.slice(i + 2);
        // Final line of a reply: "123 text" (multi-line replies use "123-text").
        if (/^\d{3} /.test(line)) {
          const reply = { code: parseInt(line.slice(0, 3), 10), text: line.slice(4) };
          const w = this.waiters.shift();
          if (w) w(reply); else this.replies.push(reply);
        }
      }
    });
  }

  next(): Promise<Reply> {
    const r = this.replies.shift();
    if (r) return Promise.resolve(r);
    return new Promise(resolve => this.waiters.push(resolve));
  }

  async cmd(line: string, expect: number[]): Promise<Reply> {
    this.socket.write(line + '\r\n');
    const r = await this.next();
    if (!expect.includes(r.code)) throw new Error(`${r.code} ${r.text}`);
    return r;
  }
}

function connect(host: string, port: number, opts: tls.ConnectionOptions): Promise<tls.TLSSocket> {
  return new Promise((resolve, reject) => {
    const s = tls.connect({ host, port, rejectUnauthorized: false, maxVersion: 'TLSv1.2', ...opts }, () => resolve(s));
    s.once('error', reject);
  });
}

function connectPlain(host: string, port: number): Promise<net.Socket> {
  return new Promise((resolve, reject) => {
    const s = net.connect({ host, port }, () => resolve(s));
    s.once('error', reject);
  });
}

const plainDataHosts = new Set<string>();        // printers that need PROT C
const backoffUntil = new Map<string, number>();  // host → no FTPS before this time
const BACKOFF_MS = 5 * 60_000;

/** Error on the data channel (as opposed to an FTP reply such as 550). */
class DataChannelError extends Error {}

async function withSession<T>(host: string, password: string, timeoutMs: number, plainData: boolean,
  fn: (c: Control) => Promise<T>): Promise<T> {
  const until = backoffUntil.get(host);
  if (until && until > Date.now()) throw new Error(`FTPS paused for ${host} after a connection failure`);
  let socket: tls.TLSSocket;
  try {
    socket = await connect(host, 990, {});
  } catch (e) {
    backoffUntil.set(host, Date.now() + BACKOFF_MS);
    throw e;
  }
  const timer = setTimeout(() => socket.destroy(new Error('FTPS timeout')), timeoutMs);
  const c = new Control(socket);
  try {
    const hello = await c.next();
    if (hello.code !== 220) throw new Error(`${hello.code} ${hello.text}`);
    await c.cmd('USER bblp', [331]);
    await c.cmd(`PASS ${password}`, [230]);
    await c.cmd('PBSZ 0', [200]);
    await c.cmd(plainData ? 'PROT C' : 'PROT P', [200]);
    await c.cmd('TYPE I', [200]);
    return await fn(c);
  } finally {
    clearTimeout(timer);
    socket.end('QUIT\r\n');
    socket.destroy();
  }
}

/** Runs one data-channel transfer (RETR/NLST) and returns the received bytes. */
async function transfer(c: Control, host: string, command: string, plainData: boolean): Promise<Buffer> {
  const pasv = await c.cmd('PASV', [227]);
  const m = /\((\d+),(\d+),(\d+),(\d+),(\d+),(\d+)\)/.exec(pasv.text);
  if (!m) throw new Error(`PASV: ${pasv.text}`);
  const port = parseInt(m[5], 10) * 256 + parseInt(m[6], 10);
  c.socket.write(command + '\r\n');
  // The server answers the command first (150, or e.g. 550 if the file does not exist,
  // in which case the data connection is dropped) — so read the reply before the data.
  let dataSocket: net.Socket | undefined;
  const opened = plainData ? connectPlain(host, port) : connect(host, port, { session: c.session ?? c.socket.getSession() });
  const received = opened.then(data => {
    dataSocket = data;
    const chunks: Buffer[] = [];
    return new Promise<Buffer>((resolve, reject) => {
      data.on('data', ch => chunks.push(ch));
      data.on('end', () => resolve(Buffer.concat(chunks)));
      data.on('error', reject);
    });
  }).catch(e => { throw new DataChannelError((e as Error).message); });
  received.catch(() => { /* reported via the control reply */ });
  const start = await c.next();
  if (start.code !== 150 && start.code !== 125) {
    dataSocket?.destroy();
    throw new Error(`${start.code} ${start.text}`);
  }
  const buf = await received;
  const end = await c.next();
  // 522 = the server refused the data channel's TLS (e.g. A1 without PROT C support).
  if (end.code === 522) throw new DataChannelError(`${end.code} ${end.text}`);
  if (end.code !== 226) throw new Error(`${end.code} ${end.text}`);
  return buf;
}

/** Runs a transfer with the printer's data-channel mode, falling back to PROT C once. */
async function run(host: string, password: string, timeoutMs: number, command: string): Promise<Buffer> {
  const plain = plainDataHosts.has(host);
  try {
    return await withSession(host, password, timeoutMs, plain, c => transfer(c, host, command, plain));
  } catch (e) {
    if (plain || !(e instanceof DataChannelError)) throw e;
    const buf = await withSession(host, password, timeoutMs, true, c => transfer(c, host, command, true));
    plainDataHosts.add(host);
    console.log(`[ftps] ${host}: encrypted data channel refused, using PROT C`);
    return buf;
  }
}

export function ftpsDownload(host: string, password: string, path: string, timeoutMs = 60_000): Promise<Buffer> {
  return run(host, password, timeoutMs, `RETR ${path}`);
}

export async function ftpsList(host: string, password: string, dir: string, timeoutMs = 20_000): Promise<string[]> {
  return (await run(host, password, timeoutMs, `NLST ${dir}`)).toString('utf8').split(/\r?\n/).filter(Boolean);
}
