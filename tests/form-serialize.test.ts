import { describe, it, expect } from 'vitest';
import { Page } from '../src/http/page.js';
import { CookieJar } from '../src/http/cookie-jar.js';
import { mockFetch, page as htmlPage, type RecordedRequest } from './helpers/mock-fetch.js';

const BASE = 'https://www.kicktipp.com';
const FORM_URL = `${BASE}/c/form`;

/** Load `form` into a page, submit it, and hand back the resulting request. */
async function submit(
  form: string,
  submitSelector = 'button[name="submitbutton"]',
): Promise<RecordedRequest> {
  const { fetchImpl, calls } = mockFetch((req) =>
    req.method === 'GET' && req.url === FORM_URL ? htmlPage(form) : htmlPage('done'),
  );
  const page = new Page(new CookieJar(), fetchImpl);
  await page.goto(FORM_URL);
  await page.click(submitSelector);
  return calls[calls.length - 1];
}

function fields(req: RecordedRequest): URLSearchParams {
  return new URLSearchParams(req.body || '');
}

const SUBMIT = '<button type="submit" name="submitbutton" value="save">Save</button>';

describe('form serialization', () => {
  it('sends text and hidden inputs', async () => {
    const req = await submit(`
      <form method="post" action="/c/form">
        <input type="text" name="user" value="alice">
        <input type="hidden" name="token" value="t0k3n">
        ${SUBMIT}
      </form>`);

    expect(fields(req).get('user')).toBe('alice');
    expect(fields(req).get('token')).toBe('t0k3n');
    expect(req.headers.get('content-type')).toBe('application/x-www-form-urlencoded');
  });

  it('omits unchecked boxes and keeps checked ones', async () => {
    const req = await submit(`
      <form method="post" action="/c/form">
        <input type="checkbox" name="agree" value="yes" checked>
        <input type="checkbox" name="spam" value="yes">
        ${SUBMIT}
      </form>`);

    expect(fields(req).get('agree')).toBe('yes');
    expect(fields(req).has('spam')).toBe(false);
  });

  it('sends only the selected radio', async () => {
    const req = await submit(`
      <form method="post" action="/c/form">
        <input type="radio" name="mode" value="a">
        <input type="radio" name="mode" value="b" checked>
        ${SUBMIT}
      </form>`);

    expect(fields(req).getAll('mode')).toEqual(['b']);
  });

  it('sends only the button that submitted the form', async () => {
    const req = await submit(`
      <form method="post" action="/c/form">
        <button type="submit" name="delete" value="1">Delete</button>
        ${SUBMIT}
      </form>`);

    expect(fields(req).get('submitbutton')).toBe('save');
    expect(fields(req).has('delete')).toBe(false);
  });

  it('falls back to the first option of a select with nothing selected', async () => {
    const req = await submit(`
      <form method="post" action="/c/form">
        <select name="team"><option value="1">One</option><option value="2">Two</option></select>
        ${SUBMIT}
      </form>`);

    expect(fields(req).get('team')).toBe('1');
  });

  it('respects an explicitly selected option', async () => {
    const req = await submit(`
      <form method="post" action="/c/form">
        <select name="team">
          <option value="1">One</option>
          <option value="2" selected>Two</option>
        </select>
        ${SUBMIT}
      </form>`);

    expect(fields(req).get('team')).toBe('2');
  });

  it('sends every selected option of a multiple select', async () => {
    const req = await submit(`
      <form method="post" action="/c/form">
        <select name="teams" multiple>
          <option value="1" selected>One</option>
          <option value="2">Two</option>
          <option value="3" selected>Three</option>
        </select>
        ${SUBMIT}
      </form>`);

    expect(fields(req).getAll('teams')).toEqual(['1', '3']);
  });

  it('sends textarea content', async () => {
    const req = await submit(`
      <form method="post" action="/c/form">
        <textarea name="note">hello there</textarea>
        ${SUBMIT}
      </form>`);

    expect(fields(req).get('note')).toBe('hello there');
  });

  it('skips disabled and unnamed fields, and file/reset inputs', async () => {
    const req = await submit(`
      <form method="post" action="/c/form">
        <input type="text" name="off" value="x" disabled>
        <input type="text" value="anonymous">
        <input type="file" name="upload">
        <input type="reset" name="reset" value="Reset">
        <input type="text" name="on" value="y">
        ${SUBMIT}
      </form>`);

    const body = fields(req);
    expect(body.has('off')).toBe(false);
    expect(body.has('upload')).toBe(false);
    expect(body.has('reset')).toBe(false);
    expect(body.get('on')).toBe('y');
  });

  it('puts a GET form into the query string', async () => {
    const req = await submit(`
      <form method="get" action="/c/search">
        <input type="text" name="q" value="bayern">
        ${SUBMIT}
      </form>`);

    expect(req.method).toBe('GET');
    expect(req.url).toBe(`${BASE}/c/search?q=bayern&submitbutton=save`);
    expect(req.body).toBeNull();
  });

  it('defaults to GET when the form has no method', async () => {
    const req = await submit(`
      <form action="/c/search"><input name="q" value="x">${SUBMIT}</form>`);

    expect(req.method).toBe('GET');
  });

  it('submits back to the current URL when the form has no action', async () => {
    const req = await submit(`
      <form method="post"><input name="q" value="x">${SUBMIT}</form>`);

    expect(req.url).toBe(FORM_URL);
  });

  it('encodes special characters', async () => {
    const req = await submit(`
      <form method="post" action="/c/form">
        <input name="team" value="Bayern &amp; Co">
        ${SUBMIT}
      </form>`);

    expect(req.body).toContain('team=Bayern+%26+Co');
    expect(fields(req).get('team')).toBe('Bayern & Co');
  });
});

