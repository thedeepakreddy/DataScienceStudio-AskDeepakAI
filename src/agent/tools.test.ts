import { describe, expect, it } from 'vitest';
import { buildPlan, planNeedsConfirm, verifyStep } from './tools';
import { parseCSV } from '../utils/csvParser';
import { applyOperation } from '../operations/registry';

const ds = parseCSV('id,age,city\n1,30,Paris\n2,,Rome\n3,50,Paris', 'p.csv');

describe('agent tools', () => {
  it('builds a checked plan and flags steps that can’t run', () => {
    const plan = buildPlan([
      { type: 'SELECT_TAB', tab: 'clean' },
      { type: 'DROP_COLUMN', column: 'ID' },
      { type: 'FILL_MISSING', column: 'id' },
      { type: 'FILTER_ROWS', column: 'age', operator: '>', value: 35 },
      { type: 'HACK_THE_PLANET' },
    ], ds);
    expect(plan.map(s => s.label)).toEqual([
      'Open the Clean step', 'Remove the column “ID”', 'Fill missing values in “id” (mean)', 'Keep rows where “age” > 35',
    ]);
    expect(plan[2].problem).toContain('no column called “id”'); // removed by the step before
    expect(plan[1].problem).toBeUndefined();
    expect(planNeedsConfirm(plan)).toBe(true);
    expect(planNeedsConfirm(buildPlan([{ type: 'SELECT_TAB', tab: 'eda' }], ds))).toBe(false);
  });

  it('verifies the effect of a step from the data', () => {
    const [fill] = buildPlan([{ type: 'FILL_MISSING', column: 'age', strategy: 'median' }], ds);
    const after = applyOperation(ds, 'fill_missing', { column: 'age', strategy: 'median' }).dataset;
    expect(verifyStep(fill, ds, after)).toEqual({ ok: true, detail: '1 missing value filled; none left.' });
    expect(verifyStep(fill, ds, ds).ok).toBe(false);

    const [filter] = buildPlan([{ type: 'FILTER_ROWS', column: 'city', operator: '==', value: 'paris' }], ds);
    const kept = applyOperation(ds, 'filter_rows', { column: 'city', operator: 'equals', value: 'paris' }).dataset;
    expect(verifyStep(filter, ds, kept)).toEqual({ ok: true, detail: '2 of 3 rows kept; all match.' });
    expect(verifyStep(filter, ds, ds).ok).toBe(false);
  });
});
