import type { Express, Request } from 'express';
import { timingSafeEqual } from 'crypto';
import type { PrinterConfig } from '../config.js';
import { CameraError, CameraRelay, resolveCameraSource } from './relay.js';
import { MJPEG_BOUNDARY, multipartFrame } from './protocol.js';

export interface CameraRouteOptions {
  printers(): PrinterConfig[];
  reportedUrl(id: string): string | null | undefined;
  relay: CameraRelay;
  allowedOrigins?: string[];
}

function authenticate(req: Request, printers: PrinterConfig[]): PrinterConfig | undefined {
  const token = /^Bearer ([0-9a-f-]{36})$/i.exec(req.headers.authorization ?? '')?.[1];
  if (!token) return;
  return printers.find(printer => {
    const expected = Buffer.from(printer.flowntAuthToken.toLowerCase());
    const supplied = Buffer.from(token.toLowerCase());
    return expected.length === supplied.length && timingSafeEqual(expected, supplied);
  });
}

export function registerCameraRoutes(app: Express, options: CameraRouteOptions): void {
  const allowed = new Set(options.allowedOrigins ?? [
    'https://flownt.app', 'https://www.flownt.app',
    'http://localhost:5173', 'http://127.0.0.1:5173',
    ...(process.env.FLOWNT_CAMERA_ORIGINS ?? '').split(',').map(origin => origin.trim()).filter(Boolean),
  ]);
  app.use('/camera', (req, res, next) => {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Vary', 'Origin');
    const origin = req.headers.origin;
    if (origin && !allowed.has(origin)) return res.status(403).json({ error: 'origin_not_allowed' });
    if (origin) res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Authorization');
    res.setHeader('Access-Control-Allow-Private-Network', 'true');
    if (req.method === 'OPTIONS') return res.sendStatus(204);
    next();
  });

  app.get('/camera/stream', (req, res) => {
    // The cloud printer UUID differs from the bridge's local UUID. The existing
    // per-printer bridge token is the authoritative link, never "first printer".
    const cfg = authenticate(req, options.printers());
    if (!cfg) return res.status(401).json({ error: 'unauthorized' });
    if (cfg.adapterType !== 'bambu') return res.status(400).json({ error: 'unsupported_camera' });
    let unsubscribe = () => {};
    let closed = false;
    const cleanup = () => {
      if (closed) return;
      closed = true;
      unsubscribe();
    };
    res.on('close', cleanup);
    res.on('error', cleanup);
    try {
      const source = resolveCameraSource(cfg, options.reportedUrl(cfg.id));
      unsubscribe = options.relay.subscribe(cfg.id, source, {
        frame(frame) {
          if (closed) return;
          if (!res.headersSent) {
            res.status(200);
            res.setHeader('Content-Type', `multipart/x-mixed-replace; boundary=${MJPEG_BOUNDARY}`);
            res.setHeader('X-Accel-Buffering', 'no');
          }
          // A slow viewer drops whole frames instead of buffering the stream.
          if (!res.writableNeedDrain) res.write(multipartFrame(frame));
        },
        error(error) {
          if (closed) return;
          cleanup();
          if (!res.headersSent) res.status(503).json({ error: error.code });
          else res.end();
        },
      });
    } catch (error) {
      cleanup();
      res.status(503).json({ error: error instanceof CameraError ? error.code : 'camera_unavailable' });
    }
  });
}
