// Flownt Anycubic-Test (Spike) — für Laien-Tester als Doppelklick-Programm gedacht.
// Validiert das reverse-engineerte Anycubic-LAN-Protokoll gegen echte Hardware und
// schneidet reale Report-Payloads mit, damit der Adapter darauf abgestimmt werden kann.
//
// Nutzung als Binary:  einfach starten → nach Drucker-IP gefragt werden → Test-Druck
//                      machen → Fenster schließen (Strg+C). Die Capture-Datei liegt
//                      danach im Home-Ordner und wird zurückgeschickt.
// Nutzung als Skript:  node scripts/anycubic-probe.mjs [drucker-ip]
//
// Read-only: es werden nur Abfragen gesendet, keine Steuerbefehle. Die Capture-Datei
// ist redigiert (keine Zugangsdaten, keine Kamera-/Stream-URLs).
import crypto from 'node:crypto';
import { writeFileSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import readline from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import mqtt from 'mqtt';

// Ablageort: Desktop (für Laien sofort sichtbar), sonst Home-Ordner als Rückfall.
// ~/Desktop ist nicht überall der echte Desktop (Windows-OneDrive-Umleitung, Lokalisierung) —
// darum der Fallback, und der volle Pfad wird am Ende ohnehin ausgegeben.
function outputDir() {
  const desktop = join(homedir(), 'Desktop');
  return existsSync(desktop) ? desktop : homedir();
}

const CTRL_PORT = 18910;
const MQTT_PORT_FALLBACK = 9883;
const QUERY_TYPES = ['status', 'info', 'tempature', 'fan', 'light', 'peripherie', 'multiColorBox'];
const SENSITIVE = new Set(['username', 'password', 'devicecrt', 'devicepk', 'token', 'broker',
  'rtspUrl', 'fileUploadUrl', 'fileUploadurl', 'url', 'streamUrl', 'videoUrl', 'flvUrl']);
const OUT_FILE = join(outputDir(), `flownt-anycubic-capture-${Date.now()}.json`);

const md5 = (s) => crypto.createHash('md5').update(s).digest('hex');
const nonce = (n) => Array.from({ length: n }, () =>
  'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'[crypto.randomInt(62)]).join('');

function redact(v) {
  if (Array.isArray(v)) return v.map(redact);
  if (v && typeof v === 'object') {
    const o = {};
    for (const [k, val] of Object.entries(v)) o[k] = SENSITIVE.has(k) ? '<redacted>' : redact(val);
    return o;
  }
  return v;
}

async function askIp() {
  const rl = readline.createInterface({ input: stdin, output: stdout });
  try {
    let ip = '';
    while (!/^\d{1,3}(\.\d{1,3}){3}$/.test(ip)) {
      ip = (await rl.question('\n  IP-Adresse des Anycubic-Druckers (z. B. 192.168.1.50): ')).trim();
      if (!/^\d{1,3}(\.\d{1,3}){3}$/.test(ip)) console.log('  ⚠  Das sieht nicht nach einer IP-Adresse aus. Bitte erneut.');
    }
    return ip;
  } finally { rl.close(); }
}

async function discoverCredentials(host) {
  console.log(`\n  [1/3] Verbinde mit dem Drucker (http://${host}:${CTRL_PORT}) …`);
  const info = await fetch(`http://${host}:${CTRL_PORT}/info`, { signal: AbortSignal.timeout(10_000) }).then(r => r.json());
  if (!info.token || info.token.length < 32 || !info.ctrlInfoUrl) {
    throw new Error('Drucker antwortet, aber der LAN-Modus scheint nicht aktiv zu sein. Bitte am Drucker-Display den LAN-Modus einschalten.');
  }
  console.log(`  [2/3] Hole Zugangsdaten (Modell: ${info.modelName ?? 'unbekannt'}) …`);
  const ts = String(Date.now());
  const n = nonce(6);
  const sign = md5(md5(info.token.slice(0, 16)) + ts + n);
  const did = crypto.randomBytes(16).toString('hex').toUpperCase();
  const ctrl = await fetch(`${info.ctrlInfoUrl}?ts=${ts}&nonce=${n}&sign=${sign}&did=${did}`,
    { method: 'POST', signal: AbortSignal.timeout(10_000) }).then(r => r.json());
  if (ctrl.code !== 200) throw new Error(`Drucker lehnte die Anfrage ab (Code ${ctrl.code}).`);
  const decipher = crypto.createDecipheriv('aes-128-cbc',
    Buffer.from(info.token.slice(16, 32), 'utf8'), Buffer.from(ctrl.data.token, 'utf8'));
  const plain = Buffer.concat([decipher.update(Buffer.from(ctrl.data.info, 'base64')), decipher.final()]);
  return JSON.parse(plain.toString('utf8'));
}

function run(host, bundle) {
  const typeId = String(bundle.modeId ?? bundle.modelId);
  const deviceId = bundle.deviceId;
  let mqttHost = host, port = MQTT_PORT_FALLBACK;
  try { const u = new URL(bundle.broker); mqttHost = u.hostname || host; port = Number(u.port) || MQTT_PORT_FALLBACK; } catch { /* Fallback */ }

  const base = `anycubic/anycubicCloud/v1/web/printer/${typeId}/${deviceId}`;
  const subTopic = `anycubic/anycubicCloud/v1/printer/+/${typeId}/${deviceId}/#`;
  const captures = [];
  const save = () => writeFileSync(OUT_FILE, JSON.stringify({
    probedHost: host, modelName: bundle.modelName, typeId,
    seenTypes: [...new Set(captures.map(c => c.type))], count: captures.length, captures,
  }, null, 2));

  console.log('  [3/3] Verbinde mit dem Drucker-Datenkanal …');
  const client = mqtt.connect(`mqtts://${mqttHost}:${port}`, {
    username: bundle.username, password: bundle.password,
    rejectUnauthorized: false, protocolVersion: 4, keepalive: 60,
    clientId: `flownt_anycubic_${crypto.randomBytes(4).toString('hex')}`,
    connectTimeout: 10_000, reconnectPeriod: 5_000,
  });

  const queryAll = () => { for (const type of QUERY_TYPES) client.publish(`${base}/${type}`,
    JSON.stringify({ type, action: type === 'multiColorBox' ? 'getInfo' : 'query', timestamp: Date.now(), msgid: crypto.randomUUID(), data: null })); };

  client.on('connect', () => {
    client.subscribe(subTopic, err => {
      if (err) { console.error('  ✗ Verbindung fehlgeschlagen:', err.message); process.exit(1); }
      console.log('\n  ✓ Verbunden! Der Test läuft jetzt.');
      console.log('  →  Bitte JETZT einen kurzen Test-Druck starten und komplett durchlaufen lassen');
      console.log('     (gerne auch mal abbrechen). Danach dieses Fenster schließen bzw. Strg+C drücken.\n');
      queryAll();
      setInterval(queryAll, 15_000);
      setInterval(save, 20_000); // Autosave, falls das Fenster hart geschlossen wird
    });
  });

  client.on('message', (topic, payload) => {
    let data; try { data = JSON.parse(payload.toString()); } catch { return; }
    const type = (data && data.type) || topic.split('/').slice(-2)[0];
    captures.push({ topic, type, data: redact(data), at: Date.now() });
    const state = data?.data?.state ?? data?.data?.project?.state ?? '';
    stdout.write(`  · empfangen: ${type}${state ? ` (Status: ${state})` : ''}          \r`);
  });
  client.on('error', err => { console.error('\n  ✗ Fehler:', err.message); process.exit(1); });

  const finish = () => {
    save();
    console.log(`\n\n  ✓ Fertig — ${captures.length} Nachrichten aufgezeichnet.`);
    console.log(`  📄 Datei: ${OUT_FILE}`);
    console.log('  Bitte diese Datei an Flownt zurückschicken. Sie enthält keine Passwörter.\n');
    process.exit(0);
  };
  process.on('SIGINT', finish);
  process.on('SIGTERM', finish);
}

console.log('\n  ── Flownt Anycubic-Verbindungstest ─────────────────────────');
console.log('  Hilft dabei, Anycubic-Drucker an Flownt anzubinden. Read-only, ohne Risiko.');
const ipArg = process.argv[2];
const ipPromise = /^\d{1,3}(\.\d{1,3}){3}$/.test(ipArg || '') ? Promise.resolve(ipArg) : askIp();
ipPromise
  .then(async host => run(host, await discoverCredentials(host)))
  .catch(err => {
    console.error(`\n  ✗ ${err.message}\n`);
    console.error('  Bitte prüfen: Drucker eingeschaltet, im selben WLAN/Netzwerk, LAN-Modus aktiv, IP korrekt.\n');
    process.exit(1);
  });
