import crypto from 'crypto';
import fs from 'fs';
import * as ini from 'ini';
import { FileLock } from './lock.js';
import { servicePaths, type ServicePaths } from './paths.js';
import {
  ConfigurationConflictError,
  durableReplace,
  fileRevision,
  mutateServiceConfiguration,
  notificationTargetSchema,
  readServiceConfiguration,
  secretReferenceSchema,
  type NotificationTarget,
  type ServiceConfiguration,
} from './store.js';

export type SecretSource = 'env' | 'file' | 'local';
export type SecretReference = `${SecretSource}:${string}`;
export type DiscordTarget = Extract<NotificationTarget, { provider: 'discord' }>;
export type TelegramTarget = Extract<NotificationTarget, { provider: 'telegram' }>;
export type NtfyTarget = Extract<NotificationTarget, { provider: 'ntfy' }>;
export type WebhookTarget = Extract<NotificationTarget, { provider: 'webhook' }>;

export class SecretResolutionError extends Error {
  constructor(readonly code: 'invalid_reference' | 'ambiguous_source' | 'unavailable' | 'empty' | 'insecure_local_store') {
    super({
      invalid_reference: 'The Secret Reference is invalid.',
      ambiguous_source: 'The Secret has more than one configured source.',
      unavailable: 'The Secret could not be read.',
      empty: 'The resolved Secret is empty.',
      insecure_local_store: 'The local Secret store is not owner-only.',
    }[code]);
    this.name = 'SecretResolutionError';
  }
}

export class LocalSecretStoreError extends Error {
  constructor() {
    super('The local Secret store could not be updated.');
    this.name = 'LocalSecretStoreError';
  }
}

export class InvalidWebhookTargetError extends Error {
  constructor(readonly code: 'invalid_url' | 'insecure_http' | 'invalid_header_value') {
    super({
      invalid_url: 'The resolved Webhook URL is invalid.',
      insecure_http: 'Plain HTTP requires --allow-insecure-http.',
      invalid_header_value: 'A resolved Webhook header value is invalid.',
    }[code]);
    this.name = 'InvalidWebhookTargetError';
  }
}

export class TargetAlreadyExistsError extends Error {
  constructor() {
    super('A Notification Target with that ID already exists.');
    this.name = 'TargetAlreadyExistsError';
  }
}

export class TargetNotFoundError extends Error {
  constructor() {
    super('The Notification Target does not exist.');
    this.name = 'TargetNotFoundError';
  }
}

export class InvalidNotificationTargetError extends Error {
  constructor() {
    super('The Notification Target configuration is invalid.');
    this.name = 'InvalidNotificationTargetError';
  }
}

function parseSecretReference(reference: string): SecretReference {
  const parsed = secretReferenceSchema.safeParse(reference);
  if (!parsed.success) throw new SecretResolutionError('invalid_reference');
  return parsed.data as SecretReference;
}

export function secretSource(reference: string): SecretSource {
  return parseSecretReference(reference).slice(0, reference.indexOf(':')) as SecretSource;
}

function trimOneFileNewline(value: string): string {
  if (value.endsWith('\r\n')) return value.slice(0, -2);
  if (value.endsWith('\n')) return value.slice(0, -1);
  return value;
}

function requireSecret(value: string, fromFile: boolean): string {
  const result = fromFile ? trimOneFileNewline(value) : value;
  if (result.length === 0) throw new SecretResolutionError('empty');
  return result;
}

function readSecretFile(file: string): string {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    throw new SecretResolutionError('unavailable');
  }
}

function readLocalSecret(key: string, paths: ServicePaths): string {
  let stat: fs.Stats;
  try {
    stat = fs.statSync(paths.secretsFile);
  } catch {
    throw new SecretResolutionError('unavailable');
  }
  if (process.platform !== 'win32') {
    const wrongMode = (stat.mode & 0o777) !== 0o600;
    const wrongOwner = typeof process.getuid === 'function' && stat.uid !== process.getuid();
    if (wrongMode || wrongOwner) throw new SecretResolutionError('insecure_local_store');
  }
  try {
    const parsed = ini.parse(fs.readFileSync(paths.secretsFile, 'utf8')) as Record<string, unknown>;
    const secrets = parsed.secrets;
    if (!secrets || typeof secrets !== 'object' || !Object.hasOwn(secrets, key)) {
      throw new SecretResolutionError('unavailable');
    }
    const value = (secrets as Record<string, unknown>)[key];
    if (!['string', 'boolean', 'number'].includes(typeof value) && value !== null) {
      throw new SecretResolutionError('unavailable');
    }
    return requireSecret(String(value), false);
  } catch (error) {
    if (error instanceof SecretResolutionError) throw error;
    throw new SecretResolutionError('unavailable');
  }
}