describe('editing before submit', () => {
  it('submits values written with fill()', async () => {
    const { fetchImpl, calls } = mockFetch((req) =>
      req.method === 'GET'
        ? htmlPage(`<form method="post" action="/c/form">
            <input name="heimTipp" value="">
            <input name="gastTipp" value="">
            ${SUBMIT}
          </form>`)
        : htmlPage('saved'),
    );
    const page = new Page(new CookieJar(), fetchImpl);
    await page.goto(FORM_URL);

    const heim = await page.$('input[name="heimTipp"]');
    const gast = await page.$('input[name="gastTipp"]');
    await heim!.fill('2');
    await gast!.fill('1');
    await page.click('button[name="submitbutton"]');

    const body = fields(calls[calls.length - 1]);
    expect(body.get('heimTipp')).toBe('2');
    expect(body.get('gastTipp')).toBe('1');
  });

  it('submits the option chosen with selectOption()', async () => {
    const { fetchImpl, calls } = mockFetch((req) =>
      req.method === 'GET'
        ? htmlPage(`<form method="post" action="/c/form">
            <select name="q1">
              <option value="-1">-</option>
              <option value="7">Bayern</option>
            </select>
            ${SUBMIT}
          </form>`)
        : htmlPage('saved'),
    );
    const page = new Page(new CookieJar(), fetchImpl);
    await page.goto(FORM_URL);
    await page.selectOption('select[name="q1"]', '7');
    await page.click('button[name="submitbutton"]');

    expect(fields(calls[calls.length - 1]).get('q1')).toBe('7');
  });

  it('reports a missing element instead of submitting', async () => {
    const { fetchImpl } = mockFetch(() => htmlPage('<form method="post"></form>'));
    const page = new Page(new CookieJar(), fetchImpl);
    await page.goto(FORM_URL);

    expect(await page.$('input[name="nope"]')).toBeNull();
    await expect(page.click('button[name="nope"]')).rejects.toThrow(/not found/);
    await expect(page.selectOption('select[name="nope"]', '1')).rejects.toThrow(/not found/);
  });

  it('rejects an option value the select does not offer', async () => {
    const { fetchImpl } = mockFetch(() =>
      htmlPage('<form method="post"><select name="q1"><option value="1">One</option></select></form>'),
    );
    const page = new Page(new CookieJar(), fetchImpl);
    await page.goto(FORM_URL);

    await expect(page.selectOption('select[name="q1"]', '9')).rejects.toThrow(/not found/);
  });

  it('submitForm() finds the form of an anchor element', async () => {
    const { fetchImpl, calls } = mockFetch((req) =>
      req.method === 'GET'
        ? htmlPage(`<form method="post" action="/c/login">
            <input name="kennung" value="">
            <input name="passwort" value="">
            <button type="submit" name="submitbutton" value="Anmelden">Login</button>
          </form>`)
        : htmlPage('welcome'),
    );
    const page = new Page(new CookieJar(), fetchImpl);
    await page.goto(FORM_URL);
    page.setInputValue('input[name="kennung"]', 'me@example.com');
    page.setInputValue('input[name="passwort"]', 'secret');
    await page.submitForm('input[name="kennung"]');

    const body = fields(calls[calls.length - 1]);
    expect(body.get('kennung')).toBe('me@example.com');
    expect(body.get('passwort')).toBe('secret');
    expect(body.get('submitbutton')).toBe('Anmelden');
  });
});
