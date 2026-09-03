/**
 * Every screen the TUI can show, one per menu item, built through a single
 * factory. Read screens pair a loader with a formatter; interactive ones
 * (place bets, suggestions, set community…) add key handlers that reach back
 * into the app for overlays, toasts and navigation.
 *
 * Screens hold their own loaded data in a closure, so the app never has to
 * know what any particular screen keeps.
 */
import { bold, dim, fg } from './ansi.js';
import { palette } from './theme.js';
import { fit } from './text.js';
import { renderTable } from './table.js';
import { messageOverlay, confirmOverlay, inputOverlay, listOverlay } from './overlays.js';
import * as F from './format.js';
import type { AppApi, FooterHint, Screen } from './types.js';
import type { Key } from './keys.js';
import type { Member } from '../../core.js';
import { OVERVIEW_VIEW_OPTIONS } from '../../core.js';
import { STRATEGIES, type StrategyName } from '../../analytics/strategies.js';
import { REPLAY_STRATEGIES } from '../../analytics/replay.js';
import { isOwnMatchSubmission } from '../../audit/log.js';
import {
  initialState,
  handleKey as handleBetKey,
  changedRows,
  normalizeDraft,
  isCompleteDraft,
  type TuiRow,
  type TuiState,
} from '../state.js';

const NO_HINTS: FooterHint[] = [];

/** A screen whose only job is to load data and format it (with optional keys). */
function readScreen<T>(
  app: AppApi,
  cfg: {
    id: string;
    title: string;
    matchdayScoped?: boolean;
    status?: () => string;
    load: () => Promise<T>;
    render: (data: T, width: number, height: number) => string[];
    footer?: FooterHint[];
    onKey?: (data: T | null, key: Key) => boolean | Promise<boolean>;
  },
): Screen {
  let state: { ready: false } | { ready: true; data: T } = { ready: false };
  return {
    id: cfg.id,
    title: cfg.title,
    matchdayScoped: cfg.matchdayScoped,
    status: cfg.status ?? (() => defaultStatus(app)),
    async load() {
      state = { ready: true, data: await cfg.load() };
    },
    render(width, height) {
      if (!state.ready) return [dim('  Loading…')];
      return cfg.render(state.data, width, height);
    },
    footer: () => cfg.footer ?? NO_HINTS,
    onKey: (key) => (cfg.onKey ? cfg.onKey(state.ready ? state.data : null, key) : false),
  };
}

function defaultStatus(app: AppApi): string {
  const ctx = app.source.getContext();
  return F.contextStrip(
    [
      ctx.community ? { label: 'community', value: ctx.community } : null,
      ctx.player ? { label: 'you', value: ctx.player } : null,
    ].filter((x): x is { label: string; value: string } => x !== null),
  );
}

function matchdayStatus(app: AppApi): string {
  const md = app.matchday === null ? 'current' : `#${app.matchday}`;
  return `${dim('matchday')} ${fg(palette.accent, md)}   ${dim('· [ ] to change')}   ${defaultStatus(app)}`;
}

// ── The factory ───────────────────────────────────────────────────

