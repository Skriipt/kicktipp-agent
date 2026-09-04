import crypto from 'crypto';
import { Command } from 'commander';
import { ask } from '../shared.js';
import { emitJson, setJsonMode } from '../helpers/output.js';
import { validateDiscordWebhookUrl } from '../service/discord.js';
import { testNotificationTarget } from '../service/delivery.js';
import { validateNtfyServerUrl, validateNtfyToken, validateNtfyTopic } from '../service/ntfy.js';
import { validateTelegramBotToken } from '../service/telegram.js';
import {
  TargetAlreadyExistsError,
  addDiscordTarget,
  addNtfyTarget,
  addTelegramTarget,
  addWebhookTarget,
  listTargets,
  removeTarget,
  setTargetEnabled,
  validateDiscordTargetInput,
  validateNtfyTargetInput,
  validateTelegramTargetInput,
  validateWebhookHeaderValue,
  validateWebhookTargetInput,
  validateWebhookUrl,
  writeLocalSecrets,
} from '../service/targets.js';

interface AddOptions {
  provider: string;
  name?: string;
  urlRef?: string;
  webhookUrlRef?: string;
  botTokenRef?: string;
  chatId?: string;
  topicId?: string;
  serverUrl?: string;
  topic?: string;
  tokenRef?: string;
  header: string[];
  allowInsecureHttp?: boolean;
  disabled?: boolean;
}

function collect(value: string, values: string[]): string[] {
  return [...values, value];
}

function parseHeaders(values: string[]): Record<string, string> {
  const headers: Record<string, string> = Object.create(null) as Record<string, string>;
  const names = new Set<string>();
  for (const value of values) {
    const separator = value.indexOf('=');
    if (separator <= 0 || separator === value.length - 1) {
      throw new Error('Each --header must be NAME=SECRET_REFERENCE.');
    }
    const name = value.slice(0, separator);
    const canonical = name.toLowerCase();
    if (names.has(canonical)) throw new Error('Additional header names must be unique.');
    names.add(canonical);
    headers[name] = value.slice(separator + 1);
  }
  return headers;
}

async function askMasked(question: string): Promise<string> {
  if (!process.stdin.isTTY) throw new Error('A Secret Reference is required in noninteractive use.');
  process.stdout.write(question);
  const stdin = process.stdin;
  const wasRaw = stdin.isRaw;
  stdin.setRawMode(true);
  stdin.resume();
  return new Promise((resolve, reject) => {
    let value = '';
    const finish = (error?: Error) => {
      stdin.removeListener('data', onData);
      stdin.setRawMode(wasRaw ?? false);
      process.stdout.write('\n');
      if (error) reject(error);
      else resolve(value);
    };
    const onData = (data: Buffer) => {
      for (const character of data.toString()) {
        if (character === '\r' || character === '\n') return finish();
        if (character === '\u0003') return finish(new Error('Cancelled.'));
        if (character === '\u007f') value = value.slice(0, -1);
        else value += character;
      }
    };
    stdin.on('data', onData);
  });
}

function localKey(): string {
  return `target.${crypto.randomUUID()}`;
}

