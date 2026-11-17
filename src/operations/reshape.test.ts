import { describe, expect, it } from 'vitest';
import { applyOperation } from './registry';
import { parseCSV } from '../utils/csvParser';

const sales = () => parseCSV(`region,product,units,price
North,A,10,2.5
North,B,5,4
South,A,8,2.5
South,A,2,2.5
,B,1,4`, 'sales.csv');

const table = (csv: string, name: string) => {
  const d = parseCSV(csv, name);
  return { name, rows: d.rows, columns: d.columns.map(c => ({ name: c.name, type: c.type })) };
};

describe('reshaping operations', () => {
  it('tidies text and reports merged categories', () => {
    const ds = parseCSV('city\n paris\nParis \nPARIS\nrome', 'c.csv');
    const r = applyOperation(ds, 'standardize_text', { column: 'city', case: 'title' });
    expect(r.dataset.rows.map(x => x.city)).toEqual(['Paris', 'Paris', 'Paris', 'Rome']);
    expect(r.summary).toContain('4 different values became 2');
  });

  it('replaces values case-insensitively', () => {
    const r = applyOperation(sales(), 'replace_values', { column: 'region', from: 'north', to: 'N' });
    expect(r.dataset.rows.map(x => x.region)).toEqual(['N', 'N', 'South', 'South', null]);
  });

  it('converts messy text to numbers and counts failures', () => {
    const ds = parseCSV('amount\n"$1,200.50"\n(300)\n"1.234,5"\n12%\nn/a\n"$1,200"\n"3,5"\n"1,234,567"', 'm.csv');
    const r = applyOperation(ds, 'convert_type', { column: 'amount', to: 'numeric' });
    expect(r.dataset.rows.map(x => x.amount)).toEqual([1200.5, -300, 1234.5, 12, null, 1200, 3.5, 1234567]);
    expect(r.summary).toContain('1 value couldn’t be converted');
    expect(r.dataset.columns[0].type).toBe('numeric');
  });

  it('left-joins and keeps unmatched rows', () => {
    const right = table('product,category,price\nA,Tools,9\nb,Toys,7', 'products.csv');
    const r = applyOperation(sales(), 'join', { right, leftKey: 'product', rightKey: 'product', how: 'left' });
    expect(r.dataset.columns.map(c => c.name)).toEqual(['region', 'product', 'units', 'price', 'category', 'price_products']);
    expect(r.dataset.rows[1]).toMatchObject({ product: 'B', category: 'Toys', price_products: 7 });
    expect(r.summary).toContain('5 rows of 5 matched');
  });

  it('inner join drops unmatched rows', () => {
    const right = table('product,category\nA,Tools', 'p.csv');
    const r = applyOperation(sales(), 'join', { right, leftKey: 'product', rightKey: 'product', how: 'inner' });
    expect(r.dataset.rows).toHaveLength(3);
  });

  it('appends rows by column name', () => {
    const right = table('Units,region,discount\n3,East,0.1', 'more.csv');
    const r = applyOperation(sales(), 'append_rows', { right });
    expect(r.dataset.rows).toHaveLength(6);
    expect(r.dataset.rows[5]).toMatchObject({ region: 'East', units: 3, product: null, discount: 0.1 });
    expect(r.dataset.rows[0].discount).toBeNull();
  });

  it('summarises by group, keeping missing keys as their own group', () => {
    const r = applyOperation(sales(), 'group_aggregate', {
      by: ['region'],
      aggregations: [{ column: 'units', fn: 'sum' }, { column: 'units', fn: 'median' }, { column: 'product', fn: 'count_distinct' }],
    });
    expect(r.dataset.rows).toEqual([
      { region: 'North', sum_units: 15, median_units: 7.5, count_distinct_product: 2 },
      { region: 'South', sum_units: 10, median_units: 5, count_distinct_product: 1 },
      { region: null, sum_units: 1, median_units: 1, count_distinct_product: 1 },
    ]);
  });

  it('pivots values into columns', () => {
    const r = applyOperation(sales(), 'pivot', { index: 'region', columns: 'product', values: 'units', fn: 'sum' });
    expect(r.dataset.columns.map(c => c.name)).toEqual(['region', 'A', 'B']);
    expect(r.dataset.rows[1]).toEqual({ region: 'South', A: 10, B: null });
  });
});
