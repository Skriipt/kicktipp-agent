import { Match } from '../helpers/match.js';

export interface Predictor {
  predict(match: Match): [number, number];
}
