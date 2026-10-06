import assert from 'node:assert/strict';
import { join } from 'node:path';
import { test } from 'node:test';
import { BambuAdapter } from '../src/adapters/bambu.js';
import type { PrinterSnapshot } from '../src/adapters/types.js';
import { Outbox } from '../src/outbox.js';
import { Clock, FakeBackend, runSteps, tempDir } from './helpers/bridge.js';
import { json, loadFrame } from './helpers/fixtures.js';

// The bridge loop with a scripted adapter, a fake backend and a fake clock (30 s/poll).

const printing = (extra: Partial<PrinterSnapshot> = {}): PrinterSnapshot => ({
  status: 'printing', jobState: 'printing', jobKey: 'task:1', printFile: 'Box', progressPct: 50, ...extra,
});
const finished = (extra: Partial<PrinterSnapshot> = {}): PrinterSnapshot => ({
  status: 'idle', jobState: 'finished', jobResult: 'completed', jobKey: 'task:1', printFile: 'Box', progressPct: 100, ...extra,
});
const repeat = <T>(n: number, f: () => T) => Array.from({ length: n }, () => f);

test('every push carries the contract version', async () => {
  const dir = tempDir(), be = new FakeBackend();
  await runSteps([() => printing()], { dir, backend: be, clock: new Clock() });
  assert.ok(be.calls.length >= 2);
  assert.ok(be.calls.every(c => c.body.contract_version === 2));
});

test('job end push fails → stored, resent exactly once after recovery', async () => {
  const dir = tempDir(), be = new FakeBackend();
  let fail = true;
  be.respond = b => (b.event_type === 'job_complete' && fail ? 503 : 200);
  const steps = [() => printing(), () => printing({ progressPct: 99 }), () => finished(),
    ...repeat(3, () => finished()), () => { fail = false; return finished(); }, ...repeat(4, () => finished())];
  await runSteps(steps, { dir, backend: be, clock: new Clock() });
  const done = be.delivered('job_complete');
  assert.equal(done.length, 1);
  assert.ok(be.attempts('job_complete') > 1);
  assert.equal(done[0].source_job_id, `task:1@${Math.round(Date.parse('2026-10-06T12:00:00Z') / 1000)}`);
  assert.equal(be.delivered('job_failed').length, 0);
});

test('restart mid-print keeps start time, mapping and weights', async () => {
  const dir = tempDir(), be = new FakeBackend(), clock = new Clock();
  const t0 = clock.t;
  // Bridge run 1: job starts; mapping and slicer weights are known.
  await runSteps([
    () => printing({ progressPct: 1, filamentMapping: [65535, 259], parsedFilamentWeights: [{ filamentIndex: 2, grams: 12.5, color: '#FFFFFF' }] }),
    () => printing({ progressPct: 5 }),
  ], { dir, backend: be, clock });
  // Bridge down for 2 h; run 2 sees the job without mapping/weights (file not fetched yet).
  clock.t += 2 * 3600_000;
  await runSteps([() => printing({ progressPct: 97 }), () => finished(), () => finished()], { dir, backend: be, clock });
  const [done] = be.delivered('job_complete');
  assert.ok(done, 'job_complete sent');
  assert.equal(done.source_job_id, `task:1@${Math.round(t0 / 1000)}`);
  assert.ok(done.duration_min! >= 120 && done.duration_min! <= 125, `duration ${done.duration_min}`);
  assert.deepEqual(done.filament_weights?.map(l => [l.filamentIndex, l.grams]), [[7, 12.5]]);
});

test('connection drop mid-print is not a new job', async () => {
  const dir = tempDir(), be = new FakeBackend(), clock = new Clock();
  const t0 = clock.t;
  await runSteps([
    () => printing({ progressPct: 10, filamentMapping: [0], parsedFilamentWeights: [{ filamentIndex: 1, grams: 5 }] }),
    () => ({ ...printing(), status: 'offline', stale: true }),
    () => ({ ...printing(), status: 'idle', jobState: 'idle', stale: true }), // stale garbage must be ignored
    () => printing({ progressPct: 60 }),
    () => finished(),
  ], { dir, backend: be, clock });
  const done = be.delivered('job_complete');
  assert.equal(done.length, 1);
  assert.equal(done[0].duration_min, Math.round((clock.t - t0) / 60_000));
  assert.deepEqual(done[0].filament_weights?.map(l => l.filamentIndex), [0]);
});

test('Bambu partial frames mid-print produce no job event', async () => {
  const dir = tempDir(), be = new FakeBackend();
  const a = new BambuAdapter('192.0.2.1', 'TESTSERIAL', 'code', 'p1', { autoConnect: false, fetchFiles: false });
  const noState = loadFrame('x2d', 'running-mid-print');
  delete noState.print!.gcode_state;
  const frames = [
    json(loadFrame('x2d', 'running-mid-print')),
    JSON.stringify({ print: { command: 'push_status', mc_percent: 53 } }),
    json(noState),
    json(loadFrame('h2c', 'running-truncated-no-gcode-state')),
    json(loadFrame('x2d', 'running-late')),
  ];
  const step = (f: string) => async () => { a.handleMessage(f); return a.getSnapshot(); };
  await runSteps(frames.map(step), { dir, backend: be, clock: new Clock() });
  assert.equal(be.attempts('job_complete') + be.attempts('job_failed'), 0);
  // ... and the real end is reported once.
  await runSteps([step(JSON.stringify({ print: { command: 'push_status', gcode_state: 'FINISH', mc_percent: 100 } })), step('{}')],
    { dir, backend: be, clock: new Clock() });
  assert.equal(be.delivered('job_complete').length, 1);
});

test('PREPARE → FAILED ends as a failed job', async () => {
  const dir = tempDir(), be = new FakeBackend();
  await runSteps([
    () => printing({ jobState: 'preparing', progressPct: 0 }),
    () => ({ status: 'error', jobState: 'failed', jobResult: 'failed', jobKey: 'task:1', printFile: 'Box', progressPct: 0 }),
    () => ({ status: 'error', jobState: 'failed', jobResult: 'failed', jobKey: 'task:1', printFile: 'Box', progressPct: 0 }),
  ], { dir, backend: be, clock: new Clock() });
  assert.equal(be.delivered('job_failed').length, 1);
  assert.equal(be.delivered('job_complete').length, 0);
});

test('a job that ended while the bridge was down is still reported', async () => {
  const dir = tempDir(), be = new FakeBackend(), clock = new Clock();
  await runSteps([() => printing({ progressPct: 99 })], { dir, backend: be, clock });
  clock.t += 3600_000;
  // After the restart the printer already runs the next job.
  await runSteps([() => printing({ jobKey: 'task:2', progressPct: 3 }), () => printing({ jobKey: 'task:2', progressPct: 4 })],
    { dir, backend: be, clock });
  assert.equal(be.delivered('job_complete').length, 1);
  assert.equal(be.delivered('job_complete')[0].source_job_id?.startsWith('task:1@'), true);
});

test('outbox shared by the bridge is the one passed in', async () => {
  const dir = tempDir(), be = new FakeBackend(), clock = new Clock();
  be.respond = b => (b.event_type === 'job_complete' ? 500 : 200);
  const outbox = new Outbox(join(dir, 'ob.json'), be.send, clock.now);
  await runSteps([() => printing(), () => finished()], { dir, backend: be, clock, outbox });
  assert.equal(outbox.stats().pending, 1);
});
