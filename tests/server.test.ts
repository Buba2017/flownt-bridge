import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { request as httpRequest } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';

// Isolated config dir: config.ts resolves ~/.flownt-bridge at import time.
const home = mkdtempSync(join(tmpdir(), 'flownt-bridge-test-'));
process.env.HOME = home;
process.env.USERPROFILE = home;
delete process.env.FLOWNT_ALLOWED_ORIGINS;
delete process.env.FLOWNT_CAMERA_ORIGINS;

const T1 = '11111111-1111-4111-8111-111111111111';
const T2 = '22222222-2222-4222-8222-222222222222';
const ACCESS_CODE = 'ac0de123';
const CLOUD_PW = 'cloud-secret-pw';
const MOON_KEY = 'moonraker-api-key-xyz';
const CLOUD_ACCESS = 'bambu-cloud-access-token-123';
const CLOUD_REFRESH = 'bambu-cloud-refresh-token-456';

mkdirSync(join(home, '.flownt-bridge'), { recursive: true });
writeFileSync(join(home, '.flownt-bridge', 'config.json'), JSON.stringify({
  version: 2, language: 'en', role: 'both',
  printers: [
    { id: 'p1', name: 'X1C', flowntAuthToken: T1, adapterType: 'bambu', adapterUrl: '10.0.0.5', adapterApiKey: ACCESS_CODE,
      adapterSerial: '00M000', pollingIntervalMs: 30000, bambuCloudEmail: 'a@b.c', bambuCloudPassword: CLOUD_PW,
      bambuCloudToken: { accessToken: CLOUD_ACCESS, refreshToken: CLOUD_REFRESH }, flowntPrinterId: 'f1', managed: true },
    { id: 'p2', name: 'Voron', flowntAuthToken: T2, adapterType: 'moonraker', adapterUrl: 'http://10.0.0.6',
      adapterApiKey: MOON_KEY, adapterSerial: '', pollingIntervalMs: 30000, flowntPrinterId: 'f2', managed: true },
  ],
}));

const { createApp, printerStates } = await import('../src/server.js');
const { loadMultiConfig, saveMultiConfig } = await import('../src/config.js');

const sent: Array<{ printer: string; cmd: unknown }> = [];
for (const id of ['p1', 'p2']) {
  printerStates.set(id, {
    snapshot: null, lastPushAt: null, running: true, error: null,
    adapter: { getSnapshot: async () => ({ status: 'idle' }), sendCommand: async (cmd) => { sent.push({ printer: id, cmd }); } },
  });
}
const updates: string[] = [];
const callbacks = {
  onAdd: () => {}, onUpdate: (c: { id: string }) => { updates.push(c.id); }, onDelete: () => {},
  onPair: async () => null,
};

async function listen(app: import('express').Express): Promise<{ server: Server; base: string }> {
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>(resolve => server.once('listening', resolve));
  return { server, base: `http://127.0.0.1:${(server.address() as AddressInfo).port}` };
}
async function close(server: Server) {
  server.closeAllConnections();
  await new Promise<void>(resolve => server.close(() => resolve()));
}

let server: Server;
let base: string;
before(async () => {
  ({ server, base } = await listen(createApp(callbacks).app));
});
after(async () => close(server));

const FLOWNT = 'https://flownt.app';
const json = (body: unknown, headers: Record<string, string> = {}) => ({
  method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body), redirect: 'manual' as const,
});

test('cross-origin POST /printer/command from another website is refused', async () => {
  sent.length = 0;
  const res = await fetch(`${base}/printer/command`, json({ type: 'stop', flowntPrinterId: 'f1' }, { Origin: 'https://evil.example', Authorization: `Bearer ${T1}` }));
  assert.equal(res.status, 403);
  assert.equal(res.headers.get('access-control-allow-origin'), null);
  assert.equal(sent.length, 0);
});

