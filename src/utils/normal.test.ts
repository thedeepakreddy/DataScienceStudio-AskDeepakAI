import { describe, expect, it } from 'vitest';
import { normalCdf, normalQuantile } from './normal';

describe('normal distribution', () => {
  it('matches standard table values', () => {
    expect(normalCdf(0)).toBeCloseTo(0.5, 7);
    expect(normalCdf(1.96)).toBeCloseTo(0.975, 4);
    expect(normalCdf(-1)).toBeCloseTo(0.158655, 5);
    expect(normalCdf(3)).toBeCloseTo(0.998650, 5);
  });

  it('inverts the CDF', () => {
    expect(normalQuantile(0.975)).toBeCloseTo(1.959964, 5);
    expect(normalQuantile(0.8)).toBeCloseTo(0.841621, 5);
    expect(normalQuantile(0.001)).toBeCloseTo(-3.090232, 5);
    for (const p of [0.01, 0.2, 0.5, 0.9, 0.999]) {
      expect(normalCdf(normalQuantile(p))).toBeCloseTo(p, 6);
    }
  });
});
