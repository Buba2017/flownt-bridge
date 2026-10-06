import net from 'node:net';
import tls from 'node:tls';

// Minimal implicit-FTPS client for Bambu printers (port 990, user bblp).
//
// Newer Bambu firmware (X1C 01.09+, X2D, H2C, …) runs vsftpd with
// require_ssl_reuse: the TLS data connection must resume the control connection's
// session, otherwise it answers "522 SSL connection failed: session reuse required".
// basic-ftp's data connection is not accepted by these printers (also for LIST), so all
// FTPS traffic goes through this client, which resumes the session captured from the
// control connection.
//
// Model quirks handled here:
// - TLS is capped at 1.2 (P2S only accepts 1.2; all others negotiate 1.2 anyway, and
//   session reuse is reliable there).
// - A1 / A1 mini reject the encrypted data channel: if it fails, the transfer is retried
//   once with a plain data channel (PROT C, control channel stays encrypted) and that mode
//   is remembered per printer.
// - Some X2D firmware answers port 990 with garbage after a failed handshake; after a
//   connection-level failure the printer is left alone for a few minutes.
//
// Nothing here may hang: one deadline covers connect, login and the transfer (scaled
// with the file size), every wait for a reply or for data has an inactivity timeout, and
// on any failure both sockets are destroyed and all pending waits are rejected.

interface Reply { code: number; text: string }

export interface FtpsOptions {
  port?: number;
  /** Deadline for connect + login + a listing; downloads add size / bytesPerSec. */
  baseTimeoutMs?: number;
  /** Assumed minimum transfer rate for the download deadline. */
  bytesPerSec?: number;
  /** No byte / reply for this long = dead connection. */
  inactivityMs?: number;
  /** Extra attempts after a transient failure (timeout, reset, 426, missing 226). */
  retries?: number;
  retryDelayMs?: number;
}

const DEFAULTS: Required<FtpsOptions> = {
  port: 990,
  baseTimeoutMs: 30_000,
  bytesPerSec: 50_000,
  inactivityMs: 30_000,
  retries: 2,
  retryDelayMs: 2_000,
};

/** FTP error. `permanent`: retrying cannot help (file missing, login refused). */
export class FtpsError extends Error {
  constructor(message: string, readonly code?: number, readonly permanent = false) {
    super(message);
  }
}

/** Error on the data channel's TLS (as opposed to an FTP reply such as 550). */
class DataChannelError extends FtpsError {}

/** The TCP/TLS connection to port 990 could not be established. */
class ConnectError extends FtpsError {}

const replyError = (r: Reply) => new FtpsError(`${r.code} ${r.text}`, r.code, r.code === 550 || r.code === 530);

class Control {
  private buf = '';
  private waiters: Array<{ resolve: (r: Reply) => void; reject: (e: Error) => void }> = [];
  private replies: Reply[] = [];
  private failure: Error | null = null;
  session: Buffer | undefined;

  constructor(readonly socket: tls.TLSSocket, private readonly inactivityMs: number) {
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
          if (w) w.resolve(reply); else this.replies.push(reply);
        }
      }
    });
    socket.on('error', e => this.fail(e));
    socket.on('close', () => this.fail(new FtpsError('FTPS control connection closed')));
  }

  /** Rejects every pending and future wait (connection gone or deadline hit). */
  fail(e: Error): void {
    if (this.failure) return;
    this.failure = e;
    for (const w of this.waiters.splice(0)) w.reject(e);
  }

  next(): Promise<Reply> {
    const r = this.replies.shift();
    if (r) return Promise.resolve(r);
    if (this.failure) return Promise.reject(this.failure);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const e = new FtpsError(`FTPS: no reply for ${Math.round(this.inactivityMs / 1000)}s`);
        this.fail(e);
        this.socket.destroy();
      }, this.inactivityMs);
      this.waiters.push({
        resolve: v => { clearTimeout(timer); resolve(v); },
        reject: e => { clearTimeout(timer); reject(e); },
      });
    });
  }

  async cmd(line: string, expect: number[]): Promise<Reply> {
    this.socket.write(line + '\r\n');
    const r = await this.next();
    if (!expect.includes(r.code)) throw replyError(r);
    return r;
  }
}

/** Resolves once connected; rejects on error or if the socket closes first. */
function opened<T extends net.Socket>(s: T, event: 'secureConnect' | 'connect'): Promise<T> {
  return new Promise((resolve, reject) => {
    const onError = (e: Error) => { cleanup(); reject(e); };
    const onClose = () => { cleanup(); reject(new Error('connection closed')); };
    const onOpen = () => { cleanup(); resolve(s); };
    const cleanup = () => { s.off('error', onError); s.off('close', onClose); s.off(event, onOpen); };
    s.once('error', onError);
    s.once('close', onClose);
    s.once(event, onOpen);
  });
}