export function resolveSecretReference(
  rawReference: string,
  options: { env?: NodeJS.ProcessEnv; paths?: ServicePaths } = {},
): string {
  const reference = parseSecretReference(rawReference);
  const separator = reference.indexOf(':');
  const source = reference.slice(0, separator) as SecretSource;
  const identifier = reference.slice(separator + 1);
  const env = options.env ?? process.env;
  const paths = options.paths ?? servicePaths(env);

  if (source === 'file') return requireSecret(readSecretFile(identifier), true);
  if (source === 'local') return readLocalSecret(identifier, paths);

  const directConfigured = Object.hasOwn(env, identifier) && env[identifier] !== undefined;
  const fileName = `${identifier}_FILE`;
  const fileConfigured = Object.hasOwn(env, fileName) && env[fileName] !== undefined;
  if (directConfigured && fileConfigured) throw new SecretResolutionError('ambiguous_source');
  if (fileConfigured) return requireSecret(readSecretFile(env[fileName] ?? ''), true);
  if (directConfigured) return requireSecret(env[identifier] ?? '', false);
  throw new SecretResolutionError('unavailable');
}

function readLocalSecrets(paths: ServicePaths): Record<string, string> {
  if (!fs.existsSync(paths.secretsFile)) return {};
  const stat = fs.statSync(paths.secretsFile);
  if (process.platform !== 'win32') {
    const wrongMode = (stat.mode & 0o777) !== 0o600;
    const wrongOwner = typeof process.getuid === 'function' && stat.uid !== process.getuid();
    if (wrongMode || wrongOwner) throw new SecretResolutionError('insecure_local_store');
  }
  const parsed = ini.parse(fs.readFileSync(paths.secretsFile, 'utf8')) as Record<string, unknown>;
  if (parsed.secrets === undefined) return {};
  if (!parsed.secrets || typeof parsed.secrets !== 'object') throw new LocalSecretStoreError();
  const result: Record<string, string> = Object.create(null) as Record<string, string>;
  for (const [key, value] of Object.entries(parsed.secrets)) {
    if (!['string', 'boolean', 'number'].includes(typeof value) && value !== null) {
      throw new LocalSecretStoreError();
    }
    result[key] = String(value);
  }
  return result;
}

export function writeLocalSecrets(
  entries: Record<string, string>,
  paths: ServicePaths = servicePaths(),
): void {
  for (const [key, value] of Object.entries(entries)) {
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(key) || value.length === 0) {
      throw new LocalSecretStoreError();
    }
  }
  const lock = FileLock.acquire(paths.configurationLockFile);
  try {
    const revision = fileRevision(paths.secretsFile);
    const secrets = { ...readLocalSecrets(paths), ...entries };
    if (fileRevision(paths.secretsFile) !== revision) throw new ConfigurationConflictError();
    durableReplace(paths.secretsFile, ini.stringify({ secrets }));
  } catch (error) {
    if (error instanceof ConfigurationConflictError || error instanceof SecretResolutionError) throw error;
    throw new LocalSecretStoreError();
  } finally {
    lock.release();
  }
}

function canonicalTarget(target: NotificationTarget): object {
  switch (target.provider) {
    case 'discord':
      return { revisionSchema: 1, provider: target.provider, webhookUrlRef: target.webhookUrlRef };
    case 'telegram':
      return {
        revisionSchema: 1,
        provider: target.provider,
        botTokenRef: target.botTokenRef,
        chatId: target.chatId,
        topicId: target.topicId ?? null,
      };
    case 'ntfy':
      return {
        revisionSchema: 1,
        provider: target.provider,
        serverUrl: target.serverUrl,
        topic: target.topic,
        tokenRef: target.tokenRef ?? null,
        allowInsecureHttp: target.allowInsecureHttp ?? false,
      };
    case 'webhook':
      return {
        revisionSchema: 1,
        provider: target.provider,
        urlRef: target.urlRef,
        headers: Object.entries(target.headers ?? {})
          .map(([name, reference]) => ({ name: name.toLowerCase(), reference }))
          .sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0),
        allowInsecureHttp: target.allowInsecureHttp ?? false,
      };
  }
}

export function targetRevision(target: NotificationTarget): string {
  return crypto.createHash('sha256').update(JSON.stringify(canonicalTarget(target))).digest('hex');
}

