import { closeSync, fstatSync, openSync, renameSync, unlinkSync, writeSync, existsSync, mkdirSync } from 'fs';
import { dirname } from 'path';
import { format } from 'util';

// Small leveled logger.
//
//   const log = createLogger('link');
//   log.info('paired as %s', name);   // 2026-10-06T12:00:00.000Z INFO  [link] paired as …
//
// - LOG_LEVEL=debug|info|warn|error (default info) filters output.
// - installConsoleCapture() routes console.* (still used by adapter modules) through the
//   same sinks, so every line gets a timestamp and level and lands in the ring buffer
//   that /diagnostics.zip exports.
// - With a log file (FLOWNT_LOG_FILE or --log-file), lines go to a size-capped rotating
//   file (5 MB × 3 rotations) instead of stdout. Used by the desktop installers, where
//   nothing else rotates the log; systemd installs keep logging to the journal.

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };
const LABEL: Record<LogLevel, string> = { debug: 'DEBUG', info: 'INFO ', warn: 'WARN ', error: 'ERROR' };

export function parseLogLevel(value: string | undefined): LogLevel {
  const v = value?.trim().toLowerCase();
  if (v === 'debug' || v === 'info' || v === 'warn' || v === 'error') return v;
  if (v === 'warning') return 'warn';
  return 'info';
}

let threshold: LogLevel = parseLogLevel(process.env.LOG_LEVEL);

export function setLogLevel(level: LogLevel): void { threshold = level; }
export function getLogLevel(): LogLevel { return threshold; }

// ── Ring buffer of recent lines (for diagnostics) ─────────────────────────────

const RECENT_MAX = 1000;
const recent: string[] = [];

/** The most recent log lines, oldest first. */
export function recentLogLines(limit = RECENT_MAX): string[] {
  return recent.slice(-limit);
}

// ── Rotating file sink ────────────────────────────────────────────────────────

export class RotatingFile {
  private fd: number | null = null;
  private size = 0;

  constructor(readonly path: string, readonly maxBytes = 5 * 1024 * 1024, readonly keep = 3) {
    if (!existsSync(dirname(path))) mkdirSync(dirname(path), { recursive: true });
    this.open();
    // An oversized file from an older version (launchd appended forever) rotates now.
    if (this.size >= this.maxBytes) this.rotate();
  }

  private open(): void {
    this.fd = openSync(this.path, 'a', 0o600);
    this.size = fstatSync(this.fd).size;
  }

  private rotate(): void {
    if (this.fd !== null) closeSync(this.fd);
    this.fd = null;
    const oldest = `${this.path}.${this.keep}`;
    if (existsSync(oldest)) unlinkSync(oldest);
    for (let i = this.keep - 1; i >= 1; i--) {
      const from = `${this.path}.${i}`;
      if (existsSync(from)) renameSync(from, `${this.path}.${i + 1}`);
    }
    if (this.keep >= 1) renameSync(this.path, `${this.path}.1`);
    else unlinkSync(this.path);
    this.open();
  }

  write(text: string): void {
    const bytes = Buffer.byteLength(text);
    if (this.size > 0 && this.size + bytes > this.maxBytes) this.rotate();
    writeSync(this.fd!, text);
    this.size += bytes;
  }

  close(): void {
    if (this.fd !== null) closeSync(this.fd);
    this.fd = null;
  }
}

let fileSink: RotatingFile | null = null;

/** Log to a rotating file instead of stdout/stderr. Returns false if it cannot be opened. */
export function enableFileLogging(path: string, maxBytes?: number, keep?: number): boolean {
  try {
    fileSink?.close();
    fileSink = new RotatingFile(path, maxBytes, keep);
    return true;
  } catch (e) {
    fileSink = null;
    rawStderr(`${new Date().toISOString()} WARN  [logger] cannot open log file ${path}: ${(e as Error).message}\n`);
    return false;
  }
}

export function disableFileLogging(): void {
  fileSink?.close();
  fileSink = null;
}

/** Log file from --log-file <path> / --log-file=<path> or FLOWNT_LOG_FILE. */
export function logFileFromArgs(argv = process.argv, env = process.env): string | null {
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--log-file' && argv[i + 1]) return argv[i + 1];
    if (argv[i].startsWith('--log-file=')) return argv[i].slice('--log-file='.length) || null;
  }
  return env.FLOWNT_LOG_FILE?.trim() || null;
}

// ── Output ────────────────────────────────────────────────────────────────────

// Original stream writers, captured before console capture could wrap anything.
const stdoutWrite = process.stdout.write.bind(process.stdout);
const stderrWrite = process.stderr.write.bind(process.stderr);
function rawStderr(text: string): void { stderrWrite(text); }

function emit(level: LogLevel, module: string | null, args: unknown[]): void {
  if (ORDER[level] < ORDER[threshold]) return;
  const message = format(...args);
  const line = `${new Date().toISOString()} ${LABEL[level]} ${module ? `[${module}] ` : ''}${message}`;
  recent.push(line);
  if (recent.length > RECENT_MAX) recent.splice(0, recent.length - RECENT_MAX);
  if (fileSink) {
    try {
      fileSink.write(line + '\n');
      return;
    } catch {
      // Disk full or file removed: keep logging to the console rather than going silent.
      fileSink = null;
    }
  }
  (ORDER[level] >= ORDER.warn ? stderrWrite : stdoutWrite)(line + '\n');
}

export interface Logger {
  debug(...args: unknown[]): void;
  info(...args: unknown[]): void;
  warn(...args: unknown[]): void;
  error(...args: unknown[]): void;
}

export function createLogger(module: string): Logger {
  return {
    debug: (...args) => emit('debug', module, args),
    info: (...args) => emit('info', module, args),
    warn: (...args) => emit('warn', module, args),
    error: (...args) => emit('error', module, args),
  };
}

let captured = false;

/** Route console.log/info/debug/warn/error through the logger sinks (idempotent). */
export function installConsoleCapture(): void {
  if (captured) return;
  captured = true;
  console.debug = (...args: unknown[]) => emit('debug', null, args);
  console.log = (...args: unknown[]) => emit('info', null, args);
  console.info = (...args: unknown[]) => emit('info', null, args);
  console.warn = (...args: unknown[]) => emit('warn', null, args);
  console.error = (...args: unknown[]) => emit('error', null, args);
}
