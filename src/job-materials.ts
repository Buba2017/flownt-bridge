import type { AmsSlot, FilamentWeight } from './adapters/types.js';
import type { SlotRef } from './contract.js';

// Which physical slot each slicer filament of a job was printed from.
//
// The parser's filamentIndex is the SLICER filament id (slice_info), not the AMS slot.
// Strategies, in order:
//  1. Bambu print.mapping (mapping[id-1] → tray code (ams_id << 8) | slot) — deterministic.
//  2. Single-filament job: the active physical slot (tray_now / extruder).
//  3. Multi-filament job: unique colour match against the AMS state.
// Only lines that were really resolved to a physical slot get slotRef.source 'ams'.

export const EXTERNAL_SLOT = 254;
export const NO_SLOT = 255;

/** Global slot number in Flownt: unit*4+slot (AMS), the unit id for AMS HT (128+). */
export function slotIndex(unit: number, slot: number): number {
  return unit >= 128 ? unit : unit * 4 + slot;
}

/**
 * Bambu tray code (ams_id << 8) | slot → global slot, as in print.mapping and
 * device.extruder snow. Units 254/255 are the external spools (one per extruder on
 * dual-nozzle printers), 65535 / -1 mean no AMS (external spool when the filament is
 * used); slot 255 within a unit means "no tray". Returns null for codes it cannot place.
 */
export function decodeTrayCode(code: number): number | null {
  if (!Number.isInteger(code)) return null;
  if (code < 0 || code >= 65535) return EXTERNAL_SLOT;
  const unit = (code >> 8) & 0xFF;
  const slot = code & 0xFF;
  if (unit === 254 || unit === 255) return EXTERNAL_SLOT;
  if (unit >= 128) return unit;                // AMS HT: one tray per unit
  if (unit < 16 && slot <= 3) return slotIndex(unit, slot);
  return null;
}

/** Active slot values worth remembering (255 = no tray → keep the last known). */
export function isTrackedSlot(v: number | null | undefined): boolean {
  return typeof v === 'number' && Number.isInteger(v) && ((v >= 0 && v < 64) || (v >= 128 && v <= EXTERNAL_SLOT));
}

export function slotLabel(slot: number): string {
  if (slot === EXTERNAL_SLOT) return 'Externe Spule';
  if (slot >= 128) return `AMS HT ${slot - 127}`;
  return `${String.fromCharCode(65 + Math.floor(slot / 4))}${(slot % 4) + 1}`;
}

export interface MaterialContext {
  mapping: number[];
  activeSlot: number | null;
  amsSlots: AmsSlot[];
}

/** A slicer filament with the slot it was printed from (or its slicer index). */
export type ResolvedLine = FilamentWeight & { source: SlotRef['source'] };

export interface ResolvedMaterials {
  lines: ResolvedLine[];
  notes: Array<{ type: 'info' | 'warn'; msg: string }>;
}

const normHex = (c?: string) => c ? '#' + c.replace(/^#/, '').replace(/^0x/i, '').slice(0, 6).toUpperCase() : '';

export function resolveMaterials(input: FilamentWeight[], ctx: MaterialContext): ResolvedMaterials {
  const notes: ResolvedMaterials['notes'] = [];
  // Unresolved lines go out by slicer order, 0-based as the contract defines it.
  const raw = (fw: FilamentWeight): ResolvedLine => ({ ...fw, filamentIndex: fw.slicerOrder ?? fw.filamentIndex, source: 'slicer_order' });
  if (!input.length) return { lines: [], notes };

  // 1. print.mapping
  if (ctx.mapping.length) {
    let corrected = 0;
    const lines = input.map((fw): ResolvedLine => {
      const code = ctx.mapping[fw.filamentIndex - 1];
      const slot = code == null ? null : decodeTrayCode(code);
      if (slot == null) return raw(fw); // never pass a raw slicer index off as an AMS slot
      if (slot !== fw.filamentIndex) corrected++;
      return { ...fw, filamentIndex: slot, source: 'ams' };
    });
    const mapped = lines.filter(l => l.source === 'ams').length;
    if (mapped > 0) {
      notes.push({ type: 'info', msg: `Filament-Zuordnung via Bambu ams_mapping (${mapped}/${lines.length} Filament(e), ${corrected} korrigiert)` });
      if (mapped < lines.length) notes.push({ type: 'warn', msg: `${lines.length - mapped} Filament(e) ohne ams_mapping-Eintrag — nach Slicer-Reihenfolge gemeldet` });
      return { lines, notes };
    }
    notes.push({ type: 'info', msg: 'ams_mapping ohne verwertbare Zuordnung — Fallback: aktiver Slot' });
  }

  // 2. single filament: the active physical slot
  if (input.length === 1) {
    const fw = input[0];
    if (ctx.activeSlot != null && isTrackedSlot(ctx.activeSlot)) {
      notes.push({ type: 'info', msg: `Filamentverbrauch → ${slotLabel(ctx.activeSlot)} (${fw.grams} g)` });
      return { lines: [{ ...fw, filamentIndex: ctx.activeSlot, source: 'ams' }], notes };
    }
    notes.push({ type: 'warn', msg: 'Aktiver AMS-Slot unbekannt — Filament evtl. nicht verknüpft' });
    return { lines: [raw(fw)], notes };
  }

  // 3. several filaments: unique colour match against the AMS (occupied slots only)
  const slots = ctx.amsSlots.filter(s => s.material);
  if (!slots.length) {
    notes.push({ type: 'warn', msg: 'Mehrfarb-Druck: kein ams_mapping/AMS-Status — Filamente evtl. nach Slicer-Reihenfolge zugeordnet' });
    return { lines: input.map(raw), notes };
  }
  const lines = input.map((fw): ResolvedLine => {
    if (!fw.color) return raw(fw);
    const matches = slots.filter(s => normHex(s.color) === normHex(fw.color));
    return matches.length === 1
      ? { ...fw, filamentIndex: slotIndex(matches[0].ams_unit, matches[0].slot), source: 'ams' }
      : raw(fw);
  });
  const matched = lines.filter(l => l.source === 'ams').length;
  notes.push(matched === lines.length
    ? { type: 'info', msg: `Mehrfarb-Druck: ${matched} Filament(e) per Farbe dem AMS-Slot zugeordnet (Fallback)` }
    : { type: 'warn', msg: `Mehrfarb-Druck: ${matched}/${lines.length} Filament(e) per Farbe zugeordnet, Rest nach Slicer-Reihenfolge` });
  return { lines, notes };
}
