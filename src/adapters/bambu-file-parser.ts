import { unzipSync } from 'fflate';
import type { FilamentWeight } from './types.js';

const dec = new TextDecoder();

function round2(v: number): number {
  return Math.round(v * 100) / 100;
}

export function parseFileBuffer(filename: string, buffer: Buffer, plate?: number): FilamentWeight[] {
  const base = (filename.split('/').pop() ?? filename).toLowerCase();
  if (base.endsWith('.3mf')) return parse3mf(buffer, plate);
  if (base.endsWith('.gcode') || base.endsWith('.gco') || base.endsWith('.g')) {
    return parseGcode(buffer.toString('utf-8'));
  }
  if (base.endsWith('.bgcode') || base.endsWith('.bgc')) return parseBgcode(buffer);
  return [];
}

// Prusa Binary G-Code (.bgcode): Best-Effort ohne echten Block-Parser. Die Print-Metadaten
// stehen als ASCII-`key=value`-Paare (ohne `;`-Präfix) im Binärstrom, sofern der Block
// unkomprimiert ist (PrusaSlicer-Default). Bei komprimierten Metadaten liefert der Scan
// nichts → Druck wird ohne Gewichte geloggt.
function parseBgcode(buffer: Buffer): FilamentWeight[] {
  const text = buffer.toString('latin1');
  const m = text.match(/filament used \[g\]\s*=\s*([\d.]+(?:\s*,\s*[\d.]+)*)/i);
  if (!m) return [];
  return m[1].split(',')
    .map((s, i) => ({ filamentIndex: i, slicerOrder: i, grams: round2(parseFloat(s.trim())) }))
    .filter(fw => !isNaN(fw.grams) && fw.grams > 0);
}

// Slicer plate thumbnails larger than this are not forwarded (Bambu's are ~50–300 KB).
const MAX_PREVIEW_BYTES = 1_500_000;

/**
 * Plate preview of a .3mf print file: the PNG Bambu Studio / OrcaSlicer render into
 * Metadata/plate_<n>.png. Falls back to the first plate image. Null if there is none.
 */
export function extractPlatePreview(buffer: Buffer, plate?: number): Buffer | null {
  let files: Record<string, Uint8Array>;
  try {
    files = unzipSync(new Uint8Array(buffer), {
      filter: f => /^Metadata\/plate_\d+\.png$/i.test(f.name) && f.originalSize <= MAX_PREVIEW_BYTES,
    });
  } catch {
    return null;
  }
  const key = (plate != null && files[`Metadata/plate_${plate}.png`] ? `Metadata/plate_${plate}.png` : undefined)
    ?? Object.keys(files).sort()[0];
  return key ? Buffer.from(files[key]) : null;
}

/** The printed plate's part of slice_info.config (all of it for single-plate files). */
function plateXml(xml: string, plate?: number): string {
  const plates = [...xml.matchAll(/<plate>([\s\S]*?)<\/plate>/g)].map(m => m[1]);
  if (plates.length > 1) {
    const printed = plates.find(pl => new RegExp(`key="index"\\s+value="${plate ?? 1}"`).test(pl));
    if (printed) return printed;
  }
  return xml;
}

/** Slicer-predicted print time of the printed plate in seconds (.3mf slice_info), or null. */
export function parseSlicePrediction(buffer: Buffer, plate?: number): number | null {
  let files: Record<string, Uint8Array>;
  try {
    files = unzipSync(new Uint8Array(buffer), { filter: f => f.name === 'Metadata/slice_info.config' });
  } catch {
    return null;
  }
  const raw = files['Metadata/slice_info.config'];
  if (!raw) return null;
  const m = /key="prediction"\s+value="(\d+(?:\.\d+)?)"/.exec(plateXml(dec.decode(raw), plate));
  const s = m ? parseFloat(m[1]) : NaN;
  return Number.isFinite(s) && s > 0 ? s : null;
}

