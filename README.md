# kicktipp-agent

A CLI and MCP server for [kicktipp.com](https://www.kicktipp.com) — the German football prediction game. View leaderboards, schedules, league tables, and place bets from the terminal or let an AI agent do it for you.

## Why?

Kicktipp has no public API. Everything goes through the website. This project gives you two ways to skip the browser:

- **CLI** — Check scores, standings, and place bets in seconds from the terminal. No clicking through pages, no waiting for ads to load. Useful for quick lookups during matchday or scripting your predictions.

- **MCP Server** — Connect an AI assistant (Claude Desktop, Claude Code, or any MCP client) to your kicktipp account. Ask it to show today's matches, check who's leading your league, or place bets for you — all through natural conversation. The assistant sees your community's data but never your password.

No browser required. Kicktipp's pages are server-rendered, so this talks to
them over plain HTTP — nothing to download, nothing to keep running. Session
caching keeps it fast: after the first login, subsequent commands reuse the
saved session and skip the login flow entirely.

## Installation

Requires Node.js 20 or newer.

Once the package is on npm:

```bash
npm install -g kicktipp-agent
# or, without a global install:
npx -y -p kicktipp-agent kicktipp
```

From a checkout:

```bash
npm install
npm run build
npm link
```

This gives you:

- **`kicktipp`** — the CLI
- **`kicktipp-mcp`** / **`kicktipp-agent-mcp`** — the MCP server (same binary)

## CLI

### First-time setup

```bash
kicktipp login --web
```

That prints a `http://127.0.0.1:…/setup?token=…` link (and opens it on macOS/Linux). Email and password go into that page, not into the terminal. After a successful Kicktipp login you pick a community. Credentials land in `~/.config/kicktipp-agent/config.ini` with mode 600.

`kicktipp login` without `--web` still prompts in the terminal, same as `set-community` on a first run.

Optionally set your player name so the leaderboard highlights your position:

```console
$ kicktipp set-player
```

### Commands

| Command | Description |
|---------|-------------|
| `login` | Connect an account (`--web` opens a localhost page) |
| `logout` | Remove stored credentials and session |
| `communities` | List all communities you belong to |
| `set-community` | Select a default community |
| `players` | List players in the saved community |
| `set-player` | Select which player you are |
| `set-notify` | Configure the `notify` backend (desktop, webhook, or command) |
| `leaderboard` | Show the matchday leaderboard |
| `overview` | Show the season overview |
| `schedule` | Show the match schedule |
| `table` | Show the league table |
| `bets` | Show your bets for a matchday |
| `bet` | Place bets (interactive, by fixture, or bonus) |
| `today` | Show today's matches and which still need bets |
| `rules` | Show the game rules |
| `guide` | Print a detailed usage guide (useful for LLM agents) |
| `sync` | Download this season into the local cache |
| `cache status` / `cache clear` | Inspect or delete the cache |
| `stats` | Season analytics for you or another player |
| `rival` | What it would take to overtake another player |
| `suggest` | Bet slip suggested from the published odds |
| `scenario` | Project the leaderboard under hypothetical results |
| `whatif` | Replay the season under a different strategy |
| `deadline` | Time to kickoff and what still needs a bet |
| `remind` / `notify` | Reminder artifacts and notifications |
| `log` | What this agent submitted, and undo |
| `profiles` | List configured profiles |
| `admin` | Spielleiter tools (members, bets for a member) |

### Placing bets

```bash
# Interactive — prompts for each match
kicktipp bet

# By fixture name (get exact names from `kicktipp bets`)
kicktipp bet "FC Bayern München vs Borussia Dortmund=2:1"
kicktipp bet "RB Leipzig vs Bayer 04 Leverkusen=0:0" --matchday 5

# Bonus questions — interactive
kicktipp bet --bonus

# Bonus questions — by name
kicktipp bet --bonus "Who will win the league?=FC Bayern München"
```

### Options

- `--matchday <n>` — Target a specific matchday (1-34)
- `--bonus` — Bonus question rankings (with `leaderboard`) or bonus bets (with `bet`)
- `--view <value>` — Overview type (with `overview`)
- `--home` / `--away` — Home/away filter (with `table`)

### Analytics

Once a season is cached locally, the agent can answer questions Kicktipp
itself does not:

```bash
kicktipp sync                      # download this season into a local cache
kicktipp stats                     # your form, hit types, biases, consistency
kicktipp stats --player Papa       # or somebody else's
kicktipp rival Papa                # what has to happen for you to overtake them
kicktipp suggest --strategy ev     # a bet slip built from the published odds
```

`sync` walks the season once, pacing its requests, and skips matchdays it has
already stored, so later runs only fetch what is new. Everything downstream of
it reads the cache: `stats` needs no network at all, and `rival`/`suggest`
accept `--offline` to work the same way.

**stats** reports points per matchday against the league average, rank history,
how your hits break down (exact result / goal difference / tendency / miss),
how your predictions compare with what actually happened, and how consistent
you are. It always states how many matchdays the numbers rest on.

**rival** shows the points gap, how much each remaining match can still swing
it, and what would have to happen for you to pass someone. Kicktipp hides other
players' bets until the deadline passes, so before kickoff the answer is given
as best/worst bounds and labelled as such.

**suggest** converts the odds Kicktipp already prints into probabilities and
proposes a full slip, explaining every pick. Three strategies: `safe` backs the
likeliest outcome, `ev` maximises expected points under your community's own
scoring rules, and `contrarian` fades the favourite in close matches (high
variance on purpose). It prints and stops — submitting needs `--place`, which
asks first, and matches that already have a bet are left alone unless you pass
`--replace`.

This is odds arithmetic, not prediction magic: the numbers come from the
bookmaker's own prices, and no external data source or API key is involved.

The cache lives in your platform's data directory (`~/.local/share/kicktipp-agent`
on Linux) and can be inspected with `kicktipp cache status` or removed with
`kicktipp cache clear`.


