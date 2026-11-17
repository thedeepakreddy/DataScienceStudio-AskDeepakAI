import { describe, expect, it } from 'vitest';
import { describeChange } from './describeChange';
import type { Dataset } from '../types';

const ds = (rows: Record<string, any>[]): Dataset => ({
  filename: 'a.csv',
  rows,
  rowCount: rows.length,
  originalRowCount: rows.length,
  columns: Object.keys(rows[0] ?? {}).map(name => ({ name, type: 'numeric', missingCount: 0, distinctCount: 1, statistics: {} })),
});

const base = ds([{ a: 1, b: 2 }, { a: 3, b: null }, { a: 5, b: 6 }]);

describe('describeChange', () => {
  it('labels an import', () => {
    expect(describeChange(null, base)).toBe('Imported');
  });
  it('counts removed rows', () => {
    expect(describeChange(base, ds(base.rows.slice(1)))).toBe('Removed 1 row');
  });
  it('names a removed column', () => {
    expect(describeChange(base, ds(base.rows.map(({ a }) => ({ a }))))).toBe('Removed “b”');
  });
  it('detects a rename', () => {
    expect(describeChange(base, ds(base.rows.map(r => ({ a: r.a, c: r.b }))))).toBe('Renamed “b” to “c”');
  });
  it('counts filled values', () => {
    expect(describeChange(base, ds(base.rows.map(r => ({ ...r, b: r.b ?? 4 }))))).toBe('Changed 1 value in “b”');
  });
  it('treats empty and null as the same', () => {
    expect(describeChange(base, ds(base.rows.map(r => ({ ...r, b: r.b ?? '' }))))).toBe('No changes');
  });
});
