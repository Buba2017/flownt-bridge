import assert from 'node:assert/strict';
import { beforeEach, test } from 'node:test';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Isolated config dir: config.ts resolves ~/.flownt-bridge at import time.
const home = mkdtempSync(join(tmpdir(), 'flownt-bridge-test-'));
process.env.HOME = home;
process.env.USERPROFILE = home;
const dir = join(home, '.flownt-bridge');
const file = join(dir, 'config.json');

const { loadMultiConfig, saveMultiConfig } = await import('../src/config.js');

beforeEach(() => {
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
});

test('a broken config.json is moved aside, not overwritten by the next save', () => {
  writeFileSync(file, '{ "version": 2, "printers": [ {');
  assert.deepEqual(loadMultiConfig(), { version: 2, language: 'de', printers: [] });
  const backups = readdirSync(dir).filter(f => f.startsWith('config.json.corrupt-'));
  assert.equal(backups.length, 1);
  assert.equal(readFileSync(join(dir, backups[0]), 'utf-8'), '{ "version": 2, "printers": [ {');
  saveMultiConfig({ version: 2, language: 'en', printers: [] });
  assert.equal(readFileSync(join(dir, backups[0]), 'utf-8'), '{ "version": 2, "printers": [ {');
});

test('JSON that is not an object counts as broken', () => {
  writeFileSync(file, 'null');
  assert.deepEqual(loadMultiConfig().printers, []);
  assert.equal(readdirSync(dir).filter(f => f.startsWith('config.json.corrupt-')).length, 1);
});

test('a broken config.json that cannot be moved aside stops loading', () => {
  writeFileSync(file, '{ broken');
  // The backup name is taken: renaming a file onto a non-empty directory fails (also as root).
  mkdirSync(join(dir, 'config.json.corrupt-42'));
  writeFileSync(join(dir, 'config.json.corrupt-42', 'x'), '');
  const realNow = Date.now;
  Date.now = () => 42;
  try {
    assert.throws(() => loadMultiConfig(), /could not be moved aside/);
  } finally {
    Date.now = realNow;
  }
  assert.equal(readFileSync(file, 'utf-8'), '{ broken');
});

test('hand-edited values are brought into shape', () => {
  writeFileSync(file, JSON.stringify({
    version: 2, language: 'fr', allowedOrigins: 'https://x.example',
    printers: [
      { id: 'p1', name: 'X1C', flowntAuthToken: 'tok', adapterType: 'bambu', adapterUrl: '10.0.0.5', adapterApiKey: 12345678,
        adapterSerial: '00M1', bambuCloudEmail: 5, bambuCloudPassword: null, smartPlugUrl: ['10.0.0.9'] },
      { id: 'p2', name: 'Voron', adapterType: 'moonraker', adapterUrl: 'http://10.0.0.6', pollingIntervalMs: 0, smartPlugUrl: '10.0.0.7' },
      'garbage',
    ],
  }));
  const cfg = loadMultiConfig();
  assert.equal(cfg.language, 'de');
  assert.equal(cfg.allowedOrigins, undefined);
  assert.equal(cfg.printers.length, 2);
  const [p1, p2] = cfg.printers;
  assert.equal(p1.adapterApiKey, '12345678');
  assert.equal(p1.pollingIntervalMs, 30_000);
  assert.ok(!('bambuCloudEmail' in p1) && !('bambuCloudPassword' in p1) && !('smartPlugUrl' in p1));
  assert.equal(p2.flowntAuthToken, '');
  assert.equal(p2.pollingIntervalMs, 30_000);
  assert.equal(p2.smartPlugUrl, '10.0.0.7');
});

test('a missing printer list is an empty one', () => {
  writeFileSync(file, JSON.stringify({ version: 2, language: 'en' }));
  assert.deepEqual(loadMultiConfig(), { version: 2, language: 'en', printers: [] });
});

test('save replaces the file atomically, owner-only, without leftovers', () => {
  saveMultiConfig({ version: 2, language: 'de', printers: [] });
  saveMultiConfig({ version: 2, language: 'en', printers: [] });
  assert.deepEqual(readdirSync(dir), ['config.json']);
  assert.equal(loadMultiConfig().language, 'en');
  if (process.platform !== 'win32') assert.equal(statSync(file).mode & 0o777, 0o600);
});