export function createScreen(app: AppApi, id: string): Screen {
  const s = app.source;
  switch (id) {
    case 'today':
      return readScreen(app, {
        id,
        title: 'Today',
        load: () => s.today(),
        render: (d, w) => F.todayView(d, w),
      });

    case 'bets':
      return readScreen(app, {
        id,
        title: 'My bets',
        matchdayScoped: true,
        status: () => matchdayStatus(app),
        load: () => s.bets(app.matchday ?? undefined),
        render: (d, w) => F.betsView(d, w),
      });

    case 'schedule':
      return readScreen(app, {
        id,
        title: 'Schedule',
        matchdayScoped: true,
        status: () => matchdayStatus(app),
        load: () => s.schedule(app.matchday ?? undefined),
        render: (d, w) => F.scheduleView(d, w),
      });

    case 'leaderboard': {
      let bonus = false;
      return readScreen(app, {
        id,
        title: 'Leaderboard',
        matchdayScoped: true,
        status: () => `${matchdayStatus(app)}   ${bonus ? fg(palette.accent, '· bonus') : dim('· b for bonus')}`,
        load: () => s.leaderboard(app.matchday ?? undefined, bonus),
        render: (d, w) => F.leaderboardView(d, w),
        footer: [{ key: 'b', label: 'toggle bonus' }],
        onKey: async (_d, key) => {
          if (key.type === 'char' && key.value === 'b') {
            bonus = !bonus;
            await app.reload();
            return true;
          }
          return false;
        },
      });
    }

    case 'overview': {
      let viewIndex = 0;
      return readScreen(app, {
        id,
        title: 'Season overview',
        status: () => `${dim('view')} ${fg(palette.accent, OVERVIEW_VIEW_OPTIONS[viewIndex])}   ${dim('· v to cycle')}   ${defaultStatus(app)}`,
        load: () => s.overview(OVERVIEW_VIEW_OPTIONS[viewIndex]),
        render: (d, w) => F.overviewView(d, w),
        footer: [{ key: 'v', label: 'cycle view' }],
        onKey: async (_d, key) => {
          if (key.type === 'char' && key.value === 'v') {
            viewIndex = (viewIndex + 1) % OVERVIEW_VIEW_OPTIONS.length;
            await app.reload();
            return true;
          }
          return false;
        },
      });
    }

    case 'table': {
      const options: (undefined | 'home' | 'away')[] = [undefined, 'home', 'away'];
      let idx = 0;
      return readScreen(app, {
        id,
        title: 'League table',
        status: () => `${dim('scope')} ${fg(palette.accent, options[idx] ?? 'full')}   ${dim('· t to cycle')}   ${defaultStatus(app)}`,
        load: () => s.table(options[idx]),
        render: (d, w) => F.tableView(d, w),
        footer: [{ key: 't', label: 'full / home / away' }],
        onKey: async (_d, key) => {
          if (key.type === 'char' && key.value === 't') {
            idx = (idx + 1) % options.length;
            await app.reload();
            return true;
          }
          return false;
        },
      });
    }

    case 'deadline':
      return readScreen(app, {
        id,
        title: 'Deadlines',
        matchdayScoped: true,
        status: () => matchdayStatus(app),
        load: () => s.deadline(app.matchday ?? undefined),
        render: (d, w) => F.deadlineView(d, w),
      });

    case 'rules':
      return readScreen(app, {
        id,
        title: 'Rules',
        load: () => s.rules(),
        render: (d, w) => F.rulesView(d, w),
      });

    case 'communities':
      return readScreen(app, {
        id,
        title: 'Communities',
        load: () => s.communities(),
        render: (d) => F.bulletList(d),
      });

    case 'players':
      return readScreen(app, {
        id,
        title: 'Players',
        load: () => s.players(),
        render: (d) => F.bulletList(d),
      });

    case 'profiles':
      return readScreen(app, {
        id,
        title: 'Profiles',
        load: async () => s.profiles(),
        render: (d) => [
          ...F.profilesView(d),
          '',
          dim('Pick a profile at launch with `kicktipp tui --profile <name>`.'),
        ],
      });

    case 'cache':
      return readScreen(app, {
        id,
        title: 'Cache',
        load: () => s.cacheInfo(),
        render: (d) => F.cacheView(d),
        footer: [{ key: 'c', label: 'clear cache' }],
        onKey: (_d, key) => {
          if (key.type === 'char' && key.value === 'c') {
            app.openOverlay(
              confirmOverlay(app, {
                title: 'Clear cache',
                danger: true,
                message: 'Delete all cached data for this community? A later sync re-downloads it.',
                onConfirm: async () => {
                  try {
                    s.clearCache();
                    app.toast('Cache cleared.', 'success');
                    await app.reload();
                  } catch (err) {
                    app.toast(errMessage(err), 'error');
                  }
                },
              }),
            );
            return true;
          }
          return false;
        },
      });

    case 'log':
      return readScreen(app, {
        id,
        title: 'Audit log',
        load: async () => s.auditLog(),
        render: (d, w) => F.auditView(d, w),
        footer: [{ key: 'u', label: 'undo last submission' }],
        onKey: (records, key) => {
          if (key.type === 'char' && key.value === 'u') {
            const last = [...(records ?? [])].reverse().find(isOwnMatchSubmission);
            if (!last) {
              app.toast('No match submission to undo.', 'warn');
              return true;
            }
            const args = last.bets
              .filter((b) => b.previous)
              .map((b) => `${b.fixture}=${b.previous}`);
            if (!args.length) {
              app.toast('The last submission has no previous values to restore.', 'warn');
              return true;
            }
            app.openOverlay(
              confirmOverlay(app, {
                title: 'Undo last submission',
                danger: true,
                message: `Restore ${args.length} bet(s) to their previous values on matchday ${last.matchday ?? '?'}?`,
                onConfirm: async () => {
                  try {
                    await s.placeBets(args, last.matchday ?? undefined);
                    app.toast('Previous bets restored.', 'success');
                    await app.reload();
                  } catch (err) {
                    app.toast(errMessage(err), 'error');
                  }
                },
              }),
            );
            return true;
          }
          return false;
        },
      });

    case 'guide':
      return readScreen(app, {
        id,
        title: 'Guide',
        load: async () => s.guide(),
        render: (d, w) => F.guideView(d, w),
      });

    case 'members':
      return readScreen(app, {
        id,
        title: 'Members',
        load: () => s.members(),
        render: (d, w) => F.membersView(d, w),
      });

    case 'stats':
      return statsScreen(app);
    case 'whatif':
      return whatifScreen(app);
    case 'rival':
      return rivalScreen(app);
    case 'scenario':
      return scenarioScreen(app);
    case 'suggest':
      return suggestScreen(app);
    case 'bonus':
      return bonusScreen(app);
    case 'place':
      return placeScreen(app);
    case 'memberbets':
      return memberBetsScreen(app);
    case 'setcommunity':
      return setCommunityScreen(app);
    case 'setplayer':
      return setPlayerScreen(app);
    case 'sync':
      return syncScreen(app);
    case 'notify':
      return notifyScreen(app);
    case 'account':
      return accountScreen(app);
    default:
      return readScreen(app, {
        id,
        title: id,
        load: async () => null,
        render: () => [dim('  This screen is not available.')],
      });
  }
}

