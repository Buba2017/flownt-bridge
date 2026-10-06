import assert from 'node:assert/strict';
import { test } from 'node:test';
import { BambuAdapter } from '../src/adapters/bambu.js';
import { startBroker, waitFor } from './helpers/broker.js';
import { loadFrame } from './helpers/fixtures.js';

// Adapter against an in-process MQTT broker: connection lifecycle.

const SERIAL = 'TESTSERIAL';

test('connects, subscribes, asks for a full report and applies it', async () => {
  const broker = await startBroker();
  const a = new BambuAdapter('192.0.2.1', SERIAL, 'code', 'p1', { brokerUrl: broker.url, fetchFiles: false });
  try {
    await waitFor(() => broker.requests.some(r => r.pushing?.command === 'pushall'), 3_000, 'pushall');
    await broker.publishReport(SERIAL, loadFrame('x2d', 'running-mid-print'));
    await waitFor(async () => (await a.getSnapshot()).status === 'printing', 3_000, 'printing');
  } finally {
    a.dispose();
    await broker.close();
  }
});
