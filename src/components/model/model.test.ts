import { describe, expect, it } from 'vitest';
import { checkProblem, checkVariables, initialProblem, initialVariables, problemToParams, variablesToParams } from './decideEditors';
import { parseRows, showValue } from './ExplainPanel';
import { typicalRow } from './PredictPanel';
import { metricValue, modelName } from './models';
import { ENGINE_METHODS } from '../stats/methods';
import type { Dataset } from '../../types';

describe('Monte Carlo inputs', () => {
  it('sends each distribution’s own parameters (triangular: low=a, high=b, likely=c)', () => {
    expect(checkVariables(initialVariables())).toBeNull();
    expect(variablesToParams(initialVariables())).toEqual([
      { name: 'price', distribution: 'normal', a: 20, b: 2 },
      { name: 'volume', distribution: 'triangular', a: 800, c: 1000, b: 1300 },
      { name: 'fixed_cost', distribution: 'constant', a: 15000 },
    ]);
  });
  it('explains what’s wrong in plain words', () => {
    expect(checkVariables([{ name: 'unit price', distribution: 'normal', a: '1', b: '1', c: '' }])).toMatch(/isn’t a usable name/);
    expect(checkVariables([{ name: 'x', distribution: 'normal', a: '1', b: '0', c: '' }])).toMatch(/standard deviation/);
    expect(checkVariables([{ name: 'x', distribution: 'triangular', a: '1', b: '5', c: '9' }])).toMatch(/most likely/);
    expect(checkVariables([{ name: 'x', distribution: 'uniform', a: '1', b: '1', c: '' }, { name: 'x', distribution: 'constant', a: '1', b: '', c: '' }])).toMatch(/lowest value/);
  });
});

describe('optimisation problem', () => {
  it('turns the table into the engine’s linear programme', () => {
    const p = initialProblem();
    expect(checkProblem(p)).toBeNull();
    expect(problemToParams(p)).toEqual({
      variables: ['chairs', 'tables'], objective: [45, 80], sense: 'maximize',
      constraints: [{ name: 'wood', coefficients: [5, 20], sense: '<=', rhs: 400 }, { name: 'labour_hours', coefficients: [10, 15], sense: '<=', rhs: 450 }],
    });
    expect(problemToParams({ ...p, whole: true }).integer).toEqual(['chairs', 'tables']);
    expect(checkProblem({ ...p, objective: ['45', ''] })).toMatch(/goal row/);
  });
});

describe('model stage helpers', () => {
  it('parses row lists people type (counting from 1)', () => {
    expect(parseRows('1, 5, 10-12', 100)).toEqual([0, 4, 9, 10, 11]);
    expect(parseRows('0, 200', 100)).toEqual([]);
    expect(parseRows('a', 100)).toBeNull();
    expect(showValue('2022-03-01T00:00:00+00:00')).toBe('2022-03-01');
    expect(showValue('2022-03-01T10:30:00')).toBe('2022-03-01T10:30:00');
  });
  it('starts predictions from a typical row', () => {
    const ds = { filename: 'd', rowCount: 3, originalRowCount: 3, rows: [{ t: 1, c: 'M' }, { t: 5, c: 'M' }, { t: 9, c: 'Y' }],
      columns: [{ name: 't', type: 'numeric', distinctCount: 3, missingCount: 0, statistics: { median: 5 } }, { name: 'c', type: 'categorical', distinctCount: 2, missingCount: 0, statistics: {} }] } as unknown as Dataset;
    expect(typicalRow({ features: ['t', 'c'], featureTypes: { t: 'integer', c: 'text' } }, ds)).toEqual({ t: '5', c: 'M' });
  });
  it('shows error metrics as positive numbers and names models readably', () => {
    expect(metricValue('neg_root_mean_squared_error', -3.2)).toBe(3.2);
    expect(metricValue('roc_auc', 0.8)).toBe(0.8);
    expect(modelName({ id: 'mdl_abc123456', name: 'churn', version: 2, label: 'LightGBM' })).toBe('churn v2');
    expect(modelName({ id: 'mdl_abc123456', name: null, version: null, label: 'LightGBM' })).toBe('LightGBM · 123456');
  });
  // Shapes recorded from the engine.
  it('writes forecast and decision headlines from real results', () => {
    expect(ENGINE_METHODS.forecast.headline({ best: 'ets', forecast: [{ date: '2023-01-01T00:00:00', value: 210.4, lower: 200, upper: 221 }],
      leaderboard: [{ model: 'ets', mase: 0.5 }, { model: 'naive', mase: 1 }] }, {}))
      .toBe('Next period (2023-01-01): 210.4, likely between 200 and 221. Best method: Exponential smoothing (ETS) — 50% more accurate than repeating the last value.');
    expect(ENGINE_METHODS.optimize.headline({ feasible: true, objective: 2025, solution: { chairs: 15, tables: 20 } }, {})).toBe('Best 2,025 with chairs = 15, tables = 20.');
    expect(ENGINE_METHODS.montecarlo.headline({ mean: 5000, percentiles: { p5: 1000, p95: 9000 }, probabilityAbove: 0.8, sensitivity: [{ variable: 'volume' }] }, { threshold: 0 }))
      .toBe('Average 5,000; 90% of outcomes fall between 1,000 and 9,000, with an 80% chance of beating 0. volume matters most.');
  });
});
