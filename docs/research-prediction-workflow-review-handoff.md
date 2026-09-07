# Historischer technischer Übergabebericht: Research-&-Prediction-Workflow

Stand: 2026-09-07
Branch: `feat/research-prediction-workflow-v2`
Implementierungs-Commit: `5ce3ccf feat(workflow): add versioned fixed R1 and R2 research prompts`

Dieser Bericht beschreibt den ursprünglichen Übergabestand und wurde um die
Review-Korrekturen ergänzt. Aktuelle Verifikation und verbleibende Grenzen:
[Review-Fixes und Abschlussprüfung](research-prediction-workflow-review-fixes.md).
Die Zahlen in Abschnitt 6 sind historische Ergebnisse des damaligen Commits.

Die inzwischen implementierte Live-Verkabelung und ihre ausstehenden Abnahmen
stehen verbindlich in [workflow-live.md](workflow-live.md). Die nachfolgende
Ist-Liste beschreibt den ursprünglichen Commit, nicht die neue Adapter-Komposition.

## 1. Zweck und damaliger Status

Der Workflow trennt Recherche, Prediction und Tippabgabe pro Fixture. Die beiden fachlichen Nutzer-Prompts für Research 1 und Research 2 sind als versionierte Templates eingebaut.

Aktueller Stand:

- Prompt-Templates integriert: **ja**
- R1/R2-Platzhalter-Rendering: **ja**
- Prompt wird an `ResearchProvider.investigate` übergeben: **ja**
- Fixture-spezifisches R1-Dossier wird in R2 eingespeist: **ja**
- Prediction erhält nur das finale Dossier: **ja**
- Live-Codex-Research-Adapter: **noch nicht implementiert**
- Echte Webrecherche nach der Prompt-Integration: **nicht ausgeführt**
- Echte Kicktipp-Schreibaktion: **nicht ausgeführt**
- GitHub-Push: **nicht ausgeführt**

Der Offline-Dry-Run ist eine synthetische Demonstration und keine Produktionsabnahme.

## 2. Workflow-Ablauf

### Fixture-Identität

Jedes Fixture wird durch diese unveränderlichen Daten definiert:

- `profile`
- `community`
- `season`
- `competition`
- `matchday`
- `fixtureId`
- exakter Heimname
- exakter Auswärtsname
- Kickoff als UTC-Epoch-Millisekunde

Der interne Schlüssel ist die vollständige Kombination aus Profil, Community, Saison, Wettbewerb, Spieltag und `fixtureId`. Teamnamen und Kickoff werden beim erneuten Öffnen zusätzlich geprüft.

`fixtureId` wird nicht erzeugt oder normalisiert. Sie muss vom Schedule-Importer stammen. Der aktuelle `get_bets`-Read-Output des Kicktipp-MCP lieferte bisher Teamnamen, Datum und Tippstatus, aber keine explizite interne Match-ID. Das ist vor einer produktiven automatischen Tippabgabe zu klären.

### Zustandsmaschine

```text
scheduled
  -> researched
  -> refreshed
  -> predicted
  -> waiting_for_submission_window
  -> eligible_for_submission
  -> submitted
```

Fehler- und Sicherheitszustände:

- `submission_failed`
- `submission_blocked`
- `kickoff_passed`

Zeitfenster:

- R1: `Kickoff - 5 Stunden`
- R2: `Kickoff - 90 Minuten`
- Submission: ab `Kickoff - 50 Minuten` bis vor Kickoff

Der lokale Scheduler besitzt pro Fixture eine eigene Schleife und schläft bis zum nächsten fälligen Zeitpunkt. Es gibt keinen KI-Aufruf während des Schlafens und keine künstliche Agent-Aktivierung für jede Prüfung.

### Research 1

R1 startet mit dem vollständigen festen R1-Prompt. Der Prompt enthält die konkreten Fixture-Werte und fordert das ausführliche Match-Dossier mit aktueller und historischer Evidenz, Quellen, Unsicherheiten und Qualitätskontrolle.

R1 darf keine Prediction und keinen Tipp erzeugen.

### Research 2

R2 erhält:

- das gleiche konkrete Fixture
- `R1_TIMESTAMP`
- `RESEARCH_TIMESTAMP`
- das bereits vorhandene fixture-spezifische R1-Dossier

