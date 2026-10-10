import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, readFileSync, existsSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  RotatingFile, createLogger, disableFileLogging, enableFileLogging, logFileFromArgs, parseLogLevel,
  recentLogLines, setLogLevel,
} from '../src/logger.js';

test('log level parsing falls back to info', () => {
  assert.equal(parseLogLevel('DEBUG'), 'debug');
  assert.equal(parseLogLevel('warning'), 'warn');
  assert.equal(parseLogLevel(undefined), 'info');
  assert.equal(parseLogLevel('verbose'), 'info');
});

test('log file comes from --log-file, --log-file= or FLOWNT_LOG_FILE', () => {
  assert.equal(logFileFromArgs(['node', 'x', '--log-file', '/a.log'], {}), '/a.log');
  assert.equal(logFileFromArgs(['node', 'x', '--log-file=/b.log'], {}), '/b.log');
  assert.equal(logFileFromArgs(['node', 'x'], { FLOWNT_LOG_FILE: '/c.log' }), '/c.log');
  assert.equal(logFileFromArgs(['node', 'x'], {}), null);
});

test('rotating file caps size and keeps the configured number of rotations', () => {
  const dir = mkdtempSync(join(tmpdir(), 'flownt-log-'));
  const path = join(dir, 'bridge.log');
  const file = new RotatingFile(path, 100, 3);
  for (let i = 0; i < 20; i++) file.write(`${String(i).padStart(2, '0')} ${'x'.repeat(36)}\n`); // 40 bytes each
  file.close();
  assert.ok(statSync(path).size <= 100);
  for (const n of [1, 2, 3]) assert.ok(existsSync(`${path}.${n}`), `rotation ${n} exists`);
  assert.ok(!existsSync(`${path}.4`));
  assert.match(readFileSync(path, 'utf-8'), /^18 /);
});

test('an oversized existing log is rotated on open', () => {
  const dir = mkdtempSync(join(tmpdir(), 'flownt-log-'));
  const path = join(dir, 'bridge.log');
  writeFileSync(path, 'y'.repeat(500));
  new RotatingFile(path, 100, 2).close();
  assert.equal(statSync(path).size, 0);
  assert.equal(statSync(`${path}.1`).size, 500);
});

test('logger writes timestamped, leveled, module-prefixed lines and honours the level', () => {
  const dir = mkdtempSync(join(tmpdir(), 'flownt-log-'));
  const path = join(dir, 'bridge.log');
  assert.ok(enableFileLogging(path));
  try {
    setLogLevel('info');
    const log = createLogger('test');
    log.debug('hidden');
    log.warn('visible %d', 42);
    log.error('boom', new Error('kaputt'));
  } finally {
    disableFileLogging();
    setLogLevel('info');
  }
  const text = readFileSync(path, 'utf-8');
  assert.doesNotMatch(text, /hidden/);
  assert.match(text, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z WARN  \[test\] visible 42$/m);
  assert.match(text, /ERROR \[test\] boom Error: kaputt\n\s+at /);
  assert.ok(recentLogLines().some(l => l.includes('[test] visible 42')));
});
