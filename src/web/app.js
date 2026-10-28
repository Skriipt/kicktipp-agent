'use strict';

const messages = {
  "error_restart_required": { "en": "The settings file changed outside this page. Restart the service to load it.", "de": "Die Einstellungsdatei wurde außerhalb dieser Seite geändert. Starte den Dienst neu, um sie zu laden." },
  "overview": {
    "de": "Übersicht",
    "en": "Overview"
  },
  "notifications": {
    "de": "Benachrichtigungen",
    "en": "Notifications"
  },
  "account": {
    "de": "Konto",
    "en": "Account"
  },
  "agent": {
    "de": "Agent verbinden",
    "en": "Connect agent"
  },
  "openTitle": {
    "en": "{count} predictions missing",
    "de": "{count} Tipps fehlen"
  },
  "matchday": {
    "en": "Matchday {value}",
    "de": "{value}. Spieltag"
  },
  "missing": {
    "de": "Tipp fehlt",
    "en": "Missing"
  },
  "checkAgain": {
    "de": "Erneut prüfen",
    "en": "Check again"
  },
  "service": {
    "de": "Dienst",
    "en": "Service"
  },
  "login": {
    "de": "Kicktipp-Anmeldung",
    "en": "Kicktipp login"
  },
  "confirmed": {
    "de": "Bestätigt",
    "en": "Confirmed"
  },
  "lastChecked": {
    "de": "Zuletzt geprüft",
    "en": "Last checked"
  },
  "nextCheck": {
    "de": "Nächste Prüfung",
    "en": "Next check"
  },
  "noErrors": {
    "en": "None reported",
    "de": "Keine gemeldet"
  },
  "readOnlyTitle": {
    "de": "Der Agent darf nur lesen",
    "en": "The agent has read-only access"
  },
  "readOnlyBody": {
    "de": "Tipps abgeben und ändern ist ausgeschaltet.",
    "en": "Submitting and editing predictions is turned off."
  },
  "accessSettings": {
    "de": "Zugriff einstellen",
    "en": "Manage access"
  },
  "edit": {
    "de": "Bearbeiten",
    "en": "Edit"
  },
  "configured": {
    "de": "Eingerichtet",
    "en": "Configured"
  },
  "notConfigured": {
    "de": "Nicht eingerichtet",
    "en": "Not configured"
  },
  "reminderCaption": {
    "de": "Vor Anstoß, nur wenn dein Tipp noch fehlt.",
    "en": "Before kickoff, only for missing predictions."
  },
  "channels": {
    "de": "Kanäle",
    "en": "Channels"
  },
  "webhookUrl": {
    "de": "Webhook-URL",
    "en": "Webhook URL"
  },
  "chatId": {
    "de": "Chat-ID",
    "en": "Chat ID"
  },
  "testMessage": {
    "de": "Testnachricht senden",
    "en": "Send test message"
  },
  "beforeKickoff": {
    "de": "Vor Anstoß erinnern",
    "en": "Remind me before kickoff"
  },
  "sharedTimes": {
    "de": "Diese Zeiten gelten für alle Kanäle. Bereits getippte Spiele werden übersprungen.",
    "en": "These times apply to every channel. Games with a prediction are skipped."
  },
  "interval": {
    "de": "Prüfintervall",
    "en": "Check interval"
  },
  "timezone": {
    "de": "Zeitzone",
    "en": "Time zone"
  },
  "save": {
    "de": "Speichern",
    "en": "Save"
  },
  "email": {
    "de": "E-Mail",
    "en": "Email"
  },
  "password": {
    "de": "Passwort",
    "en": "Password"
  },
  "website": {
    "de": "Kicktipp-Seite",
    "en": "Kicktipp site"
  },
  "pool": {
    "de": "Tipprunde",
    "en": "Prediction pool"
  },
  "singlePool": {
    "de": "Der Dienst verwendet ein Konto und eine Tipprunde.",
    "en": "The service uses one account and one prediction pool."
  },
  "checkLogin": {
    "de": "Anmeldung prüfen",
    "en": "Check login"
  },
  "mcpAddress": {
    "de": "MCP-Adresse",
    "en": "MCP address"
  },
  "copy": {
    "de": "Kopieren",
    "en": "Copy"
  },
  "token": {
    "de": "Zugangstoken",
    "en": "Access token"
  },
  "tokenHelp": {
    "de": "Im MCP-Client als Bearer-Token hinterlegen.",
    "en": "Use this as the bearer token in your MCP client."
  },
  "permission": {
    "de": "Tipps abgeben und ändern",
    "en": "Submit and edit predictions"
  },
  "permissionOff": {
    "de": "Ausgeschaltet. Der Agent darf nur lesen.",
    "en": "Off. The agent can only read."
  },
  "hoursLabel": {
    "de": "Stunden vor Anstoß",
    "en": "Hours before kickoff"
  },
  "hoursPlaceholder": {
    "de": "z. B. 2,5",
    "en": "e.g. 2.5"
  },
  "addTime": {
    "de": "Zeit hinzufügen",
    "en": "Add time"
  },
  "hoursHelp": {
    "en": "Add up to 10 times, no more than 168 hours ahead.",
    "de": "Bis zu 10 Zeiten, höchstens 168 Stunden im Voraus."
  },
  "reminderTimes": {
    "de": "Erinnerungszeiten",
    "en": "Reminder times"
  },
  "noTimes": {
    "de": "Noch keine Erinnerungszeiten hinzugefügt.",
    "en": "No reminder times added yet."
  },
  "noSavedTimes": {
    "de": "Keine Erinnerungszeiten festgelegt",
    "en": "No reminder times set"
  },
  "language": {
    "de": "Sprache",
    "en": "Language"
  },
  "mainNav": {
    "de": "Hauptnavigation",
    "en": "Main navigation"
  },
  "botToken": {
    "de": "Bot-Token",
    "en": "Bot token"
  },
  "description": {
    "en": "Manage your local Kicktipp agent.",
    "de": "Verwalte deinen lokalen Kicktipp-Agenten."
  },
  "hourOne": {
    "de": "{value} Stunde",
    "en": "{value} hour"
  },
  "hourMany": {
    "de": "{value} Stunden",
    "en": "{value} hours"
  },
  "removeTime": {
    "de": "{time} entfernen",
    "en": "Remove {time}"
  },
  "invalidHours": {
    "de": "Gib eine Zahl größer als 0 und höchstens 168 ein.",
    "en": "Enter a number greater than 0 and no more than 168."
  },
  "duplicateTime": {
    "de": "Diese Zeit ist bereits eingetragen.",
    "en": "This time is already added."
  },
  "maxTimes": {
    "de": "Du kannst bis zu 10 Erinnerungszeiten hinzufügen.",
    "en": "You can add up to 10 reminder times."
  },
  "needTime": {
    "en": "Choose at least one reminder time when channels are configured.",
    "de": "Lege mindestens eine Erinnerungszeit fest, wenn Kanäle eingerichtet sind."
  },
  "timeAdded": {
    "de": "{time} hinzugefügt.",
    "en": "Added {time}."
  },
  "timeRemoved": {
    "de": "{time} entfernt.",
    "en": "Removed {time}."
  },
  "unsaved": {
    "en": "Unsaved changes.",
    "de": "Ungespeicherte Änderungen."
  },
  "saved": {
    "en": "Saved. The changes are active.",
    "de": "Gespeichert. Die Änderungen sind aktiv."
  },
  "testSent": {
    "en": "Test message sent.",
    "de": "Testnachricht gesendet."
  },
  "loginTest": {
    "en": "Login confirmed. Your prediction pools have been loaded.",
    "de": "Anmeldung bestätigt. Deine Tipprunden wurden geladen."
  },
  "invalidUrl": {
    "de": "Gib eine gültige HTTP- oder HTTPS-Adresse ein.",
    "en": "Enter a valid HTTP or HTTPS URL."
  },
  "telegramRequired": {
    "en": "Enter a bot token and a chat ID.",
    "de": "Gib einen Bot-Token und eine Chat-ID ein."
  },
  "invalidEmail": {
    "de": "Gib eine gültige E-Mail-Adresse ein.",
    "en": "Enter a valid email address."
  },
  "requiredPassword": {
    "en": "Enter your Kicktipp password.",
    "de": "Gib dein Kicktipp-Passwort ein."
  },
  "permissionOn": {
    "en": "On. The agent can submit and edit predictions.",
    "de": "Eingeschaltet. Der Agent darf Tipps abgeben und ändern."
  },
  "writeTitle": {
    "de": "Der Agent darf Tipps abgeben",
    "en": "The agent can submit predictions"
  },
  "writeBody": {
    "en": "Submitting and editing predictions is turned on.",
    "de": "Abgeben und Ändern von Tipps ist eingeschaltet."
  },
  "copied": {
    "de": "MCP-Adresse kopiert.",
    "en": "MCP address copied."
  },
  "copyUnavailable": {
    "de": "Kopieren hier nicht verfügbar. Die Adresse lässt sich oben markieren.",
    "en": "Copying is unavailable here. Select the address above to copy it."
  },
  "emptyTitle": {
    "de": "Alle Tipps abgegeben",
    "en": "All predictions submitted"
  },
  "loadingTitle": {
    "de": "Tipps werden geprüft",
    "en": "Checking predictions"
  },
  "loginNeeded": {
    "de": "Anmeldung nötig",
    "en": "Login needed"
  },
  "checkDone": {
    "en": "Predictions updated.",
    "de": "Tipps aktualisiert."
  },
  "intervalDynamic": {
    "de": "Geprüft wird alle {minutes} Minuten.",
    "en": "Checked every {minutes} minutes."
  },
  "skip": {
    "en": "Skip to content",
    "de": "Zum Inhalt"
  },
  "signIn": {
    "en": "Sign in",
    "de": "Anmelden"
  },
  "signOut": {
    "en": "Sign out",
    "de": "Abmelden"
  },
  "adminIntro": {
    "en": "Enter your local admin token to manage this service.",
    "de": "Gib deinen lokalen Admin-Token ein, um den Dienst einzurichten."
  },
  "adminCommand": {
    "en": "Get the token from the running container:",
    "de": "Den Token erhältst du im laufenden Container:"
  },
  "adminToken": {
    "en": "Admin token",
    "de": "Admin-Token"
  },
  "adminHelp": {
    "en": "This is separate from the token used by your MCP client.",
    "de": "Dieser Token ist unabhängig vom Token für deinen MCP-Client."
  },
  "tokenRequired": {
    "en": "Enter your admin token.",
    "de": "Gib deinen Admin-Token ein."
  },
  "setupIntro": {
    "en": "Connect your Kicktipp account first. You can add reminders afterward.",
    "de": "Verbinde zuerst dein Kicktipp-Konto. Erinnerungen kannst du danach einrichten."
  },
  "localService": {
    "en": "Local service",
    "de": "Lokaler Dienst"
  },
  "conflict": {
    "en": "Settings changed elsewhere. Reload the saved settings before saving again.",
    "de": "Die Einstellungen wurden anderswo geändert. Lade den gespeicherten Stand, bevor du erneut speicherst."
  },
  "reloadWarning": {
    "en": "Reloading discards unsaved edits on this page.",
    "de": "Beim Neuladen gehen ungespeicherte Änderungen auf dieser Seite verloren."
  },
  "reloadConfig": {
    "en": "Reload saved settings",
    "de": "Gespeicherten Stand laden"
  },
  "notChecked": {
    "en": "Not checked yet",
    "de": "Noch nicht geprüft"
  },
  "noReport": {
    "en": "Check your predictions to see the upcoming games.",
    "de": "Prüfe deine Tipps, um die nächsten Spiele zu sehen."
  },
  "lastSuccess": {
    "en": "Last successful read",
    "de": "Zuletzt erfolgreich gelesen"
  },
  "statusHelp": {
    "en": "A running service does not confirm that login or message delivery succeeded.",
    "de": "Ein laufender Dienst bestätigt weder die Anmeldung noch die Zustellung von Nachrichten."
  },
  "unknown": {
    "en": "Unknown",
    "de": "Unbekannt"
  },
  "notScheduled": {
    "en": "Not scheduled",
    "de": "Nicht geplant"
  },
  "noChannels": {
    "en": "No channels configured.",
    "de": "Keine Kanäle eingerichtet."
  },
  "addChannel": {
    "en": "Add channel",
    "de": "Kanal hinzufügen"
  },
  "channelType": {
    "en": "Channel type",
    "de": "Kanaltyp"
  },
  "removeChannel": {
    "en": "Remove {name}",
    "de": "{name} entfernen"
  },
  "newChannel": {
    "en": "New channel",
    "de": "Neuer Kanal"
  },
  "savedSecret": {
    "en": "Saved. Leave blank to keep the current value.",
    "de": "Gespeichert. Leer lassen, um den bisherigen Wert zu behalten."
  },
  "enterSecret": {
    "en": "Enter the credentials for this channel.",
    "de": "Gib die Zugangsdaten für diesen Kanal ein."
  },
  "telegramHelp": {
    "en": "Create a bot with @BotFather. Open the bot, send /start and enter the chat ID.",
    "de": "Erstelle einen Bot bei @BotFather. Öffne den Bot, sende /start und trage die Chat-ID ein."
  },
  "discordHelp": {
    "en": "Create a webhook under Integrations in your Discord channel settings.",
    "de": "Erstelle einen Webhook in den Einstellungen deines Discord-Kanals unter Integrationen."
  },
  "webhookHelp": {
    "en": "The destination receives a JSON POST containing the reminder data.",
    "de": "Die Zieladresse erhält einen JSON-POST mit den Erinnerungsdaten."
  },
  "minutes": {
    "en": "minutes",
    "de": "Minuten"
  },
  "invalidInterval": {
    "en": "Enter a check interval from 1 to 1440 minutes.",
    "de": "Gib ein Prüfintervall von 1 bis 1440 Minuten ein."
  },
  "invalidZone": {
    "en": "Enter a valid time zone, for example Europe/Berlin.",
    "de": "Gib eine gültige Zeitzone ein, zum Beispiel Europe/Berlin."
  },
  "noPools": {
    "en": "Login confirmed. No prediction pools were found.",
    "de": "Anmeldung bestätigt. Es wurden keine Tipprunden gefunden."
  },
  "newIdentityPassword": {
    "en": "Enter the password for this account.",
    "de": "Gib für dieses Konto das Passwort erneut ein."
  },
  "poolHelp": {
    "en": "Use the pool name from its Kicktipp URL, or check your login to load your pools.",
    "de": "Nutze den Rundennamen aus der Kicktipp-URL oder lade deine Runden über „Anmeldung prüfen“."
  },
  "player": {
    "en": "Player name (optional)",
    "de": "Spielername (optional)"
  },
  "invalidPool": {
    "en": "Enter the pool name from its Kicktipp URL.",
    "de": "Gib den Rundennamen aus der Kicktipp-URL ein."
  },
  "showToken": {
    "en": "Show token",
    "de": "Token anzeigen"
  },
  "hideToken": {
    "en": "Hide token",
    "de": "Token verbergen"
  },
  "loading": {
    "en": "Loading…",
    "de": "Wird geladen…"
  },
  "openTitleOne": {
    "en": "1 prediction missing",
    "de": "1 Tipp fehlt"
  },
  "closed": {
    "en": "Closed",
    "de": "Geschlossen"
  },
  "noGames": {
    "en": "No games found.",
    "de": "Keine Spiele gefunden."
  },
  "unknownKickoff": {
    "en": "Time unknown",
    "de": "Zeit unbekannt"
  },
  "asOf": {
    "en": "As of {time}",
    "de": "Stand: {time}"
  },
  "staleTitle": {
    "en": "Last known predictions",
    "de": "Zuletzt gelesene Tipps"
  },
  "notAvailable": {
    "en": "Predictions currently unavailable",
    "de": "Tipps derzeit nicht verfügbar"
  },
  "failedChannels": {
    "en": "{count} channel errors",
    "de": "{count} Kanalfehler"
  },
  "disabled": {
    "en": "Not configured",
    "de": "Nicht eingerichtet"
  },
  "atLeastOneChannel": {
    "en": "Add a channel first.",
    "de": "Füge zuerst einen Kanal hinzu."
  },
  "maxChannels": {
    "en": "You can configure up to 20 channels.",
    "de": "Du kannst bis zu 20 Kanäle einrichten."
  },
  "error_unauthorized": {
    "en": "The admin token is invalid. Sign in again.",
    "de": "Der Admin-Token ist ungültig. Melde dich erneut an."
  },
  "error_setup_required": {
    "en": "Connect your Kicktipp account first.",
    "de": "Verbinde zuerst dein Kicktipp-Konto."
  },
  "error_invalid_config": {
    "en": "These settings are invalid. Check the entered values.",
    "de": "Die Einstellungen sind ungültig. Prüfe die eingegebenen Werte."
  },
  "error_config_conflict": {
    "en": "Settings changed elsewhere. Reload the saved settings.",
    "de": "Die Einstellungen wurden anderswo geändert. Lade den gespeicherten Stand."
  },
  "error_invalid_channel": {
    "en": "The channel settings are invalid.",
    "de": "Die Kanaleinstellungen sind ungültig."
  },
  "error_login_failed": {
    "en": "Login failed. Check your email, password, site and connection.",
    "de": "Anmeldung fehlgeschlagen. Prüfe E-Mail, Passwort, Seite und Verbindung."
  },
  "error_delivery_failed": {
    "en": "The message could not be delivered. Check the destination, credentials and permissions.",
    "de": "Die Nachricht konnte nicht zugestellt werden. Prüfe Ziel, Zugangsdaten und Berechtigungen."
  },
  "error_check_failed": {
    "en": "Could not read Kicktipp. Check the connection and try again later.",
    "de": "Kicktipp konnte nicht gelesen werden. Prüfe die Verbindung und versuche es später erneut."
  },
  "error_account_required": {
    "en": "Connect your Kicktipp account first.",
    "de": "Verbinde zuerst dein Kicktipp-Konto."
  },
  "error_request_failed": {
    "en": "The request could not be completed.",
    "de": "Die Anfrage konnte nicht abgeschlossen werden."
  },
  "error_network": {
    "en": "No response from the service. Reload saved settings to check for changes.",
    "de": "Keine Antwort vom Dienst. Lade den gespeicherten Stand, um Änderungen zu prüfen."
  },
  "error_auth_required": {
    "en": "Your Kicktipp login needs attention. Check your account.",
    "de": "Die Kicktipp-Anmeldung muss erneuert werden. Prüfe dein Konto."
  },
  "error_state_failed": {
    "en": "The service could not save reminder history. Check its data storage.",
    "de": "Der Dienst konnte die Erinnerungshistorie nicht speichern. Prüfe den Datenträger."
  },
  "error_stopping": {
    "en": "The service is shutting down. Try again shortly.",
    "de": "Der Dienst wird gerade beendet. Versuche es gleich erneut."
  },
  "error_origin_not_allowed": {
    "en": "This address is not allowed for administration. Use the local address.",
    "de": "Diese Adresse ist für die Verwaltung nicht freigegeben. Nutze den lokalen Zugang."
  },
  "error_operation_failed": {
    "en": "The change could not be applied. Reload the saved settings.",
    "de": "Die Änderung konnte nicht übernommen werden. Lade den gespeicherten Stand."
  },
  "error_apply_failed": {
    "en": "Saved, but not activated. Reload the status and restart the service if needed.",
    "de": "Gespeichert, aber nicht aktiviert. Lade den Status und starte den Dienst bei Bedarf neu."
  },
  "accountChangeWarning": {
    "en": "Switching accounts will discard unsaved notification and access edits.",
    "de": "Beim Kontowechsel gehen ungespeicherte Änderungen an Benachrichtigungen und Zugriffsrechten verloren."
  },
  "accountChanged": {
    "en": "Account saved. Unsaved notification and access edits were discarded.",
    "de": "Konto gespeichert. Ungespeicherte Änderungen an Benachrichtigungen und Zugriffsrechten wurden verworfen."
  }
};

