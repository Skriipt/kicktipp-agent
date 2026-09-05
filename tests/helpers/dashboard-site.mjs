import http from 'node:http';

/** Local Kicktipp-shaped site; never forwards a request to a real provider. */
export async function dashboardSite() {
  const posts = [];
  const scores = new Map();
  const answers = new Map();
  const page = content => '<!doctype html><html><body><div id="kicktipp-content">' + content + '</div></body></html>';
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    const body = new URLSearchParams(await new Promise(resolve => {
      let text = ''; req.on('data', chunk => { text += chunk; }); req.on('end', () => resolve(text));
    }));
    const user = /sid=([^;]+)/.exec(req.headers.cookie || '')?.[1];
    const redirect = (location, cookie) => { res.writeHead(302, { location, ...(cookie ? { 'set-cookie': cookie } : {}) }); res.end(); };
    res.setHeader('content-type', 'text/html; charset=utf-8');
    if (url.pathname === '/info/profil/login') {
      if (req.method === 'POST') {
        if (body.get('passwort') === ' secret password ') return redirect('/', 'sid=' + body.get('kennung')?.split('@')[0] + '; Path=/; HttpOnly');
        return redirect('/info/profil/login');
      }
      res.end(page('<form method="post" action="/info/profil/login"><input name="csrf" type="hidden" value="token"><input name="kennung"><input name="passwort" type="password"><button name="submitbutton">Login</button></form>')); return;
    }
    if (!user) return redirect('/info/profil/login');
    if (req.method === 'POST') {
      posts.push({ path: url.pathname, user, body: Object.fromEntries(body) });
      if (url.pathname === '/family/tippabgabe') {
        if (body.has('bonus')) answers.set(user, body.get('bonusAnswer'));
        else scores.set(user, [body.get('home'), body.get('away')]);
      }
      return redirect(url.pathname + (body.has('bonus') ? '?bonus=true' : ''));
    }
    if (url.pathname === '/') { res.end(page('Signed in')); return; }
    if (url.pathname === '/info/profil/meinetipprunden') {
      res.end(page('<a href="/family/">family</a><a href="/office/">office</a>')); return;
    }
    if (url.pathname === '/family/spielleiter/mitgliederliste') {
      res.end(page('<table><tbody><tr><td>Anna</td><td><a href="/family/spielleiter/tippsnachtragen?tipperId=101&tippsaisonId=99">Tipps nachtragen</a></td></tr></tbody></table>')); return;
    }
    if (url.pathname === '/family/spielleiter/tippsnachtragen') {
      res.end(page('<form method="post" action="/family/spielleiter/tippsnachtragen"><input type="hidden" name="tipperId" value="101">'
        + '<table><tbody><tr><td>10.09.30 20:30</td><td>Bayern</td><td>Dortmund</td><td>'
        + '<input id="admin_heimTipp" name="home"><input id="admin_gastTipp" name="away">'
        + '</td></tr></tbody></table><button name="submitbutton" type="submit">Speichern</button></form>')); return;
    }
    if (url.pathname.endsWith('/tippuebersicht')) {
      res.end(page('<div class="pagetitle">Spieltag 1</div><table id="ranking"><thead><tr><th>Platz</th><th>Name</th><th class="ereignis1">Bayern - Dortmund</th><th>Bonus</th><th>Punkte</th></tr></thead><tbody>'
        + '<tr><td>1</td><td><div class="mg_name">Anna</div></td><td class="ereignis1">2:1</td><td>0</td><td>14</td></tr>'
        + '<tr><td>2</td><td><div class="mg_name">Ben</div></td><td class="ereignis1">-</td><td>0</td><td>10</td></tr></tbody></table>')); return;
    }
    if (url.pathname === '/family/tippabgabe') {
      if (url.searchParams.has('bonus')) {
        res.end(page('<form method="post" action="/family/tippabgabe"><input type="hidden" name="bonus" value="true"><table id="tippabgabeFragen"><tbody><tr><td>1</td><td>Wer wird Meister?</td><td>'
          + '<select name="bonusAnswer"><option value="-1">–</option><option value="bayern"' + (answers.get(user) === 'bayern' ? ' selected' : '') + '>Bayern</option><option value="dortmund">Dortmund</option></select>'
          + '</td></tr></tbody></table><button name="submitbutton" type="submit">Speichern</button></form>')); return;
      }
      const [home, away] = scores.get(user) || ['', ''];
      res.end(page('<div class="pagetitle">1. Spieltag</div><form method="post" action="/family/tippabgabe"><input type="hidden" name="csrf" value="keep-me">'
        + '<table id="tippabgabeSpiele"><tbody><tr><td>10.09.30 20:30</td><td>Bayern</td><td>Dortmund</td><td>'
        + '<input id="one_heimTipp" name="home" value="' + home + '"><input id="one_gastTipp" name="away" value="' + away + '">'
        + '</td><td></td></tr><tr><td>01.01.20 18:00</td><td>Hamburg</td><td>Bremen</td><td class="nichttippbar">1:1</td><td></td></tr></tbody></table>'
        + '<button name="submitbutton" type="submit">Speichern</button></form>')); return;
    }
    res.writeHead(404); res.end(page('Seite wurde nicht gefunden'));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return { origin: 'http://127.0.0.1:' + server.address().port, posts, scores,
    close: () => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }) };
}
