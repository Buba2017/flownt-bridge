// Registry for extra health information shown in GET /healthz (and diagnostics.zip).
//
// A module that wants to report its state registers a provider once, e.g. a future
// delivery outbox:
//
//   import { registerHealthProvider } from './health-registry.js';
//   registerHealthProvider('outbox', () => ({ queued: queue.length, oldest_age_s: … }));
//
// The provider named "outbox" fills the top-level `outbox` field of /healthz; all others
// appear under `providers.<name>`. Providers must be cheap, must not throw secrets into
// their result, and may be async (each gets PROVIDER_TIMEOUT_MS).

export type HealthProvider = () => unknown | Promise<unknown>;

const providers = new Map<string, HealthProvider>();
const PROVIDER_TIMEOUT_MS = 1000;

/** Register (or replace) a provider; returns a function that unregisters it. */
export function registerHealthProvider(name: string, fn: HealthProvider): () => void {
  providers.set(name, fn);
  return () => { if (providers.get(name) === fn) providers.delete(name); };
}

/** Run all providers; a failing or slow provider reports `{ error }` instead of breaking /healthz. */
export async function collectHealthProviders(): Promise<Record<string, unknown>> {
  const out: Record<string, unknown> = {};
  await Promise.all([...providers].map(async ([name, fn]) => {
    let timer: NodeJS.Timeout | undefined;
    try {
      out[name] = await Promise.race([
        Promise.resolve().then(fn),
        new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('timeout')), PROVIDER_TIMEOUT_MS); }),
      ]);
    } catch (e) {
      out[name] = { error: (e as Error).message ?? String(e) };
    } finally {
      clearTimeout(timer);
    }
  }));
  return out;
}
