import { describe, expect, it } from 'vitest';
import { adjustPValues, formatP } from './pAdjust';

// Expected values: Bonferroni and Holm worked by hand from their definitions;
// BH checked against scipy.stats.false_discovery_control([0.01, 0.04, 0.03, 0.005]).
const p = [0.01, 0.04, 0.03, 0.005];

describe('p-value adjustment', () => {
  it('Bonferroni', () => {
    expect(adjustPValues(p, 'bonferroni')).toEqual([0.04, 0.16, 0.12, 0.02]);
  });
  it('Holm', () => {
    const r = adjustPValues(p, 'holm');
    [0.03, 0.06, 0.06, 0.02].forEach((v, i) => expect(r[i]).toBeCloseTo(v, 10));
  });
  it('Benjamini–Hochberg', () => {
    const r = adjustPValues(p, 'fdr_bh');
    [0.02, 0.04, 0.04, 0.02].forEach((v, i) => expect(r[i]).toBeCloseTo(v, 10));
  });
  it('formats p-values', () => {
    expect(formatP(0.0004)).toBe('< 0.001');
    expect(formatP(0.04567)).toBe('0.046');
  });
});
