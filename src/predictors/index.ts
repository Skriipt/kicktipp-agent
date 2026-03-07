import { Predictor } from './base.js';
import { SimplePredictor } from './simple.js';
import { CalculationPredictor } from './calculation.js';
import { ClaudePredictor } from './claude.js';

const predictors: Record<string, new () => Predictor> = {
  SimplePredictor,
  CalculationPredictor,
  ClaudePredictor,
};

export function getPredictors(): Record<string, new () => Predictor> {
  return predictors;
}

export function choosePredictor(name: string | undefined): Predictor {
  const all = getPredictors();
  if (name) {
    const Cls = all[name];
    if (!Cls) {
      console.error(`Unknown predictor: ${name}`);
      process.exit(1);
    }
    const p = new Cls();
    console.log(`Using predictor: ${name}`);
    return p;
  }
  const firstName = Object.keys(all)[0];
  const p = new all[firstName]();
  console.log(`Using predictor: ${firstName}`);
  return p;
}

export { Predictor } from './base.js';
