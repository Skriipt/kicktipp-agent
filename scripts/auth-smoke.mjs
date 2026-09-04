// Synthetic authentication proof. HTTP never leaves this process's loopback server.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const moduleAt = (name) => import(pathToFileURL(path.resolve('dist', name)).href);
const accounts = [
  { id: 'smoke/a', account: 'alpha', store: 'password' },
  { id: 'smoke?a', account: 'beta', store: 'password' },
  { id: 'smoke_a', account: 'legacy', store: 'session' },
];
const password = 'synthetic-smoke-password-not-a-secret';

export async function seedAuth() {
  const { saveAuth, setActiveProfile, sessionFile } = await moduleAt('config.js');
  // CookieJar accepts the custom host only when the base URL is set.
  process.env.KICKTIPP_BASE_URL = 'http://127.0.0.1';
  const { Page, saveProfileSession } = await moduleAt('browser.js');
  const { CookieJar } = await moduleAt('http/cookie-jar.js');
  for (const { id, account, store } of accounts) {
    setActiveProfile(id);
    await saveAuth({ email: `${account}@example.invalid`, password, store });
    const page = new Page(CookieJar.fromJSON({
      cookies: [{ name: 'sid', value: store === 'session' ? account : 'expired', domain: '127.0.0.1' }],
    }));
    await saveProfileSession(page, id);
    await page.close();
    assert.equal(path.dirname(sessionFile(id)), process.env.KICKTIPP_DATA_DIR);
  }
  assert.equal(new Set(accounts.map(({ id }) => sessionFile(id))).size, accounts.length);
  assert.equal(path.basename(sessionFile('smoke_a')), 'session-smoke_a.json');
  const ini = fs.readFileSync(path.join(process.env.KICKTIPP_CONFIG_DIR, 'config.ini'), 'utf8');
  assert.ok(ini.includes('enc.'));
  assert.ok(!ini.includes(password));
  console.log('Auth fixtures seeded: encrypted profiles, expired cookies, compatible session-only cookie');
}

export async function runAuthSmoke(mode) {
  assert.ok(['refresh', 'restore'].includes(mode));
  let posts = 0;
  const server = http.createServer(async (req, res) => {
    if (req.url === '/info/profil/login') {
      if (req.method === 'GET') {
        res.setHeader('content-type', 'text/html');
        res.end('<form method="post" action="/info/profil/login"><input name="kennung"><input name="passwort"></form>');
        return;
      }
      let body = '';
      for await (const chunk of req) body += chunk;
      const form = new URLSearchParams(body);
      const account = accounts.find((entry) => form.get('kennung') === `${entry.account}@example.invalid`);
      if (!account || form.get('passwort') !== password) {
        res.writeHead(401).end('Fixture login rejected');
        return;
      }
      posts += 1;
      res.writeHead(302, { location: '/', 'set-cookie': `sid=${account.account}; Path=/; HttpOnly` }).end();
      return;
    }
    const account = accounts.find((entry) => req.headers.cookie === `sid=${entry.account}`);
    if (!account) {
      res.writeHead(302, { location: '/info/profil/login' }).end();
      return;
    }
    res.setHeader('content-type', 'text/html');
    res.end(`<html><body>authenticated:${account.account}</body></html>`);
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  try {
    const base = `http://127.0.0.1:${server.address().port}`;
    process.env.KICKTIPP_BASE_URL = base;
    const { createScopedClient } = await moduleAt('client.js');
    const { sessionFile, loadProfileCredentials } = await moduleAt('config.js');
    // Proves encrypted credentials survive a new container with a stable identity.
    assert.equal((await loadProfileCredentials('smoke/a')).password, password);
    for (const { id, account } of accounts) {
      const client = createScopedClient({
        profileId: id,
        communityId: 'fixture',
        fetchImpl: (url, init) => {
          assert.equal(new URL(url).origin, base, 'No external HTTP allowed');
          return fetch(url, init);
        },
      });
      const content = await client.read(async (page) => {
        await page.goto(`${base}/fixture/`);
        return page.content();
      });
      assert.ok(content.includes(`authenticated:${account}`));
      const file = sessionFile(id);
      assert.equal(path.dirname(file), process.env.KICKTIPP_DATA_DIR);
      assert.equal(fs.statSync(file).mode & 0o777, 0o600);
      assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).cookies[0].value, account);
    }
    assert.equal(posts, mode === 'refresh' ? 2 : 0);
    assert.ok(!fs.readdirSync(process.env.KICKTIPP_DATA_DIR).some((file) => file.endsWith('.lock') && file.startsWith('auth-')));
    console.log(`Auth ${mode} passed: three isolated profiles; ${posts} loopback-only logins; sessions mode 0600`);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}