// ── Analytics screens with pickers ────────────────────────────────

function statsScreen(app: AppApi): Screen {
  let player: string | null = null;
  return readScreen(app, {
    id: 'stats',
    title: 'Stats',
    status: () => `${dim('player')} ${fg(palette.accent, player ?? app.source.getContext().player ?? 'you')}   ${dim('· p to choose')}`,
    load: () => app.source.stats(player ?? undefined),
    render: (d, w) => F.statsView(d, w),
    footer: [{ key: 'p', label: 'choose player' }],
    onKey: async (_d, key) => {
      if (key.type === 'char' && key.value === 'p') {
        const players = await safe(app, () => app.source.players());
        if (players) {
          app.openOverlay(
            listOverlay(app, {
              title: 'Player to analyse',
              items: players,
              onSelect: async (value) => {
                player = value;
                await app.reload();
              },
            }),
          );
        }
        return true;
      }
      return false;
    },
  });
}

function whatifScreen(app: AppApi): Screen {
  const presets = [...REPLAY_STRATEGIES, 'suggest:safe', 'suggest:ev', 'suggest:contrarian'];
  let strategy = 'favorite';
  return readScreen(app, {
    id: 'whatif',
    title: 'What-if replay',
    status: () => `${dim('strategy')} ${fg(palette.purple, strategy)}   ${dim('· s to choose')}`,
    load: () => app.source.replay(strategy),
    render: (d, w) => F.replayView(d, w),
    footer: [{ key: 's', label: 'choose strategy' }],
    onKey: (_d, key) => {
      if (key.type === 'char' && key.value === 's') {
        app.openOverlay(
          listOverlay(app, {
            title: 'Replay strategy',
            items: presets,
            onSelect: async (value) => {
              strategy = value;
              await app.reload();
            },
          }),
        );
        return true;
      }
      return false;
    },
  });
}

