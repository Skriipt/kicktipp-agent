# Review-Korrekturen und Abschlussprüfung

Historischer Korrekturschritt vor der Live-Verkabelung; deren aktuellen Stand beschreibt [workflow-live.md](workflow-live.md).

Stand: 2026-09-07. Basis: `2c1dcce`, lokaler uncommitteter Patch.

## Behobene Befunde

| Befund | Korrektur | Regression/Nachweis |
| --- | --- | --- |
| Neue Submission trotz Stopp während Prediction | Äußeres Signal an beide Phasen weitergereicht; zusätzliche Prüfung vor neuer Submission; noch nicht gestartete `bounded`-Arbeit wird nach Abbruch nicht aufgerufen | Stopp während Prediction bei offenem Fenster: kein Schreibversuch; hängender Predictor wird abgebrochen |
| Bereits begonnene Submission muss trotz Stopp geklärt werden | Read-back behält unabhängigen Abbruchkontext und Deadline | Angenommener synthetischer Schreibversuch wird bestätigt; kein erneutes Schreiben |
| R2 akzeptiert geänderte Teams/Kickoff bei gleichem Schlüssel | Vollständige Fixture-Identität in neuen Research-Daten; gemeinsame Schema-/Evidenzprüfung in `evidence.ts` | Geändertes Heimteam, Auswärtsteam und Kickoff sowie ungültige/fehlende Evidenz werden abgewiesen |
| Alte Checkpoints besitzen noch keine vollständige Research-Identität | Ergänzung ausschließlich aus dem vom Store vollständig geprüften umschließenden Zustand | Legacy-Zustand läuft weiter; abweichender Zeitplan und widersprüchliche vorhandene Identität bleiben gesperrt |
| Doppelklammern in Zitaten lassen R2 abbrechen | Template-Prüfung von JSON-kodierten Dossierdaten getrennt; Daten bleiben literal und werden nicht erneut expandiert | R1-Zitat mit `{{HOME_TEAM}}` und `}}` erreicht R2 und Prediction unverändert |
| Frühere Ablehnung sperrt korrigierte Folgeversuche | Frühere Gründe in `rejectionHistory`; `rejected` gilt für aktuellen Versuch; ungültige oder leere Berichte pausieren mit Backoff | Recovery nach Providerfehler und nach regulär beendetem ungültigem Bericht; ungültiges Finding fehlt weiterhin in Evidenz |
| Unverständlicher Buildfehler mit Node 18; vorherige Artefakte werden gelöscht | `.nvmrc` auf 24.15.0; Runtime-Prüfung vor Löschen von `dist`; Setup-Dokumentation ergänzt | Node 18 meldet verständlichen Versionsfehler, SHA-256 vorhandener Build-Datei bleibt unverändert |
| Zu starke Garantien und widersprüchliche Betriebsanweisungen | Prompt-Framing als zusätzliche Anweisung statt technische Isolation beschrieben; Codex als Ziel, Hermes/Firecrawl als optionale Altintegration gekennzeichnet | Dokumentationsreview; kein aktiver Fallback implementiert |
| `diff --check` im Übergabebericht | Nachgestellte Leerzeichen entfernt, historische Testzahlen als solche gekennzeichnet | `git diff --check` |

## Verifikation

Laufzeit: Node **24.15.0**, npm **11.12.1**, innerhalb der Projektanforderungen.

- Vor den Korrekturen: die neuen Regressionen schlugen im gezielten Lauf achtmal fehl und reproduzierten damit die berichteten Fehler.
- Nach den Korrekturen: **87 Workflow-/Prompt-Tests bestanden**.
- **Vollständiger Testlauf: 56 Testdateien, 796 Tests bestanden**, 117,51 Sekunden; vorgeschalteter Build erfolgreich.
- Frischer Offline-Demo-Lauf in einem separaten temporären Verzeichnis: virtuelle Wartezeiten 1/210/40 Minuten, genau eine synthetische Submission, Zustand `submitted`.
- Zweiter Demo-Start auf diesem Zustand: weiterhin `submitted`, kein weiterer synthetischer Schreibversuch.
- `git diff --check`: erfolgreich.
- Runtime-Fehlerpfad unter Node 18 separat geprüft: Abbruch vor Veränderung vorhandener Build-Dateien.
- Keine externe Recherche, echten Modellaufrufe, Kicktipp-Schreibaktionen oder Pushes. Der Quellcode-Patch ist lokal und nicht committed.

## Abschließender unabhängiger Review

**Standards:** Keine belastbaren Verstöße gegen dokumentierte Standards und keine relevanten heuristischen Code-Smells. Die gemeinsame Evidenzvalidierung verhindert einen Importzyklus zwischen Prompt-Renderer und Research-Ausführung.

**Spezifikation/Funktion:** Keine neuen belastbaren Befunde in Diff, angrenzender Zustandsmaschine, Persistenz und Regressionstests. Abbruchverhalten, vollständige Identität, Legacy-Übernahme, literal erhaltene Daten und korrigierbare Research-Ablehnungen entsprechen dem Fixauftrag.

Die beiden Review-Agenten prüften unabhängig und lesend; sie führten keine zusätzlichen Testläufe aus. Die Testnachweise stammen aus dem lokalen Hauptlauf.

## Verbleibende Integrationsgrenzen

Diese Korrekturen sind keine Produktionsfreigabe der vollständigen Tippkette:

- Produktive Codex-Research-, Prediction- und Submission-Adapter sowie gesicherte Schedule-/Kicktipp-ID-Zuordnung fehlen weiterhin. Es wurde kein echter Research-only-E2E-Lauf ausgeführt.
- `complete` bedeutet weiterhin einen beendeten Bericht mit gültiger Herkunft, nicht umfassende fachliche Coverage. Mindestens ein gültiges Finding je Phase ist erforderlich; zusätzliche Pflichtkategorien wären eine fachliche Vertragsänderung.
- Der Originalwortlaut einer separat freigegebenen Nutzerfassung lag nicht vor. Bestehende Prompt-Templates und ihre Hashes sind unverändert.
- Bereits terminal gesperrte Altzustände werden nicht automatisch freigegeben. Der Fix ermöglicht neue/künftige korrigierte Research-Wiederanläufe, ohne historische Submission-Sperren aufzuheben.
- Alte Dateien werden beim Öffnen kompatibel übernommen. Ältere Releases mit strikten Schemas können die neuen additiven Felder nicht lesen; vor einem Versionswechsel State sichern und keinen alten Writer auf den aktualisierten Store setzen. Kein automatisches Zurücksetzen bereits erfolgter Tippabgaben.
- Prozessisolation und die Einhaltung des Abbruchsignals im tatsächlichen Transport bleiben Aufgaben der künftigen Live-Adapter. Das deterministische Evidence Gate kann die Wahrheit einer Quelle oder einer Paraphrase nicht allein beweisen.
