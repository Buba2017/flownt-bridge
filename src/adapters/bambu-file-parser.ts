import { unzipSync } from 'fflate';
import type { FilamentWeight } from './types.js';

const dec = new TextDecoder();

function round2(v: number): number {
  return Math.round(v * 100) / 100;
}

export function parseFileBuffer(filename: string, buffer: Buffer): FilamentWeight[] {
  const base = (filename.split('/').pop() ?? filename).toLowerCase();
  if (base.endsWith('.3mf')) return parse3mf(buffer);
  if (base.endsWith('.gcode') || base.endsWith('.gco') || base.endsWith('.g')) {
    return parseGcode(buffer.toString('utf-8'));
  }
  return [];
}

function parse3mf(buffer: Buffer): FilamentWeight[] {
  let files: Record<string, Uint8Array>;
  try {
    files = unzipSync(new Uint8Array(buffer));
  } catch {
    return [];
  }

  // Bambu Studio: Metadata/slice_info.config (XML mit used_g pro filament id)
  const bambuRaw = files['Metadata/slice_info.config'];
  if (bambuRaw) {
    const xml = dec.decode(bambuRaw);
    const weights: FilamentWeight[] = [];
    for (const m of xml.matchAll(/<filament\b([^>]*)>/gi)) {
      const attrs = m[1];
      const idM = attrs.match(/\bid="(\d+)"/i);
      const gM = attrs.match(/used_g="([\d.]+)"/i);
      const g = gM ? round2(parseFloat(gM[1])) : 0;
      if (g > 0 && idM) {
        weights.push({ filamentIndex: parseInt(idM[1], 10), grams: g });
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
      .map((s, i) => ({ filamentIndex: i, grams: round2(parseFloat(s.trim())) }))
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
      .map((s, i) => ({ filamentIndex: i, grams: round2(parseFloat(s.trim())) }))
      .filter(fw => !isNaN(fw.grams) && fw.grams > 0);
    if (weights.length > 0) return weights;
  }

  // PrusaSlicer: ; filament_used_in_weight = 12.45; 5.67
  const prusaMultiMatch = text.match(/;\s*filament_used_in_weight\s*=\s*(.+)/i);
  if (prusaMultiMatch) {
    const parts = prusaMultiMatch[1].split(';');
    const weights = parts
      .map((s, i) => ({ filamentIndex: i, grams: round2(parseFloat(s.trim())) }))
      .filter(fw => !isNaN(fw.grams) && fw.grams > 0);
    if (weights.length > 0) return weights;
  }

  // Cura / einfaches GCode: ; filament used = 2.34 g
  const singleMatch = text.match(/;\s*filament used\s*=\s*([\d.]+)\s*g/i);
  if (singleMatch) {
    const g = round2(parseFloat(singleMatch[1]));
    if (!isNaN(g) && g > 0) return [{ filamentIndex: 0, grams: g }];
  }

  return [];
}
