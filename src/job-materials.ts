import type { AmsSlot, FilamentWeight } from './adapters/types.js';
import type { SlotRef } from './contract.js';

// Which physical slot each slicer filament of a job was printed from.
//
// The parser's filamentIndex is the SLICER filament id (slice_info), not the AMS slot.
// Strategies, in order:
//  1. Bambu print.mapping (mapping[id-1] → tray code (ams_id << 8) | slot) — deterministic.
//  2. Single-filament job: the active physical slot (tray_now / extruder).
//  3. Multi-filament job: unique colour match against the AMS state.

/** Global slot number in Flownt: unit*4+slot (AMS), 254 = external spool. */
export function slotIndex(unit: number, slot: number): number {
  return unit * 4 + slot;
}

/** Active slot values worth remembering (255 = no tray → keep the last known). */
export function isTrackedSlot(v: number | null | undefined): boolean {
  return typeof v === 'number' && ((v >= 0 && v < 16) || v === 254);
}

export function slotLabel(slot: number): string {
  return slot === 254 ? 'Externe Spule' : `${String.fromCharCode(65 + Math.floor(slot / 4))}${(slot % 4) + 1}`;
}

export interface MaterialContext {
  mapping: number[];
  activeSlot: number | null;
  amsSlots: AmsSlot[];
}

export interface ResolvedMaterials {
  weights: FilamentWeight[];
  slotSource: SlotRef['source'];
  notes: Array<{ type: 'info' | 'warn'; msg: string }>;
}

export function resolveMaterials(input: FilamentWeight[], ctx: MaterialContext): ResolvedMaterials {
  const notes: ResolvedMaterials['notes'] = [];
  let weights = input;
  let slotSource: SlotRef['source'] = 'slicer_order';
  let mappedByAmsMapping = false;

  if (weights.length && ctx.mapping.length) {
    let cnt = 0;
    // The mapping only counts if it yields at least one usable assignment; otherwise
    // (e.g. external spool: no entry for the slicer id) the raw slicer index would point
    // at a foreign AMS slot.
    let validCount = 0;
    const remapped = weights.map(fw => {
      const code = ctx.mapping[fw.filamentIndex - 1];
      if (code == null) return fw;
      // Bambu: -1 = no AMS (external spool), ≥65535 = unused/external → both 254
      if (code < 0 || code >= 65535) { validCount++; return { ...fw, filamentIndex: 254 }; }
      const amsUnit = (code >> 8) & 0xFF;
      const slot = code & 0xFF;
      if (amsUnit > 3 || slot > 3) return fw; // unexpected encoding → keep raw
      validCount++;
      const gi = slotIndex(amsUnit, slot);
      if (gi !== fw.filamentIndex) cnt++;
      return { ...fw, filamentIndex: gi };
    });
    if (validCount > 0) {
      weights = remapped;
      mappedByAmsMapping = true;
      slotSource = 'ams';
      notes.push({ type: 'info', msg: `Filament-Zuordnung via Bambu ams_mapping (${remapped.length} Filament(e), ${cnt} korrigiert)` });
    } else {
      notes.push({ type: 'info', msg: 'ams_mapping ohne verwertbare Zuordnung — Fallback: aktiver Slot' });
    }
  }

  if (!mappedByAmsMapping && weights.length === 1) {
    const fw = weights[0];
    if (ctx.activeSlot != null) {
      if (fw.filamentIndex !== ctx.activeSlot) weights = [{ ...fw, filamentIndex: ctx.activeSlot }];
      slotSource = 'ams';
      notes.push({ type: 'info', msg: `Filamentverbrauch → AMS-Slot ${slotLabel(ctx.activeSlot)} (${fw.grams} g)` });
    } else {
      notes.push({ type: 'warn', msg: 'Aktiver AMS-Slot unbekannt — Filament evtl. nicht verknüpft' });
    }
  }

  if (!mappedByAmsMapping && weights.length > 1) {
    if (ctx.amsSlots.length) {
      const normHex = (c?: string) => c ? '#' + c.replace(/^#/, '').replace(/^0x/i, '').slice(0, 6).toUpperCase() : '';
      let remappedCount = 0;
      const remapped = weights.map(fw => {
        if (!fw.color) return fw;
        const want = normHex(fw.color);
        const matches = ctx.amsSlots.filter(s => normHex(s.color) === want);
        if (matches.length === 1) {
          const gi = slotIndex(matches[0].ams_unit, matches[0].slot);
          if (gi !== fw.filamentIndex) { remappedCount++; return { ...fw, filamentIndex: gi }; }
        }
        return fw;
      });
      if (remappedCount > 0) {
        weights = remapped;
        slotSource = 'ams';
        notes.push({ type: 'info', msg: `Mehrfarb-Druck: ${remappedCount} Filament(e) per Farbe dem AMS-Slot zugeordnet (Fallback)` });
      }
    } else {
      notes.push({ type: 'warn', msg: 'Mehrfarb-Druck: kein ams_mapping/AMS-Status — Filamente evtl. nach Slicer-Reihenfolge zugeordnet' });
    }
  }

  return { weights, slotSource, notes };
}
