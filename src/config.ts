import fs from 'fs';
import path from 'path';
import os from 'os';
import * as ini from 'ini';
import readline from 'readline';

const CONFIG_DIR = path.join(os.homedir(), '.config', 'kicktipp-agent');
const CONFIG_FILE = path.join(CONFIG_DIR, 'config.ini');
export const SESSION_FILE = path.join(CONFIG_DIR, 'session.json');

function readConfig(): Record<string, any> {
  if (!fs.existsSync(CONFIG_FILE)) return {};
  return ini.parse(fs.readFileSync(CONFIG_FILE, 'utf-8'));
}

function writeConfig(config: Record<string, any>): void {
  fs.mkdirSync(CONFIG_DIR, { recursive: true });
  fs.writeFileSync(CONFIG_FILE, ini.stringify(config));
  fs.chmodSync(CONFIG_FILE, 0o600);
}

export async function loadCredentials(): Promise<{ email: string; password: string }> {
  if (process.env.KICKTIPP_EMAIL && process.env.KICKTIPP_PASSWORD) {
    return { email: process.env.KICKTIPP_EMAIL, password: process.env.KICKTIPP_PASSWORD };
  }
  const config = readConfig();
  if (config.auth?.email && config.auth?.password) {
    return { email: config.auth.email, password: config.auth.password };
  }

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const ask = (q: string): Promise<string> =>
    new Promise((resolve) => rl.question(q, resolve));

  console.log('No credentials found. Please enter your kicktipp.com login:');
  const email = await ask('Email: ');
  const password = await new Promise<string>((resolve) => {
    process.stdout.write('Password: ');
    const stdin = process.stdin;
    const wasRaw = stdin.isRaw;
    if (stdin.isTTY) stdin.setRawMode(true);
    let pwd = '';
    const onData = (ch: Buffer) => {
      const c = ch.toString();
      if (c === '\n' || c === '\r') {
        stdin.removeListener('data', onData);
        if (stdin.isTTY && wasRaw !== undefined) stdin.setRawMode(wasRaw);
        process.stdout.write('\n');
        resolve(pwd);
      } else if (c === '\u0003') {
        process.exit(1);
      } else if (c === '\u007f') {
        pwd = pwd.slice(0, -1);
      } else {
        pwd += c;
      }
    };
    stdin.resume();
    stdin.on('data', onData);
  });
  rl.close();

  const config2 = readConfig();
  config2.auth = { email, password };
  writeConfig(config2);
  console.log(`Credentials saved to ${CONFIG_FILE}`);
  return { email, password };
}

export function loadCommunity(): string | null {
  const config = readConfig();
  return config.community?.name || null;
}

export function saveCommunity(name: string): void {
  const config = readConfig();
  config.community = { name };
  writeConfig(config);
}

export function loadPlayer(): string | null {
  const config = readConfig();
  return config.player?.name || null;
}

export function savePlayer(name: string): void {
  const config = readConfig();
  config.player = { name };
  writeConfig(config);
}

export function hasCredentials(): boolean {
  if (process.env.KICKTIPP_EMAIL && process.env.KICKTIPP_PASSWORD) return true;
  const config = readConfig();
  return !!(config.auth?.email && config.auth?.password);
}

export function logout(): void {
  const removed: string[] = [];
  for (const p of [CONFIG_FILE, SESSION_FILE]) {
    if (fs.existsSync(p)) {
      fs.unlinkSync(p);
      removed.push(p);
    }
  }
  console.log(removed.length ? `Removed: ${removed.join(', ')}` : 'Nothing to remove.');
}
