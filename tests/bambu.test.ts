import assert from 'node:assert/strict';
import { test } from 'node:test';
import { zipSync, strToU8 } from 'fflate';
import { activeTrayFromExtruder, formatPrintError, mapJobState, parseHms } from '../src/adapters/bambu.js';
import { parseFileBuffer } from '../src/adapters/bambu-file-parser.js';

// Values below are taken from real printers (X1C, H2C, X2D) on firmware of 2026-10.

test('active tray on single-nozzle printers (X1C, AMS units 1+2) matches tray_now', () => {
  assert.equal(activeTrayFromExtruder({ extruder: { state: 1, info: [{ id: 0, snow: 259 }] } }), 7);
});

test('active tray on dual-nozzle printers uses the active extruder (H2C prints from B3)', () => {
  // tray_now reported "2" here (slot within the unit) — the AMS unit is only in snow.
  const dev = { extruder: { state: 33042, info: [{ id: 0, snow: 65535 }, { id: 1, snow: 258 }] } };
  assert.equal(activeTrayFromExtruder(dev), 6);
});

test('active tray: none loaded, external spool, AMS HT, no extruder data', () => {
  assert.equal(activeTrayFromExtruder({ extruder: { state: 1, info: [{ id: 0, snow: 65535 }] } }), 255);
  assert.equal(activeTrayFromExtruder({ extruder: { state: 1, info: [{ id: 0, snow: 254 << 8 }] } }), 254);
  assert.equal(activeTrayFromExtruder({ extruder: { state: 1, info: [{ id: 0, snow: 128 << 8 }] } }), 128);
  assert.equal(activeTrayFromExtruder(undefined), undefined);
});

test('HMS codes are formatted as on the printer, with severity', () => {
  assert.deepEqual(parseHms([{ attr: 201327360, code: 131077 }]), [{ code: '0C00_0300_0002_0005', severity: 'serious' }]);
  assert.deepEqual(parseHms([{ attr: 201326848, code: 196610 }])[0].severity, 'common');
});

test('print_error: status values are not errors', () => {
  assert.equal(formatPrintError(0), null);
  assert.equal(formatPrintError(0x0300_0002), null);
  assert.equal(formatPrintError(0x0500_4004), '0500_4004');
});

test('job state: preparation counts as busy, finish/failed are kept', () => {
  assert.equal(mapJobState('PREPARE'), 'preparing');
  assert.equal(mapJobState('FINISH'), 'finished');
  assert.equal(mapJobState('FAILED'), 'failed');
  assert.equal(mapJobState(''), 'idle');
});

test('3MF with several sliced plates: only the printed plate is counted', () => {
  const xml = '<config><plate><metadata key="index" value="1"/><filament id="1" used_g="10" color="#FFFFFF"/></plate>'
    + '<plate><metadata key="index" value="2"/><filament id="2" used_g="20" color="#000000"/></plate></config>';
  const file = Buffer.from(zipSync({ 'Metadata/slice_info.config': strToU8(xml) }));
  assert.deepEqual(parseFileBuffer('job.gcode.3mf', file, 2), [{ filamentIndex: 2, grams: 20, color: '#000000' }]);
  assert.deepEqual(parseFileBuffer('job.gcode.3mf', file, 1), [{ filamentIndex: 1, grams: 10, color: '#FFFFFF' }]);
});
