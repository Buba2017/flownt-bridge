import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { test } from 'node:test';
import { MoonrakerAdapter } from '../src/adapters/moonraker.js';
import { PrusaLinkAdapter } from '../src/adapters/prusa.js';
import { waitFor } from './helpers/broker.js';

// Moonraker and Prusa Link adapters against a fake printer API.

type Reply = { status: number; body?: string };

async function fakePrinter(routes: Record<string, () => Reply>) {
  const hits: string[] = [];
  const server = createServer((req, res) => {
    const path = (req.url ?? '').split('?')[0];
    hits.push(path);
    const r = routes[path]?.() ?? { status: 404 };
    res.writeHead(r.status, { 'Content-Type': 'application/json' }).end(r.body ?? '');
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { url, hits, close: () => new Promise<void>(resolve => server.close(() => resolve())) };
}

const gcode = '; filament used [g] = 12.5\nG28\n';
const json = (v: unknown): Reply => ({ status: 200, body: JSON.stringify(v) });

test('Moonraker: paused stays paused, and a job first seen paused gets its print file', async () => {
  const printer = await fakePrinter({
    '/printer/objects/query': () => json({ result: { status: { print_stats: { state: 'paused', filename: 'Box.gcode' } } } }),
    '/server/files/gcodes/Box.gcode': () => ({ status: 200, body: gcode }),
  });
  try {
    const a = new MoonrakerAdapter(printer.url);
    const s = await a.getSnapshot();
    assert.equal(s.status, 'paused');
    assert.equal(s.jobResult, null);
    assert.equal(s.printFile, 'Box.gcode');
    const later = await waitFor(async () => { const x = await a.getSnapshot(); return x.parsedFilamentWeights?.length && x; }, 3_000, 'weights');
    assert.equal(later.parsedFilamentWeights![0].grams, 12.5);
  } finally { await printer.close(); }
});

test('Prusa Link: a job first seen paused gets its file name and weights', async () => {
  const printer = await fakePrinter({
    '/api/v1/status': () => json({ printer: { state: 'PAUSED' }, job: { id: 7, progress: 40 } }),
    '/api/v1/job': () => json({ id: 7, file: { name: 'BOX~1.GCO', display_name: 'Box.gcode', refs: { download: '/files/box' } } }),
    '/files/box': () => ({ status: 200, body: gcode }),
  });
  try {
    const a = new PrusaLinkAdapter(printer.url);
    assert.equal((await a.getSnapshot()).status, 'paused');
    const s = await waitFor(async () => { const x = await a.getSnapshot(); return x.parsedFilamentWeights?.length && x; }, 3_000, 'weights');
    assert.equal(s.printFile, 'Box.gcode');
    assert.equal(s.parsedFilamentWeights![0].grams, 12.5);
  } finally { await printer.close(); }
});

test('Prusa Link: a failed job lookup at the start is repeated on the next poll', async () => {
  let jobCalls = 0;
  const printer = await fakePrinter({
    '/api/v1/status': () => json({ printer: { state: 'PRINTING' }, job: { id: 8, progress: 1 } }),
    '/api/v1/job': () => (++jobCalls === 1 ? { status: 503 } : json({ id: 8, file: { display_name: 'Clip.gcode' } })),
  });
  try {
    const a = new PrusaLinkAdapter(printer.url);
    await a.getSnapshot();
    await waitFor(() => jobCalls === 1, 3_000, 'first lookup');
    await new Promise(r => setTimeout(r, 50));
    assert.equal((await a.getSnapshot()).printFile, undefined);
    const s = await waitFor(async () => { const x = await a.getSnapshot(); return x.printFile && x; }, 3_000, 'file name');
    assert.equal(s.printFile, 'Clip.gcode');
  } finally { await printer.close(); }
});
