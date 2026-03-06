import { Match } from '../helpers/match.js';
import { Predictor } from './base.js';

export class SimplePredictor implements Predictor {
  private readonly DOMINATION_THRESHOLD = 6;
  private readonly DRAW_THRESHOLD = 1.2;

  predict(match: Match): [number, number] {
    const diff = Math.abs(match.rateHome - match.rateRoad);
    const homeWins = match.rateHome < match.rateRoad;

    if (diff < this.DRAW_THRESHOLD) return [1, 1];

    let result: [number, number];
    if (diff >= this.DOMINATION_THRESHOLD) {
      result = [3, 1];
    } else if (diff >= this.DOMINATION_THRESHOLD / 2) {
      result = [2, 1];
    } else {
      result = [1, 0];
    }

    return homeWins ? result : [result[1], result[0]];
  }
}
