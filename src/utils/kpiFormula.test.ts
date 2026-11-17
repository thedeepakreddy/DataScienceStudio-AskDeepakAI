import { describe, expect, it } from 'vitest';
import { FormulaError, checkFormula, evaluateFormula, formatKpi } from './kpiFormula';

const rows = [
  { revenue: 100, units: 2, region: 'N', 'Monthly Charges': 10 },
  { revenue: 300, units: 0, region: 'S', 'Monthly Charges': 20 },
  { revenue: null, units: 4, region: 'N', 'Monthly Charges': 30 },
];
const cols = Object.keys(rows[0]);
const val = (f: string) => evaluateFormula(checkFormula(f, cols), rows);

describe('KPI formulas', () => {
  it('evaluates aggregates and arithmetic', () => {
    expect(val('SUM(revenue)')).toBe(400);
    expect(val('SUM(revenue) / COUNT()')).toBeCloseTo(133.333, 3);
    expect(val('AVG(revenue)')).toBe(200);
    expect(val('COUNT(revenue)')).toBe(2);
    expect(val('COUNT_DISTINCT(region)')).toBe(2);
    expect(val('MEDIAN(units) * 2 + 1')).toBe(5);
    expect(val('-(MAX(units) - MIN(units))')).toBe(-4);
    expect(val('AVG([Monthly Charges]) * 12')).toBe(240);
    expect(val('mean(units)')).toBe(2);
  });

  it('returns null for division by zero', () => {
    expect(val('SUM(revenue) / MIN(units)')).toBeNull();
  });

  it('rejects unknown columns, functions and code', () => {
    expect(() => checkFormula('SUM(price)', cols)).toThrow('no column called “price”');
    expect(() => checkFormula('EVAL(x)', cols)).toThrow(FormulaError);
    expect(() => checkFormula('SUM(revenue); alert(1)', cols)).toThrow(FormulaError);
    expect(() => checkFormula('SUM()', cols)).toThrow('needs a column');
    expect(() => checkFormula('SUM(revenue) +', cols)).toThrow('ends too early');
  });

  it('formats values', () => {
    expect(formatKpi(0.1234, 'percent')).toBe('12.3%');
    expect(formatKpi(null, 'number')).toBe('—');
  });
});
