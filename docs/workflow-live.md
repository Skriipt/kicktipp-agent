# Verkabelter Research-/Prediction-Workflow

Stand: 2026-09-07. Implementierung lokal, noch nicht produktiv aktiviert.
Dieser Vertrag ergänzt die Workflow-Kernbeschreibung und ersetzt die Liste
„noch nicht verkabelt“ des ursprünglichen Übergabeberichts.

## Implementierte Kette

`npm run workflow -- --config config/workflow.json` startet den lokalen Orchestrator
im **Research-only-Modus**. Nur ein explizites `--submit` schaltet Prediction und
Submission zu. Ein Import oder ein Modulimport startet keinen Hintergrunddienst.

1. Ein eigener read-only MCP-Prozess ruft `get_workflow_fixtures` auf. Der neue
   MCP-Endpunkt liest den öffentlichen Spielplan ohne Cookies oder Modellaufruf.
2. Ohne konfigurierte Spieltage werden aktueller und nächster Spieltag importiert;
   explizite `matchdays` sind ebenfalls möglich. Standard-Pollintervall: 15 Minuten.
3. Der Import prüft interne `tippspielId`, konfigurierte `tippsaisonId`, Community,
   Spieltag, Teams und eindeutig auflösbaren Anstoß. Zahlen-IDs werden nicht erzeugt.
4. Jedes Fixture besitzt eine eigene Schleife, Locks, Zustände und Abbruchsignale.
   Neue Spiele können während anderer Research-Läufe hinzukommen. Ein verlegtes
   bekanntes Spiel stoppt seine alte Schleife; andere neue Spiele werden weiter
   importiert. Die geänderte Identität verlangt bewusste State-Reconciliation.
5. R1 startet ab T−5 Stunden und muss vor T−90 Minuten begonnen haben. R2 startet
   ab T−90 Minuten. Beide nutzen frische Codex-Prozesse mit `gpt-5.6-luna`, `xhigh`
   und Websuche. Ein gestartetes R1 kann aus Checkpoints fortgesetzt werden.
6. Nach R2 bleibt der Zustand `refreshed`. **Prediction beginnt erst ab T−50** und
   erhält ausschließlich das finale Dossier plus den festen Tippgeber-Vertrag.
7. Der Hermes-Adapter verwendet das Profilmaterial von
   `/home/ubuntu/.hermes/profiles/tippgeber`, Modell `gpt-5.6-luna`, Provider
   `openai-codex`, explizit `xhigh` und eine leere Toolauswahl.
8. Der Submission-Adapter liest frischen Spielplan und authentifiziertes Formular,
   gleicht alle Fixture-Merkmale und Provider-Saison ab und sendet nur die
   `spieltippForms[ID]`-Felder dieses Spiels sowie erlaubte Formularkontrollfelder.
   Keine Bonus- oder Nachbarspiel-Felder. Keine automatische Wiederholung eines
   POST, auch nicht bei 307/308-Weiterleitung. Direkt vor dem Versand werden
   Zeitfenster, Abbruch und read-only-Schutz erneut geprüft.
9. Erst der unabhängige Read-back bestätigt `submitted`. Geschlossene Tippzeilen
   werden anhand des frischen kanonischen Spielplans eindeutig zugeordnet.
10. Telegram-Ereignisse entstehen gemeinsam mit dem dauerhaften Status und werden
    anschließend ohne Modell gesendet.

## Dateien und Einstiegspunkte

| Baustein | Datei |
| --- | --- |
| CLI und Konfiguration | `src/workflow/cli.ts` |
| MCP-Schedule-Client | `src/workflow/mcp-schedule.ts` |
| Read-only MCP-Endpunkt | `src/server.ts`: `get_workflow_fixtures` |
| Laufender Schedule-Import | `src/workflow/orchestrator.ts` |
| Echte IDs, einzelnes POST, Read-back | `src/workflow/kicktipp.ts`, `src/http/page.ts` |
| Codex-/Hermes-Adapter | `src/workflow/agents.ts` |
| Prozessgruppen, Abbruch, Ausgabelimit | `src/workflow/process.ts` |
| Telegram-Transport und sichere Texte | `src/workflow/notifications.ts` |
| Dauerhafte Ereignisse und Wiederanlauf | `src/workflow/model.ts`, `store.ts`, `engine.ts` |
| Konfigurationsbeispiel | `docs/examples/workflow.example.json` |
| Vorbereitete User-Service-Datei | `deploy/kicktipp-workflow.service` |

## Telegram-Vertrag

