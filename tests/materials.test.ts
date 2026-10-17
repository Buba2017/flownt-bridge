import assert from 'node:assert/strict';
import { test } from 'node:test';
import { activeTrayFromExtruder, BambuAdapter } from '../src/adapters/bambu.js';
import type { AmsSlot, PrinterSnapshot } from '../src/adapters/types.js';
import { decodeTrayCode, isTrackedSlot, resolveMaterials, slotLabel } from '../src/job-materials.js';
import { Clock, FakeBackend, runSteps, tempDir } from './helpers/bridge.js';
import { json, loadFrame } from './helpers/fixtures.js';

// Which slot each filament of a job is booked to.

const slot = (unit: number, s: number, color: string, uuid: string | null = null, material = 'PLA'): AmsSlot => ({
  ams_unit: unit, slot: s, material, color, remain: 50, tray_weight: 1000, tray_uuid: uuid,
});

test('tray codes: AMS, AMS HT, external spools, none', () => {
  assert.equal(decodeTrayCode(259), 7);            // unit 1 slot 3 (X1C capture)
  assert.equal(decodeTrayCode(0), 0);
  assert.equal(decodeTrayCode(4 << 8 | 2), 18);    // unit ids above 3
  assert.equal(decodeTrayCode(128 << 8), 128);     // AMS HT
  assert.equal(decodeTrayCode(131 << 8), 131);
  assert.equal(decodeTrayCode(254 << 8), 254);     // external (left/right on dual nozzle)
  assert.equal(decodeTrayCode(255 << 8), 254);
  assert.equal(decodeTrayCode(65535), 254);
  assert.equal(decodeTrayCode(-1), 254);
  assert.equal(decodeTrayCode(1 << 8 | 7), null);  // slot out of range
});

test('active slot: HT and external are tracked, "no tray" is not', () => {
  for (const v of [0, 7, 18, 128, 135, 254]) assert.equal(isTrackedSlot(v), true, String(v));
  for (const v of [255, -1, 300, undefined, null]) assert.equal(isTrackedSlot(v as number), false, String(v));
  assert.equal(slotLabel(128), 'AMS HT 1');
  assert.equal(slotLabel(6), 'B3');
});

test('extruder slot 0xFEFF during job start is "no tray", not the external spool', async () => {
  assert.equal(activeTrayFromExtruder({ extruder: { state: 274, info: [{ id: 0, snow: 65535 }, { id: 1, snow: 65279 }] } }), 255);
  assert.equal(activeTrayFromExtruder({ extruder: { state: 1, info: [{ id: 0, snow: 255 << 8 }] } }), 254);
  const a = new BambuAdapter('192.0.2.1', 'S', 'c', 'p', { autoConnect: false, fetchFiles: false });
  a.handleMessage(json(loadFrame('x2d', 'job-start-stale-layer')));
  assert.equal((await a.getSnapshot()).activeMqttSlot, 255);
});

test('mapping covers only some filaments: the others are not claimed as AMS', () => {
  const r = resolveMaterials([{ filamentIndex: 1, grams: 5 }, { filamentIndex: 2, grams: 7 }], { mapping: [259], activeSlot: null, amsSlots: [] });
  assert.deepEqual(r.lines.map(l => [l.filamentIndex, l.source]), [[7, 'ams'], [2, 'slicer_order']]);
});

test('mapping with external and AMS HT codes', () => {
  const r = resolveMaterials([{ filamentIndex: 1, grams: 5 }, { filamentIndex: 2, grams: 7 }],
    { mapping: [255 << 8, 129 << 8], activeSlot: null, amsSlots: [] });
  assert.deepEqual(r.lines.map(l => [l.filamentIndex, l.source]), [[254, 'ams'], [129, 'ams']]);
});

test('colour fallback: only matched filaments get source ams', () => {
  const r = resolveMaterials(
    [{ filamentIndex: 1, grams: 5, color: '#FF0000' }, { filamentIndex: 2, grams: 7, color: '#00FF00' }],
    { mapping: [], activeSlot: null, amsSlots: [slot(0, 2, '#FF0000'), slot(1, 0, '#0000FF'), slot(1, 1, '#00FF00', null, '')] },
  );
  // #00FF00 is only in an empty slot → not a match
  assert.deepEqual(r.lines.map(l => [l.filamentIndex, l.source]), [[2, 'ams'], [2, 'slicer_order']]);
});

test('single filament on an AMS HT slot books there with its tray_uuid', async () => {
  const dir = tempDir(), be = new FakeBackend();
  const snap = (extra: Partial<PrinterSnapshot>): PrinterSnapshot => ({
    status: 'printing', jobState: 'printing', jobKey: 'task:3', printFile: 'Gear', activeMqttSlot: 128,
    amsSlots: [slot(0, 0, '#FFFFFF', 'AAAA'), slot(128, 0, '#222222', 'HT00000000000000000000000000000001')], ...extra,
  });
  await runSteps([
    () => snap({ progressPct: 1, parsedFilamentWeights: [{ filamentIndex: 1, grams: 9 }] }),
    () => snap({ status: 'idle', jobState: 'finished', jobResult: 'completed', progressPct: 100 }),
  ], { dir, backend: be, clock: new Clock() });
  const [line] = be.delivered('job_complete')[0].filament_weights!;
  assert.deepEqual([line.filamentIndex, line.slotRef, line.tray_uuid], [128, { source: 'ams', value: 128 }, 'HT00000000000000000000000000000001']);
});

test('active slot and mapping of the previous job are not inherited', async () => {
  const dir = tempDir(), be = new FakeBackend();
  const a = (extra: Partial<PrinterSnapshot>): PrinterSnapshot => ({ status: 'printing', jobState: 'printing', jobKey: 'task:1', printFile: 'A', ...extra });
  const b = (extra: Partial<PrinterSnapshot>): PrinterSnapshot => ({ status: 'printing', jobState: 'printing', jobKey: 'task:2', printFile: 'B', ...extra });
  await runSteps([
    () => a({ progressPct: 5, activeMqttSlot: 254, filamentMapping: [65535], parsedFilamentWeights: [{ filamentIndex: 1, grams: 3 }] }),
    () => a({ status: 'idle', jobState: 'finished', jobResult: 'completed', progressPct: 100, activeMqttSlot: 254 }),
    () => b({ progressPct: 5, activeMqttSlot: 255, parsedFilamentWeights: [{ filamentIndex: 1, grams: 4 }] }),
    () => b({ status: 'idle', jobState: 'finished', jobResult: 'completed', progressPct: 100, activeMqttSlot: 255 }),
  ], { dir, backend: be, clock: new Clock() });
  const [jobA, jobB] = be.delivered('job_complete');
  assert.deepEqual(jobA.filament_weights!.map(l => [l.filamentIndex, l.slotRef.source]), [[254, 'ams']]);
  assert.deepEqual(jobB.filament_weights!.map(l => [l.filamentIndex, l.slotRef.source]), [[1, 'slicer_order']]);
});
