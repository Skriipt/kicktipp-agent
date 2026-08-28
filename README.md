# kicktipp-agent

A helper for [Kicktipp](https://www.kicktipp.com) on both **kicktipp.com** and **kicktipp.de**. Check the table, fill the terminal tip sheet, or let Claude do it in a chat. Your password stays on your computer.

Kicktipp has no public API. This talks to the website from your machine. You do not need to know how that works.

## Start here

Pick one path. Skip the rest.

You need [Node.js 20](https://nodejs.org/) or newer on every path. On the site, press the LTS button, run the installer, leave the defaults, finish. Then open Terminal (or Command Prompt on Windows) and type `node -v`. You want a number like `v20` or `v22`, not an error.

Do not type your Kicktipp password into a chat. It stays on your computer.

### I use Claude Desktop

You do not need to live in a terminal after Node is installed.

1. Download **[kicktipp.mcpb](https://github.com/christianheidorn/kicktipp-agent/releases/latest/download/kicktipp.mcpb)** from the latest GitHub release. Same version number as the release.
2. Double-click the file. Claude Desktop should offer to install it. If nothing happens, open Claude Desktop and install the file from there.
3. In the extension settings, enter the email and password you use on kicktipp.com or kicktipp.de. Community can wait. Tick read-only if you only want Claude to look, not tip.
4. Fully quit Claude Desktop (not just the window) and open it again.
5. Start a **new** chat. Ask "What's my Kicktipp status?"

If the chat says it cannot find `node`, Node is not installed or not on your PATH. Install LTS, restart Desktop, try again.

### I use Claude Code, or another assistant that talks MCP

1. From a copy of this project:

   ```bash
   npm install
   npm run build
   claude mcp add kicktipp -- node /absolute/path/to/kicktipp-agent/dist/server.js
   ```

   Replace the path with the real folder on your machine. When this package is on npm, you can skip the copy and run:

   ```bash
   claude mcp add kicktipp -- npx -y -p kicktipp-agent kicktipp-agent-mcp
   ```

2. Open a new chat. Say **"Set up my Kicktipp account."** Open the `http://127.0.0.1:…` link in your normal browser, sign in, pick your pool.

Hand-editing Claude Desktop's JSON is a third option. Same program. See [Connecting Claude](#connecting-claude).

### I want `kicktipp` in the terminal

After Node is installed:

```bash
npm install -g kicktipp-agent
kicktipp login --web
```

On a Mac or Linux, a page should open by itself. On Windows, copy the `http://127.0.0.1:…` line from the terminal into your browser. Sign in, pick your pool. Then `kicktipp today` lists today's matches, and `kicktipp bet` opens the full-screen tip sheet.

The package is not on npm yet. From a copy of this project:

```bash
npm install
npm run build
npm link
kicktipp login --web
```

### I am changing the code

```bash
npm install
npm run build
npm test
```

`npm run pack:mcpb` builds the Desktop file yourself. Download it from [releases](https://github.com/christianheidorn/kicktipp-agent/releases) if you only want to use it.

## CLI

### First-time setup

```bash
kicktipp login --web
```

That prints a `http://127.0.0.1:…/setup?token=…` link and opens it on macOS and Linux. On Windows, paste the link into a browser. Email and password go into that page, not into the terminal. After a successful Kicktipp login you pick a community. Credentials land in `~/.config/kicktipp-agent/config.ini` with mode 600.

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
| `bet` | Place bets (full-screen tip sheet on a real terminal, or by fixture / bonus) |
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

### The tip sheet (`kicktipp bet`)

On a real terminal, `kicktipp bet` with no arguments opens a full-screen list of the matchday. Type scores in place, take the odds-based suggestion, submit with `w`.

![Kicktipp tip sheet in the terminal: fixtures, score fields, suggestions, and keyboard shortcuts](docs/images/tui-prediction.jpg)

Keys:

- arrows move
- digits type a score
- `s` take the suggestion on the current row
- `a` fill every empty row from suggestions
- `u` clear the current row
- `w` submit
- `q` quit without submitting

`kicktipp bet --no-tui` is the old one-match-at-a-time prompts. Bonus questions still use that path (`kicktipp bet --bonus`). You can also pass fixtures on the command line:

```bash
kicktipp bet "FC Bayern München vs Borussia Dortmund=2:1"
kicktipp bet "RB Leipzig vs Bayer 04 Leverkusen=0:0" --matchday 5
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

## Connecting Claude

Claude does not talk to Kicktipp itself. It starts a small program on your computer. That program logs into kicktipp.com or kicktipp.de. The assistant sees pool data. It never sees your password.

If you only wanted it working, [Start here](#start-here) is enough. The rest of this section is the detail.

The `.mcpb` file is that program, zipped, with a recipe for Claude Desktop. It is not a remote server. Each GitHub release includes one, tagged with the same version as `package.json`.

Pick **one** Desktop path. Running the bundle and a manual config at the same time starts two copies.

### After you connect the assistant

Wiring Claude to this server is not the same as signing into Kicktipp. Unless you already ran `kicktipp login` or filled in the Desktop bundle's email and password, open a new chat and tell the assistant to set up your Kicktipp account. It should call `connect_account` and give you a `http://127.0.0.1:…/setup?token=…` link. Open that, sign in, pick a community. Do not paste the password into the chat.

`get_status` returns the same link when nothing is saved yet. So does any tool that needs a login.

```bash
kicktipp login --web
```

is the CLI equivalent, if you prefer to sign in before connecting any assistant.

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

In a new chat, tell the assistant to set up Kicktipp unless you already signed in. Then ask for status.

### Claude Desktop, the bundle

A packed `kicktipp.mcpb` is attached to every [GitHub release](https://github.com/christianheidorn/kicktipp-agent/releases). Download it from the latest release:

**[kicktipp.mcpb](https://github.com/christianheidorn/kicktipp-agent/releases/latest/download/kicktipp.mcpb)**

Double-click that file, or install it from Claude Desktop. Desktop shows a settings form: email, password, optional community slug, read-only. The password goes in the OS keychain and is passed to the local process as env. Quit and reopen Desktop.

If you already signed in another way, the manual config above is simpler than filling that form.

Packing it yourself from a checkout is optional. The release asset is the one to download:

```bash
npm run pack:mcpb
```

That writes `kicktipp.mcpb` in the repo root, with the version from `package.json`.

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

Start a new chat. If Kicktipp is not signed in yet, tell the assistant to set up your account. Otherwise ask for Kicktipp status.

### Session-only storage

The setup page has a checkbox to keep the login cookie and drop the password (`store = session` under `[auth]`). A leaked config then has no Kicktipp password, and you can revoke the cookie on the Kicktipp site. When Kicktipp expires the session, this tool cannot log in again by itself. Tools return a fresh setup link instead. Opt-in, not the default.

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

### kicktipp.com and kicktipp.de

Both sites work. The default is `https://www.kicktipp.com`. If a page is missing there, the same page is tried on kicktipp.de (and the other way around), including German and English URL spellings. You usually do not have to pick.

To start on the German site on purpose, set `KICKTIPP_BASE_URL=https://www.kicktipp.de`.

## Changelog

See [CHANGELOG.md](CHANGELOG.md).

## Development

```bash
npm test          # run tests
npm run build     # compile TypeScript
npm run pack:mcpb # zip dist + production deps into kicktipp.mcpb
```

## Credits

Originally forked from [schwalle/kicktipp-betbot](https://github.com/schwalle/kicktipp-betbot) by Stefan. The project has since been fully rewritten in TypeScript with a new CLI interface, MCP server, and Cheerio-based parsing.
