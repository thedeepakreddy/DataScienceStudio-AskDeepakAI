/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { isEmpty } from './columnProfile';

// KPI formulas such as  SUM(revenue) / COUNT()  or  AVG([Monthly Charges]) * 12.
// A tiny parser of its own (numbers, + - * /, brackets and a fixed list of
// aggregate functions), so a formula can never run arbitrary code.

export const KPI_FUNCTIONS = ['SUM', 'AVG', 'MIN', 'MAX', 'MEDIAN', 'COUNT', 'COUNT_DISTINCT'] as const;
type Fn = typeof KPI_FUNCTIONS[number];

type Node =
  | { kind: 'num'; value: number }
  | { kind: 'neg'; arg: Node }
  | { kind: 'bin'; op: '+' | '-' | '*' | '/'; left: Node; right: Node }
  | { kind: 'agg'; fn: Fn; column: string | null };

export class FormulaError extends Error {}

type Token = { t: 'num'; v: number } | { t: 'id'; v: string } | { t: 'col'; v: string } | { t: 'op'; v: string };

function tokenize(src: string): Token[] {
  const out: Token[] = [];
  let i = 0;
  while (i < src.length) {
    const ch = src[i];
    if (/\s/.test(ch)) { i++; continue; }
    if (/[0-9.]/.test(ch)) {
      const m = src.slice(i).match(/^\d*\.?\d+(e[+-]?\d+)?/i);
      if (!m) throw new FormulaError(`Unexpected “${ch}”.`);
      out.push({ t: 'num', v: Number(m[0]) });
      i += m[0].length;
    } else if (/[A-Za-z_]/.test(ch)) {
      const m = src.slice(i).match(/^[A-Za-z_][A-Za-z0-9_.]*/)!;
      out.push({ t: 'id', v: m[0] });
      i += m[0].length;
    } else if (ch === '[' || ch === '"') {
      const close = ch === '[' ? ']' : '"';
      const end = src.indexOf(close, i + 1);
      if (end === -1) throw new FormulaError(`A column name starting with ${ch} is never closed.`);
      out.push({ t: 'col', v: src.slice(i + 1, end) });
      i = end + 1;
    } else if ('+-*/(),'.includes(ch)) {
      out.push({ t: 'op', v: ch });
      i++;
    } else {
      throw new FormulaError(`“${ch}” can’t be used in a formula.`);
    }
  }
  return out;
}

export function parseFormula(src: string): Node {
  const tokens = tokenize(src);
  let pos = 0;
  const peek = () => tokens[pos];
  const isOp = (v: string) => peek()?.t === 'op' && peek()!.v === v;
  const expect = (v: string) => {
    if (!isOp(v)) throw new FormulaError(`Expected “${v}”.`);
    pos++;
  };

  const expr = (): Node => {
    let left = term();
    while (isOp('+') || isOp('-')) {
      const op = (tokens[pos++] as { v: '+' | '-' }).v;
      left = { kind: 'bin', op, left, right: term() };
    }
    return left;
  };
  const term = (): Node => {
    let left = factor();
    while (isOp('*') || isOp('/')) {
      const op = (tokens[pos++] as { v: '*' | '/' }).v;
      left = { kind: 'bin', op, left, right: factor() };
    }
    return left;
  };
  const factor = (): Node => {
    const tok = peek();
    if (!tok) throw new FormulaError('The formula ends too early.');
    if (tok.t === 'num') { pos++; return { kind: 'num', value: tok.v }; }
    if (tok.t === 'op' && tok.v === '-') { pos++; return { kind: 'neg', arg: factor() }; }
    if (tok.t === 'op' && tok.v === '(') { pos++; const e = expr(); expect(')'); return e; }
    if (tok.t === 'id') {
      const fn = tok.v.toUpperCase() === 'MEAN' ? 'AVG' : tok.v.toUpperCase();
      if (!(KPI_FUNCTIONS as readonly string[]).includes(fn)) {
        throw new FormulaError(`“${tok.v}” isn’t a function. Use ${KPI_FUNCTIONS.join(', ')}.`);
      }
      pos++;
      expect('(');
      let column: string | null = null;
      const arg = peek();
      if (arg && (arg.t === 'id' || arg.t === 'col')) { column = arg.v; pos++; }
      expect(')');
      if (column === null && fn !== 'COUNT') throw new FormulaError(`${fn} needs a column, e.g. ${fn}(price).`);
      return { kind: 'agg', fn: fn as Fn, column };
    }
    throw new FormulaError(`Unexpected “${tok.v}”.`);
  };

  const tree = expr();
  if (pos < tokens.length) throw new FormulaError(`Unexpected “${String(tokens[pos].v)}”.`);
  return tree;
}

