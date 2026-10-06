import assert from 'node:assert/strict';
import { test } from 'node:test';
import { strToU8, zipSync } from 'fflate';
import { bambuJobResult } from '../src/adapters/bambu.js';
import { parseSlicePrediction } from '../src/adapters/bambu-file-parser.js';
import type { AmsSlot, PrinterSnapshot } from '../src/adapters/types.js';
import { failureReason, printedFraction } from '../src/bridge.js';
import { Clock, FakeBackend, runSteps, tempDir } from './helpers/bridge.js';

// Content of job_complete / job_failed (contract v2).

const slot = (unit: number, s: number, uuid: string | null, color = '#FFFFFF'): AmsSlot => ({
  ams_unit: unit, slot: s, material: 'PLA', color, remain: 50, tray_weight: 1000, tray_uuid: uuid,
});
const ams = [slot(1, 3, 'FA4E0000000000000000000000000007'), slot(0, 0, null, '#000000')];
const base = (extra: Partial<PrinterSnapshot>): PrinterSnapshot => ({
  status: 'printing', jobState: 'printing', jobKey: 'task:7', printFile: 'Bracket', amsSlots: ams, ...extra,
});
const startS = Math.round(Date.parse('2026-10-06T11:30:00Z') / 1000);

test('job_complete: timing, outcome, slicer estimate, tray_uuid per line', async () => {
  const dir = tempDir(), be = new FakeBackend(), clock = new Clock();
  await runSteps([
    () => base({ progressPct: 0, jobStartedAtS: startS, filamentMapping: [65535, 259], estimatedDurationMin: 95,
      parsedFilamentWeights: [{ filamentIndex: 2, grams: 20, color: '#FFFFFF' }] }),
    () => base({ progressPct: 100, layerNum: 40, totalLayers: 40 }),
    () => base({ status: 'idle', jobState: 'finished', jobResult: 'completed', progressPct: 100 }),
  ], { dir, backend: be, clock });
  const [b] = be.delivered('job_complete');
  assert.equal(b.started_at, '2026-10-06T11:30:00.000Z');
  assert.equal(b.finished_at, new Date(clock.t).toISOString()); // seen at the last poll
  assert.equal(b.outcome, 'completed');
  assert.equal(b.estimated_duration_min, 95);
  assert.equal(b.last_progress_pct, 100);
  assert.equal(b.failure_reason, undefined);
  assert.deepEqual(b.filament_weights, [{
    filamentIndex: 7, grams: 20, color: '#FFFFFF', slotRef: { source: 'ams', value: 7 },
    measureSource: 'slicer_file', estimated_grams: 20, tray_uuid: 'FA4E0000000000000000000000000007',
  }]);
});

test('job_failed: reason, last progress, partial usage by layers', async () => {
  const dir = tempDir(), be = new FakeBackend();
  const failed = () => base({ status: 'error', jobState: 'failed', jobResult: 'failed', progressPct: 31, printError: '0500_4004' });
  await runSteps([
    () => base({ progressPct: 2, filamentMapping: [259], parsedFilamentWeights: [{ filamentIndex: 1, grams: 20 }] }),
    () => base({ progressPct: 30, layerNum: 10, totalLayers: 40 }),
    failed, failed,
  ], { dir, backend: be, clock: new Clock() });
  const [b] = be.delivered('job_failed');
  assert.ok(b.source_job_id?.startsWith('task:7@'));
  assert.equal(b.outcome, 'failed');
  assert.equal(b.failure_reason, '0500_4004');
  assert.equal(b.last_progress_pct, 31);
  assert.deepEqual(b.filament_weights, [{
    filamentIndex: 7, grams: 5, color: undefined, slotRef: { source: 'ams', value: 7 },
    measureSource: 'estimated_partial', estimated_grams: 20, tray_uuid: 'FA4E0000000000000000000000000007',
  }]);
  assert.equal(be.delivered('job_complete').length, 0);
});

test('cancel: user stop (print_error xxxx_8001) or our own stop command', async () => {
  assert.equal(bambuJobResult('FAILED', 0x0300_8001, false), 'aborted');
  assert.equal(bambuJobResult('FAILED', 0x0500_4004, true), 'aborted');
  assert.equal(bambuJobResult('FAILED', 0x0500_4004, false), 'failed');
  assert.equal(bambuJobResult('FINISH', 0, true), 'completed');

  const dir = tempDir(), be = new FakeBackend();
  const cancelled = () => base({ status: 'error', jobState: 'failed', jobResult: 'aborted', progressPct: 12, printError: '0300_8001' });
  await runSteps([() => base({ progressPct: 12 }), cancelled, cancelled], { dir, backend: be, clock: new Clock() });
  const [b] = be.delivered('job_failed');
  assert.equal(b.outcome, 'cancelled');
  assert.equal(b.failure_reason, '0300_8001');
});

test('failure reason falls back to the most severe HMS code', () => {
  assert.equal(failureReason({ printError: null, hms: [
    { code: '0C00_0300_0003_000B', severity: 'common' },
    { code: '0700_2000_0002_0001', severity: 'serious' },
  ] }), '0700_2000_0002_0001');
  assert.equal(failureReason({ printError: null, hms: [] }), null);
});

test('printed fraction: layers when known, else progress', () => {
  assert.equal(printedFraction({ lastLayer: 10, totalLayers: 40, lastProgressPct: 50 }), 0.25);
  assert.equal(printedFraction({ lastLayer: null, totalLayers: null, lastProgressPct: 50 }), 0.5);
  assert.equal(printedFraction({ lastLayer: null, totalLayers: null, lastProgressPct: null }), null);
});

test('stale layer count of the previous job is not used (captured: 29/29 at 0 %)', async () => {
  const dir = tempDir(), be = new FakeBackend();
  const failed = () => base({ status: 'error', jobState: 'failed', jobResult: 'failed', progressPct: 0, layerNum: 29, totalLayers: 29 });
  await runSteps([
    () => base({ jobState: 'preparing', progressPct: 0, layerNum: 29, totalLayers: 29, parsedFilamentWeights: [{ filamentIndex: 1, grams: 20 }] }),
    failed, failed,
  ], { dir, backend: be, clock: new Clock() });
  assert.equal(be.delivered('job_failed')[0].filament_weights?.[0].grams, 0);
});

test('estimated duration falls back to the printer\'s remaining time at the start', async () => {
  const dir = tempDir(), be = new FakeBackend();
  await runSteps([
    () => base({ jobState: 'preparing', progressPct: 0, etaSec: 0 }),
    () => base({ progressPct: 0, etaSec: 4_260 }),
    () => base({ progressPct: 50, etaSec: 2_000 }),
    () => base({ status: 'idle', jobState: 'finished', jobResult: 'completed', progressPct: 100 }),
  ], { dir, backend: be, clock: new Clock() });
  assert.equal(be.delivered('job_complete')[0].estimated_duration_min, 71);
});

test('slicer prediction of the printed plate', () => {
  const xml = '<config><plate><metadata key="index" value="1"/><metadata key="prediction" value="600"/></plate>'
    + '<plate><metadata key="index" value="2"/><metadata key="prediction" value="5400"/></plate></config>';
  const file = Buffer.from(zipSync({ 'Metadata/slice_info.config': strToU8(xml) }));
  assert.equal(parseSlicePrediction(file, 2), 5400);
  assert.equal(parseSlicePrediction(file, 1), 600);
  assert.equal(parseSlicePrediction(Buffer.from('not a zip')), null);
});