const plainDataHosts = new Set<string>();        // printers that need PROT C
const backoffUntil = new Map<string, number>();  // host → no FTPS before this time
const BACKOFF_MS = 5 * 60_000;

/** Resets per-host state (tests). */
export function resetFtpsState(): void {
  plainDataHosts.clear();
  backoffUntil.clear();
}

export interface DirEntry { name: string; isDir: boolean; size: number | null }

/** One logged-in FTPS session. Several transfers can run in it, one after another. */
export class FtpsSession {
  constructor(
    private readonly c: Control,
    private readonly host: string,
    private readonly plainData: boolean,
    private readonly o: Required<FtpsOptions>,
    private readonly track: (s: net.Socket) => void,
    readonly setDeadline: (ms: number) => void,
  ) {}

  /** File size via SIZE, null if the server does not tell. A missing file throws 550. */
  async size(path: string): Promise<number | null> {
    this.c.socket.write(`SIZE ${path}\r\n`);
    const r = await this.c.next();
    if (r.code === 213) {
      const n = parseInt(r.text.trim(), 10);
      return Number.isFinite(n) ? n : null;
    }
    if (r.code === 550) throw replyError(r);
    return null;
  }

  /** Downloads a file; the session deadline is extended by its size. */
  async retr(path: string): Promise<Buffer> {
    const size = await this.size(path);
    this.setDeadline(this.o.baseTimeoutMs + ((size ?? 0) / this.o.bytesPerSec) * 1000);
    const buf = await this.transfer(`RETR ${path}`);
    if (size != null && buf.length !== size) throw new FtpsError(`FTPS: got ${buf.length} of ${size} bytes`);
    return buf;
  }

  async nlst(dir: string): Promise<string[]> {
    return (await this.transfer(`NLST ${dir}`)).toString('utf8').split(/\r?\n/).filter(Boolean);
  }

  /** Directory listing (unix LIST format as sent by vsftpd). */
  async list(dir: string): Promise<DirEntry[]> {
    const text = (await this.transfer(`LIST ${dir}`)).toString('utf8');
    return parseList(text);
  }

  /** Runs one data-channel transfer (RETR/NLST/LIST) and returns the received bytes. */
  private async transfer(command: string): Promise<Buffer> {
    const c = this.c;
    const pasv = await c.cmd('PASV', [227]);
    const m = /\((\d+),(\d+),(\d+),(\d+),(\d+),(\d+)\)/.exec(pasv.text);
    if (!m) throw new FtpsError(`PASV: ${pasv.text}`);
    const port = parseInt(m[5], 10) * 256 + parseInt(m[6], 10);
    c.socket.write(command + '\r\n');
    // The server answers the command first (150, or e.g. 550 if the file does not exist,
    // in which case the data connection is dropped) — so read the reply before the data.
    const data = this.plainData
      ? net.connect({ host: this.host, port })
      : tls.connect({ host: this.host, port, rejectUnauthorized: false, maxVersion: 'TLSv1.2', session: c.session ?? c.socket.getSession() });
    this.track(data);
    data.setTimeout(this.o.inactivityMs, () => data.destroy(new FtpsError(`FTPS: data stalled for ${Math.round(this.o.inactivityMs / 1000)}s`)));
    const received = opened(data, this.plainData ? 'connect' : 'secureConnect')
      .catch(e => { throw new DataChannelError((e as Error).message); })
      .then(() => new Promise<Buffer>((resolve, reject) => {
        const chunks: Buffer[] = [];
        let ended = false;
        data.on('data', ch => chunks.push(ch));
        data.on('end', () => { ended = true; resolve(Buffer.concat(chunks)); });
        data.on('error', reject);
        data.on('close', () => { if (!ended) reject(new FtpsError('FTPS: data connection closed early')); });
      }));
    received.catch(() => { /* reported via the control reply or awaited below */ });
    const start = await c.next();
    if (start.code !== 150 && start.code !== 125) {
      data.destroy();
      throw replyError(start);
    }
    const buf = await received;
    const end = await c.next();
    // 522 = the server refused the data channel's TLS (e.g. A1 without PROT C support).
    if (end.code === 522) throw new DataChannelError(`${end.code} ${end.text}`, end.code);
    // 426 = transfer aborted; anything but 226 means the data may be incomplete.
    if (end.code !== 226) throw new FtpsError(`${end.code} ${end.text}`, end.code);
    return buf;
  }
}

