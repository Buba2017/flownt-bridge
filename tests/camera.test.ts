import assert from 'node:assert/strict';
import { test } from 'node:test';
import express from 'express';
import { BambuJpegParser, cameraLogin, JpegParser, MAX_FRAME_BYTES, multipartFrame } from '../src/camera/protocol.js';
import { CameraError, CameraRelay, resolveCameraSource, startCamera, type CameraListener, type CameraSource } from '../src/camera/relay.js';
import { registerCameraRoutes } from '../src/camera/routes.js';
import type { PrinterConfig } from '../src/config.js';

const jpeg = Buffer.from([0xff, 0xd8, 1, 2, 3, 0xff, 0xd9]);
const cfg: PrinterConfig = {
  id: 'local-printer-1', name: 'Test P1', adapterType: 'bambu', adapterUrl: '192.168.1.20',
  adapterApiKey: '12345678', adapterSerial: '01STEST', pollingIntervalMs: 30000,
  flowntAuthToken: '11111111-1111-4111-8111-111111111111',
};
const tick = () => new Promise<void>(resolve => setImmediate(resolve));

test('login encodes Bambu credentials at protocol offsets without leaking extra bytes', () => {
  const login = cameraLogin(cfg.adapterApiKey);
  assert.equal(login.length, 80);
  assert.equal(login.readUInt32LE(0), 0x40);
  assert.equal(login.readUInt32LE(4), 0x3000);
  assert.equal(login.subarray(16, 20).toString(), 'bblp');
  assert.equal(login.subarray(48, 56).toString(), cfg.adapterApiKey);
  assert.ok(login.subarray(56).every(byte => byte === 0));
  assert.throws(() => cameraLogin('a'.repeat(33)));
});

test('Bambu frames survive split headers, split payloads and coalesced frames', () => {
  const header = Buffer.alloc(16);
  header.writeUInt32LE(jpeg.length);
  const wire = Buffer.concat([header, jpeg, header, jpeg]);
  for (const chunkSize of [1, 3, 15, 17, wire.length]) {
    const parser = new BambuJpegParser();
    const frames: Buffer[] = [];
    for (let i = 0; i < wire.length; i += chunkSize) frames.push(...parser.push(wire.subarray(i, i + chunkSize)));
    assert.deepEqual(frames, [jpeg, jpeg]);
  }
});

test('Bambu parser rejects unreasonable sizes and non-JPEG frames', () => {
  for (const size of [0, 3, MAX_FRAME_BYTES + 1]) {
    const header = Buffer.alloc(16); header.writeUInt32LE(size);
    assert.throws(() => new BambuJpegParser().push(header));
  }
  const header = Buffer.alloc(16); header.writeUInt32LE(4);
  assert.throws(() => new BambuJpegParser().push(Buffer.concat([header, Buffer.alloc(4)])));
});

test('FFmpeg JPEG parser survives split SOI/EOI and multiple frames', () => {
  const parser = new JpegParser();
  const wire = Buffer.concat([jpeg, jpeg]);
  const frames = [...wire].flatMap(byte => parser.push(Buffer.from([byte])));
  assert.deepEqual(frames, [jpeg, jpeg]);
  assert.throws(() => new JpegParser().push(Buffer.concat([Buffer.from([0xff, 0xd8]), Buffer.alloc(MAX_FRAME_BYTES)])));
});

test('RTSP auto-detection, explicit overrides and reported endpoints stay on the configured printer', () => {
  assert.equal(resolveCameraSource(cfg).transport, 'jpeg');
  assert.equal(resolveCameraSource(cfg, 'disable').transport, 'jpeg');
  const x1 = { ...cfg, adapterSerial: '00MTEST' };
  for (const prefix of ['00M', '00W', '03W', '22E', '093', '094', '20P', '31B']) {
    assert.equal(resolveCameraSource({ ...cfg, adapterSerial: `${prefix}TEST` }).transport, 'rtsp');
  }
  assert.equal(resolveCameraSource(x1).rtspUrl, 'rtsps://bblp:12345678@192.168.1.20:322/streaming/live/1');
  const source = resolveCameraSource(cfg, 'rtsps://untrusted.example:322/streaming/live/2');
  assert.equal(new URL(source.rtspUrl!).hostname, cfg.adapterUrl);
  assert.equal(new URL(source.rtspUrl!).pathname, '/streaming/live/2');
  assert.equal(resolveCameraSource({ ...x1, cameraTransport: 'jpeg' }).transport, 'jpeg');
  assert.throws(() => resolveCameraSource(x1, 'disable'), /liveview_disabled/);
  assert.throws(() => resolveCameraSource(x1, 'file:///etc/passwd'), /invalid_camera_config/);
  assert.throws(() => resolveCameraSource({ ...cfg, adapterUrl: 'http://user:password@printer/' }));
});

test('viewers share one upstream; last unsubscribe stops it; printers stay isolated', async () => {
  const captures = new Map<string, CameraListener>();
  let starts = 0; let stops = 0;
  const relay = new CameraRelay((source, listener) => {
    starts++; captures.set(source.host, listener);
    return () => { stops++; };
  });
  const frames: Buffer[] = [];
  const listener: CameraListener = { frame: frame => frames.push(frame), error: () => {} };
  const source = resolveCameraSource(cfg);
  const off1 = relay.subscribe('one', source, listener);
  const off2 = relay.subscribe('one', source, { ...listener });
  const off3 = relay.subscribe('two', { ...source, host: '192.168.1.21' }, { frame: () => {}, error: () => {} });
  await tick();
  assert.equal(starts, 2);
  captures.get(source.host)!.frame(jpeg);
  assert.deepEqual(frames, [jpeg, jpeg]);
  off1(); assert.equal(stops, 0);
  off2(); assert.equal(stops, 1);
  off3(); assert.equal(stops, 2);
});

