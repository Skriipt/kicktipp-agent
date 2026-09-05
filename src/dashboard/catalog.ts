import type { Command } from 'commander';
import { z } from 'zod';

// Interactive commands have dedicated web forms. Everything else is derived
// from Commander so a CLI option cannot silently disappear from the dashboard.
export const dedicatedCommands = ['login', 'logout', 'set-community', 'set-player', 'set-lang', 'set-site',
  'profiles', 'communities', 'players', 'bet', 'tui', 'set-notify', 'targets add', 'serve', 'dashboard'];
const groups: Record<string, string> = {
  today: 'Übersicht', deadline: 'Übersicht', 'tip-status': 'Übersicht',
  bets: 'Tipps', suggest: 'Tipps', log: 'Tipps',
  leaderboard: 'Ranglisten', overview: 'Ranglisten', schedule: 'Ranglisten', table: 'Ranglisten', rules: 'Ranglisten',
  stats: 'Analysen', rival: 'Analysen', scenario: 'Analysen', whatif: 'Analysen',
  targets: 'Benachrichtigungen', notify: 'Benachrichtigungen',
  service: 'Automatisierung', remind: 'Automatisierung',
  admin: 'Spielleitung', sync: 'Wartung', cache: 'Wartung', doctor: 'Wartung', guide: 'Hilfe',
};

export function commandLeaves(program: Command, prefix = ''): { id: string; command: Command }[] {
  return program.commands.flatMap(command => {
    const id = `${prefix}${command.name()}`;
    return command.commands.length ? commandLeaves(command, id + ' ') : [{ id, command }];
  });
}

export function commandCatalog(program: Command) {
  return commandLeaves(program).filter(({ id }) => !dedicatedCommands.includes(id)).map(({ id, command }) => ({
    id, group: groups[id.split(' ')[0]] ?? 'Weitere Funktionen', description: command.description(),
    args: command.registeredArguments.map(a => ({ name: a.name(), description: a.description, required: a.required, variadic: a.variadic })),
    options: command.options.filter(o => o.long !== '--yes').map(o => ({
      name: o.long!.slice(2), description: o.description, value: o.required || o.optional,
      optional: o.optional, variadic: o.variadic, default: o.defaultValue,
    })),
  }));
}

const text = z.string().max(16000).refine(s => !s.includes('\0'), 'NUL is not allowed');
export const requestSchema = z.object({
  operation: z.string().min(1).max(80),
  profile: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/)
    .refine(value => !['constructor', 'prototype', '__proto__'].includes(value)).nullable().default(null),
  community: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/).nullable().default(null),
  confirmed: z.boolean().default(false),
  payload: z.record(z.string(), z.unknown()).default({}),
}).strict();
export type DashboardRequest = z.infer<typeof requestSchema>;

export function commandIsMutation(id: string, options: Record<string, unknown>): boolean {
  return (id === 'suggest' && options.place === true && options.json !== true)
    || (id === 'log' && options.undo === true)
    || (id === 'notify' && options.json !== true)
    || (id === 'admin bet' && options['dry-run'] !== true)
    || (id === 'service run-once' && options['dry-run'] !== true)
    || (id === 'remind' && (options.install === true || options.uninstall === true))
    || ['cache clear', 'targets test', 'targets enable', 'targets disable', 'targets remove'].includes(id);
}

export function commandArguments(program: Command, payload: Record<string, unknown>, confirmed: boolean): string[] {
  const input = z.object({
    command: z.string(), args: z.array(text).max(100).default([]),
    options: z.record(z.string(), z.union([text, z.boolean(), z.array(text).max(100)])).default({}),
    confirmMember: text.optional(), confirmMemberId: text.optional(),
  }).strict().parse(payload);
  const definition = commandCatalog(program).find(c => c.id === input.command);
  if (!definition) throw new Error('Diese Funktion ist nicht verfügbar.');
  if (commandIsMutation(input.command, input.options) && !confirmed) throw new Error('Bestätigung erforderlich.');
  const argv = input.command.split(' ');
  for (const [name, value] of Object.entries(input.options)) {
    const option = definition.options.find(o => o.name === name);
    if (!option) throw new Error(`Unbekannte Option: ${name}`);
    if (value === false || value === '') continue;
    if (!option.value) {
      if (value !== true) throw new Error(`Ungültiger Schalter: ${name}`);
      argv.push('--' + name);
    } else {
      if (value === true) {
        if (!option.optional) throw new Error(`Wert fehlt: ${name}`);
        argv.push('--' + name);
      } else {
        if (Array.isArray(value) && !option.variadic && name !== 'header') throw new Error('Ungültige Werteliste.');
        const values = Array.isArray(value) ? value : [value];
        for (const item of values) {
          if (['warn-hours', 'every', 'target'].includes(name) && (!Number.isFinite(Number(item)) || Number(item) <= 0)) throw new Error('Positive Zahl erforderlich: ' + name);
          if (['matchday', 'from', 'to', 'target', 'every', 'verify'].includes(name) && !/^\d+$/.test(item)) {
            throw new Error(`Ganze positive Zahl erforderlich: ${name}`);
          }
          if (['matchday', 'from', 'to', 'verify'].includes(name) && (+item < 1 || +item > 34)) throw new Error('Spieltag muss zwischen 1 und 34 liegen.');
          if (name === 'ics') throw new Error('Kalender über die Download-Schaltfläche exportieren.');
        }
        if (option.variadic) {
          if (values.some(v => v.startsWith('-'))) throw new Error('Ungültiger Optionswert.');
          argv.push('--' + name, ...values);
        } else for (const item of values) argv.push('--' + name + '=' + item);
      }
    }
  }
  if (input.command === 'remind' && input.options.ics) throw new Error('Kalender über die Download-Schaltfläche exportieren.');
  if (input.command === 'remind' && process.platform !== 'linux' && (input.options.install || input.options.uninstall)) {
    throw new Error('systemd ist nur unter Linux verfügbar.');
  }
  if (confirmed && ['suggest', 'log', 'admin bet'].includes(input.command)) argv.push('--yes');
  argv.push('--', ...input.args);
  return argv;
}
