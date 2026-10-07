import assert from 'node:assert/strict';
import { join } from 'node:path';
import { test } from 'node:test';
import type { AmsSlot } from '../src/adapters/types.js';
import type { IngestBody, MaterialLine } from '../src/contract.js';
import { amsRemainLines, cloudSlot, cloudTaskLines, matchCloudTask, parseCloudTasks } from '../src/material-sources.js';
import { Outbox, type PendingMaterial } from '../src/outbox.js';
import { Clock, FakeBackend, tempDir } from './helpers/bridge.js';

const slot = (unit: number, s: number, remain: number, uuid: string | null, extra: Partial<AmsSlot> = {}): AmsSlot =>
  ({ ams_unit: unit, slot: s, material: 'PLA', color: '#FF0000', remain, tray_weight: 1000, tray_uuid: uuid, ...extra });

const T0 = Date.parse('2026-10-07T06:49:20Z');
const tasksResponse = {
  total: 3,
  hits: [
    { id: 111, deviceId: '20P6BJ650604116', title: 'Oberschale', startTime: '2026-10-07T06:49:00Z', endTime: '2026-10-07T09:39:00Z',
      weight: 151.2, amsDetailMapping: [{ ams: 1, weight: 150.2, filamentType: 'ABS-GF', targetColor: 'FF6600FF' }, { ams: 255, weight: 1 }] },
    { id: 222, deviceId: '20P6BJ650604116', title: 'Anderes Teil', startTime: '2026-10-07T06:52:00Z', weight: 10, amsDetailMapping: [] },
    { id: 333, deviceId: 'OTHER', title: 'Oberschale', startTime: '2026-10-07T06:49:20Z', weight: 99, amsDetailMapping: [{ ams: 0, weight: 99 }] },
    { deviceId: 'broken' },
  ],
};

test('cloud tasks: parsing, tray ids and matching by id, title and time', () => {
  const tasks = parseCloudTasks(tasksResponse);
  assert.equal(tasks.length, 3);
  assert.deepEqual(tasks[0].ams, [
    { ams: 1, weight: 150.2, filamentType: 'ABS-GF', color: '#FF6600' },
    { ams: 255, weight: 1, filamentType: undefined, color: undefined },
  ]);
  assert.equal(cloudSlot(5), 5);
  assert.equal(cloudSlot(128), 128);
  assert.equal(cloudSlot(255), 254);
  assert.equal(cloudSlot(-1), 254);
  assert.equal(cloudSlot(300), null);

  const base = { serial: '20P6BJ650604116', ids: [], startedAt: T0, finishedAt: T0 + 170 * 60_000 };
  assert.equal(matchCloudTask(tasks, { ...base, ids: ['222'] })?.id, '222', 'id wins');
  assert.equal(matchCloudTask(tasks, { ...base, title: 'Oberschale' })?.id, '111', 'same title within the window');
  assert.equal(matchCloudTask(tasks, { ...base, title: 'Anderes_Teil' })?.id, '222', 'title normalised');
  assert.equal(matchCloudTask(tasks, { ...base, startedAt: T0 + 3 * 3_600_000, finishedAt: T0 + 4 * 3_600_000 }), null, 'far away');
  assert.equal(matchCloudTask(tasks, { ...base, serial: 'NOPE', title: 'Oberschale' }), null, 'other printer');
});

test('cloud task lines: per tray, RFID of the slot, scaled for failed jobs', () => {
  const [task] = parseCloudTasks(tasksResponse);
  const slots = [slot(0, 1, 50, 'UUID-A2')];
  assert.deepEqual(cloudTaskLines(task, slots), [
    { filamentIndex: 1, grams: 150.2, color: '#FF6600', filament_type: 'ABS-GF', slotRef: { source: 'ams', value: 1 },
      measureSource: 'bambu_cloud', estimated_grams: 150.2, tray_uuid: 'UUID-A2' },
    { filamentIndex: 254, grams: 1, color: undefined, filament_type: null, slotRef: { source: 'ams', value: 254 },
      measureSource: 'bambu_cloud', estimated_grams: 1, tray_uuid: null },
  ]);
  const partial = cloudTaskLines(task, slots, 0.5);
  assert.equal(partial[0].grams, 75.1);
  assert.equal(partial[0].measureSource, 'estimated_partial');
});

