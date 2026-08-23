import { spawn } from 'child_process';
import { readConfig } from '../config.js';

export type NotifierKind = 'desktop' | 'webhook' | 'command';

export interface NotifierConfig {
  kind: NotifierKind;
  /** webhook: the URL to POST to. command: the program to run. */
  target?: string;
}

/**
 * Which notifier to use, from the [notify] config section:
 *
 *   [notify]
 *   kind = webhook
 *   target = https://ntfy.sh/my-topic
 *
 * There is deliberately no default endpoint — a webhook only ever goes
 * somewhere the user named themselves.
 */
export function readNotifierConfig(): NotifierConfig {
  const notify = readConfig().notify ?? {};
  const kind = (process.env.KICKTIPP_NOTIFY_KIND || notify.kind || 'desktop') as NotifierKind;
  const target = process.env.KICKTIPP_NOTIFY_TARGET || notify.target;
  return { kind, target };
}

function run(command: string, args: string[], input?: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ['pipe', 'ignore', 'pipe'] });
    let stderr = '';
    child.stderr?.on('data', (chunk) => {
      stderr += String(chunk);
    });
    child.on('error', (err) => reject(new Error(`Could not run '${command}': ${err.message}`)));
    child.on('close', (code) =>
      code === 0
        ? resolve()
        : reject(new Error(`'${command}' exited with ${code}${stderr ? `: ${stderr.trim()}` : ''}`)),
    );
    // A command that ignores stdin may exit before we finish writing; that
    // is not a failure of the notification, so the broken pipe is ignored.
    child.stdin?.on('error', () => {});
    child.stdin?.end(input ?? '');
  });
}

async function desktop(title: string, body: string): Promise<void> {
  if (process.platform === 'darwin') {
    const escape = (s: string) => s.replace(/["\\]/g, '\\$&');
    await run('osascript', ['-e', `display notification "${escape(body)}" with title "${escape(title)}"`]);
    return;
  }
  if (process.platform === 'linux') {
    await run('notify-send', [title, body]);
    return;
  }
  throw new Error(
    `No desktop notifier for ${process.platform}. Use the webhook or command backend instead.`,
  );
}

async function webhook(target: string, payload: unknown): Promise<void> {
  const res = await fetch(target, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  if (!res.ok) throw new Error(`Webhook ${target} answered ${res.status} ${res.statusText}.`);
}

/**
 * Deliver a notification. The payload is the deadline report plus a human
 * `summary`, documented as a stable shape so webhook consumers can rely
 * on it.
 */
export async function notify(
  config: NotifierConfig,
  summary: string,
  payload: unknown,
  deps: { fetchImpl?: typeof fetch } = {},
): Promise<void> {
  switch (config.kind) {
    case 'desktop':
      return desktop('kicktipp', summary);
    case 'webhook': {
      if (!config.target) {
        throw new Error('The webhook notifier needs a target URL ([notify] target = ...).');
      }
      const body = { summary, ...(payload as object) };
      if (deps.fetchImpl) {
        const res = await deps.fetchImpl(config.target, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        });
        if (!res.ok) throw new Error(`Webhook ${config.target} answered ${res.status}.`);
        return;
      }
      return webhook(config.target, body);
    }
    case 'command':
      if (!config.target) {
        throw new Error('The command notifier needs a command ([notify] target = ...).');
      }
      // Summary as argv, full payload on stdin, so a simple script can use
      // either without parsing.
      return run(config.target, [summary], JSON.stringify(payload));
    default:
      throw new Error(`Unknown notifier '${config.kind}'. Use desktop, webhook or command.`);
  }
}
