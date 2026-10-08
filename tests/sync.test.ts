import assert from 'node:assert/strict';
import { test } from 'node:test';
import { constants, createCipheriv, publicEncrypt, randomBytes } from 'node:crypto';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BridgeSyncResponse, LinkedPrinterConfig } from '../src/contract.js';

const home = mkdtempSync(join(tmpdir(), 'flownt-sync-test-'));
process.env.HOME = home;
process.env.USERPROFILE = home;

const { RemovalGuard, MIN_DURATION_MS } = await import('../src/link/removal-guard.js');
const { addTombstone, pruneTombstones, takeTombstone, TOMBSTONE_TTL_MS } = await import('../src/link/tombstones.js');
const { reconcile } = await import('../src/link/sync.js');
const { loadMultiConfig } = await import('../src/config.js');
const { publicKeyPem } = await import('../src/link/keys.js');

test('guard: small removals apply at once, mass removals wait for 3 syncs over 5 minutes', () => {
  let now = 0;
  const guard = new RemovalGuard(() => now);
  assert.deepEqual(guard.decide(['a'], 3), { allowed: ['a'], held: [], confirmed: false });
  // Exactly half is not "more than half".
  assert.deepEqual(guard.decide(['a'], 2), { allowed: ['a'], held: [], confirmed: false });
  // The only printer is "all printers".
  assert.deepEqual(guard.decide(['a'], 1).held, ['a']);
  guard.reset();
  // All three removed: held.
  for (let i = 0; i < 5; i++) {
    const d = guard.decide(['c', 'a', 'b'], 3);
    assert.deepEqual(d.allowed, []);
    assert.equal(d.held.length, 3);
    now += 30_000;
  }
  assert.equal(guard.status()!.confirmations, 5);
  now = MIN_DURATION_MS; // 5 min after the first sighting
  const d = guard.decide(['a', 'b', 'c'], 3);
  assert.equal(d.confirmed, true);
  assert.deepEqual(d.allowed.sort(), ['a', 'b', 'c']);
  assert.equal(guard.status(), null);
});

test('guard: time alone is not enough, and an interruption restarts the count', () => {
  let now = 0;
  const guard = new RemovalGuard(() => now);
  guard.decide(['a', 'b'], 2);
  now += MIN_DURATION_MS * 2;
  assert.deepEqual(guard.decide(['a', 'b'], 2).allowed, [], 'only 2 sightings');
  guard.decide([], 2); // a healthy sync in between
  assert.equal(guard.status(), null);
  guard.decide(['a', 'b'], 2);
  now += MIN_DURATION_MS;
  guard.decide(['a', 'b'], 2);
  guard.decide(['a'], 2); // different set (1 of 2 is not mass) → applies, clears pending
  assert.equal(guard.status(), null);
});

test('tombstones expire after 24 h and match by Flownt id or serial', () => {
  const cfg: import('../src/config.js').MultiConfig = { version: 2, language: 'en', printers: [] };
  addTombstone(cfg, { flowntPrinterId: 'f1', adapterSerial: '00M1', adapterApiKey: 'code1' }, 0);
  addTombstone(cfg, { flowntPrinterId: 'f2', adapterApiKey: '' }, 0); // nothing to keep
  assert.equal(cfg.removedSecrets?.length, 1);
  assert.equal(takeTombstone(cfg, { flowntPrinterId: 'other', adapterSerial: '00m1' }), 'code1');
  assert.equal(cfg.removedSecrets, undefined);
  addTombstone(cfg, { flowntPrinterId: 'f1', adapterApiKey: 'code1' }, 0);
  assert.equal(pruneTombstones(cfg, TOMBSTONE_TTL_MS - 1), false);
  assert.equal(pruneTombstones(cfg, TOMBSTONE_TTL_MS), true);
  assert.equal(cfg.removedSecrets, undefined);
});

// ── reconcile against a real (temporary) config ─────────────────────────────

const remote = (id: string, serial: string): LinkedPrinterConfig => ({
  printer_id: id, name: `P-${id}`, adapter_type: 'bambu', adapter_url: '10.0.0.1', device_serial: serial,
  auth_token: `${id.padEnd(8, '0')}-0000-4000-8000-000000000000`, enabled: true,
});
const PRINTERS = [remote('f1', 'S1'), remote('f2', 'S2'), remote('f3', 'S3')];

function seedConfig() {
  mkdirSync(join(home, '.flownt-bridge'), { recursive: true });
  writeFileSync(join(home, '.flownt-bridge', 'config.json'), JSON.stringify({
    version: 2, language: 'en',
    printers: PRINTERS.map((r, i) => ({
      id: `local-${i + 1}`, name: r.name, flowntAuthToken: r.auth_token, adapterType: 'bambu', adapterUrl: r.adapter_url,
      adapterApiKey: `code-${r.printer_id}`, adapterSerial: r.device_serial, pollingIntervalMs: 30000,
      flowntPrinterId: r.printer_id, managed: true,
    })),
  }));
}
const response = (printers: LinkedPrinterConfig[], secrets: BridgeSyncResponse['secrets'] = []): BridgeSyncResponse =>
  ({ bridge_id: 'b', name: 'bridge', printers, secrets });

