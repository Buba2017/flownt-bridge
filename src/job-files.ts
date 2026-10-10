import { createHash } from 'crypto';
import fetch from 'node-fetch';
import type { JobFile } from './adapters/types.js';
import type { PrinterConfig } from './config.js';
import { CONTRACT_VERSION, JOB_FILE_MAX_BYTES, type IngestBody, type JobFileRef, type JobFileResponse } from './contract.js';
import type { Sender } from './outbox.js';
import { BRIDGE_VERSION } from './version.js';

// Stores a job's print file (.gcode.3mf from the SD card) in Flownt for the print log
// (contract 3, event 'job_file'): announce it by SHA-256, PUT it to the signed URL Flownt
// returns (unless the same content is stored already), then confirm. Best effort: a
// failure is logged and never affects the job booking.

export type Put = (url: string, body: Buffer) => Promise<number>;

const defaultPut: Put = async (url, body) => {
  const res = await fetch(url, {
    method: 'PUT', body,
    headers: { 'Content-Type': 'application/octet-stream', 'x-upsert': 'true' },
    signal: AbortSignal.timeout(120_000),
  });
  return res.status;
};

export type UploadResult = 'exists' | 'stored' | 'too_large' | 'failed';

export async function uploadJobFile(send: Sender, cfg: PrinterConfig, sourceJobId: string, f: JobFile, put: Put = defaultPut): Promise<UploadResult> {
  if (f.buf.length > JOB_FILE_MAX_BYTES) return 'too_large';
  const ref: JobFileRef = {
    source_job_id: sourceJobId, file_name: f.fileName,
    sha256: createHash('sha256').update(f.buf).digest('hex'), size_bytes: f.buf.length,
  };
  const base = { auth_token: cfg.flowntAuthToken, event_type: 'job_file' as const, bridge_version: BRIDGE_VERSION, contract_version: CONTRACT_VERSION };
  const first = await send({ ...base, job_file: ref } as IngestBody);
  const r = first.data as JobFileResponse | null;
  if (first.status !== 200 || !r) return 'failed';
  if (r.status === 'exists' || r.status === 'too_large') return r.status;
  if (r.status !== 'upload' || !r.upload_url) return 'failed';
  const code = await put(r.upload_url, f.buf);
  if (code < 200 || code >= 300) return 'failed';
  const done = await send({ ...base, job_file: { ...ref, done: true } } as IngestBody);
  return done.status === 200 ? 'stored' : 'failed';
}
