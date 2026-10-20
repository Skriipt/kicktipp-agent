# Home Assistant HTTP backend

This backend reuses the agent's scoped client, Kicktipp parsers, form/CSRF
handling, read-only guard, and submission audit. It provides no dashboard,
automatic tipping, account setup, generic command execution, or admin actions.
Every request requires a bearer token, including health checks.

## Account isolation

`KICKTIPP_PROFILE` is **required**. The HTTP entry point locks that exact profile
for its process and refuses a conflicting `KICKTIPP_PROFILE_LOCK`. There is no
default account. Profile, community, player, credentials, session paths, and
admin/member IDs cannot be selected through HTTP. Community comes only from
the named profile, captured at startup. Restart this backend after intentionally
changing its profile's community.

Each operation owns an independent authenticated page. Reads may run in
parallel, with at most one auth refresh retry. Writes are serialized within the
backend, use fresh pages, and are **never retried**. Profile-specific session
refresh locks and atomic cookie writes are reused. Run one HA backend per
account/config volume; multiple replicas are unnecessary and their independent
write queues would not serialize submissions across replicas.

`KICKTIPP_PROFILE_LOCK=<profile-name>` is also optional for existing CLI/MCP
entry points. It overrides interactive selection, ignores `KICKTIPP_EMAIL`,
`KICKTIPP_PASSWORD`, community/player overrides and classic account fallbacks,
and refuses other explicit profile clients. Reconnect/setup, credential
replacement, logout, and admin member actions are disabled. MCP hides those
tools; core/config guards enforce the same restriction. Without the lock,
existing multi-profile selection remains available. MCP tool operations are
serialized so a profile switch cannot close or redirect another running tool's
page. Process environment and disk configuration remain trusted operator inputs.

An existing ChatGPT/MCP container keeps its current account and automations.
The HA deployment below does not modify it. To lock an existing MCP instance
later, add `KICKTIPP_PROFILE_LOCK` matching **its own** `KICKTIPP_PROFILE` in that
instance's deployment during a separately planned maintenance window. Merely
setting `KICKTIPP_PROFILE` selects an account; it does not disable MCP switching.

## Prepare the separate Docker host

Use `compose.ha.yaml` as a separate Compose project. Do not merge it into the
existing MCP/Reminder Compose file, run its `up` command, or reuse its project
name. The new project is `kicktipp-ha`; it defines only `ha-api`, references an
existing config volume, and creates separate HA audit data. No changes to the
original `compose.yaml` are needed.

1. Check out the feature branch on the Docker host and create local settings:

   ```bash
   cp deploy/ha.env.example .env.ha
   # Fill the required fields in this ignored local file as described below.
   ```

2. Set `KICKTIPP_PROFILE` in `.env.ha` to the exact existing account intended for
   HA. Set `KICKTIPP_AUTH_CONFIG_VOLUME` to its existing named config volume,
   or preferably a dedicated copy containing only the intended profile and its
   session. The template never creates or replaces that external volume. The
   profile must have its own `community` in `config.ini`; there is no fallback.
   Do not populate the example file in Git with real account or host values.

3. Check credential identity **before starting**. Password encryption uses
   `SHA-256("kicktipp-agent:" + os.hostname() + ":" + os.userInfo().username)`
   as its AES-256-GCM key. Copying encrypted `config.ini` to a randomly named
   container does not suffice. Obtain the source identity and mount names
   without printing credentials (replace the container placeholder locally):

   ```bash
   docker inspect EXISTING_MCP_CONTAINER --format \
     'hostname={{.Config.Hostname}} user={{.Config.User}}'
   docker inspect EXISTING_MCP_CONTAINER --format \
     '{{range .Mounts}}{{println .Name .Destination}}{{end}}'
   docker exec EXISTING_MCP_CONTAINER id -un
   ```

   Set `KICKTIPP_AUTH_HOSTNAME` to that source hostname. The template deliberately
   uses `user: node`; this must match the username that saved the password.
   Reusing a hostname here only supplies key material; the container/project
   names, data volume, and lifecycle remain separate.

