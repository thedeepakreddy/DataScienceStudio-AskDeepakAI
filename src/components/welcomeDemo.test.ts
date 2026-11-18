import { describe, expect, it } from 'vitest';
import { demoResults, median, pearson } from './welcomeDemo';

describe('agent welcome demo numbers are real', () => {
  it('fills the two blanks with medians and computes the rest from the rows', () => {
    const d = demoResults();
    expect(d.raw.filter(x => x.tenure == null || x.charges == null)).toHaveLength(2);
    expect(d.fills).toHaveLength(2);
    const tenures = d.raw.map(x => x.tenure).filter((x): x is number => x != null);
    expect(d.fills.find(f => f.col === 'tenure')!.value).toBe(median(tenures));
    expect(d.rows.every(x => x.tenure != null && x.charges != null)).toBe(true);
    expect(d.r).toBeCloseTo(pearson(d.rows.map(x => x.tenure!), d.rows.map(x => x.charges!)), 10);
    expect(Math.abs(d.r)).toBeLessThanOrEqual(1);
    expect(d.model.testRows).toBe(6);
    expect(d.model.accuracy).toBeGreaterThanOrEqual(0);
    expect(d.byPlan.reduce((s, g) => s + g.n, 0)).toBe(20);
  });
  it('median and correlation are right on known values', () => {
    expect(median([3, 1, 2])).toBe(2);
    expect(median([4, 1, 2, 3])).toBe(2.5);
    expect(pearson([1, 2, 3], [2, 4, 6])).toBeCloseTo(1);
    expect(pearson([1, 2, 3], [3, 2, 1])).toBeCloseTo(-1);
  });
});
