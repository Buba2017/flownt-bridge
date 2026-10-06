# Bambu Lab printers over LAN — what the bridge relies on

Notes on the parts of the Bambu LAN protocol the bridge uses, with the model and firmware
quirks we ran into. Verified against X1C, X2D and H2C printers (firmware as of 2026-10).
Some facts were cross-checked with the open-source project
[bambuddy](https://github.com/maziggy/bambuddy). It is AGPL-3.0: we take protocol
knowledge from it, never code.

## Connections

| What | Port | Notes |
|---|---|---|
| MQTT (status, commands) | 8883, TLS | user `bblp`, password = LAN access code; reports on `device/<serial>/report`, requests on `device/<serial>/request` |
| FTPS (print files) | 990, implicit TLS | user `bblp`, password = access code; see below |
| Camera X1/X2/H2/P2 | 322, RTSPS | needs "LAN Only Liveview" enabled on the printer, otherwise `ipcam.rtsp_url = "disable"` |
| Camera A1/P1 | 6000, TLS JPEG | |
| Discovery (SSDP) | UDP 2021/1990 | printers announce serial, model code, name and IP; never the access code |

## Control commands need Developer Mode

Since the 2025 "authorization" firmware, printers in normal (cloud) mode reject or ignore
control commands sent over LAN MQTT: pause, resume, stop, starting a print, temperature
and AMS control. They only work with **LAN-only mode + Developer Mode** enabled on the
printer, which turns off Bambu Cloud and Bambu Handy for that printer. A rejection shows
up as a command reply with `result != "success"`, no reply at all, or HMS
`0500_0500_0001_0007` ("MQTT command verification failed"). The bridge reports this as
`command_rejected` (HTTP 409 on `/printer/command`). Reading status, AMS data, files and
the camera works in all modes.

Commands must always name the printer. `/printer/command` takes `printerId` (local) or
`flowntPrinterId`; without either it only acts when exactly one printer is connected.

## Print state (`print.gcode_state`)

| gcode_state | Flownt status | job_state | Meaning |
|---|---|---|---|
| `IDLE`, `""` | idle | idle | nothing running |
| `PREPARE`, `SLICING` | printing | preparing | heating, levelling, calibration — the printer is busy |
| `RUNNING` | printing | printing | |
| `PAUSE` | paused | paused | |
| `FINISH` | idle | finished | job done; the plate is still full |
| `FAILED` | error | failed | failed or stopped (the firmware reports a manual stop as FAILED) |

- A job can fail during `PREPARE` without ever reaching `RUNNING`; it must still end as a
  failed job. That's why `PREPARE` counts as printing.
- `print_error` is a 32-bit value shown as `MMMM_EEEE`. Low words below `0x4000` are
  status values, not errors.
- **HMS** (`print.hms`, list of `{attr, code}`): the code shown on the printer is
  `attr` (hi/lo 16 bit) + `code` (hi/lo 16 bit) as hex, `XXXX_XXXX_XXXX_XXXX`. Severity is
  `code >> 16`: 1 fatal, 2 serious, 3 common, 4 info. Explanation:
  `https://e.bambulab.com/index.php?e=<code without _>&s=device_hms&lang=en` (redirects to
  the Bambu wiki).

## AMS and tray numbering

- AMS unit ids come from `ams.ams[].id` and do not have to start at 0 (an X1C with two
  AMS reported units 1 and 2). Use the ids, never array positions.
- Global tray number in Flownt: `unit * 4 + slot`. AMS HT units have ids 128–135 with
  one tray each. 254 = external spool, 255 = no tray.
- **`ams.tray_now` is not enough on dual-nozzle printers** (H2D, H2C, X2D): there it is
  only the slot within its unit (an H2C printing from unit 1 slot 2 reported
  `tray_now = "2"`). The reliable source on all current firmware is
  `device.extruder.info[i].snow` = `(ams_id << 8) | slot` of the tray loaded on extruder
  `i` (65535 = none), with the active extruder in bits 4–7 of `device.extruder.state`.
- `print.mapping` (during a job): one entry per slicer filament (index = filament id − 1),
  value `(ams_id << 8) | slot`; 65535 = unused or external spool.
- `get_version` (`{"info":{"command":"get_version"}}`) lists modules; the AMS model
  follows from the module name prefix: `ams/` AMS, `ams_f1/` AMS Lite, `n3f/` AMS 2 Pro,
  `n3s/` AMS HT.
- RFID: `tray_uuid` identifies a Bambu spool (both tags of a spool share it; all zeros
  = no tag), `tray_info_idx` is the Bambu filament code (e.g. `GFA00`, `GFB50`),
  `tray_sub_brands` the product line, `remain` the fill level in % (−1 unknown) and
  `tray_weight` the spool's net weight in g.

## Print files over FTPS

- **TLS session reuse is mandatory** on current firmware (vsftpd
  `require_ssl_reuse`): the TLS data connection must resume the control connection's
  session, otherwise the printer answers `522 SSL connection failed: session reuse
  required`. basic-ftp does not satisfy this on these printers, so the bridge uses its
  own small client (`src/adapters/ftps.ts`), capped at TLS 1.2.
- A1 / A1 mini refuse the encrypted data channel; the client falls back to `PROT C`
  (plain data channel, encrypted control channel) once and remembers it per printer.
- After a connection-level failure the bridge leaves the printer's FTPS alone for 5
  minutes (some X2D firmware answers with garbage after a failed handshake).
- **Where the file is:** FTPS only serves the external storage (SD card / USB stick).
  - X1/P1/A1 keep a copy of every sent job there: `/cache/<name>.gcode.3mf` or the
    root.
  - H2D/H2C/H2S/X2D/P2S have internal storage and keep jobs sent from Bambu Studio
    there unless the SD card is chosen as the target when sending. Those jobs cannot be
    read over FTPS, so there is no plate preview and no slicer weights for them; Flownt
    falls back to the other weight sources.
- File names: spaces may become `_`, and a `/` in the job name is stored as `2f`. The
  bridge tries these variants and then lists `/cache`, `/` and `/model`.
- `gcode_file` (`/data/Metadata/plate_<n>.gcode`) gives the plate being printed.

## The .3mf print file

- `Metadata/slice_info.config` (XML): per `<plate>`, the `index`, `printer_model_id`
  (e.g. `BL-P001` X1C, `O1C2` H2C, `N6` X2D), `nozzle_diameters`, `prediction` (s),
  `weight`, and one `<filament>` per used filament with `id` (slicer filament, from 1),
  `type`, `color`, `used_g`, `used_m`, `tray_info_idx` and on dual-nozzle printers
  `group_id` (nozzle).
- Files sent from Bambu Studio contain only the printed plate. A project with several
  sliced plates lists each plate separately, so the bridge only counts the plate that is
  being printed.
- `Metadata/plate_<n>.png` is the plate thumbnail (512×512) used as the print preview.

## Not implemented: starting prints from Flownt

Uploading a sliced file and starting it would need Developer Mode (see above) and, on
dual-nozzle printers, a correct `nozzle_mapping`; a wrong mapping can level with one
nozzle and print with the other above the bed. Not built on purpose.
