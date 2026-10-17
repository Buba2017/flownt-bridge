// Protection against a bridge-sync response that would wipe the bridge: if the backend
// returns `printers: []` (or drops most printers) because of a transient error, the
// bridge must not delete its printers and their access codes. A "mass removal" — all
// managed printers, or more than half of them — is only applied after the same removal
// was seen in CONFIRMATIONS consecutive syncs spanning at least MIN_DURATION_MS.
// Smaller removals apply at once.

export const CONFIRMATIONS = 3;
export const MIN_DURATION_MS = 5 * 60 * 1000;

export interface PendingRemoval {
  /** Flownt printer ids the backend no longer lists. */
  printerIds: string[];
  /** When this exact removal was first seen. */
  since: Date;
  /** Consecutive syncs that proposed it. */
  confirmations: number;
}

export interface RemovalDecision {
  /** Remove these now. */
  allowed: string[];
  /** Keep these for now (mass removal waiting for confirmation). */
  held: string[];
  /** True when a held mass removal has just been confirmed. */
  confirmed: boolean;
}

export class RemovalGuard {
  private pending: { key: string; ids: string[]; firstAt: number; count: number } | null = null;

  constructor(
    private readonly now: () => number = () => Date.now(),
    private readonly confirmations = CONFIRMATIONS,
    private readonly minDurationMs = MIN_DURATION_MS,
  ) {}

  /**
   * @param toRemove Flownt ids of managed printers missing from the sync response.
   * @param managedCount Managed printers currently configured (present at the last applied sync).
   */
  decide(toRemove: string[], managedCount: number): RemovalDecision {
    if (toRemove.length === 0) {
      this.pending = null;
      return { allowed: [], held: [], confirmed: false };
    }
    // All managed printers, or more than half of them.
    const mass = toRemove.length * 2 > managedCount;
    if (!mass) {
      this.pending = null;
      return { allowed: toRemove, held: [], confirmed: false };
    }
    const ids = [...toRemove].sort();
    const key = ids.join(',');
    if (this.pending?.key === key) this.pending.count++;
    else this.pending = { key, ids, firstAt: this.now(), count: 1 };
    if (this.pending.count >= this.confirmations && this.now() - this.pending.firstAt >= this.minDurationMs) {
      this.pending = null;
      return { allowed: toRemove, held: [], confirmed: true };
    }
    return { allowed: [], held: toRemove, confirmed: false };
  }

  status(): PendingRemoval | null {
    if (!this.pending) return null;
    return { printerIds: this.pending.ids, since: new Date(this.pending.firstAt), confirmations: this.pending.count };
  }

  reset(): void { this.pending = null; }
}
