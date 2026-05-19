export interface PrinterSnapshot {
  status: 'idle' | 'printing' | 'error' | 'offline';
  printFile?: string;
  progressPct?: number;
  tempHotend?: number;
  tempBed?: number;
  etaSec?: number;
}

export interface Adapter {
  getSnapshot(): Promise<PrinterSnapshot>;
}
