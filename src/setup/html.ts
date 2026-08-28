import { currentLanguage, t } from '../i18n/index.js';
import { siteLabel, urlBase } from '../url.js';

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function page(title: string, body: string): string {
  return `<!DOCTYPE html>
<html lang="${currentLanguage()}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>
  :root { color-scheme: light dark; }
  body { font: 16px/1.45 system-ui, sans-serif; max-width: 28rem; margin: 2.5rem auto; padding: 0 1.25rem; }
  h1 { font-size: 1.25rem; font-weight: 650; }
  label, .check { display: block; margin: 0.85rem 0 0.35rem; }
  input[type=email], input[type=password] { width: 100%; box-sizing: border-box; padding: 0.45rem 0.55rem; font: inherit; }
  .check { display: flex; gap: 0.5rem; align-items: flex-start; margin: 0.9rem 0; }
  .check input { margin-top: 0.25rem; }
  .hint { color: CanvasText; opacity: 0.7; font-size: 0.9rem; margin: 0.35rem 0 0; }
  .error { color: #b00020; margin: 0.75rem 0; }
  button { font: inherit; margin-top: 1.1rem; padding: 0.45rem 0.9rem; cursor: pointer; }
  fieldset { border: 1px solid color-mix(in srgb, CanvasText 20%, Canvas); border-radius: 0.4rem; padding: 0.6rem 0.9rem; }
  legend { padding: 0 0.3rem; }
</style>
</head>
<body>
${body}
</body>
</html>`;
}

export function loginPage(token: string, error?: string): string {
  const err = error ? `<p class="error">${escapeHtml(error)}</p>` : '';
  return page(
    t('setup.loginTitle'),
    `<h1>${escapeHtml(t('setup.loginTitle'))}</h1>
<p>${escapeHtml(t('setup.loginLead'))}</p>
${err}
<form method="post" action="/setup?token=${escapeHtml(token)}">
  <input type="hidden" name="token" value="${escapeHtml(token)}">
  <input type="hidden" name="step" value="login">
  <label for="email">${escapeHtml(t('setup.email'))}</label>
  <input id="email" name="email" type="email" autocomplete="username" required>
  <label for="password">${escapeHtml(t('setup.password'))}</label>
  <input id="password" name="password" type="password" autocomplete="current-password" required>
  <fieldset>
    <legend>${escapeHtml(t('setup.siteLegend'))}</legend>
    <label class="check"><input type="radio" name="site" value="com"${siteLabel(urlBase()) === 'de' ? '' : ' checked'}> ${escapeHtml(t('setup.siteCom'))}</label>
    <label class="check"><input type="radio" name="site" value="de"${siteLabel(urlBase()) === 'de' ? ' checked' : ''}> ${escapeHtml(t('setup.siteDe'))}</label>
  </fieldset>
  <fieldset>
    <legend>${escapeHtml(t('setup.langLegend'))}</legend>
    <label class="check"><input type="radio" name="language" value="en"${currentLanguage() === 'de' ? '' : ' checked'}> ${escapeHtml(t('setup.langEn'))}</label>
    <label class="check"><input type="radio" name="language" value="de"${currentLanguage() === 'de' ? ' checked' : ''}> ${escapeHtml(t('setup.langDe'))}</label>
  </fieldset>
  <label class="check"><input type="checkbox" name="store" value="session"> ${escapeHtml(t('setup.storeSession'))}</label>
  <label class="check"><input type="checkbox" name="read_only" value="1"> ${escapeHtml(t('setup.readOnly'))}</label>
  <button type="submit">${escapeHtml(t('setup.signIn'))}</button>
</form>`,
  );
}

export function communityPage(token: string, communities: string[], error?: string): string {
  const err = error ? `<p class="error">${escapeHtml(error)}</p>` : '';
  const options = communities
    .map(
      (name, i) =>
        `<label class="check"><input type="radio" name="community" value="${escapeHtml(name)}"${i === 0 ? ' required' : ''}> ${escapeHtml(name)}</label>`,
    )
    .join('\n');
  return page(
    t('setup.communityTitle'),
    `<h1>${escapeHtml(t('setup.communityTitle'))}</h1>
<p>${escapeHtml(t('setup.communityLead'))}</p>
${err}
<form method="post" action="/setup?token=${escapeHtml(token)}">
  <input type="hidden" name="token" value="${escapeHtml(token)}">
  <input type="hidden" name="step" value="community">
  <fieldset>
    <legend>${escapeHtml(t('setup.communityLegend'))}</legend>
    ${options}
  </fieldset>
  <button type="submit">${escapeHtml(t('setup.save'))}</button>
</form>`,
  );
}

export function donePage(): string {
  return page(
    t('setup.doneTitle'),
    `<h1>${escapeHtml(t('setup.doneTitle'))}</h1>
<p>${escapeHtml(t('setup.doneLead'))}</p>`,
  );
}

export function forbiddenPage(): string {
  return page(
    t('setup.closedTitle'),
    `<h1>${escapeHtml(t('setup.closedTitle'))}</h1><p>${escapeHtml(t('setup.closedLead'))}</p>`,
  );
}
