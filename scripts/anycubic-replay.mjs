// Flownt Anycubic-Spike — Capture-Replay durch den echten Adapter.
// Spielt Probe-Captures (flownt-anycubic-capture-*.json) Nachricht für Nachricht durch
// AnycubicAdapter.onMessage und simuliert die Job-Ende-Erkennung aus bridge.ts
// (Übergang printing/paused → idle/error konsumiert jobResult). So lässt sich ohne
// Hardware verifizieren, dass Drucklog-Events, Gramm und Job-IDs korrekt herauskommen.
//
// Nutzung: node scripts/anycubic-replay.mjs <capture.json...>
import { execSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';

const files = process.argv.slice(2);
if (!files.length) {
  console.error('Nutzung: node scripts/anycubic-replay.mjs <capture.json...>');
  process.exit(1);
}

// Adapter (TS) für den Test bündeln — gleiche Toolchain wie der Bridge-Build.
const buildDir = mkdtempSync(join(tmpdir(), 'anycubic-replay-'));
const buildFile = join(buildDir, 'anycubic.cjs');
execSync(`npx esbuild src/adapters/anycubic.ts --bundle --platform=node --format=cjs --outfile=${buildFile} --log-level=error`, { stdio: 'inherit' });
const { AnycubicAdapter } = createRequire(import.meta.url)(buildFile);

const ts = (ms) => new Date(ms).toISOString().replace('T', ' ').slice(5, 19);

for (const file of files) {
  const raw = JSON.parse(readFileSync(file, 'utf8'));
  const caps = raw.captures ?? [];
  console.log(`\n══ ${file.split('/').pop()} — ${raw.modelName} (${caps.length} Nachrichten) ══`);

  const adapter = new AnycubicAdapter('127.0.0.1');
  let prevStatus = null;
  let printStartedAt = null;
  const events = [];

  for (const c of caps) {
    adapter.onMessage(c.topic, Buffer.from(JSON.stringify(c.data)));
    const snap = await adapter.getSnapshot();

    // Druckstart-Erkennung wie bridge.ts
    if (snap.status === 'printing' && prevStatus !== 'printing' && prevStatus !== 'paused') {
      printStartedAt = c.at;
      events.push(`${ts(c.at)}  ▶ Druck gestartet: ${snap.printFile ?? '–'}`);
    }
    // Job-Ende-Erkennung wie bridge.ts (aktiv → idle/error, Ausgang aus jobResult)
    const wasActive = prevStatus === 'printing' || prevStatus === 'paused';
    if (wasActive && (snap.status === 'idle' || snap.status === 'error')) {
      const outcome = snap.jobResult ?? (snap.status === 'error' ? 'failed' : 'completed');
      const durMin = printStartedAt != null ? Math.round((c.at - printStartedAt) / 60000) : '?';
      const grams = snap.parsedFilamentWeights?.map(w => `${w.grams} g (Index ${w.filamentIndex})`).join(', ') ?? '—';
      events.push(`${ts(c.at)}  ■ ${outcome === 'completed' ? 'job_complete' : `job_failed (${outcome})`}`
        + ` · ${durMin} min · ${grams} · Datei: ${snap.printFile ?? '–'} · JobId: ${snap.sourceJobId ?? '–'}`);
      printStartedAt = null;
    }
    prevStatus = snap.status;
  }

  const final = await adapter.getSnapshot();
  adapter.dispose();

  if (events.length) { console.log('\n  Ereignisse:'); for (const e of events) console.log(`   ${e}`); }
  else console.log('\n  Keine Druck-Ereignisse (Capture war idle).');
  console.log(`\n  End-Snapshot: status=${final.status} progress=${final.progressPct ?? '–'}`
    + ` hotend=${final.tempHotend ?? '–'}°C bed=${final.tempBed ?? '–'}°C aktiverSlot=${final.activeMqttSlot ?? '–'}`);
  if (final.amsSlots?.length) {
    console.log('  ACE-Slots:');
    for (const s of final.amsSlots)
      console.log(`   Unit ${s.ams_unit} Slot ${s.slot}: ${s.material.padEnd(10)} ${s.color} ${s.remain}% (Spule ${s.tray_weight} g)`);
  }
}

rmSync(buildDir, { recursive: true, force: true });
process.exit(0);