function rivalScreen(app: AppApi): Screen {
  let rival: string | null = null;
  return readScreen(app, {
    id: 'rival',
    title: 'Rival watch',
    matchdayScoped: true,
    status: () =>
      rival
        ? `${dim('rival')} ${fg(palette.red, rival)}   ${matchdayStatus(app)}`
        : `${dim('press r to pick a rival')}   ${matchdayStatus(app)}`,
    load: async () => (rival ? app.source.rival(rival, app.matchday ?? undefined) : null),
    render: (d, w) =>
      d ? F.rivalView(d, w) : [dim('  Pick a rival with '), '', `  ${fg(palette.primary, 'r')}  choose a player to compare against`],
    footer: [{ key: 'r', label: 'choose rival' }],
    onKey: async (_d, key) => {
      if (key.type === 'char' && key.value === 'r') {
        const players = await safe(app, () => app.source.players());
        const you = app.source.getContext().player;
        if (players) {
          app.openOverlay(
            listOverlay(app, {
              title: 'Rival to watch',
              items: players.filter((p) => p !== you),
              onSelect: async (value) => {
                rival = value;
                await app.reload();
              },
            }),
          );
        }
        return true;
      }
      return false;
    },
  });
}

function scenarioScreen(app: AppApi): Screen {
  let results: string[] = [];
  return readScreen(app, {
    id: 'scenario',
    title: 'Scenarios',
    matchdayScoped: true,
    status: () => `${dim(`${results.length} hypothetical result(s)`)}   ${matchdayStatus(app)}`,
    load: () => app.source.scenario(app.matchday ?? undefined, results),
    render: (d, w) => F.scenarioView(d, w),
    footer: [
      { key: 'a', label: 'add result' },
      { key: 'x', label: 'clear' },
    ],
    onKey: async (_d, key) => {
      if (key.type === 'char' && key.value === 'a') {
        app.openOverlay(
          inputOverlay(app, {
            title: 'Add a hypothetical result',
            prompt: 'Enter a fixture and score to pin.',
            placeholder: 'Home vs Away=H:G',
            onSubmit: async (value) => {
              if (!value) return;
              results = [...results, value];
              try {
                await app.reload();
                app.toast('Result added to the scenario.', 'success');
              } catch (err) {
                results = results.slice(0, -1);
                app.toast(errMessage(err), 'error');
              }
            },
          }),
        );
        return true;
      }
      if (key.type === 'char' && key.value === 'x') {
        results = [];
        await app.reload();
        return true;
      }
      return false;
    },
  });
}

