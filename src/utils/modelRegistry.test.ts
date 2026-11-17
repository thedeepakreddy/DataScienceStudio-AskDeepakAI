import { describe, expect, it } from 'vitest';
import { buildSchema, checkInput, gateBlocks, modelCardMarkdown, validationGate } from './modelRegistry';
import { parseCSV } from './csvParser';
import type { MLResult } from '../types';

const ds = parseCSV(['id,plan,age,churn', ...Array.from({ length: 40 }, (_, i) =>
  `${i},${i % 2 ? 'pro' : 'basic'},${20 + i},${i < 30 ? 'No' : 'Yes'}`)].join('\n'), 'c.csv');

const result = (over: Partial<MLResult>): MLResult => ({
  target: 'churn', modelType: 'classification', modelAlgorithm: 'RF', hyperparameters: {},
  metrics: { accuracy: 0.9 }, featureImportance: [{ feature: 'age', score: 0.6 }], tuningHistory: [], predictions: [],
  modelReportMarkdown: '', cv: { mean: 0.88, std: 0.03 }, split: { strategy: 'random', testSize: 0.2, seed: 42, trainRows: 32, testRows: 40 },
  leakageWarnings: [], ...over,
} as MLResult);

describe('model registry', () => {
  it('passes a model that beats the baseline', () => {
    const gate = validationGate(result({}), ds);
    expect(gate.map(g => [g.id, g.status])).toEqual([
      ['baseline', 'pass'], ['stability', 'pass'], ['agreement', 'pass'], ['leakage', 'pass'], ['test-size', 'pass'],
    ]);
    expect(gateBlocks(gate)).toBe(false);
  });

  it('blocks a model no better than guessing, or with leakage, or using an ID', () => {
    expect(validationGate(result({ metrics: { accuracy: 0.75 } }), ds).find(g => g.id === 'baseline')!.status).toBe('fail');
    expect(gateBlocks(validationGate(result({ leakageWarnings: [{ column: 'x', reason: 'copy' }] }), ds))).toBe(true);
    expect(validationGate(result({ featureImportance: [{ feature: 'id', score: 0.7 }] }), ds).some(g => g.id === 'id-feature' && g.status === 'fail')).toBe(true);
  });

  it('checks prediction inputs against the training data', () => {
    const schema = buildSchema(ds, ['plan', 'age']);
    expect(schema[1]).toMatchObject({ min: 20, max: 59 });
    expect(checkInput(schema, { plan: 'pro', age: 30 })).toEqual([]);
    const w = checkInput(schema, { plan: 'gold', age: 99 });
    expect(w).toHaveLength(2);
    expect(w[0]).toContain('never appeared');
    expect(w[1]).toContain('outside the training range (20 to 59)');
  });

  it('writes a model card with the real numbers and limitations', () => {
    const r = result({ cv: { mean: 0.6, std: 0.2 } as any });
    const card = modelCardMarkdown({
      id: 'm', name: 'Churn model', version: 2, datasetId: 'd', versionId: 'v', modelKey: 'random_forest', modelId: null,
      recipe: { target: 'churn', features: ['plan', 'age'], modelType: 'classification', hyperparameters: { seed: 7 } },
      algorithm: 'RF', task: 'classification', metrics: { accuracy: 0.9 }, cv: { mean: 0.6, std: 0.2, folds: 5, metric: 'accuracy' },
      split: r.split, topFeatures: [{ feature: 'age', score: 0.6 }], schema: [], gate: validationGate(r, ds), intendedUse: 'Prioritise calls.',
      createdAt: 0, active: true,
    }, 'c.csv', 'v3 Removed 2 rows');
    expect(card).toContain('# Model card: Churn model (v2)');
    expect(card).toContain('| accuracy | 90.0% |');
    expect(card).toContain('Random seed: 7');
    expect(card).toContain('⚠ Stable across data samples');
    expect(card).toContain('Prioritise calls.');
  });
});
