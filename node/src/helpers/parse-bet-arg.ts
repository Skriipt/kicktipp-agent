export interface EditableMatch {
  home: string;
  away: string;
  heimName: string;
  gastName: string;
}

export function parseBetArg(arg: string): {
  home: string;
  away: string;
  h: number;
  g: number;
} {
  if (!arg.includes('=')) {
    throw new Error(
      `Invalid bet '${arg}'. Use format: Home vs Away=H:G`,
    );
  }
  const eqIdx = arg.lastIndexOf('=');
  const fixture = arg.slice(0, eqIdx);
  const result = arg.slice(eqIdx + 1);
  if (!fixture.includes(' vs ')) {
    throw new Error(
      `Invalid fixture '${arg}'. Use format: Home vs Away=H:G`,
    );
  }
  const vsIdx = fixture.indexOf(' vs ');
  const home = fixture.slice(0, vsIdx).trim();
  const away = fixture.slice(vsIdx + 4).trim();
  if (!home || !away) {
    throw new Error(
      `Invalid fixture '${arg}'. Both team names required.`,
    );
  }
  const parts = result.split(':');
  if (parts.length !== 2) {
    throw new Error(
      `Invalid result '${result}'. Use format H:G (e.g. 2:1)`,
    );
  }
  const h = parseInt(parts[0]);
  const g = parseInt(parts[1]);
  if (isNaN(h) || isNaN(g)) {
    throw new Error(
      `Invalid result '${result}'. Use format H:G (e.g. 2:1)`,
    );
  }
  return { home, away, h, g };
}

export function matchFixture(
  home: string,
  away: string,
  editable: EditableMatch[],
): EditableMatch {
  const match = editable.find(
    (e) =>
      e.home.toLowerCase() === home.toLowerCase() &&
      e.away.toLowerCase() === away.toLowerCase(),
  );
  if (!match) {
    throw new Error(`No match found for "${home} vs ${away}"`);
  }
  return match;
}
