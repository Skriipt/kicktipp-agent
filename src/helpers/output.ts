/**
 * JSON mode is a process-wide switch rather than a parameter because the
 * top-level error handler needs it too: in JSON mode a failure has to come
 * out as JSON on stdout, not as prose on stderr.
 */
let jsonMode = false;

export function setJsonMode(on: boolean): void {
  jsonMode = on;
}

export function isJsonMode(): boolean {
  return jsonMode;
}

/** The only place that writes machine-readable output to stdout. */
export function emitJson(value: unknown): void {
  console.log(JSON.stringify(value, null, 2));
}

export function emitError(err: unknown): void {
  const message = err instanceof Error ? err.message : String(err);
  if (jsonMode) emitJson({ error: message });
  else console.error(message);
}

/** Width of the widest entry, for column alignment. */
export function widest(values: string[], min = 0): number {
  return Math.max(min, ...values.map((v) => v.length));
}