async function resolveAddInput(idArgument: string | undefined, options: AddOptions) {
  const id = (idArgument ?? (process.stdin.isTTY ? await ask('Target ID: ') : '')).trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(id)) {
    throw new Error('A valid Notification Target ID is required.');
  }
  if (listTargets().some((target) => target.id === id)) throw new TargetAlreadyExistsError();

  const localSecrets: Record<string, string> = {};
  if (options.provider === 'discord') {
    if (
      options.urlRef
      || options.botTokenRef
      || options.chatId
      || options.topicId
      || options.serverUrl
      || options.topic
      || options.tokenRef
      || options.header.length > 0
      || options.allowInsecureHttp
    ) {
      throw new Error('Discord Targets accept only --webhook-url-ref.');
    }
    let webhookUrlRef = options.webhookUrlRef;
    if (!webhookUrlRef) {
      const url = await askMasked('Discord Webhook URL (stored locally): ');
      validateDiscordWebhookUrl(url);
      const key = localKey();
      localSecrets[key] = url;
      webhookUrlRef = `local:${key}`;
    }
    return { provider: 'discord' as const, id, webhookUrlRef, localSecrets };
  }
  if (options.provider === 'telegram') {
    if (
      options.urlRef
      || options.webhookUrlRef
      || options.header.length > 0
      || options.allowInsecureHttp
      || options.serverUrl
      || options.topic
      || options.tokenRef
    ) {
      throw new Error('Telegram Targets accept only --bot-token-ref, --chat-id, and --topic-id.');
    }
    const chatId = (options.chatId ?? (process.stdin.isTTY ? await ask('Telegram Chat ID: ') : '')).trim();
    if (!chatId) throw new Error('A Telegram Chat ID is required.');
    let topicId: number | undefined;
    if (options.topicId !== undefined) {
      topicId = /^\d+$/u.test(options.topicId) ? Number(options.topicId) : Number.NaN;
      if (!Number.isSafeInteger(topicId) || topicId <= 0) {
        throw new Error('Telegram Topic ID must be a positive integer.');
      }
    }
    let botTokenRef = options.botTokenRef;
    if (!botTokenRef) {
      const token = await askMasked('Telegram Bot Token (stored locally): ');
      validateTelegramBotToken(token);
      const key = localKey();
      localSecrets[key] = token;
      botTokenRef = `local:${key}`;
    }
    return { provider: 'telegram' as const, id, botTokenRef, chatId, topicId, localSecrets };
  }
  if (options.provider === 'ntfy') {
    if (
      options.urlRef
      || options.webhookUrlRef
      || options.botTokenRef
      || options.chatId
      || options.topicId
      || options.header.length > 0
    ) throw new Error('ntfy Targets accept only --server-url, --topic, --token-ref, and --allow-insecure-http.');
    const serverUrl = (options.serverUrl ?? (process.stdin.isTTY ? await ask('ntfy Server URL: ') : '')).trim();
    validateNtfyServerUrl(serverUrl, options.allowInsecureHttp);
    const topic = (options.topic ?? (process.stdin.isTTY ? await ask('ntfy Topic: ') : '')).trim();
    validateNtfyTopic(topic);
    let tokenRef = options.tokenRef;
    if (!tokenRef && process.stdin.isTTY) {
      const token = await askMasked('ntfy Access Token (blank for anonymous): ');
      if (token) {
        validateNtfyToken(token);
        const key = localKey();
        localSecrets[key] = token;
        tokenRef = `local:${key}`;
      }
    }
    return { provider: 'ntfy' as const, id, serverUrl, topic, tokenRef, localSecrets };
  }
  if (options.provider !== 'webhook') throw new Error('Provider must be discord, telegram, ntfy, or webhook.');
  if (
    options.webhookUrlRef
    || options.botTokenRef
    || options.chatId
    || options.topicId
    || options.serverUrl
    || options.topic
    || options.tokenRef
  ) {
    throw new Error('Provider-specific options do not apply to Generic Webhook Targets.');
  }

  const headers = parseHeaders(options.header);
  let urlRef = options.urlRef;
  if (!urlRef) {
    const url = await askMasked('Webhook URL (stored locally): ');
    validateWebhookUrl(url, options.allowInsecureHttp);
    const key = localKey();
    localSecrets[key] = url;
    urlRef = `local:${key}`;
  }

  if (process.stdin.isTTY && options.header.length === 0) {
    while (true) {
      const name = (await ask('Additional header name (blank to finish): ')).trim();
      if (!name) break;
      const value = await askMasked('Header value (stored locally): ');
      validateWebhookHeaderValue(value);
      const key = localKey();
      localSecrets[key] = value;
      headers[name] = `local:${key}`;
    }
  }
  return { provider: 'webhook' as const, id, urlRef, headers, localSecrets };
}

