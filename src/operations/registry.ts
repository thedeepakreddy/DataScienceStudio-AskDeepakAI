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
  standardize_text: { column: string; trim?: boolean; collapseSpaces?: boolean; case?: 'none' | 'lower' | 'upper' | 'title' };
  replace_values: { column: string; from: string; to: string; matchCase?: boolean };
  convert_type: { column: string; to: ColumnType };
  join: { right: TableInput; leftKey: string; rightKey: string; how: 'left' | 'inner' };
  append_rows: { right: TableInput };
  group_aggregate: { by: string[]; aggregations: { column: string; fn: AggregateFn }[] };
  pivot: { index: string; columns: string; values: string; fn: AggregateFn };
}

export type AggregateFn = 'count' | 'count_distinct' | 'sum' | 'mean' | 'median' | 'min' | 'max';

/** A second table for join/append. `versionId` is kept for provenance; rows may be dropped when recorded. */
export interface TableInput {
  name: string;
  versionId?: string;
  rows?: Record<string, any>[];
  columns?: { name: string; type: ColumnType }[];
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

type MoreId = 'standardize_text' | 'replace_values' | 'convert_type' | 'join' | 'append_rows' | 'group_aggregate' | 'pivot';

const BASE_OPERATIONS: { [K in Exclude<OperationId, MoreId>]: OperationDef<K> } = {
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

// --- Helpers for the reshaping operations ------------------------------------

function parseNumberLoose(v: unknown): number | null {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (isEmpty(v) || typeof v === 'boolean') return null;
  let str = String(v).trim();
  const negative = /^\(.*\)$/.test(str); // accounting negatives: (1,200)
  str = str.replace(/^\(|\)$/g, '').replace(/[\s$€£¥₹%]/g, '');
  // "1.234,5" (European) vs "1,234.5". A lone comma followed by exactly three
  // digits ("1,200") is a thousands separator; with one, two or four+ digits
  // ("3,5", "0,25") it is a decimal comma.
  if (/^-?\d{1,3}(\.\d{3})+(,\d+)?$/.test(str)) str = str.replace(/\./g, '').replace(',', '.');
  else if (/^-?\d+,(\d{1,2}|\d{4,})$/.test(str)) str = str.replace(',', '.');
  else str = str.replace(/,/g, '');
  const n = Number(str);
  return str !== '' && Number.isFinite(n) ? (negative ? -n : n) : null;
}

function aggregate(values: unknown[], fn: AggregateFn): number | null {
  if (fn === 'count') return values.filter(v => !isEmpty(v)).length;
  if (fn === 'count_distinct') return new Set(values.filter(v => !isEmpty(v)).map(String)).size;
  const nums = values.map(toNumber).filter((n): n is number => n !== null);
  if (nums.length === 0) return null;
  switch (fn) {
    case 'sum': return round6(nums.reduce((a, b) => a + b, 0));
    case 'mean': return round6(nums.reduce((a, b) => a + b, 0) / nums.length);
    case 'min': return Math.min(...nums);
    case 'max': return Math.max(...nums);
    case 'median': {
      const s = [...nums].sort((a, b) => a - b);
      const m = Math.floor(s.length / 2);
      return s.length % 2 ? s[m] : round6((s[m - 1] + s[m]) / 2);
    }
  }
}

function requireTable(t: TableInput): { rows: Record<string, any>[]; columns: { name: string; type: ColumnType }[] } {
  if (!t?.rows || !t.columns) throw new OperationError('The second table isn’t loaded. Choose its file again.');
  return { rows: t.rows, columns: t.columns };
}

const keyOf = (v: unknown) => (isEmpty(v) ? null : String(v).trim().toLowerCase());

const MORE_OPERATIONS: { [K in MoreId]: OperationDef<K> } = {
  standardize_text: {
    label: 'Tidy up text',
    runsIn: 'browser',
    run(ds, { column, trim = true, collapseSpaces = true, case: mode = 'none' }) {
      const col = requireColumn(ds, column);
      if (col.type === 'numeric' || col.type === 'boolean') throw new OperationError(`“${column}” isn’t a text column.`);
      let changed = 0;
      const rows = ds.rows.map(r => {
        const v = r[column];
        if (isEmpty(v)) return r;
        let s2 = String(v);
        if (trim) s2 = s2.trim();
        if (collapseSpaces) s2 = s2.replace(/\s+/g, ' ');
        if (mode === 'lower') s2 = s2.toLowerCase();
        else if (mode === 'upper') s2 = s2.toUpperCase();
        else if (mode === 'title') s2 = s2.toLowerCase().replace(/(^|[\s\-_/])(\p{L})/gu, (_, a, b) => a + b.toUpperCase());
        const out = s2 === '' ? null : s2;
        if (out === v) return r;
        changed++;
        return { ...r, [column]: out };
      });
      const before = col.distinctCount;
      const dataset = rebuildDataset(ds, rows, colTypes(ds));
      const after = dataset.columns.find(c => c.name === column)!.distinctCount;
      return {
        dataset,
        summary: changed === 0
          ? `“${column}” was already tidy.`
          : `Tidied ${plural(changed, 'value')} in “${column}”` + (after < before ? `; ${before} different values became ${after}.` : '.'),
      };
    },
  },

  replace_values: {
    label: 'Replace values',
    runsIn: 'browser',
    run(ds, { column, from, to, matchCase = false }) {
      const col = requireColumn(ds, column);
      const same = (v: unknown) => !isEmpty(v) && (matchCase ? String(v) === from : String(v).toLowerCase() === from.toLowerCase());
      const replacement = to === '' ? null : castValue(col.type, to);
      if (to !== '' && replacement === null) throw new OperationError(`“${to}” isn’t a valid ${col.type} value for “${column}”.`);
      let changed = 0;
      const rows = ds.rows.map(r => {
        if (!same(r[column])) return r;
        changed++;
        return { ...r, [column]: replacement };
      });
      return {
        dataset: rebuildDataset(ds, rows, colTypes(ds)),
        summary: changed === 0
          ? `No “${from}” values found in “${column}”.`
          : `Replaced ${plural(changed, 'value')} “${from}” with ${to === '' ? 'empty' : `“${to}”`} in “${column}”.`,
      };
    },
  },

  convert_type: {
    label: 'Change a column’s type',
    runsIn: 'browser',
    run(ds, { column, to }) {
      const col = requireColumn(ds, column);
      if (col.type === to) throw new OperationError(`“${column}” is already ${to}.`);
      let failed = 0;
      const rows = ds.rows.map(r => {
        const v = r[column];
        if (isEmpty(v)) return { ...r, [column]: null };
        let out: unknown;
        if (to === 'numeric') out = parseNumberLoose(v);
        else if (to === 'boolean') out = castValue('boolean', v);
        else if (to === 'datetime') {
          const t = typeof v === 'number' ? NaN : Date.parse(String(v));
          out = Number.isNaN(t) ? null : new Date(t).toISOString();
        } else out = String(v);
        if (out === null) failed++;
        return { ...r, [column]: out };
      });
      return {
        dataset: rebuildDataset(ds, rows, colTypes(ds).map(c => (c.name === column ? { ...c, type: to } : c))),
        summary: `Changed “${column}” to ${to}.` + (failed ? ` ${plural(failed, 'value')} couldn’t be converted and ${failed === 1 ? 'is' : 'are'} now empty.` : ''),
      };
    },
  },

  join: {
    label: 'Join another table',
    runsIn: 'browser',
    run(ds, { right, leftKey, rightKey, how }) {
      requireColumn(ds, leftKey);
      const r = requireTable(right);
      if (!r.columns.some(c => c.name === rightKey)) throw new OperationError(`“${right.name}” has no column “${rightKey}”.`);
      const index = new Map<string, Record<string, any>[]>();
      r.rows.forEach(row => {
        const k = keyOf(row[rightKey]);
        if (k === null) return;
        index.set(k, [...(index.get(k) ?? []), row]);
      });
      // Right-hand columns keep their names unless they clash with the left table.
      const leftNames = new Set(ds.columns.map(c => c.name.toLowerCase()));
      const rightCols = r.columns.filter(c => c.name !== rightKey).map(c => {
        let name = c.name;
        let i = 2;
        if (leftNames.has(name.toLowerCase())) {
          name = `${c.name}_${right.name.replace(/\.[^.]+$/, '').replace(/[^A-Za-z0-9]+/g, '_')}`;
          while (leftNames.has(name.toLowerCase())) name = `${c.name}_${i++}`;
        }
        leftNames.add(name.toLowerCase());
        return { from: c.name, name, type: c.type };
      });
      let matched = 0;
      const rows: Record<string, any>[] = [];
      ds.rows.forEach(left => {
        const k = keyOf(left[leftKey]);
        const hits = k === null ? undefined : index.get(k);
        if (hits) {
          matched++;
          hits.forEach(h => {
            const row = { ...left };
            rightCols.forEach(c => { row[c.name] = h[c.from] ?? null; });
            rows.push(row);
          });
        } else if (how === 'left') {
          const row = { ...left };
          rightCols.forEach(c => { row[c.name] = null; });
          rows.push(row);
        }
      });
      return {
        dataset: rebuildDataset(ds, rows, [...colTypes(ds), ...rightCols.map(c => ({ name: c.name, type: c.type }))]),
        summary: `Joined “${right.name}”: ${plural(matched, 'row')} of ${ds.rows.length.toLocaleString()} matched, giving ${plural(rows.length, 'row')} and ${plural(rightCols.length, 'new column')}.`,
      };
    },
  },

  append_rows: {
    label: 'Add rows from another table',
    runsIn: 'browser',
    run(ds, { right }) {
      const r = requireTable(right);
      const leftNames = ds.columns.map(c => c.name);
      const lower = new Map(leftNames.map(n => [n.toLowerCase(), n]));
      const extra = r.columns.filter(c => !lower.has(c.name.toLowerCase()));
      const missing = leftNames.filter(n => !r.columns.some(c => c.name.toLowerCase() === n.toLowerCase()));
      const types = new Map(ds.columns.map(c => [c.name, c.type]));
      const added = r.rows.map(row => {
        const out: Record<string, any> = {};
        leftNames.forEach(n => { out[n] = null; });
        extra.forEach(c => { out[c.name] = null; });
        for (const [k, v] of Object.entries(row)) {
          const target = lower.get(k.toLowerCase()) ?? k;
          out[target] = castValue(types.get(target) ?? r.columns.find(c => c.name === k)?.type ?? 'categorical', v);
        }
        return out;
      });
      const rows = [...ds.rows.map(row => {
        if (extra.length === 0) return row;
        const copy = { ...row };
        extra.forEach(c => { copy[c.name] = null; });
        return copy;
      }), ...added];
      const notes = [
        extra.length ? `${plural(extra.length, 'new column')} added` : '',
        missing.length ? `${plural(missing.length, 'column')} missing from “${right.name}” left empty for its rows` : '',
      ].filter(Boolean).join('; ');
      return {
        dataset: rebuildDataset(ds, rows, [...colTypes(ds), ...extra.map(c => ({ name: c.name, type: c.type }))]),
        summary: `Added ${plural(added.length, 'row')} from “${right.name}”.` + (notes ? ` ${notes}.` : ''),
      };
    },
  },

  group_aggregate: {
    label: 'Summarise by group',
    runsIn: 'browser',
    run(ds, { by, aggregations }) {
      if (by.length === 0) throw new OperationError('Choose at least one column to group by.');
      if (aggregations.length === 0) throw new OperationError('Add at least one summary.');
      by.forEach(b => requireColumn(ds, b));
      aggregations.forEach(a => {
        const col = requireColumn(ds, a.column);
        if (!['count', 'count_distinct'].includes(a.fn) && col.type !== 'numeric') {
          throw new OperationError(`A ${a.fn} needs a numeric column; “${a.column}” isn’t numeric.`);
        }
      });
      const groups = new Map<string, { keys: unknown[]; rows: Record<string, any>[] }>();
      ds.rows.forEach(r => {
        const keys = by.map(b => (isEmpty(r[b]) ? null : r[b]));
        const id = JSON.stringify(keys);
        if (!groups.has(id)) groups.set(id, { keys, rows: [] });
        groups.get(id)!.rows.push(r);
      });
      const outNames = aggregations.map(a => `${a.fn}_${a.column}`);
      const rows = [...groups.values()].map(g => {
        const row: Record<string, any> = {};
        by.forEach((b, i) => { row[b] = g.keys[i]; });
        aggregations.forEach((a, i) => { row[outNames[i]] = aggregate(g.rows.map(r => r[a.column]), a.fn); });
        return row;
      });
      const byTypes = by.map(b => ({ name: b, type: ds.columns.find(c => c.name === b)!.type }));
      return {
        dataset: { ...rebuildDataset(ds, rows, [...byTypes, ...outNames.map(n => ({ name: n, type: 'numeric' as const }))]), filename: `${ds.filename} (summary)` },
        summary: `Summarised ${plural(ds.rows.length, 'row')} into ${plural(rows.length, 'group')}.`,
      };
    },
  },

  pivot: {
    label: 'Pivot',
    runsIn: 'browser',
    run(ds, { index, columns, values, fn }) {
      requireColumn(ds, index);
      requireColumn(ds, columns);
      const valCol = requireColumn(ds, values);
      if (!['count', 'count_distinct'].includes(fn) && valCol.type !== 'numeric') {
        throw new OperationError(`A ${fn} needs a numeric column; “${values}” isn’t numeric.`);
      }
      const colValues = [...new Set(ds.rows.map(r => r[columns]).filter(v => !isEmpty(v)).map(String))].sort();
      if (colValues.length === 0) throw new OperationError(`“${columns}” has no values to make columns from.`);
      if (colValues.length > 100) throw new OperationError(`“${columns}” has ${colValues.length} different values; pivoting would create too many columns.`);
      const names = uniqueNames([index, ...colValues]).slice(1);
      const cells = new Map<string, Map<string, unknown[]>>();
      const order: { key: string; value: unknown }[] = [];
      ds.rows.forEach(r => {
        const k = isEmpty(r[index]) ? null : r[index];
        const id = JSON.stringify(k);
        if (!cells.has(id)) { cells.set(id, new Map()); order.push({ key: id, value: k }); }
        const c = r[columns];
        if (isEmpty(c)) return;
        const m = cells.get(id)!;
        m.set(String(c), [...(m.get(String(c)) ?? []), r[values]]);
      });
      const rows = order.map(({ key, value }) => {
        const row: Record<string, any> = { [index]: value };
        colValues.forEach((cv, i) => {
          const vs = cells.get(key)!.get(cv);
          row[names[i]] = vs ? aggregate(vs, fn) : null;
        });
        return row;
      });
      const indexType = ds.columns.find(c => c.name === index)!.type;
      return {
        dataset: { ...rebuildDataset(ds, rows, [{ name: index, type: indexType }, ...names.map(n => ({ name: n, type: 'numeric' as const }))]), filename: `${ds.filename} (pivot)` },
        summary: `Pivoted into ${plural(rows.length, 'row')} × ${plural(colValues.length, 'value column')} (${fn} of “${values}”).`,
      };
    },
  },
};

function uniqueNames(names: string[]): string[] {
  const used = new Set<string>();
  return names.map(n => {
    let name = n.trim() || 'column';
    let i = 2;
    while (used.has(name.toLowerCase())) name = `${n}_${i++}`;
    used.add(name.toLowerCase());
    return name;
  });
}

export const OPERATIONS: { [K in OperationId]: OperationDef<K> } = { ...BASE_OPERATIONS, ...MORE_OPERATIONS };

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
