# Mitwirken an der Flownt Bridge

Danke, dass du die Flownt Bridge verbessern willst. Diese Seite beschreibt, wie Beiträge
ablaufen und unter welchen Bedingungen sie aufgenommen werden.

## Ablauf

- **Basis-Branch ist `main`.** Pull Requests gehen gegen `main`.
- **Ein Feature pro Pull Request.** Kleine, in sich abgeschlossene Änderungen lassen sich
  schneller prüfen und mergen. Fehlerbehebungen und neue Funktionen nicht mischen.
- Größere Vorhaben vorher in einem Issue oder mit dem Projektinhaber abstimmen.

## Sprache

- **Dokumentation** (README und alle anderen `.md`-Dateien, `.env.example`) auf Deutsch.
- **Code-Kommentare und Commit-Nachrichten** auf Englisch.
- Commits folgen [Conventional Commits](https://www.conventionalcommits.org/), z. B.
  `fix(bambu): keep the active tray when the mapping is empty`.
- Texte in der Oberfläche gibt es auf Deutsch und Englisch; neue Texte in beiden Sprachen
  anlegen.

## Vor dem Pull Request

Diese Prüfungen laufen auch in der CI und müssen grün sein:

```bash
npm run typecheck
npm test
npm run build
```

## Datenvertrag mit Flownt

`src/contract.ts` ist eine generierte Kopie von `supabase/functions/_shared/contract.ts` aus dem
Flownt-Repository. Die Datei nie von Hand bearbeiten: Änderungen in Flownt machen und dort
`npm run sync:contract` ausführen; das schreibt die Kopie in dieses Repository.

## Rechte an Beiträgen

Mit dem Einreichen eines Beitrags (Commit, Pull Request, Patch oder auf anderem Weg) erklärst du dich mit den folgenden Bedingungen einverstanden. Wenn du nicht einverstanden bist, reiche bitte nichts ein.

1. **Übertragung.** Du überträgst Alexander Pehlke (SolidFab3D), im Folgenden „Projektinhaber“, alle Rechte an deinem Beitrag, soweit diese übertragbar sind.
2. **Nutzungsrechte.** Soweit Rechte nicht übertragbar sind – insbesondere das Urheberrecht selbst nach deutschem Recht –, räumst du dem Projektinhaber an deinem Beitrag das ausschließliche, unwiderrufliche, zeitlich, räumlich und inhaltlich unbeschränkte, übertragbare und unterlizenzierbare Nutzungsrecht für alle bekannten und unbekannten Nutzungsarten ein. Dazu gehört insbesondere das Recht, den Beitrag zu vervielfältigen, zu verbreiten, öffentlich zugänglich zu machen, zu bearbeiten und unter beliebigen Lizenzen zu veröffentlichen oder zu vertreiben, auch unter anderen als der aktuellen Lizenz und auch proprietär.
3. **Keine Vergütung.** Für den Beitrag und die Rechteeinräumung erhältst du keine Vergütung.
4. **Namensnennung.** Soweit gesetzlich zulässig, verzichtest du auf die Nennung als Urheber.
5. **Berechtigung.** Du sicherst zu, dass du zu dieser Rechteeinräumung berechtigt bist und dass dein Beitrag keine Rechte Dritter verletzt. Erstellst du den Beitrag im Rahmen eines Arbeits- oder Dienstverhältnisses, liegen die Nutzungsrechte in der Regel bei deinem Arbeitgeber (§ 43 UrhG). Dann reichst du den Beitrag nur mit dessen Zustimmung ein, und die Rechteeinräumung erfolgt durch den Arbeitgeber.
6. **Fremder Code.** Code aus anderen Projekten übernimmst du nur, wenn dessen Lizenz mit der Lizenz dieses Projekts vereinbar ist, und kennzeichnest ihn im Pull Request.

## Lizenz

Die Flownt Bridge ist quelloffen und steht unter der [Elastic License 2.0](LICENSE). Nutzen,
verändern und weitergeben ist erlaubt, auch kommerziell und im eigenen Unternehmen. Nicht
erlaubt ist, die Software Dritten als gehosteten oder verwalteten Dienst anzubieten. Verbindlich
ist allein der Lizenztext in [LICENSE](LICENSE).
