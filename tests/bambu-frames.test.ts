import assert from 'node:assert/strict';
import { test } from 'node:test';
import { BambuAdapter } from '../src/adapters/bambu.js';
import { json, loadFrame } from './helpers/fixtures.js';

// Frames captured from our printers (X1C, X2D, H2C), fed straight into the adapter.

function adapter() {
  return new BambuAdapter('192.0.2.1', 'TESTSERIAL', 'code', 'p1', { autoConnect: false, fetchFiles: false });
}

test('X1C with AMS units 1+2: slots, active tray, HMS', async () => {
  const a = adapter();
  a.handleMessage(json(loadFrame('x1c', 'running-ams-units-1-2')));
  const s = await a.getSnapshot();
  assert.equal(s.status, 'printing');
  assert.equal(s.progressPct, 77);
  assert.equal(s.activeMqttSlot, 7); // unit 1 slot 3
  assert.deepEqual([...new Set(s.amsSlots!.map(x => x.ams_unit))], [1, 2]);
  assert.equal(s.hms?.length, 3);
  assert.deepEqual(s.filamentMapping, [65535, 65535, 65535, 259]);
});

test('X2D (dual nozzle) mid print: active tray from the active extruder', async () => {
  const a = adapter();
  a.handleMessage(json(loadFrame('x2d', 'running-mid-print')));
  const s = await a.getSnapshot();
  assert.equal(s.status, 'printing');
  assert.equal(s.progressPct, 52);
  assert.equal(s.activeMqttSlot, 0);
  assert.equal(s.printFile, 'Oberschale');
});

test('command echoes from other clients do not change the state', async () => {
  const a = adapter();
  a.handleMessage(json(loadFrame('x2d', 'running-mid-print')));
  for (const f of ['gcode-line-echo', 'gcode-line-reply', 'project-file-echo', 'ignore-reply']) {
    a.handleMessage(json(loadFrame('common', f)));
  }
  assert.equal((await a.getSnapshot()).status, 'printing');
});
