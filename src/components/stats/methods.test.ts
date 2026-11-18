import { describe, expect, it } from 'vitest';
import { ENGINE_METHODS, GROUP_METHODS, GUIDES } from './methods';
import { columnsFor, num, pValue } from './methodKit';
import { CAPABILITIES } from '../../engine/contract.generated';
import type { Dataset } from '../../types';

const col = (name: string, type: any, distinctCount: number) => ({ name, type, distinctCount, missingCount: 0, statistics: {} });
const dataset = { filename: 'd.csv', rows: [], rowCount: 600, originalRowCount: 600, columns: [
  col('customer', 'numeric', 60), col('spend', 'numeric', 590), col('treated', 'numeric', 2), col('segment', 'categorical', 3), col('when', 'datetime', 100),
] } as unknown as Dataset;

describe('method kit', () => {
  it('filters columns for each kind of field', () => {
    expect(columnsFor(dataset, 'binary')).toEqual(['treated']);
    expect(columnsFor(dataset, 'group')).toEqual(['customer', 'treated', 'segment']);  // numeric ids count as groups
    expect(columnsFor(dataset, 'numeric')).toEqual(['customer', 'spend', 'treated']);
    expect(columnsFor(dataset, 'categorical')).toEqual(['treated', 'segment']);
  });

  it('formats numbers and p-values readably', () => {
    expect(num(1.23456)).toBe('1.23');
    expect(num(0.0000123)).toBe('1.23e-5');
    expect(num(null)).toBe('—');
    expect(pValue(0.0004)).toBe('< 0.001');
    expect(pValue(0.0412)).toBe('0.041');
  });
});

describe('methods', () => {
  it('every method runs a real engine capability and every group/guide points at real methods', () => {
    for (const m of Object.values(ENGINE_METHODS)) expect(CAPABILITIES[m.cap], m.id).toBeDefined();
    const builtin = new Set(['quick', 'interpret']);
    for (const ids of Object.values(GROUP_METHODS)) for (const id of ids) expect(builtin.has(id) || !!ENGINE_METHODS[id], id).toBe(true);
    const walk = (s: any): string[] => s.options.flatMap((o: any) => (o.method ? [o.method] : walk(o.next)));
    for (const g of Object.values(GUIDES)) for (const id of walk(g)) expect(builtin.has(id) || !!ENGINE_METHODS[id], id).toBe(true);
  });

  // Result shapes recorded from the engine.
  it('writes plain-language headlines from real results', () => {
    expect(ENGINE_METHODS.propensity.headline({ effect: 1.56, ci: [1.4, 1.81] }, { treatment: 'treated', outcome: 'spend' }))
      .toBe('treated raises spend: +1.56 on average (95% CI 1.4 to 1.81).');
    expect(ENGINE_METHODS.propensity.headline({ effect: 0.1, ci: [-0.2, 0.4] }, { treatment: 't', outcome: 'y' })).toContain('has no clear effect on');
    expect(ENGINE_METHODS.glm.headline({ coefficients: [
      { term: 'Intercept', estimate: 2, p: 0, statistic: 20 }, { term: 'x', estimate: 0.8, ci: [0.7, 0.9], p: 1e-9, statistic: 12 }, { term: 'g', estimate: 0.1, p: 0.4, statistic: 0.8 }] }, { outcome: 'y' }))
      .toBe('x has the clearest effect on y: +0.8 per unit (95% CI 0.7 to 0.9, p < 0.001).');
    expect(ENGINE_METHODS.ab.headline({ control: 'A', sampleRatio: { mismatch: false }, variants: [{ variant: 'A' }, { variant: 'B', p: 0.2, relativeLift: 0.05, significant: false }] }, {}))
      .toBe('No variant clearly beats A: best is B at +5% (p 0.200).');
    expect(ENGINE_METHODS.ab.headline({ control: 'A', sampleRatio: { mismatch: true, p: 0.001 }, variants: [] }, {})).toMatch(/^Don’t trust this test yet/);
    expect(ENGINE_METHODS.km.headline({ curves: [{ group: 'A', median: 10.6 }, { group: 'B', median: null }], logRank: { p: 0.0001 } }, {}))
      .toBe('Groups differ (log-rank p < 0.001). Median time — A: 10.6 · B: not reached.');
    expect(ENGINE_METHODS['bayes-t'].headline({ bf10: 5e22, bf01: 2e-23, evidence: 'extreme' }, {})).toContain('more than 10,000×');
    expect(ENGINE_METHODS['bayes-ab'].headline({ leader: 'B', leaderProbability: 0.9999, variants: [{ name: 'B', expectedLoss: 0.000003 }] }, {})).toContain('over 99.9% chance');
    expect(ENGINE_METHODS.sample.params!({ metric: 'conversion', baseline: 5, mde: 10 })).toMatchObject({ baseline: 0.05, mde: 0.1 });
  });
});