function suggestScreen(app: AppApi): Screen {
  let strategy: StrategyName = 'safe';
  return readScreen(app, {
    id: 'suggest',
    title: 'Suggestions',
    matchdayScoped: true,
    status: () => `${matchdayStatus(app)}   ${dim('· 1-4 strategy · p place')}`,
    load: () => app.source.suggest(strategy, app.matchday ?? undefined),
    render: (d, w) => F.suggestView(d, w),
    footer: [
      { key: '1-4', label: 'strategy' },
      { key: 'p', label: 'place all' },
    ],
    onKey: async (data, key) => {
      if (key.type === 'char' && '1234'.includes(key.value)) {
        strategy = STRATEGIES[Number(key.value) - 1];
        await app.reload();
        return true;
      }
      if (key.type === 'char' && key.value === 's') {
        app.openOverlay(
          listOverlay(app, {
            title: 'Suggestion strategy',
            items: [...STRATEGIES],
            onSelect: async (value) => {
              strategy = value as StrategyName;
              await app.reload();
            },
          }),
        );
        return true;
      }
      if (key.type === 'char' && key.value === 'p' && data) {
        if (app.source.getContext().readOnly) {
          app.toast('Read-only mode: placing bets is disabled.', 'warn');
          return true;
        }
        const args = data.suggestions.map((b) => `${b.home} vs ${b.away}=${b.bet}`);
        app.openOverlay(
          confirmOverlay(app, {
            title: `Place ${args.length} suggested bet(s)`,
            message: `Submit the ${strategy.toUpperCase()} slip for ${
              app.matchday === null ? 'the current matchday' : `matchday ${app.matchday}`
            }?`,
            onConfirm: async () => {
              try {
                const placed = await app.source.placeBets(args, app.matchday ?? undefined);
                app.openOverlay(
                  messageOverlay(app, {
                    title: 'Bets placed',
                    color: palette.primary,
                    lines: placed.map((p) => `${p.home} vs ${p.away}  →  ${p.homeGoals}:${p.awayGoals}`),
                  }),
                );
                await app.reload();
              } catch (err) {
                app.toast(errMessage(err), 'error');
              }
            },
          }),
        );
        return true;
      }
      return false;
    },
  });
}

function bonusScreen(app: AppApi): Screen {
  return readScreen(app, {
    id: 'bonus',
    title: 'Bonus bets',
    load: () => app.source.bonusBets(),
    render: (d, w) => F.bonusView(d, w),
    footer: [{ key: 'e', label: 'answer a question' }],
    onKey: async (answers, key) => {
      if (key.type !== 'char' || key.value !== 'e') return false;
      if (app.source.getContext().readOnly) {
        app.toast('Read-only mode: placing bets is disabled.', 'warn');
        return true;
      }
      if (answers && answers.length && !answers.some((a) => a.editable)) {
        app.toast('The bonus round is closed — these answers can no longer be changed.', 'warn');
        return true;
      }
      // The place flow needs the editable form (options + slot names).
      const questions = await safe(app, () => app.source.bonusQuestions());
      if (!questions || !questions.length) {
        app.toast('No open bonus questions to answer.', 'warn');
        return true;
      }
      app.openOverlay(
        listOverlay(app, {
          title: 'Which question?',
          items: questions.map((q) => q.question),
          onSelect: async (question, index) => {
            const options = questions[index].selects[0]?.options.map((o) => o.text) ?? [];
            app.openOverlay(
              listOverlay(app, {
                title: 'Choose an answer',
                items: options,
                onSelect: async (answer) => {
                  try {
                    await app.source.placeBonusBets([`${question}=${answer}`]);
                    app.toast(`Answered: ${answer}`, 'success');
                    await app.reload();
                  } catch (err) {
                    app.toast(errMessage(err), 'error');
                  }
                },
              }),
            );
          },
        }),
      );
      return true;
    },
  });
}

function memberBetsScreen(app: AppApi): Screen {
  let member: Member | null = null;
  let members: Member[] = [];
  return readScreen(app, {
    id: 'memberbets',
    title: 'Member bets',
    matchdayScoped: true,
    status: () =>
      member
        ? `${dim('member')} ${fg(palette.accent, member.name)}   ${matchdayStatus(app)}`
        : `${dim('press m to pick a member')}   ${matchdayStatus(app)}`,
    load: async () => {
      if (!members.length) members = await app.source.members();
      return member ? app.source.betsForMember(member, app.matchday ?? undefined) : null;
    },
    render: (d, w) =>
      d ? F.betsView({ title: d.member.name, matches: d.matches }, w) : [dim('  Press '), '', `  ${fg(palette.primary, 'm')}  choose a member (Spielleiter rights required)`],
    footer: [{ key: 'm', label: 'choose member' }],
    onKey: (_d, key) => {
      if (key.type === 'char' && key.value === 'm') {
        if (!members.length) {
          app.toast('No members available (admin rights required).', 'warn');
          return true;
        }
        app.openOverlay(
          listOverlay(app, {
            title: 'Member',
            items: members.map((m) => `${m.name}${m.dummy ? ' (dummy)' : ''}`),
            onSelect: async (_value, index) => {
              member = members[index];
              await app.reload();
            },
          }),
        );
        return true;
      }
      return false;
    },
  });
}