R2 ist ausschließlich Delta-Recherche. Es prüft kurzfristige Änderungen, Verfügbarkeit, Breaking News und bestätigte Aufstellungen. Unveränderte R1-Informationen werden nicht erneut vollständig recherchiert.

Wenn offizielle Aufstellungen noch nicht verfügbar sind, muss der Research-Agent dies ausdrücklich als `CONFIRMED LINEUP NOT YET AVAILABLE` ausweisen.

### Prediction

Prediction wird erst nach validiertem R1 und R2 gestartet. Der Predictor erhält nur:

- das finale Markdown-Dossier
- ein Abort-Signal

Er erhält keine Webtools, keine Suchergebnisse, keine andere Fixture und keine gemeinsame Research-Session. Die Ausgabe wird schema-validiert, auf Fixture-Identität geprüft und muss auf Quellen aus dem Dossier verweisen.

### Submission

Submission bleibt eine separate, einzeln getaktete Operation. Vor dem Schreiben werden Zeitfenster, Research, Prediction und Fixture-Identität erneut geprüft. Nach einem unklaren Schreibausgang erfolgt ausschließlich Read-back; es gibt keinen automatischen Schreib-Retry.

## 3. Prompt-Integration

### Datei

`src/workflow/prompts.ts`

Exports:

- `RESEARCH_PROMPT_VERSION`
- `R1_PROMPT_TEMPLATE_V1`
- `R2_PROMPT_TEMPLATE_V1`
- `renderResearchPrompt(fixture, phase, options)`

Die Templates enthalten die feste deutsche Nutzerfassung. Änderungen an der fachlichen Formulierung sollen eine neue Prompt-Version erhalten.

### Platzhalter

Gemeinsam:

```text
{{HOME_TEAM}}
{{AWAY_TEAM}}
{{COMPETITION}}
{{SEASON}}
{{DATE}}
{{KICKOFF}}
{{TIMEZONE}}
{{FIXTURE_ID}}
{{RESEARCH_TIMESTAMP}}
{{RESEARCH_PHASE}}
```

Zusätzlich in R2:

```text
{{MATCHDAY}}
{{R1_TIMESTAMP}}
{{MATCH_DOSSIER}}
```

`DATE` und `KICKOFF` werden in `Europe/Berlin` formatiert. Research-Zeitstempel werden als eindeutige UTC-ISO-Zeit eingesetzt. Teamnamen, IDs, Unicode, führende Nullen und Dollarzeichen werden literal erhalten.

Der Renderer:

- validiert das Fixture mit `fixtureSchema`
- ersetzt alle Platzhalter in einem Durchlauf
- verwirft unbekannte oder verbleibende Platzhalter
- verwirft Platzhalter-Syntax in Fixture-Metadaten; übernimmt Doppelklammern in JSON-kodierten Dossierdaten literal und ohne erneute Expansion
- validiert für R2 das R1-Schema, Originalevidenz und vollständige Fixture-Identität einschließlich Teamnamen und Anstoßzeit
- setzt das R1-Dossier als JSON-kodierte Daten innerhalb von Markierungen ein
- kennzeichnet Dossiertext als nicht vertrauenswürdige Daten; die technische Durchsetzung von Fixture- und Tool-Grenzen bleibt Aufgabe des isolierten Runners

Das gerenderte Prompt wird nicht persistiert. Es werden keine Credentials, Cookies oder Secrets in den Prompt übernommen.

### Übergabe an den Provider

`src/workflow/research.ts` erweitert `ResearchProvider.investigate` um:

```ts
input.prompt: string
```

Die Übergabe erfolgt in `research()` nach dem Rendering und vor den Provider-Aufrufen. R2 erhält zusätzlich das R1-Objekt und baut daraus die Baseline.

Wichtig: Die bestehende Provider-Abstraktion reicht das Prompt nur weiter. Sie führt selbst keinen Codex-Prozess aus.

## 4. Relevante Dateien

### Kernmodell und Persistenz

- `src/workflow/model.ts`
  - Fixture-Schema und Fixture-Key
  - Zeitfenster
  - Zustände
  - Research-, Evidence- und Prediction-Schemas
  - Coverage und Markdown-Dossierprojektion