### Deadlines and reminders

```bash
kicktipp deadline                  # countdown and what still needs a bet
kicktipp deadline --check          # exits 2 when something is due soon
kicktipp remind --print cron       # a crontab line built on that exit code
kicktipp remind --print systemd    # or user units; --install writes them
kicktipp remind --ics season.ics   # a calendar with an alarm per kickoff
kicktipp notify                    # notify now, if anything is urgent
```

The predict page in a browser shows kickoff times in *your* timezone.
Kicktipp's HTML does not: `.com` prints US Central (`8/28/26 1:30 PM`) and
`.de` prints Berlin (`28.08.26 20:30`) — the same instant, rewritten by
JavaScript on the page. The CLI reads the HTML, then shows the time in this
machine's zone (or `KICKTIPP_TZ` if you set one). Later rows that share a
kickoff have a blank date cell; that value is carried forward from the row
above.

A match is urgent when it still needs a bet and kickoff is within **6 hours**
(`--warn-hours`, or `KICKTIPP_WARN_HOURS`). Kicktipp closes betting at each
match's own kickoff, not at a matchday-wide deadline.

Notifications go through one backend, configured with `kicktipp set-notify`
(or the MCP `set_notify` tool). That writes `[notify]` in
`~/.config/kicktipp-agent/config.ini`:

```bash
kicktipp set-notify                  # picker
kicktipp set-notify desktop
kicktipp set-notify webhook https://ntfy.sh/your-topic
kicktipp set-notify command /usr/local/bin/my-hook
```

`desktop` is macOS Notification Center (or `notify-send` on Linux). `webhook`
POSTs JSON to the URL. `command` runs that program with the summary as an
argument and the deadline report on stdin. `KICKTIPP_NOTIFY_KIND` and
`KICKTIPP_NOTIFY_TARGET` override the file if set. There is no default
webhook endpoint — a URL only ever goes where you named it.

### Scenarios, replays and the bet log

```bash
kicktipp scenario "Bayern vs BVB=2:1"     # project the table
kicktipp scenario --target 1              # what would put you first
kicktipp whatif "2:1"                     # replay the season on a fixed bet
kicktipp whatif suggest:ev
kicktipp log                              # what the agent submitted
kicktipp log --undo                       # put the previous bets back
```

Every submission — CLI, TUI, suggestion or MCP — is appended to a local
JSONL log with the bet it replaced, which is what makes `--undo` possible and
what lets you audit an assistant after the fact.

### Multiple pools and accounts

```bash
kicktipp -c other-pool schedule     # one-off, without changing the default
kicktipp -p work stats              # a separate account and session
kicktipp profiles
```

A profile is a `[profile.<name>]` section with its own account, community and
player. Configs without profiles keep working exactly as before.

### Spielleiter tools

If you run a community, `kicktipp admin members`, `admin bets <member>` and
`admin bet <member> "Home vs Away=H:G"` fill in bets for members who have no
login of their own. Placing for someone else asks you to type their name back
first, and refuses outright if the page would not carry their id.

### Scoring rules

Features that count points read your community's rules page to learn what an
exact result, a goal difference and a tendency are worth, and whether any
matchday counts double. If that page cannot be parsed, Kicktipp's 4/3/2
defaults are assumed and every affected output says so. You can also set the
values explicitly:

```ini
[scoring]
exact = 4
diff = 3
tendency = 2
```

To find out whether the values are actually right:

```bash
kicktipp rules --verify        # recompute a finished matchday and compare
```

This recomputes every player's score for a finished matchday and checks it
against the numbers Kicktipp itself reported — the only real proof the model
matches the community. It exits 1 on a mismatch.

## MCP server

Claude (or any MCP client) does not talk to Kicktipp itself. It starts a small Node program on your computer. That program logs into kicktipp.com and exposes tools. The assistant sees pool data. It never sees your password.

The `.mcpb` file you can double-click is that program, zipped, with a recipe for Claude Desktop. It is not a remote server.

Pick **one** Desktop path. Running the bundle and a manual config at the same time starts two copies.

### Sign in

Any of these writes `~/.config/kicktipp-agent/config.ini` (mode 600) and a session cookie. You only need one.

```bash
kicktipp login --web
```

