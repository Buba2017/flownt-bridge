import fetch from 'node-fetch';
import { parseCloudTasks, type CloudTask } from './material-sources.js';

const BASE_URL = 'https://api.bambulab.com/v1/user-service';

const HEADERS = {
  'Content-Type': 'application/json',
  'User-Agent': 'bambu_network_agent/01.09.05.01',
  'X-BBL-Client-Name': 'OrcaSlicer',
};

interface LoginResponse {
  accessToken?: string;
  refreshToken?: string;
  expiresIn?: number;
  loginType?: string;
  message?: string;
}

/** Bambu Cloud session as delivered by Flownt (bridge secret `bambu_cloud_token`). */
export interface CloudToken {
  accessToken: string;
  refreshToken?: string;
  /** Epoch ms; unknown when absent. */
  expiresAt?: number;
}

/** Reads the print task history of a printer from the Bambu Cloud. */
export interface CloudTaskSource {
  /** Recent tasks of this printer; null when the cloud cannot be reached or rejects us. */
  listTasks(serial: string): Promise<CloudTask[] | null>;
}

async function fetchTasks(token: string, serial: string): Promise<{ status: number; tasks: CloudTask[] }> {
  const url = `${BASE_URL}/my/tasks?deviceId=${encodeURIComponent(serial)}&limit=20`;
  const res = await fetch(url, {
    headers: { ...HEADERS, Authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) return { status: res.status, tasks: [] };
  return { status: res.status, tasks: parseCloudTasks(await res.json()) };
}

/**
 * Token-based cloud access (preferred): the session comes encrypted from Flownt's
 * "Mit Bambu Lab anmelden" dialog. An expired access token is renewed with the refresh
 * token; the renewed session is handed to `onRefresh` so it survives restarts.
 */
export class BambuCloudSession implements CloudTaskSource {
  private refreshing: Promise<boolean> | null = null;

  constructor(private token: CloudToken, private readonly onRefresh: (t: CloudToken) => void = () => {}) {}

  get current(): CloudToken { return this.token; }

  private async refresh(): Promise<boolean> {
    if (!this.token.refreshToken) return false;
    this.refreshing ??= (async () => {
      try {
        const res = await fetch(`${BASE_URL}/user/refreshtoken`, {
          method: 'POST', headers: HEADERS,
          body: JSON.stringify({ refreshToken: this.token.refreshToken }),
          signal: AbortSignal.timeout(15_000),
        });
        const data = await res.json().catch(() => ({})) as LoginResponse;
        if (!res.ok || !data.accessToken) {
          console.warn(`[bambu-cloud] token refresh failed (${res.status})`);
          return false;
        }
        this.token = {
          accessToken: data.accessToken,
          refreshToken: data.refreshToken || this.token.refreshToken,
          expiresAt: typeof data.expiresIn === 'number' ? Date.now() + data.expiresIn * 1000 : undefined,
        };
        this.onRefresh(this.token);
        console.log('[bambu-cloud] token refreshed');
        return true;
      } catch (err) {
        console.warn('[bambu-cloud] token refresh error:', (err as Error).message);
        return false;
      } finally {
        this.refreshing = null;
      }
    })();
    return this.refreshing;
  }

  async listTasks(serial: string): Promise<CloudTask[] | null> {
    try {
      // Renew a day before the expiry instead of waiting for the 401.
      if (this.token.expiresAt && this.token.expiresAt - Date.now() < 24 * 3_600_000) await this.refresh();
      let r = await fetchTasks(this.token.accessToken, serial);
      if (r.status === 401 && await this.refresh()) r = await fetchTasks(this.token.accessToken, serial);
      if (r.status < 200 || r.status >= 300) {
        console.warn(`[bambu-cloud] task history ${r.status}`);
        return null;
      }
      return r.tasks;
    } catch (err) {
      console.warn('[bambu-cloud] task history error:', (err as Error).message);
      return null;
    }
  }
}

/**
 * Legacy access with e-mail + password from the local bridge config. Accounts that get a
 * login code by e-mail cannot use it; prefer the token from Flownt.
 */
export class BambuCloudClient implements CloudTaskSource {
  private token: string | null = null;
  private tokenExpiry = 0;

  constructor(
    private readonly email: string,
    private readonly password: string,
  ) {}

  private async ensureToken(): Promise<boolean> {
    if (this.token && Date.now() < this.tokenExpiry) return true;
    try {
      const res = await fetch(`${BASE_URL}/user/login`, {
        method: 'POST',
        headers: HEADERS,
        body: JSON.stringify({ account: this.email, password: this.password, apiError: '' }),
        signal: AbortSignal.timeout(10_000),
      });
      const data = await res.json() as LoginResponse;
      if (!data.accessToken) {
        console.warn('[bambu-cloud] Login fehlgeschlagen:', data.message ?? data.loginType ?? 'Unbekannt');
        return false;
      }
      this.token = data.accessToken;
      this.tokenExpiry = Date.now() + 23 * 60 * 60 * 1000;
      console.log('[bambu-cloud] Login erfolgreich ✓');
      return true;
    } catch (err) {
      console.warn('[bambu-cloud] Login-Fehler:', err);
      return false;
    }
  }

  async listTasks(serial: string): Promise<CloudTask[] | null> {
    if (!await this.ensureToken()) return null;
    try {
      const r = await fetchTasks(this.token!, serial);
      if (r.status === 401) this.token = null;
      return r.status >= 200 && r.status < 300 ? r.tasks : null;
    } catch (err) {
      console.warn('[bambu-cloud] Tasks-Abruf Fehler:', err);
      return null;
    }
  }
}

// ── Access-code lookup (one-off login, nothing is persisted) ───────────────────
// Used by the web UI to fill in the LAN access codes of printers bound to a Bambu
// account. Neither the password nor the resulting token is stored.

export type CloudLoginStep =
  | { kind: 'token'; token: string }
  | { kind: 'verifyCode' }               // Bambu e-mailed a one-time code
  | { kind: 'tfa'; tfaKey: string }      // authenticator app code required
  | { kind: 'error'; message: string };

export interface CloudDevice {
  serial: string;
  name: string;
  model: string;
  accessCode: string;
  online: boolean;
}

async function postJson(url: string, body: unknown): Promise<{ data: Record<string, unknown>; setCookie: string[] }> {
  const res = await fetch(url, {
    method: 'POST',
    headers: HEADERS,
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(15_000),
  });
  const text = await res.text();
  let data: Record<string, unknown> = {};
  try { data = text ? JSON.parse(text) as Record<string, unknown> : {}; } catch { data = { message: text.slice(0, 200) }; }
  return { data, setCookie: res.headers.raw()['set-cookie'] ?? [] };
}

function stepFrom(data: Record<string, unknown>): CloudLoginStep {
  if (typeof data.accessToken === 'string' && data.accessToken) return { kind: 'token', token: data.accessToken };
  if (data.loginType === 'verifyCode') return { kind: 'verifyCode' };
  if (data.loginType === 'tfa' && typeof data.tfaKey === 'string') return { kind: 'tfa', tfaKey: data.tfaKey };
  return { kind: 'error', message: String(data.message ?? data.error ?? 'Login fehlgeschlagen') };
}

export async function cloudLogin(email: string, password: string): Promise<CloudLoginStep> {
  const { data } = await postJson(`${BASE_URL}/user/login`, { account: email, password, apiError: '' });
  const step = stepFrom(data);
  if (step.kind === 'verifyCode') {
    // The login answer only says a code is needed; requesting it is a separate call.
    await postJson(`${BASE_URL}/user/sendemail/code`, { email, type: 'codeLogin' });
  }
  return step;
}

export async function cloudLoginWithEmailCode(email: string, code: string): Promise<CloudLoginStep> {
  const { data } = await postJson(`${BASE_URL}/user/login`, { account: email, code });
  return stepFrom(data);
}

export async function cloudLoginWithTfa(tfaKey: string, code: string): Promise<CloudLoginStep> {
  const { data, setCookie } = await postJson('https://bambulab.com/api/sign-in/tfa', { tfaKey, tfaCode: code });
  const cookie = setCookie.find(c => c.startsWith('token='));
  if (cookie) return { kind: 'token', token: cookie.split(';', 1)[0].slice('token='.length) };
  return stepFrom(data);
}

export async function fetchBoundDevices(token: string): Promise<CloudDevice[]> {
  const res = await fetch('https://api.bambulab.com/v1/iot-service/api/user/bind', {
    headers: { ...HEADERS, Authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new Error(`Bambu Cloud ${res.status}`);
  const data = await res.json() as { devices?: Array<Record<string, unknown>> };
  return (data.devices ?? []).map(d => ({
    serial: String(d.dev_id ?? ''),
    name: String(d.name ?? ''),
    model: String(d.dev_product_name ?? d.dev_model_name ?? ''),
    accessCode: String(d.dev_access_code ?? ''),
    online: d.online === true,
  })).filter(d => d.serial);
}
