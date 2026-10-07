# Bambu-Kamera-Streaming

Die Flownt Bridge kann die Kameras von Bambu-Druckern in Flownt im Browser anzeigen. Sie nutzt
dafür die lokale IP-Adresse und den LAN-Access-Code des Druckers, unabhängig vom Video der
Bambu Cloud. Der Drucker kann mit der Bambu Cloud verbunden bleiben. Wo nötig, muss am Drucker
„LAN Liveview“ eingeschaltet sein; das ist etwas anderes, als den ganzen Drucker in den
LAN-only-Modus zu versetzen. Ob die Kamera verfügbar ist, hängt von Modell und Firmware ab.

## Einrichtung

1. Den Drucker wie gewohnt mit dieser Bridge verbinden.
2. Für P1P/P1S und A1/A1 mini ist keine weitere Software nötig.
3. Für X1 und andere RTSP-Modelle FFmpeg auf dem **Rechner der Bridge** installieren:
   - macOS: `brew install ffmpeg`
   - Debian / Raspberry Pi OS: `sudo apt install ffmpeg`
   - Windows: FFmpeg installieren und `ffmpeg.exe` in den `PATH` des Bridge-Prozesses legen.

   Findet der Autostart FFmpeg nicht, `FLOWNT_FFMPEG_PATH` auf den vollständigen Pfad der
   ausführbaren Datei setzen.
4. In Flownt unter **Drucker & Geräte** auf der Druckerkarte die Kamera öffnen (**Live-Kamera öffnen**).
5. Läuft die Bridge auf einem anderen Rechner, dessen Adresse eingeben, z. B.
   `http://192.168.1.50:7432`. Die IP-Adresse des Druckers ist nicht die Adresse der Bridge.
6. Die Abfrage des Browsers nach Zugriff auf das lokale Netzwerk erlauben.

Das Druckerformular der Bridge hat den Punkt **Kamera-Verbindung**. **Automatisch** nutzt einen
vom Drucker gemeldeten RTSP-Endpunkt oder ein bekanntes Seriennummern-Präfix von X1/P2/H2;
andernfalls die JPEG-Übertragung von P1/A1. Meldet ein unbekanntes Modell keinen Endpunkt,
**X1 / H2 / P2 (RTSP)** auswählen. Meldet der Drucker „Liveview deaktiviert“, Liveview am
Drucker einschalten und erneut versuchen.

Bei einer eigenen Flownt-Instanz deren genauen Browser-Origin erlauben: mit
`FLOWNT_ALLOWED_ORIGINS=https://flownt.example.com` (mehrere kommagetrennt; das ältere
`FLOWNT_CAMERA_ORIGINS` funktioniert weiterhin) oder in der Bridge-Oberfläche unter
**Einstellungen → Weitere Flownt-Adressen**. Umgebungsvariablen werden beim Start des Prozesses
gelesen, nicht aus einer `.env`-Datei. Kamera, Druckerbefehle und Etikettendruck nutzen dieselbe
Liste erlaubter Origins.

## Verhalten

- Eine Kamera startet, wenn der erste Betrachter sich verbindet, und stoppt, wenn der letzte
  geht.
- Betrachter teilen sich je Drucker eine Verbindung zum Drucker.
- P1/A1 nutzen den nativen JPEG-Stream des Druckers mit niedriger Bildrate über TLS-Port 6000.
- RTSP-Modelle nutzen je betrachtetem Drucker einen FFmpeg-Prozess. Ausgegeben wird MJPEG mit
  höchstens 5 Bildern pro Sekunde und 960 Pixeln Breite, um Bandbreite im LAN und CPU zu
  schonen.
- Schließen des Viewers, Ausblenden des Browser-Tabs oder Verlassen der Seite gibt die
  Verbindung frei. Nach vorübergehenden Fehlern versucht Flownt dreimal, sich neu zu verbinden.
- Langsame Betrachter verwerfen Bilder, statt eine unbegrenzte Warteschlange aufzubauen.
- Ändern oder Löschen der Druckereinstellungen beendet die Kamera-Sitzungen dieses Druckers.
- Es werden keine Bilder aufgezeichnet, nach Supabase hochgeladen oder auf der Festplatte
  gespeichert.

## Authentifizierung und Erreichbarkeit im Netzwerk

`GET /camera/stream` verlangt `Authorization: Bearer <Flownt-Bridge-Token>`. Über das Token
findet die Bridge den Drucker; der Browser braucht die lokale Drucker-ID der Bridge nicht. In
Stream-URLs stehen weder Token noch Access Code. Anfragen ohne gültige Kopplung erhalten 401,
nicht erlaubte Browser-Origins 403. Fehler vor dem ersten Bild kommen als JSON mit einem
verständlichen Code, z. B. `ffmpeg_missing`.

Die Antwort ist `multipart/x-mixed-replace; boundary=flownt-frame`, mit
`Content-Type: image/jpeg` und `Content-Length` je Bild sowie `Cache-Control: no-store`. Das
Frontend liest sie per `fetch` und zeigt lokale Blob-URLs an.

Der Viewer braucht eine Netzwerkverbindung zur Bridge. Chrome fragt nach der Erlaubnis für das
lokale Netzwerk; andere Browser blockieren unter Umständen HTTP-Zugriffe ins LAN aus einer
HTTPS-App. Ein vertrauenswürdiger HTTPS-Reverse-Proxy kann das lösen. Bei einem Proxy Caching
und Puffern der Antwort abschalten und lang laufende Streaming-Antworten erlauben. Außerhalb des
lokalen Netzwerks die Bridge nur über HTTPS ansprechen. Diese Funktion richtet keinen
Internet-Tunnel, keinen TURN-Dienst und kein Cloud-Video-Relay ein und macht eine private
LAN-IP nicht von außen erreichbar.

Für einen eigenen Tunnel nur `/camera/` weiterleiten und die öffentliche Adresse in
`FLOWNT_PUBLIC_URL` eintragen; die Bridge meldet sie an Flownt und erlaubt ihren Hostnamen.

Die Setup-Oberfläche der Bridge ist eine lokale Verwaltungsoberfläche. Sie insgesamt im
Internet zu veröffentlichen, gehört nicht zu dieser Kamera-Funktion.

## Prüfung

`npm run test:camera` testet Paketfragmentierung, Grenzen, Wahl der Übertragungsart, gemeinsam
genutzte Verbindungen und Aufräumen, Trennung zwischen Druckern, Authentifizierung, CORS,
HTTP-Streaming und Startfehler von FFmpeg. `npx tsc --noEmit` und `npm run build` prüfen Typen
und das gebaute Bundle. An echten Druckern ist weiterhin eine Abnahme nötig: installierte
Firmware, Access Code für die Kamera und gleichzeitiges Ansehen in Bambu Studio bzw. Handy.
