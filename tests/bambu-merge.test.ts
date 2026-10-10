import assert from 'node:assert/strict';
import { test } from 'node:test';
import { BambuAdapter } from '../src/adapters/bambu.js';
import { mergePrintState } from '../src/adapters/bambu-state.js';
import { json, loadFrame, partial } from './helpers/fixtures.js';

// Partial MQTT reports are merged key by key into a cached state.

function adapter() {
  return new BambuAdapter('192.0.2.1', 'TESTSERIAL', 'code', 'p1', { autoConnect: false, fetchFiles: false });
}

test('partial frame mid-print keeps status, temps, AMS and does not end the job', async () => {
  const a = adapter();
  a.handleMessage(json(loadFrame('x2d', 'running-mid-print')));
  const before = await a.getSnapshot();
  a.handleMessage(JSON.stringify({ print: { command: 'push_status', sequence_id: '2022', mc_percent: 53 } }));
  const s = await a.getSnapshot();
  assert.equal(s.status, 'printing');
  assert.equal(s.jobState, 'printing');
  assert.equal(s.jobResult, null);
  assert.equal(s.progressPct, 53);
  assert.equal(s.tempBed, before.tempBed);
  assert.equal(s.tempHotend, before.tempHotend);
  assert.equal(s.etaSec, before.etaSec);
  assert.deepEqual(s.amsSlots, before.amsSlots);
  assert.equal(s.printFile, 'Oberschale');
  assert.deepEqual(s.filamentMapping, [0]);
});

test('frame without gcode_state before any full report does not claim idle', async () => {
  const a = adapter();
  // H2C frame cut before gcode_state (real capture).
  a.handleMessage(json(loadFrame('h2c', 'running-truncated-no-gcode-state')));
  const s = await a.getSnapshot();
  assert.equal(s.status, 'offline');
  assert.equal(s.jobState, undefined);
  assert.equal(s.amsSlots?.length, 8); // the AMS data is still used
});

test('AMS frame with one unit does not wipe the other unit', () => {
  const full = loadFrame('h2c', 'running-truncated-no-gcode-state').print!;
  const merged = mergePrintState(full, { command: 'push_status', ams: { ams: [{ id: '1', humidity: '4', humidity_raw: '35' }] } });
  assert.deepEqual(merged.ams.ams.map((u: any) => u.id), ['0', '1']);
  assert.equal(merged.ams.ams[0].tray.length, 4);
  assert.equal(merged.ams.ams[1].humidity, '4');
  assert.equal(merged.ams.ams[1].tray[2].tray_type, 'PC'); // trays of the updated unit stay
});

test('tray with only {id, state} keeps its spool data while the slot is occupied', () => {
  const full = loadFrame('h2c', 'running-truncated-no-gcode-state').print!;
  const merged = mergePrintState(full, { ams: { ams: [{ id: 0, tray: [{ id: 2, state: 11 }] }] } });
  const tray = merged.ams.ams[0].tray[2];
  assert.equal(tray.tray_type, 'ABS-GF');
  assert.equal(tray.tray_uuid, full.ams.ams[0].tray[2].tray_uuid);
  assert.match(tray.tray_uuid, /^FA4E/);
});

test('tray_exist_bits: a removed spool loses its cached data', () => {
  const full = loadFrame('h2c', 'running-truncated-no-gcode-state').print!;
  // ef → e7: unit 0 slot 3 (bit 3) now empty
  const merged = mergePrintState(full, { ams: { tray_exist_bits: 'e7', ams: [{ id: '0', tray: [{ id: '3', state: 9 }] }] } });
  assert.deepEqual(merged.ams.ams[0].tray[3], { id: '3', state: 9 });
  assert.equal(merged.ams.ams[0].tray[2].tray_type, 'ABS-GF');
});

test('tray_exist_bits on an X1C with AMS ids 1+2 (bits start at unit 1)', async () => {
  const a = adapter();
  a.handleMessage(json(loadFrame('x1c', 'running-ams-units-1-2'))); // tray_exist_bits 9b0
  const slots = (await a.getSnapshot()).amsSlots!;
  const present = slots.filter(x => x.material).map(x => `${x.ams_unit}.${x.slot}`);
  assert.deepEqual(present, ['1.0', '1.1', '1.3', '2.0', '2.3']);
});

test('ams_exist_bits: a disconnected AMS unit is dropped', () => {
  const full = loadFrame('h2c', 'running-truncated-no-gcode-state').print!;
  const merged = mergePrintState(full, { ams: { ams_exist_bits: '1' } });
  assert.deepEqual(merged.ams.ams.map((u: any) => u.id), ['0']);
});

test('ids sent as numbers or strings address the same unit/tray', () => {
  const full = loadFrame('h2c', 'running-truncated-no-gcode-state').print!;
  const merged = mergePrintState(full, { ams: { ams: [{ id: 1, tray: [{ id: 1, remain: 50 }] }] } });
  assert.equal(merged.ams.ams.length, 2);
  assert.equal(merged.ams.ams[1].tray[1].remain, 50);
  assert.equal(merged.ams.ams[1].tray[1].tray_type, 'PLA');
});

test('implausible AMS temperature is ignored, humidity index and percent are kept apart', async () => {
  const a = adapter();
  a.handleMessage(json(loadFrame('x2d', 'running-mid-print')));
  a.handleMessage(JSON.stringify({ print: { command: 'push_status', ams: { ams: [{ id: '0', temp: '655.3', humidity: '2', humidity_raw: '41' }] } } }));
  const hum = (await a.getSnapshot()).amsHumidity!;
  assert.deepEqual(hum, [{ ams_unit: 0, humidity: 2, temp: 28.1, humidity_pct: 41 }]);
});

test('command replies and echoed commands are not merged as telemetry', async () => {
  const a = adapter();
  a.handleMessage(json(loadFrame('x2d', 'running-mid-print')));
  // The printer echoes command fields; a reply may even carry a gcode_state.
  a.handleMessage(JSON.stringify({ print: { command: 'stop', gcode_state: 'IDLE', result: 'success', sequence_id: '5' } }));
  a.handleMessage(json(loadFrame('common', 'project-file-echo')));
  const s = await a.getSnapshot();
  assert.equal(s.status, 'printing');
  assert.deepEqual(s.filamentMapping, [0]);
});

test('a partial frame with only some keys from a real frame', async () => {
  const a = adapter();
  const full = loadFrame('x1c', 'running-ams-units-1-2');
  a.handleMessage(json(full));
  a.handleMessage(json(partial(full, ['mc_percent', 'mc_remaining_time', 'nozzle_temper'])));
  const s = await a.getSnapshot();
  assert.equal(s.status, 'printing');
  assert.equal(s.activeMqttSlot, 7);
  assert.equal(s.hms?.length, 3);
});