test('preflight: allowed origin gets CORS + PNA headers, others get nothing', async () => {
  const ok = await fetch(`${base}/printer/command`, { method: 'OPTIONS', headers: {
    Origin: FLOWNT, 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'authorization,content-type',
    'Access-Control-Request-Private-Network': 'true',
  } });
  assert.equal(ok.status, 204);
  assert.equal(ok.headers.get('access-control-allow-origin'), FLOWNT);
  assert.equal(ok.headers.get('access-control-allow-private-network'), 'true');
  assert.match(ok.headers.get('access-control-allow-headers') ?? '', /Authorization/);
  const bad = await fetch(`${base}/dymo/print`, { method: 'OPTIONS', headers: { Origin: 'https://evil.example', 'Access-Control-Request-Private-Network': 'true' } });
  assert.equal(bad.status, 403);
  assert.equal(bad.headers.get('access-control-allow-private-network'), null);
});

test('printer command without or with a wrong token is refused', async () => {
  sent.length = 0;
  assert.equal((await fetch(`${base}/printer/command`, json({ type: 'pause', flowntPrinterId: 'f1' }, { Origin: FLOWNT }))).status, 401);
  assert.equal((await fetch(`${base}/printer/command`, json({ type: 'pause' }, { Origin: FLOWNT, Authorization: 'Bearer 33333333-3333-4333-8333-333333333333' }))).status, 401);
  // A valid token of another printer cannot act on this one.
  const mismatch = await fetch(`${base}/printer/command`, json({ type: 'stop', flowntPrinterId: 'f1' }, { Origin: FLOWNT, Authorization: `Bearer ${T2}` }));
  assert.equal(mismatch.status, 403);
  assert.equal(sent.length, 0);
});

test('valid token + allowed origin reaches exactly that printer', async () => {
  sent.length = 0;
  const res = await fetch(`${base}/printer/command`, json({ type: 'pause', flowntPrinterId: 'f1' }, { Origin: FLOWNT, Authorization: `Bearer ${T1}` }));
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('access-control-allow-origin'), FLOWNT);
  assert.deepEqual(sent, [{ printer: 'p1', cmd: { type: 'pause' } }]);
  // Token alone identifies the printer; scripts on this machine (no Origin) need it too.
  const local = await fetch(`${base}/printer/command`, json({ type: 'resume' }, { Authorization: `Bearer ${T2.toUpperCase()}` }));
  assert.equal(local.status, 200);
  assert.deepEqual(sent[1], { printer: 'p2', cmd: { type: 'resume' } });
  assert.equal((await fetch(`${base}/printer/command`, json({ type: 'explode' }, { Authorization: `Bearer ${T1}` }))).status, 400);
});

test('/dymo/print: other origins refused; local browser with allowed origin passes; scripts need a token', async () => {
  assert.equal((await fetch(`${base}/dymo/print`, json({}, { Origin: 'https://evil.example' }))).status, 403);
  assert.equal((await fetch(`${base}/dymo/print`, json({}))).status, 401);
  assert.equal((await fetch(`${base}/dymo/print`, json({}, { Authorization: 'Bearer nope' }))).status, 401);
  // Auth passes → validation answers (no Dymo call with an empty body).
  assert.equal((await fetch(`${base}/dymo/print`, json({}, { Origin: FLOWNT }))).status, 400);
  assert.equal((await fetch(`${base}/dymo/print`, json({}, { Authorization: `Bearer ${T2}` }))).status, 400);
});

test('/api/version is readable by Flownt and announces bearer command auth', async () => {
  const res = await fetch(`${base}/api/version`, { headers: { Origin: FLOWNT } });
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('access-control-allow-origin'), FLOWNT);
  const body = await res.json() as { version: string; command_auth: string };
  assert.equal(body.command_auth, 'bearer');
  assert.match(body.version, /^\d+\.\d+\.\d+/);
});

function csrfFrom(page: string): string {
  const m = /name="_csrf" value="([^"]+)"/.exec(page);
  assert.ok(m, 'form carries a CSRF token');
  return m[1];
}
const form = (fields: Record<string, string>, headers: Record<string, string> = {}) => ({
  method: 'POST', redirect: 'manual' as const,
  headers: { 'Content-Type': 'application/x-www-form-urlencoded', ...headers },
  body: new URLSearchParams(fields).toString(),
});

