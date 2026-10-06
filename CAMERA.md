# Bambu camera streaming

Flownt Bridge 0.10.0 can stream Bambu cameras to Flownt in a browser. It uses the
printer's local IP and LAN access code, independently of Bambu Cloud video. The
printer can stay connected to Bambu Cloud. Enable LAN Liveview on the printer
where required; this is separate from putting the whole printer in LAN-only mode.
Availability depends on model and firmware.

## Setup

1. Pair the printer with this bridge as usual.
2. For P1P/P1S and A1/A1 mini, no additional software is needed.
3. For X1 and other RTSP models, install FFmpeg on the **bridge computer**:
   - macOS: `brew install ffmpeg`
   - Debian / Raspberry Pi OS: `sudo apt install ffmpeg`
   - Windows: install FFmpeg and put `ffmpeg.exe` on the bridge process's PATH.
   If autostart cannot find it, set `FLOWNT_FFMPEG_PATH` to the full executable path.
4. In Flownt's Printers & Devices view, click **View live camera**.
5. If the bridge is on another computer, enter its address, e.g.
   `http://192.168.1.50:7432`. The printer's IP is not the bridge address.
6. Allow the browser's local network permission when prompted.

The bridge printer form includes **Camera connection**. Automatic uses a reported
RTSP endpoint or known X1/P2/H2 serial prefix; otherwise it uses P1/A1 JPEG capture. If
an unknown model does not report its endpoint, select **X1 / H2 / P2 (RTSP)**.
If the printer reports liveview disabled, enable it on the printer before retrying.

For self-hosted Flownt, allow its exact browser origin using
`FLOWNT_ALLOWED_ORIGINS=https://flownt.example.com` (comma-separated for several;
the older `FLOWNT_CAMERA_ORIGINS` still works) or under **Settings → Additional Flownt
addresses** in the bridge UI. Environment variables are read at process startup, not
from a `.env` file. The camera, printer-command and label-printing routes share this
allowlist.

## Behavior

- A camera starts when its first viewer connects and stops when the last leaves.
- Viewers share one upstream connection per printer.
- P1/A1 use the printer's native low-frame-rate JPEG stream over TLS port 6000.
- RTSP models use one FFmpeg process per watched printer. Output is MJPEG at
  up to 5 fps and 960 pixels wide to limit LAN bandwidth and CPU use.
- Closing the viewer, hiding the browser tab or leaving the page releases the
  connection. Flownt attempts three reconnects after transient failures.
- Slow viewers drop frames rather than accumulating an unbounded queue.
- Changing/deleting printer settings closes that printer's camera sessions.
- No frames are recorded, uploaded to Supabase or stored on disk.

## Authentication and network reachability

`GET /camera/stream` requires `Authorization: Bearer <Flownt bridge token>`.
The token resolves the printer; the browser does not need the bridge's local
printer UUID. No token or printer access code appears in stream URLs. Unpaired
requests return 401; disallowed browser origins return 403. Errors before the first
frame return JSON with an actionable code, e.g. `ffmpeg_missing`.

The response is `multipart/x-mixed-replace; boundary=flownt-frame`, with
`Content-Type: image/jpeg` and `Content-Length` per frame, and `Cache-Control:
no-store`. The frontend reads it through fetch and displays local Blob URLs.

The viewer needs a network route to the bridge. Chrome supports local network
permission prompts; other browsers may block HTTP LAN access from an HTTPS app.
A trusted HTTPS reverse proxy can resolve that limitation. If using a proxy,
disable caching and response buffering and allow long-lived streaming responses.
Use HTTPS when accessing a bridge outside the local network. This feature does
not provision an internet tunnel, TURN service or cloud video relay, and does not
make a private LAN IP remotely reachable.

The existing bridge setup UI is a local administration interface. Publishing that
entire interface on the internet is outside the scope of this camera feature.

## Verification

`npm run test:camera` exercises packet fragmentation, bounds, transport selection,
viewer sharing/cleanup, printer isolation, authentication, CORS, HTTP streaming and
FFmpeg startup failures. `npx tsc --noEmit` and `npm run build` check types and the
packaged bridge bundle. Physical printers still need an acceptance check for the
installed firmware, camera access code and concurrent Bambu Studio/Handy viewing.