function parse3mf(buffer: Buffer, plate?: number): FilamentWeight[] {
  let files: Record<string, Uint8Array>;
  try {
    files = unzipSync(new Uint8Array(buffer));
  } catch {
    return [];
  }

  // Bambu Studio: Metadata/slice_info.config (XML mit used_g pro filament id)
  const bambuRaw = files['Metadata/slice_info.config'];
  if (bambuRaw) {
    // Files sent from Bambu Studio contain only the printed plate. A project with several
    // sliced plates lists each plate's filaments separately: count only the printed one.
    const xml = plateXml(dec.decode(bambuRaw), plate);
    const weights: FilamentWeight[] = [];
    for (const m of xml.matchAll(/<filament\b([^>]*)>/gi)) {
      const attrs = m[1];
      const idM = attrs.match(/\bid="(\d+)"/i);
      const gM = attrs.match(/used_g="([\d.]+)"/i);
      const colorM = attrs.match(/\bcolor="(#?[0-9a-fA-F]{6,8})"/i);
      const typeM = attrs.match(/\btype="([^"]{1,40})"/i);
      const g = gM ? round2(parseFloat(gM[1])) : 0;
      if (g > 0 && idM) {
        // filamentIndex hier = Slicer-Reihenfolge (NICHT der physische AMS-Slot!).
        // Die physische Zuordnung passiert in bridge.ts per Farbe gegen den AMS-Live-Status.
        const id = parseInt(idM[1], 10);
        const fw: FilamentWeight = { filamentIndex: id, grams: g, color: colorM ? colorM[1] : undefined, slicerOrder: Math.max(0, id - 1) };
        if (typeM) fw.filamentType = typeM[1];
        weights.push(fw);
      }
    }
    if (weights.length > 0) return weights;
  }

  // PrusaSlicer / OrcaSlicer: Metadata/Slic3r_PE.config
  const prusaRaw = files['Metadata/Slic3r_PE.config'];
  if (prusaRaw) {
    const cfg = dec.decode(prusaRaw);
    const gramsRaw = cfg.match(/filament_used_g\s*=\s*(.+)/i)?.[1] ?? '';
    const weights = gramsRaw.split(';')
      .map((s, i) => ({ filamentIndex: i, slicerOrder: i, grams: round2(parseFloat(s.trim())) }))
      .filter(fw => !isNaN(fw.grams) && fw.grams > 0);
    if (weights.length > 0) return weights;
  }

  // Fallback: eingebettete GCode-Datei im Archiv
  const gcodeKey = Object.keys(files).find(k => /\.gcode$/i.test(k));
  if (gcodeKey) {
    return parseGcode(dec.decode(files[gcodeKey]));
  }

  return [];
}

function parseGcode(text: string): FilamentWeight[] {
  // Bambu/OrcaSlicer/PrusaSlicer Multi-Filament: ; filament used [g] = 0.76, 7.61, 18.38
  const multiMatch = text.match(/;\s*filament used \[g\]\s*=\s*([\d.,\s]+)/i);
  if (multiMatch) {
    const weights = multiMatch[1].split(',')
      .map((s, i) => ({ filamentIndex: i, slicerOrder: i, grams: round2(parseFloat(s.trim())) }))
      .filter(fw => !isNaN(fw.grams) && fw.grams > 0);
    if (weights.length > 0) return weights;
  }

  // PrusaSlicer: ; filament_used_in_weight = 12.45; 5.67
  const prusaMultiMatch = text.match(/;\s*filament_used_in_weight\s*=\s*(.+)/i);
  if (prusaMultiMatch) {
    const parts = prusaMultiMatch[1].split(';');
    const weights = parts
      .map((s, i) => ({ filamentIndex: i, slicerOrder: i, grams: round2(parseFloat(s.trim())) }))
      .filter(fw => !isNaN(fw.grams) && fw.grams > 0);
    if (weights.length > 0) return weights;
  }

  // Cura / einfaches GCode: ; filament used = 2.34 g
  const singleMatch = text.match(/;\s*filament used\s*=\s*([\d.]+)\s*g/i);
  if (singleMatch) {
    const g = round2(parseFloat(singleMatch[1]));
    if (!isNaN(g) && g > 0) return [{ filamentIndex: 0, slicerOrder: 0, grams: g }];
  }

  return [];
}