test('cancel before startup opens no camera; late failures cannot close a replacement', async () => {
  let starts = 0;
  const captures: CameraListener[] = [];
  const relay = new CameraRelay((_source, listener) => { starts++; captures.push(listener); return () => {}; });
  const listener: CameraListener = { frame: () => {}, error: () => {} };
  relay.subscribe('one', resolveCameraSource(cfg), listener)();
  await tick(); assert.equal(starts, 0);
  relay.subscribe('one', resolveCameraSource(cfg), listener);
  await tick();
  relay.invalidate('one');
  let received = false;
  const off = relay.subscribe('one', resolveCameraSource(cfg), { frame: () => { received = true; }, error: () => assert.fail('replacement closed') });
  await tick();
  captures[0].error(new CameraError('camera_unavailable'));
  captures[1].frame(jpeg);
  assert.equal(received, true);
  off();
  relay.dispose();
});

test('missing FFmpeg reports a safe actionable error without credential URLs', async () => {
  const previous = process.env.FLOWNT_FFMPEG_PATH;
  process.env.FLOWNT_FFMPEG_PATH = '/no-such-flownt-ffmpeg';
  try {
    const error = await new Promise<CameraError>(resolve => {
      startCamera({ transport: 'rtsp', host: cfg.adapterUrl, accessCode: cfg.adapterApiKey, rtspUrl: 'rtsps://bblp:12345678@127.0.0.1:322/streaming/live/1' }, {
        frame: () => assert.fail('unexpected frame'), error: resolve,
      });
    });
    assert.equal(error.code, 'ffmpeg_missing');
    assert.ok(!error.message.includes(cfg.adapterApiKey));
  } finally {
    if (previous === undefined) delete process.env.FLOWNT_FFMPEG_PATH;
    else process.env.FLOWNT_FFMPEG_PATH = previous;
  }
});

test('HTTP camera route authenticates the correct printer and streams multipart frames', async () => {
  let starts = 0; let stops = 0; const hosts: string[] = [];
  const relay = new CameraRelay((source: CameraSource, listener) => {
    starts++; hosts.push(source.host);
    const timer = setInterval(() => listener.frame(jpeg), 10);
    return () => { stops++; clearInterval(timer); };
  });
  const app = express();
  registerCameraRoutes(app, {
    printers: () => [cfg, { ...cfg, id: 'local-printer-2', adapterUrl: '192.168.1.21', flowntAuthToken: '22222222-2222-4222-8222-222222222222' }],
    reportedUrl: () => null, relay, allowedOrigins: ['https://flownt.app'],
  });
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>(resolve => server.once('listening', resolve));
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  const url = `http://127.0.0.1:${address.port}/camera/stream`;
  try {
    assert.equal((await fetch(url)).status, 401);
    assert.equal((await fetch(url, { headers: { Authorization: 'Bearer 33333333-3333-4333-8333-333333333333' } })).status, 401);
    assert.equal((await fetch(url, { headers: { Origin: 'https://untrusted.example', Authorization: `Bearer ${cfg.flowntAuthToken}` } })).status, 403);
    assert.equal(starts, 0);
    const preflight = await fetch(url, { method: 'OPTIONS', headers: { Origin: 'https://flownt.app', 'Access-Control-Request-Headers': 'authorization' } });
    assert.equal(preflight.status, 204);
    assert.equal(preflight.headers.get('access-control-allow-origin'), 'https://flownt.app');
    assert.equal(preflight.headers.get('access-control-allow-headers'), 'Authorization');
    const response = await fetch(url, { headers: { Origin: 'https://flownt.app', Authorization: 'Bearer 22222222-2222-4222-8222-222222222222' } });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.ok(response.headers.get('content-type')?.includes('multipart/x-mixed-replace'));
    const reader = response.body!.getReader();
    const { value } = await reader.read();
    assert.deepEqual(Buffer.from(value!), multipartFrame(jpeg));
    assert.deepEqual(hosts, ['192.168.1.21']);
    await reader.cancel();
    const deadline = Date.now() + 1000;
    while (!stops && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10));
    assert.equal(stops, 1);
  } finally {
    relay.dispose(); server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});

test('HTTP startup failure is JSON and can be retried without retaining an upstream', async () => {
  const relay = new CameraRelay((_source, listener) => { listener.error(new CameraError('ffmpeg_missing')); return () => {}; });
  const app = express();
  registerCameraRoutes(app, { printers: () => [cfg], reportedUrl: () => null, relay });
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>(resolve => server.once('listening', resolve));
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  try {
    for (let i = 0; i < 2; i++) {
      const response = await fetch(`http://127.0.0.1:${address.port}/camera/stream`, { headers: { Authorization: `Bearer ${cfg.flowntAuthToken}` } });
      assert.equal(response.status, 503);
      assert.deepEqual(await response.json(), { error: 'ffmpeg_missing' });
    }
  } finally {
    relay.dispose(); server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});
