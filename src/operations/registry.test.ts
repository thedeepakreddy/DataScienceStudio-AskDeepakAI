import { describe, expect, it } from 'vitest';
import { applyOperation, applyOperations, OperationError } from './registry';
import { parseCSV } from '../utils/csvParser';

const csv = `id,city,age,income,member
1,Paris,30,1000,yes
2,Rome,,2000,no
3,Paris,50,,yes
4,,40,4000,no
4,,40,4000,no`;
const ds = () => parseCSV(csv, 'people.csv');

describe('operation registry', () => {
  it('fills with the true median and refreshes column stats', () => {
    const r = applyOperation(ds(), 'fill_missing', { column: 'age', strategy: 'median' });
    expect(r.dataset.rows[1].age).toBe(40);
    const age = r.dataset.columns.find(c => c.name === 'age')!;
    expect(age.missingCount).toBe(0);
    expect(age.statistics.mean).toBe(40);
    expect(r.summary).toContain('1 missing value');
  });

  it('refuses a mean on a text column', () => {
    expect(() => applyOperation(ds(), 'fill_missing', { column: 'city', strategy: 'mean' })).toThrow(OperationError);
  });

  it('fills text with the most common value', () => {
    const r = applyOperation(ds(), 'fill_missing', { column: 'city', strategy: 'mode' });
    expect(r.dataset.rows[3].city).toBe('Paris');
  });

  it('drops and renames columns without touching the input', () => {
    const input = ds();
    const r = applyOperations(input, [
      { op: 'drop_columns', params: { columns: ['id'] } },
      { op: 'rename_column', params: { from: 'income', to: 'salary' } },
    ]);
    expect(r.dataset.columns.map(c => c.name)).toEqual(['city', 'age', 'salary', 'member']);
    expect(r.dataset.rows[0].salary).toBe(1000);
    expect(input.columns.map(c => c.name)).toContain('id');
  });

  it('filters rows numerically', () => {
    const r = applyOperation(ds(), 'filter_rows', { column: 'age', operator: 'greater_than', value: 35 });
    expect(r.dataset.rows.map(x => x.age)).toEqual([50, 40, 40]);
    expect(r.dataset.rowCount).toBe(3);
  });

  it('removes exact duplicates', () => {
    const r = applyOperation(ds(), 'remove_duplicates', {});
    expect(r.dataset.rows).toHaveLength(4);
    expect(r.summary).toBe('Removed 1 duplicate row.');
  });

  it('leaves uncomputable derived values empty instead of 0', () => {
    const r = applyOperation(ds(), 'derive_column', { source: 'income', transform: 'divide', other: 'age' });
    const col = r.dataset.rows.map(x => x.income_div_age);
    expect(col[0]).toBeCloseTo(33.333333, 5);
    expect(col[1]).toBeNull(); // age missing
    expect(col[2]).toBeNull(); // income missing
  });

  it('scales with the real min and max', () => {
    const r = applyOperation(ds(), 'derive_column', { source: 'income', transform: 'minmax' });
    expect(r.dataset.rows.map(x => x.minmax_income)).toEqual([0, 1 / 3, null, 1, 1].map(v => (v === null ? null : parseFloat(v.toFixed(6)))));
  });

  it('one-hot encodes and keeps missing as missing', () => {
    const r = applyOperation(ds(), 'one_hot_encode', { column: 'city' });
    expect(r.dataset.rows[0]).toMatchObject({ city_Paris: 1, city_Rome: 0 });
    expect(r.dataset.rows[3].city_Paris).toBeNull();
  });

  it('rejects a duplicate column name', () => {
    expect(() => applyOperation(ds(), 'add_column', { name: 'AGE', type: 'numeric', value: 1 })).toThrow('already exists');
  });
});