4. Create a fresh API secret on the Docker host. The image runs as UID 1000
   (`node`), which needs read access to this file and write access to its config
   directory for session refresh/lock files. The API never changes credentials
   or community config. Keep the secret file out of Git and the image:

   ```bash
   install -d -m 700 secrets
   (umask 077; openssl rand -hex 32 > secrets/ha-api-token)
   # If your host user is not UID 1000, grant only the container user access:
   sudo chown 1000:1000 secrets/ha-api-token
   sudo chmod 600 secrets/ha-api-token
   ```

   Make a backup of config before provisioning. When sharing an existing volume,
   the API reads its existing profile and writes only that profile's cookie/lock
   files. A separate copy containing only the HA account further limits file
   access and avoids concurrent operator edits to a shared config.

5. Verify decryption locally in a one-off container. This does not log in,
   make network requests, or print the password. A session-only profile reports
   its stored cookie's presence, not whether Kicktipp still accepts it:

   ```bash
   docker compose --env-file .env.ha -f compose.ha.yaml config --quiet
   docker compose --env-file .env.ha -f compose.ha.yaml build
   docker compose --env-file .env.ha -f compose.ha.yaml run --rm --no-deps \
     --entrypoint node ha-api --input-type=module --eval '
       import fs from "node:fs";
       const c = await import("./dist/config.js");
       try {
         const profile = process.env.KICKTIPP_PROFILE;
         if (c.isProfileSessionOnly(profile)) {
           if (!fs.existsSync(c.sessionFile(profile))) throw new Error();
           console.log("Stored session found; live validity is unverified.");
         } else {
           await c.loadProfileCredentials(profile);
           console.log("Profile credentials decrypt under this identity.");
         }
       } catch {
         console.error("Auth check failed; verify the source hostname/user or reconnect safely.");
         process.exitCode = 1;
       }
     '
   ```

   Runtime startup repeats this credential check and fails before listening if it cannot decrypt the profile.

6. If the original identity is unknown or cannot be reused, reconnect **only
   the HA profile** in a dedicated config volume. Do not rewrite a shared config
   containing encrypted passwords for other users under a different identity.
   Run the existing CLI's terminal login with the intended stable hostname/user,
   `KICKTIPP_PROFILE` set, no `KICKTIPP_PROFILE_LOCK`, and no environment email or
   password overrides. Keep credentials out of arguments, environment variables,
   logs, and chat. For example, with a dedicated volume:

   ```bash
   docker run --rm -it --hostname YOUR_STABLE_AUTH_HOSTNAME \
     --env KICKTIPP_PROFILE=YOUR_HA_PROFILE \
     --mount type=volume,source=YOUR_DEDICATED_CONFIG_VOLUME,target=/config \
     kicktipp-agent:ha-api kicktipp login
   ```

   This existing interactive command stores the selected profile and asks for
   its community; it submits no predictions. If a session-only profile has
   expired, provision a fresh dedicated config volume with the terminal
   login command above first. Do not bypass the HTTP server's lock to reconnect.

## Start, verify, and remove only the HA backend

The default published port is `127.0.0.1:8787`. To reach it from a separate HA
host, set `KICKTIPP_HA_BIND_ADDRESS` to a **specific private LAN address** and
restrict ingress to the HA host with host/network firewall rules. Do not set a
public address or forward this port from the internet. `0.0.0.0` inside the
container is needed for Docker forwarding; the host bind controls exposure.
Bearer authentication is mandatory on both loopback and LAN. HTTP does not
encrypt the token: use a trusted local network or a TLS reverse proxy, keeping
the upstream port restricted. No browser CORS access is enabled.

```bash
docker compose --env-file .env.ha -f compose.ha.yaml up -d --no-deps ha-api
docker compose --env-file .env.ha -f compose.ha.yaml ps
docker compose --env-file .env.ha -f compose.ha.yaml logs --tail 50 ha-api
```

The authenticated local healthcheck contacts only `/v1/health`, never Kicktipp.
Verify `/v1/status`, then `/v1/bets` from the HA backend using its bearer secret.
Use a dry run for a slip to prove parsing; do not make a real submission as a
deployment test. Keep `KICKTIPP_READ_ONLY=1` until manual submission is wanted.
To permit manual submissions, set it to `0` and recreate **only `ha-api`** with
the above `up` command. Existing MCP containers remain untouched.

For rollback/removal:

```bash
docker compose --env-file .env.ha -f compose.ha.yaml down
```

Do not add `--volumes`; retain the HA audit data. The external config volume is
never removed by this project. This command does not stop another Compose
project's containers. To roll back code, build the previously reviewed revision
and run the same HA-only `up` command.

## HTTP contract

