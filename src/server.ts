import express from 'express';
import https from 'https';
import http from 'http';
import { execFile } from 'child_process';
import { promises as fs } from 'fs';
import { randomUUID } from 'crypto';
import {
  loadMultiConfig, saveMultiConfig,
  PrinterConfig, BridgeLang, newPrinterId,
} from './config.js';
import { Adapter, PrinterCommand, PrinterSnapshot } from './adapters/types.js';
import { getEventLog } from './events.js';

const PORT = 7432;

// ── Shared state ──────────────────────────────────────────────────────────────

export interface PrinterBridgeState {
  snapshot: PrinterSnapshot | null;
  lastPushAt: Date | null;
  running: boolean;
  error: string | null;
  adapter: Adapter | null;
}

export const printerStates = new Map<string, PrinterBridgeState>();

export interface ServerCallbacks {
  onAdd(cfg: PrinterConfig): void;
  onUpdate(cfg: PrinterConfig): void;
  onDelete(id: string): void;
}

// ── Translations ──────────────────────────────────────────────────────────────

interface Tr {
  bridge: string; status: string; settings: string; addPrinter: string;
  editPrinter: string; myPrinters: string; printerName: string;
  printerNamePlaceholder: string; printerType: string; authToken: string;
  authTokenHint: string; ipAddress: string; serial: string;
  serialPlaceholder: string; accessCode: string; accessCodeHint: string;
  printerUrl: string; apiKey: string; bambuCloud: string;
  cloudEmail: string; cloudEmailHint: string; cloudPassword: string;
  save: string; cancel: string; delete: string; edit: string;
  backToStatus: string; noPrinters: string; language: string;
  printing: string; idle: string; error: string; offline: string;
  paused: string; lastUpdate: string; noEvents: string; events: string;
  bed: string; tokenRequired: string; bambuFieldsRequired: string;
  moonrakerUrlRequired: string; nameRequired: string; confirmDelete: string;
  smartPlug: string; smartPlugIp: string; smartPlugHint: string;
}

const T: Record<BridgeLang, Tr> = {
  de: {
    bridge: 'Flownt Bridge',
    status: 'Status',
    settings: 'Einstellungen',
    addPrinter: '+ Drucker',
    editPrinter: 'Drucker bearbeiten',
    myPrinters: 'Meine Drucker',
    printerName: 'Name',
    printerNamePlaceholder: 'z.B. X1C Werkstatt',
    printerType: 'Drucker-Typ',
    authToken: 'Flownt Auth-Token',
    authTokenHint: 'In Flownt → Drucker bearbeiten → Bridge → Token kopieren',
    ipAddress: 'IP-Adresse',
    serial: 'Seriennummer',
    serialPlaceholder: '00M09A123456789',
    accessCode: 'Access Code',
    accessCodeHint: 'Alle drei Werte auf dem Druckerdisplay unter Einstellungen → Netzwerk.',
    printerUrl: 'Drucker-URL',
    apiKey: 'API-Key (optional)',
    bambuCloud: 'Bambu Cloud (optional)',
    cloudEmail: 'Bambu Cloud E-Mail',
    cloudEmailHint: 'Optional — liest Filamentgewicht automatisch nach Druckende aus der Bambu Cloud.',
    cloudPassword: 'Bambu Cloud Passwort',
    save: 'Speichern & Verbinden',
    cancel: 'Abbrechen',
    delete: 'Löschen',
    edit: 'Bearbeiten',
    backToStatus: '← Status',
    noPrinters: 'Noch keine Drucker konfiguriert.',
    language: 'Sprache',
    printing: 'Druckt',
    idle: 'Bereit',
    error: 'Fehler',
    offline: 'Offline',
    paused: 'Pausiert',
    lastUpdate: 'Letztes Update',
    noEvents: 'Noch keine Ereignisse.',
    events: 'Ereignisse',
    bed: 'Bett',
    tokenRequired: 'Bitte Auth-Token eingeben.',
    bambuFieldsRequired: 'Bitte IP-Adresse, Seriennummer und Access Code eingeben.',
    moonrakerUrlRequired: 'Bitte Drucker-URL eingeben.',
    nameRequired: 'Bitte einen Namen eingeben.',
    confirmDelete: 'Drucker wirklich löschen?',
    smartPlug: 'Smart-Plug / Strommessung (optional)',
    smartPlugIp: 'Shelly IP-Adresse',
    smartPlugHint: 'Optional — Shelly (Gen 1/2/3) im LAN für echte Strommessung. Leer lassen, wenn keiner vorhanden.',
  },
  en: {
    bridge: 'Flownt Bridge',
    status: 'Status',
    settings: 'Settings',
    addPrinter: '+ Printer',
    editPrinter: 'Edit Printer',
    myPrinters: 'My Printers',
    printerName: 'Name',
    printerNamePlaceholder: 'e.g. X1C Workshop',
    printerType: 'Printer Type',
    authToken: 'Flownt Auth Token',
    authTokenHint: 'Open Flownt → Edit printer → Bridge Connection → Copy token',
    ipAddress: 'IP Address',
    serial: 'Serial Number',
    serialPlaceholder: '00M09A123456789',
    accessCode: 'Access Code',
    accessCodeHint: 'Find all three values on the printer display under Settings → Network.',
    printerUrl: 'Printer URL',
    apiKey: 'API Key (optional)',
    bambuCloud: 'Bambu Cloud (optional)',
    cloudEmail: 'Bambu Cloud Email',
    cloudEmailHint: 'Optional — reads filament weight automatically from Bambu Cloud after each print.',
    cloudPassword: 'Bambu Cloud Password',
    save: 'Save & Connect',
    cancel: 'Cancel',
    delete: 'Delete',
    edit: 'Edit',
    backToStatus: '← Status',
    noPrinters: 'No printers configured yet.',
    language: 'Language',
    printing: 'Printing',
    idle: 'Ready',
    error: 'Error',
    offline: 'Offline',
    paused: 'Paused',
    lastUpdate: 'Last update',
    noEvents: 'No events yet.',
    events: 'Events',
    bed: 'Bed',
    tokenRequired: 'Please enter the auth token.',
    bambuFieldsRequired: 'Please fill in IP address, serial number and access code.',
    moonrakerUrlRequired: 'Please enter the printer URL.',
    nameRequired: 'Please enter a name.',
    confirmDelete: 'Really delete this printer?',
    smartPlug: 'Smart plug / power metering (optional)',
    smartPlugIp: 'Shelly IP address',
    smartPlugHint: 'Optional — a Shelly (Gen 1/2/3) on your LAN for real power metering. Leave empty if you don\'t have one.',
  },
} as const;

