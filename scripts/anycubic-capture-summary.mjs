// Flownt Anycubic-Spike — Capture-Auswertung.
// Verdichtet große Probe-Captures (flownt-anycubic-capture-*.json) zu einer kompakten
// Zusammenfassung, damit die Analyse ohne Volltext-Lesen der Datei möglich ist.
//
// Zusammenfassung:  node scripts/anycubic-capture-summary.mjs <datei...>
// Gezielter Dump:   node scripts/anycubic-capture-summary.mjs <datei> --dump <type> [--grep <regex>] [--from <idx>] [--limit <n>]
//   --dump multiColorBox        alle Nachrichten dieses Typs (kompakt, dedupliziert)
//   --grep gram                 nur Nachrichten, deren JSON auf das Regex matcht
//   --from 120 --limit 20       Fenster über den Nachrichts-Index
import { readFileSync, statSync } from 'node:fs';

const MAX_VAL = 80;          // Sample-Werte kürzen
const MAX_SAMPLES = 4;       // distinct Samples pro Feldpfad
const MAX_DUMP = 2000;       // Zeichen pro Dump-Nachricht
const INTERESTING = /gram|weight|consum|usage|filament|progress|remain|eta|percent|layer|supplies|spool|color|material|print|job|task|file|state|status|duration|time_/i;

const args = process.argv.slice(2);
const files = args.filter(a => !a.startsWith('--') && !isOpt(a));
function isOpt(a) {
  const i = args.indexOf(a);
  return i > 0 && args[i - 1].startsWith('--') && args[i - 1] !== '--dump-all';
}
const opt = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
const dumpType = opt('--dump');
const grep = opt('--grep') ? new RegExp(opt('--grep'), 'i') : null;
const from = Number(opt('--from') ?? 0);
const limit = Number(opt('--limit') ?? 50);

if (!files.length) {
  console.error('Nutzung: node scripts/anycubic-capture-summary.mjs <datei...> [--dump <type>] [--grep <regex>] [--from <idx>] [--limit <n>]');
  process.exit(1);
}

const short = (v) => {
  const s = typeof v === 'string' ? JSON.stringify(v) : JSON.stringify(v);
  return s && s.length > MAX_VAL ? s.slice(0, MAX_VAL) + '…' : s;
};
const ts = (ms) => new Date(ms).toISOString().replace('T', ' ').slice(5, 19);

// Rekursiv alle Feldpfade + distinct Beispielwerte einsammeln.
function collect(obj, path, into) {
  if (obj === null || typeof obj !== 'object') {
    const e = into.get(path) ?? { n: 0, samples: new Set(), min: Infinity, max: -Infinity, numeric: true };
    e.n++;
    if (typeof obj === 'number') { e.min = Math.min(e.min, obj); e.max = Math.max(e.max, obj); }
    else e.numeric = false;
    if (e.samples.size < MAX_SAMPLES) e.samples.add(short(obj));
    into.set(path, e);
    return;
  }
  if (Array.isArray(obj)) {
    const e = into.get(path) ?? { n: 0, samples: new Set(), numeric: false, isArr: true, lens: new Set() };
    e.isArr = true; e.lens ??= new Set();   // Pfad kann vorher als Skalar gesehen worden sein
    e.n++; e.lens.add(obj.length); into.set(path, e);
    obj.forEach((v) => collect(v, path + '[]', into));
    return;
  }
  for (const [k, v] of Object.entries(obj)) collect(v, path ? `${path}.${k}` : k, into);
}

for (const file of files) {
  const raw = JSON.parse(readFileSync(file, 'utf8'));
  const caps = raw.captures ?? [];
  const size = (statSync(file).size / 1024 / 1024).toFixed(1);

  console.log(`\n══ ${file} (${size} MB) ══`);
  console.log(`   Modell: ${raw.modelName ?? '?'} · typeId ${raw.typeId ?? '?'} · ${caps.length} Nachrichten`);
  if (caps.length) {
    const t0 = caps[0].at, t1 = caps[caps.length - 1].at;
    console.log(`   Zeitraum: ${ts(t0)} → ${ts(t1)} (${Math.round((t1 - t0) / 60000)} min)`);
  }

  // ── Dump-Modus ──
  if (dumpType) {
    let shown = 0, lastJson = '';
    caps.forEach((c, i) => {
      if (i < from || shown >= limit) return;
      if (c.type !== dumpType && dumpType !== '*') return;
      const json = JSON.stringify(c.data);
      if (grep && !grep.test(json)) return;
      if (json === lastJson) return;            // identische Folge-Nachrichten überspringen
      lastJson = json;
      console.log(`\n#${i} +${caps.length ? Math.round((c.at - caps[0].at) / 1000) : 0}s ${c.topic}`);
      console.log(json.length > MAX_DUMP ? json.slice(0, MAX_DUMP) + `…(${json.length} Z.)` : json);
      shown++;
    });
    console.log(`\n(${shown} Nachrichten gezeigt, Filter: type=${dumpType}${grep ? ` grep=${grep.source}` : ''}, ab #${from}, Limit ${limit})`);
    continue;
  }

  // ── Zähler je Typ + Action ──
  const byType = new Map();
  for (const c of caps) {
    const action = c.data?.action ?? '';
    const key = `${c.type}${action ? ` / ${action}` : ''}`;
    byType.set(key, (byType.get(key) ?? 0) + 1);
  }
  console.log('\n   Nachrichten je Typ/Action:');
  for (const [k, n] of [...byType.entries()].sort((a, b) => b[1] - a[1]))
    console.log(`     ${String(n).padStart(5)} × ${k}`);

  // ── State-Timeline (Envelope-state, aufeinanderfolgende Duplikate raus) ──
  const timeline = [];
  for (const c of caps) {
    const s = typeof c.data?.state === 'string' ? c.data.state : null;
    if (s && (!timeline.length || timeline[timeline.length - 1].s !== s))
      timeline.push({ s, at: c.at, i: caps.indexOf(c) });
  }
  console.log(`\n   State-Timeline (${timeline.length} Wechsel):`);
  const t0 = caps[0]?.at ?? 0;
  for (const e of timeline.slice(0, 40))
    console.log(`     +${String(Math.round((e.at - t0) / 1000)).padStart(6)}s  #${e.i}  ${e.s}`);
  if (timeline.length > 40) console.log(`     … ${timeline.length - 40} weitere`);

  // ── Feld-Inventar je Typ ──
  console.log('\n   Feld-Inventar (Pfad · Anzahl · Wertebereich/Samples):');
  const types = [...new Set(caps.map(c => c.type))];
  for (const type of types) {
    const fields = new Map();
    for (const c of caps) if (c.type === type) collect(c.data, '', fields);
    console.log(`\n   ▸ ${type}`);
    for (const [path, e] of [...fields.entries()].sort()) {
      if (!path) continue;
      let val;
      if (e.isArr) val = `Array, Längen {${[...e.lens].sort((a, b) => a - b).join(',')}}`;
      else if (e.numeric && e.min !== e.max) val = `${e.min} … ${e.max}`;
      else val = [...e.samples].join(' | ');
      const mark = INTERESTING.test(path) ? '★' : ' ';
      console.log(`     ${mark} ${path.padEnd(44)} ${String(e.n).padStart(5)}×  ${val}`);
    }
  }
}
