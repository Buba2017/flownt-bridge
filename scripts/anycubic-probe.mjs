// Anycubic Kobra LAN-Probe (Spike) — validiert das reverse-engineerte LAN-Protokoll
// gegen echte Hardware und schneidet reale Report-Payloads mit.
//
//   node scripts/anycubic-probe.mjs <drucker-ip> [sekunden]
//
// Ablauf: Credential-Discovery (HTTP 18910 + AES) → MQTT 9883 (TLS) → alle Reports
// abfragen → eintreffende Payloads sammeln und (redigiert) nach anycubic-capture-<ts>.json
// schreiben. Read-only: es werden nur Query-Nachrichten gesendet, keine Steuerbefehle.
//
// Braucht Node 18+ (globales fetch/crypto) und das `mqtt`-Paket (bereits Bridge-Dep).
// Aus dem bridge/-Ordner ausführen, damit `mqtt` auflösbar ist.
import crypto from 'node:crypto';
import { writeFileSync } from 'node:fs';
import mqtt from 'mqtt';

const HOST = process.argv[2];
const DURATION_S = Number(process.argv[3] || 90);
if (!HOST) {
  console.error('Aufruf: node scripts/anycubic-probe.mjs <drucker-ip> [sekunden]');
  process.exit(1);
}

const CTRL_PORT = 18910;
const MQTT_PORT_FALLBACK = 9883;
const QUERY_TYPES = ['status', 'info', 'tempature', 'fan', 'light', 'peripherie', 'multiColorBox'];
const SENSITIVE = new Set(['username', 'password', 'devicecrt', 'devicepk', 'token', 'broker',
  'rtspUrl', 'fileUploadUrl', 'fileUploadurl', 'url', 'streamUrl', 'videoUrl', 'flvUrl']);

const md5 = (s) => crypto.createHash('md5').update(s).digest('hex');
const nonce = (n) => Array.from({ length: n }, () =>
  'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'[crypto.randomInt(62)]).join('');

// Redigiert Geheimnisse rekursiv, damit das Capture gefahrlos geteilt werden kann.
function redact(v) {
  if (Array.isArray(v)) return v.map(redact);
  if (v && typeof v === 'object') {
    const o = {};
    for (const [k, val] of Object.entries(v)) o[k] = SENSITIVE.has(k) ? '<redacted>' : redact(val);
    return o;
  }
  return v;
}

async function discoverCredentials() {
  console.log(`[probe] GET http://${HOST}:${CTRL_PORT}/info …`);
  const info = await fetch(`http://${HOST}:${CTRL_PORT}/info`, { signal: AbortSignal.timeout(10_000) })
    .then(r => r.json());
  const token = info.token;
  const ctrlUrl = info.ctrlInfoUrl;
  if (!token || token.length < 32 || !ctrlUrl) {
    throw new Error(`/info unvollständig — token(${token?.length}) / ctrlInfoUrl(${!!ctrlUrl}). Ist LAN-Modus am Drucker aktiv?`);
  }
  console.log(`[probe] /info ok — modelName=${info.modelName} modelId=${info.modelId ?? info.modeId}`);

  const ts = String(Date.now());
  const n = nonce(6);
  const sign = md5(md5(token.slice(0, 16)) + ts + n);
  const did = crypto.randomBytes(16).toString('hex').toUpperCase();
  const url = `${ctrlUrl}?ts=${ts}&nonce=${n}&sign=${sign}&did=${did}`;
  console.log(`[probe] POST ${ctrlUrl} …`);
  const ctrl = await fetch(url, { method: 'POST', signal: AbortSignal.timeout(10_000) }).then(r => r.json());
  if (ctrl.code !== 200) throw new Error(`ctrlInfo code=${ctrl.code} (${ctrl.msg ?? 'kein msg'})`);

  const key = token.slice(16, 32);
  const iv = ctrl.data.token;
  const decipher = crypto.createDecipheriv('aes-128-cbc', Buffer.from(key, 'utf8'), Buffer.from(iv, 'utf8'));
  const plain = Buffer.concat([decipher.update(Buffer.from(ctrl.data.info, 'base64')), decipher.final()]);
  const bundle = JSON.parse(plain.toString('utf8'));
  console.log(`[probe] Credentials entschlüsselt — deviceId=${bundle.deviceId} modeId=${bundle.modeId ?? bundle.modelId}`);
  return bundle;
}

function run(bundle) {
  const typeId = String(bundle.modeId ?? bundle.modelId);
  const deviceId = bundle.deviceId;
  let host = HOST, port = MQTT_PORT_FALLBACK;
  try { const u = new URL(bundle.broker); host = u.hostname || HOST; port = Number(u.port) || MQTT_PORT_FALLBACK; } catch { /* Fallback */ }

  const base = `anycubic/anycubicCloud/v1/web/printer/${typeId}/${deviceId}`;
  const subTopic = `anycubic/anycubicCloud/v1/printer/+/${typeId}/${deviceId}/#`;
  const captures = [];

  console.log(`[probe] MQTT connect mqtts://${host}:${port} (ohne Client-Cert) …`);
  const client = mqtt.connect(`mqtts://${host}:${port}`, {
    username: bundle.username,
    password: bundle.password,
    rejectUnauthorized: false,
    protocolVersion: 4,
    keepalive: 60,
    clientId: `flownt_anycubic_${crypto.randomBytes(4).toString('hex')}`,
    connectTimeout: 10_000,
    reconnectPeriod: 0,
  });

  const queryAll = () => {
    for (const type of QUERY_TYPES) {
      client.publish(`${base}/${type}`, JSON.stringify({
        type, action: type === 'multiColorBox' ? 'getInfo' : 'query',
        timestamp: Date.now(), msgid: crypto.randomUUID(), data: null,
      }));
    }
  };

  client.on('connect', () => {
    console.log('[probe] MQTT verbunden ✓');
    client.subscribe(subTopic, err => {
      if (err) { console.error('[probe] Subscribe-Fehler:', err.message); process.exit(1); }
      console.log(`[probe] subscribed: ${subTopic}`);
      queryAll();
      const iv = setInterval(queryAll, 15_000);
      setTimeout(() => {
        clearInterval(iv);
        const file = `anycubic-capture-${Date.now()}.json`;
        writeFileSync(file, JSON.stringify({
          probedHost: HOST, modelName: bundle.modelName, typeId, seenTypes: [...new Set(captures.map(c => c.type))],
          captures,
        }, null, 2));
        console.log(`\n[probe] Fertig. ${captures.length} Nachrichten → ${file}`);
        console.log('[probe] Bitte diese Datei zurückschicken. Sie ist redigiert (keine Zugangsdaten/Stream-URLs).');
        client.end();
        process.exit(0);
      }, DURATION_S * 1000);
    });
  });

  client.on('message', (topic, payload) => {
    let data; try { data = JSON.parse(payload.toString()); } catch { data = payload.toString(); }
    const type = (data && data.type) || topic.split('/').slice(-2)[0];
    captures.push({ topic, type, data: redact(data) });
    const state = data?.data?.state ?? data?.data?.project?.state ?? '';
    console.log(`[probe] ← ${type}${state ? ` (state=${state})` : ''}`);
  });

  client.on('error', err => { console.error('[probe] MQTT-Fehler:', err.message); process.exit(1); });
}

discoverCredentials().then(run).catch(err => {
  console.error('[probe] FEHLER:', err.message);
  console.error('[probe] Prüfen: Drucker im selben LAN? LAN-Modus aktiv? IP korrekt?');
  process.exit(1);
});