- `src/workflow/store.ts`
  - persistenter Workflow-Store
  - atomare JSON-Schreibvorgänge
  - Markdown-Projektion
  - Fixture-Locks und Wiederanlauf

### Research und Ausführung

- `src/workflow/prompts.ts`
  - feste R1-/R2-Prompt-Templates
  - Platzhalter-Renderer
  - R2-Baseline-Framing
- `src/workflow/research.ts`
  - Provider-Schnittstelle
  - per-Request-Timeout
  - Phasen-Deadline
  - Abort-Verhalten
  - Fortschritts-/Wiederholungserkennung
  - Checkpoints
  - Evidence Gate
  - partielle Evidenz und Unsicherheiten
- `src/workflow/engine.ts`
  - Scheduler
  - Zustandsübergänge
  - isolierte Fixture-Loops
  - Research-Retry/Recovery
  - Prediction-Grenze
  - Submission-Fenster
  - Read-back und at-most-once-Schreibschutz
- `src/workflow/firecrawl.ts`
  - optionaler, streng bewachter Firecrawl-Adapter aus der vorherigen Provider-Richtung
  - nicht als Codex-Adapter verwenden
  - prüfen, ob er im Rahmen der Umstellung auf Codex entfernt oder bewusst als ungenutzte optionale Altintegration behalten werden soll
- `src/workflow/demo.ts`
  - synthetischer Offline-Provider
  - synthetischer Predictor
  - synthetischer Submission-Adapter
  - keine Netzwerk- oder Kicktipp-Aktion

### Tests

- `tests/workflow.test.ts`
  - Scheduler und Zeitfenster
  - R1/R2-Ausführung
  - Fixture-Isolation
  - Provider-Hänger
  - Checkpoint/Recovery
  - partielle Evidenz
  - Prediction- und Submission-Sicherheitsgrenzen
- `tests/workflow-prompts.test.ts`
  - Template-Version und SHA-Checksums
  - vollständige Platzhalter-Ersetzung
  - wörtliche Werterhaltung
  - Zeitzonen-/DST-Fälle
  - R2-Dossier-Baseline
  - Fail-closed bei Fremd-/Future-/unvollständigem R1
  - keine Provider-Aufrufe bei ungültigem Prompt

### Dokumentation und Projektbefehle

- `docs/research-prediction-workflow.md`
  - vollständiger Workflow-Vertrag
  - Persistenz und Locks
  - ResearchProvider-Vertrag
  - Evidence Gate
  - Prompt-Integration
  - Providergrenzen und Sicherheitsregeln
- `package.json`
  - `npm test`
  - `npm run build`
  - `npm run workflow:demo`

Build-Artefakte werden in `dist/` erzeugt. Der Offline-Demo-Store liegt unter `data/workflow-demo/` innerhalb des Checkouts und ist synthetisch.

## 5. Technische Schutzmechanismen

- Kein standardmäßiges Such- oder Retrieval-Zähl-Limit.
- Optionales `maxCalls` ist nur ein expliziter Betreiber-Schutz und keine Vollständigkeitsbedingung.
- Identische Query-/Ergebnis- oder URL-/Original-Wiederholungen werden als fehlender Fortschritt erkannt.
- Unterschiedliche neue Queries und Quellen bleiben möglich.
- Jede Fixture besitzt eigenen State-, Abort-, Deadline- und Provider-Kontext.
- Eine hängende Fixture blockiert nicht die anderen Fixtures.
- Pro Retrieval gilt standardmäßig ein zweiminütiger Timeout.
- Pro Research-Phase gilt standardmäßig eine technische 30-Minuten-Deadline.
- Checkpoints werden nach akzeptierten Originalen und Findings geschrieben. Frühere Ablehnungen bleiben als Historie erhalten, sperren aber einen korrigierten Folgeversuch nicht dauerhaft.
- Fehlende optionale Evidenz wird als Coverage-Lücke/Unsicherheit gespeichert, nicht als künstlich erfüllte Tatsache.
- Falsche Fixture-Identität, fremde Teams, falsche Saison/Wettbewerb, fehlende Originalquelle, fehlendes Zitat, Zukunftsdaten und stale Current-State-Evidenz werden abgelehnt.
- Prediction erhält keinen Webzugriff.
- Submission ist zeitfenstergebunden, einzeln und at-most-once; ein Stoppsignal verhindert neue Schreibversuche, bereits begonnene werden weiterhin per Read-back geklärt.
- Unklarer Submission-Ausgang führt zu Read-back statt erneutem Schreiben.

