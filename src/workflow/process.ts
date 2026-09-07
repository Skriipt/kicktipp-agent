import { spawn } from 'node:child_process';

export interface ProcessOptions {
  cwd?: string;
  input?: string;
  signal: AbortSignal;
  env?: NodeJS.ProcessEnv;
  maxOutputBytes?: number;
}
export type RunProcess = (executable: string, args: string[], options: ProcessOptions) => Promise<string>;

const providerCodes = ['invalid_json_schema', 'invalid_api_key', 'authentication_error',
  'rate_limit_exceeded', 'insufficient_quota', 'model_not_found', 'invalid_request_error'] as const;
type FailureReason = typeof providerCodes[number] | 'process_exit' | 'process_unavailable' | 'cancelled' | 'output_limit';

/** Only fixed error codes and OS exit metadata may cross the process boundary. */
export class WorkflowProcessError extends Error {
  constructor(readonly reason: FailureReason, readonly exitCode: number | null = null, readonly exitSignal: NodeJS.Signals | null = null) {
    super(`Workflow process failed: ${reason}${exitCode === null ? '' : ` (exit ${exitCode})`}${exitSignal ? ` (${exitSignal})` : ''}`);
    this.name = 'WorkflowProcessError';
  }
}

/** No shell, bounded output, and process-group cancellation including grandchildren. */
export const runProcess: RunProcess = (executable, args, options) => {
  options.signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, {
      cwd: options.cwd, env: options.env ?? process.env, shell: false,
      detached: process.platform !== 'win32', stdio: ['pipe', 'pipe', 'pipe'],
    });
    let output = ''; let bytes = 0; let failure: FailureReason | undefined;
    let stderrTail = ''; let providerCode: typeof providerCodes[number] | undefined;
    const kill = (reason: FailureReason) => {
      failure ??= reason;
      try {
        if (process.platform !== 'win32' && child.pid) process.kill(-child.pid, 'SIGKILL');
        else child.kill('SIGKILL');
      } catch { /* Process already exited. */ }
    };
    const abort = () => kill('cancelled');
    options.signal.addEventListener('abort', abort, { once: true });
    if (options.signal.aborted) abort();
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      bytes += Buffer.byteLength(chunk);
      if (bytes > (options.maxOutputBytes ?? 2_000_000)) kill('output_limit');
      else output += chunk;
    });
    // Inspect a bounded tail for known API codes, never expose raw stderr.
    child.stderr.on('data', (chunk: Buffer) => {
      bytes += chunk.length;
      stderrTail = (stderrTail + chunk.toString('utf8')).slice(-16_384);
      for (const code of providerCodes) {
        if (new RegExp(`"(?:code|type)"\\s*:\\s*"${code}"`).test(stderrTail)) { providerCode = code; break; }
      }
      if (bytes > (options.maxOutputBytes ?? 2_000_000)) kill('output_limit');
    });
    child.stdin.on('error', () => {});
    child.on('error', () => {
      options.signal.removeEventListener('abort', abort);
      reject(new WorkflowProcessError('process_unavailable'));
    });
    child.on('close', (code, signal) => {
      options.signal.removeEventListener('abort', abort);
      // Reap any descendants that outlived the direct child.
      if (process.platform !== 'win32' && child.pid) {
        try { process.kill(-child.pid, 'SIGKILL'); } catch { /* Already gone. */ }
      }
      if (failure || code !== 0) reject(new WorkflowProcessError(failure ?? providerCode ?? 'process_exit', code, signal));
      else resolve(output);
    });
    child.stdin.end(options.input ?? '');
  });
};