export interface TargetSummary {
  id: string;
  provider: NotificationTarget['provider'];
  enabled: boolean;
  revision: string;
  secrets: Array<{ purpose: string; configured: true; sourceClass: SecretSource }>;
  doctorWarnings?: Array<{ code: 'insecure_http'; blocking: false }>;
}

function targetSecretReferences(target: NotificationTarget): Array<[string, string]> {
  switch (target.provider) {
    case 'discord': return [['webhook-url', target.webhookUrlRef]];
    case 'telegram': return [['bot-token', target.botTokenRef]];
    case 'ntfy': return target.tokenRef ? [['token', target.tokenRef]] : [];
    case 'webhook': return [
      ['url', target.urlRef],
      ...Object.values(target.headers ?? {}).map((reference): [string, string] => ['header', reference]),
    ];
  }
}

export function summarizeTarget(target: NotificationTarget): TargetSummary {
  return {
    id: target.id,
    provider: target.provider,
    enabled: target.enabled,
    revision: targetRevision(target),
    secrets: targetSecretReferences(target).map(([purpose, reference]) => ({
      purpose,
      configured: true,
      sourceClass: secretSource(reference),
    })),
    ...(target.provider === 'ntfy'
      && new URL(target.serverUrl).protocol === 'http:'
      ? { doctorWarnings: [{ code: 'insecure_http', blocking: false }] }
      : {}),
  };
}

export function listTargets(paths: ServicePaths = servicePaths()): TargetSummary[] {
  return readServiceConfiguration(paths).targets.map(summarizeTarget);
}

export interface AddWebhookTargetInput {
  id: string;
  name?: string;
  enabled?: boolean;
  urlRef: string;
  headers?: Record<string, string>;
  allowInsecureHttp?: boolean;
}

export interface AddDiscordTargetInput {
  id: string;
  name?: string;
  enabled?: boolean;
  webhookUrlRef: string;
}

export interface AddTelegramTargetInput {
  id: string;
  name?: string;
  enabled?: boolean;
  botTokenRef: string;
  chatId: string;
  topicId?: number;
}

export interface AddNtfyTargetInput {
  id: string;
  name?: string;
  enabled?: boolean;
  serverUrl: string;
  topic: string;
  tokenRef?: string;
  allowInsecureHttp?: boolean;
}

function addTarget(target: NotificationTarget, paths: ServicePaths): ServiceConfiguration {
  return mutateServiceConfiguration((configuration) => {
    if (configuration.targets.some((existing) => existing.id === target.id)) {
      throw new TargetAlreadyExistsError();
    }
    configuration.targets.push(target);
    configuration.job.targetIds.push(target.id);
    return configuration;
  }, paths);
}

function buildDiscordTarget(input: AddDiscordTargetInput): DiscordTarget {
  const parsed = notificationTargetSchema.safeParse({
    id: input.id,
    ...(input.name ? { name: input.name } : {}),
    enabled: input.enabled ?? true,
    provider: 'discord',
    webhookUrlRef: parseSecretReference(input.webhookUrlRef),
  });
  if (!parsed.success || parsed.data.provider !== 'discord') {
    throw new InvalidNotificationTargetError();
  }
  return parsed.data;
}

export function validateDiscordTargetInput(input: AddDiscordTargetInput): void {
  buildDiscordTarget(input);
}

export function addDiscordTarget(
  input: AddDiscordTargetInput,
  paths: ServicePaths = servicePaths(),
): ServiceConfiguration {
  return addTarget(buildDiscordTarget(input), paths);
}

function buildTelegramTarget(input: AddTelegramTargetInput): TelegramTarget {
  const parsed = notificationTargetSchema.safeParse({
    id: input.id,
    ...(input.name ? { name: input.name } : {}),
    enabled: input.enabled ?? true,
    provider: 'telegram',
    botTokenRef: parseSecretReference(input.botTokenRef),
    chatId: input.chatId,
    ...(input.topicId === undefined ? {} : { topicId: input.topicId }),
  });
  if (!parsed.success || parsed.data.provider !== 'telegram') {
    throw new InvalidNotificationTargetError();
  }
  return parsed.data;
}

export function validateTelegramTargetInput(input: AddTelegramTargetInput): void {
  buildTelegramTarget(input);
}

export function addTelegramTarget(
  input: AddTelegramTargetInput,
  paths: ServicePaths = servicePaths(),
): ServiceConfiguration {
  return addTarget(buildTelegramTarget(input), paths);
}

