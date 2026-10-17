export const MAX_FRAME_BYTES = 4 * 1024 * 1024;
export const MJPEG_BOUNDARY = 'flownt-frame';

/** Bambu P1/A1: 80-byte login followed by length-prefixed JPEGs over TLS. */
export function cameraLogin(accessCode: string): Buffer {
  if (!/^[\x20-\x7e]{1,32}$/.test(accessCode)) throw new Error('Invalid camera access code');
  const login = Buffer.alloc(80);
  login.writeUInt32LE(0x40, 0);
  login.writeUInt32LE(0x3000, 4);
  login.write('bblp', 16, 'ascii');
  login.write(accessCode, 48, 'ascii');
  return login;
}

function checkJpeg(frame: Buffer): void {
  if (frame.length < 4 || frame[0] !== 0xff || frame[1] !== 0xd8 ||
      frame[frame.length - 2] !== 0xff || frame[frame.length - 1] !== 0xd9) {
    throw new Error('Invalid camera frame');
  }
}

export class BambuJpegParser {
  private pending: Buffer = Buffer.alloc(0);

  push(chunk: Buffer): Buffer[] {
    this.pending = Buffer.concat([this.pending, chunk]);
    const frames: Buffer[] = [];
    while (this.pending.length >= 16) {
      const size = this.pending.readUInt32LE(0);
      if (size < 4 || size > MAX_FRAME_BYTES) throw new Error('Invalid camera frame size');
      if (this.pending.length < 16 + size) break;
      const frame = this.pending.subarray(16, 16 + size);
      checkJpeg(frame);
      frames.push(frame);
      this.pending = this.pending.subarray(16 + size);
    }
    return frames;
  }
}

/** FFmpeg image2pipe emits concatenated JPEGs without Bambu's 16-byte header. */
export class JpegParser {
  private pending: Buffer = Buffer.alloc(0);

  push(chunk: Buffer): Buffer[] {
    this.pending = Buffer.concat([this.pending, chunk]);
    const frames: Buffer[] = [];
    while (this.pending.length) {
      if (this.pending.length === 1 && this.pending[0] === 0xff) break;
      if (this.pending[0] !== 0xff || this.pending[1] !== 0xd8) throw new Error('Invalid camera frame');
      const end = this.pending.indexOf(Buffer.from([0xff, 0xd9]), 2);
      if (end < 0) {
        if (this.pending.length > MAX_FRAME_BYTES) throw new Error('Camera frame too large');
        break;
      }
      if (end + 2 > MAX_FRAME_BYTES) throw new Error('Camera frame too large');
      frames.push(this.pending.subarray(0, end + 2));
      this.pending = this.pending.subarray(end + 2);
    }
    return frames;
  }
}

export function multipartFrame(frame: Buffer): Buffer {
  return Buffer.concat([
    Buffer.from(`--${MJPEG_BOUNDARY}\r\nContent-Type: image/jpeg\r\nContent-Length: ${frame.length}\r\n\r\n`),
    frame, Buffer.from('\r\n'),
  ]);
}
