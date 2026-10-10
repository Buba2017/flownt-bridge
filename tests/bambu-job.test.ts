import assert from 'node:assert/strict';
import { test } from 'node:test';
import { BambuAdapter } from '../src/adapters/bambu.js';
import { isNewJob, isSystemJob, jobIdentity } from '../src/adapters/bambu-state.js';
import { json, loadFrame } from './helpers/fixtures.js';

// Job identity: a new print is recognised by its id, not by a status edge.

function adapter() {
  return new BambuAdapter('192.0.2.1', 'TESTSERIAL', 'code', 'p1', { autoConnect: false, fetchFiles: false });
}

test('LAN jobs (subtask_id "", job_id "0") are identified by task_id; "0" is never a job id', () => {
  const p = loadFrame('x2d', 'running-mid-print').print!;
  assert.equal(p.subtask_id, '');
  assert.equal(p.job_id, '0');
  assert.deepEqual(jobIdentity(p), { key: 'task:1403', sourceJobId: null });
  assert.deepEqual(jobIdentity({ subtask_id: '734561', job_id: '0', task_id: '12' }), { key: 'subtask:734561', sourceJobId: '734561' });
  assert.deepEqual(jobIdentity({ subtask_id: '0', job_id: '98765' }), { key: 'job:98765', sourceJobId: '98765' });
  assert.deepEqual(jobIdentity({ subtask_id: '', job_id: '0', task_id: '0', subtask_name: 'Box' }), { key: 'file:Box', sourceJobId: null });
});

test('new job: id change while busy, or ended → busy with the same file', () => {
  assert.equal(isNewJob('task:1', 'RUNNING', 'task:1', 'RUNNING'), false);
  assert.equal(isNewJob('task:1', 'RUNNING', 'task:2', 'PREPARE'), true);
  assert.equal(isNewJob('file:Box', 'FINISH', 'file:Box', 'PREPARE'), true);
  assert.equal(isNewJob('file:Box', 'FAILED', 'file:Box', 'IDLE'), false);
  assert.equal(isNewJob(null, undefined, 'task:1', 'RUNNING'), true); // bridge start mid-print
});

test('same job across partial and full frames, next job by task_id', async () => {
  const a = adapter();
  a.handleMessage(json(loadFrame('x2d', 'running-mid-print')));
  assert.equal((await a.getSnapshot()).jobKey, 'task:1403');
  a.handleMessage(JSON.stringify({ print: { command: 'push_status', mc_percent: 60 } }));
  a.handleMessage(json(loadFrame('x2d', 'running-late')));
  let s = await a.getSnapshot();
  assert.equal(s.jobKey, 'task:1403');
  assert.equal(s.sourceJobId, null);
  // FINISH, then the next job (captured: still RUNNING-ish frame with a new task_id).
  a.handleMessage(JSON.stringify({ print: { command: 'push_status', gcode_state: 'FINISH', mc_percent: 100 } }));
  s = await a.getSnapshot();
  assert.equal(s.jobState, 'finished');
  assert.equal(s.jobKey, 'task:1403');
  a.handleMessage(json(loadFrame('x2d', 'job-start-stale-layer')));
  s = await a.getSnapshot();
  assert.equal(s.jobKey, 'task:1115');
  assert.equal(s.parsedFilamentWeights, null);
});

test('job start without its own mapping drops the previous job\'s mapping', async () => {
  const a = adapter();
  a.handleMessage(json(loadFrame('x1c', 'running-ams-units-1-2')));
  a.handleMessage(JSON.stringify({ print: { command: 'push_status', gcode_state: 'FINISH' } }));
  a.handleMessage(JSON.stringify({ print: { command: 'push_status', gcode_state: 'PREPARE', task_id: '999', subtask_name: 'External' } }));
  const s = await a.getSnapshot();
  assert.equal(s.jobKey, 'task:999');
  assert.equal(s.filamentMapping, undefined);
});

test('printer routines (calibration after setup) are no print jobs', async () => {
  const { mkdtempSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { JobTracker, JobSessionStore } = await import('../src/job-session.js');
  // Captured from a new H2C right after setup (fields trimmed).
  const cali = { print: {
    command: 'push_status', gcode_state: 'RUNNING', print_type: 'system', mc_percent: 30,
    gcode_file: '/usr/etc/print/O1C2/holder_cali.gcode', subtask_name: 'holder_cali.gcode',
    task_id: '3126', subtask_id: '0', job_id: '0',
  } };
  assert.equal(isSystemJob(cali.print), true);
  assert.equal(isSystemJob({ print_type: 'local', gcode_file: '/data/Metadata/plate_1.gcode' }), false);
  assert.equal(isSystemJob({ print_type: 'cloud', gcode_file: '/data/Metadata/plate_2.gcode' }), false);

  const a = adapter();
  a.handleMessage(JSON.stringify(cali));
  const s = await a.getSnapshot();
  assert.equal(s.status, 'printing');
  assert.equal(s.systemJob, true);
  const tracker = new JobTracker('p1', new JobSessionStore(mkdtempSync(join(tmpdir(), 'flownt-jobs-'))), () => 1_000);
  assert.deepEqual(tracker.observe(s, null), {});
  assert.equal(tracker.session, null);

  // A session saved for the routine by an older bridge is dropped without a log.
  const store = new JobSessionStore(mkdtempSync(join(tmpdir(), 'flownt-jobs-')));
  const legacy = new JobTracker('p2', store, () => 1_000);
  assert.ok(legacy.observe({ ...s, systemJob: undefined }, null).started);
  assert.deepEqual(legacy.observe(s, null), {});
  assert.equal(legacy.session, null);
  assert.equal(new JobTracker('p2', store, () => 2_000).session, null, 'removed from disk too');

  // The next real print starts a job as usual.
  a.handleMessage(JSON.stringify({ print: { command: 'push_status', gcode_state: 'FINISH' } }));
  a.handleMessage(JSON.stringify({ print: {
    command: 'push_status', gcode_state: 'RUNNING', print_type: 'local', gcode_file: '/data/Metadata/plate_1.gcode',
    subtask_name: 'Oberschale', task_id: '4000',
  } }));
  const real = await a.getSnapshot();
  assert.equal(real.systemJob, false);
  assert.ok(tracker.observe(real, null).started);
});
