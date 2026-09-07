import type { Fixture } from './model.js';
import { runProcess, type RunProcess } from './process.js';

export interface NotificationEvent {
  test?: boolean;
  type: 'r1_completed' | 'r2_completed' | 'tips_submitted' | 'workflow_error';
  fixture: Fixture;
  at: number;
  phase?: 'r1' | 'r2' | 'prediction' | 'submission';
}

export interface Notifier {
  send(event: NotificationEvent, signal: AbortSignal): Promise<void>;
}

// Labels originate outside this process. Never forward links, credentials or
// formatting/control instructions, even when they occur inside a team name.
function teamLabel(value: string): string {
  if (value.length > 120 || /(?:[:/@=<>\\]|[\p{L}\p{N}-]+\.[\p{L}]{2,}\b|\d+\.\d+\.\d+\.\d+|token|secret|password|cookie|bearer|api.?key|[\p{L}\p{N}_-]{32,})/iu.test(value)
    || /[\p{Cc}\p{Cf}]/u.test(value)) return 'Team';
  const safe = value.replace(/[^\p{L}\p{N} .’'()&-]/gu, '').trim();
  return safe || 'Team';
}

export function formatNotification(event: NotificationEvent): string {
  return (event.test ? '[TEST]\n' : '') + notificationBody(event);
}
function notificationBody(event: NotificationEvent): string {
  const match = `${teamLabel(event.fixture.home)} – ${teamLabel(event.fixture.away)}`;
  switch (event.type) {
    case 'r1_completed': {
      const kickoff = new Intl.DateTimeFormat('de-DE', {
        timeZone: 'Europe/Berlin', day: '2-digit', month: '2-digit', year: 'numeric',
        hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
      }).format(new Date(event.fixture.kickoff));
      return `✅ Research 1 abgeschlossen\n\n${match}\nAnpfiff: ${kickoff} Uhr\nDossier: gespeichert`;
    }
    case 'r2_completed':
      return `✅ Research 2 abgeschlossen\n\n${match}\nDelta-Research: gespeichert`;
    case 'tips_submitted':
      return `✅ Tipp erfolgreich abgegeben\n\n${match}\nKicktipp-Read-back: bestätigt`;
    case 'workflow_error': {
      const phases = { r1: 'Research 1', r2: 'Research 2', prediction: 'Prediction', submission: 'Tippabgabe' };
      const phase = event.phase && Object.hasOwn(phases, event.phase) ? phases[event.phase] : 'Workflow';
      return `⚠️ Workflow-Fehler\n\n${match}\nPhase: ${phase}\nGrund: Phase fehlgeschlagen, pausiert oder Sicherheitsprüfung nicht bestätigt. Details lokal prüfen.`;
    }
    default:
      throw new Error('Unsupported notification event');
  }
}

/** A direct Hermes transport: no model, chat session or fallback backend. */
export class HermesTelegramNotifier implements Notifier {
  constructor(private readonly target = 'telegram', private readonly runner: RunProcess = runProcess) {
    if (target !== 'telegram' && (target.trim() !== target || !/^telegram:-?\d{1,20}$/.test(target))) {
      throw new Error('Invalid Telegram target');
    }
  }

  async send(event: NotificationEvent, signal: AbortSignal): Promise<void> {
    try {
      signal.throwIfAborted();
      await this.runner('hermes', ['send', '--to', this.target, '--quiet', formatNotification(event)], {
        signal, maxOutputBytes: 16_384,
      });
    } catch {
      // Child output may contain credentials or private URLs; do not retain it.
      throw new Error('Telegram notification delivery failed');
    }
  }
}