function getLang(): BridgeLang { return loadMultiConfig().language; }
function tr(): Tr { return T[getLang()]; }

// ── HTML shell ─────────────────────────────────────────────────────────────────

function html(title: string, body: string, autoRefresh = false): string {
  const lang = getLang();
  return `<!DOCTYPE html>
<html lang="${lang}">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title} – Flownt Bridge</title>
<style>
  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; background: #0f0f0f; color: #e5e5e5; min-height: 100vh; display: flex; flex-direction: column; align-items: center; padding: 1.5rem 1rem; gap: 1rem; }
  .topbar { width: 100%; max-width: 960px; display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap; gap: 0.5rem; margin-bottom: 0.25rem; }
  .logo { font-size: 1.1rem; font-weight: 700; color: #ff7a2f; letter-spacing: -0.5px; }
  .topbar-right { display: flex; gap: 0.5rem; align-items: center; flex-wrap: wrap; }
  .card { background: #1a1a1a; border: 1px solid #2a2a2a; border-radius: 16px; padding: 1.5rem; width: 100%; max-width: 960px; }
  .card-sm { max-width: 480px; }
  .printer-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(400px, 1fr)); gap: 1rem; width: 100%; max-width: 960px; }
  h1 { font-size: 1.05rem; font-weight: 600; margin-bottom: 1rem; }
  p.hint { color: #555; font-size: 0.75rem; margin-top: -0.75rem; margin-bottom: 1rem; }
  label { display: block; font-size: 0.75rem; color: #888; margin-bottom: 0.375rem; font-weight: 500; }
  input, select { width: 100%; background: #111; border: 1px solid #333; border-radius: 8px; padding: 0.625rem 0.875rem; color: #e5e5e5; font-size: 0.9rem; margin-bottom: 1rem; outline: none; }
  input:focus, select:focus { border-color: #ff7a2f; }
  .btn { background: #ff7a2f; color: #fff; border: none; border-radius: 8px; padding: 0.5rem 1rem; font-size: 0.85rem; font-weight: 600; cursor: pointer; text-decoration: none; display: inline-flex; align-items: center; }
  .btn:hover { background: #e06820; }
  .btn-ghost { background: transparent; border: 1px solid #333; color: #999; }
  .btn-ghost:hover { border-color: #555; color: #e5e5e5; }
  .btn-danger { background: #ef444415; border: 1px solid #ef444430; color: #ef4444; }
  .btn-danger:hover { background: #ef444425; }
  .btn-full { width: 100%; justify-content: center; margin-top: 0.25rem; }
  .badge { display: inline-block; background: #ff7a2f22; color: #ff7a2f; border-radius: 6px; padding: 2px 8px; font-size: 0.72rem; font-weight: 600; }
  .dot { width: 9px; height: 9px; border-radius: 50%; display: inline-block; flex-shrink: 0; }
  .green { background: #10b981; } .gray { background: #444; } .red { background: #ef4444; } .yellow { background: #f59e0b; }
  .row { display: flex; gap: 1rem; }
  .row > div { flex: 1; }
  #adapter-bambu, #adapter-moonraker { display: none; }
  .printer-header { display: flex; align-items: center; gap: 0.625rem; margin-bottom: 1rem; }
  .printer-name { font-size: 0.95rem; font-weight: 700; flex: 1; }
  .stat-box { background: #111; border-radius: 10px; padding: 0.875rem; margin-bottom: 0.75rem; }
  .info-row { font-size: 0.8rem; color: #888; margin-top: 0.35rem; }
  .section-label { font-size: 0.68rem; color: #555; text-transform: uppercase; letter-spacing: 0.08em; margin-bottom: 0.5rem; }
  .ev-list { max-height: 150px; overflow-y: auto; }
  .ev-row { display: flex; gap: 0.4rem; padding: 0.25rem 0; border-bottom: 1px solid #1c1c1c; font-size: 0.73rem; }
  .ev-row:last-child { border-bottom: none; }
  .ev-icon { flex-shrink: 0; width: 12px; }
  .ev-time { color: #444; flex-shrink: 0; white-space: nowrap; }
  .ev-msg { color: #aaa; word-break: break-word; }
  .list-row { display: flex; align-items: center; padding: 0.7rem 0; border-bottom: 1px solid #1c1c1c; gap: 0.75rem; }
  .list-row:last-child { border-bottom: none; }
  .list-name { flex: 1; font-weight: 500; font-size: 0.9rem; }
  .list-sub { font-size: 0.73rem; color: #555; margin-top: 2px; }
  .lang-wrap { display: flex; align-items: center; gap: 0.375rem; }
  .lang-wrap label { margin: 0; font-size: 0.75rem; color: #555; }
  .lang-wrap select { margin: 0; width: auto; padding: 0.3rem 0.5rem; font-size: 0.78rem; }
  hr.sep { border: none; border-top: 1px solid #222; margin: 0.875rem 0; }
  .empty { color: #333; font-size: 0.85rem; text-align: center; padding: 1.5rem 0; }
  .err-banner { color: #ef4444; background: #ef444415; border: 1px solid #ef444430; border-radius: 8px; padding: 0.625rem 0.875rem; margin-bottom: 1rem; font-size: 0.85rem; }
</style>
</head>
<body>
${body}
${autoRefresh ? '<script>setTimeout(() => location.reload(), 8000);</script>' : ''}
</body>
</html>`;
}

