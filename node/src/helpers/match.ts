export class Match {
  readonly hometeam: string;
  readonly roadteam: string;
  private _matchDate: Date | null;
  readonly rateHome: number;
  readonly rateDeuce: number;
  readonly rateRoad: number;

  constructor(
    hometeam: string,
    roadteam: string,
    matchDate: string | Date,
    rateHome: string | number,
    rateDeuce: string | number,
    rateRoad: string | number,
  ) {
    this.hometeam = hometeam;
    this.roadteam = roadteam;
    this._matchDate = this.parseDate(matchDate);
    this.rateHome = typeof rateHome === 'string' ? parseFloat(rateHome) : rateHome;
    this.rateDeuce = typeof rateDeuce === 'string' ? parseFloat(rateDeuce) : rateDeuce;
    this.rateRoad = typeof rateRoad === 'string' ? parseFloat(rateRoad) : rateRoad;
  }

  get matchDate(): Date | null {
    return this._matchDate;
  }

  set matchDate(date: Date | null) {
    this._matchDate = date;
  }

  get odds(): [number, number, number] {
    return [this.rateHome, this.rateDeuce, this.rateRoad];
  }

  toString(): string {
    const dateStr = this._matchDate
      ? this._matchDate.toLocaleDateString('de-DE', {
          day: '2-digit',
          month: '2-digit',
          year: 'numeric',
          hour: '2-digit',
          minute: '2-digit',
        })
      : 'unknown';
    return `${dateStr} '${this.hometeam}' vs. '${this.roadteam}' (${this.rateHome};${this.rateDeuce};${this.rateRoad})`;
  }

  private parseDate(date: string | Date): Date | null {
    if (date instanceof Date) return date;
    const trimmed = date.trim();
    // US format: M/D/YY h:mm AM/PM
    const usMatch = trimmed.match(
      /^(\d{1,2})\/(\d{1,2})\/(\d{2})\s+(\d{1,2}):(\d{2})\s+(AM|PM)$/i,
    );
    if (usMatch) {
      const [, m, d, y, h, min, ampm] = usMatch;
      let hour = parseInt(h);
      if (ampm.toUpperCase() === 'PM' && hour !== 12) hour += 12;
      if (ampm.toUpperCase() === 'AM' && hour === 12) hour = 0;
      return new Date(
        2000 + parseInt(y),
        parseInt(m) - 1,
        parseInt(d),
        hour,
        parseInt(min),
      );
    }
    // DE format: DD.MM.YY HH:MM
    const deMatch = trimmed.match(
      /^(\d{2})\.(\d{2})\.(\d{2})\s+(\d{2}):(\d{2})$/,
    );
    if (deMatch) {
      const [, d, m, y, h, min] = deMatch;
      return new Date(
        2000 + parseInt(y),
        parseInt(m) - 1,
        parseInt(d),
        parseInt(h),
        parseInt(min),
      );
    }
    return null;
  }
}
