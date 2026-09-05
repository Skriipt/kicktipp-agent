const $ = selector => document.querySelector(selector);
const state = { profile: sessionStorage.getItem('kicktipp-profile') || null, community: null, page: 'Übersicht', tab: null, snapshot: null, dirty: false, busy: false };
const navItems = ['Übersicht', 'Tipps', 'Ranglisten', 'Analysen', 'Benachrichtigungen', 'Automatisierung', 'Spielleitung', 'Wartung', 'Konten', 'Einstellungen', 'Hilfe'];
const titles = {
  today: 'Heute', deadline: 'Fristen', 'tip-status': 'Tippstatus', bets: 'Meine Tipps', suggest: 'Vorschläge', log: 'Änderungsverlauf',
  leaderboard: 'Rangliste', overview: 'Saisonübersicht', schedule: 'Spielplan', table: 'Tabelle', rules: 'Spielregeln', grid: 'Spielertipps',
  stats: 'Statistik', rival: 'Rivalenvergleich', scenario: 'Szenario', whatif: 'Saison simulieren',
  'targets list': 'Ziele', 'targets test': 'Test senden', 'targets enable': 'Ziel aktivieren', 'targets disable': 'Ziel deaktivieren',
  'targets remove': 'Ziel entfernen', notify: 'Sofort benachrichtigen', 'service status': 'Status', 'service health': 'Zustand',
  'service run-once': 'Einmal ausführen', remind: 'Kalender & Zeitpläne', 'admin members': 'Mitglieder',
  'admin bets': 'Tipps ansehen', 'admin bet': 'Tipps nachtragen', sync: 'Synchronisieren',
  'cache status': 'Cache-Status', 'cache clear': 'Cache leeren', doctor: 'Diagnose', guide: 'Anleitung',
};
const labels = {
  matchday: 'Spieltag', bonus: 'Bonusfragen', home: 'Nur Heimspiele', away: 'Nur Auswärtsspiele', view: 'Ansicht',
  player: 'Spieler', compare: 'Vergleichsspieler', name: 'Name', strategy: 'Strategie', target: 'Zielrang',
  pin: 'Feste Tipps (ein Tipp pro Zeile)', place: 'Vorschläge direkt abgeben', replace: 'Vorhandene Tipps ersetzen',
  offline: 'Nur lokale Daten verwenden', undo: 'Letzte Tippabgabe rückgängig machen', all: 'Alle Einträge',
  'dry-run': 'Vorschau ohne Änderung', 'warn-hours': 'Warnung vor Anpfiff (Stunden)', check: 'Dringlichkeit prüfen',
  force: 'Auch ohne dringende Frist senden', print: 'Zeitplan ausgeben', install: 'systemd-Dateien installieren',
  uninstall: 'systemd-Dateien entfernen', every: 'Intervall (Minuten)', refresh: 'Vorhandenen Cache erneuern',
  from: 'Ab Spieltag', to: 'Bis Spieltag', verify: 'Punktwertung prüfen (Spieltag)', details: 'Namen und Inhalte einschließen',
  member: 'Mitglied (Name oder ID)', bets: 'Tipps (ein Tipp pro Zeile)', results: 'Ergebnisse (eins pro Zeile)', id: 'Ziel-ID',
};
const dataLabels = {
  community: 'Community', matchday: 'Spieltag', title: 'Titel', data: 'Daten', matches: 'Spiele', rankings: 'Rangliste',
  position: 'Platz', name: 'Name', matchdayPoints: 'Spieltagspunkte', bonus: 'Bonus', total: 'Gesamt', home: 'Heim',
  away: 'Gast', bet: 'Tipp', date: 'Datum', result: 'Ergebnis', odds: 'Quoten', draw: 'Unentschieden', team: 'Team',
  played: 'Spiele', points: 'Punkte', wins: 'Siege', draws: 'Unentschieden', losses: 'Niederlagen', goalDifference: 'Differenz',
  goalsFor: 'Tore', goalsAgainst: 'Gegentore', player: 'Spieler', players: 'Spieler', status: 'Status', summary: 'Zusammenfassung',
  complete: 'Vollständig', partial: 'Teilweise', missing: 'Fehlend', tipped: 'Getippt', question: 'Frage', answer: 'Antwort',
  deadline: 'Fristen', timeZone: 'Zeitzone', now: 'Stand', nextKickoff: 'Nächster Anpfiff', nextKickoffIn: 'Verbleibende Zeit',
  openCount: 'Offene Spiele', needsBetCount: 'Fehlende Tipps', urgentCount: 'Dringend', warnHours: 'Warnfrist (Stunden)',
  closed: 'Geschlossen', urgent: 'Dringend', needsBet: 'Tipp fehlt', kickoff: 'Anpfiff', stats: 'Statistik', compare: 'Vergleich',
  rules: 'Punktwertung', source: 'Quelle', confidence: 'Verlässlichkeit', values: 'Werte', exact: 'Exaktes Ergebnis',
  goalDiff: 'Tordifferenz', tendency: 'Tendenz', drawExact: 'Exaktes Remis', drawTendency: 'Remis-Tendenz',
  enabled: 'Aktiviert', running: 'Läuft', readable: 'Lesbar', health: 'Zustand', reasons: 'Hinweise', runtime: 'Laufzeit',
  session: 'Sitzung', condition: 'Zustand', notifications: 'Benachrichtigungen', deliveries: 'Zustellungen',
  nextWakeAt: 'Nächster Lauf', at: 'Zeit', outcome: 'Ergebnis', previous: 'Vorher', fixture: 'Begegnung',
  dryRun: 'Vorschau', message: 'Meldung', placed: 'Tipps', homeGoals: 'Heimtore', awayGoals: 'Gasttore',
};
const label = key => dataLabels[key] || key.replace(/([a-z])([A-Z])/g, '$1 $2').replaceAll('_', ' ');
function h(tag, attrs = {}, ...children) {
  const element = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (key.startsWith('on')) element.addEventListener(key.slice(2), event => {
      try { Promise.resolve(value(event)).catch(showError); } catch (error) { showError(error); }
    });
    else if (key === 'class') element.className = value;
    else if (key === 'text') element.textContent = value;
    else if (key === 'checked' || key === 'disabled' || key === 'required' || key === 'hidden') element[key] = value;
    else if (value !== undefined && value !== null) element.setAttribute(key, value);
  }
  for (const child of children.flat(Infinity)) {
    if (child !== null && child !== undefined && child !== false) element.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return element;
}
function button(text, action, kind = '', attrs = {}) { return h('button', { type: 'button', class: kind, onclick: action, ...attrs }, text); }
function field(text, control, hint = '') {
  const labeledControl = control.matches('input,select,textarea') ? control : control.querySelector('input,select,textarea');
  const id = labeledControl.id || 'field-' + crypto.randomUUID();
  labeledControl.id = id;
  return h('div', { class: 'field' }, h('label', { for: id }, text), control, hint && h('small', {}, hint));
}
function input(value = '', type = 'text', attrs = {}) { return h('input', { type, value: value ?? '', ...attrs }); }
function select(values, current = '', attrs = {}) {
  const control = h('select', attrs, values.map(v => {
    const [value, text] = Array.isArray(v) ? v : [v, v];
    return h('option', { value }, text);
  }));
  control.value = current ?? '';
  return control;
}
function check(text, checked = false, hint = '') {
  const control = input('', 'checkbox', { checked });
  const id = 'check-' + crypto.randomUUID(); control.id = id;
  return { control, node: h('div', { class: 'check' }, control, h('label', { for: id }, text, hint && h('div', { class: 'muted tiny' }, hint))) };
}
function card(title, subtitle, ...content) {
  return h('section', { class: 'card' }, h('div', { class: 'card-head' }, h('div', {}, h('h2', {}, title), subtitle && h('p', {}, subtitle))), content);
}
function notice(text, kind = '') { return h('div', { class: 'notice ' + kind }, text); }
function empty(title, text, action) {
  return h('div', { class: 'empty' }, h('div', { class: 'empty-symbol', 'aria-hidden': 'true' }, '↗'), h('h2', {}, title), h('p', {}, text), action);
}
let toastTimer;
function toast(text) { $('#toast').textContent = text; $('#toast').hidden = false; clearTimeout(toastTimer); toastTimer = setTimeout(() => { $('#toast').hidden = true; }, 5500); }
function showError(error) {
  const message = error.message || String(error);
  const host = $('#page-error');
  if (host) { host.replaceChildren(notice(message, 'error')); host.scrollIntoView({ block: 'nearest' }); }
  toast(message);
}
async function confirmAction(title, detail) {
  const dialog = $('#confirmation');
  $('#confirm-title').textContent = title;
  $('#confirm-context').textContent = 'Konto: ' + (state.profile || 'Standardprofil') + ' · Community: ' + (state.community || '–');
  $('#confirm-detail').textContent = detail;
  dialog.showModal();
  return new Promise(resolve => {
    $('#confirm-submit').onclick = () => { dialog.close('yes'); };
    $('#confirm-cancel').onclick = () => { dialog.close('no'); };
    dialog.addEventListener('close', () => resolve(dialog.returnValue === 'yes'), { once: true });
    dialog.returnValue = 'no';
  });
}
let token = location.hash.slice(1) || sessionStorage.getItem('kicktipp-token') || '';
if (location.hash) { sessionStorage.setItem('kicktipp-token', token); history.replaceState(null, '', location.pathname); }
async function api(path, data) {
  const response = await fetch('/api/' + path, {
    method: data === undefined ? 'GET' : 'POST',
    headers: { Authorization: 'Bearer ' + token, ...(data === undefined ? {} : { 'Content-Type': 'application/json' }) },
    body: data === undefined ? undefined : JSON.stringify(data),
  });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || 'Anfrage fehlgeschlagen.');
  return result;
}
async function run(operation, payload = {}, options = {}) {
  const initial = await api('run', { operation, payload, profile: state.profile, community: state.community, confirmed: !!options.confirmed });
  if (options.background) return initial;
  let job = initial;
  while (job.status === 'running' || !job.status) {
    options.progress?.(job);
    await new Promise(resolve => setTimeout(resolve, 350));
    job = await api('jobs/' + job.id);
  }
  return job;
}
async function runData(operation, payload = {}, options = {}) {
  const job = await run(operation, payload, options);
  if (job.status === 'failed') throw new Error(job.error || job.output || 'Aktion fehlgeschlagen (Code ' + job.code + ').');
  return job.result;
}
function busyNode(text = 'Daten werden geladen …') { return h('div', { class: 'busy', role: 'status' }, h('div', { class: 'loader' }), text); }
function download(filename, type, content) {
  const url = URL.createObjectURL(new Blob([content], { type }));
  const anchor = h('a', { href: url, download: filename }); anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
function renderValue(value, depth = 0) {
  if (value === null || value === undefined || value === '') return h('span', { class: 'muted' }, '–');
  if (typeof value !== 'object') return h('span', {}, typeof value === 'boolean' ? value ? 'Ja' : 'Nein' : String(value));
  if (depth > 6) return h('pre', {}, JSON.stringify(value, null, 2));
  if (Array.isArray(value)) {
    if (!value.length) return h('span', { class: 'muted' }, 'Keine Einträge');
    if (value.every(row => row && typeof row === 'object' && !Array.isArray(row))) {
      const keys = [...new Set(value.flatMap(row => Object.keys(row)))].filter(k => k !== 'isCurrentPlayer');
      return h('div', { class: 'table-scroll' }, h('table', {},
        h('thead', {}, h('tr', {}, keys.map(key => h('th', { scope: 'col' }, label(key))))),
        h('tbody', {}, value.map(row => h('tr', { class: row.isCurrentPlayer ? 'current' : '' }, keys.map(key => h('td', {}, renderValue(row[key], depth + 1))))))));
    }
    return h('div', {}, value.map(row => h('div', {}, renderValue(row, depth + 1))));
  }
  return h('dl', {}, Object.entries(value).filter(([key]) => key !== 'isCurrentPlayer').map(([key, val]) => [
    h('dt', {}, label(key)), h('dd', {}, renderValue(val, depth + 1)),
  ]));
}
function renderOutcome(host, job) {
  const content = [];
  if (job.status === 'failed') content.push(notice(job.error || 'Die Aktion meldet einen Fehler oder Handlungsbedarf (Code ' + job.code + ').', 'error'));
  if (job.result !== undefined) {
    const data = job.result;
    if (data.download) {
      content.push(notice('Export ist bereit.'), button('Kalender herunterladen', () => download(data.download.filename, data.download.type, data.download.content)));
    } else {
      content.push(renderValue(data.data ?? data));
      if (data.data && data.deadline) content.push(h('details', {}, h('summary', {}, 'Fristen'), renderValue(data.deadline)));
      content.push(h('div', { class: 'actions' }, button('JSON herunterladen', () => download('kicktipp-ergebnis.json', 'application/json', JSON.stringify(data, null, 2)), 'secondary small')));
    }
  } else content.push(h('pre', { class: 'output' }, job.output || 'Aktion abgeschlossen.'));
  if (job.output && job.result !== undefined) content.push(h('details', {}, h('summary', {}, 'Ausgabe anzeigen'), h('pre', { class: 'output' }, job.output)));
  host.replaceChildren(...content);
}
async function refreshSnapshot() {
  state.snapshot = await runData('snapshot');
  state.community = state.snapshot.community;
  const profile = $('#profile');
  profile.replaceChildren(h('option', { value: '' }, 'Standardprofil'), ...state.snapshot.profiles.map(p => h('option', { value: p }, p)));
  profile.value = state.profile || '';
  $('#community-badge').textContent = state.community || 'Keine Community';
  $('#version').textContent = 'Version ' + state.snapshot.version;
}
function heading(title, subtitle, action) {
  return h('div', { class: 'page-heading' }, h('div', {}, h('p', { class: 'eyebrow' }, 'Kicktipp / ' + (state.community || 'Einrichtung')), h('h1', {}, title), h('p', { class: 'subtitle' }, subtitle)), action);
}
const descriptions = {
  Übersicht: 'Das Wichtigste rund um deine Tipprunde.',
  Tipps: 'Spiele tippen, Vorschläge prüfen und Änderungen nachvollziehen.',
  Ranglisten: 'Deine Community, die Saison und die Ergebnisse im Überblick.',
  Analysen: 'Vergleiche Spieler und prüfe mögliche Ergebnisse mit den vorhandenen Saisondaten.',
  Benachrichtigungen: 'Wähle, wo und wie Erinnerungen ankommen.',
  Automatisierung: 'Erinnerungsregeln, Zustellungen und den laufenden Dienst verwalten.',
  Spielleitung: 'Mitglieder verwalten und Tipps im Namen eines Mitglieds nachtragen.',
  Wartung: 'Daten synchronisieren, Cache prüfen und Probleme erkennen.',
  Konten: 'Kicktipp verbinden und Community sowie Spieler auswählen.',
  Einstellungen: 'Gemeinsame Einstellungen für CLI, MCP und Dashboard.',
  Hilfe: 'Alle Funktionen deines Kicktipp-Projekts.',
};
function navIcon(index) {
  const paths = ['M3 10 12 3l9 7v11h-6v-7H9v7H3z','m4 17 10-10 3 3-10 10H4zM14 7l3-3 3 3-3 3','M4 21V11h4v10M10 21V4h4v17M16 21v-7h4v7','m3 17 6-6 4 3 8-10M3 21h18','M5 17h14l-2-3V9a5 5 0 0 0-10 0v5zM10 21h4','M12 3v4m0 10v4M3 12h4m10 0h4M6 6l3 3m6 6 3 3M6 18l3-3m6-6 3-3','M4 21v-2a5 5 0 0 1 10 0v2M9 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8M17 5v6m-3-3h6','m5 19 8-8m2 2a6 6 0 0 0 6-8l-4 4-3-3 4-4a6 6 0 0 0-8 6','M4 21v-3a8 8 0 0 1 16 0v3M12 12a5 5 0 1 0 0-10 5 5 0 0 0 0 10','M4 7h16M4 17h16M8 4v6m8 4v6','M12 17v1m-3-10a3 3 0 1 1 5 2c-2 1-2 2-2 3M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20'];
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  for (const [key, val] of Object.entries({ viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', 'stroke-width': '1.5', 'stroke-linecap': 'round', 'stroke-linejoin': 'round', class: 'nav-icon', 'aria-hidden': 'true' })) svg.setAttribute(key, val);
  const path = document.createElementNS(svg.namespaceURI, 'path'); path.setAttribute('d', paths[index]); svg.append(path); return svg;
}
function renderNav() {
  $('#navigation').replaceChildren(...navItems.flatMap((item, index) => [
    index === 8 && h('div', { class: 'nav-separator' }),
    h('button', { type: 'button', class: state.page === item ? 'active' : '', 'aria-current': state.page === item ? 'page' : undefined,
      onclick: () => navigate(item) }, navIcon(index), item),
  ]).filter(Boolean));
}
async function navigate(page, tab = null) {
  if (state.busy) { toast('Bitte die laufende Aktion abwarten.'); return; }
  if (state.dirty && !await confirmAction('Änderungen verwerfen?', 'Die nicht gespeicherten Eingaben auf dieser Seite werden verworfen.')) return;
  state.dirty = false; state.page = page; state.tab = tab;
  setMenu(false);
  await renderPage();
}
async function renderPage() {
  renderNav(); $('#breadcrumb').textContent = state.page;
  const main = $('#content'); main.replaceChildren(heading(state.page, descriptions[state.page]), h('div', { id: 'page-error', role: 'alert' }));
  if (state.snapshot.settings.readOnly && ['Tipps', 'Spielleitung'].includes(state.page)) main.append(notice('Lesemodus aktiv. Tippabgaben sind gesperrt; Vorschauen bleiben verfügbar.'));
  if (state.page === 'Konten') { renderAccounts(main); return; }
  if (state.page === 'Einstellungen') { renderSettings(main); return; }
  if (state.page === 'Benachrichtigungen') { renderNotifications(main); return; }
  if (state.page === 'Automatisierung') { renderAutomation(main); return; }
  if (state.page === 'Tipps') { renderBetsPage(main); return; }
  if (state.page === 'Übersicht') {
    const snapshot = state.snapshot;
    const stats = [['Community', state.community || 'Noch offen', snapshot.player ? 'Spieler: ' + snapshot.player : 'Spieler noch nicht ausgewählt'],
      ['Konto', snapshot.auth.configured ? 'Verbunden' : 'Einrichten', state.profile || 'Standardprofil'],
      ['Erinnerungsdienst', snapshot.serviceStatus.readable && snapshot.serviceStatus.runtime.running ? 'Läuft' : 'Gestoppt', snapshot.service?.job.name || 'Noch nicht eingerichtet']];
    main.append(h('div', { class: 'stats' }, stats.map(([name, value, note]) => h('div', { class: 'stat' }, h('div', { class: 'label' }, name), h('div', { class: 'value' }, value), h('div', { class: 'note' }, note)))));
    if (!snapshot.auth.configured || !state.community) {
      main.append(card('Bereit für die nächste Tipprunde?', '', empty('Verbinde dein Kicktipp-Konto', 'Melde dich an und wähle deine Community. Danach stehen hier Spiele, Fristen und der Tippstatus bereit.', button('Konto einrichten', () => navigate('Konten')))));
      return;
    }
  }
  if (state.page === 'Hilfe') main.append(card('Dashboard verwenden', '',
    h('p', {}, 'Wähle oben das Konto. Unter Konten legst du Community und Spieler fest. Alle Abfragen und Änderungen verwenden dieselben Daten wie die CLI.'),
    h('p', {}, 'Unter Tipps kannst du Spiel- und Bonus-Tipps bearbeiten, vorab prüfen und gesammelt absenden. Analysen benötigen teilweise einen Saison-Cache: Wartung → Synchronisieren.'),
    h('p', {}, 'Für automatische Erinnerungen zuerst ein benanntes Konto verbinden, dann unter Automatisierung einen deaktivierten Auftrag speichern, Benachrichtigungsziele ergänzen und den Auftrag aktivieren.'),
    h('p', {}, 'Ein hier gestarteter Dienst läuft bis zum Stoppen oder Beenden des Dashboards. Bereits extern gestartete Dienste werden angezeigt und über ihre Konfiguration gesteuert; stoppen musst du sie beim jeweiligen Prozessmanager.'),
    h('p', {}, 'Der vollständige Link aus dem Terminal ist dein Dashboard-Zugang. Er gilt bis zum Neustart. Bei Fernzugriff einen SSH-Tunnel verwenden.')));
  const commands = state.snapshot.commands.filter(c => c.group === state.page);
  if (state.page === 'Ranglisten') commands.push({ id: 'grid', description: 'Alle sichtbaren Spielertipps des Spieltags.', args: [],
    options: [{ name: 'matchday', value: true, description: 'Leer = aktueller Spieltag.' }] });
  renderCommandTabs(main, commands);
}
function renderCommandTabs(main, commands) {
  if (!commands.length) return;
  const active = commands.find(c => c.id === state.tab) || commands[0];
  const tabs = h('div', { class: 'tabs', role: 'tablist', 'aria-label': 'Funktionen' });
  const host = h('div', { role: 'tabpanel' });
  for (const command of commands) tabs.append(button(titles[command.id] || command.id, async () => {
    if (state.busy) return;
    if (state.dirty && !await confirmAction('Änderungen verwerfen?', 'Die nicht gespeicherten Eingaben werden verworfen.')) return;
    state.dirty = false; state.tab = command.id;
    [...tabs.children].forEach(b => { b.classList.toggle('active', b.textContent === (titles[command.id] || command.id)); b.setAttribute('aria-selected', String(b.classList.contains('active'))); });
    host.replaceChildren(); renderCommandForm(host, command);
  }, command === active ? 'active' : '', { role: 'tab', 'aria-selected': command === active }));
  main.append(tabs, host); renderCommandForm(host, active);
}
const optionChoices = {
  strategy: ['safe', 'ev', 'contrarian'], view: ['matchday-points', 'standings', 'standings-diff', 'matchday-standings', 'points-from-leader'],
  print: ['cron', 'systemd'],
};
function renderCommandForm(host, command) {
  const form = h('form');
  const fields = h('div', { class: 'form-grid' });
  const controls = [];
  for (const arg of command.args) {
    let control;
    if (arg.variadic) control = h('textarea', { required: arg.required, placeholder: 'Bayern vs Dortmund=2:1' });
    else if (arg.name === 'strategy') control = input('actual', 'text', { required: true, list: 'replay-strategies' });
    else control = input('', 'text', { required: arg.required });
    if (['player', 'compare', 'name', 'member'].includes(arg.name)) control.setAttribute('list', 'known-players');
    fields.append(field(labels[arg.name] || arg.name, control, arg.description));
    controls.push({ arg, control });
  }
  for (const option of command.options) {
    if (option.name === 'json' && command.id !== 'notify') continue;
    if (option.name === 'ics') continue;
    let control, node;
    if (!option.value) {
      const checkbox = check(option.name === 'json' ? 'Nur Fristen prüfen, keine Nachricht senden' : labels[option.name] || option.name, option.name === 'dry-run', option.description);
      control = checkbox.control; node = checkbox.node;
    } else {
      const numeric = ['matchday', 'target', 'from', 'to', 'every', 'warn-hours', 'verify'].includes(option.name);
      if (optionChoices[option.name]) control = select([['', 'Standard'], ...optionChoices[option.name]], option.default || '');
      else if (option.variadic || option.name === 'header') control = h('textarea', {});
      else control = input(option.default ?? '', numeric ? 'number' : 'text', numeric ? {
        min: option.name === 'warn-hours' ? '.1' : '1', max: ['matchday', 'from', 'to', 'verify'].includes(option.name) ? '34' : undefined,
        step: option.name === 'warn-hours' ? '.1' : '1',
      } : {});
      if (['player', 'compare'].includes(option.name)) { control.setAttribute('list', 'known-players'); if (!control.value) control.value = state.snapshot.player || ''; }
      node = field(labels[option.name] || option.name, control, option.description);
    }
    let useCurrent;
    if (option.name === 'verify') {
      const current = check('Aktuellen Spieltag prüfen, falls kein Spieltag angegeben');
      useCurrent = current.control; node.append(current.node);
    }
    controls.push({ option, control, useCurrent }); fields.append(node);
  }
  const result = h('section', { class: 'card result', hidden: true, 'aria-live': 'polite' });
  const execute = h('button', { type: 'submit' }, 'Ausführen');
  const buttons = h('div', { class: 'actions' }, execute);
  if (command.id === 'remind') buttons.append(button('Kalender herunterladen', async () => {
    const options = values().options;
    result.hidden = false; result.replaceChildren(busyNode('Kalender wird erstellt …'));
    renderOutcome(result, await run('calendar', { matchday: options.matchday ? +options.matchday : undefined, warnHours: options['warn-hours'] ? +options['warn-hours'] : undefined }));
  }, 'secondary'));
  form.append(fields, buttons);
  host.append(card(titles[command.id] || command.id, command.description, form), result,
    h('datalist', { id: 'replay-strategies' }, ['actual', 'home', 'draw', 'away', 'favorite', 'safe', 'ev', 'contrarian', '1:0', '2:1', '1:1'].map(value => h('option', { value }))));
  function values() {
    const args = [], options = {};
    for (const entry of controls) {
      const { control, option, arg } = entry;
      const value = control.type === 'checkbox' ? control.checked : control.value.trim();
      if (arg) {
        if (arg.variadic) args.push(...String(value).split(/\r?\n/).map(v => v.trim()).filter(Boolean));
        else if (value) args.push(value);
      } else if (entry.useCurrent?.checked && value === '') options[option.name] = true;
      else if (value !== '' && value !== false) options[option.name] = option.variadic || option.name === 'header' ? String(value).split(/\r?\n/).filter(Boolean) : value;
    }
    if (command.options.some(o => o.name === 'json') && command.id !== 'notify' && !(command.id === 'suggest' && options.place)) options.json = true;
    return { args, options };
  }
  form.addEventListener('submit', async event => {
    event.preventDefault(); execute.disabled = true;
    try {
      const { args, options } = values();
      const mutates = ['cache clear', 'targets test', 'targets enable', 'targets disable', 'targets remove'].includes(command.id)
        || command.id === 'notify' && !options.json || command.id === 'admin bet' && !options['dry-run']
        || command.id === 'service run-once' && !options['dry-run'] || command.id === 'log' && options.undo
        || command.id === 'suggest' && options.place || command.id === 'remind' && (options.install || options.uninstall);
      let memberConfirmation = {};
      let confirmationDetail = args.concat(Object.entries(options).filter(([key]) => key !== 'json').map(([key, value]) => (labels[key] || key) + ': ' + value)).join('\n') || 'Diese Aktion verändert Daten oder sendet eine Benachrichtigung.';
      if (command.id === 'admin bet' && mutates) {
        const preview = await runData('command', { command: command.id, args, options: { ...options, 'dry-run': true } });
        memberConfirmation = { confirmMember: preview.member.name, confirmMemberId: preview.member.tipperId };
        confirmationDetail = 'Mitglied: ' + preview.member.name + ' (ID ' + preview.member.tipperId + ')\n' + args.slice(1).join('\n');
      }
      if (mutates && !await confirmAction(titles[command.id] || command.id, confirmationDetail)) return;
      state.busy = true; result.hidden = false; result.replaceChildren(busyNode('Aktion läuft. Das kann bei einer Saison-Synchronisierung einige Minuten dauern.'));
      const job = ['tip-status', 'grid'].includes(command.id)
        ? await run(command.id, { matchday: options.matchday ? +options.matchday : undefined })
        : await run('command', { command: command.id, args, options, ...memberConfirmation }, { confirmed: !!mutates });
      renderOutcome(result, job); state.dirty = false;
      if (mutates) await refreshSnapshot();
    } catch (error) { result.replaceChildren(notice(error.message, 'error')); showError(error); }
    finally { state.busy = false; execute.disabled = false; }
  });
}
function renderAccounts(main) {
  const snapshot = state.snapshot;
  const profileName = input(state.profile || '', 'text', { placeholder: 'Standardprofil oder neuer Name', pattern: '[A-Za-z0-9][A-Za-z0-9._\\-]{0,63}' });
  const email = input(snapshot.auth.email, 'email', { required: true, autocomplete: 'username' });
  const password = input('', 'password', { required: true, autocomplete: 'current-password' });
  const store = select([['session', 'Nur Sitzung speichern'], ['password', 'Passwort für automatische Anmeldung speichern']], snapshot.auth.store);
  const site = input(snapshot.settings.site, 'url', { required: true, list: 'kicktipp-sites' });
  const loginButton = h('button', { type: 'submit' }, snapshot.auth.configured ? 'Erneut verbinden' : 'Konto verbinden');
  const form = h('form', { 'data-dirty': 'true' }, h('div', { class: 'form-grid' },
    field('Profilname', profileName, 'Leer = Standardprofil. Ein neuer Name legt ein getrenntes Konto an.'),
    field('Kicktipp-Seite', site, 'https://www.kicktipp.de oder https://www.kicktipp.com'), field('E-Mail', email), field('Passwort', password),
    field('Zugang speichern', store, 'Nur Sitzung: Nach Ablauf erneut anmelden. Gespeicherte Passwörter sind an Rechner und Benutzer gebunden.')),
    h('div', { class: 'actions' }, loginButton, snapshot.auth.configured && button('Abmelden', async () => {
      if (!await confirmAction('Konto abmelden?', 'Gespeicherte Zugangsdaten und Sitzung dieses Profils entfernen.')) return;
      await runData('logout', {}, { confirmed: true }); state.profile = null; sessionStorage.removeItem('kicktipp-profile'); state.dirty = false;
      await refreshSnapshot(); await renderPage(); toast('Abgemeldet.');
    }, 'secondary')));
  form.addEventListener('submit', async event => {
    event.preventDefault(); loginButton.disabled = true; state.busy = true;
    const previousProfile = state.profile;
    try {
      state.profile = profileName.value.trim() || null;
      const data = await runData('login', { email: email.value, password: password.value, store: store.value, site: site.value }, { confirmed: true });
      password.value = ''; state.dirty = false; state.community = null; sessionStorage.setItem('kicktipp-profile', state.profile || '');
      await refreshSnapshot(); await renderPage(); toast('Konto verbunden. Jetzt Community auswählen.');
      const picker = $('#community-select');
      if (picker) { picker.replaceChildren(h('option', { value: '' }, 'Community auswählen'), ...data.communities.map(c => h('option', { value: c }, c))); }
    } catch (error) { state.profile = previousProfile; password.value = ''; showError(error); }
    finally { loginButton.disabled = false; state.busy = false; }
  });
  main.append(card('Kicktipp-Konto', 'Zugangsdaten werden ausschließlich vom lokalen Projekt verwendet.', form),
    h('datalist', { id: 'kicktipp-sites' }, ['https://www.kicktipp.de', 'https://www.kicktipp.com'].map(value => h('option', { value }))));
  const communities = select([['', 'Community auswählen'], ...(state.community ? [state.community] : [])], state.community, { id: 'community-select', required: true });
  const players = select([['', 'Kein Spieler ausgewählt'], ...(snapshot.player ? [snapshot.player] : [])], snapshot.player);
  const loadPlayers = async () => {
    if (!communities.value) return;
    players.disabled = true;
    try {
      const data = await runData('players', { community: communities.value });
      players.replaceChildren(h('option', { value: '' }, 'Kein Spieler ausgewählt'), ...data.players.map(p => h('option', { value: p }, p)));
      if (data.players.includes(snapshot.player)) players.value = snapshot.player;
    } finally { players.disabled = false; }
  };
  communities.addEventListener('change', () => { players.replaceChildren(h('option', { value: '' }, 'Kein Spieler ausgewählt')); loadPlayers().catch(showError); });
  const selectionForm = h('form', { 'data-dirty': 'true' }, h('div', { class: 'form-grid' }, field('Community', communities), field('Eigener Spieler', players, 'Wird als Standard für Statistiken und Vergleiche verwendet.')),
    h('div', { class: 'actions' }, h('button', { type: 'submit' }, 'Auswahl speichern'),
      button('Communities laden', async () => {
        const data = await runData('communities'); communities.replaceChildren(h('option', { value: '' }, 'Community auswählen'), ...data.communities.map(c => h('option', { value: c }, c)));
        if (data.communities.includes(state.community)) communities.value = state.community;
        await loadPlayers();
      }, 'secondary'), button('Spieler laden', loadPlayers, 'secondary')));
  selectionForm.addEventListener('submit', async event => {
    event.preventDefault();
    try {
      await runData('selection', { community: communities.value, player: players.value || undefined }, { confirmed: true });
      state.dirty = false; state.community = communities.value; await refreshSnapshot(); toast('Community und Spieler gespeichert.');
    } catch (error) { showError(error); }
  });
  main.append(card('Deine Tipprunde', 'Die Auswahl gilt für das oben ausgewählte Konto.', selectionForm));
}
function renderSettings(main) {
  const settings = state.snapshot.settings;
  if (settings.environmentOverrides.length) main.append(notice('Vom Prozess vorgegeben: ' + settings.environmentOverrides.join(', ') + '. Diese Variablen haben Vorrang vor gespeicherten Werten. Verzeichnisse und Prozessvariablen werden beim Start festgelegt.'));
  const language = select([['de', 'Deutsch'], ['en', 'English']], settings.language);
  const site = input(settings.site, 'url', { required: true });
  const timezone = input(settings.timezone, 'text', { required: true, list: 'timezones' });
  const strategy = select([['', 'Projektstandard'], ['safe', 'Sicher'], ['ev', 'Erwartungswert'], ['contrarian', 'Gegen den Trend']], settings.strategy);
  const warnHours = input(settings.warnHours, 'number', { min: '.1', max: '8760', step: '.1', required: true });
  const readOnly = check('Lesemodus', settings.readOnly, 'Verhindert echte Tippabgaben in allen Projektoberflächen.');
  const scoringEnabled = check('Eigene Punktwertung verwenden', !!settings.scoring, 'Nur nötig, wenn die Spielregeln nicht zuverlässig erkannt werden.');
  const scoringFields = ['exact', 'goalDiff', 'tendency', 'drawExact', 'drawTendency'].map(key => ({ key, control: input(settings.scoring?.[key] ?? '', 'number', { min: '0', step: 'any' }) }));
  const scoringGrid = h('div', { class: 'form-grid' }, scoringFields.map(({ key, control }) => field(label(key), control, key.startsWith('draw') ? 'Optional; leer übernimmt die normale Wertung.' : 'Pflichtwert bei eigener Punktwertung.')));
  function toggleScoring() { scoringFields.forEach(({ key, control }) => { control.disabled = !scoringEnabled.control.checked; control.required = scoringEnabled.control.checked && !key.startsWith('draw'); }); }
  scoringEnabled.control.addEventListener('change', toggleScoring); toggleScoring();
  const submit = h('button', { type: 'submit' }, 'Einstellungen speichern');
  const form = h('form', { 'data-dirty': 'true' }, h('div', { class: 'form-grid' },
    field('Sprache der Projekt-Ausgaben', language, 'Die Dashboard-Navigation ist deutsch. CLI-Ausgaben folgen dieser Auswahl.'),
    field('Kicktipp-Adresse', site, 'Standard: https://www.kicktipp.de oder https://www.kicktipp.com'),
    field('Anzeige-Zeitzone', timezone, 'IANA-Zeitzone, zum Beispiel Europe/Berlin.'),
    field('Standardstrategie', strategy), field('Warnfrist (Stunden)', warnHours), readOnly.node),
    h('hr'), h('h3', {}, 'Punktwertung'), scoringEnabled.node, scoringGrid, h('div', { class: 'actions' }, submit));
  form.addEventListener('submit', async event => {
    event.preventDefault(); submit.disabled = true;
    try {
      if (!await confirmAction('Einstellungen speichern?', 'Die Änderungen gelten auch für CLI und MCP.\nKicktipp-Adresse: ' + site.value + '\nLesemodus: ' + (readOnly.control.checked ? 'aktiv' : 'inaktiv'))) return;
      const scoring = scoringEnabled.control.checked ? Object.fromEntries(scoringFields.filter(f => f.control.value !== '').map(f => [f.key, +f.control.value])) : null;
      await runData('settings', { revision: settings.revision, language: language.value, site: site.value, timezone: timezone.value,
        strategy: strategy.value, warnHours: +warnHours.value, readOnly: readOnly.control.checked, scoring }, { confirmed: true });
      state.dirty = false; await refreshSnapshot(); await renderPage(); toast('Einstellungen gespeichert.');
    } catch (error) { showError(error); } finally { submit.disabled = false; }
  });
  main.append(card('Allgemein', 'Eine Konfiguration für das gesamte Projekt.', form),
    h('datalist', { id: 'timezones' }, ['Europe/Berlin', 'Europe/Vienna', 'Europe/Zurich', 'America/Chicago', 'UTC'].map(zone => h('option', { value: zone }))),
    card('Speicherorte', 'Diese Pfade gelten für den laufenden Prozess.', h('div', { class: 'result' }, renderValue(state.snapshot.paths))));
}
function renderBetsPage(main) {
  const tabs = [{ id: 'edit', name: 'Tipps eingeben' }, { id: 'bonus-edit', name: 'Bonusfragen' },
    ...state.snapshot.commands.filter(c => c.group === 'Tipps').map(c => ({ id: c.id, name: titles[c.id] }))];
  const active = state.tab || 'edit';
  main.append(h('div', { class: 'tabs' }, tabs.map(tab => button(tab.name, () => navigate('Tipps', tab.id), tab.id === active ? 'active' : ''))));
  if (!['edit', 'bonus-edit'].includes(active)) { renderCommandForm(main, state.snapshot.commands.find(c => c.id === active)); return; }
  const bonus = active === 'bonus-edit';
  const matchday = input('', 'number', { min: '1', max: '34', placeholder: 'Aktueller Spieltag' });
  const content = h('div');
  let loadedDay;
  const form = h('form', { class: 'compact-form' }, !bonus && field('Spieltag', matchday), h('div', { class: 'actions' }, h('button', { type: 'submit' }, bonus ? 'Bonusfragen laden' : 'Spiele laden')));
  form.addEventListener('submit', async event => {
    event.preventDefault();
    try {
      if (state.dirty && !await confirmAction('Tipps neu laden?', 'Nicht abgegebene Änderungen werden verworfen.')) return;
      state.dirty = false; loadedDay = matchday.value ? +matchday.value : undefined;
      content.replaceChildren(busyNode());
      const data = await runData(bonus ? 'bonus' : 'bets', { matchday: loadedDay });
      if (bonus) renderBonusEditor(content, data);
      else renderMatchEditor(content, data, loadedDay);
    } catch (error) { content.replaceChildren(notice(error.message, 'error')); }
  });
  main.append(card(bonus ? 'Deine Bonus-Tipps' : 'Deine Spiel-Tipps', bonus ? 'Antworten direkt aus den verfügbaren Kicktipp-Optionen wählen.' : 'Lade einen Spieltag, ändere deine Tipps und prüfe sie vor der Abgabe.', form), content);
}
function submissionButtons(bets, payload, status, afterSubmit) {
  const preview = button('Tipps prüfen', () => submit(true), 'secondary');
  const send = button('Tipps abgeben', () => submit(false), '', { disabled: state.snapshot.settings.readOnly });
  async function submit(dryRun) {
    preview.disabled = true; send.disabled = true;
    try {
      const selected = bets();
      if (!selected.length) { toast('Keine Änderungen vorhanden.'); return; }
      if (!dryRun && !await confirmAction('Tipps verbindlich abgeben?', selected.join('\n'))) return;
      state.busy = true; status.replaceChildren(busyNode(dryRun ? 'Tipps werden geprüft …' : 'Tipps werden abgegeben …'));
      const result = await runData('place', { ...payload, bets: selected, dryRun }, { confirmed: !dryRun });
      status.replaceChildren(notice(result.message));
      if (!dryRun) { state.dirty = false; await afterSubmit(); toast(result.message); }
    } catch (error) { status.replaceChildren(notice(error.message, 'error')); }
    finally { state.busy = false; preview.disabled = false; send.disabled = state.snapshot.settings.readOnly; }
  }
  return h('div', { class: 'actions' }, preview, send);
}
function renderMatchEditor(host, data, matchday) {
  if (!data.matches.length) { host.replaceChildren(card('Spiele', '', empty('Keine Spiele gefunden', 'Für diesen Spieltag sind keine Spiele verfügbar.'))); return; }
  const entries = [];
  const rows = data.matches.map(match => {
    const parts = /^\d+:\d+$/.test(match.bet) ? match.bet.split(':') : ['', ''];
    const home = input(parts[0], 'number', { min: '0', max: '999', 'data-dirty': 'true', 'aria-label': match.home + ' Tore', disabled: !match.editable || state.snapshot.settings.readOnly });
    const away = input(parts[1], 'number', { min: '0', max: '999', 'data-dirty': 'true', 'aria-label': match.away + ' Tore', disabled: !match.editable || state.snapshot.settings.readOnly });
    entries.push({ match, home, away, original: parts.join(':') });
    return h('tr', {}, h('td', { class: 'muted' }, match.date), h('td', { class: 'match-team' }, match.home),
      h('td', { class: 'match-team' }, match.away), h('td', {}, h('div', { class: 'score' }, home, h('span', {}, ':'), away)),
      h('td', {}, h('span', { class: 'badge' }, match.editable ? 'Offen' : 'Geschlossen')),
      h('td', { class: 'muted tiny' }, [match.odds.home, match.odds.draw, match.odds.away].join(' / ')));
  });
  const status = h('div', { role: 'status', class: 'result' });
  const collect = () => entries.flatMap(entry => {
    if (!entry.match.editable) return [];
    const score = entry.home.value + ':' + entry.away.value;
    if (score === entry.original) return [];
    if (![entry.home, entry.away].every(control => control.value !== '' && control.checkValidity())) throw new Error('Für geänderte Tipps beide Torzahlen vollständig eingeben. Bestehende Tipps können nicht durch leere Felder gelöscht werden.');
    return [entry.match.home + ' vs ' + entry.match.away + '=' + score];
  });
  host.replaceChildren(card(data.title || 'Spieltag', 'Nur geänderte Tipps werden abgesendet. Quoten: Heim / Remis / Gast.',
    h('div', { class: 'table-scroll' }, h('table', {}, h('thead', {}, h('tr', {}, ['Anpfiff', 'Heim', 'Gast', 'Dein Tipp', 'Status', 'Quoten'].map(text => h('th', { scope: 'col' }, text)))), h('tbody', {}, rows))),
    submissionButtons(collect, { matchday }, status, async () => renderMatchEditor(host, await runData('bets', { matchday }), matchday)), status));
}
function renderBonusEditor(host, data) {
  const groups = [];
  const content = data.questions.map(question => {
    const controls = question.selects.map((slot, index) => {
      const control = select(slot.options.map(o => [o.value, o.text]), slot.selected, { 'data-dirty': 'true', disabled: state.snapshot.settings.readOnly });
      return { control, slot, node: field(question.selects.length > 1 ? 'Platz ' + (index + 1) : 'Antwort', control) };
    });
    groups.push({ question, controls });
    return h('div', {}, h('h3', {}, question.question), h('div', { class: 'form-grid' }, controls.map(c => c.node)), h('hr'));
  });
  const collect = () => groups.flatMap(({ question, controls }) => {
    if (controls.every(c => c.control.value === c.slot.selected)) return [];
    if (controls.some(c => !c.control.value || c.control.value === '-1')) throw new Error('Für eine geänderte Bonusfrage bitte alle Antwortfelder ausfüllen.');
    return controls.map(c => question.question + '=' + c.control.selectedOptions[0].textContent);
  });
  const status = h('div', { role: 'status' });
  host.replaceChildren(card('Bonusfragen', '', content.length ? content : empty('Keine bearbeitbaren Bonusfragen', 'Hier erscheinen Bonusfragen, sobald sie zur Tippabgabe offen sind.'),
    content.length && submissionButtons(collect, { bonus: true }, status, async () => renderBonusEditor(host, await runData('bonus'))), status),
    card('Gespeicherte Antworten', '', h('div', { class: 'result' }, renderValue(data.answers))));
}
function defaultService() {
  return { schemaVersion: 1, job: { id: crypto.randomUUID(), name: 'Tipp-Erinnerung', enabled: false,
    profileId: state.profile || state.snapshot.profiles[0] || '', communityId: state.community || '',
    language: 'de', displayTimezone: state.snapshot.settings.timezone,
    policy: { excludeParticipantIds: [], stages: [{ beforeDeadlineMinutes: 360, severity: 'warning' }, { beforeDeadlineMinutes: 60, severity: 'urgent' }] },
    targetIds: [] }, targets: [] };
}
async function saveService(configuration, serviceRevision = state.snapshot.serviceRevision) {
  await runData('service-config', { configuration, revision: serviceRevision }, { confirmed: true });
  state.dirty = false; await refreshSnapshot();
}
function renderNotifications(main) {
  const snapshot = state.snapshot;
  const tabs = ['Ziele', 'Einmalige Benachrichtigung', 'Senden'];
  const active = state.tab || tabs[0];
  main.append(h('div', { class: 'tabs' }, tabs.map(tab => button(tab, () => navigate('Benachrichtigungen', tab), active === tab ? 'active' : ''))));
  if (active === 'Senden') { renderCommandForm(main, snapshot.commands.find(c => c.id === 'notify')); return; }
  if (active === 'Einmalige Benachrichtigung') {
    const kind = select([['desktop', 'Desktop'], ['webhook', 'Webhook'], ['command', 'Lokales Programm']], snapshot.notifier.kind);
    const target = input('', 'password', { autocomplete: 'new-password', placeholder: snapshot.notifier.configured ? 'Gespeichert – leer lassen zum Beibehalten' : 'URL oder Programmpfad' });
    const form = h('form', { 'data-dirty': 'true' }, h('div', { class: 'form-grid' }, field('Benachrichtigungskanal', kind),
      field('Ziel', target, 'Webhook: vollständige URL. Programm: ausführbarer Pfad; keine Shell-Befehlszeile. Desktop nutzt den Rechner, auf dem das Projekt läuft.')),
      h('div', { class: 'actions' }, h('button', { type: 'submit' }, 'Kanal speichern')));
    form.addEventListener('submit', async event => {
      event.preventDefault();
      try {
        if (!await confirmAction('Benachrichtigungskanal speichern?', kind.selectedOptions[0].textContent + (kind.value === 'command' ? '\nDieses Programm wird bei Benachrichtigungen lokal ausgeführt.' : ''))) return;
        await runData('notifier', { kind: kind.value, target: target.value || undefined }, { confirmed: true });
        target.value = ''; state.dirty = false; await refreshSnapshot(); toast('Kanal gespeichert.');
      } catch (error) { showError(error); }
    });
    main.append(card('Einmaliger Benachrichtigungskanal', 'Für „Senden“ und die CLI-Befehle notify / remind.', snapshot.notifier.fromEnvironment && notice('Der Kanal wird durch Umgebungsvariablen vorgegeben.'), form)); return;
  }
  if (!snapshot.service) {
    main.append(card('Benachrichtigungsziele', '', empty('Zuerst einen Erinnerungsauftrag anlegen', 'Speichere unter Automatisierung einen deaktivierten Auftrag. Anschließend kannst du hier Discord, Telegram, ntfy und Webhooks verbinden.',
      button('Automatisierung einrichten', () => navigate('Automatisierung'))))); return;
  }
  const targetEditor = h('div');
  const targets = snapshot.service.targets;
  main.append(card('Verbundene Ziele', 'Geheimnisse bleiben auf dem Server. Angezeigt werden ausschließlich Referenzen.',
    targets.length ? targets.map(target => h('div', { class: 'target-row' },
      h('div', {}, h('strong', {}, target.name || target.id), ' ', h('span', { class: 'badge' }, target.provider), h('p', {}, target.id + ' · ' + (target.enabled ? 'Aktiviert' : 'Deaktiviert'))),
      h('div', { class: 'actions' },
        button('Bearbeiten', () => renderTargetEditor(targetEditor, target), 'secondary small'),
        button('Test', async () => {
          if (!await confirmAction('Testnachricht senden?', 'Eine echte Testnachricht wird an ' + (target.name || target.id) + ' gesendet.')) return;
          const result = await run('command', { command: 'targets test', args: [target.id] }, { confirmed: true });
          const host = h('div', { class: 'result card' }); renderOutcome(host, result); targetEditor.replaceChildren(host);
        }, 'secondary small'),
        button(target.enabled ? 'Deaktivieren' : 'Aktivieren', async () => {
          if (!await confirmAction('Ziel ändern?', target.id + (target.enabled ? ' deaktivieren' : ' aktivieren'))) return;
          await runData('command', { command: target.enabled ? 'targets disable' : 'targets enable', args: [target.id] }, { confirmed: true });
          state.dirty = false; await refreshSnapshot(); await renderPage();
        }, 'secondary small'),
        button('Entfernen', async () => {
          if (!await confirmAction('Ziel entfernen?', target.id + ' wird aus der Service-Konfiguration entfernt.')) return;
          await runData('command', { command: 'targets remove', args: [target.id] }, { confirmed: true });
          state.dirty = false; await refreshSnapshot(); await renderPage();
        }, 'text-button small')))) : empty('Noch keine Ziele', 'Verbinde deinen ersten Benachrichtigungskanal.'),
    h('div', { class: 'actions' }, button('Ziel hinzufügen', () => renderTargetEditor(targetEditor)))),
    targetEditor);
}
function renderTargetEditor(host, existing) {
  const configuration = structuredClone(state.snapshot.service);
  const revision = state.snapshot.serviceRevision;
  const id = input(existing?.id || '', 'text', { required: true, pattern: '[A-Za-z0-9][A-Za-z0-9._\\-]*', disabled: !!existing, placeholder: 'z. B. telegram-privat' });
  const name = input(existing?.name || '');
  const provider = select(['discord', 'telegram', 'ntfy', 'webhook'], existing?.provider || 'discord');
  const enabled = check('Ziel aktivieren', existing?.enabled ?? true);
  const useForJob = check('Für diesen Erinnerungsauftrag verwenden', existing ? configuration.job.targetIds.includes(existing.id) : true);
  const providerFields = h('div', { class: 'form-grid' });
  const secretFields = [], values = {};
  const insecure = check('Unverschlüsseltes HTTP ausdrücklich erlauben', existing?.allowInsecureHttp || false);
  function rebuild() {
    providerFields.replaceChildren(); secretFields.length = 0; Object.keys(values).forEach(k => delete values[k]);
    insecure.node.hidden = !['ntfy', 'webhook'].includes(provider.value);
    const source = provider.value === existing?.provider ? existing : {};
    function plain(key, title, type = 'text', required = true, fallback = '') {
      const control = input(source[key] ?? fallback, type, { required }); values[key] = control; providerFields.append(field(title, control));
    }
    function secret(key, title, optional = false) {
      const mode = select([['reference', 'Referenz'], ['secret', 'Geheimnis lokal speichern']], source[key] ? 'reference' : 'secret');
    const control = input(source[key] || '', source[key] ? 'text' : 'password', { required: !optional, autocomplete: 'new-password', 'aria-label': title + ' Wert' });
      mode.addEventListener('change', () => { control.type = mode.value === 'secret' ? 'password' : 'text'; control.value = ''; });
      secretFields.push({ key, mode, control });
      providerFields.append(field(title, h('div', {}, mode, control), 'Referenzen: local:NAME, env:NAME oder file:ABSOLUTER_PFAD. Neue Werte werden nie zurückgelesen.'));
    }
    if (provider.value === 'discord') secret('webhookUrlRef', 'Discord-Webhook');
    if (provider.value === 'telegram') { secret('botTokenRef', 'Bot-Token'); plain('chatId', 'Chat-ID'); plain('topicId', 'Thread-/Topic-ID (optional)', 'number', false); }
    if (provider.value === 'ntfy') { plain('serverUrl', 'Server', 'url', true, 'https://ntfy.sh'); plain('topic', 'Topic'); secret('tokenRef', 'Access-Token (optional)', true); }
    if (provider.value === 'webhook') {
      secret('urlRef', 'Webhook-URL');
      const headers = h('textarea', {}, Object.entries(source.headers || {}).map(([k, v]) => k + '=' + v).join('\n')); values.headers = headers;
      providerFields.append(field('Zusätzliche Header', headers, 'Ein Header pro Zeile: Header-Name=env:SECRET. Geheimnisse können unten als lokale Referenz gespeichert werden.'));
    }
  }
  provider.addEventListener('change', rebuild); rebuild();
  const submit = h('button', { type: 'submit' }, 'Ziel speichern');
  const form = h('form', { 'data-dirty': 'true' }, h('div', { class: 'form-grid' }, field('ID', id), field('Anzeigename (optional)', name), field('Anbieter', provider)),
    h('hr'), providerFields, insecure.node, enabled.node, useForJob.node,
    h('div', { class: 'actions' }, submit, button('Abbrechen', () => { host.replaceChildren(); state.dirty = false; }, 'secondary')));
  form.addEventListener('submit', async event => {
    event.preventDefault(); submit.disabled = true;
    try {
      if (!await confirmAction('Benachrichtigungsziel speichern?', (name.value || id.value) + ' · ' + provider.value + '\nDas Ziel wird ' + (useForJob.control.checked ? '' : 'nicht ') + 'dem Auftrag zugeordnet.')) return;
      const target = { id: id.value, ...(name.value ? { name: name.value } : {}), provider: provider.value, enabled: enabled.control.checked };
      for (const [key, control] of Object.entries(values)) {
        if (!control.value) continue;
        if (key === 'headers') {
          const headers = {};
          for (const line of control.value.split(/\r?\n/).filter(v => v.trim())) {
            const eq = line.indexOf('='); if (eq < 1) throw new Error('Headerformat: Name=Referenz');
            const key = line.slice(0, eq).trim();
            if (Object.keys(headers).some(name => name.toLowerCase() === key.toLowerCase())) throw new Error('Doppelter Header: ' + key);
            headers[key] = line.slice(eq + 1).trim();
          }
          target.headers = headers;
        } else target[key] = key === 'topicId' ? +control.value : control.value;
      }
      for (const entry of secretFields) {
        if (!entry.control.value) continue;
        if (entry.mode.value === 'secret') {
          const saved = await runData('secret', { value: entry.control.value }, { confirmed: true });
          entry.control.value = saved.reference; entry.control.type = 'text'; entry.mode.value = 'reference';
        }
        target[entry.key] = entry.control.value;
      }
      if (['ntfy', 'webhook'].includes(target.provider)) target.allowInsecureHttp = insecure.control.checked;
      configuration.targets = configuration.targets.filter(t => t.id !== existing?.id);
      if (configuration.targets.some(t => t.id === target.id)) throw new Error('Diese Ziel-ID existiert bereits.');
      configuration.targets.push(target);
      configuration.job.targetIds = configuration.job.targetIds.filter(t => t !== target.id);
      if (useForJob.control.checked) configuration.job.targetIds.push(target.id);
      await saveService(configuration, revision); await renderPage(); toast('Benachrichtigungsziel gespeichert.');
    } catch (error) { showError(error); } finally { submit.disabled = false; }
  });
  const headerSecret = input('', 'password', { autocomplete: 'new-password' });
  const reference = h('code');
  host.replaceChildren(card(existing ? 'Ziel bearbeiten' : 'Neues Ziel', 'Änderungen gelten für zukünftige Zustellungen. Bestehende Zustellungen behalten ihre eindeutige Zuordnung.', form,
    h('details', {}, h('summary', {}, 'Lokales Geheimnis für einen Header speichern'),
      field('Geheimnis', headerSecret), h('div', { class: 'actions' }, button('Referenz erzeugen', async () => {
        const saved = await runData('secret', { value: headerSecret.value }, { confirmed: true });
        headerSecret.value = ''; reference.textContent = saved.reference;
      }, 'secondary'), reference))));
  host.scrollIntoView({ block: 'start', behavior: 'smooth' });
}
function renderAutomation(main) {
  const snapshot = state.snapshot;
  const active = state.tab || 'Auftrag';
  const commands = snapshot.commands.filter(c => c.group === 'Automatisierung');
  main.append(h('div', { class: 'tabs' }, [{ id: 'Auftrag', title: 'Auftrag' }, { id: 'Dienst', title: 'Dienst steuern' }, ...commands.map(c => ({ id: c.id, title: titles[c.id] }))].map(tab => button(tab.title, () => navigate('Automatisierung', tab.id), active === tab.id ? 'active' : ''))));
  if (active === 'Dienst') { renderServiceControl(main); return; }
  if (active !== 'Auftrag') { renderCommandForm(main, commands.find(c => c.id === active)); return; }
  if (snapshot.serviceError) main.append(notice(snapshot.serviceError, 'error'));
  const configuration = structuredClone(snapshot.service || defaultService());
  const job = configuration.job;
  const name = input(job.name, 'text', { required: true });
  const enabled = check('Erinnerungsauftrag aktivieren', job.enabled, 'Mindestens ein aktiviertes Ziel muss zugeordnet sein.');
  const profile = select([['', 'Benanntes Profil auswählen'], ...snapshot.profiles], job.profileId, { required: true });
  const community = input(job.communityId, 'text', { required: true });
  const language = input(job.language, 'text', { required: true });
  const timezone = input(job.displayTimezone, 'text', { required: true });
  const excluded = h('textarea', {}, job.policy.excludeParticipantIds.join('\n'));
  const stages = h('div');
  const stageControls = [];
  function addStage(stage = { beforeDeadlineMinutes: 60, severity: 'warning' }) {
    const minutes = input(stage.beforeDeadlineMinutes, 'number', { min: '1', required: true });
    const severity = select([['info', 'Info'], ['warning', 'Warnung'], ['urgent', 'Dringend']], stage.severity);
    const row = h('div', { class: 'stage' }, field('Minuten vor Tippfrist', minutes), field('Dringlichkeit', severity),
      button('×', () => { row.remove(); stageControls.splice(stageControls.findIndex(c => c.row === row), 1); state.dirty = true; }, 'secondary', { 'aria-label': 'Erinnerungsstufe entfernen' }));
    stageControls.push({ row, minutes, severity }); stages.append(row);
  }
  job.policy.stages.forEach(addStage);
  const targets = configuration.targets.map(target => ({ id: target.id, ...check((target.name || target.id) + (target.enabled ? '' : ' (deaktiviert)'), job.targetIds.includes(target.id)) }));
  const submit = h('button', { type: 'submit' }, 'Auftrag speichern');
  const form = h('form', { 'data-dirty': 'true' },
    !snapshot.profiles.length && notice('Für den Dienst ist ein benanntes Profil nötig. Unter Konten einen Profilnamen eingeben und verbinden.', 'warning'),
    h('div', { class: 'form-grid' }, field('Name', name), field('Konto', profile), field('Community', community),
      field('Sprache der Erinnerungen', language, 'Sprachcode, z. B. de oder en.'), field('Zeitzone', timezone)), enabled.node,
    h('hr'), h('h3', {}, 'Erinnerungsstufen'), h('p', { class: 'tiny' }, 'Prüft die nächste gemeinsame Tippfrist und erinnert Teilnehmer, denen mindestens ein Tipp dieser Spielgruppe fehlt.'),
    stages, button('Stufe hinzufügen', () => { addStage(); state.dirty = true; }, 'secondary'),
    h('hr'), h('h3', {}, 'Benachrichtigungsziele'), targets.length ? targets.map(t => t.node) : notice('Noch keine Ziele. Auftrag deaktiviert speichern, dann unter Benachrichtigungen ein Ziel hinzufügen.'),
    h('hr'), field('Ausgeschlossene Teilnehmer-IDs', excluded, 'Eine ID pro Zeile. Verfügbare IDs findest du unter Spielleitung → Mitglieder.'),
    h('details', {}, h('summary', {}, 'Auftragsidentität'), h('code', {}, job.id), h('p', { class: 'tiny' }, 'Die ID bleibt erhalten, damit Zustellungen beim Bearbeiten nicht doppelt ausgelöst werden.')),
    h('div', { class: 'actions' }, submit));
  form.addEventListener('submit', async event => {
    event.preventDefault(); submit.disabled = true;
    try {
      if (!await confirmAction('Erinnerungsauftrag speichern?', name.value + '\nKonto: ' + profile.value + '\nCommunity: ' + community.value + '\nAktiviert: ' + (enabled.control.checked ? 'Ja' : 'Nein'))) return;
      Object.assign(job, { name: name.value, enabled: enabled.control.checked, profileId: profile.value, communityId: community.value,
        language: language.value, displayTimezone: timezone.value, targetIds: targets.filter(t => t.control.checked).map(t => t.id) });
      job.policy.excludeParticipantIds = excluded.value.split(/\r?\n/).map(s => s.trim()).filter(Boolean);
      job.policy.stages = stageControls.map(c => ({ beforeDeadlineMinutes: +c.minutes.value, severity: c.severity.value }));
      await saveService(configuration); await renderPage(); toast('Erinnerungsauftrag gespeichert.');
    } catch (error) { showError(error); } finally { submit.disabled = false; }
  });
  main.append(card('Erinnerungsauftrag', 'Ein dauerhafter Auftrag mit mehreren Kanälen und Erinnerungsstufen.', form));
}
function renderServiceControl(main) {
  const logFormat = select(['text', 'json'], 'text');
  const status = h('div');
  const logs = h('div', { class: 'result' });
  const start = button('Dienst starten', async () => {
    if (!await confirmAction('Erinnerungsdienst starten?', 'Der Dienst bleibt aktiv und kann echte Benachrichtigungen an die konfigurierten Ziele senden.')) return;
    await run('service-start', { logFormat: logFormat.value }, { confirmed: true, background: true });
    state.dirty = false; await update(); toast('Dienst wird gestartet.');
  });
  const stop = button('Dienst stoppen', async () => {
    if (!await confirmAction('Erinnerungsdienst stoppen?', 'Der hier gestartete Dienst wird geordnet beendet. Laufende Zustellungen dürfen noch abschließen.')) return;
    await run('service-stop', {}, { confirmed: true, background: true }); await update(); toast('Beendigung angefordert.');
  }, 'secondary');
  async function update() {
    const runtime = await api('runtime');
    start.disabled = runtime.running; stop.disabled = !runtime.running;
    status.replaceChildren(notice(runtime.running ? 'Der vom Dashboard gestartete Dienst läuft.' : 'Aktuell läuft kein vom Dashboard gestarteter Dienst.'));
    if (runtime.jobId) renderOutcome(logs, await api('jobs/' + runtime.jobId));
  }
  main.append(card('Erinnerungsdienst', 'Starten und Stoppen steuert ausschließlich den von diesem Dashboard gestarteten Prozess.',
    field('Logformat', logFormat), h('div', { class: 'actions' }, start, stop, button('Status aktualisieren', update, 'secondary')),
    h('hr'), status, logs),
    card('Fehlenden Zustand wiederherstellen', 'Nur verwenden, wenn service-state.json fehlt. Ein bestehender Zustand wird nicht überschrieben.',
      notice('Nach einem Zustandsverlust könnten bereits gesendete Erinnerungen erneut zugestellt werden.', 'warning'),
      button('Fehlenden Zustand initialisieren', async () => {
        if (!await confirmAction('Mögliche doppelte Erinnerungen akzeptieren?', 'Der fehlende Service-Zustand wird neu angelegt. Bereits gesendete Erinnerungen können danach erneut zugestellt werden.')) return;
        const data = await runData('service-initialize', {}, { confirmed: true }); toast(data.message); await refreshSnapshot();
      }, 'secondary')));
  update().catch(showError);
}
const mobile = matchMedia('(max-width: 760px)');
function setMenu(open) {
  document.body.classList.toggle('menu-open', open);
  $('#menu').setAttribute('aria-expanded', String(open));
  $('#sidebar').inert = mobile.matches && !open;
}
$('#menu').addEventListener('click', () => { setMenu(true); $('#menu-close').focus(); });
$('#menu-close').addEventListener('click', () => { setMenu(false); $('#menu').focus(); });
mobile.addEventListener('change', () => setMenu(false));
setMenu(false);
document.addEventListener('keydown', event => { if (event.key === 'Escape' && document.body.classList.contains('menu-open')) { setMenu(false); $('#menu').focus(); } });
$('#profile').addEventListener('change', async event => {
  const next = event.target.value || null;
  if (state.busy || state.dirty && !await confirmAction('Konto wechseln?', 'Nicht gespeicherte Eingaben werden verworfen.')) { event.target.value = state.profile || ''; return; }
  state.busy = true;
  try { state.profile = next; state.community = null; state.dirty = false; await refreshSnapshot(); sessionStorage.setItem('kicktipp-profile', next || ''); await renderPage(); }
  catch (error) { showError(error); }
  finally { state.busy = false; }
});
document.addEventListener('input', event => { if (event.target.closest('[data-dirty]')) state.dirty = true; });
window.addEventListener('beforeunload', event => { if (state.dirty || state.busy) { event.preventDefault(); event.returnValue = ''; } });
try {
  if (sessionStorage.getItem('kicktipp-profile') === null) {
    const initial = await api('runtime'); state.profile = initial.profile; state.community = initial.community;
  }
  await refreshSnapshot(); await renderPage();
}
catch (error) { $('#content').replaceChildren(heading('Verbindung erforderlich', 'Öffne den vollständigen Link aus dem Terminal.'), notice(error.message, 'error'), button('Erneut versuchen', () => location.reload(), 'secondary')); }
