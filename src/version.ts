import { readFileSync } from 'fs';

// Bridge version — single source is package.json "version".
// Builds (scripts/build.mjs) inline it as __BRIDGE_VERSION__; `npm start` / tests read
// package.json next to src/. Reported to Flownt in every ingest/sync body, shown in the
// UI footer and at GET /api/version.
declare const __BRIDGE_VERSION__: string | undefined;

function resolveVersion(): string {
  if (typeof __BRIDGE_VERSION__ === 'string' && __BRIDGE_VERSION__) return __BRIDGE_VERSION__;
  try {
    const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf-8')) as { version?: string };
    if (pkg.version) return pkg.version;
  } catch { /* fall through */ }
  return '0.0.0-dev';
}

export const BRIDGE_VERSION = resolveVersion();
