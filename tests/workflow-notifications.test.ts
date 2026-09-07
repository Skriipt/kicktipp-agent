import { describe, expect, it, vi } from 'vitest';
import type { Fixture } from '../src/workflow/model.js';
import { formatNotification, HermesTelegramNotifier, type NotificationEvent } from '../src/workflow/notifications.js';
import type { RunProcess } from '../src/workflow/process.js';

const fixture: Fixture = {
  profile: 'test', community: 'test', season: '2026', competition: 'Bundesliga', matchday: '1', fixtureId: '42',
  home: '1. FC Union Berlin', away: 'FC Schalke 04', kickoff: Date.UTC(2026, 8, 11, 18, 30),
};
const event: NotificationEvent = { type: 'r1_completed', fixture, at: fixture.kickoff - 1000 };

describe('workflow Telegram transport', () => {
  it.each(['telegram', 'telegram:123456', 'telegram:-100123456'])('passes exact native arguments for %s', async target => {
    const runner = vi.fn<RunProcess>().mockResolvedValue('');
    const signal = new AbortController().signal;
    await new HermesTelegramNotifier(target, runner).send(event, signal);
    expect(runner).toHaveBeenCalledExactlyOnceWith('hermes', ['send', '--to', target, '--quiet',
      '✅ Research 1 abgeschlossen\n\n1. FC Union Berlin – FC Schalke 04\nAnpfiff: 11.09.2026, 20:30 Uhr\nDossier: gespeichert'],
    { signal, maxOutputBytes: 16_384 });
  });

  it('defaults to Telegram', async () => {
    const runner = vi.fn<RunProcess>().mockResolvedValue('');
    await new HermesTelegramNotifier(undefined, runner).send(event, new AbortController().signal);
    expect(runner.mock.calls[0][1][2]).toBe('telegram');
  });

  it.each(['discord', 'telegram:', 'telegram:123:secret', 'telegram:token=secret', 'telegram:123\n', '--to=discord',
    'telegram:$(touch /tmp/unsafe)', 'telegram:123456789012345678901', 'https://secret.example'])('rejects unsafe target %j', target => {
    expect(() => new HermesTelegramNotifier(target, vi.fn<RunProcess>())).toThrow('Invalid Telegram target');
  });

  it.each([
    ['r2_completed', '✅ Research 2 abgeschlossen', 'Delta-Research: gespeichert'],
    ['tips_submitted', '✅ Tipp erfolgreich abgegeben', 'Kicktipp-Read-back: bestätigt'],
    ['workflow_error', '⚠️ Workflow-Fehler', 'Phase: Research 2'],
  ] as const)('formats %s from fixed safe wording', (type, title, detail) => {
    const message = formatNotification({ ...event, type, phase: 'r2' });
    expect(message).toContain(title);
    expect(message).toContain(detail);
    expect(message).toContain(`${fixture.home} – ${fixture.away}`);
  });

  it.each(['https://private.example/?token=PRIVATE', 'www.private.de', 'private.io', '127.0.0.1', 'cookie PRIVATE', 'token=PRIVATE',
    'password PRIVATE', 'Bearer PRIVATE', 'Team\nsecret', 'Team\u202ePRIVATE', 'a'.repeat(121),
    '<a href="private">Team</a>'])('does not send unsafe external labels %j', home => {
    const message = formatNotification({ ...event, fixture: { ...fixture, home } });
    expect(message).toContain(`Team – ${fixture.away}`);
    expect(message).not.toContain(home);
    expect(message).not.toContain('PRIVATE');
  });

  it('never includes extra provider-error or dossier fields', () => {
    const unsafe = { ...event, type: 'workflow_error' as const, error: 'SECRET https://private.example', dossier: 'PRIVATE DOSSIER' };
    const message = formatNotification(unsafe);
    expect(message).not.toMatch(/SECRET|https:|DOSSIER/);
  });

  it('uses Berlin time across daylight saving boundaries', () => {
    expect(formatNotification({ ...event, fixture: { ...fixture, kickoff: Date.UTC(2026, 2, 29, 1, 30) } }))
      .toContain('29.03.2026, 03:30 Uhr');
  });

  it('isolates delivery failures without exposing output or attempting fallback', async () => {
    const runner = vi.fn<RunProcess>().mockRejectedValue(new Error('Cookie SECRET https://private.example'));
    await expect(new HermesTelegramNotifier('telegram', runner).send(event, new AbortController().signal))
      .rejects.toThrow(/^Telegram notification delivery failed$/);
    expect(runner).toHaveBeenCalledTimes(1);
  });

  it('does not invoke Hermes after cancellation', async () => {
    const runner = vi.fn<RunProcess>().mockResolvedValue('');
    await expect(new HermesTelegramNotifier('telegram', runner).send(event, AbortSignal.abort()))
      .rejects.toThrow('Telegram notification delivery failed');
    expect(runner).not.toHaveBeenCalled();
  });
});