Unterstützt: `r1_completed`, `r2_completed`, `tips_submitted`, `workflow_error`.
Der direkte Aufruf lautet `hermes send --to telegram --quiet <message>`;
`telegram:<chat_id>` ist optional. Kein Shell-Wrapper, Discord, Webhook oder
zusätzlicher Tippgeber-/LLM-Aufruf. Das Ziel enthält ausschließlich den Kanal und
eine optionale numerische Chat-ID.

Nachrichten enthalten feste Texte, bereinigte Teamnamen und gegebenenfalls den
Anstoß in Europe/Berlin. Keine Dossiers, Rohfehler, Cookies oder Quellen-URLs.
Zustandsfehler und Versandfehler werden getrennt behandelt: ein Telegram-Fehler
setzt einen erfolgreichen fachlichen Zustand nicht zurück.

Die persistierte Deduplizierung verwendet Fixture-Key, Ereignis, Zeitstempel und
Phase. Die Versandabsicht wird vor Hermes gespeichert. `pending` wird beim
Neustart nachgeholt, auch bei bereits abgeschlossenen Spielen. `attempted` wird
nach einem unklaren Prozessabbruch **nicht automatisch erneut versendet**;
`failed` ebenfalls nicht. Dies priorisiert keine Doppelmeldungen gegenüber einer
garantierten Telegram-Zustellung. Der lokale Versandzustand bleibt im JSON
sichtbar; normale Ticks und Neustarts duplizieren bestätigte Nachrichten nicht.

## Modell- und Prozessgrenzen

Codex erhält einen privaten Arbeits-/Auth-Bereich, keine allgemeine Benutzer-
oder Projektkonfiguration und keine geteilte Sitzung. Shell, MCP-Konfiguration,
Apps, Plugins und weitere nicht benötigte Tools sind deaktiviert. Für Research
sind Websuche und der von Codex dafür benötigte Code-Mode-Host aktiviert; beim
Metadaten-Aufruf bleiben beide deaktiviert. Der Recherchebericht wird
in strukturierte Findings übersetzt; ein vom Modell geschriebener Seitentext wird
nicht ungeprüft zu Evidenz.

Originale werden separat per HTTPS geladen, mit öffentlichen DNS-Adressen an die
Verbindung gebunden und begrenzt eingelesen. Weiterleitungen werden abgewiesen;
der Kandidat muss die finale Original-URL benennen. Ein eigener Aufruf ohne
Webtools ordnet Metadaten aus dem geladenen Original zu. Anschließend greifen
wörtliche Zitatprüfung und gemeinsames Evidence Gate. Akzeptierte Quellen und
Findings werden während dieser Validierung schrittweise checkpointed. Der erste
Codex-Bericht selbst ist vor seiner Rückgabe noch kein dauerhafter Checkpoint.
Das kanonische Markdown-Dossier entsteht ausschließlich aus geprüfter Evidenz.

Der hier installierte Hermes-One-shot-Modus akzeptiert `-t none` nicht und reicht
`--reasoning` nicht an den Agenten weiter. Deshalb erzeugt der Adapter einen
kleinen nativen Python-Aufruf der installierten Hermes-API. Toolauswahl, Reasoning,
fehlende gemeinsame Session-DB, deaktivierter Speicher und deaktivierte
Hintergrundanalyse werden explizit gesetzt. Geerbte Hermes-Worker-Kontexte werden
entfernt, damit beispielsweise ein fremder Kanban-Auftrag keine Tools hinzufügt.

Temporäre Arbeitsverzeichnisse werden auch nach Fehlern entfernt. Prozesse starten
mit `shell: false`; Abbruch beendet die Prozessgruppe einschließlich Kindprozessen.
Ausgabe ist begrenzt, rohes stderr wird nicht als Fehlertext weitergegeben.
Erneuerte `auth.json`-Snapshots werden unter kurzem Lock atomar zurückgeschrieben,
aber nur wenn die ursprüngliche Auth-Datei inzwischen nicht geändert wurde.
Sessions, Profileinstellungen und `.env` werden nicht zurückgeschrieben.

Technische Grenzen bleiben explizit: Research 30 Minuten pro Versuch, Retrieval
2 Minuten pro Anfrage, Prediction und Submission jeweils bis zu 30 Sekunden,
zusätzlich durch den Anstoß begrenzt. Telegram hat eine eigene 10-Sekunden-Grenze.
Es gibt kein standardmäßiges Suchzähl-Limit. Unzugängliche Originale, fehlende
verlässliche Metadaten oder ungültige Antworten pausieren den Research-Lauf.

## Lokale Befehle

Im Repository:

```bash
nvm install && nvm use
npm run build
npm run workflow -- --config config/workflow.json --schedule
npm run workflow -- --config config/workflow.json --research-check 1625874559
```

