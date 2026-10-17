import { connect } from 'tls';
import { spawn } from 'child_process';
import type { PrinterConfig } from '../config.js';
import { BambuJpegParser, cameraLogin, JpegParser } from './protocol.js';

export type CameraTransport = 'auto' | 'jpeg' | 'rtsp';
export type CameraErrorCode = 'camera_unavailable' | 'liveview_disabled' | 'ffmpeg_missing' | 'invalid_camera_config' | 'camera_reconfigured';
export class CameraError extends Error {
  constructor(public readonly code: CameraErrorCode) { super(code); }
}
export interface CameraSource { transport: 'jpeg' | 'rtsp'; host: string; accessCode: string; rtspUrl?: string }
export interface CameraListener { frame(frame: Buffer): void; error(error: CameraError): void }
export type CameraStarter = (source: CameraSource, listener: CameraListener) => () => void;

export function resolveCameraSource(cfg: PrinterConfig, reportedUrl?: string | null): CameraSource {
  let address: URL;
  try {
    address = new URL(/^https?:\/\//i.test(cfg.adapterUrl) ? cfg.adapterUrl : `http://${cfg.adapterUrl}`);
    if (!address.hostname || address.username || address.password || address.pathname !== '/' || address.search || address.hash) throw new Error();
  } catch { throw new CameraError('invalid_camera_config'); }
  const host = address.hostname.replace(/^\[|\]$/g, '');
  // Known X1/P2/H2/X2 serial prefixes plus printer-reported ipcam.rtsp_url.
  // A manual transport setting handles unknown/new models.
  // 20P = X2D, 31B = H2C (observed on real printers).
  const transport = cfg.cameraTransport && cfg.cameraTransport !== 'auto' ? cfg.cameraTransport
    : (/^rtsps?:\/\//i.test(reportedUrl ?? '') || /^(00M|00W|03W|22E|093|094|20P|31B)/i.test(cfg.adapterSerial) ? 'rtsp' : 'jpeg');
  if (transport === 'jpeg') return { transport, host, accessCode: cfg.adapterApiKey };
  // RTSP models report rtsp_url "disable" while LAN liveview is switched off on the printer.
  if (reportedUrl === 'disable') throw new CameraError('liveview_disabled');
  let url: URL;
  try {
    url = new URL(reportedUrl || `rtsps://${address.hostname}:322/streaming/live/1`);
    // Printer-reported endpoints may contain a stale host. Keep its path/port but
    // only ever connect to the configured printer, never to another reported host.
    if (url.protocol !== 'rtsps:' && url.protocol !== 'rtsp:') throw new Error();
    url.hostname = address.hostname;
    url.port ||= '322';
    url.username = 'bblp';
    url.password = cfg.adapterApiKey;
    url.hash = '';
  } catch { throw new CameraError('invalid_camera_config'); }
  return { transport, host, accessCode: cfg.adapterApiKey, rtspUrl: url.toString() };
}

export const startCamera: CameraStarter = (source, listener) => {
  let stopped = false;
  let stopUpstream = () => {};
  let watchdog: ReturnType<typeof setTimeout>;
  const stop = () => {
    if (stopped) return;
    stopped = true;
    clearTimeout(watchdog);
    stopUpstream();
  };
  const fail = (code: CameraErrorCode = 'camera_unavailable') => {
    if (stopped) return;
    stop();
    listener.error(new CameraError(code));
  };
  const resetTimeout = () => {
    clearTimeout(watchdog);
    watchdog = setTimeout(() => fail(), 20_000);
    watchdog.unref();
  };
  resetTimeout();
  const emit = (frames: Buffer[]) => {
    if (stopped) return;
    for (const frame of frames) {
      resetTimeout();
      listener.frame(frame);
    }
  };
  if (source.transport === 'jpeg') {
    const parser = new BambuJpegParser();
    // Bambu LAN cameras have self-signed device certificates, as does local MQTT.
    const socket = connect({ host: source.host, port: 6000, rejectUnauthorized: false });
    stopUpstream = () => socket.destroy();
    socket.on('secureConnect', () => {
      try { socket.write(cameraLogin(source.accessCode)); } catch { fail('invalid_camera_config'); }
    });
    socket.on('data', chunk => {
      try { emit(parser.push(chunk)); } catch { fail(); }
    });
    socket.on('error', () => fail());
    socket.on('close', () => fail());
  } else {
    const parser = new JpegParser();
    // No shell, no stderr forwarding: FFmpeg errors can contain credential URLs.
    const child = spawn(process.env.FLOWNT_FFMPEG_PATH?.trim() || 'ffmpeg', [
      '-hide_banner', '-loglevel', 'error', '-nostdin',
      '-rtsp_transport', 'tcp', '-timeout', '10000000', '-i', source.rtspUrl!,
      '-an', '-vf', "fps=5,scale='min(960,iw)':-2", '-c:v', 'mjpeg', '-q:v', '5',
      '-threads', '1', '-f', 'image2pipe', 'pipe:1',
    ], { stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true });
    stopUpstream = () => {
      child.kill('SIGTERM');
      const killTimer = setTimeout(() => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); }, 2000);
      killTimer.unref();
      child.once('close', () => clearTimeout(killTimer));
    };
    child.stdout.on('data', (chunk: Buffer) => {
      try { emit(parser.push(chunk)); } catch { fail(); }
    });
    child.on('error', (err: NodeJS.ErrnoException) => fail(err.code === 'ENOENT' ? 'ffmpeg_missing' : 'camera_unavailable'));
    child.on('close', () => fail());
  }
  return stop;
};

interface CameraConnection { sourceKey: string; listeners: Set<CameraListener>; stop: () => void }

/** One upstream per printer, bounded viewer queues in HTTP, no idle capture. */
export class CameraRelay {
  private connections = new Map<string, CameraConnection>();
  constructor(private readonly start: CameraStarter = startCamera) {}

  subscribe(id: string, source: CameraSource, listener: CameraListener): () => void {
    const sourceKey = JSON.stringify(source);
    let connection = this.connections.get(id);
    if (connection && connection.sourceKey !== sourceKey) {
      this.invalidate(id);
      connection = undefined;
    }
    if (!connection) {
      connection = { sourceKey, listeners: new Set(), stop: () => {} };
      this.connections.set(id, connection);
      connection.listeners.add(listener);
      const current = connection;
      // Start after subscribe returns, so callers have installed cleanup first.
      queueMicrotask(() => {
        if (this.connections.get(id) !== current) return;
        try {
          current.stop = this.start(source, {
            frame: frame => {
              if (this.connections.get(id) === current) for (const viewer of [...current.listeners]) viewer.frame(frame);
            },
            error: error => { if (this.connections.get(id) === current) this.invalidate(id, error); },
          });
          if (this.connections.get(id) !== current) current.stop();
        } catch { this.invalidate(id, new CameraError('camera_unavailable')); }
      });
    } else connection.listeners.add(listener);
    const current = connection;
    return () => {
      current.listeners.delete(listener);
      if (!current.listeners.size && this.connections.get(id) === current) {
        this.connections.delete(id);
        current.stop();
      }
    };
  }

  invalidate(id: string, error = new CameraError('camera_reconfigured')): void {
    const connection = this.connections.get(id);
    if (!connection) return;
    this.connections.delete(id);
    connection.stop();
    for (const listener of [...connection.listeners]) listener.error(error);
    connection.listeners.clear();
  }

  dispose(): void { for (const id of [...this.connections.keys()]) this.invalidate(id); }
}
