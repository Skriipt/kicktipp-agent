import { describe, it, expect } from 'vitest';
import { Page } from '../src/http/page.js';
import { CookieJar } from '../src/http/cookie-jar.js';
import { fetchMembers, resolveMember, fetchBetsForMember, placeBetsForMember, AdminRequiredError } from '../src/core.js';
import { getAdminMembersUrl, getAdminTipsUrl } from '../src/url.js';
import { mockFetch, page as htmlPage } from './helpers/mock-fetch.js';

const BASE = 'https://www.kicktipp.com';

const MEMBER_LIST = `<div id="kicktipp-content"><table><tbody>
  <tr><td>Papa</td><td><a href="/mycomm/spielleiter/tippsnachtragen?tipperId=111&tippsaisonId=99">Tipps nachtragen</a></td></tr>
  <tr><td>Oma (Dummy)</td><td><a href="/mycomm/spielleiter/tippsnachtragen?tipperId=222&tippsaisonId=99">Tipps nachtragen</a></td></tr>
</tbody></table></div>`;

const TIPS_PAGE = (bet = '') => {
  const [h, g] = bet ? bet.split(':') : ['', ''];
  return `<div id="kicktipp-content"><form method="post" action="/mycomm/spielleiter/tippsnachtragen?tipperId=111&tippsaisonId=99">
    <table><tbody><tr>
      <td>21.08.26 20:30</td><td>Bayern</td><td>BVB</td>
      <td><input id="r1_heimTipp" name="r1_heimTipp" value="${h}"><input id="r1_gastTipp" name="r1_gastTipp" value="${g}"></td>
    </tr></tbody></table>
    <button type="submit" name="submitbutton" value="save">save</button></form></div>`;
};

function adminPage(existing = '') {
  const { fetchImpl, calls } = mockFetch((req) => {
    if (req.url.startsWith(`${BASE}/mycomm/spielleiter/mitgliederliste`)) return htmlPage(MEMBER_LIST);
    if (req.url.startsWith(`${BASE}/mycomm/spielleiter/tippsnachtragen`)) {
      return req.method === 'GET' ? htmlPage(TIPS_PAGE(existing)) : htmlPage('saved');
    }
    return undefined;
  });
  return { page: new Page(new CookieJar(), fetchImpl), calls };
}

describe('admin routes', () => {
  it('builds the member and tips URLs', () => {
    expect(getAdminMembersUrl('mycomm')).toBe(`${BASE}/mycomm/spielleiter/mitgliederliste`);
    expect(getAdminTipsUrl('mycomm', '111', '99', 3)).toBe(
      `${BASE}/mycomm/spielleiter/tippsnachtragen?tipperId=111&tippsaisonId=99&spieltagIndex=3`,
    );
  });
});

describe('fetchMembers', () => {
  it('reads names and ids, and spots dummy members', async () => {
    const { page } = adminPage();
    const members = await fetchMembers(page, 'mycomm');
    expect(members).toEqual([
      { tipperId: '111', tippsaisonId: '99', name: 'Papa', dummy: false },
      { tipperId: '222', tippsaisonId: '99', name: 'Oma', dummy: true },
    ]);
  });

  it('reports a non-admin clearly rather than as an auth failure', async () => {
    const { fetchImpl } = mockFetch((req) =>
      req.url.includes('/info/profil/login')
        ? htmlPage('<form></form>')
        : { status: 302, location: '/info/profil/login?spielleiter=1' },
    );
    const page = new Page(new CookieJar(), fetchImpl);
    await expect(fetchMembers(page, 'mycomm')).rejects.toBeInstanceOf(AdminRequiredError);
  });
});

describe('resolveMember', () => {
  const members = [
    { tipperId: '111', tippsaisonId: '99', name: 'Papa', dummy: false },
    { tipperId: '222', tippsaisonId: '99', name: 'Oma', dummy: true },
    { tipperId: '333', tippsaisonId: '99', name: 'Papa', dummy: false },
  ];

  it('resolves by id', () => {
    expect(resolveMember(members, '222').name).toBe('Oma');
  });

  it('resolves an unambiguous name', () => {
    expect(resolveMember(members, 'Oma').tipperId).toBe('222');
    expect(resolveMember(members, 'oma').tipperId).toBe('222');
  });

  it('refuses an ambiguous name rather than guessing', () => {
    expect(() => resolveMember(members, 'Papa')).toThrow(/More than one member/);
  });

  it('lists the members when the name is unknown', () => {
    expect(() => resolveMember(members, 'Nobody')).toThrow(/No member "Nobody"/);
  });
});

describe('acting for a member', () => {
  const member = { tipperId: '111', tippsaisonId: '99', name: 'Oma', dummy: true };

  it('reads their bets', async () => {
    const { page } = adminPage('2:1');
    const result = await fetchBetsForMember(page, 'mycomm', member, 3);
    expect(result.member).toBe(member);
    expect(result.matches[0]).toMatchObject({ home: 'Bayern', away: 'BVB', bet: '2:1' });
  });

  it('submits through the member-specific page', async () => {
    const { page, calls } = adminPage();
    const placed = await placeBetsForMember(page, 'mycomm', member, ['Bayern vs BVB=3:0'], 3, true, 'cli:admin');

    expect(placed).toEqual([{ home: 'Bayern', away: 'BVB', homeGoals: 3, awayGoals: 0 }]);
    const post = calls.find((c) => c.method === 'POST');
    expect(post?.url).toContain('tipperId=111');
    expect(post?.body).toContain('r1_heimTipp=3');
  });

  it('submits nothing on a dry run', async () => {
    const { page, calls } = adminPage();
    await placeBetsForMember(page, 'mycomm', member, ['Bayern vs BVB=3:0'], 3, false, 'cli:admin');
    expect(calls.some((c) => c.method === 'POST')).toBe(false);
  });

  it('refuses to submit when the form would not carry the member id', async () => {
    // A form whose action has lost the tipperId would post to the admin's own
    // entry, which is the one mistake worth being paranoid about.
    const { fetchImpl } = mockFetch((req) =>
      req.url.startsWith(`${BASE}/mycomm/spielleiter/tippsnachtragen`)
        ? req.method === 'GET'
          ? htmlPage(
              '<div id="kicktipp-content"><form method="post" action="/mycomm/spielleiter/tippsnachtragen">' +
                '<table><tbody><tr><td>21.08.26</td><td>Bayern</td><td>BVB</td>' +
                '<td><input id="r1_heimTipp" name="r1_heimTipp" value=""><input id="r1_gastTipp" name="r1_gastTipp" value=""></td>' +
                '</tr></tbody></table>' +
                '<button type="submit" name="submitbutton" value="save">save</button></form></div>',
            )
          : htmlPage('saved')
        : htmlPage(MEMBER_LIST),
    );
    const page = new Page(new CookieJar(), fetchImpl);
    await expect(
      placeBetsForMember(page, 'mycomm', member, ['Bayern vs BVB=3:0'], 3, true, 'cli:admin'),
    ).rejects.toThrow(/does not carry their tipperId/);
  });

  it('rejects a fixture that is not on the page', async () => {
    const { page } = adminPage();
    await expect(
      placeBetsForMember(page, 'mycomm', member, ['Nobody vs Nowhere=1:0'], 3, true, 'cli:admin'),
    ).rejects.toThrow();
  });
});
