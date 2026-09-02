let active = false;
let silenced = false;

/**
 * The dashboard owns the terminal, so suppress CLI status output while it runs.
 */
export function silenceStatus(on: boolean): void {
  if (on) statusClear();
  silenced = on;
}

export function status(msg: string): void {
  if (silenced || !process.stderr.isTTY) return;
  process.stderr.write(`\r\x1b[2K${msg}`);
  active = true;
}

export function statusClear(): void {
  if (!active) return;
  process.stderr.write('\r\x1b[2K');
  active = false;
}
