# Flownt Bridge — Ein-Befehl-Installer für Windows
#
#   irm https://raw.githubusercontent.com/Buba2017/flownt-bridge/main/install.ps1 | iex
#
# Lädt die fertige .exe aus den GitHub-Releases, entfernt das "Mark of the Web"
# (kein SmartScreen-Block), richtet Autostart bei der Anmeldung ein und startet die Bridge.
#
# The .exe is verified against the release's SHA256SUMS before it replaces the installed
# one; the install stops on a mismatch. $env:FLOWNT_VERSION = 'v0.10.0' installs a
# specific release; $env:FLOWNT_SKIP_CHECKSUM = '1' skips the check (only for old
# releases published without SHA256SUMS).
$ErrorActionPreference = 'Stop'
$repo  = 'Buba2017/flownt-bridge'
$port  = 7432
$dir   = Join-Path $env:LOCALAPPDATA 'flownt-bridge'
$bin   = Join-Path $dir 'flownt-bridge.exe'
$log   = Join-Path $dir 'bridge.log'
$asset = 'flownt-bridge-win-x64.exe'

# Pin one release for the .exe and its checksum (a release published in between must
# not mix them up): FLOWNT_VERSION, else the current latest release.
$tag = $env:FLOWNT_VERSION
if (-not $tag) {
  try { $tag = (Invoke-RestMethod -Uri "https://api.github.com/repos/$repo/releases/latest" -UseBasicParsing).tag_name } catch { $tag = $null }
}
$base = if ($tag) { "https://github.com/$repo/releases/download/$tag" } else { "https://github.com/$repo/releases/latest/download" }
$url  = "$base/$asset"
$tmp  = "$bin.download"

Write-Host "`n=== Flownt Bridge Installer ===`n" -ForegroundColor Cyan
New-Item -ItemType Directory -Force -Path $dir | Out-Null

Write-Host "Lade $asset ($(if ($tag) { $tag } else { 'latest' })) ..."
try {
  Invoke-WebRequest -Uri $url -OutFile $tmp -UseBasicParsing
} catch {
  Write-Host "Download fehlgeschlagen. Asset evtl. (noch) nicht veröffentlicht:" -ForegroundColor Red
  Write-Host "  https://github.com/$repo/releases/latest"
  exit 1
}

# Pruefsumme gegen SHA256SUMS des Releases (fail closed). `throw` statt `exit`, damit
# ein per `irm | iex` gestartetes Fenster offen bleibt und die Meldung lesbar ist.
if ($env:FLOWNT_SKIP_CHECKSUM -eq '1') {
  Write-Host "WARNUNG: Pruefsumme NICHT geprueft (FLOWNT_SKIP_CHECKSUM=1)." -ForegroundColor Yellow
} else {
  $hint = "Die Bridge wurde NICHT aktualisiert. Nur fuer aeltere Releases ohne SHA256SUMS: `$env:FLOWNT_SKIP_CHECKSUM='1' setzen und erneut ausfuehren."
  try {
    $sums = (Invoke-WebRequest -Uri "$base/SHA256SUMS" -UseBasicParsing).Content
    if ($sums -is [byte[]]) { $sums = [Text.Encoding]::UTF8.GetString($sums) }
  } catch {
    Remove-Item -Force $tmp -ErrorAction SilentlyContinue
    Write-Host "SHA256SUMS fuer $(if ($tag) { $tag } else { 'latest' }) nicht gefunden." -ForegroundColor Red
    throw $hint
  }
  $expected = $null
  foreach ($line in ($sums -split "`r?`n")) {
    if ($line -match "^\s*([0-9a-fA-F]{64})\s+\*?(\S+)\s*$" -and $Matches[2] -eq $asset) { $expected = $Matches[1]; break }
  }
  $actual = (Get-FileHash -Algorithm SHA256 -Path $tmp).Hash
  if (-not $expected -or $actual -ne $expected) {
    Remove-Item -Force $tmp -ErrorAction SilentlyContinue
    Write-Host "Pruefsumme stimmt nicht: erwartet '$expected', erhalten '$actual'." -ForegroundColor Red
    throw $hint
  }
  Write-Host "OK Pruefsumme" -ForegroundColor Green
}

# Laufende Instanz erst jetzt beenden (nach erfolgreichem Download + Pruefung) — sonst
# sperrt Windows die Datei bzw. es liefe danach eine zweite Instanz (Update-Fall).
Get-Process -Name 'flownt-bridge' -ErrorAction SilentlyContinue | Stop-Process -Force
Start-Sleep -Milliseconds 500
Move-Item -Force -Path $tmp -Destination $bin

# Mark-of-the-Web entfernen → SmartScreen blockt die .exe nicht
Unblock-File -Path $bin
Write-Host "OK Binary installiert: $bin" -ForegroundColor Green

# Autostart bei Anmeldung (geplante Aufgabe; Fallback: Startup-Verknüpfung)
try {
  # The bridge writes and rotates its own log file (5 MB x 3).
  $action   = New-ScheduledTaskAction -Execute $bin -Argument "--log-file `"$log`""
  $trigger  = New-ScheduledTaskTrigger -AtLogOn
  $settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable
  Register-ScheduledTask -TaskName 'FlowntBridge' -Action $action -Trigger $trigger -Settings $settings -Force | Out-Null
  Write-Host "OK Autostart eingerichtet (geplante Aufgabe 'FlowntBridge')." -ForegroundColor Green
} catch {
  $startup = [Environment]::GetFolderPath('Startup')
  $sc = (New-Object -ComObject WScript.Shell).CreateShortcut((Join-Path $startup 'FlowntBridge.lnk'))
  $sc.TargetPath = $bin
  $sc.Arguments = "--log-file `"$log`""
  $sc.Save()
  Write-Host "OK Autostart per Startup-Verknuepfung eingerichtet." -ForegroundColor Green
}

# Jetzt starten
Start-Process -FilePath $bin -ArgumentList "--log-file `"$log`""
Start-Sleep -Seconds 2
Write-Host "`nOK Flownt Bridge laeuft!`n" -ForegroundColor Green
Write-Host "  Web-Oberflaeche:  http://localhost:$port"
Write-Host "  Dort waehlst du, was die Bridge tun soll (Drucker ueberwachen / Etiketten drucken)."
Write-Host "  Logs:             $log"
Write-Host "  Stoppen:          Task-Manager -> 'flownt-bridge' beenden`n"