Or, in a chat with the assistant already connected, ask it to set up Kicktipp. It should call `connect_account` and give you a `http://127.0.0.1:…/setup?token=…` link. Open that, sign in, pick a community. Do not paste the password into the chat.

`get_status` returns the same link when nothing is saved yet. So does any tool that needs a login.

### Claude Desktop, by hand

Settings → Developer → Edit config opens `~/Library/Application Support/Claude/claude_desktop_config.json` on a Mac. Add this under `mcpServers`, then fully quit and reopen Desktop:

```json
"kicktipp": {
  "command": "node",
  "args": [
    "/absolute/path/to/kicktipp-agent/dist/server.js"
  ]
}
```

No `env` block. The program reads `config.ini`. Build first (`npm run build`). After a `git pull` that changes the server, build again or Desktop keeps using the old `dist`.

In a new chat, ask for Kicktipp status.

### Claude Desktop, the bundle

From a checkout:

```bash
npm run pack:mcpb
```

That writes `kicktipp.mcpb` in the repo root. Double-click it (or install it from Desktop). Desktop shows a settings form: email, password, optional community slug, read-only. The password goes in the OS keychain and is passed to the local process as env. Quit and reopen Desktop.

If you already signed in with `kicktipp login --web`, the manual config above is simpler. You can skip the form.

Turn the extension off if you also added the JSON snippet, so only one server runs.

### Claude Code

From this checkout:

```bash
claude mcp add kicktipp -- node /absolute/path/to/kicktipp-agent/dist/server.js
```

When the package is on npm:

```bash
claude mcp add kicktipp -- npx -y -p kicktipp-agent kicktipp-agent-mcp
```

Start a new chat and ask for Kicktipp status, or ask it to connect the account.

### Session-only storage

The setup page has a checkbox to keep the login cookie and drop the password (`store = session` under `[auth]`). A leaked config then has no Kicktipp password, and you can revoke the cookie from kicktipp.com. When Kicktipp expires the session, this tool cannot log in again by itself. Tools return a fresh setup link instead. Opt-in, not the default.

### Environment variables

An `env` block in the client config still works and wins over the file. Use it only when a client cannot use the setup page or Desktop's settings form. The password then sits in that client's config:

```json
{
  "mcpServers": {
    "kicktipp": {
      "command": "node",
      "args": ["/absolute/path/to/kicktipp-agent/dist/server.js"],
      "env": {
        "KICKTIPP_EMAIL": "you@example.com",
        "KICKTIPP_PASSWORD": "yourpassword"
      }
    }
  }
}
```

### Available tools

| Tool | Description |
|------|-------------|
| `get_status` | Check if credentials and community are configured |
| `connect_account` | Open the localhost setup page (for "set up kicktipp" / reconnect) |
| `get_today_matches` | Today's matches with bet status |
| `get_bets` | Matches and current bets for a matchday |
| `get_schedule` | Match schedule with results |
| `get_leaderboard` | Player rankings for a matchday |
| `get_overview` | Season overview across all matchdays |
| `get_table` | League table (actual football standings) |
| `get_rules` | Game rules and scoring system |
| `get_communities` | List communities the user belongs to |
| `get_players` | List players in the community |
| `get_bonus_questions` | Bonus questions with options |
| `set_community` | Set the active community |
| `set_player` | Set which player you are |
| `place_bets` | Place match bets by fixture name |
| `place_bonus_bets` | Place bonus question answers |
| `sync_history` | Fill the local cache so the analytics tools have data |
| `get_stats` | Season analytics for a player |
| `get_rival_analysis` | Gap, swing and overtake conditions vs. another player |
| `suggest_bets` | Suggested bet slip from the odds (read-only, never submits) |
| `get_deadline` | Countdown and which matches still need a bet |
| `get_standings_scenarios` | Project the table under hypothetical results |
| `whatif` | Replay the season under a different strategy |
| `get_bet_log` | What this agent submitted, from the record |
| `list_members` / `get_bets_for_member` / `place_bets_for_member` | Spielleiter tools |

### Read-only mode

For a connection that provably cannot bet, check read-only on the setup page, set `read_only = true` under `[server]`, or set `KICKTIPP_READ_ONLY=1` in an `env` block. Betting and settings tools are then never registered, so they do not appear in the tool list at all, and the submitting functions refuse independently. This is the recommended way to try the MCP server for the first time.

### Choosing the Kicktipp host

By default everything runs against `https://www.kicktipp.com`. Set
`KICKTIPP_BASE_URL=https://www.kicktipp.de` to use the German site and its
German page names instead. You rarely need to: when a page is missing under
one host or spelling, the same page is retried under the other automatically,
so communities that only exist on one of the two still work either way.

## Development

```bash
npm test          # run tests
npm run build     # compile TypeScript
npm run pack:mcpb # zip dist + production deps into kicktipp.mcpb
```

## Credits

Originally forked from [schwalle/kicktipp-betbot](https://github.com/schwalle/kicktipp-betbot) by Stefan. The project has since been fully rewritten in TypeScript with a new CLI interface, MCP server, and Cheerio-based parsing.
