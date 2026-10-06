import tls from 'node:tls';

// Minimal implicit-FTPS client for Bambu printers (port 990, user bblp).
//
// Newer Bambu firmware (X1C 01.09+, X2D, H2C, …) runs vsftpd with
// require_ssl_reuse: the TLS data connection must resume the control connection's
// session, otherwise it answers "522 SSL connection failed: session reuse required".
// basic-ftp's data connection is not accepted by these printers, so downloads fall back
// to this client, which resumes the session captured from the control connection.

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
    const s = tls.connect({ host, port, rejectUnauthorized: false, ...opts }, () => resolve(s));
    s.once('error', reject);
  });
}

async function withSession<T>(host: string, password: string, timeoutMs: number,
  fn: (c: Control) => Promise<T>): Promise<T> {
  const socket = await connect(host, 990, {});
  const timer = setTimeout(() => socket.destroy(new Error('FTPS timeout')), timeoutMs);
  const c = new Control(socket);
  try {
    const hello = await c.next();
    if (hello.code !== 220) throw new Error(`${hello.code} ${hello.text}`);
    await c.cmd('USER bblp', [331]);
    await c.cmd(`PASS ${password}`, [230]);
    await c.cmd('PBSZ 0', [200]);
    await c.cmd('PROT P', [200]);
    await c.cmd('TYPE I', [200]);
    return await fn(c);
  } finally {
    clearTimeout(timer);
    socket.end('QUIT\r\n');
    socket.destroy();
  }
}

/** Runs one data-channel transfer (RETR/NLST) and returns the received bytes. */
async function transfer(c: Control, host: string, command: string): Promise<Buffer> {
  const pasv = await c.cmd('PASV', [227]);
  const m = /\((\d+),(\d+),(\d+),(\d+),(\d+),(\d+)\)/.exec(pasv.text);
  if (!m) throw new Error(`PASV: ${pasv.text}`);
  const port = parseInt(m[5], 10) * 256 + parseInt(m[6], 10);
  c.socket.write(command + '\r\n');
  // The server answers the command first (150, or e.g. 550 if the file does not exist,
  // in which case the data connection is dropped) — so read the reply before the data.
  let dataSocket: tls.TLSSocket | undefined;
  const received = connect(host, port, { session: c.session ?? c.socket.getSession() }).then(data => {
    dataSocket = data;
    const chunks: Buffer[] = [];
    return new Promise<Buffer>((resolve, reject) => {
      data.on('data', ch => chunks.push(ch));
      data.on('end', () => resolve(Buffer.concat(chunks)));
      data.on('error', reject);
    });
  });
  received.catch(() => { /* reported via the control reply */ });
  const start = await c.next();
  if (start.code !== 150 && start.code !== 125) {
    dataSocket?.destroy();
    throw new Error(`${start.code} ${start.text}`);
  }
  const buf = await received;
  const end = await c.next();
  if (end.code !== 226) throw new Error(`${end.code} ${end.text}`);
  return buf;
}

export function ftpsDownload(host: string, password: string, path: string, timeoutMs = 60_000): Promise<Buffer> {
  return withSession(host, password, timeoutMs, c => transfer(c, host, `RETR ${path}`));
}

export function ftpsList(host: string, password: string, dir: string, timeoutMs = 20_000): Promise<string[]> {
  return withSession(host, password, timeoutMs, async c =>
    (await transfer(c, host, `NLST ${dir}`)).toString('utf8').split(/\r?\n/).filter(Boolean));
}
