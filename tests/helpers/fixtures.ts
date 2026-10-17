import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

// Captured MQTT frames from our printers (see tests/fixtures/bambu/*/). Each file is the
// payload as the printer sent it, plus a `_fixture` block describing where it came from;
// serials, IPs and RFID ids are replaced with stable fake values.
const ROOT = join(import.meta.dirname, '..', 'fixtures', 'bambu');

export type Frame = { print?: Record<string, any>; info?: Record<string, any> };

export function loadFrame(model: string, name: string): Frame {
  const raw = JSON.parse(readFileSync(join(ROOT, model, name.endsWith('.json') ? name : `${name}.json`), 'utf8'));
  delete raw._fixture;
  return raw as Frame;
}

export function listFrames(model: string): string[] {
  return readdirSync(join(ROOT, model)).filter(f => f.endsWith('.json')).sort();
}

/** A copy of `frame.print` with only the given keys (simulates a partial push_status). */
export function partial(frame: Frame, keys: string[]): Frame {
  const p = frame.print ?? {};
  const out: Record<string, any> = { command: 'push_status', sequence_id: p.sequence_id ?? '1' };
  for (const k of keys) if (k in p) out[k] = structuredClone(p[k]);
  return { print: out };
}

export const json = (f: Frame) => JSON.stringify(f);
