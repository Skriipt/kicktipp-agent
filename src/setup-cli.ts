#!/usr/bin/env node
import fs from 'node:fs';
import crypto from 'node:crypto';
import readline from 'node:readline/promises';
import { Writable } from 'node:stream';
import { pathToFileURL } from 'node:url';
import { Page, login, getCommunities } from './browser.js';
import { setUrlBase } from './url.js';
import { validateChannel, sendNotification, type NotificationChannel } from './notify/backends.js';
import { readServiceConfig, serviceConfigFile, writeServiceConfig, type ServiceConfig } from './service/settings.js';

export interface SetupIO {
  ask(question: string, options?: { default?: string; secret?: boolean }): Promise<string>;
  log(message: string): void;
}

function terminalIO(): SetupIO & { close(): void } {
  if (!process.stdin.isTTY) throw new Error('Der Assistent braucht ein Terminal. Nutze docker compose run --rm kicktipp setup ohne -T.');
  let muted = false;
  const output = new Writable({ write(chunk, _encoding, done) { if (!muted) process.stdout.write(chunk); done(); } });
  const rl = readline.createInterface({ input: process.stdin, output, terminal: true });
  return {
    log: (message) => console.log(message),
    async ask(question, options = {}) {
      const suffix = options.default ? ` [${options.default}]` : '';
      process.stdout.write(`${question}${suffix}: `);
      muted = !!options.secret;
      try { return await rl.question('') || options.default || ''; }
      finally { if (muted) process.stdout.write('\n'); muted = false; }
    },
    close() { rl.close(); output.end(); },
  };
}

export async function discoverCommunities(email: string, password: string, site: 'de' | 'com'): Promise<string[]> {
  setUrlBase(`https://www.kicktipp.${site}`);
  const page = new Page();
  try { await login(page, email, password); return await getCommunities(page); }
  catch { throw new Error('Kicktipp-Anmeldung fehlgeschlagen. Prüfe E-Mail, Passwort, gewählte Seite und Verbindung.'); }
  finally { await page.close(); }
}

/** Discover only; never consume updates or replace an existing Telegram webhook. */
export async function discoverTelegramChats(botToken: string, fetchImpl = fetch): Promise<{ id: string; label: string }[]> {
  try {
    const response = await fetchImpl(`https://api.telegram.org/bot${botToken}/getUpdates`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ limit: 100, timeout: 0 }), redirect: 'error', signal: AbortSignal.timeout(15_000),
    });
    const data = await response.json() as { ok?: boolean; result?: Array<{ message?: { chat?: { id: number; title?: string; first_name?: string; username?: string } } }> };
    if (!response.ok || !data.ok || !Array.isArray(data.result)) throw new Error();
    const chats = new Map<string, string>();
    for (const update of data.result) {
      const chat = update.message?.chat;
      if (chat && Number.isSafeInteger(chat.id)) chats.set(String(chat.id), chat.title || chat.first_name || chat.username || String(chat.id));
    }
    return [...chats].map(([id, label]) => ({ id, label }));
  } catch { throw new Error('Telegram-Chats konnten nicht geladen werden. Bot-Token prüfen; bei bereits genutzten Bots die Chat-ID manuell eingeben.'); }
}

async function askYes(io: SetupIO, question: string, fallback: boolean): Promise<boolean> {
  for (;;) {
    const value = (await io.ask(`${question} (j/n)`, { default: fallback ? 'j' : 'n' })).trim().toLowerCase();
    if (['j', 'ja', 'y', 'yes'].includes(value)) return true;
    if (['n', 'nein', 'no'].includes(value)) return false;
    io.log('Bitte j oder n eingeben.');
  }
}

async function required(io: SetupIO, label: string, options: { default?: string; secret?: boolean } = {}): Promise<string> {
  for (;;) {
    const value = await io.ask(label, options);
    if (value.trim()) return options.secret ? value : value.trim();
    io.log('Dieses Feld darf nicht leer sein.');
  }
}

