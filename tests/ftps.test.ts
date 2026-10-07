import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { strToU8, zipSync } from 'fflate';
import { BambuAdapter } from '../src/adapters/bambu.js';
import { ftpsDownload, FtpsError, FtpsOptions, parseList, resetFtpsState, withFtps } from '../src/adapters/ftps.js';
import { waitFor } from './helpers/broker.js';
import { startFakeFtps } from './helpers/ftps-server.js';

// Our FTPS client against a fake printer: every failure is bounded, nothing hangs.

const FILE = Buffer.alloc(200_000, 7);
const fast = (port: number, extra: FtpsOptions = {}): FtpsOptions => ({
  port, baseTimeoutMs: 1_000, inactivityMs: 300, retries: 2, retryDelayMs: 20, ...extra,
});
const retrs = (cmds: string[]) => cmds.filter(c => c.startsWith('RETR')).length;

afterEach(() => resetFtpsState());

test('downloads a file (SIZE, RETR, 226)', async () => {
  const srv = await startFakeFtps({ '/cache/Box.gcode.3mf': FILE });
  try {
    const buf = await ftpsDownload('127.0.0.1', 'code', '/cache/Box.gcode.3mf', fast(srv.port));
    assert.ok(buf.equals(FILE));
    assert.ok(srv.commands.includes('SIZE /cache/Box.gcode.3mf'));
  } finally { await srv.close(); }
});

test('550 is permanent: no retry, no data connection', async () => {
  const srv = await startFakeFtps({});
  try {
    await assert.rejects(ftpsDownload('127.0.0.1', 'code', '/cache/x.3mf', fast(srv.port)),
      (e: unknown) => e instanceof FtpsError && e.code === 550);
    assert.equal(srv.commands.filter(c => c.startsWith('USER')).length, 1);
    assert.equal(retrs(srv.commands), 0);
  } finally { await srv.close(); }
});

test('transfer stalling mid-file fails within the deadline after bounded retries', async () => {
  const srv = await startFakeFtps({ '/a.3mf': FILE });
  srv.fault = () => 'stall';
  try {
    const t0 = Date.now();
    await assert.rejects(ftpsDownload('127.0.0.1', 'code', '/a.3mf', fast(srv.port)), /stalled|timeout|closed/);
    assert.ok(Date.now() - t0 < 4_000, `took ${Date.now() - t0} ms`);
    assert.equal(retrs(srv.commands), 3); // 1 + 2 retries
  } finally { await srv.close(); }
});

test('a stalled first attempt is retried and then succeeds', async () => {
  const srv = await startFakeFtps({ '/a.3mf': FILE });
  srv.fault = i => (i === 0 ? 'stall' : undefined);
  try {
    assert.ok((await ftpsDownload('127.0.0.1', 'code', '/a.3mf', fast(srv.port))).equals(FILE));
  } finally { await srv.close(); }
});

test('missing 226 and 426 count as failed transfers', async () => {
  for (const fault of ['no226', '426'] as const) {
    const srv = await startFakeFtps({ '/a.3mf': FILE });
    srv.fault = () => fault;
    try {
      await assert.rejects(ftpsDownload('127.0.0.1', 'code', '/a.3mf', fast(srv.port, { retries: 0 })), fault === '426' ? /426/ : /closed/);
    } finally { await srv.close(); }
  }
});

test('server that never greets: deadline, no hang', async () => {
  const srv = await startFakeFtps({});
  srv.fault = () => 'noGreeting';
  try {
    const t0 = Date.now();
    await assert.rejects(withFtps('127.0.0.1', 'code', async () => 1, fast(srv.port, { retries: 0, inactivityMs: 5_000 })), /timeout/);
    assert.ok(Date.now() - t0 < 2_000);
  } finally { await srv.close(); }
});

test('wrong access code (530) is not retried', async () => {
  const srv = await startFakeFtps({});
  try {
    await assert.rejects(withFtps('127.0.0.1', 'wrong', async () => 1, fast(srv.port)), /530/);
    assert.equal(srv.commands.filter(c => c.startsWith('USER')).length, 1);
  } finally { await srv.close(); }
});

test('connection refused → back off from this printer', async () => {
  const srv = await startFakeFtps({});
  const port = srv.port;
  await srv.close();
  await assert.rejects(withFtps('127.0.0.1', 'code', async () => 1, fast(port)));
  await assert.rejects(withFtps('127.0.0.1', 'code', async () => 1, fast(port)), /paused/);
});

test('LIST parsing (vsftpd format)', () => {
  const text = 'drwxr-xr-x    2 0        0            4096 Oct 06 12:00 My Prints\r\n'
    + '-rw-r--r--    1 0        0          123456 Oct 06 12:00 Box v2.gcode.3mf\r\n'
    + '-rw-r--r--    1 0        0               5 Jan 01  2025 old.txt\r\n';
  assert.deepEqual(parseList(text), [
    { name: 'My Prints', isDir: true, size: null },
    { name: 'Box v2.gcode.3mf', isDir: false, size: 123456 },
    { name: 'old.txt', isDir: false, size: 5 },
  ]);
});

