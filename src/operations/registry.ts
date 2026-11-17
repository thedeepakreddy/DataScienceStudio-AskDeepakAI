/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Dataset, DatasetColumn } from '../types';
import { isEmpty, rebuildDataset } from '../utils/columnProfile';

// Every change the studio can make to a dataset, in one place. The Clean
// step, the assistant and saved workflows all run these same functions, so an
// operation behaves identically wherever it is started, and each version in the
// history can record exactly which operation (and settings) produced it.
//
// Each operation is pure: it returns a new Dataset and never mutates its input.

export type ColumnType = DatasetColumn['type'];
export type FillStrategy = 'mean' | 'median' | 'mode' | 'zero' | 'constant';
export type FilterOperator = 'equals' | 'not_equals' | 'greater_than' | 'less_than' | 'contains' | 'is_empty' | 'is_not_empty';
export type DeriveTransform = 'log' | 'sqrt' | 'square' | 'minmax' | 'standard' | 'multiply' | 'divide';

export interface OperationParams {
  drop_columns: { columns: string[] };
  rename_column: { from: string; to: string };
  fill_missing: { column: string; strategy: FillStrategy; value?: string | number | boolean };
  add_column: { name: string; type: ColumnType; value: string | number | boolean | null };
  add_row: { values?: Record<string, unknown> };
  delete_rows: { indices: number[] };
  filter_rows: { column: string; operator: FilterOperator; value?: string | number };
  remove_duplicates: Record<string, never>;
  derive_column: { source: string; transform: DeriveTransform; other?: string; name?: string };
  one_hot_encode: { column: string; prefix?: string };
}

export type OperationId = keyof OperationParams;

export interface AppliedOperation<K extends OperationId = OperationId> {
  op: K;
  params: OperationParams[K];
}

export interface OperationResult {
  dataset: Dataset;
  /** What happened, in plain words, with the real counts. */
  summary: string;
}

export class OperationError extends Error {}

interface OperationDef<K extends OperationId> {
  label: string;
  /** Where it runs. Every operation here is light enough for the browser. */
  runsIn: 'browser' | 'backend';
  run: (ds: Dataset, params: OperationParams[K]) => OperationResult;
}

const plural = (n: number, w: string) => `${n.toLocaleString()} ${w}${n === 1 ? '' : 's'}`;
const colTypes = (ds: Dataset) => ds.columns.map(c => ({ name: c.name, type: c.type }));

function requireColumn(ds: Dataset, name: string): DatasetColumn {
  const col = ds.columns.find(c => c.name === name);
  if (!col) throw new OperationError(`There is no column called “${name}”.`);
  return col;
}

function requireNumeric(ds: Dataset, name: string): DatasetColumn {
  const col = requireColumn(ds, name);
  if (col.type !== 'numeric') throw new OperationError(`“${name}” isn’t numeric, so this can’t be applied to it.`);
  return col;
}

function requireNewName(ds: Dataset, name: string) {
  const clean = name.trim();
  if (!clean) throw new OperationError('Enter a column name.');
  if (ds.columns.some(c => c.name.toLowerCase() === clean.toLowerCase())) {
    throw new OperationError(`A column called “${clean}” already exists.`);
  }
  return clean;
}

