/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React from 'react';
import type { Dataset } from '../../types';
import type { CapabilityName } from '../../engine/client';

// ------------------------------------------------------------------ specs
export type ColumnFilter = 'numeric' | 'categorical' | 'binary' | 'date' | 'group' | 'any';

/** `when`: show (and require) the field only when it returns true for the current values. */
export type Field = FieldSpec & { when?: (v: Values) => boolean };
type FieldSpec =
  | { key: string; label: string; kind: 'column'; filter: ColumnFilter; optional?: boolean; help?: string }
  | { key: string; label: string; kind: 'columns'; filter: ColumnFilter; min?: number; max?: number; help?: string }
  | { key: string; label: string; kind: 'select'; options: { value: string; label: string }[]; default: string; help?: string }
  | { key: string; label: string; kind: 'number'; default?: number; min?: number; max?: number; step?: number; optional?: boolean; help?: string; percent?: boolean }
  | { key: string; label: string; kind: 'toggle'; default: boolean; help?: string }
  | { key: string; label: string; kind: 'text'; placeholder?: string; optional?: boolean; default?: string; help?: string; secret?: boolean; multiline?: boolean }
  | { key: string; label: string; kind: 'arms'; help?: string }
  /** A bespoke editor (e.g. a table of variables); `check` returns a problem to show, or null. */
  | { key: string; label: string; kind: 'custom'; initial: () => any; editor: React.FC<{ value: any; onChange: (v: any) => void; id: string; dataset?: Dataset }>; check?: (v: any) => string | null; help?: string };

export type Values = Record<string, any>;

export interface Method {
  id: string;
  title: string;
  /** The question it answers, in plain words. */
  answers: string;
  cap: CapabilityName;
  fields: Field[];
  /** Turns form values into the capability's parameters (defaults: values as they are). */
  params?: (v: Values) => Record<string, unknown>;
  /** One plain-language sentence leading the result. */
  headline: (r: any, v: Values) => string;
  /** Green when the finding is clear, orange when it needs care, plain otherwise. */
  tone?: (r: any, v: Values) => 'good' | 'warn' | 'plain';
  render: (r: any, v: Values) => React.ReactNode;
  /** A check of the form's values beyond “required fields are filled” (a problem to show, or null). */
  check?: (v: Values) => string | null;
  /** Whether the dataset can support this method at all (else it's hidden). */
  available?: (d: Dataset) => boolean;
}

export interface GuideStep {
  question: string;
  options: { label: string; method?: string; next?: GuideStep }[];
}

// ------------------------------------------------------------------ columns
export function columnsFor(dataset: Dataset, filter: ColumnFilter): string[] {
  return dataset.columns.filter(c => {
    switch (filter) {
      case 'numeric': return c.type === 'numeric';
      case 'categorical': return c.type === 'categorical' || c.type === 'boolean' || (c.type === 'numeric' && c.distinctCount <= 12);
      case 'binary': return c.distinctCount === 2;
      // Grouping keys: categories, or ids stored as numbers (repeated across rows).
      case 'group': return c.type !== 'datetime' && c.distinctCount >= 2 && c.distinctCount <= Math.max(2, dataset.rowCount / 2);
      case 'date': return c.type === 'datetime' || (c.type === 'numeric' && c.distinctCount > 2 && c.distinctCount <= 400) || /date|time|period|week|month|year/i.test(c.name);
      default: return true;
    }
  }).map(c => c.name);
}

// ------------------------------------------------------------------ formatting
export function num(v: unknown, digits = 3): string {
  if (v === null || v === undefined || typeof v !== 'number' || !Number.isFinite(v)) return '—';
  const a = Math.abs(v);
  if (a !== 0 && (a < 1e-3 || a >= 1e6)) return v.toExponential(2);
  return Number(v.toPrecision(digits)).toLocaleString(undefined, { maximumFractionDigits: 6 });
}
export const pValue = (p: unknown) => typeof p !== 'number' ? '—' : p < 0.001 ? '< 0.001' : p.toFixed(3);
export const pct = (v: unknown, digits = 0) => typeof v === 'number' ? `${(v * 100).toFixed(digits)}%` : '—';
export const signed = (v: number, digits = 3) => `${v >= 0 ? '+' : ''}${num(v, digits)}`;
export const ciText = (ci?: unknown[], digits = 3) => Array.isArray(ci) && ci.length === 2 ? `95% CI ${num(ci[0], digits)} to ${num(ci[1], digits)}` : '';
export const sig = (p: unknown, alpha = 0.05) => typeof p === 'number' && p < alpha;

// ------------------------------------------------------------------ building blocks
export function StatGrid({ items }: { items: [string, React.ReactNode][] }) {
  return (
    <dl className="grid grid-cols-2 lg:grid-cols-4 gap-px bg-separator rounded-xl overflow-hidden">
      {items.map(([k, v]) => (
        <div key={k} className="bg-surface px-4 py-3">
          <dt className="text-xs text-label-2">{k}</dt>
          <dd className="mt-0.5 text-[17px] font-semibold tabular-nums text-label">{v}</dd>
        </div>
      ))}
    </dl>
  );
}