`--schedule` führt weder Research noch Prediction, Submission oder Telegram aus.
`--research-check` wählt exakt ein importiertes Fixture, startet nur wirklich
fällige Research-Phasen und aktiviert keine Benachrichtigungen. Ein noch nicht
geöffnetes Research-Zeitfenster wird nicht für den Test umgangen. Der Befehl endet
nach dem Tick und meldet Abschlussflags und Anzahl akzeptierter Evidenzen.

Dauerhafter Research-only-Betrieb im Vordergrund:

```bash
npm run workflow -- --config config/workflow.json
```

Die vorbereitete systemd-Datei nutzt denselben Research-only-Modus, eine feste
Node-24-Laufzeit, restriktive Dateirechte und Prozessgruppen-Stopp. Sie wurde
**nicht installiert oder gestartet**. Für eine spätere Aktivierung muss die
konkrete Datei als User-Service installiert werden. `--submit` ist erst nach den
unten genannten Live-Prüfungen in den Startbefehl aufzunehmen.

## Verifikation und noch ausstehende Abnahme

Bereits real geprüft: öffentlicher Spielplanimport durch die vollständige
MCP-/CLI-Kette. Für `toms-zockerrunde-2627` wurde die interne Saison `5530388`
bestätigt. Spieltag 3 enthält neun importierbare Partien. Union Berlin–Schalke hat
`fixtureId=1625874559`, Anstoß `2026-09-11T18:30:00Z` und damit R1 am
11.09.2026 um 15:30 Uhr Europe/Berlin. Der Import nutzt keine gespeicherten Cookies.

Die gespeicherte angemeldete Sitzung leitete den Predict-Zugriff auf Login um.
Daher sind authentifizierter Read-back und das reale Serververhalten bei gezielt
teilweiser Formularübermittlung noch nicht live abgenommen. Es wurde keine echte
Tippabgabe als Test durchgeführt. Die Account-Neuverbindung wurde beim Nutzer
angefragt.

Der echte Research-only-E2E-Lauf kann vor dem genannten Zeitfenster nicht als
regulärer R1 durchgeführt werden. Native OpenAI-Websuche, reales Modellresultat
und erfolgreiche Evidence-Gate-Passage bleiben deshalb Live-Abnahmepunkte.
Weder ein zeitlich vorgezogener Test noch die synthetischen Adaptertests ersetzen
sie. Ein lokaler Responses-Mock bestätigte die Abschaltung nicht benötigter
Codex-Tools; installierte Hermes-Aufrufparameter wurden anhand lokaler API-Quellen
geprüft. Es erfolgte keine Modellinferenz und es wurden keine Telegram-Testnachrichten gesendet. Eine Konfigurationsprobe mit Dummy-Authentifizierung wurde mit HTTP 401 abgewiesen.

Semantische Saison-/Wettbewerbsbezeichnungen sind weiterhin Betreiberangaben;
die interne Provider-Saison wird technisch geprüft. Quellenzuverlässigkeit und
die Bedeutung einer Paraphrase bleiben semantische Bewertungen. `complete`
bedeutet gültige Herkunft bei abgeschlossenem Bericht, nicht volle Coverage.
Bereits gesperrte Altzustände werden nicht automatisch freigegeben.

## Abschlussprüfung

- Node 24.15.0: Build erfolgreich, **60 Testdateien / 873 Tests bestanden**,
  105,09 Sekunden im finalen Gesamtlauf.
- `git diff --check` und `systemd-analyze --user verify deploy/kicktipp-workflow.service` erfolgreich.
- Frische Offline-Demo erfolgreich bis `submitted`; wiederholter Start ohne erneute Submission.
- Echter öffentlicher MCP-/CLI-Import: 18 Spiele (aktueller und nächster Spieltag),
  davon neun zukünftige Partien.
- Der Research-Prüfbefehl für `1625874559` wurde vor dem realen R1-Fenster
  abgewiesen; kein vorgezogener Research-Lauf wurde als Abnahme ausgegeben.
- Unabhängige Reviews von Transport, Orchestrierung und Modelladaptern fanden fünf Randfälle;
  alle wurden mit Regressionstests behoben und unabhängig nachgeprüft: erlaubte
  Ursprungsserver, vollständige Datenzeilen, ausstehende Nachrichten nach Anpfiff
  und isolierte Behandlung eines verlegten Spiels. Zusätzlich wurde der gepinnte
  DNS-Callback für Nodes tatsächlichen IPv4-Aufrufvertrag korrigiert.
- Der Transportreview führte 20 Tests unabhängig aus; der Orchestrierungsreview
  führte 85 Workflow-/Scheduler-Tests unabhängig aus. Der Modelladapterreview führte zudem
  zehn Adaptertests unabhängig aus. Alle drei meldeten danach keine weiteren
  Befunde in ihrem Prüfbereich.