async function choose(io: SetupIO, label: string, items: string[], current?: string): Promise<string> {
  items.forEach((item, index) => io.log(`  ${index + 1}. ${item}`));
  const defaultIndex = Math.max(0, items.indexOf(current ?? '')) + 1;
  for (;;) {
    const value = await io.ask(label, { default: String(defaultIndex) });
    const index = Number(value) - 1;
    if (Number.isInteger(index) && items[index]) return items[index];
    io.log('Bitte eine Nummer aus der Liste auswählen.');
  }
}

interface SetupOptions {
  notificationsOnly?: boolean;
  file?: string;
  io?: SetupIO;
  communities?: typeof discoverCommunities;
  telegramChats?: typeof discoverTelegramChats;
  send?: typeof sendNotification;
}

export async function runSetup(options: SetupOptions = {}): Promise<void> {
  const file = options.file ?? serviceConfigFile();
  const previous = fs.existsSync(file) ? readServiceConfig(file) : undefined;
  const terminal = options.io ? null : terminalIO();
  const io = options.io ?? terminal!;
  try {
    if (options.notificationsOnly && !previous) throw new Error('Bitte zuerst die vollständige Einrichtung mit setup ausführen.');
    io.log('Kicktipp einrichten — Zugangsdaten werden nur lokal gespeichert.');
    const config: ServiceConfig = previous ? structuredClone(previous) : {
      version: 1, account: { email: '', password: '', community: '', site: 'de' },
      server: { token: crypto.randomBytes(32).toString('base64url'), host: '0.0.0.0', port: 8787, readOnly: true, allowedOrigins: [] },
      timeZone: 'Europe/Berlin', notifications: { channels: [], warnHours: [24, 6, 1], everyMinutes: 15 },
    };
    if (!options.notificationsOnly) {
      config.account.email = await required(io, 'Kicktipp E-Mail', { default: config.account.email });
      const password = await io.ask(`Kicktipp Passwort${previous ? ' (Enter: bisheriges behalten)' : ''}`, { secret: true });
      config.account.password = password || config.account.password;
      if (!config.account.password) config.account.password = await required(io, 'Kicktipp Passwort', { secret: true });
      config.account.site = await choose(io, 'Kicktipp-Seite', ['de', 'com'], config.account.site) as 'de' | 'com';
      io.log('Prüfe Anmeldung und lade deine Tipprunden …');
      const communities = await (options.communities ?? discoverCommunities)(config.account.email, config.account.password, config.account.site);
      if (!communities.length) throw new Error('Keine Tipprunde gefunden. Tritt zunächst auf Kicktipp einer Tipprunde bei.');
      config.account.community = await choose(io, 'Tipprunde', communities, config.account.community);
      const player = await io.ask('Spielername für Statistiken (optional)', { default: config.account.player });
      config.account.player = player.trim() || undefined;
      config.server.readOnly = !await askYes(io, 'Darf dein Agent Tipps abgeben und ändern?', !config.server.readOnly);
      for (;;) {
        const zone = await io.ask('Zeitzone', { default: config.timeZone });
        try { new Intl.DateTimeFormat('de', { timeZone: zone }); config.timeZone = zone; break; }
        catch { io.log('Ungültige Zeitzone. Beispiel: Europe/Berlin.'); }
      }
    }

    io.log('Benachrichtigungen: mehrere Kanäle sind möglich.');
    if (config.notifications.channels.length) {
      io.log(`Gespeichert: ${config.notifications.channels.map((c) => `${c.id} (${c.kind})`).join(', ')}`);
      if (!await askYes(io, 'Vorhandene Kanäle behalten?', true)) config.notifications.channels = [];
    }
    while (await askYes(io, 'Benachrichtigungskanal hinzufügen?', config.notifications.channels.length === 0)) {
      const kind = await choose(io, 'Kanaltyp', ['discord', 'telegram', 'webhook']) as NotificationChannel['kind'];
      const id = `${kind}-${crypto.randomBytes(4).toString('hex')}`;
      let channel: NotificationChannel;
      if (kind === 'telegram') {
        io.log('1. In Telegram @BotFather öffnen, /newbot senden und einen Bot erstellen.');
        const botToken = await required(io, 'Bot-Token von BotFather', { secret: true });
        io.log('2. Deinen neuen Bot öffnen und /start senden. Für Gruppen: Bot hinzufügen und /start@Botname senden.');
        let chatId = await io.ask('Chat-ID (Enter: automatisch erkennen)');
        if (!chatId) {
          try {
            const chats = await (options.telegramChats ?? discoverTelegramChats)(botToken);
            if (chats.length) {
              const labels = chats.map((chat) => `${chat.label} (${chat.id})`);
              const selected = await choose(io, 'Zielchat', labels);
              chatId = chats[labels.indexOf(selected)].id;
            }
          } catch (error) { io.log((error as Error).message); }
        }
        if (!chatId) chatId = await required(io, 'Kein Chat erkannt. Nach /start erneut einrichten oder bekannte Chat-ID eingeben');
        channel = { id, kind, botToken, chatId };
      } else {
        io.log(kind === 'discord'
          ? 'Discord: Kanal bearbeiten → Integrationen → Webhooks → Neuer Webhook → Webhook-URL kopieren.'
          : 'Der Webhook erhält einen JSON-POST mit summary, event und den Spieldaten.');
        const url = await required(io, 'Webhook-URL', { secret: true });
        channel = { id, kind, url };
      }
      try { channel = validateChannel(channel); }
      catch (error) { io.log((error as Error).message); continue; }
      if (await askYes(io, 'Jetzt eine Testnachricht senden?', true)) {
        try {
          await (options.send ?? sendNotification)(channel, { event: 'test', summary: 'Kicktipp ist verbunden. Deine Benachrichtigungen funktionieren.' });
          io.log('Testnachricht erfolgreich gesendet.');
        } catch {
          io.log('Testnachricht fehlgeschlagen. Bitte Ziel, Zugangsdaten und Bot-/Webhook-Berechtigungen prüfen.');
          if (!await askYes(io, 'Kanal trotzdem speichern?', false)) continue;
        }
      }
      config.notifications.channels.push(channel);
    }
    if (config.notifications.channels.length) {
      for (;;) {
        const value = await io.ask('Erinnerungen wie viele Stunden vor Anpfiff? (Komma-getrennt)', { default: config.notifications.warnHours.join(',') });
        const hours = value.split(',').map((part) => Number(part.trim()));
        if (hours.length <= 10 && hours.every((n) => Number.isFinite(n) && n > 0 && n <= 168)) { config.notifications.warnHours = hours; break; }
        io.log('Bitte 1 bis 10 positive Stundenwerte bis 168 angeben, z. B. 24,6,1.');
      }
      for (;;) {
        const value = Number(await io.ask('Prüfintervall in Minuten', { default: String(config.notifications.everyMinutes) }));
        if (Number.isFinite(value) && value >= 1 && value <= 1440) { config.notifications.everyMinutes = value; break; }
        io.log('Bitte einen Wert von 1 bis 1440 eingeben.');
      }
    }
    writeServiceConfig(config, file);
    io.log(`Gespeichert in ${file} (nur für den Dateibesitzer lesbar).`);
    io.log('Starten: docker compose up -d\nNach Änderungen: docker compose restart kicktipp');
    io.log(`MCP-URL auf diesem Rechner: http://127.0.0.1:8787/mcp\nAuthorization: Bearer ${config.server.token}`);
    io.log('Für einen Agenten auf einem anderen Rechner einen HTTPS-Zugang oder SSH-Tunnel verwenden.');
  } finally { terminal?.close(); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runSetup({ notificationsOnly: process.argv.includes('--notifications') }).catch((error) => {
    console.error((error as Error).message); process.exitCode = 1;
  });
}
