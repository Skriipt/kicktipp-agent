import ora, { type Ora } from 'ora';

let spinner: Ora | null = null;

export function status(msg: string): void {
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
