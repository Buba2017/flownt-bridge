import open from 'open';
import { loadMultiConfig, PrinterConfig, newPrinterId } from './config.js';
import { MoonrakerAdapter } from './adapters/moonraker.js';
import { BambuAdapter } from './adapters/bambu.js';
import { startServer, printerStates, PrinterBridgeState } from './server.js';
import { runBridge } from './bridge.js';
import { Adapter } from './adapters/types.js';

const PORT = 7432;
const URL  = `http://localhost:${PORT}`;

function buildAdapter(cfg: PrinterConfig): Adapter {
  if (cfg.adapterType === 'bambu') {
    if (!cfg.adapterSerial) throw new Error(`[${cfg.name}] Seriennummer fehlt in der Konfiguration.`);
    return new BambuAdapter(cfg.adapterUrl, cfg.adapterSerial, cfg.adapterApiKey, cfg.id);
  }
  if (cfg.adapterType === 'moonraker') {
    return new MoonrakerAdapter(cfg.adapterUrl, cfg.adapterApiKey);
  }
  throw new Error(`Unbekannter Adapter: ${cfg.adapterType}`);
}

function makePrinterState(): PrinterBridgeState {
  return { snapshot: null, lastPushAt: null, running: false, error: null, adapter: null };
}

const runningBridges = new Map<string, () => void>();

function startPrinter(cfg: PrinterConfig): void {
  // Stop existing instance if already running
  runningBridges.get(cfg.id)?.();

  let state = printerStates.get(cfg.id);
  if (!state) {
    state = makePrinterState();
    printerStates.set(cfg.id, state);
  }
  state.running = true;
  state.error   = null;

  const adapter = buildAdapter(cfg);
  state.adapter = adapter;

  let cancelled = false;
  runningBridges.set(cfg.id, () => { cancelled = true; state!.running = false; });

  runBridge(adapter, cfg, state, () => cancelled).catch(err => {
    state!.error   = String(err);
    state!.running = false;
  });
  console.log(`[flownt-bridge] Drucker gestartet: ${cfg.name}`);
}

function stopPrinter(id: string): void {
  runningBridges.get(id)?.();
  runningBridges.delete(id);
  const state = printerStates.get(id);
  if (state) state.running = false;
}

// Start web UI
startServer({
  onAdd(cfg) {
    startPrinter(cfg);
  },
  onUpdate(cfg) {
    // Restart with updated config
    startPrinter(cfg);
  },
  onDelete(id) {
    stopPrinter(id);
    printerStates.delete(id);
  },
});

// Start all configured printers immediately
const existing = loadMultiConfig();
if (existing.printers.length > 0) {
  console.log(`[flownt-bridge] ${existing.printers.length} Drucker gefunden. Starte alle…`);
  for (const printer of existing.printers) {
    startPrinter(printer);
  }
  console.log(`[flownt-bridge] Status: ${URL}`);
} else {
  console.log(`[flownt-bridge] Noch nicht eingerichtet. Öffne ${URL}/setup/new im Browser…`);
  const isHeadless = process.platform === 'linux' && !process.env.DISPLAY;
  if (!isHeadless) open(`${URL}/setup/new`).catch(() => {});
}