test('setup POST without CSRF token, or cross-site, is refused', async () => {
  const before = loadMultiConfig().language;
  assert.equal((await fetch(`${base}/language`, form({ lang: 'de' }))).status, 403);
  const token = csrfFrom(await (await fetch(`${base}/setup`)).text());
  assert.equal((await fetch(`${base}/language`, form({ lang: 'de', _csrf: 'wrong' }))).status, 403);
  // Valid token but posted from another site.
  assert.equal((await fetch(`${base}/language`, form({ lang: 'de', _csrf: token }, { Origin: 'https://evil.example' }))).status, 403);
  assert.equal((await fetch(`${base}/language`, form({ lang: 'de', _csrf: token }, { 'Sec-Fetch-Site': 'cross-site' }))).status, 403);
  assert.equal(loadMultiConfig().language, before);
  // Same origin (as through an SSH tunnel on any local port) works.
  const ok = await fetch(`${base}/language`, form({ lang: 'en', _csrf: token, returnUrl: '/setup' }, { Origin: base, 'Sec-Fetch-Site': 'same-origin' }));
  assert.equal(ok.status, 302);
  assert.equal(ok.headers.get('location'), '/setup');
});

test('setup pages never contain stored secrets, and empty secret fields keep them', async () => {
  for (const id of ['p1', 'p2']) {
    const page = await (await fetch(`${base}/setup/${id}`)).text();
    for (const secret of [T1, T2, ACCESS_CODE, CLOUD_PW, MOON_KEY, CLOUD_ACCESS, CLOUD_REFRESH]) assert.ok(!page.includes(secret), `${id} page leaks ${secret}`);
    assert.ok(page.includes('••••'));
  }
  const page = await (await fetch(`${base}/setup/p1`)).text();
  assert.equal(page.match(/X-Frame-Options/), null); // header, not markup
  const res = await fetch(`${base}/setup/p1`, form({
    _csrf: csrfFrom(page), name: 'X1C renamed', token: '', adapterType: 'bambu', bambuUrl: '10.0.0.5',
    bambuSerial: '00M000', bambuCode: '', bambuCloudEmail: 'a@b.c', bambuCloudPassword: '',
  }));
  assert.equal(res.status, 302);
  const p1 = loadMultiConfig().printers.find(p => p.id === 'p1')!;
  assert.equal(p1.name, 'X1C renamed');
  assert.equal(p1.flowntAuthToken, T1);
  assert.equal(p1.adapterApiKey, ACCESS_CODE);
  assert.equal(p1.bambuCloudPassword, CLOUD_PW);
  assert.equal(p1.flowntPrinterId, 'f1');
  assert.equal(p1.managed, true);
  assert.deepEqual(p1.bambuCloudToken, { accessToken: CLOUD_ACCESS, refreshToken: CLOUD_REFRESH });
});

test('setup UI sends anti-framing headers', async () => {
  const res = await fetch(`${base}/setup`);
  assert.equal(res.headers.get('x-frame-options'), 'DENY');
  assert.equal(res.headers.get('cache-control'), 'no-store');
});

function rawGet(path: string, host: string): Promise<number> {
  const url = new URL(base);
  return new Promise((resolve, reject) => {
    const req = httpRequest({ hostname: url.hostname, port: url.port, path, headers: { Host: host } }, res => { res.resume(); resolve(res.statusCode ?? 0); });
    req.on('error', reject);
    req.end();
  });
}

test('DNS-rebinding hosts are refused, local names accepted', async () => {
  assert.equal(await rawGet('/setup', 'attacker.example.com:7432'), 403);
  assert.equal(await rawGet('/setup', 'localhost:7432'), 200);
  assert.equal(await rawGet('/setup', '192.168.1.20:7432'), 200);
  assert.equal(await rawGet('/setup', 'raspberrypi.local:7432'), 200);
});