const toNumber = (v: unknown): number | null => {
  if (isEmpty(v) || typeof v === 'boolean') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

function castValue(type: ColumnType, v: unknown): unknown {
  if (v === null || v === undefined || v === '') return null;
  if (type === 'numeric') return toNumber(v);
  if (type === 'boolean') {
    if (typeof v === 'boolean') return v;
    const s = String(v).trim().toLowerCase();
    if (['true', 'yes', '1'].includes(s)) return true;
    if (['false', 'no', '0'].includes(s)) return false;
    return null;
  }
  return String(v);
}

const round6 = (n: number) => parseFloat(n.toFixed(6));

export const OPERATIONS: { [K in OperationId]: OperationDef<K> } = {
  drop_columns: {
    label: 'Remove columns',
    runsIn: 'browser',
    run(ds, { columns }) {
      if (columns.length === 0) throw new OperationError('Choose at least one column to remove.');
      columns.forEach(c => requireColumn(ds, c));
      const drop = new Set(columns);
      const rows = ds.rows.map(r => {
        const copy = { ...r };
        columns.forEach(c => delete copy[c]);
        return copy;
      });
      return {
        dataset: rebuildDataset(ds, rows, colTypes(ds).filter(c => !drop.has(c.name))),
        summary: columns.length === 1 ? `Removed “${columns[0]}”.` : `Removed ${columns.length} columns.`,
      };
    },
  },

  rename_column: {
    label: 'Rename a column',
    runsIn: 'browser',
    run(ds, { from, to }) {
      requireColumn(ds, from);
      const name = requireNewName(ds, to);
      const rows = ds.rows.map(r => {
        const copy: Record<string, any> = {};
        for (const k of Object.keys(r)) copy[k === from ? name : k] = r[k];
        return copy;
      });
      return {
        dataset: rebuildDataset(ds, rows, colTypes(ds).map(c => (c.name === from ? { ...c, name } : c))),
        summary: `Renamed “${from}” to “${name}”.`,
      };
    },
  },

  fill_missing: {
    label: 'Fill missing values',
    runsIn: 'browser',
    run(ds, { column, strategy, value }) {
      const col = requireColumn(ds, column);
      const filled = ds.rows.map(r => r[column]).filter(v => !isEmpty(v));
      let fill: unknown;
      if (strategy === 'mean' || strategy === 'median') {
        if (col.type !== 'numeric') throw new OperationError(`The ${strategy} only works for numeric columns; “${column}” isn’t numeric.`);
        const nums = filled.map(toNumber).filter((n): n is number => n !== null).sort((a, b) => a - b);
        if (nums.length === 0) throw new OperationError(`“${column}” has no numbers to compute a ${strategy} from.`);
        if (strategy === 'mean') {
          fill = round6(nums.reduce((a, b) => a + b, 0) / nums.length);
        } else {
          const mid = Math.floor(nums.length / 2);
          fill = nums.length % 2 ? nums[mid] : (nums[mid - 1] + nums[mid]) / 2;
        }
      } else if (strategy === 'mode') {
        if (filled.length === 0) throw new OperationError(`“${column}” has no values to find the most common one.`);
        const counts = new Map<unknown, number>();
        filled.forEach(v => counts.set(v, (counts.get(v) ?? 0) + 1));
        fill = [...counts.entries()].sort((a, b) => b[1] - a[1])[0][0];
      } else if (strategy === 'zero') {
        if (col.type !== 'numeric') throw new OperationError(`Filling with 0 only works for numeric columns.`);
        fill = 0;
      } else {
        fill = castValue(col.type, value);
        if (fill === null) throw new OperationError(`“${value ?? ''}” isn’t a valid ${col.type} value for “${column}”.`);
      }
      let count = 0;
      const rows = ds.rows.map(r => {
        if (!isEmpty(r[column])) return r;
        count++;
        return { ...r, [column]: fill };
      });
      return {
        dataset: rebuildDataset(ds, rows, colTypes(ds)),
        summary: count === 0
          ? `“${column}” had no missing values.`
          : `Filled ${plural(count, 'missing value')} in “${column}” with ${String(fill)} (${strategy}).`,
      };
    },
  },

  add_column: {
    label: 'Add a column',
    runsIn: 'browser',
    run(ds, { name, type, value }) {
      const clean = requireNewName(ds, name);
      const v = castValue(type, value);
      if (value !== null && value !== '' && v === null) throw new OperationError(`“${value}” isn’t a valid ${type} value.`);
      const rows = ds.rows.map(r => ({ ...r, [clean]: v }));
      return {
        dataset: rebuildDataset(ds, rows, [...colTypes(ds), { name: clean, type }]),
        summary: `Added column “${clean}”.`,
      };
    },
  },

  add_row: {
    label: 'Add an empty row',
    runsIn: 'browser',
    run(ds, { values }) {
      const row: Record<string, any> = {};
      ds.columns.forEach(c => { row[c.name] = null; });
      for (const [k, v] of Object.entries(values ?? {})) {
        const col = ds.columns.find(c => c.name.toLowerCase() === k.toLowerCase());
        if (col) row[col.name] = castValue(col.type, v);
      }
      const rows = [...ds.rows, row];
      return { dataset: rebuildDataset(ds, rows, colTypes(ds)), summary: values && Object.keys(values).length ? `Added a row (row ${rows.length}).` : `Added an empty row (row ${rows.length}).` };
    },
  },

  delete_rows: {
    label: 'Delete rows',
    runsIn: 'browser',
    run(ds, { indices }) {
      const drop = new Set(indices.filter(i => Number.isInteger(i) && i >= 0 && i < ds.rows.length));
      if (drop.size === 0) throw new OperationError('No valid rows were chosen.');
      const rows = ds.rows.filter((_, i) => !drop.has(i));
      return { dataset: rebuildDataset(ds, rows, colTypes(ds)), summary: `Deleted ${plural(drop.size, 'row')}.` };
    },
  },

  filter_rows: {
    label: 'Keep rows that match',
    runsIn: 'browser',
    run(ds, { column, operator, value }) {
      const col = requireColumn(ds, column);
      const target = col.type === 'numeric' ? toNumber(value) : value;
      if ((operator === 'greater_than' || operator === 'less_than') && (col.type !== 'numeric' || target === null)) {
        throw new OperationError('“Greater than” and “less than” need a numeric column and a number.');
      }
      const keep = (v: unknown) => {
        switch (operator) {
          case 'is_empty': return isEmpty(v);
          case 'is_not_empty': return !isEmpty(v);
          case 'equals': return !isEmpty(v) && String(v).toLowerCase() === String(value ?? '').toLowerCase();
          case 'not_equals': return isEmpty(v) || String(v).toLowerCase() !== String(value ?? '').toLowerCase();
          case 'contains': return !isEmpty(v) && String(v).toLowerCase().includes(String(value ?? '').toLowerCase());
          case 'greater_than': { const n = toNumber(v); return n !== null && n > (target as number); }
          case 'less_than': { const n = toNumber(v); return n !== null && n < (target as number); }
        }
      };
      const rows = ds.rows.filter(r => keep(r[column]));
      const removed = ds.rows.length - rows.length;
      return {
        dataset: rebuildDataset(ds, rows, colTypes(ds)),
        summary: `Kept ${plural(rows.length, 'row')}, removed ${plural(removed, 'row')}.`,
      };
    },
  },

  remove_duplicates: {
    label: 'Remove duplicate rows',
    runsIn: 'browser',
    run(ds) {
      const names = ds.columns.map(c => c.name);
      const seen = new Set<string>();
      const rows = ds.rows.filter(r => {
        const key = JSON.stringify(names.map(n => (isEmpty(r[n]) ? null : r[n])));
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });
      const removed = ds.rows.length - rows.length;
      return {
        dataset: rebuildDataset(ds, rows, colTypes(ds)),
        summary: removed === 0 ? 'No duplicate rows found.' : `Removed ${plural(removed, 'duplicate row')}.`,
      };
    },
  },

  derive_column: {
    label: 'Create a calculated column',
    runsIn: 'browser',
    run(ds, { source, transform, other, name }) {
      requireNumeric(ds, source);
      const needsOther = transform === 'multiply' || transform === 'divide';
      if (needsOther) {
        if (!other) throw new OperationError('Choose a second column.');
        requireNumeric(ds, other);
      }
      const defaultName = {
        log: `log_${source}`, sqrt: `sqrt_${source}`, square: `sq_${source}`, minmax: `minmax_${source}`,
        standard: `std_${source}`, multiply: `${source}_x_${other}`, divide: `${source}_div_${other}`,
      }[transform];
      const newName = requireNewName(ds, name?.trim() || defaultName);

      const xs = ds.rows.map(r => toNumber(r[source]));
      const present = xs.filter((n): n is number => n !== null);
      const min = Math.min(...present);
      const max = Math.max(...present);
      const mean = present.reduce((a, b) => a + b, 0) / (present.length || 1);
      const sd = Math.sqrt(present.reduce((a, v) => a + (v - mean) ** 2, 0) / (present.length || 1));

      // A value that can't be computed (missing input, log of a negative,
      // division by zero) is left empty rather than replaced with a made-up 0.
      let skipped = 0;
      const rows = ds.rows.map((r, i) => {
        const x = xs[i];
        const y = needsOther ? toNumber(r[other!]) : null;
        let out: number | null = null;
        if (x !== null) {
          switch (transform) {
            case 'log': out = x > -1 ? Math.log1p(x) : null; break;
            case 'sqrt': out = x >= 0 ? Math.sqrt(x) : null; break;
            case 'square': out = x * x; break;
            case 'minmax': out = max > min ? (x - min) / (max - min) : null; break;
            case 'standard': out = sd > 0 ? (x - mean) / sd : null; break;
            case 'multiply': out = y !== null ? x * y : null; break;
            case 'divide': out = y !== null && y !== 0 ? x / y : null; break;
          }
        }
        if (out === null || !Number.isFinite(out)) { skipped++; out = null; }
        return { ...r, [newName]: out === null ? null : round6(out) };
      });
      return {
        dataset: rebuildDataset(ds, rows, [...colTypes(ds), { name: newName, type: 'numeric' }]),
        summary: `Created “${newName}”.` + (skipped ? ` ${plural(skipped, 'row')} left empty because the value couldn’t be computed.` : ''),
      };
    },
  },

  one_hot_encode: {
    label: 'Split a category into yes/no columns',
    runsIn: 'browser',
    run(ds, { column, prefix }) {
      requireColumn(ds, column);
      const values = [...new Set(ds.rows.map(r => r[column]).filter(v => !isEmpty(v)).map(String))].sort();
      if (values.length === 0) throw new OperationError(`“${column}” has no values to split.`);
      if (values.length > 50) throw new OperationError(`“${column}” has ${values.length} different values; that would add too many columns.`);
      const base = prefix?.trim() || column;
      const used = new Set(ds.columns.map(c => c.name.toLowerCase()));
      const names = values.map(v => {
        let n = `${base}_${v.replace(/[^A-Za-z0-9]+/g, '_')}`;
        let i = 2;
        while (used.has(n.toLowerCase())) n = `${base}_${v.replace(/[^A-Za-z0-9]+/g, '_')}_${i++}`;
        used.add(n.toLowerCase());
        return n;
      });
      const rows = ds.rows.map(r => {
        const copy = { ...r };
        const v = isEmpty(r[column]) ? null : String(r[column]);
        values.forEach((val, i) => { copy[names[i]] = v === null ? null : (v === val ? 1 : 0); });
        return copy;
      });
      return {
        dataset: rebuildDataset(ds, rows, [...colTypes(ds), ...names.map(n => ({ name: n, type: 'numeric' as const }))]),
        summary: `Split “${column}” into ${plural(names.length, 'column')}.`,
      };
    },
  },
};

/** Runs one operation. Throws OperationError with a plain message if it can't. */
export function applyOperation<K extends OperationId>(ds: Dataset, op: K, params: OperationParams[K]): OperationResult {
  const def = OPERATIONS[op] as OperationDef<K>;
  if (!def) throw new OperationError(`Unknown operation “${op}”.`);
  return def.run(ds, params);
}

/** Runs a list of operations in order (a saved workflow). */
export function applyOperations(ds: Dataset, ops: AppliedOperation[]): OperationResult {
  let current = ds;
  const summaries: string[] = [];
  for (const step of ops) {
    const r = applyOperation(current, step.op, step.params as never);
    current = r.dataset;
    summaries.push(r.summary);
  }
  return { dataset: current, summary: summaries.join(' ') };
}