Send `Authorization: Bearer <secret>` on every request. Use `Content-Type:
application/json` for POST. The API never accepts tokens in query parameters.

- `GET /v1/health`: local process health, profile, community; no upstream call.
- `GET /v1/status`: profile, community, `read_only`, `credentials_saved`,
  `session_only`; no credentials and no upstream call.
- `GET /v1/bets?matchday=4`: own fixture names, saved bets and odds from the
  existing agent parser, under `data`. Omit matchday for Kicktipp's current one.
- `GET /v1/tip-status?matchday=4`: community tip-completeness data under `data`
  from the existing read logic; no admin access.
- `POST /v1/bets`: manual regular match bets only. Unknown body fields and
  query parameters are rejected. Matchday must be an integer from 1 to 99;
  one request supports up to 100 fixture strings, at most 16 KiB total.

A preview request (default `dry_run=true`) is:

```json
{"bets":["Home Team vs Away Team=2:1"],"matchday":4,"dry_run":true}
```

Only after a deliberate human action may the caller send the same slip with
`"dry_run":false,"confirm":true`. The flag records caller intent; the backend
does not authenticate a separate human or run automatic tipping. The token
holder can submit once the operator enables writes. Successful responses include
`profile`, `community`, `dry_run`, and `placed`. Dry runs do not submit to
Kicktipp, but do append a local preview audit record. Match submissions use the
audit source `ha:place_bets` in the separate HA data volume.

Errors contain only a safe `error` code: 401 for missing/invalid bearer auth,
403 for read-only/policy/browser-origin rejection, 400 for invalid input or
missing confirmation, 413/415 for body size/type, 404/405 for unsupported routes
or methods, and 502 for upstream failure. A failed write returns
`submission_unknown`: it **may already have reached Kicktipp**. Never retry it
automatically; read back `/v1/bets` and reconcile with the requested slip first.
An HTTP success reflects the existing form submission path, not an independent
verification that Kicktipp persisted every value; read back before displaying a
verified saved state. Health alone does not prove a stored session is valid.

## Tests

```bash
npm ci
npm run build
npm test
npm run test:docker:ha
```

HTTP and profile tests use temporary config/data and a fake Kicktipp transport.
The Docker smoke uses fake encrypted credentials, an isolated network, and no
published host ports. It checks the Compose isolation contract, authentication,
credential identity mismatch, non-root execution, and graceful shutdown. It
does not use real accounts or submit real predictions.

## Complete dashboard data

The dashboard extension adds three authenticated, fixed-profile routes:

- `GET /v1/overview[?matchday=N]`: full source-ordered ranking, stable participant
  IDs, all source columns, match context, rank changes, individual predictions
  and awarded points, matchday/bonus/wins/total values. Empty, unpublished,
  hidden and explicitly failed predictions remain different states. A source
  `f` classification means zero awarded points; other missing points are null.
- `GET /v1/form[?matchday=N]`: actual selected season and matchday, stable form
  field IDs, existing own predictions, printed deadline converted to UTC from
  its source time zone, and real editable-input availability.
- `POST /v1/submissions`: strict `{season,matchday,edits,dry_run,confirm}` body.
  Each edit is `{id,home,away,previous}`; `previous` is the loaded prediction or
  null. Requires the explicit form context, checks current editability/deadline
  and unchanged prior values, serializes with existing writes, then uses the
  existing submission/audit path. No extra model is involved. An actual write
  requires `dry_run:false,confirm:true`; a preview uses `dry_run:true`.

A submission returns `outcome: preview|verified|not_verified|submission_unknown`.
Only values independently read back from the same season/matchday are verified.
An upstream write failure is never retried, even when its readback fails too.
Partial matches are reported individually in `verification`; returned `form`
contains the real saved values. HTTP 409 indicates stale or uneditable input.

The overview and form defaults are resolved independently from Kicktipp's
selected form/navigation metadata, never a fixed day, season length or calendar
calculation. Multiple callers share per-key in-flight requests and a 45-second
cache for form/live standings, 180 seconds for other standings. Writes invalidate
that cache. Failures are not cached and do not manufacture empty success payloads.

Expose these routes only through a HA-authenticated server-side bridge. Store
its token and expected profile in private local configuration; never send the
upstream token to a Lovelace card. The bridge must verify `/v1/status` against its
configured profile before a write. All integration tests use fake transport.
