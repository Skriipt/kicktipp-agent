import { describe, it, expect } from 'vitest';
import { Match } from '../src/helpers/match.js';
import { SimplePredictor } from '../src/predictors/simple.js';
import { CalculationPredictor } from '../src/predictors/calculation.js';
import { getPredictors } from '../src/predictors/index.js';

describe('SimplePredictor', () => {
  const predictor = new SimplePredictor();

  it('predicts draw for close odds', () => {
    const m = new Match('A', 'B', '03/15/26 03:30 PM', '2.0', '3.0', '2.5');
    expect(predictor.predict(m)).toEqual([1, 1]);
  });

  it('predicts home win for lower home odds', () => {
    const m = new Match('A', 'B', '03/15/26 03:30 PM', '1.5', '4.0', '6.0');
    const [h, g] = predictor.predict(m);
    expect(h).toBeGreaterThan(g);
  });

  it('predicts away win for lower away odds', () => {
    const m = new Match('A', 'B', '03/15/26 03:30 PM', '6.0', '4.0', '1.5');
    const [h, g] = predictor.predict(m);
    expect(g).toBeGreaterThan(h);
  });
});

describe('CalculationPredictor', () => {
  const predictor = new CalculationPredictor();

  it('predicts draw for close odds', () => {
    const m = new Match('A', 'B', '03/15/26 03:30 PM', '2.0', '3.0', '2.5');
    expect(predictor.predict(m)).toEqual([1, 1]);
  });

  it('predicts home win for lower home odds', () => {
    const m = new Match('A', 'B', '03/15/26 03:30 PM', '1.2', '6.0', '12.0');
    const [h, g] = predictor.predict(m);
    expect(h).toBeGreaterThan(g);
  });
});

describe('Predictor registry', () => {
  it('has all predictors', () => {
    const all = getPredictors();
    expect(Object.keys(all)).toContain('SimplePredictor');
    expect(Object.keys(all)).toContain('CalculationPredictor');
    expect(Object.keys(all)).toContain('ClaudePredictor');
  });
});
