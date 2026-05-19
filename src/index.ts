import { config } from './config.js';
import { MoonrakerAdapter } from './adapters/moonraker.js';
import { BambuAdapter } from './adapters/bambu.js';
import { runBridge } from './bridge.js';

function buildAdapter() {
  if (config.adapterType === 'moonraker') {
    return new MoonrakerAdapter(config.adapterUrl, config.adapterApiKey);
  }
  if (config.adapterType === 'bambu') {
    if (!config.adapterSerial) throw new Error('ADAPTER_SERIAL is required for Bambu adapter');
    return new BambuAdapter(config.adapterUrl, config.adapterSerial, config.adapterApiKey);
  }
  throw new Error(`Unknown adapter type: ${config.adapterType}`);
}

runBridge(buildAdapter()).catch(err => {
  console.error('[flownt-bridge] Fatal:', err);
  process.exit(1);
});
