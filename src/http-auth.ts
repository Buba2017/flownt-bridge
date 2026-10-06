import { createHash, randomBytes, timingSafeEqual } from 'crypto';
import { isIP } from 'net';
import { hostname as osHostname } from 'os';
import type { Request } from 'express';

// Building blocks for the local HTTP API's access control:
//   - which browser origins may call the bridge (CORS allowlist),
//   - which Host headers the bridge answers to (DNS-rebinding defence),
//   - loopback detection, constant-time token comparison,
//   - CSRF protection and the optional admin password for the setup UI.

// ── Origins ───────────────────────────────────────────────────────────────────

/** Browser origins of the hosted Flownt app and its native shells. */
export const DEFAULT_ALLOWED_ORIGINS: readonly string[] = [
  'https://flownt.app',
  'https://www.flownt.app',
  // Capacitor shells (iOS: capacitor://localhost, Android with androidScheme https).
  'capacitor://localhost',
  'https://localhost',
];

// Local development servers and the bridge's own UI on any port.
const LOCAL_HTTP_ORIGIN = /^http:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d{1,5})?$/;

export function normalizeOrigin(value: string): string | null {
  const v = value.trim().toLowerCase().replace(/\/+$/, '');
  if (!v || v === 'null') return null;
  if (/^capacitor:\/\/[a-z0-9.-]+$/.test(v)) return v;
  try {
    const url = new URL(v);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    if (url.username || url.password || (url.pathname !== '/' && url.pathname !== '') || url.search || url.hash) return null;
    return url.origin;
  } catch {
    return null;
  }
}

/** Extra origins from FLOWNT_ALLOWED_ORIGINS and the older FLOWNT_CAMERA_ORIGINS (comma-separated). */
export function envAllowedOrigins(env: NodeJS.ProcessEnv = process.env): string[] {
  return [env.FLOWNT_ALLOWED_ORIGINS, env.FLOWNT_CAMERA_ORIGINS]
    .flatMap(v => (v ?? '').split(','))
    .map(normalizeOrigin)
    .filter((o): o is string => !!o);
}

/**
 * Origin policy: built-in defaults + local dev origins + environment + `extra()`
 * (origins saved in the setup UI). `extra` is read per call, so UI changes apply at once.
 */
export function originPolicy(extra: () => string[] = () => [], env: NodeJS.ProcessEnv = process.env) {
  const fixed = new Set([...DEFAULT_ALLOWED_ORIGINS, ...envAllowedOrigins(env)]);
  return (origin: string | undefined): boolean => {
    if (!origin) return false;
    const o = normalizeOrigin(origin);
    if (!o) return false;
    if (fixed.has(o) || LOCAL_HTTP_ORIGIN.test(o)) return true;
    return extra().some(e => normalizeOrigin(e) === o);
  };
}

// ── Hosts (DNS rebinding) ─────────────────────────────────────────────────────

/** Host name (lower case, no port, no brackets) from a Host header value. */
export function hostName(hostHeader: string | undefined): string | null {
  if (!hostHeader) return null;
  const h = hostHeader.trim().toLowerCase();
  if (h.startsWith('[')) {
    const end = h.indexOf(']');
    return end > 0 ? h.slice(1, end) : null;
  }
  return h.replace(/:\d+$/, '') || null;
}

/**
 * A DNS-rebinding page reaches the bridge under an attacker-controlled public domain.
 * Only names that cannot be such a domain are answered: IP literals, localhost,
 * single-label LAN names, mDNS/private suffixes, this machine's host name and the names
 * listed in FLOWNT_BRIDGE_ALLOWED_HOSTS (plus the host of FLOWNT_PUBLIC_URL).
 */
export function hostPolicy(env: NodeJS.ProcessEnv = process.env) {
  const extra = new Set<string>();
  for (const h of (env.FLOWNT_BRIDGE_ALLOWED_HOSTS ?? '').split(',')) {
    const name = hostName(h);
    if (name) extra.add(name);
  }
  try {
    if (env.FLOWNT_PUBLIC_URL?.trim()) extra.add(new URL(env.FLOWNT_PUBLIC_URL.trim()).hostname.toLowerCase());
  } catch { /* ignore an invalid URL here */ }
  const own = osHostname().toLowerCase();
  if (own) { extra.add(own); extra.add(own.split('.')[0]); }
  return (hostHeader: string | undefined): boolean => {
    const name = hostName(hostHeader);
    if (!name) return false;
    if (isIP(name)) return true;
    if (name === 'localhost' || name.endsWith('.localhost')) return true;
    if (!name.includes('.')) return true;
    if (/\.(local|lan|internal|home\.arpa)$/.test(name)) return true;
    return extra.has(name);
  };
}

// ── Loopback ──────────────────────────────────────────────────────────────────

export function isLoopbackAddress(address: string | undefined): boolean {
  if (!address) return false;
  const a = address.toLowerCase();
  return a === '::1' || /^127\./.test(a) || /^::ffff:127\./.test(a);
}