function recorder() {
  const calls = { add: [] as string[], update: [] as string[], del: [] as string[] };
  return {
    calls,
    cb: {
      onAdd: (p: { flowntPrinterId?: string }) => { calls.add.push(p.flowntPrinterId!); },
      onUpdate: (p: { flowntPrinterId?: string }) => { calls.update.push(p.flowntPrinterId!); },
      onDelete: (id: string) => { calls.del.push(id); },
      isConnected: () => true,
    },
  };
}

test('an empty printer list (backend glitch) keeps all printers and their codes', () => {
  seedConfig();
  const { calls, cb } = recorder();
  const guard = new RemovalGuard(() => 0);
  for (let i = 0; i < 10; i++) reconcile(response([]), cb, guard);
  const cfg = loadMultiConfig();
  assert.equal(cfg.printers.length, 3);
  assert.deepEqual(cfg.printers.map(p => p.adapterApiKey), ['code-f1', 'code-f2', 'code-f3']);
  assert.deepEqual(calls.del, []);
  // The next healthy sync clears the pending removal.
  reconcile(response(PRINTERS), cb, guard);
  assert.equal(guard.status(), null);
});

test('dropping more than half is held; a single removal applies at once', () => {
  seedConfig();
  const { calls, cb } = recorder();
  reconcile(response([PRINTERS[0]]), cb, new RemovalGuard(() => 0));
  assert.equal(loadMultiConfig().printers.length, 3);
  reconcile(response([PRINTERS[0], PRINTERS[1]]), cb, new RemovalGuard(() => 0));
  assert.deepEqual(loadMultiConfig().printers.map(p => p.flowntPrinterId), ['f1', 'f2']);
  assert.deepEqual(calls.del, ['local-3']);
});

test('a confirmed removal tombstones the codes; re-adding restores them', () => {
  seedConfig();
  const { calls, cb } = recorder();
  let now = 0;
  const guard = new RemovalGuard(() => now);
  reconcile(response([]), cb, guard);
  now += MIN_DURATION_MS / 2;
  reconcile(response([]), cb, guard);
  now += MIN_DURATION_MS / 2;
  reconcile(response([]), cb, guard);
  let cfg = loadMultiConfig();
  assert.equal(cfg.printers.length, 0);
  assert.equal(calls.del.length, 3);
  assert.deepEqual(cfg.removedSecrets!.map(t => t.adapterApiKey).sort(), ['code-f1', 'code-f2', 'code-f3']);

  reconcile(response([PRINTERS[1]]), cb, guard);
  cfg = loadMultiConfig();
  assert.equal(cfg.printers.length, 1);
  assert.equal(cfg.printers[0].flowntPrinterId, 'f2');
  assert.equal(cfg.printers[0].adapterApiKey, 'code-f2', 'code restored from the tombstone');
  assert.equal(cfg.removedSecrets!.length, 2);
});

test('a code delivered before its printer is parked and applied when the printer arrives', () => {
  seedConfig();
  const { cb } = recorder();
  const ciphertext = publicEncrypt(
    { key: publicKeyPem(), padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha256' }, Buffer.from('newcode9'),
  ).toString('base64');
  const guard = new RemovalGuard(() => 0);
  reconcile(response(PRINTERS, [{ id: 's1', printer_id: 'f4', kind: 'access_code', ciphertext }]), cb, guard);
  assert.equal(loadMultiConfig().removedSecrets?.[0].flowntPrinterId, 'f4');
  reconcile(response([...PRINTERS, remote('f4', 'S4')]), cb, guard);
  const p4 = loadMultiConfig().printers.find(p => p.flowntPrinterId === 'f4')!;
  assert.equal(p4.adapterApiKey, 'newcode9');
});

test('a Bambu Cloud token arrives in the hybrid envelope and is stored on the printer', () => {
  seedConfig();
  const { cb, calls } = recorder();
  const token = JSON.stringify({ access_token: 'a'.repeat(900), refresh_token: 'r'.repeat(300), expires_at: '2027-01-05T00:00:00Z' });
  const key = randomBytes(32), iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const ct = Buffer.concat([cipher.update(token, 'utf-8'), cipher.final(), cipher.getAuthTag()]);
  const k = publicEncrypt({ key: publicKeyPem(), padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha256' }, key);
  const ciphertext = 'hyb1:' + Buffer.from(JSON.stringify({
    k: k.toString('base64'), iv: iv.toString('base64'), ct: ct.toString('base64'),
  })).toString('base64');
  reconcile(response(PRINTERS, [{ id: 's9', printer_id: PRINTERS[0].printer_id, kind: 'bambu_cloud_token', ciphertext }]), cb, new RemovalGuard(() => 0));
  const p = loadMultiConfig().printers.find(x => x.flowntPrinterId === PRINTERS[0].printer_id)!;
  assert.equal(p.bambuCloudToken?.accessToken, 'a'.repeat(900));
  assert.equal(p.bambuCloudToken?.refreshToken, 'r'.repeat(300));
  assert.equal(p.bambuCloudToken?.expiresAt, Date.parse('2027-01-05T00:00:00Z'));
  assert.equal(p.adapterApiKey, `code-${PRINTERS[0].printer_id}`, 'access code untouched');
  assert.deepEqual(calls.update, [], 'a new cloud session does not reconnect the printer');
});