// ── Language selector ──────────────────────────────────────────────────────────

function langSelector(returnUrl: string): string {
  const lang = getLang();
  const t = tr();
  return `<form class="lang-wrap" method="POST" action="/language">
    <input type="hidden" name="returnUrl" value="${returnUrl}"/>
    <label>${t.language}:</label>
    <select name="lang" onchange="this.form.submit()">
      <option value="de" ${lang === 'de' ? 'selected' : ''}>Deutsch</option>
      <option value="en" ${lang === 'en' ? 'selected' : ''}>English</option>
    </select>
  </form>`;
}

// ── Status page ────────────────────────────────────────────────────────────────

function statusPage(): string {
  const cfg = loadMultiConfig();
  const t = tr();

  const cards = cfg.printers.map(printer => {
    const state   = printerStates.get(printer.id);
    const snap    = state?.snapshot ?? null;
    const running = state?.running ?? false;

    const dotClass =
      !running                     ? 'gray'   :
      snap?.status === 'printing'  ? 'green'  :
      snap?.status === 'paused'    ? 'yellow' :
      snap?.status === 'error'     ? 'red'    :
      snap?.status === 'idle'      ? 'green'  : 'gray';

    const statusLabel =
      !running                     ? t.offline  :
      snap?.status === 'printing'  ? t.printing :
      snap?.status === 'paused'    ? t.paused   :
      snap?.status === 'error'     ? t.error    :
      snap?.status === 'idle'      ? t.idle     : t.offline;

    const lastPush = state?.lastPushAt
      ? state.lastPushAt.toLocaleTimeString(cfg.language === 'de' ? 'de-DE' : 'en-GB')
      : '–';

    const adapterLabel = printer.adapterType === 'bambu' ? 'Bambu Lab' : 'Moonraker';

    // ETA
    let etaStr = '';
    if (snap?.etaSec != null && snap.etaSec > 0) {
      const h = Math.floor(snap.etaSec / 3600);
      const m = Math.floor((snap.etaSec % 3600) / 60);
      etaStr = ` · ⏱ ${h > 0 ? `${h}h ${m}m` : `${m}m`}`;
    }

    // AMS slots grouped by unit
    let amsHtml = '';
    const slots    = snap?.amsSlots ?? [];
    const humidity = snap?.amsHumidity ?? [];
    if (slots.length > 0) {
      const unitMap = new Map<number, typeof slots>();
      for (const sl of slots) {
        if (!unitMap.has(sl.ams_unit)) unitMap.set(sl.ams_unit, []);
        unitMap.get(sl.ams_unit)!.push(sl);
      }
      const unitRows = [...unitMap.entries()].sort(([a], [b]) => a - b).map(([unitIdx, unitSlots]) => {
        const hum = humidity.find(h => h.ams_unit === unitIdx);
        const humStr = hum ? `<span style="font-size:0.68rem;color:#555;">💧 ${hum.humidity}/5 · ${hum.temp.toFixed(0)}°C</span>` : '';
        const slotDivs = unitSlots.map(sl => {
          const globalIdx = sl.ams_unit * 4 + sl.slot;
          const isActive  = snap?.activeMqttSlot === globalIdx;
          const ring      = isActive ? 'box-shadow:0 0 0 2px #ff7a2f;' : '';
          return `<div style="text-align:center;flex:1;min-width:0;">
            <div style="width:30px;height:30px;border-radius:50%;background:${sl.color};margin:0 auto 3px;${ring}border:1.5px solid rgba(128,128,128,0.5);"></div>
            <div style="font-size:0.63rem;color:#888;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${sl.material || '–'}</div>
            <div style="font-size:0.63rem;color:#555;">${sl.remain ?? 0}%</div>
          </div>`;
        }).join('');
        return `<div style="margin-bottom:${unitMap.size > 1 ? '0.75rem' : '0'};">
          ${(unitMap.size > 1 || humStr) ? `<div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:0.4rem;">
            ${unitMap.size > 1 ? `<span style="font-size:0.68rem;color:#444;">AMS ${unitIdx + 1}</span>` : '<span></span>'}
            ${humStr}
          </div>` : ''}
          <div style="display:flex;gap:0.625rem;">${slotDivs}</div>
        </div>`;
      }).join('');
      amsHtml = `<div class="stat-box" style="margin-bottom:0.75rem;">
        <div class="section-label">AMS</div>
        ${unitRows}
      </div>`;
    }

    // Event log (last 8)
    const evLog = getEventLog(printer.id);
    const evRows = evLog.length === 0
      ? `<div style="color:#333;font-size:0.78rem;padding:0.25rem 0;">${t.noEvents}</div>`
      : evLog.slice(0, 8).map(ev => {
          const icon  = ev.type === 'success' ? '✓' : ev.type === 'warn' ? '⚠' : 'ℹ';
          const color = ev.type === 'success' ? '#10b981' : ev.type === 'warn' ? '#f59e0b' : '#6b7280';
          const time  = ev.ts.toLocaleTimeString(cfg.language === 'de' ? 'de-DE' : 'en-GB', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
          return `<div class="ev-row">
            <span class="ev-icon" style="color:${color};">${icon}</span>
            <span class="ev-time">${time}</span>
            <span class="ev-msg">${ev.msg}</span>
          </div>`;
        }).join('');

    const errHtml = state?.error
      ? `<div style="color:#ef4444;font-size:0.75rem;margin-bottom:0.5rem;">⚠ ${state.error.slice(0, 80)}</div>`
      : '';

    return `<div class="card">
      <div class="printer-header">
        <span class="dot ${dotClass}"></span>
        <span class="printer-name">${printer.name}</span>
        <span class="badge">${adapterLabel}</span>
        <a href="/setup/${printer.id}" class="btn btn-ghost" style="padding:0.3rem 0.625rem;font-size:0.78rem;">${t.edit}</a>
      </div>
      <div class="stat-box">
        <div style="font-size:1.1rem;font-weight:700;">${statusLabel}</div>
        ${snap?.printFile ? `<div class="info-row">📄 ${snap.printFile}${snap.progressPct != null ? ` · ${snap.progressPct}%` : ''}${etaStr}</div>` : ''}
        ${snap?.tempHotend != null ? `<div class="info-row">🌡 ${snap.tempHotend}°C${snap.tempBed != null ? ` · ${t.bed} ${snap.tempBed}°C` : ''}</div>` : ''}
      </div>
      ${amsHtml}
      ${errHtml}
      <div style="font-size:0.73rem;color:#555;margin-bottom:0.625rem;">${t.lastUpdate}: ${lastPush}</div>
      <div class="section-label">${t.events}</div>
      <div class="ev-list">${evRows}</div>
    </div>`;
  }).join('');

  return html(t.status, `
<div class="topbar">
  <span class="logo">⬡ ${t.bridge}</span>
  <div class="topbar-right">
    ${langSelector('/')}
    <a href="/setup" class="btn btn-ghost">${t.settings}</a>
    <a href="/setup/new" class="btn">${t.addPrinter}</a>
  </div>
</div>
<div class="printer-grid">${cards}</div>`, true);
}

// ── Setup list page ────────────────────────────────────────────────────────────

function setupListPage(): string {
  const cfg = loadMultiConfig();
  const t = tr();

  const rows = cfg.printers.length === 0
    ? `<div class="empty">${t.noPrinters}</div>`
    : cfg.printers.map(p => {
        const adapterLabel = p.adapterType === 'bambu' ? 'Bambu Lab' : 'Moonraker';
        const state = printerStates.get(p.id);
        const dotClass = !state?.running ? 'gray' : state.snapshot?.status === 'printing' ? 'green' : 'green';
        return `<div class="list-row">
          <span class="dot ${dotClass}"></span>
          <div style="flex:1;">
            <div class="list-name">${p.name}</div>
            <div class="list-sub">${adapterLabel} · ${p.adapterUrl || '–'}</div>
          </div>
          <div style="display:flex;gap:0.375rem;">
            <a href="/setup/${p.id}" class="btn btn-ghost" style="padding:0.3rem 0.625rem;font-size:0.78rem;">${t.edit}</a>
            <form method="POST" action="/setup/${p.id}/delete" onsubmit="return confirm('${t.confirmDelete}')">
              <button type="submit" class="btn btn-danger" style="padding:0.3rem 0.625rem;font-size:0.78rem;">${t.delete}</button>
            </form>
          </div>
        </div>`;
      }).join('');

  return html(t.settings, `
<div class="topbar">
  <span class="logo">⬡ ${t.bridge}</span>
  <div class="topbar-right">
    ${langSelector('/setup')}
    ${cfg.printers.length > 0 ? `<a href="/" class="btn btn-ghost">${t.backToStatus}</a>` : ''}
  </div>
</div>
<div class="card card-sm">
  <h1>${t.myPrinters}</h1>
  ${rows}
  <div style="margin-top:1rem;">
    <a href="/setup/new" class="btn btn-full">${t.addPrinter}</a>
  </div>
</div>`);
}

// ── Add / Edit form ────────────────────────────────────────────────────────────

function printerFormPage(printer?: PrinterConfig, error?: string): string {
  const t = tr();
  const cfg = loadMultiConfig();
  const isEdit  = !!printer;
  const title   = isEdit ? t.editPrinter : t.addPrinter;
  const action  = isEdit ? `/setup/${printer!.id}` : '/setup/new';
  const isBambu = !printer || printer.adapterType === 'bambu';

  return html(title, `
<div class="topbar">
  <span class="logo">⬡ ${t.bridge}</span>
  <div class="topbar-right">
    ${langSelector(action)}
    <a href="${cfg.printers.length > 0 ? '/setup' : '/'}" class="btn btn-ghost">${t.cancel}</a>
  </div>
</div>
<div class="card card-sm">
  <h1>${title}</h1>
  ${error ? `<div class="err-banner">${error}</div>` : ''}
  <form method="POST" action="${action}">

    <label>${t.printerName}</label>
    <input name="name" placeholder="${t.printerNamePlaceholder}" value="${printer?.name ?? ''}" required/>

    <label>${t.authToken}</label>
    <input name="token" type="password" placeholder="xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx" value="${printer?.flowntAuthToken ?? ''}" required/>
    <p class="hint">${t.authTokenHint}</p>

    <label>${t.printerType}</label>
    <select name="adapterType" id="adapterTypeSelect" onchange="switchAdapter(this.value)">
      <option value="bambu"      ${isBambu  ? 'selected' : ''}>Bambu Lab (X1, P1, A1, H2D, …)</option>
      <option value="moonraker"  ${!isBambu ? 'selected' : ''}>Moonraker / Klipper</option>
    </select>

    <div id="adapter-bambu">
      <label>${t.ipAddress}</label>
      <input name="bambuUrl" placeholder="192.168.1.100" value="${printer?.adapterType === 'bambu' ? printer.adapterUrl : ''}"/>
      <label>${t.serial}</label>
      <input name="bambuSerial" placeholder="${t.serialPlaceholder}" value="${printer?.adapterType === 'bambu' ? printer.adapterSerial : ''}"/>
      <label>${t.accessCode}</label>
      <input name="bambuCode" type="password" placeholder="8-stelliger Code" value="${printer?.adapterType === 'bambu' ? printer.adapterApiKey : ''}"/>
      <p class="hint">${t.accessCodeHint}</p>
      <hr class="sep"/>
      <div class="section-label" style="margin-bottom:0.625rem;">${t.bambuCloud}</div>
      <label>${t.cloudEmail}</label>
      <input name="bambuCloudEmail" type="email" placeholder="email@example.com" value="${printer?.bambuCloudEmail ?? ''}"/>
      <label>${t.cloudPassword}</label>
      <input name="bambuCloudPassword" type="password" value="${printer?.bambuCloudPassword ?? ''}"/>
      <p class="hint">${t.cloudEmailHint}</p>
    </div>

    <div id="adapter-moonraker">
      <label>${t.printerUrl}</label>
      <input name="moonrakerUrl" placeholder="http://192.168.1.100" value="${printer?.adapterType === 'moonraker' ? printer.adapterUrl : ''}"/>
      <label>${t.apiKey}</label>
      <input name="moonrakerKey" type="password" value="${printer?.adapterType === 'moonraker' ? printer.adapterApiKey : ''}"/>
    </div>

    <hr class="sep"/>
    <div class="section-label" style="margin-bottom:0.625rem;">${t.smartPlug}</div>
    <label>${t.smartPlugIp}</label>
    <input name="shellyUrl" placeholder="192.168.1.50" value="${printer?.smartPlugUrl ?? ''}"/>
    <p class="hint">${t.smartPlugHint}</p>

    <button class="btn btn-full" type="submit" style="margin-top:0.5rem;">${t.save}</button>
  </form>
</div>
<script>
  function switchAdapter(val) {
    document.getElementById('adapter-bambu').style.display     = val === 'bambu'      ? 'block' : 'none';
    document.getElementById('adapter-moonraker').style.display = val === 'moonraker'  ? 'block' : 'none';
  }
  switchAdapter(document.getElementById('adapterTypeSelect').value);
</script>`);
}

// ── Form parser ────────────────────────────────────────────────────────────────

function parseForm(
  body: Record<string, string>,
  id: string,
): { cfg: PrinterConfig | null; error?: string } {
  const t = tr();
  const { name, token, adapterType, bambuUrl, bambuSerial, bambuCode, moonrakerUrl, moonrakerKey, bambuCloudEmail, bambuCloudPassword, shellyUrl } = body;
  if (!name?.trim())   return { cfg: null, error: t.nameRequired };
  if (!token?.trim())  return { cfg: null, error: t.tokenRequired };
  const isBambu = adapterType === 'bambu';
  if (isBambu  && (!bambuUrl?.trim() || !bambuSerial?.trim() || !bambuCode?.trim()))
    return { cfg: null, error: t.bambuFieldsRequired };
  if (!isBambu && !moonrakerUrl?.trim())
    return { cfg: null, error: t.moonrakerUrlRequired };

  return {
    cfg: {
      id,
      name:              name.trim(),
      flowntAuthToken:   token.trim(),
      adapterType:       isBambu ? 'bambu' : 'moonraker',
      adapterUrl:        isBambu ? bambuUrl.trim() : moonrakerUrl.trim(),
      adapterApiKey:     isBambu ? bambuCode.trim() : (moonrakerKey ?? '').trim(),
      adapterSerial:     isBambu ? bambuSerial.trim() : '',
      pollingIntervalMs: 30_000,
      ...(isBambu && bambuCloudEmail?.trim()    ? { bambuCloudEmail:    bambuCloudEmail.trim()    } : {}),
      ...(isBambu && bambuCloudPassword?.trim() ? { bambuCloudPassword: bambuCloudPassword.trim() } : {}),
      ...(shellyUrl?.trim() ? { smartPlugType: 'shelly' as const, smartPlugUrl: shellyUrl.trim() } : {}),
    },
  };
}

// ── Dymo Connect proxy ─────────────────────────────────────────────────────────

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

// ── Express server ─────────────────────────────────────────────────────────────

export function startServer(callbacks: ServerCallbacks): void {
  const app = express();
  app.use(express.urlencoded({ extended: true }));
  app.use(express.json({ limit: '10mb' }));

  function setCorsHeaders(req: express.Request, res: express.Response) {
    res.setHeader('Access-Control-Allow-Origin', req.headers.origin ?? '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Private-Network', 'true');
  }

  // ── Dymo proxy ─────────────────────────────────────────────────────────────

  app.use('/dymo', (req, res, next) => {
    setCorsHeaders(req, res);
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
    try {
      const body = new URLSearchParams({
        printerName, printParamsXml: '', labelXml,
        labelSetXml: '<LabelSet><LabelSetRecord/></LabelSet>',
      }).toString();
      const result = await callDymoConnect(body);
      const norm = result.trim().toLowerCase();
      if (!norm || norm === 'true') return res.json({ ok: true });
      if (norm.includes('error') || norm.includes('exception')) return res.json({ ok: false, error: `Dymo: ${result.slice(0, 200)}` });
    } catch { /* fall through to CUPS fallback */ }

    if (!pngBase64) {
      return res.json({ ok: false, error: 'Dymo REST API rejected. No PNG fallback provided.' });
    }
    const tmpFile = `/tmp/dymo_${randomUUID()}.png`;
    try {
      await fs.writeFile(tmpFile, Buffer.from(pngBase64, 'base64'));
      const DYMO_PPD: Record<string, { name: string; wPts: number; hPts: number }> = {
        '57x32': { name: 'w162h90',  wPts: 162, hPts: 90  },
        '54x25': { name: 'w154h64',  wPts: 154, hPts: 64  },
        '89x28': { name: 'w79h252',  wPts: 79,  hPts: 252 },
      };
      const sizeKey  = `${Math.round(widthMm ?? 57)}x${Math.round(heightMm ?? 32)}`;
      const dymo     = DYMO_PPD[sizeKey];
      const mediaName = dymo ? dymo.name : `Custom.${Math.round((widthMm ?? 57) / 25.4 * 72)}x${Math.round((heightMm ?? 32) / 25.4 * 72)}`;
      const wPx = dymo ? Math.round(dymo.wPts / 72 * 300) : Math.round((widthMm ?? 57) / 25.4 * 300);
      const hPx = dymo ? Math.round(dymo.hPts / 72 * 300) : Math.round((heightMm ?? 32) / 25.4 * 300);
      await new Promise<void>((resolve, reject) => {
        execFile('sips', ['-z', String(hPx), String(wPx), tmpFile],
          (err) => { if (err) reject(err); else resolve(); });
      });
      const cupsName = printerName.replace(/ /g, '_');
      console.log(`[dymo-bridge] lp: ${cupsName} media=${mediaName} ppi=300 (${wPx}x${hPx}px)`);
      await new Promise<void>((resolve, reject) => {
        execFile('lp', ['-d', cupsName, '-o', `media=${mediaName}`, '-o', 'ppi=300', tmpFile],
          (err) => { if (err) reject(err); else resolve(); });
      });
      return res.json({ ok: true });
    } catch (e) {
      console.error(`[dymo-bridge] lp failed:`, e);
      return res.status(500).json({ ok: false, error: `lp: ${String(e)}` });
    } finally {
      fs.unlink(tmpFile).catch(() => {});
    }
  });

  // ── Printer command (multi-printer aware) ───────────────────────────────────

  app.use('/printer', (req, res, next) => {
    setCorsHeaders(req, res);
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    next();
  });
  app.options('/printer/command', (_req, res) => res.sendStatus(204));
  app.post('/printer/command', async (req, res) => {
    const body = req.body as PrinterCommand & { printerId?: string };
    const { printerId, ...cmd } = body;
    if (!(cmd as { type?: string }).type) return res.status(400).json({ ok: false, error: 'Missing command type' });

    let adapter: Adapter | null | undefined;
    if (printerId) {
      adapter = printerStates.get(printerId)?.adapter;
    } else {
      adapter = [...printerStates.values()].find(s => s.running)?.adapter;
    }
    if (!adapter?.sendCommand) {
      return res.status(503).json({ ok: false, error: 'Connected adapter does not support commands' });
    }
    try {
      await adapter.sendCommand(cmd as PrinterCommand);
      res.json({ ok: true });
    } catch (e) {
      res.status(500).json({ ok: false, error: String(e) });
    }
  });

  // ── API state ───────────────────────────────────────────────────────────────

  app.get('/api/state', (_req, res) => {
    const cfg = loadMultiConfig();
    res.json(cfg.printers.map(p => {
      const state = printerStates.get(p.id);
      return {
        printerId: p.id,
        name:      p.name,
        running:   state?.running   ?? false,
        error:     state?.error     ?? null,
        lastPushAt: state?.lastPushAt ?? null,
        snapshot:  state?.snapshot  ?? null,
        events:    getEventLog(p.id),
      };
    }));
  });

  // ── Language ────────────────────────────────────────────────────────────────

  app.post('/language', (req, res) => {
    const { lang, returnUrl } = req.body as { lang?: string; returnUrl?: string };
    if (lang === 'de' || lang === 'en') {
      const cfg = loadMultiConfig();
      cfg.language = lang;
      saveMultiConfig(cfg);
    }
    res.redirect(returnUrl ?? '/');
  });

  // ── Pages ───────────────────────────────────────────────────────────────────

  app.get('/', (_req, res) => {
    const cfg = loadMultiConfig();
    if (cfg.printers.length === 0) return res.redirect('/setup/new');
    res.send(statusPage());
  });

  app.get('/setup', (_req, res) => res.send(setupListPage()));

  app.get('/setup/new', (_req, res) => res.send(printerFormPage()));

  app.post('/setup/new', (req, res) => {
    const { cfg: newCfg, error } = parseForm(req.body as Record<string, string>, newPrinterId());
    if (!newCfg) return res.send(printerFormPage(undefined, error));
    const multi = loadMultiConfig();
    multi.printers.push(newCfg);
    saveMultiConfig(multi);
    callbacks.onAdd(newCfg);
    res.redirect('/');
  });

  app.get('/setup/:id', (req, res) => {
    const multi   = loadMultiConfig();
    const printer = multi.printers.find(p => p.id === req.params.id);
    if (!printer) return res.redirect('/setup');
    res.send(printerFormPage(printer));
  });

  app.post('/setup/:id', (req, res) => {
    const id = req.params.id;
    const multi = loadMultiConfig();
    const existing = multi.printers.find(p => p.id === id);
    const { cfg: updated, error } = parseForm(req.body as Record<string, string>, id);
    if (!updated) return res.send(printerFormPage(existing, error));
    multi.printers = multi.printers.map(p => p.id === id ? updated : p);
    saveMultiConfig(multi);
    callbacks.onUpdate(updated);
    res.redirect('/');
  });

  app.post('/setup/:id/delete', (req, res) => {
    const id = req.params.id;
    const multi = loadMultiConfig();
    multi.printers = multi.printers.filter(p => p.id !== id);
    saveMultiConfig(multi);
    callbacks.onDelete(id);
    res.redirect('/setup');
  });

  app.listen(PORT, () => {
    console.log(`[flownt-bridge] Web UI running at http://localhost:${PORT}`);
  });
}
