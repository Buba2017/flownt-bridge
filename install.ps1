# Flownt Bridge — Ein-Befehl-Installer für Windows
#
#   irm https://raw.githubusercontent.com/Buba2017/flownt-bridge/main/install.ps1 | iex
#
# Lädt die fertige .exe aus den GitHub-Releases, entfernt das "Mark of the Web"
# (kein SmartScreen-Block), richtet Autostart bei der Anmeldung ein und startet die Bridge.
$ErrorActionPreference = 'Stop'
$repo  = 'Buba2017/flownt-bridge'
$port  = 7432
$dir   = Join-Path $env:LOCALAPPDATA 'flownt-bridge'
$bin   = Join-Path $dir 'flownt-bridge.exe'
$asset = 'flownt-bridge-win-x64.exe'
$url   = "https://github.com/$repo/releases/latest/download/$asset"

Write-Host "`n=== Flownt Bridge Installer ===`n" -ForegroundColor Cyan
New-Item -ItemType Directory -Force -Path $dir | Out-Null

# Laufende Instanz beenden, bevor wir die .exe ueberschreiben — sonst sperrt Windows
# die Datei (Download schlaegt fehl) bzw. es liefe danach eine zweite Instanz (Update-Fall).
Get-Process -Name 'flownt-bridge' -ErrorAction SilentlyContinue | Stop-Process -Force
Start-Sleep -Milliseconds 500

Write-Host "Lade $asset ..."
try {
  Invoke-WebRequest -Uri $url -OutFile $bin -UseBasicParsing
} catch {
  Write-Host "Download fehlgeschlagen. Asset evtl. (noch) nicht veröffentlicht:" -ForegroundColor Red
  Write-Host "  https://github.com/$repo/releases/latest"
  exit 1
}

# Mark-of-the-Web entfernen → SmartScreen blockt die .exe nicht
Unblock-File -Path $bin
Write-Host "OK Binary installiert: $bin" -ForegroundColor Green

# Autostart bei Anmeldung (geplante Aufgabe; Fallback: Startup-Verknüpfung)
try {
  $action   = New-ScheduledTaskAction -Execute $bin
  $trigger  = New-ScheduledTaskTrigger -AtLogOn
  $settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable
  Register-ScheduledTask -TaskName 'FlowntBridge' -Action $action -Trigger $trigger -Settings $settings -Force | Out-Null
  Write-Host "OK Autostart eingerichtet (geplante Aufgabe 'FlowntBridge')." -ForegroundColor Green
} catch {
  $startup = [Environment]::GetFolderPath('Startup')
  $sc = (New-Object -ComObject WScript.Shell).CreateShortcut((Join-Path $startup 'FlowntBridge.lnk'))
  $sc.TargetPath = $bin
  $sc.Save()
  Write-Host "OK Autostart per Startup-Verknuepfung eingerichtet." -ForegroundColor Green
}

# Jetzt starten
Start-Process -FilePath $bin
Start-Sleep -Seconds 2
Write-Host "`nOK Flownt Bridge laeuft!`n" -ForegroundColor Green
Write-Host "  Web-Oberflaeche:  http://localhost:$port"
Write-Host "  Dort waehlst du, was die Bridge tun soll (Drucker ueberwachen / Etiketten drucken)."
Write-Host "  Stoppen:          Task-Manager -> 'flownt-bridge' beenden`n"