// ── Config action screens ─────────────────────────────────────────

function setCommunityScreen(app: AppApi): Screen {
  let list: string[] = [];
  return readScreen(app, {
    id: 'setcommunity',
    title: 'Set community',
    load: async () => {
      list = await app.source.communities();
      return list;
    },
    render: (d) => [
      dim('Pick the community future screens act on.'),
      '',
      ...F.bulletList(d ?? []),
      '',
      `Press ${fg(palette.primary, 'enter')} to choose.`,
    ],
    footer: [{ key: 'enter', label: 'choose' }],
    onKey: (_d, key) => {
      if (key.type === 'enter') {
        app.openOverlay(
          listOverlay(app, {
            title: 'Choose community',
            items: list,
            onSelect: async (value) => {
              app.source.setCommunity(value);
              app.refreshContext();
              app.toast(`Community set to ${value}.`, 'success');
            },
          }),
        );
        return true;
      }
      return false;
    },
  });
}

function setPlayerScreen(app: AppApi): Screen {
  let list: string[] = [];
  return readScreen(app, {
    id: 'setplayer',
    title: 'Set player',
    load: async () => {
      list = await app.source.players();
      return list;
    },
    render: (d) => [
      dim('Tell the leaderboards which player is you.'),
      '',
      ...F.bulletList(d ?? []),
      '',
      `Press ${fg(palette.primary, 'enter')} to choose.`,
    ],
    footer: [{ key: 'enter', label: 'choose' }],
    onKey: (_d, key) => {
      if (key.type === 'enter') {
        app.openOverlay(
          listOverlay(app, {
            title: 'Which one are you?',
            items: list,
            onSelect: async (value) => {
              app.source.setPlayer(value);
              app.refreshContext();
              app.toast(`You are now ${value}.`, 'success');
            },
          }),
        );
        return true;
      }
      return false;
    },
  });
}

function syncScreen(app: AppApi): Screen {
  let lastResult: string | null = null;
  return readScreen(app, {
    id: 'sync',
    title: 'Sync season',
    load: async () => null,
    render: () => [
      dim('Update the local cache for offline analytics (stats, what-if,'),
      dim('rival, scenarios). Finished and future matchdays are skipped.'),
      '',
      lastResult ? fg(palette.primary, lastResult) : dim('Press enter to sync now.'),
    ],
    footer: [{ key: 'enter', label: 'sync now' }],
    onKey: async (_d, key) => {
      if (key.type === 'enter') {
        app.toast('Syncing… this can take a minute.', 'info');
        try {
          const result = await app.source.sync({});
          lastResult = `Synced ${result.fetched} matchday(s), skipped ${result.skipped}. Cache: ${result.cacheDir}`;
          app.toast('Season synced.', 'success');
        } catch (err) {
          app.toast(errMessage(err), 'error');
        }
        return true;
      }
      return false;
    },
  });
}