const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => Array.from(document.querySelectorAll(selector));
let language = 'en';
try { if (localStorage.getItem('kicktipp-language') === 'de') language = 'de'; } catch {}
let token = '';
let epoch = 0;
let config = null;
let revision = '';
let overview = null;
let currentPage = 'overview';
let channelDrafts = [];
let selectedChannel = null;
let hours = [];
let channelSequence = 0;
const dirty = new Set();
let loadingOverview = false;
let overviewRequest = 0;

function t(key, params = {}) {
  let result = messages[key]?.[language] || messages.error_request_failed[language];
  for (const [name, value] of Object.entries(params)) result = result.replaceAll(`{${name}}`, String(value));
  return result;
}
function hoursText(value) {
  return t(value === 1 ? 'hourOne' : 'hourMany', { value: new Intl.NumberFormat(language, { maximumSignificantDigits: 15 }).format(value) });
}
function message(element, key, params = {}, error = false) {
  element.dataset.message = key;
  element.dataset.params = JSON.stringify(params);
  element.classList.toggle('error', error);
  renderMessage(element);
}
function renderMessage(element) {
  if (!element.dataset.message) return;
  const params = JSON.parse(element.dataset.params || '{}');
  if ('hours' in params) params.time = hoursText(params.hours);
  element.textContent = t(element.dataset.message, params);
}
function clearMessage(element) {
  delete element.dataset.message;
  delete element.dataset.params;
  element.textContent = '';
  element.classList.remove('error');
}
function markDirty(panel) { dirty.add(panel); renderAccountNotice(); }
function fieldError(input, target, key) {
  input.setAttribute('aria-invalid', 'true');
  message(target, key, {}, true);
  input.focus();
  return false;
}
function clearInvalid(parent = document) {
  parent.querySelectorAll('[aria-invalid]').forEach(input => input.removeAttribute('aria-invalid'));
}
function errorKey(error) {
  return messages[`error_${error.code}`] ? `error_${error.code}` : 'error_request_failed';
}
function showError(target, error) {
  if (error.code === 'stale_session') return;
  if (error.code === 'config_conflict') $('#conflict-banner').hidden = false;
  if (error.code === 'unauthorized') message($('#login-feedback'), 'error_unauthorized', {}, true);
  else message(target, errorKey(error), {}, true);
}
async function api(path, body) {
  const session = epoch;
  const accessToken = token;
  let response;
  try {
    response = await fetch(`/api/admin/${path}`, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { Authorization: `Bearer ${accessToken}`, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
      body: body === undefined ? undefined : JSON.stringify(body),
      credentials: 'omit', cache: 'no-store', redirect: 'error',
      signal: AbortSignal.timeout(45_000),
    });
  } catch {
    throw Object.assign(new Error('network'), { code: session === epoch ? 'network' : 'stale_session' });
  }
  if (session !== epoch) throw Object.assign(new Error('stale_session'), { code: 'stale_session' });
  const data = await response.json().catch(() => null);
  if (session !== epoch) throw Object.assign(new Error('stale_session'), { code: 'stale_session' });
  if (!response.ok) {
    const code = typeof data?.error === 'string' ? data.error : 'request_failed';
    if (response.status === 401) { logout(); throw Object.assign(new Error('unauthorized'), { code: 'unauthorized' }); }
    throw Object.assign(new Error(code), { code });
  }
  if (data === null) throw Object.assign(new Error('request_failed'), { code: 'request_failed' });
  return data;
}
async function action(button, target, operation) {
  if (button.disabled) return;
  const scope = button.closest('[data-panel]') || button.closest('form');
  const locked = Array.from(scope?.querySelectorAll('input, select, button') || [button]).map(control => [control, control.disabled]);
  const wasInert = scope?.inert || false;
  if (scope) scope.inert = true;
  locked.forEach(([control]) => { control.disabled = true; });
  button.setAttribute('aria-busy', 'true');
  clearMessage(target);
  try { await operation(); } catch (error) { showError(target, error); }
  finally {
    locked.forEach(([control, wasDisabled]) => { control.disabled = wasDisabled; });
    if (scope) scope.inert = wasInert;
    if (scope?.id === 'notifications') $('#channel-kind').disabled = !!currentChannel()?.id;
    button.removeAttribute('aria-busy');
  }
}
function logout() {
  token = '';
  epoch++;
  config = null;
  revision = '';
  overview = null;
  channelDrafts = [];
  hours = [];
  selectedChannel = null;
  dirty.clear();
  overviewRequest++;
  loadingOverview = false;
  $$('input').forEach(input => { if (input.type === 'checkbox') input.checked = false; else input.value = ''; });
  $('#channel-list').replaceChildren();
  $('#reminder-times').replaceChildren();
  $('#communities').replaceChildren();
  $('#matches').replaceChildren();
  $('#mcp-token').type = 'password';
  $$('[data-message]').forEach(clearMessage);
  $('#authenticated').hidden = true;
  $('#navigation').hidden = true;
  $('#logout').hidden = true;
  $('#login-panel').hidden = false;
  $('#conflict-banner').hidden = true;
  document.title = `Kicktipp Agent: ${t('signIn')}`;
  $('#admin-token').focus();
}
function applyEnvelope(envelope, hydrate = []) {
  revision = envelope.revision;
  config = envelope.config;
  $('#setup-banner').hidden = !!envelope.configured;
  $('#conflict-banner').hidden = true;
  if (envelope.status) overview = { ...overview, status: envelope.status };
  if (hydrate.includes('account')) {
    $('#email').value = config?.account.email || '';
    $('#password').value = '';
    $('#site').value = config?.account.site || 'de';
    $('#community').value = config?.account.community || '';
    $('#player').value = config?.account.player || '';
    $('#communities').replaceChildren();
    dirty.delete('account');
  }
  if (hydrate.includes('notifications')) {
    channelDrafts = (config?.notifications.channels || []).map(channel => ({ ...channel, _key: ++channelSequence }));
    selectedChannel = channelDrafts[0]?._key ?? null;
    hours = [...(config?.notifications.warnHours || [])];
    $('#custom-hours').value = '';
    $('#interval').value = config?.notifications.everyMinutes ?? 15;
    $('#zone').value = config?.timeZone || 'Europe/Berlin';
    dirty.delete('notifications');
    renderChannelList();
    selectChannel(selectedChannel);
    renderHours();
  }
  if (hydrate.includes('agent')) {
    $('#permission').checked = config ? !config.readOnly : false;
    $('#mcp-token').value = '';
    $('#mcp-token').type = 'password';
    dirty.delete('agent');
  }
  $('#password-help').textContent = t(config?.account.hasPassword ? 'savedSecret' : 'requiredPassword');
  $$('[data-page=overview], [data-page=notifications], [data-page=agent]').forEach(button => button.disabled = !config);
  $('#mcp-url').textContent = `${location.origin}/mcp`;
  renderPermission();
  renderOverview();
}
async function saveConfig(patch, panel, target) {
  const previousIdentity = JSON.stringify(config ? [config.account.email.toLowerCase(), config.account.site, config.account.community] : null);
  const otherEdits = dirty.has('notifications') || dirty.has('agent');
  const envelope = await api('config', { revision, ...patch });
  // A response requested before this save belongs to the previous config.
  overviewRequest++;
  loadingOverview = false;
  overview = null;
  const nextIdentity = JSON.stringify(envelope.config ? [envelope.config.account.email.toLowerCase(), envelope.config.account.site, envelope.config.account.community] : null);
  const identityChanged = panel === 'account' && previousIdentity !== nextIdentity;
  applyEnvelope(envelope, identityChanged ? ['account', 'notifications', 'agent'] : [panel]);
  message(target, identityChanged && otherEdits ? 'accountChanged' : 'saved');
  renderAccountNotice();
  if (panel === 'account') {
    // The account may have changed; never leave an old account's token/report visible.
    $('#mcp-token').value = '';
    $('#mcp-token').type = 'password';
  }
}
function navigate(page, refresh = true) {
  if (!['overview', 'notifications', 'account', 'agent'].includes(page)) page = 'overview';
  if (!config) page = 'account';
  currentPage = page;
  $$('[data-panel]').forEach(panel => panel.hidden = panel.id !== page);
  $$('#navigation [data-page]').forEach(button => {
    if (button.dataset.page === page) button.setAttribute('aria-current', 'page');
    else button.removeAttribute('aria-current');
  });
  document.title = `Kicktipp Agent: ${t(page)}`;
  try { history.replaceState(null, '', `#${page}`); } catch {}
  if (page === 'overview' && refresh) void loadOverview();
}
async function loadOverview() {
  const request = ++overviewRequest;
  loadingOverview = true;
  renderOverview();
  try {
    const data = await api('overview');
    if (request !== overviewRequest) return;
    overview = data;
  } catch (error) {
    if (request !== overviewRequest || error.code === 'stale_session') return;
    if (token) { overview = { ...overview, error: error.code }; showError($('#check-feedback'), error); }
  } finally {
    if (request === overviewRequest) { loadingOverview = false; renderOverview(); }
  }
}
function dateText(value, options = {}) {
  if (!value || !Number.isFinite(Date.parse(value))) return t('unknown');
  try { return new Intl.DateTimeFormat(language, { timeZone: config?.timeZone || 'Europe/Berlin', hourCycle: 'h23', ...options }).format(new Date(value)); }
  catch { return t('unknown'); }
}
function renderOverview() {
  const status = overview?.status;
  const scheduler = status?.scheduler;
  const read = status?.read;
  const report = overview?.report;
  const readError = overview?.error || read?.lastError;
  const deliveryError = ['delivery_failed', 'state_failed'].includes(scheduler?.lastError) ? scheduler.lastError : null;
  const error = readError || deliveryError;
  $('#version').textContent = status?.version ? `Kicktipp Agent ${status.version}` : 'Kicktipp Agent';
  $('#overview-community').textContent = config?.account.community || '';
  $('#last-check').textContent = dateText(read?.lastCheck, { dateStyle: 'short', timeStyle: 'short' });
  $('#next-check').textContent = scheduler?.nextCheck ? dateText(scheduler.nextCheck, { dateStyle: 'short', timeStyle: 'short' }) : t('notScheduled');
  $('#last-success').textContent = dateText(read?.lastSuccess, { dateStyle: 'short', timeStyle: 'short' });
  $('#login-status').textContent = t(readError === 'auth_required' || readError === 'login_failed' ? 'loginNeeded' : readError ? 'unknown' : read?.lastSuccess ? 'confirmed' : 'notChecked');
  $('#login-status').classList.toggle('check', !!read?.lastSuccess && !readError);
  $('#delivery-status').textContent = !config?.notifications.channels.length ? t('disabled') : !scheduler?.lastCheck ? t('notChecked') : scheduler.failedChannels?.length ? t('failedChannels', { count: scheduler.failedChannels.length }) : t('noErrors');
  $('#interval-caption').textContent = config ? t('intervalDynamic', { minutes: config.notifications.everyMinutes }) : '';
  $('#read-mode').textContent = t(config?.readOnly !== false ? 'readOnlyTitle' : 'writeTitle');
  $('#read-mode-help').textContent = t(config?.readOnly !== false ? 'readOnlyBody' : 'writeBody');
  const warning = $('#overview-warning');
  warning.hidden = !error;
  warning.textContent = error ? t(messages[`error_${error}`] ? `error_${error}` : 'error_request_failed') : '';
  $('#matchday').hidden = !report?.matchday;
  $('#matchday').textContent = report?.matchday ? t('matchday', { value: report.matchday }) : '';
  $('#report-time').textContent = report?.now ? t('asOf', { time: dateText(report.now, { dateStyle: 'short', timeStyle: 'short' }) }) : '';
  $('#matches').replaceChildren();
  const state = $('#match-state');
  state.replaceChildren();
  if (!report) {
    $('#match-title').textContent = t(loadingOverview ? 'loadingTitle' : error ? 'notAvailable' : 'notChecked');
    const p = document.createElement('p');
    p.textContent = t(loadingOverview ? 'loading' : 'noReport');
    state.append(p);
    state.hidden = false;
  } else {
    const rows = Array.isArray(report.matches) ? report.matches : [];
    const count = report.needsBetCount;
    $('#match-title').textContent = t(loadingOverview ? 'loadingTitle' : readError ? 'staleTitle' : count === 0 ? 'emptyTitle' : count === 1 ? 'openTitleOne' : 'openTitle', { count });
    state.hidden = rows.length > 0;
    if (!rows.length) { const p = document.createElement('p'); p.textContent = t('noGames'); state.append(p); }
    for (const match of rows) {
      const row = document.createElement('div'); row.className = 'match';
      const time = document.createElement('div'); time.className = 'time';
      time.textContent = match.kickoff ? dateText(match.kickoff, { hour: '2-digit', minute: '2-digit' }) : t('unknownKickoff');
      if (match.kickoff) { const day = document.createElement('small'); day.textContent = dateText(match.kickoff, { weekday: 'short', day: 'numeric', month: 'short' }); time.append(day); }
      const teams = document.createElement('div'); teams.className = 'teams';
      for (const name of [match.home, match.away]) { const team = document.createElement('span'); team.textContent = name; teams.append(team); }
      const score = document.createElement('div'); score.className = 'score';
      if (match.bet) score.textContent = match.bet;
      else { const tag = document.createElement('span'); tag.className = `tag${match.needsBet ? ' open' : ''}`; tag.textContent = t(match.closed ? 'closed' : 'missing'); score.append(tag); }
      row.append(time, teams, score); $('#matches').append(row);
    }
  }
  $('#summary-channels').replaceChildren();
  for (const kind of ['discord', 'telegram', 'webhook']) {
    const channels = config?.notifications.channels.filter(channel => channel.kind === kind) || [];
    const container = document.createElement('div'), name = document.createElement('strong'), detail = document.createElement('small');
    name.textContent = kind === 'discord' ? 'Discord' : kind === 'telegram' ? 'Telegram' : 'Webhook';
    detail.textContent = channels.length ? `${t('configured')} (${channels.length})` : t('notConfigured');
    container.append(name, detail); $('#summary-channels').append(container);
  }
  $('#saved-times').replaceChildren();
  for (const value of config?.notifications.warnHours || []) { const span = document.createElement('span'); span.textContent = hoursText(value); $('#saved-times').append(span); }
  if (!config?.notifications.warnHours.length) { const span = document.createElement('span'); span.textContent = t('noSavedTimes'); $('#saved-times').append(span); }
}

