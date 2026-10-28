import { Command } from 'commander';
import { t } from '../i18n/index.js';

export function getGuideText(): string {
  return `# Kicktipp service and CLI

## Setup

  docker compose run --rm kicktipp setup
  docker compose up -d

The setup wizard configures your account, community, MCP access and notification
channels. Use setup --notifications to change Discord, Telegram or webhook
delivery and reminder times. Restart the service after changing its settings.

  kicktipp setup
  kicktipp setup --notifications
  kicktipp notify --test          # test all configured channels; no Kicktipp call

## Reading Kicktipp

  kicktipp today                  # today's matches and missing tips
  kicktipp bets --matchday 5      # exact fixture names, odds and existing tips
  kicktipp schedule              # fixtures and results
  kicktipp leaderboard           # community ranking
  kicktipp overview              # season overview
  kicktipp table                 # league standings
  kicktipp rules --verify        # scoring rules and verification
  kicktipp tip-status            # complete, partial or missing tips
  kicktipp deadline              # upcoming deadlines
  kicktipp sync                  # update the season cache
  kicktipp stats                 # season statistics

Most read commands accept --json; use <command> --help for supported options.
The client uses HTTP directly. No browser is required.

## Submitting tips

  kicktipp bet "Home vs Away=2:1" "Another Home vs Another Away=0:0"
  kicktipp bet --bonus "Question text=Answer"

Use exact fixture names from bets. For bonus ranking questions, repeat the same
question once per dropdown in a single call, in slot order.

  kicktipp suggest --strategy ev # prints suggestions without submitting
  kicktipp suggest --place       # submits after confirmation
  kicktipp log                   # verified submissions
  kicktipp log --all             # also include dry runs and failed/unknown writes
  kicktipp log --undo            # restore previous values of the last match write

Read-only mode rejects submissions. A submitted result means a fresh read
confirmed the requested values. For submission_unknown, check the saved tips
before trying again; never automatically repeat an uncertain submission.

## Spielleiter

  kicktipp admin members
  kicktipp admin bets <member>
  kicktipp admin bet <member> "Home vs Away=2:1"

These commands require the account's Spielleiter rights. Use --help for
confirmation and preview options.

## MCP

The Compose service provides authenticated HTTP MCP at /mcp. Configure the
endpoint and Bearer token shown by setup in your MCP client. The service keeps
checking reminders even when no agent is connected. Local clients can still
start node dist/server.js using stdio.
`;
}

export function registerGuideCommand(program: Command): void {
  program
    .command('guide')
    .description(t('cmd.guide.description'))
    .action(() => console.log(getGuideText()));
}