function notifyScreen(app: AppApi): Screen {
  return readScreen(app, {
    id: 'notify',
    title: 'Notifications',
    load: async () => app.source.notifyConfig(),
    render: (d) => [
      F.heading('Reminder delivery'),
      '',
      `  ${dim('Backend')}  ${fg(palette.primary, d?.kind ?? 'desktop')}`,
      `  ${dim('Target ')}  ${d?.target ? fg(palette.text, d.target) : dim('—')}`,
      d?.fromEnv ? dim('  (currently overridden by environment variables)') : '',
      '',
      dim('Reminders fire before kickoff when a match still needs a bet.'),
      `Press ${fg(palette.primary, 'e')} to change the backend.`,
    ],
    footer: [{ key: 'e', label: 'edit backend' }],
    onKey: (_d, key) => {
      if (key.type === 'char' && key.value === 'e') {
        app.openOverlay(
          listOverlay(app, {
            title: 'Notification backend',
            items: ['desktop', 'webhook', 'command'],
            onSelect: (kind) => {
              if (kind === 'desktop') {
                app.source.setNotify('desktop');
                app.toast('Desktop notifications enabled.', 'success');
                void app.reload();
                return;
              }
              app.openOverlay(
                inputOverlay(app, {
                  title: `${kind} target`,
                  prompt: kind === 'webhook' ? 'Webhook URL to POST to.' : 'Command to run.',
                  placeholder: kind === 'webhook' ? 'https://ntfy.sh/your-topic' : '/path/to/hook',
                  onSubmit: async (target) => {
                    try {
                      app.source.setNotify(kind, target);
                      app.toast(`Saved ${kind} notifier.`, 'success');
                      await app.reload();
                    } catch (err) {
                      app.toast(errMessage(err), 'error');
                    }
                  },
                }),
              );
            },
          }),
        );
        return true;
      }
      return false;
    },
  });
}

function accountScreen(app: AppApi): Screen {
  return readScreen(app, {
    id: 'account',
    title: 'Account',
    load: async () => app.source.getContext(),
    render: (ctx) => {
      if (!ctx) return [dim('  Loading…')];
      const yes = fg(palette.primary, 'yes');
      const no = fg(palette.red, 'no');
      return [
        F.heading('Session'),
        '',
        `  ${dim('Logged in')}   ${ctx.loggedIn ? yes : no}`,
        `  ${dim('Community')}   ${ctx.community ?? dim('not set')}`,
        `  ${dim('Player')}      ${ctx.player ?? dim('not set')}`,
        `  ${dim('Profile')}     ${ctx.profile ?? dim('default')}`,
        `  ${dim('Read-only')}   ${ctx.readOnly ? yes : no}`,
        `  ${dim('Mode')}        ${fg(palette.primary, 'live')}`,
        '',
        dim('Connect or reset an account from the CLI:'),
        `  ${fg(palette.teal, 'kicktipp login --web')}     open the browser setup page`,
        `  ${fg(palette.teal, 'kicktipp logout')}          remove stored credentials`,
      ];
    },
  });
}

// ── Place bets: the interactive grid ──────────────────────────────

function placeScreen(app: AppApi): Screen {
  let state: TuiState | null = null;
  let title = '';

  const buildRows = async (): Promise<TuiRow[]> => {
    const md = app.matchday ?? undefined;
    const [{ title: t, matches }, deadline, suggestion] = await Promise.all([
      app.source.bets(md),
      app.source.deadline(md),
      app.source.suggest('safe', md),
    ]);
    title = t;
    return matches.map((match, i) => {
      const saved = /^\d+:\d+$/.test(match.bet) ? match.bet : null;
      const closed = deadline.matches[i]?.closed ?? false;
      return {
        home: match.home,
        away: match.away,
        kickoff: deadline.matches[i]?.kickoff ?? null,
        saved,
        draft: saved ?? '',
        suggestion: suggestion.suggestions[i]?.bet ?? null,
        odds: match.odds.home || null,
        editable: !closed,
      };
    });
  };

  const submit = async (): Promise<void> => {
    if (!state) return;
    if (app.source.getContext().readOnly) {
      app.toast('Read-only mode: placing bets is disabled.', 'warn');
      state.outcome = null;
      return;
    }
    const changed = changedRows(state);
    const args = changed.map((r) => `${r.home} vs ${r.away}=${normalizeDraft(r.draft)}`);
    try {
      const placed = await app.source.placeBets(args, app.matchday ?? undefined);
      app.openOverlay(
        messageOverlay(app, {
          title: `Submitted ${placed.length} bet(s)`,
          color: palette.primary,
          lines: placed.map((p) => `${p.home} vs ${p.away}  →  ${p.homeGoals}:${p.awayGoals}`),
        }),
      );
      await app.reload();
    } catch (err) {
      app.toast(errMessage(err), 'error');
      if (state) state.outcome = null;
    }
  };

  return {
    id: 'place',
    title: 'Place bets',
    matchdayScoped: true,
    capturesInput: () => true,
    status: () =>
      `${bold(title || 'Matchday')}   ${matchdayStatus(app)}`,
    async load() {
      state = initialState(await buildRows());
    },
    render(width) {
      if (!state) return [dim('  Loading…')];
      return renderPlaceGrid(state, width);
    },
    footer: () => [
      { key: '0-9', label: 'score' },
      { key: 's', label: 'suggestion' },
      { key: 'a', label: 'fill all' },
      { key: 'u', label: 'clear' },
      { key: 'w', label: 'submit' },
      { key: 'esc', label: 'back' },
    ],
    async onKey(key) {
      if (!state) return false;
      const betKey = toBetKey(key);
      if (!betKey) return false;
      state = handleBetKey(state, betKey);
      if (state.outcome === 'submit') {
        await submit();
      } else if (state.outcome === 'quit') {
        state.outcome = null;
        app.focusSidebar();
      }
      return true;
    },
  };
}