function channelName(channel) {
  const kind = channel.kind === 'telegram' ? 'Telegram' : channel.kind === 'discord' ? 'Discord' : 'Webhook';
  return channel.id ? `${kind} / ${channel.id}` : `${kind} / ${t('newChannel')}`;
}
function currentChannel() { return channelDrafts.find(channel => channel._key === selectedChannel); }
function renderChannelList() {
  $('#channel-list').replaceChildren();
  $('#no-channels').hidden = channelDrafts.length > 0;
  for (const channel of channelDrafts) {
    const row = document.createElement('li'), pick = document.createElement('button'), remove = document.createElement('button');
    pick.type = 'button'; pick.className = 'channel-pick'; pick.textContent = channelName(channel);
    pick.setAttribute('aria-pressed', String(channel._key === selectedChannel));
    pick.addEventListener('click', () => selectChannel(channel._key));
    remove.type = 'button'; remove.className = 'remove quiet'; remove.textContent = '×';
    remove.setAttribute('aria-label', t('removeChannel', { name: channelName(channel) }));
    remove.addEventListener('click', () => {
      channelDrafts = channelDrafts.filter(item => item._key !== channel._key);
      if (selectedChannel === channel._key) selectedChannel = channelDrafts[0]?._key ?? null;
      selectChannel(selectedChannel); renderChannelList(); markDirty('notifications');
      message($('#notification-feedback'), 'unsaved');
    });
    row.append(pick, remove); $('#channel-list').append(row);
  }
}
function renderChannelLabels() {
  const channel = currentChannel();
  if (!channel) return;
  $('#channel-secret-label').textContent = t(channel.kind === 'telegram' ? 'botToken' : 'webhookUrl');
  $('#secret-help').textContent = t(channel.hasSecret ? 'savedSecret' : 'enterSecret');
  $('#channel-secret').placeholder = channel.hasSecret ? t('savedSecret') : channel.kind === 'telegram' ? '' : 'https://…';
  $('#chat-field').hidden = channel.kind !== 'telegram';
  $('#provider-help').textContent = t(channel.kind === 'telegram' ? 'telegramHelp' : channel.kind === 'discord' ? 'discordHelp' : 'webhookHelp');
}
function selectChannel(key) {
  selectedChannel = key;
  const channel = currentChannel();
  $('#channel-editor').hidden = !channel;
  clearMessage($('#channel-feedback')); clearInvalid($('#channel-editor'));
  if (channel) {
    $('#channel-kind').value = channel.kind;
    $('#channel-kind').disabled = !!channel.id;
    $('#channel-secret').value = channel.kind === 'telegram' ? channel.botToken || '' : channel.url || '';
    $('#chat-id').value = channel.chatId || '';
    renderChannelLabels();
  } else { $('#channel-secret').value = ''; $('#chat-id').value = ''; }
  renderChannelList();
}
function channelPayload(channel) {
  const payload = { kind: channel.kind };
  if (channel.id) payload.id = channel.id;
  if (channel.kind === 'telegram') {
    if (channel.botToken?.trim()) payload.botToken = channel.botToken.trim();
    payload.chatId = channel.chatId?.trim() || '';
  } else if (channel.url?.trim()) payload.url = channel.url.trim();
  return payload;
}
function validateChannelDraft(channel) {
  if (!channel) return 'atLeastOneChannel';
  if (channel.kind === 'telegram') {
    if ((!channel.hasSecret && !channel.botToken?.trim()) || !channel.chatId?.trim()) return 'telegramRequired';
  } else {
    if (channel.hasSecret && !channel.url?.trim()) return null;
    try { if (!['http:', 'https:'].includes(new URL(channel.url).protocol)) return 'invalidUrl'; }
    catch { return 'invalidUrl'; }
  }
  return null;
}
function renderHours() {
  $('#reminder-times').replaceChildren();
  $('#times-empty').hidden = hours.length > 0;
  for (const value of hours) {
    const li = document.createElement('li'), label = document.createElement('span'), remove = document.createElement('button');
    label.textContent = hoursText(value); remove.type = 'button'; remove.textContent = '×';
    remove.setAttribute('aria-label', t('removeTime', { time: hoursText(value) }));
    remove.addEventListener('click', () => {
      const index = hours.indexOf(value);
      hours = hours.filter(item => item !== value); renderHours(); markDirty('notifications');
      message($('#hours-feedback'), 'timeRemoved', { hours: value });
      const next = $$('#reminder-times button')[Math.min(index, hours.length - 1)]; (next || $('#custom-hours')).focus();
    });
    li.append(label, remove); $('#reminder-times').append(li);
  }
}
function addTime() {
  const input = $('#custom-hours'), raw = input.value.trim(), value = Number(raw.replace(',', '.'));
  let error;
  if (!/^(?:\d+(?:[.,]\d+)?|[.,]\d+)$/.test(raw) || !Number.isFinite(value) || value <= 0 || value > 168) error = 'invalidHours';
  else if (hours.includes(value)) error = 'duplicateTime';
  else if (hours.length >= 10) error = 'maxTimes';
  if (error) return fieldError(input, $('#hours-feedback'), error);
  hours.push(value); hours.sort((a, b) => b - a);
  input.value = ''; input.removeAttribute('aria-invalid'); renderHours(); markDirty('notifications');
  message($('#hours-feedback'), 'timeAdded', { hours: value }); input.focus(); return true;
}
function accountPayload(requirePool) {
  clearInvalid($('#account-form'));
  const result = $('#account-feedback'), email = $('#email'), password = $('#password'), community = $('#community');
  const sameIdentity = config?.account.email.trim().toLowerCase() === email.value.trim().toLowerCase() && config?.account.site === $('#site').value;
  if (!email.value.trim() || email.validity.typeMismatch) { fieldError(email, result, 'invalidEmail'); return null; }
  if ((!config?.account.hasPassword || !sameIdentity) && !password.value) { fieldError(password, result, sameIdentity ? 'requiredPassword' : 'newIdentityPassword'); return null; }
  if (requirePool && !/^[\p{L}\p{N}_-]+$/u.test(community.value.trim())) { fieldError(community, result, 'invalidPool'); return null; }
  return {
    email: email.value.trim(), site: $('#site').value,
    ...(password.value ? { password: password.value } : {}),
    ...(requirePool ? { community: community.value.trim(), player: $('#player').value.trim() } : {}),
  };
}
function renderAccountNotice() {
  const changed = config && (config.account.email.toLowerCase() !== $('#email').value.trim().toLowerCase() || config.account.site !== $('#site').value || config.account.community !== $('#community').value.trim());
  $('#account-change-note').hidden = !(changed && (dirty.has('notifications') || dirty.has('agent')));
}
function renderPermission() {
  $('#permission-note').textContent = t($('#permission').checked ? 'permissionOn' : 'permissionOff');
  $('#reveal-token').textContent = t($('#mcp-token').type === 'text' ? 'hideToken' : 'showToken');
}
function setLanguage(next) {
  language = next === 'de' ? 'de' : 'en';
  try { localStorage.setItem('kicktipp-language', language); } catch {}
  document.documentElement.lang = language;
  $$('[data-i18n]').forEach(element => element.textContent = t(element.dataset.i18n));
  $$('[data-aria]').forEach(element => element.setAttribute('aria-label', t(element.dataset.aria)));
  $$('[data-placeholder]').forEach(element => element.placeholder = t(element.dataset.placeholder));
  $$('[data-language]').forEach(button => button.setAttribute('aria-pressed', String(button.dataset.language === language)));
  $$('[data-message]').forEach(renderMessage);
  $('meta[name=description]').content = t('description');
  document.title = `Kicktipp Agent: ${t(token ? currentPage : 'signIn')}`;
  $('#password-help').textContent = t(config?.account.hasPassword ? 'savedSecret' : 'requiredPassword');
  renderOverview(); renderHours(); renderChannelList(); renderChannelLabels(); renderPermission(); renderAccountNotice();
}

