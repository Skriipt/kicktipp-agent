import ora, { type Ora } from 'ora';

let spinner: Ora | null = null;
let silenced = false;

/**
 * The dashboard owns stdin and the alt screen. ora's default
 * `discardStdin` pauses stdin and drops raw mode when the spinner
 * stops, which makes the TUI paint once and then exit.
 */
export function silenceStatus(on: boolean): void {
  if (on) statusClear();
  silenced = on;
}

export function status(msg: string): void {
  if (silenced) return;
  if (spinner) {
    spinner.text = msg;
  } else {
    spinner = ora(msg).start();
  }
}

export function statusClear(): void {
  if (spinner) {
    spinner.stop();
    spinner = null;
  }
}
