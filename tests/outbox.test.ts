import assert from 'node:assert/strict';
import { join } from 'node:path';
import { test } from 'node:test';
import type { IngestBody } from '../src/contract.js';
import { Outbox } from '../src/outbox.js';
import { Clock, FakeBackend, tempDir } from './helpers/bridge.js';

const body = (id: string): IngestBody => ({ auth_token: 't', event_type: 'job_complete', source_job_id: id, contract_version: 2 });

test('a failed push is retried with backoff and delivered exactly once', async () => {
  const dir = tempDir(), clock = new Clock(), be = new FakeBackend();
  const ob = new Outbox(join(dir, 'outbox.json'), be.send, clock.now);
  be.respond = () => new Error('ECONNRESET');
  ob.enqueue('p1', 'P1', body('a'));
  await ob.flush();
  assert.deepEqual(ob.stats(), { pending: 1, oldestAgeS: 0, awaitingMaterial: 0, rejected: 0 });
  await ob.flush(); // not due yet (5 s backoff)
  assert.equal(be.attempts('job_complete'), 1);
  clock.t += 5_000;
  be.respond = () => 503;
  await ob.flush();
  assert.equal(be.attempts('job_complete'), 2);
  clock.t += 9_000;
  await ob.flush(); // 10 s backoff after the 2nd failure
  assert.equal(be.attempts('job_complete'), 2);
  clock.t += 1_000;
  be.respond = () => 200;
  await ob.flush();
  clock.t += 60_000;
  await ob.flush();
  assert.equal(be.delivered('job_complete').length, 1);
  assert.equal(be.attempts('job_complete'), 3);
  assert.deepEqual(ob.stats(), { pending: 0, oldestAgeS: null, awaitingMaterial: 0, rejected: 0 });
});

test('the outbox survives a restart', async () => {
  const dir = tempDir(), clock = new Clock(), be = new FakeBackend();
  be.respond = () => 500;
  const first = new Outbox(join(dir, 'outbox.json'), be.send, clock.now);
  first.enqueue('p1', 'P1', body('a'));
  await first.flush();
  clock.t += 120_000;
  be.respond = () => 200;
  const second = new Outbox(join(dir, 'outbox.json'), be.send, clock.now);
  assert.deepEqual(second.stats(), { pending: 1, oldestAgeS: 120, awaitingMaterial: 0, rejected: 0 });
  await second.flush();
  assert.equal(be.delivered().length, 1);
  assert.equal(new Outbox(join(dir, 'outbox.json'), be.send, clock.now).stats().pending, 0);
});

test('4xx drops the entry (no poisoning), 408/429 are retried', async () => {
  const dir = tempDir(), clock = new Clock(), be = new FakeBackend();
  const ob = new Outbox(join(dir, 'outbox.json'), be.send, clock.now);
  be.respond = b => (b.source_job_id === 'bad' ? 401 : 429);
  ob.enqueue('p1', 'P1', body('bad'));
  ob.enqueue('p1', 'P1', body('busy'));
  await ob.flush();
  assert.deepEqual(ob.pending().map(e => e.body.source_job_id), ['busy']);
  clock.t += 5_000;
  be.respond = () => 200;
  await ob.flush();
  assert.equal(ob.stats().pending, 0);
});

test('concurrent flushes from several printers send each entry once', async () => {
  const dir = tempDir(), clock = new Clock(), be = new FakeBackend();
  const ob = new Outbox(join(dir, 'outbox.json'), be.send, clock.now);
  ob.enqueue('p1', 'P1', body('a'));
  ob.enqueue('p2', 'P2', body('b'));
  await Promise.all([ob.flush(), ob.flush(), ob.flush()]);
  assert.equal(be.calls.length, 2);
});