$('#login-form').addEventListener('submit', event => {
  event.preventDefault();
  const input = $('#admin-token');
  if (!input.value.trim()) { fieldError(input, $('#login-feedback'), 'tokenRequired'); return; }
  void action(event.currentTarget.querySelector('[type=submit]'), $('#login-feedback'), async () => {
    epoch++; token = input.value.trim();
    const envelope = await api('config');
    input.value = ''; input.removeAttribute('aria-invalid');
    applyEnvelope(envelope, ['account', 'notifications', 'agent']);
    $('#login-panel').hidden = true; $('#authenticated').hidden = false; $('#navigation').hidden = false; $('#logout').hidden = false;
    navigate(config ? location.hash.slice(1) || 'overview' : 'account');
  });
});
$('#logout').addEventListener('click', logout);
$$('[data-language]').forEach(button => button.addEventListener('click', () => setLanguage(button.dataset.language)));
$$('[data-page]').forEach(button => button.addEventListener('click', () => navigate(button.dataset.page)));
window.addEventListener('hashchange', () => { if (token && !$('#authenticated').hidden) navigate(location.hash.slice(1)); });
window.addEventListener('beforeunload', event => { if (dirty.size) { event.preventDefault(); event.returnValue = ''; } });
$('#reload-config').addEventListener('click', event => {
  void action(event.currentTarget, $('#check-feedback'), async () => {
    const envelope = await api('config');
    overviewRequest++;
    loadingOverview = false;
    overview = null;
    applyEnvelope(envelope, ['account', 'notifications', 'agent']);
    $$('[data-message]').forEach(clearMessage);
    navigate(currentPage);
  });
});
$('#check-now').addEventListener('click', event => {
  void action(event.currentTarget, $('#check-feedback'), async () => {
    const request = ++overviewRequest;
    loadingOverview = true; renderOverview();
    try { const result = await api('check', {}); if (request === overviewRequest) { overview = result; message($('#check-feedback'), 'checkDone'); } }
    catch (error) { if (request === overviewRequest && token) overview = { ...overview, error: error.code }; throw error; }
    finally { if (request === overviewRequest) { loadingOverview = false; renderOverview(); } }
  });
});
$('#add-channel').addEventListener('click', () => {
  if (channelDrafts.length >= 20) { message($('#notification-feedback'), 'maxChannels', {}, true); return; }
  const channel = { _key: ++channelSequence, kind: 'discord', hasSecret: false };
  channelDrafts.push(channel); selectedChannel = channel._key; selectChannel(channel._key); markDirty('notifications'); $('#channel-kind').focus();
});
$('#channel-kind').addEventListener('change', event => {
  const channel = currentChannel(); if (!channel || channel.id) return;
  channel.kind = event.target.value; delete channel.url; delete channel.botToken; channel.chatId = '';
  selectChannel(channel._key); markDirty('notifications');
});
$('#channel-secret').addEventListener('input', event => {
  const channel = currentChannel(); if (!channel) return;
  channel[channel.kind === 'telegram' ? 'botToken' : 'url'] = event.target.value;
  event.target.removeAttribute('aria-invalid'); markDirty('notifications'); clearMessage($('#channel-feedback'));
});
$('#chat-id').addEventListener('input', event => { const channel = currentChannel(); if (channel) { channel.chatId = event.target.value; markDirty('notifications'); } });
$('#test-channel').addEventListener('click', event => {
  const channel = currentChannel(), invalid = validateChannelDraft(channel);
  if (invalid) { fieldError($('#channel-secret'), $('#channel-feedback'), invalid); return; }
  const payload = channelPayload(channel);
  void action(event.currentTarget, $('#channel-feedback'), async () => {
    await api('notifications/test', { channel: payload, language });
    message($('#channel-feedback'), 'testSent');
  });
});
$('#add-time').addEventListener('click', addTime);
$('#custom-hours').addEventListener('keydown', event => { if (event.key === 'Enter') { event.preventDefault(); addTime(); } });
$('#custom-hours').addEventListener('input', event => { event.target.removeAttribute('aria-invalid'); markDirty('notifications'); clearMessage($('#hours-feedback')); });
for (const id of ['interval', 'zone']) $(`#${id}`).addEventListener('input', () => markDirty('notifications'));
$('#save-notifications').addEventListener('click', event => {
  const result = $('#notification-feedback');
  clearInvalid($('#notifications'));
  if ($('#custom-hours').value.trim() && !addTime()) return;
  if (channelDrafts.length && !hours.length) { fieldError($('#custom-hours'), result, 'needTime'); return; }
  const everyMinutes = Number($('#interval').value);
  if (!Number.isFinite(everyMinutes) || everyMinutes < 1 || everyMinutes > 1440) { fieldError($('#interval'), result, 'invalidInterval'); return; }
  const timeZone = $('#zone').value.trim();
  try { new Intl.DateTimeFormat('en', { timeZone }); } catch { fieldError($('#zone'), result, 'invalidZone'); return; }
  for (const channel of channelDrafts) {
    const invalid = validateChannelDraft(channel);
    if (invalid) { selectChannel(channel._key); fieldError($('#channel-secret'), result, invalid); return; }
  }
  const notifications = { channels: channelDrafts.map(channelPayload), warnHours: [...hours], everyMinutes };
  void action(event.currentTarget, result, () => saveConfig({ notifications, timeZone }, 'notifications', result));
});
$$('#account-form input, #account-form select').forEach(input => input.addEventListener('input', () => markDirty('account')));
$('#check-account').addEventListener('click', event => {
  const account = accountPayload(false); if (!account) return;
  void action(event.currentTarget, $('#account-feedback'), async () => {
    const result = await api('account/check', { account });
    $('#communities').replaceChildren();
    for (const name of result.communities || []) { const option = document.createElement('option'); option.value = name; $('#communities').append(option); }
    if (!$('#community').value && result.communities?.length === 1) $('#community').value = result.communities[0];
    message($('#account-feedback'), result.communities?.length ? 'loginTest' : 'noPools');
  });
});
$('#account-form').addEventListener('submit', event => {
  event.preventDefault();
  const account = accountPayload(true); if (!account) return;
  void action(event.currentTarget.querySelector('[type=submit]'), $('#account-feedback'), () => saveConfig({ account }, 'account', $('#account-feedback')));
});
$('#permission').addEventListener('change', () => { renderPermission(); markDirty('agent'); });
$('#save-permission').addEventListener('click', event => {
  void action(event.currentTarget, $('#permission-feedback'), () => saveConfig({ readOnly: !$('#permission').checked }, 'agent', $('#permission-feedback')));
});
$('#reveal-token').addEventListener('click', event => {
  if ($('#mcp-token').type === 'text') { $('#mcp-token').type = 'password'; renderPermission(); return; }
  void action(event.currentTarget, $('#connection-feedback'), async () => {
    const connection = await api('connection');
    $('#mcp-url').textContent = new URL(connection.url, location.origin).href;
    $('#mcp-token').value = connection.token;
    $('#mcp-token').type = 'text'; renderPermission();
  });
});
$('#copy-address').addEventListener('click', async () => {
  try { await navigator.clipboard.writeText($('#mcp-url').textContent); message($('#copy-feedback'), 'copied'); }
  catch { message($('#copy-feedback'), 'copyUnavailable', {}, true); }
});
setLanguage(language);
