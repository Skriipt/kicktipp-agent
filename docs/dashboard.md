# Web dashboard

Build and start from a checkout:

```sh
npm ci
npm run build
npm run dashboard
```

After `npm link`, use `kicktipp dashboard`. The default port is 3210.
`kicktipp dashboard --port 0` chooses a free port. Open the **complete URL**
printed in the terminal, including the fragment after `#`.

The server uses Node's HTTP server and isolated CLI workers. The frontend
uses browser-native controls and CSS. No additional dependency or cloud
account is required.

## First connection

1. Open **Konten** and enter your Kicktipp email and password.
2. Leave the profile name empty for the default account, or name it to create
   a separate profile. Autonomous reminders require a named profile.
3. Choose whether to keep only the session or store the password for renewal.
4. Connect the account, load its communities, then load and select its player.
5. Save the selection. The header identifies the account and community used
   for subsequent actions.

The account selector switches between saved profiles. Each operation runs in
a separate process so simultaneous requests cannot change another request's
account, community, language, or host. A profile selected in the browser
survives a page reload in that tab. CLI `--profile` and `--community` flags
provide the initial selection; `--lang` and `--site` provide process overrides.

## Features

| Dashboard section | CLI functionality |
| --- | --- |
| Übersicht | `today`, `deadline` including urgency checks, `tip-status` |
| Tipps | `bets`, interactive `bet` / `tui` prediction editing, bonus answers, `suggest` with strategy/pins/place/replace, `log` including undo |
| Ranglisten | `leaderboard` including bonus, every `overview` view, `schedule`, home/away `table`, `rules` verification, TUI player tip grid |
| Analysen | `stats` with comparison, `rival`, `scenario` with results/target rank, `whatif` including fixed score strategies |
| Benachrichtigungen | `targets add/list/test/enable/disable/remove`, target editing and assignment, `set-notify`, `notify` with force/preview |
| Automatisierung | `serve`, `service status/health/run-once`, dry runs, `remind` calendar/cron/systemd output and installation |
| Spielleitung | `admin members/bets/bet`, dry runs and confirmed member submissions |
| Wartung | `sync` with range/refresh, `cache status/clear`, online/offline `doctor` |
| Konten | `profiles`, `login` and `login --web` setup flow, `logout`, `communities/set-community`, `players/set-player` |
| Einstellungen | `set-lang`, `set-site`, read-only mode, display timezone, suggestion strategy, warning hours, scoring override |
| Hilfe | `guide`, dashboard usage instructions |

Commander supplies the command and option catalog. Web forms replace
terminal prompts and `--yes` with explicit confirmation. Read results appear
as tables or structured fields with JSON download. CLI diagnostics remain
available as text. Nonzero exit codes display the associated result and
error/urgency status rather than reporting success.

The match editor changes only edited fixtures and identifies locked rows.
Bonus selections come from the actual Kicktipp form. Submissions reuse
`core.ts`, including read-only enforcement and the audit log. Spielleiter
submission first resolves the member and previews the tips, then checks the
confirmed name and ID against a fresh member lookup.

## Notifications and automation

1. Connect a named profile.
2. Under **Automatisierung**, save a disabled reminder job with its actual
   profile, community, language, timezone, and reminder stages.
3. Under **Benachrichtigungen**, add one or more targets and assign them to
   the job. Discord, Telegram, ntfy, and generic webhooks are supported.
4. Test the targets if desired. **Test sends a real notification.**
5. Enable the job and start the service under **Dienst steuern**.

All schema settings are represented: stable job identity, enabled state,
profile/community, language, timezone, stage minutes and severity, excluded
participant IDs, target IDs, and all provider fields. The current policy
selects the next deadline group and requires all games in that group;
these fixed policy values are preserved when editing existing configurations.

Secrets can use `env:NAME`, `file:/absolute/path`, or `local:KEY`.
Entering a raw secret creates a new local reference in the existing secrets
store. The browser never reads saved secret values back. Rotating a secret
through the dashboard creates a new reference, preserving delivery versioning.
Unused local references are retained; editing or deleting a target does not
erase a secret potentially used elsewhere.

The dashboard only stops service processes that it started. An external
service remains visible through status/health; stop it through its process
manager. Closing the browser does not stop the server or service. Ending the
dashboard process requests a graceful service shutdown and allows in-flight
actions time to finish.

Calendar exports download as ICS files. Cron and systemd output can be copied.
systemd installation/removal is available on Linux and has the same behavior
as the CLI: it manages unit files and prints the commands needed to reload
and enable/disable them. Desktop notifications depend on the host platform;
on Windows use a webhook or a supported executable instead.

## Settings and access

Configuration updates reuse the existing file locks. Settings and service
forms carry revisions so another writer's changes cannot be silently lost.
Changed service job IDs are rejected to preserve delivery identity.

Display timezone is stored as `[ui] timezone`; warning hours are stored as
`[notify] warn_hours`. `KICKTIPP_TZ` and `KICKTIPP_WARN_HOURS` take precedence,
as do the existing language, site, read-only, strategy, and notifier overrides.
Process overrides are listed in **Einstellungen**. Config/Data directories
are process-start settings; changing them requires restarting the application.

The dashboard binds to loopback and checks the Host and Origin headers.
API calls require a random access token, sent in an authorization header.
The browser removes the token fragment from the address bar after loading.
No token is placed in cookies or sent to Kicktipp. A restart invalidates it.

For a dashboard running on another computer, keep the listener private and
forward the port:

```sh
ssh -L 3210:127.0.0.1:3210 your-server
# On the server:
kicktipp dashboard --port 3210
```

Open the printed `http://127.0.0.1:3210/#...` link on your local computer.
This is a local account administration tool; there is no public multi-user
hosting mode.

## Verification

`npm test` builds the dashboard and runs API, CLI-catalog, authentication,
profile-isolation, submission, service lifecycle, and conflict tests against
a local Kicktipp-shaped test server. Test accounts never contact Kicktipp or
a real notification provider. Existing parser/provider tests continue to
cover the shared integrations.
