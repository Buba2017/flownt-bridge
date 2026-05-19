import open from 'open';
import { loadConfig, BridgeConfig } from './config.js';
import { MoonrakerAdapter } from './adapters/moonraker.js';
import { BambuAdapter } from './adapters/bambu.js';
import { startServer, bridgeState } from './server.js';
import { runBridge } from './bridge.js';
import { Adapter } from './adapters/types.js';

const PORT = 7432;
const URL  = `http://localhost:${PORT}`;

function buildAdapter(cfg: BridgeConfig): Adapter {
  if (cfg.adapterType === 'bambu') {
    if (!cfg.adapterSerial) throw new Error('Seriennummer fehlt in der Konfiguration.');
    return new BambuAdapter(cfg.adapterUrl, cfg.adapterSerial, cfg.adapterApiKey);
  }
  if (cfg.adapterType === 'moonraker') {
    return new MoonrakerAdapter(cfg.adapterUrl, cfg.adapterApiKey);
  }
  throw new Error(`Unbekannter Adapter: ${cfg.adapterType}`);
}

let stopBridge: (() => void) | null = null;

function startBridgeFromConfig(cfg: BridgeConfig): void {
  if (stopBridge) { stopBridge(); stopBridge = null; }
  bridgeState.running = true;
  bridgeState.error = null;
  const adapter = buildAdapter(cfg);
  let cancelled = false;
  stopBridge = () => { cancelled = true; bridgeState.running = false; };
  runBridge(adapter, cfg, bridgeState, () => cancelled).catch(err => {
    bridgeState.error = String(err);
    bridgeState.running = false;
  });
}

// Start web UI
startServer((cfg) => {
  console.log('[flownt-bridge] Konfiguration gespeichert. Starte Verbindung…');
  startBridgeFromConfig(cfg);
});

// Try to start immediately if already configured
const existing = loadConfig();
if (existing) {
  console.log('[flownt-bridge] Konfiguration gefunden. Starte direkt.');
  startBridgeFromConfig(existing);
  console.log(`[flownt-bridge] Status: ${URL}`);
} else {
  console.log(`[flownt-bridge] Noch nicht eingerichtet. Öffne ${URL}/setup im Browser…`);
  open(`${URL}/setup`);
}
