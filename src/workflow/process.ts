import { spawn } from 'node:child_process';

export interface ProcessOptions {
  cwd?: string;
  input?: string;
  signal: AbortSignal;
  env?: NodeJS.ProcessEnv;
  maxOutputBytes?: number;
}
export type RunProcess = (executable: string, args: string[], options: ProcessOptions) => Promise<string>;

/** No shell, bounded output, and process-group cancellation including grandchildren. */
export const runProcess: RunProcess = (executable, args, options) => {
  options.signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, {
      cwd: options.cwd, env: options.env ?? process.env, shell: false,
      detached: process.platform !== 'win32', stdio: ['pipe', 'pipe', 'pipe'],
    });
    let output = ''; let bytes = 0; let failed = false;
    const kill = () => {
      failed = true;
      try {
        if (process.platform !== 'win32' && child.pid) process.kill(-child.pid, 'SIGKILL');
        else child.kill('SIGKILL');
      } catch { /* Process already exited. */ }
    };
    options.signal.addEventListener('abort', kill, { once: true });
    if (options.signal.aborted) kill();
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      bytes += Buffer.byteLength(chunk);
      if (bytes > (options.maxOutputBytes ?? 2_000_000)) kill();
      else output += chunk;
    });
    // Never surface stderr: adapters may emit authentication data or private URLs.
    child.stderr.on('data', (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > (options.maxOutputBytes ?? 2_000_000)) kill();
    });
    child.stdin.on('error', () => {});
    child.on('error', () => {
      options.signal.removeEventListener('abort', kill);
      reject(new Error('Workflow process unavailable'));
    });
    child.on('close', code => {
      options.signal.removeEventListener('abort', kill);
      // Reap any descendants that outlived the direct child.
      if (process.platform !== 'win32' && child.pid) {
        try { process.kill(-child.pid, 'SIGKILL'); } catch { /* Already gone. */ }
      }
      if (failed || code !== 0) reject(new Error('Workflow process failed or cancelled'));
      else resolve(output);
    });
    child.stdin.end(options.input ?? '');
  });
};
