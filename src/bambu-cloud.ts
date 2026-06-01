import fetch from 'node-fetch';

const BASE_URL = 'https://api.bambulab.com/v1/user-service';

const HEADERS = {
  'Content-Type': 'application/json',
  'User-Agent': 'bambu_network_agent/01.09.05.01',
  'X-BBL-Client-Name': 'OrcaSlicer',
};

interface LoginResponse {
  accessToken?: string;
  loginType?: string;
  message?: string;
}

interface Task {
  deviceId?: string;
  weight?: number;
  status?: number;
  costTime?: number;
}

interface TasksResponse {
  hits?: Task[];
  total?: number;
}

export class BambuCloudClient {
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

  async getLatestTaskWeight(serial: string): Promise<number | null> {
    if (!await this.ensureToken()) return null;
    try {
      const res = await fetch(`${BASE_URL}/my/tasks`, {
        headers: { ...HEADERS, Authorization: `Bearer ${this.token}` },
        signal: AbortSignal.timeout(10_000),
      });
      if (!res.ok) {
        if (res.status === 401) this.token = null;
        return null;
      }
      const data = await res.json() as TasksResponse;
      const task = data.hits?.find(t => t.deviceId === serial);
      if (!task) {
        console.log('[bambu-cloud] Kein Task für Serial gefunden');
        return null;
      }
      return typeof task.weight === 'number' ? task.weight : null;
    } catch (err) {
      console.warn('[bambu-cloud] Tasks-Abruf Fehler:', err);
      return null;
    }
  }

  // Versucht bis zu maxAttempts mal mit delay dazwischen — cloud braucht etwas Zeit nach Druckende
  async getLatestTaskWeightWithRetry(serial: string, maxAttempts = 4, delayMs = 8_000): Promise<number | null> {
    for (let i = 0; i < maxAttempts; i++) {
      if (i > 0) {
        console.log(`[bambu-cloud] Warte ${delayMs / 1000}s, Versuch ${i + 1}/${maxAttempts}…`);
        await new Promise<void>(r => setTimeout(r, delayMs));
      }
      const weight = await this.getLatestTaskWeight(serial);
      if (weight != null) {
        console.log(`[bambu-cloud] Gewicht erhalten: ${weight}g`);
        return weight;
      }
    }
    console.warn('[bambu-cloud] Gewicht nicht abrufbar nach allen Versuchen');
    return null;
  }
}
