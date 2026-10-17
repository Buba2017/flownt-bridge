import assert from 'node:assert/strict';
import { test } from 'node:test';
import { BambuAdapter, BambuAdapterOptions } from '../src/adapters/bambu.js';
import { getEventLog } from '../src/events.js';
import { startBroker, TestBroker, waitFor } from './helpers/broker.js';
import { loadFrame } from './helpers/fixtures.js';

// Adapter against an in-process MQTT broker: connection lifecycle.

const SERIAL = 'TESTSERIAL';
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
const pushalls = (b: TestBroker) => b.requests.filter(r => r.pushing?.command === 'pushall').length;

async function withAdapter(timings: BambuAdapterOptions['timings'], fn: (a: BambuAdapter, b: TestBroker, id: string) => Promise<void>) {
  const broker = await startBroker();
  const id = `p-${Math.random().toString(36).slice(2)}`;
  const a = new BambuAdapter('192.0.2.1', SERIAL, 'code', id, {
    brokerUrl: broker.url, fetchFiles: false,
    timings: { reconnectMinMs: 50, reconnectMaxMs: 200, watchdogTickMs: 25, ...timings },
  });
  try {
    await waitFor(() => pushalls(broker) >= 1, 3_000, 'first pushall');
    await fn(a, broker, id);
  } finally {
    a.dispose();
    await broker.close();
  }
}

test('connects, subscribes, asks for a full report and applies it', () => withAdapter({}, async (a, broker) => {
  assert.ok(broker.requests.some(r => r.info?.command === 'get_version'));
  await broker.publishReport(SERIAL, loadFrame('x2d', 'running-mid-print'));
  const s = await waitFor(async () => { const s = await a.getSnapshot(); return s.status === 'printing' && s; }, 3_000, 'printing');
  assert.equal(s.stale, false);
  assert.equal(s.jobKey, 'task:1403');
}));

test('reconnect keeps the last state and job, marks it stale and asks for a full report', () => withAdapter({}, async (a, broker) => {
  await broker.publishReport(SERIAL, loadFrame('x2d', 'running-mid-print'));
  await waitFor(async () => (await a.getSnapshot()).status === 'printing', 3_000, 'printing');
  const before = pushalls(broker);

  broker.dropClients();
  const offline = await waitFor(async () => { const s = await a.getSnapshot(); return s.status === 'offline' && s; }, 3_000, 'offline');
  assert.equal(offline.stale, true);
  assert.equal(offline.printFile, 'Oberschale');
  assert.equal(offline.jobKey, 'task:1403');
  assert.equal(offline.progressPct, 52);

  await waitFor(() => pushalls(broker) > before, 3_000, 'pushall after reconnect');
  const reconnected = await a.getSnapshot();
  assert.equal(reconnected.status, 'printing'); // last known, not idle
  assert.equal(reconnected.stale, true);

  // A partial frame does not confirm the state; the next report with gcode_state does.
  await broker.publishReport(SERIAL, { print: { command: 'push_status', mc_percent: 53 } });
  await waitFor(async () => (await a.getSnapshot()).progressPct === 53, 3_000, 'partial applied');
  assert.equal((await a.getSnapshot()).stale, true);
  await broker.publishReport(SERIAL, loadFrame('x2d', 'running-late'));
  const fresh = await waitFor(async () => { const s = await a.getSnapshot(); return s.stale === false && s; }, 3_000, 'fresh');
  assert.equal(fresh.jobKey, 'task:1403');
  assert.equal(fresh.progressPct, 95);
}));

test('silent session is rebuilt, but not while the printer prepares a job', () => withAdapter(
  { silenceMs: 150, prepareSilenceMs: 1_200 },
  async (a, broker) => {
    const prepare = loadFrame('x2d', 'job-start-stale-layer');
    prepare.print!.gcode_state = 'PREPARE';
    await broker.publishReport(SERIAL, prepare);
    await waitFor(async () => (await a.getSnapshot()).jobState === 'preparing', 3_000, 'preparing');
    const connects = broker.connects();
    await sleep(500);
    assert.equal(broker.connects(), connects, 'no reconnect during PREPARE');
    await waitFor(() => broker.connects() > connects, 3_000, 'reconnect once clearly dead');

    // Re-publish until seen: a frame sent before the new session has subscribed is lost.
    const running = loadFrame('x2d', 'running-mid-print');
    await waitFor(async () => {
      await broker.publishReport(SERIAL, running);
      return (await a.getSnapshot()).jobState === 'printing';
    }, 3_000, 'printing');
    const c2 = broker.connects();
    await waitFor(() => broker.connects() > c2, 1_000, 'reconnect after 150 ms silence');
  },
));

test('periodic full report request', () => withAdapter({ pushallIntervalMs: 100 }, async (_a, broker) => {
  const n = pushalls(broker);
  await waitFor(() => pushalls(broker) >= n + 2, 2_000, 'periodic pushall');
}));

test('warns once when the subscription gets no data (wrong serial)', () => withAdapter({ noDataWarnMs: 100 }, async (_a, _b, id) => {
  await sleep(400);
  const warnings = getEventLog(id).filter(e => e.msg.includes('Seriennummer'));
  assert.equal(warnings.length, 1);
}));

test('a late error from a torn-down client does not crash the process', () => withAdapter({}, async (a) => {
  const old = (a as any).client;
  (a as any).teardownClient();
  assert.doesNotThrow(() => old.emit('error', new Error('late socket error')));
}));