## 6. Verifikation dieses Commits

Unabhängig ausgeführt:

```text
npm test
Test Files: 56 passed (56)
Tests:      782 passed (782)
Duration:   94.02s

npm run build
Erfolgreich

npm run workflow:demo
State: submitted
```

Zusätzlich geprüft:

- `git diff --check HEAD^ HEAD`: erfolgreich
- Arbeitsbaum nach dem Implementierungs-Commit: sauber
- Build-Dateien für `prompts`, `research` und `engine`: vorhanden
- Codex-Implementierungsprozess: beendet, kein Prozess zurückgeblieben
- keine Live-Recherche
- keine Kicktipp-Schreibaktion
- kein Push

Bekannte Umgebungsmeldung: npm meldet, dass die installierte npm-Version Node `26.8.0-alpha` nicht offiziell unterstützt. Die Tests und der Build liefen trotzdem erfolgreich; ein unabhängiger Reviewer sollte die Runtime-Version als Umgebungsrisiko berücksichtigen.

## 7. Offene Review-Punkte für einen unabhängigen Worker

1. **Live-Codex-Adapter prüfen:** Wird `input.prompt` tatsächlich an einen separaten Codex-Prozess mit `--search`, Modell `gpt-5.6-luna` und maximal unterstütztem Reasoning (`xhigh`) übergeben?
2. **Adapter-Ausgabe prüfen:** Übersetzt der Live-Adapter den Markdown-Bericht korrekt in originalquellenbasierte `{ findings, uncertainties }`, statt Markdown ungeprüft als Evidenz zu übernehmen?
3. **Provider-Auswahl prüfen:** Ist Firecrawl vollständig aus dem aktiven Pfad entfernt, oder existiert noch eine unbeabsichtigte Fallback-/Providerroute?
4. **Fixture-ID prüfen:** Liefert der Kicktipp-Schedule-Importer eine echte Kicktipp-interne Match-ID und wird sie vor Prediction/Submission gegen Teamnamen und Kickoff geprüft?
5. **R2-Baseline prüfen:** Erhält R2 ausschließlich das R1-Dossier desselben Fixtures und keine Prediction oder fremde Quellen?
6. **Prompt-Wortlaut prüfen:** Stimmen die versionierten Templates exakt mit der freigegebenen Nutzerfassung überein? Insbesondere die zusätzlichen Daten-/Output-Abschnitte und der `MATCHDAY`-Platzhalter in R2 sollten bewusst bestätigt werden.
7. **Zeitfenster prüfen:** Kann ein 18-minütiger R1-Lauf bei realem Kickoff noch sauber abgeschlossen werden, ohne R2 oder Submission fälschlich zu blockieren?
8. **Prozessisolierung prüfen:** Besitzt jeder Live-Codex-Lauf eigene Session-/Arbeits-/Logpfade und eine Prozessgruppen-Notbremse?
9. **Secret-Sicherheit prüfen:** Werden Codex-/Hermes-Konfiguration, Cookies, API-Schlüssel und private URLs niemals in Prompt, Report, Logs oder Fehlertext übernommen?
10. **E2E-Dry-Run prüfen:** Einen echten Research-only-Lauf für genau ein Fixture ausführen; keine Prediction und keine Submission. Prozessende, Report, Quellen, Fixture-Identität und fehlende Leaks unabhängig verifizieren.

## 8. Empfohlene Review-Befehle

```bash
cd /home/ubuntu/kicktipp-agent-dev-web-dashboard-2026-09-05
git status --short --branch
git show --stat --oneline 5ce3ccf
npm test
npm run build
npm run workflow:demo
```

Für den Review soll der Worker insbesondere `src/workflow/prompts.ts`, `src/workflow/research.ts`, `src/workflow/engine.ts`, `src/workflow/model.ts`, `src/workflow/store.ts`, beide Workflow-Testdateien und `docs/research-prediction-workflow.md` gemeinsam lesen.
