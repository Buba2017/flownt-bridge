import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Adapter, PrinterSnapshot } from '../../src/adapters/types.js';
import { runBridge } from '../../src/bridge.js';
import type { PrinterConfig } from '../../src/config.js';
import type { IngestBody } from '../../src/contract.js';
import { JobSessionStore } from '../../src/job-session.js';
import { Outbox, SendResult } from '../../src/outbox.js';
import type { PrinterBridgeState } from '../../src/server.js';

export const tempDir = () => mkdtempSync(join(tmpdir(), 'flownt-bridge-test-'));

export const cfg = (id = 'printer-1'): PrinterConfig => ({
  id, name: 'Test', flowntAuthToken: 'token', adapterType: 'bambu', adapterUrl: '192.0.2.1',
  adapterApiKey: 'code', adapterSerial: 'TESTSERIAL', pollingIntervalMs: 30_000,
});

/** A fake bridge-ingest: records every body; `respond` decides the HTTP status. */
export class FakeBackend {
  calls: Array<{ body: IngestBody; status: number }> = [];
  respond: (body: IngestBody) => number | Error = () => 200;
  send = async (body: IngestBody): Promise<SendResult> => {
    const r = this.respond(body);
    if (r instanceof Error) { this.calls.push({ body, status: 0 }); throw r; }
    this.calls.push({ body, status: r });
    return { status: r, data: r === 200 && body.event_type === 'job_complete' ? { print_log_id: 'log-1' } : {}, text: '' };
  };
  delivered(type?: string) {
    return this.calls.filter(c => c.status >= 200 && c.status < 300 && (!type || c.body.event_type === type)).map(c => c.body);
  }
  attempts(type: string) { return this.calls.filter(c => c.body.event_type === type).length; }
}

/** Fake clock: sleeping advances it. */
export class Clock {
  constructor(public t = Date.parse('2026-10-06T12:00:00Z')) {}
  now = () => this.t;
  sleep = async (ms: number) => { this.t += ms; await new Promise(r => setImmediate(r)); };
}

/**
 * Runs the bridge loop over a list of steps; each step yields the snapshot of one poll
 * (30 s apart on the fake clock). Returns when all steps were consumed.
 */
export async function runSteps(
  steps: Array<() => PrinterSnapshot | Promise<PrinterSnapshot>>,
  opts: { dir: string; backend: FakeBackend; clock: Clock; printerId?: string; outbox?: Outbox },
): Promise<void> {
  let i = 0;
  const adapter: Adapter = { getSnapshot: async () => steps[Math.min(i++, steps.length - 1)]() };
  const state: PrinterBridgeState = { snapshot: null, lastPushAt: null, running: true, error: null, adapter } as PrinterBridgeState;
  const outbox = opts.outbox ?? new Outbox(join(opts.dir, 'outbox.json'), opts.backend.send, opts.clock.now);
  await runBridge(adapter, cfg(opts.printerId), state, () => i >= steps.length, {
    send: opts.backend.send, outbox, sessions: new JobSessionStore(join(opts.dir, 'jobs')),
    now: opts.clock.now, sleep: opts.clock.sleep, currentConfig: () => cfg(opts.printerId),
  });
}
