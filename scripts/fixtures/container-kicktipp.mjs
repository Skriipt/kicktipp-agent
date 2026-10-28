// Synthetic Kicktipp + webhook receiver for smoke-container.mjs. No external I/O.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';

const community = 'compose-smoke';
const state = { received: [], unexpected: [], logins: 0 };
const parts = new Intl.DateTimeFormat('de-DE', {
  timeZone: 'Europe/Berlin', year: '2-digit', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', hour12: false,
}).formatToParts(new Date(Date.now() + 30 * 60_000));
const value = (type) => parts.find((part) => part.type === type).value;
const kickoff = `${value('day')}.${value('month')}.${value('year')} ${value('hour')}:${value('minute')}`;

const server = createServer((request, response) => {
  void (async () => {
    const url = new URL(request.url, 'http://localhost');
    const pathname = url.pathname;
    const html = (body) => {
      response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      response.end(body);
    };
    if (request.method === 'GET' && (pathname === '/health' || pathname === '/events')) {
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify(pathname === '/events' ? state : { status: 'ok' }));
      return;
    }
    if (pathname === '/webhook' && request.method === 'POST') {
      let body = '';
      for await (const chunk of request) body += chunk;
      state.received.push(JSON.parse(body));
      response.writeHead(204);
      response.end();
      return;
    }
    if (pathname === '/info/profil/login' && request.method === 'GET') {
      html('<form method="post" action="/info/profil/login"><input name="kennung"><input type="password" name="passwort"><button name="submitbutton">Login</button></form>');
      return;
    }
    if (pathname === '/info/profil/login' && request.method === 'POST') {
      let body = '';
      for await (const chunk of request) body += chunk;
      const form = new URLSearchParams(body);
      assert.equal(form.get('kennung'), 'smoke@example.invalid');
      assert.equal(form.get('passwort'), 'local-smoke-fixture-password');
      state.logins++;
      response.writeHead(302, { Location: '/', 'Set-Cookie': 'sid=smoke; Path=/; HttpOnly' });
      response.end();
      return;
    }
    if (request.method === 'GET' && ['/', '/info/profil/meinetipprunden', `/${community}/tippabgabe`, `/${community}/tippspielplan`].includes(pathname)) {
      if (!request.headers.cookie?.includes('sid=smoke')) {
        response.writeHead(302, { Location: '/info/profil/login' });
        response.end();
        return;
      }
      if (pathname.endsWith('/tippabgabe') && url.searchParams.get('bonus') === 'true') {
        html(`<div id="kicktipp-content"><table id="tippabgabeFragen"><tbody>
          <tr><td>1</td><td>Wer wird Meister?</td><td>
          <select name="tippabgabeFragenForms[101].tipp"><option value="-1" selected>---</option><option value="1">Home FC</option></select>
          </td></tr></tbody></table></div>`);
      } else if (pathname.endsWith('/tippspielplan')) {
        html(`<div id="kicktipp-content"><table id="fragen"><thead><tr>
          <th name="wettbewerb">Wettbewerb</th><th name="termin">Termin</th><th name="tipptermin">Tipptermin</th><th name="frage">Frage</th>
          </tr></thead><tbody><tr><td>Fixture League</td><td>01.06.27 15:30</td><td>${kickoff}</td><td>Wer wird Meister?</td></tr></tbody></table></div>`);
      } else if (pathname.endsWith('/tippabgabe')) {
        html(`<div id="kicktipp-content"><div class="pagetitle">Spieltag 1</div>
          <table id="tippabgabeSpiele"><tbody><tr><td>${kickoff}</td><td>Home FC</td><td>Away FC</td><td>
          <input id="spieltipp_1_heimTipp" value=""><input id="spieltipp_1_gastTipp" value="">
          </td></tr></tbody></table></div>`);
      } else {
        html(`<div id="kicktipp-content"><a href="/${community}/">${community}</a></div>`);
      }
      return;
    }
    state.unexpected.push(`${request.method} ${pathname}`);
    response.writeHead(500);
    response.end('Unexpected fixture request');
  })().catch((error) => {
    state.unexpected.push(error.message);
    if (!response.headersSent) response.writeHead(500);
    response.end('Fixture failed');
  });
});
server.listen(8788, '0.0.0.0');
process.once('SIGTERM', () => { server.closeIdleConnections(); server.close(); });