/** Column names the formula uses. */
export function formulaColumns(node: Node): string[] {
  switch (node.kind) {
    case 'num': return [];
    case 'neg': return formulaColumns(node.arg);
    case 'bin': return [...formulaColumns(node.left), ...formulaColumns(node.right)];
    case 'agg': return node.column ? [node.column] : [];
  }
}

function aggregate(fn: Fn, column: string | null, rows: Record<string, any>[]): number | null {
  if (column === null) return rows.length;
  const values = rows.map(r => r[column]).filter(v => !isEmpty(v));
  if (fn === 'COUNT') return values.length;
  if (fn === 'COUNT_DISTINCT') return new Set(values.map(String)).size;
  const nums = values.map(Number).filter(Number.isFinite);
  if (nums.length === 0) return null;
  switch (fn) {
    case 'SUM': return nums.reduce((a, b) => a + b, 0);
    case 'AVG': return nums.reduce((a, b) => a + b, 0) / nums.length;
    case 'MIN': return Math.min(...nums);
    case 'MAX': return Math.max(...nums);
    case 'MEDIAN': {
      const s = [...nums].sort((a, b) => a - b);
      const m = Math.floor(s.length / 2);
      return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
    }
  }
}

/** The value of a formula over rows; null when it can't be computed (e.g. division by zero). */
export function evaluateFormula(node: Node, rows: Record<string, any>[]): number | null {
  switch (node.kind) {
    case 'num': return node.value;
    case 'neg': { const v = evaluateFormula(node.arg, rows); return v === null ? null : -v; }
    case 'agg': return aggregate(node.fn, node.column, rows);
    case 'bin': {
      const a = evaluateFormula(node.left, rows);
      const b = evaluateFormula(node.right, rows);
      if (a === null || b === null) return null;
      if (node.op === '/') return b === 0 ? null : a / b;
      return node.op === '+' ? a + b : node.op === '-' ? a - b : a * b;
    }
  }
}

/** Parses and checks a formula against the dataset's columns. Throws FormulaError. */
export function checkFormula(src: string, columns: string[]): Node {
  if (!src.trim()) throw new FormulaError('Enter a formula.');
  const tree = parseFormula(src);
  const missing = formulaColumns(tree).filter(c => !columns.includes(c));
  if (missing.length) throw new FormulaError(`There is no column called “${missing[0]}”. Put names with spaces in [square brackets].`);
  return tree;
}

export type KpiFormat = 'number' | 'percent' | 'currency';

export interface KpiDefinition {
  id: string;
  name: string;
  formula: string;
  format: KpiFormat;
}

export function formatKpi(value: number | null, format: KpiFormat): string {
  if (value === null || !Number.isFinite(value)) return '—';
  if (format === 'percent') return `${(value * 100).toLocaleString(undefined, { maximumFractionDigits: 1 })}%`;
  if (format === 'currency') return value.toLocaleString(undefined, { maximumFractionDigits: 2, minimumFractionDigits: 2 });
  return value.toLocaleString(undefined, { maximumFractionDigits: 2 });
}
