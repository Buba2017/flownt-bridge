import open from 'open';
import { loadMultiConfig, PrinterConfig, FLOWNT_EDGE_URL, needsAccessCode } from './config.js';
import { MoonrakerAdapter } from './adapters/moonraker.js';
import { PrusaLinkAdapter } from './adapters/prusa.js';
import { BambuAdapter } from './adapters/bambu.js';
import { startServer, printerStates, PrinterBridgeState } from './server.js';
import { runBridge } from './bridge.js';
import { Adapter, PrinterSnapshot } from './adapters/types.js';
import { BRIDGE_VERSION } from './version.js';
import { startDiscovery } from './link/discovery.js';
import { pair, startSyncLoop, syncNow, type LinkCallbacks } from './link/sync.js';
import { createLogger, enableFileLogging, installConsoleCapture, logFileFromArgs } from './logger.js';
import { registerHealthProvider } from './health-registry.js';
import { getOutbox, outboxStats } from './outbox.js';

// Logging first: timestamps/levels for every console line, optional rotating log file.
installConsoleCapture();
const logFile = logFileFromArgs();
if (logFile && enableFileLogging(logFile)) process.stdout.write(`[flownt-bridge] logging to ${logFile}\n`);
const log = createLogger('flownt-bridge');

// Job end events waiting for delivery to Flownt (persistent outbox) in /healthz.
registerHealthProvider('outbox', () => {
  const s = outboxStats();
  return { pending: s.pending, oldest_age_s: s.oldestAgeS, awaiting_material: s.awaitingMaterial, rejected: s.rejected };
});
// Queued job ends always go out with the printer's current Flownt token.
getOutbox().setTokenResolver(id => loadMultiConfig().printers.find(p => p.id === id)?.flowntAuthToken ?? null);

// A rejected promise nobody awaited is a bug, but not worth dropping live printer
// connections for: log it with its stack and keep running. An uncaught exception
// leaves the process in an unknown state: log it and exit non-zero so the service
// manager (systemd / launchd / scheduled task) restarts a clean process.
process.on('unhandledRejection', (reason) => {
  log.error('Unhandled promise rejection:', reason);
});
process.on('uncaughtException', (err, origin) => {
  log.error(`Uncaught exception (${origin}) — exiting:`, err);
  process.exit(1);
});

const PORT = Number(process.env.FLOWNT_BRIDGE_PORT) || 7432;
const URL  = `http://localhost:${PORT}`;

log.info(`v${BRIDGE_VERSION} startet…`);
log.info(`Flownt backend: ${FLOWNT_EDGE_URL}`);

function buildAdapter(cfg: PrinterConfig): Adapter {
  if (cfg.adapterType === 'bambu') {
    if (!cfg.adapterSerial) throw new Error(`[${cfg.name}] Seriennummer fehlt in der Konfiguration.`);
    return new BambuAdapter(cfg.adapterUrl, cfg.adapterSerial, cfg.adapterApiKey, cfg.id);
  }
  if (cfg.adapterType === 'moonraker') {
    return new MoonrakerAdapter(cfg.adapterUrl, cfg.adapterApiKey);
  }
  if (cfg.adapterType === 'prusa') {
    return new PrusaLinkAdapter(cfg.adapterUrl, cfg.adapterApiKey);
  }
  throw new Error(`Unbekannter Adapter: ${cfg.adapterType}`);
}

function makePrinterState(): PrinterBridgeState {
  // The snapshot setter records when the adapter last delivered data (for /healthz).
  let snapshot: PrinterSnapshot | null = null;
  const state = { lastPushAt: null, running: false, error: null, adapter: null, lastSnapshotAt: null } as unknown as PrinterBridgeState;
  Object.defineProperty(state, 'snapshot', {
    enumerable: true,
    get: () => snapshot,
    set: (value: PrinterSnapshot | null) => { snapshot = value; if (value) state.lastSnapshotAt = new Date(); },
  });
  return state;
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
  state.error = null;
  if (needsAccessCode(cfg)) {
    // Shown as "access code missing" in the web UI; started once a code is saved.
    state.running = false;
    log.info(`${cfg.name}: wartet auf Access Code`);
    return;
  }
  let adapter: Adapter;
  try {
    adapter = buildAdapter(cfg);
  } catch (e) {
    // A broken printer entry (e.g. missing serial) must not take down the other printers.
    state.running = false;
    state.error = (e as Error).message;
    log.error(`${cfg.name}: cannot start:`, (e as Error).message);
    return;
  }
  state.running = true;
  state.adapter = adapter;

  let cancelled = false;
  runningBridges.set(cfg.id, () => {
    cancelled = true;
    state!.running = false;
    // Adapter mit abbauen: sonst reconnectet der alte MQTT-Client ewig weiter und
    // kämpft am A1/P1 mit dem neuen um den einzigen lokalen Verbindungs-Slot.
    adapter.dispose?.();
  });

  runBridge(adapter, cfg, state, () => cancelled).catch(err => {
    log.error(`${cfg.name}: bridge loop stopped:`, err);
    state!.error   = String(err);
    state!.running = false;
  });
  log.info(`Drucker gestartet: ${cfg.name}`);
}

function stopPrinter(id: string): void {
  runningBridges.get(id)?.();
  runningBridges.delete(id);
  const state = printerStates.get(id);
  if (state) state.running = false;
}

const printerCallbacks: LinkCallbacks = {
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
  isConnected(id) {
    const s = printerStates.get(id);
    return !!s?.running && !s.error && !!s.snapshot && s.snapshot.status !== 'offline';
  },
};

// Start web UI
startServer({
  ...printerCallbacks,
  async onPair(code, name) {
    try {
      await pair(code, name);
      startSyncLoop(printerCallbacks);
      await syncNow(printerCallbacks);
      return null;
    } catch (e) {
      return (e as Error).message;
    }
  },
});

// LAN discovery runs for monitoring bridges; it only listens.
const role = loadMultiConfig().role;
if (role !== 'label') startDiscovery();

// Linked to Flownt: printers and access codes come from there. A pairing code in the
// environment pairs a headless bridge once (e.g. systemd EnvironmentFile).
if (loadMultiConfig().link) {
  startSyncLoop(printerCallbacks);
} else if (process.env.FLOWNT_PAIRING_CODE?.trim()) {
  pair(process.env.FLOWNT_PAIRING_CODE, process.env.FLOWNT_BRIDGE_NAME)
    .then(() => startSyncLoop(printerCallbacks))
    .catch(e => createLogger('link').error(`Kopplung mit FLOWNT_PAIRING_CODE fehlgeschlagen: ${(e as Error).message}`));
}

// Start all configured printers immediately
const existing = loadMultiConfig();
if (existing.printers.length > 0) {
  log.info(`${existing.printers.length} Drucker gefunden. Starte alle…`);
  for (const printer of existing.printers) {
    startPrinter(printer);
  }
  log.info(`Status: ${URL}`);
} else {
  log.info(`Noch nicht eingerichtet. Öffne ${URL} im Browser…`);
  const isHeadless = process.platform === 'linux' && !process.env.DISPLAY;
  if (!isHeadless) open(`${URL}/`).catch(() => {});
}