test('admin password protects the setup UI with a session cookie', async () => {
  const { server: s2, base: b2 } = await listen(createApp(callbacks, { adminPassword: 'hunter2-long', port: 1 }).app);
  try {
    const redirect = await fetch(`${b2}/setup`, { redirect: 'manual' });
    assert.equal(redirect.status, 302);
    assert.equal(redirect.headers.get('location'), '/login?next=%2Fsetup');
    assert.equal((await fetch(`${b2}/api/state`)).status, 401);
    // Browser API stays reachable without the admin login.
    assert.equal((await fetch(`${b2}/api/version`)).status, 200);
    const login = await (await fetch(`${b2}/login?next=/setup`)).text();
    const csrf = csrfFrom(login);
    assert.equal((await fetch(`${b2}/login`, form({ _csrf: csrf, password: 'wrong', next: '/setup' }))).status, 401);
    const ok = await fetch(`${b2}/login`, form({ _csrf: csrf, password: 'hunter2-long', next: '//evil.example/x' }));
    assert.equal(ok.status, 302);
    assert.equal(ok.headers.get('location'), '/');
    const cookie = ok.headers.get('set-cookie')!.split(';')[0];
    assert.match(ok.headers.get('set-cookie')!, /HttpOnly; SameSite=Strict/);
    assert.equal((await fetch(`${b2}/setup`, { headers: { Cookie: cookie } })).status, 200);
    assert.equal((await fetch(`${b2}/api/state`, { headers: { Authorization: 'Bearer hunter2-long' } })).status, 200);
  } finally {
    await close(s2);
  }
});

test('/healthz reports versions and per-printer state without secrets; providers plug in', async () => {
  const { registerHealthProvider } = await import('../src/health-registry.js');
  const { CONTRACT_VERSION } = await import('../src/contract.js');
  const off = registerHealthProvider('outbox', () => ({ queued: 2 }));
  const offBroken = registerHealthProvider('broken', () => { throw new Error('nope'); });
  try {
    const res = await fetch(`${base}/healthz`);
    assert.equal(res.status, 200);
    const text = await res.text();
    for (const secret of [T1, T2, ACCESS_CODE, CLOUD_PW, MOON_KEY]) assert.ok(!text.includes(secret));
    const body = JSON.parse(text);
    assert.equal(body.contract_version, CONTRACT_VERSION);
    assert.match(body.bridge_version, /^\d+\.\d+\.\d+/);
    assert.equal(typeof body.uptime_s, 'number');
    assert.deepEqual(body.outbox, { queued: 2 });
    assert.deepEqual(body.providers.broken, { error: 'nope' });
    const p1 = body.printers.find((p: { id: string }) => p.id === 'p1');
    assert.equal(p1.adapter_type, 'bambu');
    assert.equal(p1.connected, false);
    assert.ok('last_message_age_s' in p1 && 'status' in p1);
  } finally {
    off(); offBroken();
  }
});

test('/diagnostics.zip is redacted and refuses cross-site requests', async () => {
  const { unzipSync, strFromU8 } = await import('fflate');
  const { createLogger } = await import('../src/logger.js');
  createLogger('test').info(`leaky line token=${T1} rtsps://bblp:${ACCESS_CODE}@10.0.0.5:322/x Bearer abc.def`);
  const stored = loadMultiConfig();
  stored.printers[0].bambuCloudToken = { accessToken: CLOUD_ACCESS, refreshToken: CLOUD_REFRESH, expiresAt: 1 };
  saveMultiConfig(stored);
  assert.equal((await fetch(`${base}/diagnostics.zip`, { headers: { 'Sec-Fetch-Site': 'cross-site' } })).status, 403);
  const res = await fetch(`${base}/diagnostics.zip`);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('content-type'), 'application/zip');
  const files = unzipSync(new Uint8Array(await res.arrayBuffer()));
  assert.deepEqual(Object.keys(files).sort(), ['config.redacted.json', 'events.json', 'health.json', 'recent.log', 'versions.json']);
  for (const [name, data] of Object.entries(files)) {
    const text = strFromU8(data);
    for (const secret of [T1, T2, ACCESS_CODE, CLOUD_PW, MOON_KEY, CLOUD_ACCESS, CLOUD_REFRESH, 'abc.def']) assert.ok(!text.includes(secret), `${name} leaks ${secret}`);
  }
  const cfg = JSON.parse(strFromU8(files['config.redacted.json']));
  assert.equal(cfg.printers[0].flowntAuthToken, '[redacted]');
  assert.equal(cfg.printers[0].adapterSerial, '00M000');
  assert.deepEqual(cfg.printers[0].bambuCloudToken, { accessToken: '[redacted]', expiresAt: 1 });
  assert.match(strFromU8(files['recent.log']), /leaky line token=\[redacted\]/);
});