Alle Änderungen sind lokal, uncommitted und ungepusht. Es wurde kein
Produktionsdienst gestartet und keine echte Tippabgabe ausgeführt.

## Sofortiger End-to-End-Test mit echter Tippabgabe

```sh
npm run build
npm run workflow -- --config config/workflow.json --test 1625874559 --submit
```

`--test <fixtureId> --submit` führt für genau das importierte Spiel sofort R1,
R2, die echte Hermes-Prediction und eine **echte Kicktipp-Abgabe mit Read-back**
aus. Codex recherchiert dabei tatsächlich im Web. `--test` erfordert `--submit`;
`--schedule` und `--research-check` dürfen nicht kombiniert werden.

Nur die T-X-Öffnungszeiten entfallen. Der echte Anpfiff, reale Zeitstempel,
Quellenalter, Fixture-Identität, technische Deadlines und der Schreibschutz nach
Anpfiff bleiben wirksam. Vor Modellaufrufen prüft ein authentifizierter Read-only-
Abruf das Spiel und einen vorhandenen Tipp. Vorhandene Tipps werden im Test nicht
überschrieben; diese Prüfung wird vor der Abgabe erneut vorgenommen.

Jeder Lauf speichert seine Artefakte in einem ausgegebenen eigenen Verzeichnis
`/tmp/kicktipp-workflow-test-*`. State und Research tragen `execution: "test"`;
der normale Store lehnt sie ab. Dossiers und konfigurierte Telegram-Nachrichten
sind als Test gekennzeichnet. Der Aufruf führt einen einzelnen Durchlauf aus und
beendet sich mit Fehlerstatus, falls die Abgabe nicht bestätigt wurde. Er startet
keinen Dauerscheduler. Temporäre Artefakte bei Bedarf vor einer Systembereinigung
sichern. Ein abgegebener Tipp bleibt real gespeichert, bis er manuell geändert
oder gelöscht wird.

Verifikation am 07.09.2026: Der reale Testaufruf für Fixture `1625874559`
erreichte die Vorprüfung. Kicktipp leitete auf den Login um
(`authenticationRedirect: true`, keine Match-Tabelle). Deshalb wurden dabei
keine Modelle gestartet, keine Telegram-Nachrichten gesendet und keine Tipps
abgegeben. Der vollständige Live-Nachweis erfordert einen erneuerten Login des
konfigurierten Profils.

Abschlussprüfung des Testmodus: 880 Tests in 60 Dateien bestanden, Build unter
Node 24.15.0 erfolgreich, `git diff --check` ohne Befund. Regressionen prüfen
sofortige Phasen vor T-5h, unveränderte Zeitstempel, Test-/Produktions-Trennung,
Nachrichten-Deduplizierung, Quellenvalidierung, bestehende Tipps und die
Anpfiffprüfung unmittelbar vor dem POST. Der Live-End-to-End-Nachweis bleibt
wegen des oben dokumentierten Login-Redirects offen.

## Diagnose des R1-Providerstarts

Der R1-Abbruch nach wenigen Sekunden wurde am 07.09.2026 mit dem tatsächlichen
Codex-Adapter reproduziert: HTTP 400, `invalid_json_schema`, nicht unterstütztes
`format: "uri"` unter `originals[].url`. Das an Codex gesendete Schema lässt dieses
Format jetzt weg; die Zod-Prüfung aller zurückgegebenen URLs bleibt erhalten.
Siehe die [unterstützten Structured-Outputs-Schemas](https://developers.openai.com/api/docs/guides/structured-outputs#supported-schemas).

Eine zusätzliche Live-Webprobe zeigte einen blockierten Werkzeugaufruf durch
`features.code_mode_host=false`. Research aktiviert jetzt den Code-Mode-Host;
ein tatsächlicher Websuchaufruf wurde danach bestätigt. Der isolierte Aufruf mit
dem korrigierten R1-Ausgabeschema wurde ebenfalls erfolgreich abgeschlossen.
Dies ist kein Nachweis für vollständige R1/R2-Evidenz oder eine echte Tippabgabe.

Prozessfehler behalten bekannte Provider-Codes, Exit-Code und Abbruchsignal.
Research schreibt diese sichere Diagnose in `uncertainties` des JSON-States und
Dossiers. Unbekannte Fehler bleiben generisch; rohe stderr-Ausgaben, Auth-Daten
und private URLs werden nicht gespeichert. Timeout, Abbruch, Ausgabelimit und
ungültige Providerantwort werden unterschieden. Die fehlgeschlagenen ursprünglichen
Artefakte werden nicht nachträglich umgeschrieben.
