let fixtureConfig = null, fixtureRevision = '0', fixtureConflict = false, fixtureDelay = null, fixtureError = null, fixtureOverviewDelay = null, fixtureReadStatus = null, fixtureAccountDelay = null, fixtureReports = null;
let fixtureProfiles = [], fixtureProfileSequence = 0;
const fixtureRequests = [];
const fixtureStatus = () => ({ version: '1.3.0', startedAt: '2026-10-28T12:00:00Z', community: fixtureConfig?.account.community,
  readOnly: fixtureConfig?.readOnly ?? true,
  read: fixtureReadStatus || { lastCheck: '2026-10-28T14:00:00Z', lastSuccess: '2026-10-28T14:00:00Z', lastError: ['auth_required', 'check_failed'].includes(fixtureError) ? fixtureError : null },
  scheduler: { running: true, lastCheck: '2026-10-28T14:00:00Z', lastSuccess: '2026-10-28T14:00:00Z', nextCheck: '2026-10-28T14:15:00Z', lastError: fixtureError, failedChannels: [], deliveredCount: 0 } });
const fixtureEnvelope = () => ({ revision: fixtureRevision, configured: fixtureProfiles.length > 0,
  profiles: fixtureProfiles.map(profile => ({ id: profile.id, name: profile.name, community: profile.account.community, readOnly: profile.readOnly })),
  profile: fixtureConfig?.id || null, config: structuredClone(fixtureConfig), status: fixtureStatus() });
const fixtureReport = () => ({ community: fixtureConfig.account.community, matchday: 9, now: '2026-10-28T14:00:00Z', timeZone: fixtureConfig.timeZone,
  matches: [{ home: 'Freiburg', away: 'Dortmund', kickoff: '2026-10-30T19:30:00Z', bet: null, needsBet: true, closed: false },
    { home: 'Frankfurt', away: 'Stuttgart', kickoff: '2026-10-31T14:30:00Z', bet: '2:1', needsBet: false, closed: false }], needsBetCount: 1 });
window.fetch = async (address, options) => {
  const url = new URL(address, location.href), path = url.pathname;
  const body = options.body ? JSON.parse(options.body) : null;
  fixtureRequests.push({ path, address, options, body, profile: body?.profile || url.searchParams.get('profile') });
  if (path === '/api/admin/config' && body && fixtureDelay) await fixtureDelay;
  const error = (code, status = 400) => ({ ok: false, status, json: async () => ({ error: code }) });
  if (options.headers.Authorization !== 'Bearer fixture-admin-token') return error('unauthorized', 401);
  const profile = body?.profile || url.searchParams.get('profile');
  fixtureConfig = profile ? fixtureProfiles.find(item => item.id === profile) : fixtureProfiles[0] || null;
  if (profile && !fixtureConfig) return error('profile_not_found', 404);
  let data;
  if (path === '/api/admin/config' && !body) data = fixtureEnvelope();
  else if (['/api/admin/config', '/api/admin/profiles', '/api/admin/profiles/remove'].includes(path)) {
    if (fixtureConflict || body.revision !== fixtureRevision) { fixtureConflict = false; return error('config_conflict', 409); }
    if (path === '/api/admin/profiles/remove') {
      fixtureProfiles = fixtureProfiles.filter(item => item.id !== body.profile);
      fixtureConfig = fixtureProfiles[0] || null;
    } else {
      if (body.name && fixtureProfiles.some(item => item.name.toLowerCase() === body.name.toLowerCase() && (path === '/api/admin/profiles' || item.id !== fixtureConfig?.id))) return error('duplicate_profile_name');
      if (path === '/api/admin/profiles') {
        fixtureConfig = { id: `profile-${++fixtureProfileSequence}`, name: body.name,
          account: { email: '', community: '', site: 'de', hasPassword: false },
          notifications: { channels: [], warnHours: [], everyMinutes: 15 }, readOnly: true, timeZone: 'Europe/Berlin' };
        fixtureProfiles.push(fixtureConfig);
      }
      if (!fixtureConfig) return error('profile_required');
      if (body.name) fixtureConfig.name = body.name;
      if (body.account) { fixtureConfig.account = { ...fixtureConfig.account, ...body.account, hasPassword: true }; delete fixtureConfig.account.password; }
      if (body.notifications) fixtureConfig.notifications = { ...body.notifications, channels: body.notifications.channels.map((channel, index) => ({
        id: channel.id || `channel-${index}`, kind: channel.kind, hasSecret: true, ...(channel.kind === 'telegram' ? { chatId: channel.chatId } : {}),
      })) };
      if ('timeZone' in body) fixtureConfig.timeZone = body.timeZone;
      if ('readOnly' in body) fixtureConfig.readOnly = body.readOnly;
    }
    fixtureRevision = String(Number(fixtureRevision) + 1); data = fixtureEnvelope();
  } else if (path === '/api/admin/account/check') {
    data = { communities: body.account.email === 'family@example.com' ? ['family-pool', 'family-league'] : ['friends', 'league', 'new-pool'] };
    if (fixtureAccountDelay) await fixtureAccountDelay;
  }
  else if (path === '/api/admin/notifications/test') data = { ok: true };
  else if (path === '/api/admin/overview' || path === '/api/admin/check') data = { status: fixtureStatus(), report: fixtureReport(), ...(fixtureReports ? { reports: fixtureReports } : {}) };
  else if (path === '/api/admin/connection') data = { url: '/mcp', token: 'fixture-mcp-token', readOnly: fixtureConfig.readOnly };
  else throw Error(`unexpected fixture route ${path}`);
  const snapshot = structuredClone(data);
  if (path === '/api/admin/overview' && fixtureOverviewDelay) await fixtureOverviewDelay;
  return { ok: true, status: 200, json: async () => structuredClone(snapshot) };
};
try { localStorage.removeItem('kicktipp-language'); } catch {}
