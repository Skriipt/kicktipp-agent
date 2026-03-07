export const URL_BASE = 'https://www.kicktipp.com';
export const URL_LOGIN = `${URL_BASE}/info/profil/login`;

export function getPredictUrl(
  community: string,
  matchday?: number,
): string {
  const base = `${URL_BASE}/${encodeURIComponent(community)}/predict`;
  if (matchday === undefined) return base;
  if (matchday < 1 || matchday > 34) {
    throw new RangeError(
      `The matchday '${matchday}' is not valid, use only 1 to 34!`,
    );
  }
  return `${base}?spieltagIndex=${matchday}`;
}

export function getLeaderboardUrl(
  community: string,
  matchday?: number,
  bonus = false,
): string {
  const params: string[] = [];
  if (bonus) params.push('bonus=true');
  if (matchday !== undefined) {
    if (matchday < 1 || matchday > 34) {
      throw new RangeError(
        `The matchday '${matchday}' is not valid, use only 1 to 34!`,
      );
    }
    params.push(`spieltagIndex=${matchday}`);
  }
  const base = `${URL_BASE}/${encodeURIComponent(community)}/leaderboard`;
  return params.length ? `${base}?${params.join('&')}` : base;
}