export function Note({ children, tone = 'plain' }: { children: React.ReactNode; tone?: 'plain' | 'warn' }) {
  return <p className={`rounded-xl px-3 py-2 text-sm ${tone === 'warn' ? 'bg-orange/10 text-orange' : 'bg-fill text-label-2'}`}>{children}</p>;
}

/** Estimates with confidence intervals, drawn as a small forest plot next to the numbers. */
export function EffectTable({ rows, valueLabel = 'Estimate', zero = 0, log = false }: {
  rows: { term: string; value: number; ci?: [number, number]; p?: number; extra?: React.ReactNode }[];
  valueLabel?: string; zero?: number; log?: boolean;
}) {
  const t = (x: number) => (log ? Math.log(Math.max(x, 1e-9)) : x);
  const finite = rows.flatMap(r => [r.value, ...(r.ci ?? [])]).filter(Number.isFinite).map(t);
  const lo = Math.min(t(zero), ...finite), hi = Math.max(t(zero), ...finite);
  const span = hi - lo || 1;
  const x = (v: number) => `${((t(v) - lo) / span) * 100}%`;
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm tabular-nums">
        <thead>
          <tr className="text-left text-xs text-label-2">
            <th className="py-1.5 pr-4 font-medium">Term</th><th className="py-1.5 pr-4 font-medium">{valueLabel}</th>
            <th className="py-1.5 pr-4 font-medium">95% CI</th><th className="py-1.5 pr-4 font-medium">p</th>
            <th className="py-1.5 font-medium w-[30%] min-w-[120px]" aria-label="Interval plot" />
          </tr>
        </thead>
        <tbody className="divide-y divide-separator">
          {rows.map(r => (
            <tr key={r.term}>
              <td className="py-1.5 pr-4 text-label max-w-[14rem] truncate" title={r.term}>{r.term}</td>
              <td className={`py-1.5 pr-4 font-medium ${sig(r.p) ? 'text-label' : 'text-label-2'}`}>{num(r.value)}</td>
              <td className="py-1.5 pr-4 text-label-2 whitespace-nowrap">{r.ci ? `${num(r.ci[0])} – ${num(r.ci[1])}` : '—'}</td>
              <td className={`py-1.5 pr-4 ${sig(r.p) ? 'text-green font-medium' : 'text-label-2'}`}>{r.p === undefined ? '—' : pValue(r.p)}</td>
              <td className="py-1.5">
                <div className="relative h-4" aria-hidden>
                  <div className="absolute top-0 bottom-0 w-px bg-separator" style={{ left: x(zero) }} />
                  {r.ci && Number.isFinite(r.ci[0]) && Number.isFinite(r.ci[1]) && (
                    <div className={`absolute top-1/2 h-0.5 -translate-y-1/2 ${sig(r.p) ? 'bg-blue' : 'bg-label-3'}`} style={{ left: x(Math.min(...r.ci)), width: `calc(${x(Math.max(...r.ci))} - ${x(Math.min(...r.ci))})` }} />
                  )}
                  {Number.isFinite(r.value) && <div className={`absolute top-1/2 w-2 h-2 -ml-1 -translate-y-1/2 rounded-full ${sig(r.p) ? 'bg-blue' : 'bg-label-3'}`} style={{ left: x(r.value) }} />}
                </div>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** A plain table for rows of results; numbers formatted, at most `limit` rows. */
export function DataTable({ rows, columns, limit = 20 }: { rows: Record<string, any>[]; columns: { key: string; label: string; format?: (v: any, row: any) => React.ReactNode }[]; limit?: number }) {
  if (!rows?.length) return null;
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm tabular-nums">
        <thead><tr className="text-left text-xs text-label-2">{columns.map(c => <th key={c.key} className="py-1.5 pr-4 font-medium whitespace-nowrap">{c.label}</th>)}</tr></thead>
        <tbody className="divide-y divide-separator">
          {rows.slice(0, limit).map((row, i) => (
            <tr key={i}>{columns.map(c => <td key={c.key} className="py-1.5 pr-4 text-label whitespace-nowrap">{c.format ? c.format(row[c.key], row) : typeof row[c.key] === 'number' ? num(row[c.key]) : String(row[c.key] ?? '—')}</td>)}</tr>
          ))}
        </tbody>
      </table>
      {rows.length > limit && <p className="mt-1 text-xs text-label-3">Showing {limit} of {rows.length}.</p>}
    </div>
  );
}

export const Section: React.FC<{ title: string; children?: React.ReactNode }> = ({ title, children }) => (
  <div className="space-y-2"><h4 className="text-sm font-semibold text-label">{title}</h4>{children}</div>
);
