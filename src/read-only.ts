import { readConfig } from './config.js';

/**
 * Read-only mode lets someone connect an assistant (or open a shell) with a
 * hard guarantee that nothing can be submitted to Kicktipp. It is enforced in
 * three places on purpose: mutating MCP tools are never registered, CLI
 * commands refuse up front, and the submitting functions themselves check
 * again — so a future wiring mistake still cannot place a bet.
 */
export function isReadOnly(): boolean {
  const env = process.env.KICKTIPP_READ_ONLY;
  if (env !== undefined) return env !== '' && env !== '0' && env.toLowerCase() !== 'false';
  return readConfig().server?.read_only === true || readConfig().server?.read_only === 'true';
}

export class ReadOnlyError extends Error {
  constructor(action = 'This action') {
    super(
      `${action} is blocked: kicktipp-agent is running in read-only mode ` +
        '(unset KICKTIPP_READ_ONLY, or remove read_only from the [server] config section).',
    );
  }
}

/** Throw unless writes are permitted. Used by the CLI and by core.ts. */
export function assertWritable(action = 'This action'): void {
  if (isReadOnly()) throw new ReadOnlyError(action);
}
