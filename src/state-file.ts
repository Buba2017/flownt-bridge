import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'fs';
import { dirname } from 'path';

// Small JSON state files next to the config (job sessions, outbox). They can hold the
// printer's Flownt token, so: owner-only permissions and an atomic replace — a crash
// never leaves half a file.

export function readJson<T>(file: string): T | null {
  if (!existsSync(file)) return null;
  try {
    return JSON.parse(readFileSync(file, 'utf-8')) as T;
  } catch (e) {
    const backup = `${file}.corrupt-${Date.now()}`;
    try { renameSync(file, backup); } catch { /* keep going */ }
    console.error(`[state] ${file} unreadable (${(e as Error).message}) — moved to ${backup}`);
    return null;
  }
}

export function writeJsonAtomic(file: string, data: unknown): void {
  const dir = dirname(file);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(data), { encoding: 'utf-8', mode: 0o600 });
  renameSync(tmp, file);
}

export function removeFile(file: string): void {
  try { rmSync(file, { force: true }); } catch { /* ignore */ }
}