/** Parses vsftpd LIST output ("-rw-r--r-- 1 0 0 1234 Oct 06 12:00 name"). */
export function parseList(text: string): DirEntry[] {
  const out: DirEntry[] = [];
  for (const line of text.split(/\r?\n/)) {
    const m = /^([dl-])[rwxsStT-]{9}\S*\s+\d+\s+\S+\s+\S+\s+(\d+)\s+\w{3}\s+\d{1,2}\s+(?:\d{1,2}:\d{2}|\d{4})\s+(.+)$/.exec(line);
    if (!m) continue;
    const name = m[1] === 'l' ? m[3].split(' -> ')[0] : m[3];
    if (name === '.' || name === '..') continue;
    out.push({ name, isDir: m[1] === 'd', size: m[1] === '-' ? parseInt(m[2], 10) : null });
  }
  return out;
}

async function openSession<T>(host: string, password: string, o: Required<FtpsOptions>, plainData: boolean,
  fn: (s: FtpsSession) => Promise<T>): Promise<T> {
  const until = backoffUntil.get(host);
  if (until && until > Date.now()) throw new FtpsError(`FTPS paused for ${host} after a connection failure`);
  const sockets = new Set<net.Socket>();
  const track = (s: net.Socket) => { sockets.add(s); s.on('error', () => { /* handled by the waiters */ }); };
  let control: Control | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let rejectDeadline!: (e: Error) => void;
  const deadline = new Promise<never>((_, reject) => { rejectDeadline = reject; });
  deadline.catch(() => { /* raced below */ });
  const setDeadline = (ms: number) => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      const e = new FtpsError(`FTPS timeout after ${Math.round(ms / 1000)}s`);
      control?.fail(e);
      for (const s of sockets) s.destroy();
      rejectDeadline(e);
    }, ms);
  };
  setDeadline(o.baseTimeoutMs);

  const work = (async () => {
    const socket = tls.connect({ host, port: o.port, rejectUnauthorized: false, maxVersion: 'TLSv1.2' });
    track(socket);
    try {
      await opened(socket, 'secureConnect');
    } catch (e) {
      backoffUntil.set(host, Date.now() + BACKOFF_MS);
      throw new ConnectError((e as Error).message);
    }
    const c = control = new Control(socket, o.inactivityMs);
    const hello = await c.next();
    if (hello.code !== 220) throw replyError(hello);
    await c.cmd('USER bblp', [331]);
    await c.cmd(`PASS ${password}`, [230]);
    await c.cmd('PBSZ 0', [200]);
    await c.cmd(plainData ? 'PROT C' : 'PROT P', [200]);
    await c.cmd('TYPE I', [200]);
    return fn(new FtpsSession(c, host, plainData, o, track, setDeadline));
  })();
  work.catch(() => { /* raced below */ });
  try {
    return await Promise.race([work, deadline]);
  } finally {
    if (timer) clearTimeout(timer);
    const ctl = [...sockets][0];
    if (ctl && !ctl.destroyed) { try { ctl.write('QUIT\r\n'); } catch { /* ignore */ } }
    for (const s of sockets) s.destroy();
  }
}

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

/**
 * Runs `fn` in a session with the printer's data-channel mode (falling back to PROT C
 * once), retrying transient failures with backoff. Missing files (550), a refused login
 * and connection failures are not retried.
 */
export async function withFtps<T>(host: string, password: string, fn: (s: FtpsSession) => Promise<T>, opts: FtpsOptions = {}): Promise<T> {
  const o = { ...DEFAULTS, ...opts };
  for (let attempt = 0; ; attempt++) {
    const plain = plainDataHosts.has(host);
    try {
      try {
        return await openSession(host, password, o, plain, fn);
      } catch (e) {
        if (plain || !(e instanceof DataChannelError)) throw e;
        const r = await openSession(host, password, o, true, fn);
        plainDataHosts.add(host);
        console.log(`[ftps] ${host}: encrypted data channel refused, using PROT C`);
        return r;
      }
    } catch (e) {
      const permanent = (e instanceof FtpsError && e.permanent) || e instanceof ConnectError || e instanceof DataChannelError;
      if (permanent || attempt >= o.retries) throw e;
      console.warn(`[ftps] ${host}: ${(e as Error).message} — retry ${attempt + 1}/${o.retries}`);
      await sleep(o.retryDelayMs * (attempt + 1));
    }
  }
}

export function ftpsDownload(host: string, password: string, path: string, opts?: FtpsOptions): Promise<Buffer> {
  return withFtps(host, password, s => s.retr(path), opts);
}

export function ftpsList(host: string, password: string, dir: string, opts?: FtpsOptions): Promise<string[]> {
  return withFtps(host, password, s => s.nlst(dir), opts);
}
