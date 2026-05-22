import express from 'express';
import https from 'https';
import http from 'http';
import { execFile } from 'child_process';
import { promises as fs } from 'fs';
import { randomUUID } from 'crypto';
import { loadConfig, saveConfig, configExists, BridgeConfig, FLOWNT_EDGE_URL } from './config.js';
import { PrinterSnapshot } from './adapters/types.js';

const PORT = 7432;

// Shared state updated by the bridge loop
export const bridgeState = {
  snapshot: null as PrinterSnapshot | null,
  lastPushAt: null as Date | null,
  running: false,
  error: null as string | null,
};

function html(title: string, body: string) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title} – Flownt Bridge</title>
<style>
  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; background: #0f0f0f; color: #e5e5e5; min-height: 100vh; display: flex; flex-direction: column; align-items: center; padding: 2rem 1rem; }
  .card { background: #1a1a1a; border: 1px solid #2a2a2a; border-radius: 16px; padding: 2rem; width: 100%; max-width: 480px; }
  .logo { font-size: 1.25rem; font-weight: 700; color: #ff7a2f; margin-bottom: 2rem; text-align: center; letter-spacing: -0.5px; }
  h1 { font-size: 1.1rem; font-weight: 600; margin-bottom: 0.5rem; }
  p { color: #888; font-size: 0.875rem; line-height: 1.5; margin-bottom: 1.5rem; }
  label { display: block; font-size: 0.75rem; color: #888; margin-bottom: 0.375rem; font-weight: 500; }
  input, select { width: 100%; background: #111; border: 1px solid #333; border-radius: 8px; padding: 0.625rem 0.875rem; color: #e5e5e5; font-size: 0.9rem; margin-bottom: 1rem; outline: none; }
  input:focus, select:focus { border-color: #ff7a2f; }
  .btn { width: 100%; background: #ff7a2f; color: #fff; border: none; border-radius: 8px; padding: 0.75rem; font-size: 0.9rem; font-weight: 600; cursor: pointer; margin-top: 0.5rem; }
  .btn:hover { background: #e06820; }
  .btn-ghost { background: transparent; border: 1px solid #333; color: #888; margin-top: 0.5rem; }
  .btn-ghost:hover { border-color: #555; color: #e5e5e5; }
  .hint { font-size: 0.75rem; color: #555; margin-top: -0.75rem; margin-bottom: 1rem; }
  .status-dot { width: 10px; height: 10px; border-radius: 50%; display: inline-block; margin-right: 6px; }
  .green { background: #10b981; } .gray { background: #555; } .red { background: #ef4444; }
  .row { display: flex; gap: 1rem; }
  .row > div { flex: 1; }
  .badge { display: inline-block; background: #ff7a2f22; color: #ff7a2f; border-radius: 6px; padding: 2px 8px; font-size: 0.75rem; font-weight: 600; }
  #adapter-bambu, #adapter-moonraker { display: none; }
</style>
</head>
<body>
<div class="logo">⬡ Flownt Bridge</div>
${body}
</body>
</html>`;
}

function setupPage(error?: string) {
  const cfg = loadConfig();
  const isBambu = !cfg || cfg.adapterType === 'bambu';
  return html('Setup', `
<div class="card">
  <h1>Setup</h1>
  <p>Connect your printer to Flownt. You only need the credentials from Flownt and your printer.</p>
  ${error ? `<p style="color:#ef4444;background:#ef444420;padding:0.75rem;border-radius:8px;margin-bottom:1rem;">${error}</p>` : ''}
  <form method="POST" action="/setup">

    <label>Flownt Auth Token</label>
    <input name="token" type="password" placeholder="Copy from Flownt (Printer → Edit → Bridge)" value="${cfg?.flowntAuthToken ?? ''}" required/>
    <p class="hint">Open Flownt → Edit printer → Bridge Connection → Copy token</p>

    <label>Printer Type</label>
    <select name="adapterType" id="adapterTypeSelect" onchange="switchAdapter(this.value)">
      <option value="bambu" ${isBambu ? 'selected' : ''}>Bambu Lab (X1, P1, A1, …)</option>
      <option value="moonraker" ${!isBambu ? 'selected' : ''}>Moonraker / Klipper</option>
    </select>

    <div id="adapter-bambu">
      <label>Printer IP Address</label>
      <input name="bambuUrl" placeholder="192.168.1.100" value="${cfg?.adapterType === 'bambu' ? cfg.adapterUrl : ''}"/>
      <label>Serial Number</label>
      <input name="bambuSerial" placeholder="00M09A123456789" value="${cfg?.adapterType === 'bambu' ? cfg.adapterSerial : ''}"/>
      <label>Access Code</label>
      <input name="bambuCode" type="password" placeholder="8-digit code from the display" value="${cfg?.adapterType === 'bambu' ? cfg.adapterApiKey : ''}"/>
      <p class="hint">Find all three values on the printer display under Settings → Network.</p>
    </div>

    <div id="adapter-moonraker">
      <label>Printer URL</label>
      <input name="moonrakerUrl" placeholder="http://192.168.1.100" value="${cfg?.adapterType === 'moonraker' ? cfg.adapterUrl : ''}"/>
      <label>API Key (optional)</label>
      <input name="moonrakerKey" type="password" placeholder="Leave empty if not set" value="${cfg?.adapterType === 'moonraker' ? cfg.adapterApiKey : ''}"/>
    </div>

    <button class="btn" type="submit">Save &amp; Connect</button>
  </form>
</div>
<script>
  function switchAdapter(val) {
    document.getElementById('adapter-bambu').style.display = val === 'bambu' ? 'block' : 'none';
    document.getElementById('adapter-moonraker').style.display = val === 'moonraker' ? 'block' : 'none';
  }
  switchAdapter(document.getElementById('adapterTypeSelect').value);
</script>`);
}

function statusPage() {
  const cfg = loadConfig();
  const s = bridgeState.snapshot;
  const statusColor = s?.status === 'printing' ? 'green' : s?.status === 'error' ? 'red' : s?.status === 'idle' ? 'green' : 'gray';
  const statusLabel = s?.status === 'printing' ? 'Printing' : s?.status === 'error' ? 'Error' : s?.status === 'idle' ? 'Ready' : 'Offline';
  const lastPush = bridgeState.lastPushAt ? bridgeState.lastPushAt.toLocaleTimeString('en-US') : '–';
  const adapterLabel = cfg?.adapterType === 'bambu' ? 'Bambu Lab' : 'Moonraker';
  return html('Status', `
<div class="card">
  <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:1.5rem;">
    <h1>Status</h1>
    <span class="badge">${adapterLabel}</span>
  </div>
  <div style="background:#111;border-radius:12px;padding:1.25rem;margin-bottom:1.5rem;">
    <div style="font-size:0.75rem;color:#555;margin-bottom:0.5rem;">PRINTER STATUS</div>
    <div style="font-size:1.5rem;font-weight:700;display:flex;align-items:center;">
      <span class="status-dot ${statusColor}"></span>${statusLabel}
    </div>
    ${s?.printFile ? `<div style="color:#888;font-size:0.8rem;margin-top:0.5rem;">📄 ${s.printFile}${s.progressPct != null ? ` · ${s.progressPct}%` : ''}</div>` : ''}
    ${s?.tempHotend != null ? `<div style="color:#888;font-size:0.8rem;margin-top:0.25rem;">🌡 Nozzle ${s.tempHotend}°C${s.tempBed != null ? ` · Bed ${s.tempBed}°C` : ''}</div>` : ''}
  </div>
  <div style="font-size:0.8rem;color:#555;">Last update: ${lastPush}</div>
  ${bridgeState.error ? `<div style="color:#ef4444;margin-top:0.75rem;font-size:0.8rem;">⚠ ${bridgeState.error}</div>` : ''}
  <a href="/setup"><button class="btn btn-ghost" style="margin-top:1.5rem;">Change settings</button></a>
</div>
<script>setTimeout(() => location.reload(), 15000);</script>`);
}

// Dymo Connect Proxy — ruft Dymo von localhost aus, umgeht die Origin-Beschränkung.
// Reihenfolge: HTTP 41951 zuerst (Standard-Modus), dann HTTPS 41951, dann HTTP 41952.
function callDymoConnect(body: string): Promise<string> {
  const candidates: Array<{ mod: typeof https | typeof http; port: number; proto: string }> = [
    { mod: http,  port: 41951, proto: 'http'  },
    { mod: https, port: 41951, proto: 'https' },
    { mod: http,  port: 41952, proto: 'http'  },
  ];
  const tryNext = (i: number): Promise<string> => {
    if (i >= candidates.length) return Promise.reject(new Error('Dymo Connect nicht erreichbar'));
    const { mod, port, proto } = candidates[i];
    return new Promise<string>((resolve, reject) => {
      const options = {
        hostname: 'localhost', port,
        path: '/DYMO/DLS/Printing/PrintLabel',
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'Content-Length': Buffer.byteLength(body),
        },
        rejectUnauthorized: false,
      };
      const req = mod.request(options, (res) => {
        let data = '';
        res.on('data', (chunk: Buffer) => { data += chunk.toString(); });
        res.on('end', () => { console.log(`[dymo] ${proto}:${port} → "${data.trim()}"`); resolve(data); });
      });
      req.on('error', () => tryNext(i + 1).then(resolve, reject));
      req.write(body);
      req.end();
    });
  };
  return tryNext(0);
}

export function startServer(onConfigSaved: (cfg: BridgeConfig) => void): void {
  const app = express();
  app.use(express.urlencoded({ extended: true }));
  app.use(express.json({ limit: '10mb' }));

  // Dymo-Proxy: CORS damit die Vercel-App http://localhost:7432 ansprechen kann
  app.use('/dymo', (_req, res, next) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    next();
  });
  app.options('/dymo/print', (_req, res) => res.sendStatus(204));
  app.post('/dymo/print', async (req, res) => {
    const { printerName, labelXml, pngBase64, widthMm, heightMm } = req.body as {
      printerName?: string; labelXml?: string;
      pngBase64?: string; widthMm?: number; heightMm?: number;
    };
    if (!printerName || !labelXml) {
      return res.status(400).json({ ok: false, error: 'printerName and labelXml are required' });
    }

    // Versuch 1: Dymo Connect REST API
    try {
      const body = new URLSearchParams({
        printerName, printParamsXml: '', labelXml,
        labelSetXml: '<LabelSet><LabelSetRecord/></LabelSet>',
      }).toString();
      const result = await callDymoConnect(body);
      const norm = result.trim().toLowerCase();
      if (!norm || norm === 'true') return res.json({ ok: true });
      if (norm.includes('error') || norm.includes('exception')) return res.json({ ok: false, error: `Dymo: ${result.slice(0, 200)}` });
      // norm === 'false' → weiter zu Fallback
    } catch { /* fall through to CUPS fallback */ }

    // Fallback: macOS lp command via CUPS driver
    if (!pngBase64) {
      return res.json({ ok: false, error: 'Dymo REST API rejected. No PNG fallback provided.' });
    }
    const tmpFile = `/tmp/dymo_${randomUUID()}.png`;
    try {
      await fs.writeFile(tmpFile, Buffer.from(pngBase64, 'base64'));
      // Exakte PPD-Papiergrößen des DYMO-Treibers (mm-Werte stimmen nicht exakt mit pt-Werten überein)
      // Pixel werden aus den pt-Werten der PPD errechnet, nicht aus mm — verhindert Verzerrung.
      const DYMO_PPD: Record<string, { name: string; wPts: number; hPts: number }> = {
        '57x32': { name: 'w162h90', wPts: 162, hPts: 90 },
        '54x25': { name: 'w154h64', wPts: 154, hPts: 64 },
        '89x28': { name: 'w79h252', wPts: 79,  hPts: 252 },
      };
      const sizeKey = `${Math.round(widthMm ?? 57)}x${Math.round(heightMm ?? 32)}`;
      const dymo = DYMO_PPD[sizeKey];
      const mediaName = dymo ? dymo.name : `Custom.${Math.round((widthMm ?? 57) / 25.4 * 72)}x${Math.round((heightMm ?? 32) / 25.4 * 72)}`;
      const wPx = dymo ? Math.round(dymo.wPts / 72 * 300) : Math.round((widthMm ?? 57) / 25.4 * 300);
      const hPx = dymo ? Math.round(dymo.hPts / 72 * 300) : Math.round((heightMm ?? 32) / 25.4 * 300);
      await new Promise<void>((resolve, reject) => {
        execFile('sips', ['-z', String(hPx), String(wPx), tmpFile],
          (err) => { if (err) reject(err); else resolve(); });
      });
      // CUPS ersetzt Leerzeichen durch Unterstriche im Druckernamen
      const cupsName = printerName.replace(/ /g, '_');
      console.log(`[dymo-bridge] lp: ${cupsName} media=${mediaName} ppi=300 (${wPx}x${hPx}px)`);
      await new Promise<void>((resolve, reject) => {
        execFile('lp', [
          '-d', cupsName,
          '-o', `media=${mediaName}`,
          '-o', 'ppi=300',
          tmpFile,
        ], (err) => { if (err) reject(err); else resolve(); });
      });
      console.log(`[dymo-bridge] lp ✓`);
      return res.json({ ok: true });
    } catch (e) {
      console.error(`[dymo-bridge] lp failed:`, e);
      return res.status(500).json({ ok: false, error: `lp: ${String(e)}` });
    } finally {
      fs.unlink(tmpFile).catch(() => {});
    }
  });

  app.get('/', (_req, res) => {
    res.send(configExists() ? statusPage() : setupPage());
  });


  app.get('/setup', (_req, res) => res.send(setupPage()));

  app.post('/setup', (req, res) => {
    const { token, adapterType, bambuUrl, bambuSerial, bambuCode, moonrakerUrl, moonrakerKey } = req.body as Record<string, string>;
    if (!token) {
      return res.send(setupPage('Please enter the auth token from Flownt.'));
    }
    const isBambu = adapterType === 'bambu';
    if (isBambu && (!bambuUrl || !bambuSerial || !bambuCode)) {
      return res.send(setupPage('Please fill in IP address, serial number and access code.'));
    }
    if (!isBambu && !moonrakerUrl) {
      return res.send(setupPage('Please enter the printer URL.'));
    }
    const cfg: BridgeConfig = {
      flowntAuthToken: token.trim(),
      adapterType: isBambu ? 'bambu' : 'moonraker',
      adapterUrl: isBambu ? bambuUrl.trim() : moonrakerUrl.trim(),
      adapterApiKey: isBambu ? bambuCode.trim() : (moonrakerKey ?? '').trim(),
      adapterSerial: isBambu ? bambuSerial.trim() : '',
      pollingIntervalMs: 30_000,
    };
    saveConfig(cfg);
    onConfigSaved(cfg);
    res.redirect('/');
  });

  app.listen(PORT, () => {
    console.log(`[flownt-bridge] Web UI running at http://localhost:${PORT}`);
  });
}

