/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Dataset } from '../types';
import { isIdentifierColumn } from '../utils/csvParser';
import type { CapabilityResult } from './catalog';

const col = (ds: Dataset | null, name: unknown) =>
  typeof name === 'string' ? ds?.columns.find(c => c.name === name || c.name.toLowerCase() === name.toLowerCase())?.name : undefined;

// --- Helpers for the analysis capabilities ------------------------------------

export const mean = (xs: number[]) => { const v = xs.filter(Number.isFinite); return v.length ? v.reduce((a, b) => a + b, 0) / v.length : 0; };
export const rel = (x: number, base: number) => (base ? (x - base) / Math.abs(base) : x);
export const fmtNum = (n: number) => (Math.abs(n) >= 100 ? Math.round(n).toLocaleString() : n.toFixed(2));

/** Columns worth testing against a target: not IDs, not dates, with variation and not too many categories. */
export function screenCandidates(ds: Dataset, target: string, only?: string[]): string[] {
  const pool = only?.length ? only.map(n => col(ds, n)!).filter(Boolean) : ds.columns.map(c => c.name);
  return pool
    .map(n => ds.columns.find(c => c.name === n)!)
    .filter(c => c && c.name !== target && !isIdentifierColumn(c, ds.rowCount) && c.type !== 'datetime' && c.distinctCount > 1 && (c.type === 'numeric' || c.distinctCount <= 30))
    .slice(0, 12)
    .map(c => c.name);
}

/** Informative numeric columns for segmentation (no IDs, no near-constant columns, no outcome-like columns). */
export function clusterColumns(ds: Dataset, only?: string[]): string[] {
  if (only?.length) return only.map(n => col(ds, n)!).filter(n => n && ds.columns.find(c => c.name === n)?.type === 'numeric');
  return ds.columns
    .filter(c => c.type === 'numeric' && c.distinctCount > 5 && !isIdentifierColumn(c, ds.rowCount) && !/(target|label|churn|outcome|fraud|converted|survived)$/i.test(c.name))
    .slice(0, 8)
    .map(c => c.name);
}

/** Deep-analysis findings, with skew fixes proposed only when a model will be trained. */
export function deepEdaResult(body: any, planModel: boolean): CapabilityResult {
  const skewed = (body?.numericSummaries ?? []).filter((s: any) => Math.abs(s.skew) > 2 && s.min >= 0).sort((a: any, b: any) => Math.abs(b.skew) - Math.abs(a.skew));
  const outliers = (body?.outliers ?? []).filter((o: any) => o.outlierCount > 0);
  const strong: string[] = [];
  const m = body?.correlation;
  if (m?.columns) {
    for (let i = 0; i < m.columns.length; i++) for (let j = i + 1; j < m.columns.length; j++) {
      const r = m.matrix[i]?.[j];
      if (typeof r === 'number' && Math.abs(r) >= 0.7) strong.push(`${m.columns[i]}–${m.columns[j]} (r = ${r.toFixed(2)})`);
    }
  }
  const parts = [
    `${Number(body?.rowCount ?? 0).toLocaleString()} rows analysed`,
    skewed.length ? `strongly skewed: ${skewed.slice(0, 3).map((s: any) => `${s.column} (${Number(s.skew).toFixed(1)})`).join(', ')}` : 'no strongly skewed columns',
    outliers.length ? `outliers in ${outliers.length} column${outliers.length === 1 ? '' : 's'}` : 'no IQR outliers',
    strong.length ? `strong correlations: ${strong.slice(0, 3).join(', ')}` : 'no strong correlations',
  ];
  return {
    summary: `${parts.join('; ')}.`,
    data: { rowCount: body?.rowCount, skewed: skewed.map((s: any) => s.column), outlierColumns: outliers.map((o: any) => o.column), strongCorrelations: strong },
    followUps: planModel
      ? skewed.slice(0, 2).map((s: any) => ({ capability: 'data.derive_column', params: { source: s.column, transform: 'log' }, reason: `${s.column} is strongly right-skewed (${Number(s.skew).toFixed(1)}); a log version helps models.` }))
      : [],
  };
}