test('RFID remaining-% estimate', () => {
  const start = [slot(0, 0, 80, 'U1'), slot(0, 1, 50, 'U2'), slot(0, 2, -1, null), slot(0, 3, 40, 'U4')];
  const end = [slot(0, 0, 70, 'U1'), slot(0, 1, 50, 'U2'), slot(0, 2, -1, null), slot(0, 3, 90, 'U5')];
  assert.deepEqual(amsRemainLines(start, end), [
    { filamentIndex: 0, grams: 100, color: '#FF0000', filament_type: 'PLA', slotRef: { source: 'ams', value: 0 },
      measureSource: 'ams_remain', tray_uuid: 'U1' },
  ], 'only the slot whose spool stayed and dropped counts');
  assert.equal(amsRemainLines(start, end, 20)[0].grams, 125, 'adopted at 20 %: extrapolated');
  assert.deepEqual(amsRemainLines(start, end, 60), [], 'adopted late: no estimate');
  assert.deepEqual(amsRemainLines(undefined, end), []);
});

const pending = (over: Partial<PendingMaterial> = {}): PendingMaterial => ({
  until: Date.parse('2026-10-06T12:30:00Z'), nextAt: 0, attempts: 0, plateIndex: 1, fileUnreadable: true,
  serial: 'S', jobIds: [], startedAt: 0, finishedAt: 0, fraction: null, mapping: [], activeSlot: null, amsSlots: [],
  fallback: [], ...over,
});
const body = (id: string): IngestBody => ({ auth_token: 'old', event_type: 'job_complete', source_job_id: id, contract_version: 3 });
const line: MaterialLine = { filamentIndex: 1, grams: 42, slotRef: { source: 'ams', value: 1 }, measureSource: 'bambu_cloud' };

test('outbox: a job end waits for its material lookup and goes out with the result', async () => {
  const dir = tempDir(), clock = new Clock(), be = new FakeBackend();
  const ob = new Outbox(join(dir, 'outbox.json'), be.send, clock.now);
  let calls = 0;
  ob.setEnricher('p1', async () => (++calls < 2 ? null : { lines: [line], source: 'Bambu Cloud' }));
  ob.enqueue('p1', 'P1', body('a'), pending());
  await ob.flush();
  assert.equal(be.calls.length, 0, 'nothing found yet: not sent');
  assert.equal(ob.stats().awaitingMaterial, 1);
  await ob.flush();
  assert.equal(calls, 1, 'retry waits for its backoff');
  clock.t += 60_000;
  await ob.flush();
  assert.deepEqual(be.delivered()[0].filament_weights, [line]);
  assert.equal(be.delivered()[0].material_unknown, undefined);
  assert.equal(ob.stats().pending, 0);
});

test('outbox: after the lookup window the fallback (or material_unknown) is sent', async () => {
  const dir = tempDir(), clock = new Clock(), be = new FakeBackend();
  const ob = new Outbox(join(dir, 'outbox.json'), be.send, clock.now);
  ob.setEnricher('p1', async () => null);
  const estimate: MaterialLine = { ...line, measureSource: 'ams_remain', grams: 100 };
  ob.enqueue('p1', 'P1', body('a'), pending({ fallback: [estimate] }));
  ob.enqueue('p1', 'P1', body('b'), pending());
  await ob.flush();
  assert.equal(be.calls.length, 0);
  clock.t = Date.parse('2026-10-06T12:30:01Z');
  await ob.flush();
  const sent = be.delivered();
  assert.deepEqual(sent.find(b => b.source_job_id === 'a')?.filament_weights, [estimate]);
  assert.equal(sent.find(b => b.source_job_id === 'b')?.material_unknown, true);
});

test('outbox: an exhausted lookup sends the fallback at once', async () => {
  const dir = tempDir(), clock = new Clock(), be = new FakeBackend();
  const ob = new Outbox(join(dir, 'outbox.json'), be.send, clock.now);
  ob.setEnricher('p1', async () => 'exhausted');
  ob.enqueue('p1', 'P1', body('a'), pending());
  await ob.flush();
  assert.equal(be.delivered()[0].material_unknown, true);
});

test('outbox: pending material survives a restart', async () => {
  const dir = tempDir(), clock = new Clock(), be = new FakeBackend();
  new Outbox(join(dir, 'outbox.json'), be.send, clock.now).enqueue('p1', 'P1', body('a'), pending());
  const ob = new Outbox(join(dir, 'outbox.json'), be.send, clock.now);
  assert.equal(ob.stats().awaitingMaterial, 1);
  ob.setEnricher('p1', async () => ({ lines: [line], source: 'Druckdatei' }));
  await ob.flush();
  assert.equal(be.delivered().length, 1);
});

