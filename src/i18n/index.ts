import { de } from './de.js';
import { en } from './en.js';

export type Language = 'en' | 'de';

/** Same keys as English; values may differ (the German catalog). */
type DeepStringify<T> = T extends string ? string : { [K in keyof T]: DeepStringify<T[K]> };

export type Catalog = DeepStringify<typeof en>;

type NestedKeyOf<T> = T extends string
  ? never
  : {
      [K in keyof T & string]: T[K] extends string ? K : `${K}.${NestedKeyOf<T[K]>}`;
    }[keyof T & string];

export type MessageKey = NestedKeyOf<Catalog>;

const catalogs: Record<Language, Catalog> = { en, de };

let current: Language = 'en';

export function currentLanguage(): Language {
  return current;
}

export function setLanguage(language: Language): void {
  current = language;
}

export function isLanguage(value: string): value is Language {
  return value === 'en' || value === 'de';
}

/** Reject unknown spellings. Empty / missing is not an error. */
export function parseLanguage(raw: string | undefined | null): Language | undefined {
  if (raw == null) return undefined;
  const value = raw.trim().toLowerCase();
  if (!value) return undefined;
  if (isLanguage(value)) return value;
  throw new Error(en.i18n.unknown.replace('{value}', raw.trim()));
}

export function langFromArgv(argv: string[]): string | undefined {
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--lang' || arg === '-L') return argv[i + 1];
    if (arg.startsWith('--lang=')) return arg.slice('--lang='.length);
  }
  return undefined;
}

export function resolveLanguage(opts?: {
  argv?: string[];
  env?: NodeJS.ProcessEnv;
  configLanguage?: string | null;
}): Language {
  const argv = opts?.argv ?? process.argv;
  const env = opts?.env ?? process.env;
  const fromFlag = parseLanguage(langFromArgv(argv));
  if (fromFlag) return fromFlag;
  const fromEnv = parseLanguage(env.KICKTIPP_LANG);
  if (fromEnv) return fromEnv;
  const fromConfig = parseLanguage(opts?.configLanguage);
  if (fromConfig) return fromConfig;
  return 'en';
}

function lookup(catalog: Catalog, key: MessageKey): string {
  let cur: unknown = catalog;
  for (const part of key.split('.')) {
    if (typeof cur !== 'object' || cur === null || !(part in cur)) {
      throw new Error(`Missing i18n key '${key}'`);
    }
    cur = (cur as Record<string, unknown>)[part];
  }
  if (typeof cur !== 'string') throw new Error(`i18n key '${key}' is not a string`);
  return cur;
}

export function flattenKeys(node: object, prefix = ''): string[] {
  const keys: string[] = [];
  for (const [name, value] of Object.entries(node)) {
    const path = prefix ? `${prefix}.${name}` : name;
    if (typeof value === 'string') keys.push(path);
    else if (value && typeof value === 'object') keys.push(...flattenKeys(value, path));
  }
  return keys;
}

export function t(key: MessageKey, vars?: Record<string, string | number>): string {
  let text = lookup(catalogs[current], key);
  if (!vars) return text;
  for (const [name, value] of Object.entries(vars)) {
    text = text.replaceAll(`{${name}}`, String(value));
  }
  return text;
}

export { en, de };
