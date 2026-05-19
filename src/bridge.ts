import fetch from 'node-fetch';
import { config } from './config.js';
import { Adapter, PrinterSnapshot } from './adapters/types.js';

const INGEST_URL = `${config.flowntEdgeUrl}/bridge-ingest`;
let consecutiveErrors = 0;

async function push(snapshot: PrinterSnapshot, eventType = 'status_update'): Promise<void> {
  const body = {
    auth_token: config.flowntAuthToken,
    event_type: eventType,
    printer_status: snapshot.status,
    print_file: snapshot.printFile,
    progress_pct: snapshot.progressPct,
    temp_hotend: snapshot.tempHotend,
    temp_bed: snapshot.tempBed,
    eta_s: snapshot.etaSec,
  };

  const res = await fetch(INGEST_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(10_000),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`bridge-ingest returned ${res.status}: ${text}`);
  }
}

function sleep(ms: number) {
  return new Promise<void>(r => setTimeout(r, ms));
}

export async function runBridge(adapter: Adapter): Promise<never> {
  console.log('[flownt-bridge] Starting. Polling every', config.pollingIntervalMs / 1000, 's →', INGEST_URL);

  // Send heartbeat immediately on start
  try {
    await fetch(INGEST_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ auth_token: config.flowntAuthToken, event_type: 'heartbeat' }),
    });
    console.log('[flownt-bridge] Auth OK ✓');
  } catch (e) {
    console.error('[flownt-bridge] Initial heartbeat failed:', e);
  }

  // eslint-disable-next-line no-constant-condition
  while (true) {
    try {
      const snapshot = await adapter.getSnapshot();
      await push(snapshot);
      consecutiveErrors = 0;
      const statusLabel = snapshot.status.toUpperCase();
      const progress = snapshot.progressPct != null ? ` ${snapshot.progressPct}%` : '';
      const file = snapshot.printFile ? ` "${snapshot.printFile}"` : '';
      console.log(`[flownt-bridge] ${new Date().toISOString()} → ${statusLabel}${file}${progress}`);
    } catch (err) {
      consecutiveErrors++;
      const backoff = Math.min(consecutiveErrors * 5_000, 60_000);
      console.error(`[flownt-bridge] Error (${consecutiveErrors}x), retry in ${backoff / 1000}s:`, err);
      await sleep(backoff);
      continue;
    }

    await sleep(config.pollingIntervalMs);
  }
}