// ── adapter: print file fetch ──────────────────────────────────────────────────────

const threeMf = Buffer.from(zipSync({
  'Metadata/slice_info.config': strToU8('<config><plate><metadata key="index" value="1"/><metadata key="prediction" value="3600"/>'
    + '<filament id="1" used_g="12.5" color="#FFFFFF"/></plate></config>'),
}));
const running = (name: string, task = '5') => JSON.stringify({ print: { command: 'push_status', gcode_state: 'RUNNING', subtask_name: name, task_id: task, mc_percent: 10 } });

function adapter(port: number, extra: Record<string, unknown> = {}) {
  return new BambuAdapter('127.0.0.1', 'S', 'code', 'p', { autoConnect: false, ftps: fast(port), ...extra });
}

test('adapter finds a file started from the SD card in a sub folder via LIST', async () => {
  const srv = await startFakeFtps({ '/My Prints/Box v2.gcode.3mf': threeMf, '/cache/other.gcode.3mf': threeMf });
  try {
    const a = adapter(srv.port);
    a.handleMessage(running('Box v2'));
    const s = await waitFor(async () => { const s = await a.getSnapshot(); return s.parsedFilamentWeights?.length && s; }, 5_000, 'weights');
    assert.deepEqual(s.parsedFilamentWeights, [{ filamentIndex: 1, grams: 12.5, color: '#FFFFFF', slicerOrder: 0 }]);
    assert.equal(s.estimatedDurationMin, 60);
    assert.ok(srv.commands.includes('LIST /My Prints'));
  } finally { await srv.close(); }
});

test('adapter fetches the file again after a failed attempt', async () => {
  const srv = await startFakeFtps({ '/cache/Box.gcode.3mf': threeMf });
  srv.fault = i => (i < 3 ? 'stall' : undefined); // the whole first attempt fails
  try {
    const a = adapter(srv.port, { fetchRetryMs: 50 });
    a.handleMessage(running('Box'));
    await waitFor(() => retrs(srv.commands) >= 3, 5_000, 'first attempt');
    await waitFor(async () => {
      a.handleMessage(running('Box')); // the next report triggers the retry once due
      return (await a.getSnapshot()).parsedFilamentWeights?.length;
    }, 8_000, 'weights after retry');
  } finally { await srv.close(); }
});

test('job in internal storage (project_file url file:///userdata): looked for once on the card, then left alone', async () => {
  const srv = await startFakeFtps({});
  try {
    const a = adapter(srv.port, { fetchRetryMs: 10 });
    a.handleMessage(JSON.stringify({ print: { command: 'project_file', url: 'file:///userdata/project_file.gcode.3mf', subtask_name: 'Body', result: 'SUCCESS', sequence_id: '1' } }));
    a.handleMessage(running('Body'));
    await waitFor(() => srv.commands.some(c => c === 'QUIT'), 5_000, 'search done');
    const n = srv.commands.length;
    for (let i = 0; i < 5; i++) { a.handleMessage(running('Body')); await new Promise(r => setTimeout(r, 20)); }
    assert.equal(srv.commands.length, n, 'no second search');
    assert.deepEqual(await a.refetchJobWeights('Body', 1), { kind: 'internal' });
  } finally { await srv.close(); }
});

test('X1C reprint reported in /data/: the file is still found on the card', async () => {
  const srv = await startFakeFtps({ '/cache/Distanzspangen.gcode.3mf': threeMf });
  try {
    const a = adapter(srv.port);
    a.handleMessage(JSON.stringify({ print: { command: 'project_file', url: 'file:///data/Metadata/plate_1.gcode', subtask_name: 'Distanzspangen', result: 'SUCCESS', sequence_id: '1' } }));
    a.handleMessage(running('Distanzspangen'));
    await waitFor(async () => (await a.getSnapshot()).parsedFilamentWeights?.length, 5_000, 'weights loaded');
  } finally { await srv.close(); }
});

test('file not on the card: looked for once per job, then left alone', async () => {
  const srv = await startFakeFtps({ '/cache/unrelated.gcode.3mf': threeMf });
  try {
    const a = adapter(srv.port, { fetchRetryMs: 10 });
    a.handleMessage(running('Oberschale'));
    await waitFor(() => srv.commands.some(c => c === 'QUIT'), 5_000, 'search done');
    const n = srv.commands.length;
    for (let i = 0; i < 5; i++) { a.handleMessage(running('Oberschale')); await new Promise(r => setTimeout(r, 20)); }
    assert.equal(srv.commands.length, n);
  } finally { await srv.close(); }
});