/** Whether a bind address only accepts connections from this machine. */
export function isLoopbackBind(host: string | undefined): boolean {
  if (!host) return false;
  const h = host.trim().toLowerCase().replace(/^\[|\]$/g, '');
  return h === 'localhost' || isLoopbackAddress(h);
}

// ── Tokens ────────────────────────────────────────────────────────────────────

export function bearerToken(req: Pick<Request, 'headers'>): string | null {
  return /^Bearer\s+(\S+)\s*$/i.exec(req.headers.authorization ?? '')?.[1] ?? null;
}

/** Constant-time string comparison that does not leak the length either. */
export function safeEqual(a: string, b: string): boolean {
  const ha = createHash('sha256').update(a).digest();
  const hb = createHash('sha256').update(b).digest();
  return timingSafeEqual(ha, hb);
}

// ── Same-origin / CSRF ────────────────────────────────────────────────────────

export const CSRF_FIELD = '_csrf';

/**
 * Whether a browser request comes from the bridge's own pages. Compares Origin (or
 * Referer) with the Host the browser used — so it works under any address, including
 * an SSH tunnel to localhost:<any port>. Requests without these headers (curl) pass;
 * state-changing forms additionally need the CSRF token.
 */
export function isSameOriginRequest(req: Pick<Request, 'headers'>): boolean {
  const host = req.headers.host?.toLowerCase();
  const site = req.headers['sec-fetch-site'];
  if (typeof site === 'string' && site !== 'same-origin' && site !== 'none') return false;
  const origin = req.headers.origin;
  if (origin !== undefined) {
    if (origin === 'null') return false;
    try { return new URL(origin).host.toLowerCase() === host; } catch { return false; }
  }
  const referer = req.headers.referer;
  if (referer) {
    try { return new URL(referer).host.toLowerCase() === host; } catch { return false; }
  }
  return true;
}

export function newSecret(): string {
  return randomBytes(32).toString('base64url');
}

// ── Admin password + sessions ─────────────────────────────────────────────────

export function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of (header ?? '').split(';')) {
    const i = part.indexOf('=');
    if (i <= 0) continue;
    const k = part.slice(0, i).trim();
    try { out[k] = decodeURIComponent(part.slice(i + 1).trim()); } catch { /* skip malformed */ }
  }
  return out;
}

const SESSION_TTL_MS = 12 * 60 * 60 * 1000;
const FAIL_WINDOW_MS = 10 * 60 * 1000;
const MAX_FAILS = 10;

/** Optional password for the setup UI (FLOWNT_BRIDGE_ADMIN_PASSWORD), with in-memory sessions. */
export class AdminAuth {
  readonly cookieName: string;
  private sessions = new Map<string, number>();
  private fails = new Map<string, { count: number; since: number }>();

  constructor(private readonly password: string | undefined, port: number, private readonly now = () => Date.now()) {
    this.cookieName = `flownt_bridge_session_${port}`;
  }

  get enabled(): boolean { return !!this.password; }

  /** Whether too many failed logins came from this address recently. */
  locked(remote: string): boolean {
    const f = this.fails.get(remote);
    if (!f) return false;
    if (this.now() - f.since > FAIL_WINDOW_MS) { this.fails.delete(remote); return false; }
    return f.count >= MAX_FAILS;
  }

  /** Returns a new session id, or null for a wrong password. */
  login(password: string, remote: string): string | null {
    if (!this.password || this.locked(remote)) return null;
    if (!safeEqual(password, this.password)) {
      const f = this.fails.get(remote) ?? { count: 0, since: this.now() };
      f.count++;
      this.fails.set(remote, f);
      return null;
    }
    this.fails.delete(remote);
    const id = newSecret();
    this.sessions.set(id, this.now() + SESSION_TTL_MS);
    return id;
  }

  logout(req: Pick<Request, 'headers'>): void {
    const id = parseCookies(req.headers.cookie)[this.cookieName];
    if (id) this.sessions.delete(id);
  }

  /** Valid session cookie, or `Authorization: Bearer <admin password>` for scripts. */
  check(req: Pick<Request, 'headers'>): boolean {
    if (!this.password) return true;
    const bearer = bearerToken(req);
    if (bearer && safeEqual(bearer, this.password)) return true;
    const id = parseCookies(req.headers.cookie)[this.cookieName];
    if (!id) return false;
    const expires = this.sessions.get(id);
    if (!expires) return false;
    if (expires < this.now()) { this.sessions.delete(id); return false; }
    this.sessions.set(id, this.now() + SESSION_TTL_MS); // sliding expiry
    return true;
  }

  cookie(id: string): string {
    return `${this.cookieName}=${id}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${SESSION_TTL_MS / 1000}`;
  }

  clearCookie(): string {
    return `${this.cookieName}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0`;
  }
}