function buildNtfyTarget(input: AddNtfyTargetInput): NtfyTarget {
  const parsed = notificationTargetSchema.safeParse({
    id: input.id,
    ...(input.name ? { name: input.name } : {}),
    enabled: input.enabled ?? true,
    provider: 'ntfy',
    serverUrl: input.serverUrl,
    topic: input.topic,
    ...(input.tokenRef ? { tokenRef: parseSecretReference(input.tokenRef) } : {}),
    ...(input.allowInsecureHttp ? { allowInsecureHttp: true } : {}),
  });
  if (!parsed.success || parsed.data.provider !== 'ntfy') {
    throw new InvalidNotificationTargetError();
  }
  return parsed.data;
}

export function validateNtfyTargetInput(input: AddNtfyTargetInput): void {
  buildNtfyTarget(input);
}

export function addNtfyTarget(
  input: AddNtfyTargetInput,
  paths: ServicePaths = servicePaths(),
): ServiceConfiguration {
  return addTarget(buildNtfyTarget(input), paths);
}

function buildWebhookTarget(input: AddWebhookTargetInput): WebhookTarget {
  const target: WebhookTarget = {
    id: input.id,
    ...(input.name ? { name: input.name } : {}),
    enabled: input.enabled ?? true,
    provider: 'webhook',
    urlRef: parseSecretReference(input.urlRef),
    ...(input.headers && Object.keys(input.headers).length > 0
      ? { headers: Object.fromEntries(Object.entries(input.headers).map(([name, reference]) => [
        name,
        parseSecretReference(reference),
      ])) }
      : {}),
    ...(input.allowInsecureHttp ? { allowInsecureHttp: true } : {}),
  };
  const parsed = notificationTargetSchema.safeParse(target);
  if (!parsed.success || parsed.data.provider !== 'webhook') {
    throw new InvalidNotificationTargetError();
  }
  return parsed.data;
}

export function validateWebhookTargetInput(input: AddWebhookTargetInput): void {
  buildWebhookTarget(input);
}

export function addWebhookTarget(
  input: AddWebhookTargetInput,
  paths: ServicePaths = servicePaths(),
): ServiceConfiguration {
  return addTarget(buildWebhookTarget(input), paths);
}

export function setTargetEnabled(
  id: string,
  enabled: boolean,
  paths: ServicePaths = servicePaths(),
): ServiceConfiguration {
  return mutateServiceConfiguration((configuration) => {
    const target = configuration.targets.find((candidate) => candidate.id === id);
    if (!target) throw new TargetNotFoundError();
    target.enabled = enabled;
    return configuration;
  }, paths);
}

export function removeTarget(
  id: string,
  paths: ServicePaths = servicePaths(),
): ServiceConfiguration {
  return mutateServiceConfiguration((configuration) => {
    const index = configuration.targets.findIndex((candidate) => candidate.id === id);
    if (index < 0) throw new TargetNotFoundError();
    configuration.targets.splice(index, 1);
    configuration.job.targetIds = configuration.job.targetIds.filter((targetId) => targetId !== id);
    return configuration;
  }, paths);
}

export interface ResolvedWebhookTarget {
  url: string;
  headers: Record<string, string>;
}

export function validateWebhookUrl(value: string, allowInsecureHttp = false): string {
  if (
    /[\u0000-\u0020\u007f]/u.test(value)
    || value.includes('#')
    || /^[A-Za-z][A-Za-z0-9+.-]*:\/\/[^/?#]*@/u.test(value)
  ) {
    throw new InvalidWebhookTargetError('invalid_url');
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new InvalidWebhookTargetError('invalid_url');
  }
  if (url.username || url.password || url.hash || !['http:', 'https:'].includes(url.protocol)) {
    throw new InvalidWebhookTargetError('invalid_url');
  }
  if (url.protocol === 'http:' && !allowInsecureHttp) {
    throw new InvalidWebhookTargetError('insecure_http');
  }
  return url.toString();
}

export function validateWebhookHeaderValue(value: string): string {
  if (/[\u0000-\u0008\u000a-\u001f\u007f]/u.test(value)) {
    throw new InvalidWebhookTargetError('invalid_header_value');
  }
  return value;
}

export function resolveWebhookTarget(
  target: WebhookTarget,
  options: { env?: NodeJS.ProcessEnv; paths?: ServicePaths } = {},
): ResolvedWebhookTarget {
  const url = validateWebhookUrl(
    resolveSecretReference(target.urlRef, options),
    target.allowInsecureHttp,
  );
  const headers: Record<string, string> = Object.create(null) as Record<string, string>;
  for (const [name, reference] of Object.entries(target.headers ?? {})) {
    headers[name] = validateWebhookHeaderValue(resolveSecretReference(reference, options));
  }
  return { url, headers };
}