function toBetKey(key: Key): Parameters<typeof handleBetKey>[1] | null {
  switch (key.type) {
    case 'up':
      return { type: 'up' };
    case 'down':
      return { type: 'down' };
    case 'enter':
      return { type: 'enter' };
    case 'backspace':
      return { type: 'backspace' };
    case 'escape':
      return { type: 'quit' };
    case 'char': {
      const v = key.value;
      if (/^\d$/.test(v) || v === ':' || v === '-') return { type: 'char', value: v };
      if (v === 'w') return { type: 'submit' };
      if (v === 'u') return { type: 'clear' };
      if (v === 's') return { type: 'suggest' };
      if (v === 'a') return { type: 'suggest-all' };
      if (v === 'q') return { type: 'quit' };
      return null;
    }
    default:
      return null;
  }
}

function renderPlaceGrid(state: TuiState, width: number): string[] {
  const rows = state.rows.map((row) => {
    const changed = row.editable && isCompleteDraft(row.draft) && normalizeDraft(row.draft) !== row.saved;
    const marker = changed ? fg(palette.primary, '●') : ' ';
    let value: string;
    if (!row.editable) value = dim('closed');
    else if (row.draft) value = bold(fg(palette.heading, fit(normalizeDraft(row.draft), 5, 'center')));
    else value = dim(fit('_:_', 5, 'center'));
    const saved = row.saved ? dim(`was ${row.saved}`) : row.editable ? dim('no bet') : '';
    const hint = row.suggestion && !row.draft ? dim(`sug ${row.suggestion}`) : '';
    return [marker, F.fixtureLabel(row.home, row.away), value, saved, hint];
  });

  const lines = renderTable({
    width,
    selected: state.cursor,
    columns: [
      { header: '' },
      { header: 'Match', flex: true, min: 16 },
      { header: 'Bet', align: 'center' },
      { header: 'Saved', align: 'right' },
      { header: 'Hint', align: 'right' },
    ],
    rows,
  });

  const pending = changedRows(state).length;
  lines.push('');
  lines.push(
    pending
      ? bold(fg(palette.primary, `${pending} bet(s) ready — press w to submit`))
      : dim('No changes yet. Type a score like 21 or 2:1.'),
  );
  if (state.message) lines.push(fg(palette.amber, state.message));
  return lines;
}

// ── helpers ───────────────────────────────────────────────────────

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Run a source call, turning a failure into a toast and returning null. */
async function safe<T>(app: AppApi, fn: () => Promise<T>): Promise<T | null> {
  try {
    return await fn();
  } catch (err) {
    app.toast(errMessage(err), 'error');
    return null;
  }
}