test('outbox: rejected events are kept, a rotated token is used', async () => {
  const dir = tempDir(), clock = new Clock(), be = new FakeBackend();
  const ob = new Outbox(join(dir, 'outbox.json'), be.send, clock.now);
  ob.setTokenResolver(id => (id === 'p1' ? 'new' : null));
  be.respond = b => (b.auth_token === 'new' ? 200 : 401);
  ob.enqueue('p1', 'P1', body('a'));
  ob.enqueue('p2', 'P2', body('b'));
  await ob.flush();
  assert.equal(be.delivered()[0].source_job_id, 'a', 'sent with the current token');
  assert.equal(ob.stats().rejected, 1);
  assert.equal(new Outbox(join(dir, 'outbox.json'), be.send, clock.now).rejected()[0].body.source_job_id, 'b', 'kept on disk');
});

test('terminal body defers a job without slicer weights; the enricher finds file or cloud', async () => {
  const { buildTerminalBody, materialEnricher } = await import('../src/bridge.js');
  const { cfg } = await import('./helpers/bridge.js');
  const session = {
    version: 1 as const, jobKey: 'task:5538', sourceJobId: 'task:5538@1', printFile: 'Oberschale', startedAt: T0,
    startedAtSource: 'printer' as const, energyStartWh: null, filamentMapping: [], parsedFilamentWeights: [],
    estimatedDurationMin: null, lastProgressPct: 100, lastLayer: null, totalLayers: null, lastActiveSlot: 1,
    amsSlots: [slot(0, 1, 35, 'UUID-A2')], amsSlotsAtStart: [slot(0, 1, 50, 'UUID-A2')], amsStartProgressPct: 0,
    jobIds: { taskId: '5538' }, plateIndex: 1, fileInternal: true, printError: null, hms: [], stopRequested: false, updatedAt: T0,
  };
  const end = { session, outcome: 'completed' as const, finishedAt: T0 + 3_600_000, seen: true };
  const snap = { status: 'idle' as const };

  // Adapter without print files and no cloud: sent right away with the RFID estimate.
  const direct = buildTerminalBody(cfg(), snap, end, null, { canRefetch: false, hasCloud: false });
  assert.equal(direct.pending, undefined);
  assert.equal(direct.body.filament_weights?.[0].grams, 150);
  assert.equal(direct.body.filament_weights?.[0].measureSource, 'ams_remain');

  // With a cloud source: deferred, the estimate kept as fallback.
  const deferred = buildTerminalBody(cfg(), snap, end, null, { canRefetch: true, hasCloud: true });
  assert.ok(deferred.pending);
  assert.equal(deferred.pending.fileUnreadable, false, 'the card is still tried once (X1C reprints report /data/)');
  assert.deepEqual(deferred.pending.jobIds, ['5538']);
  assert.equal(deferred.pending.fallback[0].grams, 150);

  // No file, no cloud: the lookup is exhausted.
  assert.equal(await materialEnricher({ getSnapshot: async () => snap }, cfg, () => null)({ ...deferred.pending, fileUnreadable: true }), 'exhausted');

  const cloud = { listTasks: async () => parseCloudTasks(tasksResponse) };
  const enrich = materialEnricher({ getSnapshot: async () => snap }, () => ({ ...cfg(), adapterSerial: '20P6BJ650604116' }), () => cloud);
  const found = await enrich({ ...deferred.pending, serial: '20P6BJ650604116' });
  assert.equal(found?.source, 'Bambu Cloud');
  assert.equal(found?.lines[0].grams, 150.2);
  assert.equal(found?.lines[0].tray_uuid, 'UUID-A2');

  // File on the SD card after all: the file wins and needs no cloud.
  const xml = '<config><plate><metadata key="index" value="1"/><filament id="1" type="PETG" used_g="33.5" color="#00FF00"/></plate></config>';
  const { zipSync, strToU8 } = await import('fflate');
  const { parseFileBuffer } = await import('../src/adapters/bambu-file-parser.js');
  const file = Buffer.from(zipSync({ 'Metadata/slice_info.config': strToU8(xml) }));
  const adapter = {
    getSnapshot: async () => snap,
    refetchJobWeights: async () => ({ kind: 'ok' as const, weights: parseFileBuffer('x.gcode.3mf', file, 1) }),
  };
  const fromFile = await materialEnricher(adapter, cfg, () => null)({ ...deferred.pending, fileUnreadable: false });
  assert.equal(fromFile?.source, 'Druckdatei');
  assert.deepEqual(fromFile?.lines.map(l => [l.grams, l.measureSource, l.filament_type, l.slotRef.value]), [[33.5, 'slicer_file', 'PETG', 1]]);
});
