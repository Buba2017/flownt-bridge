import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  AdminAuth, envAllowedOrigins, hostPolicy, isLoopbackAddress, isLoopbackBind, isSameOriginRequest,
  normalizeOrigin, originPolicy, safeEqual,
} from '../src/http-auth.js';

test('origin policy: defaults, local dev, env (new + legacy var) and saved extras', () => {
  const env = { FLOWNT_ALLOWED_ORIGINS: 'https://flownt.newmatik.com/', FLOWNT_CAMERA_ORIGINS: 'https://cam.example' };
  let saved = ['https://self.example'];
  const allowed = originPolicy(() => saved, env);
  for (const o of ['https://flownt.app', 'https://www.flownt.app', 'capacitor://localhost', 'https://localhost',
    'http://localhost:5173', 'http://127.0.0.1:4173', 'http://localhost:7432', 'https://flownt.newmatik.com',
    'https://cam.example', 'https://self.example']) {
    assert.ok(allowed(o), o);
  }
  for (const o of ['https://evil.example', 'http://flownt.app', 'https://flownt.app.evil.example', 'null', '',
    'http://localhost.evil.example', 'https://localhost:8443']) {
    assert.ok(!allowed(o), o);
  }
  saved = [];
  assert.ok(!allowed('https://self.example'), 'saved origins are read per call');
  assert.deepEqual(envAllowedOrigins({ FLOWNT_CAMERA_ORIGINS: 'https://a.example, bogus, https://b.example/path' }), ['https://a.example']);
  assert.equal(normalizeOrigin('HTTPS://Flownt.Example/'), 'https://flownt.example');
});

test('host policy blocks public names (DNS rebinding) but accepts local ones', () => {
  const ok = hostPolicy({ FLOWNT_BRIDGE_ALLOWED_HOSTS: 'bridge.example.com', FLOWNT_PUBLIC_URL: 'https://cam.example.org' });
  for (const h of ['localhost:7432', '127.0.0.1:7432', '[::1]:7432', '10.1.0.5', 'raspberrypi:7432', 'pi.local',
    'printer.lan', 'bridge.example.com:443', 'cam.example.org']) assert.ok(ok(h), h);
  for (const h of ['evil.example.com:7432', 'localhost.evil.com', '', undefined]) assert.ok(!ok(h), String(h));
});

test('loopback detection', () => {
  for (const a of ['127.0.0.1', '::1', '::ffff:127.0.0.1', '127.1.2.3']) assert.ok(isLoopbackAddress(a), a);
  for (const a of ['10.0.0.1', '::ffff:10.0.0.1', undefined]) assert.ok(!isLoopbackAddress(a), String(a));
  assert.ok(isLoopbackBind('localhost'));
  assert.ok(isLoopbackBind('[::1]'));
  assert.ok(!isLoopbackBind('0.0.0.0'));
  assert.ok(!isLoopbackBind('::'));
});

test('same-origin check compares Origin/Referer with Host and honours Sec-Fetch-Site', () => {
  const h = (headers: Record<string, string>) => ({ headers: { host: 'localhost:9000', ...headers } });
  assert.ok(isSameOriginRequest(h({ origin: 'http://localhost:9000' })));
  assert.ok(isSameOriginRequest(h({ referer: 'http://localhost:9000/setup' })));
  assert.ok(isSameOriginRequest(h({})));
  assert.ok(!isSameOriginRequest(h({ origin: 'http://localhost:7432' })));
  assert.ok(!isSameOriginRequest(h({ origin: 'null' })));
  assert.ok(!isSameOriginRequest(h({ 'sec-fetch-site': 'same-site' })));
});

test('safeEqual and admin sessions', () => {
  assert.ok(safeEqual('abc', 'abc'));
  assert.ok(!safeEqual('abc', 'abcd'));
  let now = 0;
  const admin = new AdminAuth('pw-123456', 7432, () => now);
  assert.equal(admin.login('nope', '1.2.3.4'), null);
  const id = admin.login('pw-123456', '1.2.3.4')!;
  assert.ok(admin.check({ headers: { cookie: `other=1; ${admin.cookieName}=${id}` } }));
  now += 13 * 60 * 60 * 1000;
  assert.ok(!admin.check({ headers: { cookie: `${admin.cookieName}=${id}` } }), 'session expires');
  for (let i = 0; i < 10; i++) admin.login('wrong', '5.6.7.8');
  assert.ok(admin.locked('5.6.7.8'));
  assert.equal(admin.login('pw-123456', '5.6.7.8'), null, 'locked out after repeated failures');
  assert.ok(new AdminAuth(undefined, 1).check({ headers: {} }), 'no password = open');
});