export function registerTargetsCommand(program: Command): void {
  const targets = program
    .command('targets')
    .description('Manage Service Notification Targets');

  targets
    .command('add')
    .description('Add a Discord, Telegram, ntfy, or Generic Webhook Notification Target')
    .argument('[id]', 'Stable Notification Target ID')
    .option('--provider <provider>', 'Notification Target provider', 'webhook')
    .option('--name <name>', 'Display name')
    .option('--url-ref <reference>', 'Webhook URL Secret Reference')
    .option('--webhook-url-ref <reference>', 'Discord Webhook URL Secret Reference')
    .option('--bot-token-ref <reference>', 'Telegram Bot Token Secret Reference')
    .option('--chat-id <id>', 'Telegram Chat ID')
    .option('--topic-id <id>', 'Optional Telegram Topic ID')
    .option('--server-url <url>', 'ntfy server root URL')
    .option('--topic <topic>', 'ntfy topic')
    .option('--token-ref <reference>', 'Optional ntfy Access Token Secret Reference')
    .option('--header <name=reference>', 'Secret-valued additional header', collect, [])
    .option('--allow-insecure-http', 'Explicitly allow a plain HTTP ntfy or Webhook URL')
    .option('--disabled', 'Create the Notification Target disabled')
    .action(async (idArgument: string | undefined, options: AddOptions) => {
      const resolved = await resolveAddInput(idArgument, options);
      if (resolved.provider === 'discord') {
        const input = {
          id: resolved.id,
          name: options.name,
          enabled: !options.disabled,
          webhookUrlRef: resolved.webhookUrlRef,
        };
        validateDiscordTargetInput(input);
        if (Object.keys(resolved.localSecrets).length > 0) writeLocalSecrets(resolved.localSecrets);
        addDiscordTarget(input);
        console.log(`Added Discord Notification Target ${resolved.id}.`);
        return;
      }
      if (resolved.provider === 'telegram') {
        const input = {
          id: resolved.id,
          name: options.name,
          enabled: !options.disabled,
          botTokenRef: resolved.botTokenRef,
          chatId: resolved.chatId,
          topicId: resolved.topicId,
        };
        validateTelegramTargetInput(input);
        if (Object.keys(resolved.localSecrets).length > 0) writeLocalSecrets(resolved.localSecrets);
        addTelegramTarget(input);
        console.log(`Added Telegram Notification Target ${resolved.id}.`);
        return;
      }
      if (resolved.provider === 'ntfy') {
        const input = {
          id: resolved.id,
          name: options.name,
          enabled: !options.disabled,
          serverUrl: resolved.serverUrl,
          topic: resolved.topic,
          tokenRef: resolved.tokenRef,
          allowInsecureHttp: options.allowInsecureHttp,
        };
        validateNtfyTargetInput(input);
        if (Object.keys(resolved.localSecrets).length > 0) writeLocalSecrets(resolved.localSecrets);
        addNtfyTarget(input);
        console.log(`Added ntfy Notification Target ${resolved.id}.`);
        return;
      }
      const input = {
        id: resolved.id,
        name: options.name,
        enabled: !options.disabled,
        urlRef: resolved.urlRef,
        headers: resolved.headers,
        allowInsecureHttp: options.allowInsecureHttp,
      };
      validateWebhookTargetInput(input);
      if (Object.keys(resolved.localSecrets).length > 0) writeLocalSecrets(resolved.localSecrets);
      addWebhookTarget(input);
      console.log(`Added Generic Webhook Notification Target ${resolved.id}.`);
    });

  targets
    .command('list')
    .description('List Notification Targets without Secret References or values')
    .option('--json', 'Output JSON')
    .action((options: { json?: boolean }) => {
      if (options.json) setJsonMode(true);
      const summaries = listTargets();
      if (options.json) {
        emitJson({ targets: summaries });
        return;
      }
      for (const target of summaries) {
        const secrets = target.secrets.map((secret) => `${secret.purpose}:${secret.sourceClass}`).join(', ');
        console.log(`${target.id}  ${target.provider}  ${target.enabled ? 'enabled' : 'disabled'}  ${target.revision}  ${secrets || 'no secrets'}`);
      }
    });

  targets
    .command('test')
    .description('Send one diagnostic message to a Notification Target')
    .argument('<id>', 'Notification Target ID')
    .action(async (id: string) => {
      const outcome = await testNotificationTarget(id);
      console.log(`Notification Target test: ${outcome.state}.`);
      if (outcome.state !== 'confirmed') process.exitCode = 1;
    });

  for (const enabled of [true, false]) {
    targets
      .command(enabled ? 'enable' : 'disable')
      .description(`${enabled ? 'Enable' : 'Disable'} a Notification Target`)
      .argument('<id>', 'Notification Target ID')
      .action((id: string) => {
        setTargetEnabled(id, enabled);
        console.log(`${enabled ? 'Enabled' : 'Disabled'} Notification Target ${id}.`);
      });
  }

  targets
    .command('remove')
    .description('Remove a Notification Target and its Reminder Job reference')
    .argument('<id>', 'Notification Target ID')
    .action((id: string) => {
      removeTarget(id);
      console.log(`Removed Notification Target ${id}.`);
    });
}
