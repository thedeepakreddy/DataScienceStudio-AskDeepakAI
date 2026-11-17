/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState } from 'react';
import { AlertTriangle } from 'lucide-react';
import { Dataset } from '../types';
import { apiFetch } from '../utils/api';
import { useLogRun } from '../contexts/WorkspaceContext';
import { isIdentifierColumn } from '../utils/csvParser';
import { formatP } from '../utils/pAdjust';
import Orb from './Orb';

interface Coef {
  term: string; estimate: number | null; se: number | null; statistic: number | null; pValue: number | null;
  ci: (number | null)[]; significant: boolean; oddsRatio?: number | null; oddsRatioCi?: (number | null)[];
}
interface RegressionResult {
  kind: 'linear' | 'logistic'; outcome: string; n: number; alpha: number;
  coefficients: Coef[];
  fit: Record<string, number | null | number[]>;
  assumptions: { name: string; passed: boolean; detail: string }[];
  notes: string[];
}

const fmt = (v: number | null | undefined) =>
  v === null || v === undefined || !Number.isFinite(v) ? '—' : Math.abs(v) >= 1000 ? v.toFixed(0) : Math.abs(v) >= 1 ? v.toFixed(3) : v.toPrecision(3);

/** Linear or logistic regression: how each predictor relates to an outcome, holding the others fixed. */
export default function StatsRegression({ dataset }: { dataset: Dataset }) {
  const logRun = useLogRun();
  const names = dataset.columns.map(c => c.name);
  const [outcome, setOutcome] = useState(dataset.columns.find(c => c.type === 'numeric')?.name ?? names[0] ?? '');
  const [kind, setKind] = useState<'auto' | 'linear' | 'logistic'>('auto');
  const usable = dataset.columns.filter(c => !isIdentifierColumn(c, dataset.rowCount) && c.type !== 'datetime');
  const [predictors, setPredictors] = useState<string[]>(() => usable.filter(c => c.name !== outcome).slice(0, 3).map(c => c.name));
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<RegressionResult | null>(null);

  const outcomeCol = dataset.columns.find(c => c.name === outcome);
  const resolvedKind = kind !== 'auto' ? kind : outcomeCol?.type === 'numeric' && (outcomeCol.distinctCount ?? 3) > 2 ? 'linear' : 'logistic';
  const chosen = predictors.filter(p => p !== outcome && names.includes(p));

  const run = async () => {
    setLoading(true);
    setError(null);
    try {
      const cols = [outcome, ...chosen];
      const res = await apiFetch('/api/stats/regression', {
        method: 'POST',
        body: JSON.stringify({
          data: dataset.rows.map(r => Object.fromEntries(cols.map(c => [c, r[c]]))),
          outcome, predictors: chosen, kind: resolvedKind,
        }),
      });
      const body = await res.json().catch(() => null);
      if (!res.ok || !body) throw new Error(body?.error || `The regression couldn’t run (HTTP ${res.status}).`);
      setResult(body);
      const fitText = body.kind === 'linear' ? `R² ${fmt(body.fit.rSquared)}` : `pseudo R² ${fmt(body.fit.pseudoRSquared)}`;
      logRun({ kind: 'regression', title: `${body.kind === 'linear' ? 'Linear' : 'Logistic'} regression of ${outcome}`, summary: `${fitText} · ${body.n} rows`, status: 'succeeded', params: { outcome, predictors: chosen, kind: resolvedKind }, result: body });
    } catch (err) {
      setResult(null);
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="space-y-6">
      <div className="card p-4 sm:p-5 space-y-4">
        <div>
          <h3 className="card-title" data-agent="area-regression">Regression</h3>
          <p className="mt-1 text-sm text-label-2">
            See how each column relates to an outcome while the others are held fixed. A number outcome uses linear regression;
            a yes/no outcome uses logistic regression. Text columns are compared against their first category.
          </p>
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <div>
            <label className="field-label" htmlFor="reg-outcome">Outcome</label>
            <select id="reg-outcome" data-agent="reg-outcome" className="input" value={outcome} onChange={e => setOutcome(e.target.value)}>
              {names.map(n => <option key={n} value={n}>{n}</option>)}
            </select>
          </div>
          <div>
            <label className="field-label" htmlFor="reg-kind">Model</label>
            <select id="reg-kind" data-agent="reg-kind" className="input" value={kind} onChange={e => setKind(e.target.value as typeof kind)}>
              <option value="auto">Automatic ({resolvedKind})</option>
              <option value="linear">Linear (number outcome)</option>
              <option value="logistic">Logistic (yes/no outcome)</option>
            </select>
          </div>
        </div>
        <fieldset>
          <legend className="field-label">Predictors</legend>
          <div className="flex flex-wrap gap-x-5 gap-y-2">
            {usable.filter(c => c.name !== outcome).map(c => (
              <label key={c.name} className="flex items-center gap-2 text-sm text-label">
                <input
                  type="checkbox"
                  data-agent={`reg-pred-${c.name}`}
                  checked={predictors.includes(c.name)}
                  onChange={e => setPredictors(e.target.checked ? [...predictors, c.name] : predictors.filter(p => p !== c.name))}
                />
                {c.name}
              </label>
            ))}
          </div>
        </fieldset>
        <button type="button" data-agent="reg-run" onClick={run} disabled={loading || chosen.length === 0} aria-busy={loading} className="btn btn-primary">
          {loading ? <><Orb state="solving" onAccent label="Fitting the model" /> Fitting…</> : 'Run Regression'}
        </button>
        {error && (
          <p role="alert" className="flex items-start gap-2 rounded-xl bg-red/10 px-3 py-2.5 text-sm text-red">
            <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" /> {error}
          </p>
        )}
      </div>

      {result && (
        <div className="card p-4 sm:p-5 space-y-5 animate-fade-in" role="region" aria-label="Regression result">
          <dl className="grid grid-cols-2 lg:grid-cols-4 gap-px bg-separator rounded-xl overflow-hidden">
            {(result.kind === 'linear'
              ? [['R²', fmt(result.fit.rSquared as number)], ['Adjusted R²', fmt(result.fit.adjRSquared as number)], ['Model p-value (F test)', formatP(result.fit.fPValue as number)], ['Rows', result.n.toLocaleString()]]
              : [['Pseudo R² (McFadden)', fmt(result.fit.pseudoRSquared as number)], ['Model p-value (LR test)', formatP(result.fit.lrPValue as number)], ['Accuracy at 0.5', `${((result.fit.accuracy as number) * 100).toFixed(1)}%`], ['Always guessing the common answer', `${((result.fit.baseRate as number) * 100).toFixed(1)}%`]]
            ).map(([k, v]) => (
              <div key={k} className="bg-surface px-4 py-3">
                <dt className="text-xs text-label-2">{k}</dt>
                <dd className="mt-0.5 text-[17px] font-semibold tabular-nums text-label">{v}</dd>
              </div>
            ))}
          </dl>
          <div className="overflow-x-auto">
            <table className="w-full text-sm tabular-nums">
              <thead>
                <tr className="text-left text-xs text-label-2">
                  {['Term', 'Estimate', `${Math.round((1 - result.alpha) * 100)}% CI`, ...(result.kind === 'logistic' ? ['Odds ratio'] : []), 'p-value'].map(h => <th key={h} className="py-1.5 pr-4 font-medium">{h}</th>)}
                </tr>
              </thead>
              <tbody className="divide-y divide-separator">
                {result.coefficients.map(c => (
                  <tr key={c.term}>
                    <td className="py-1.5 pr-4 text-label">{c.term}</td>
                    <td className="py-1.5 pr-4 text-label-2">{fmt(c.estimate)}</td>
                    <td className="py-1.5 pr-4 text-label-2">{fmt(c.ci[0])} to {fmt(c.ci[1])}</td>
                    {result.kind === 'logistic' && <td className="py-1.5 pr-4 text-label-2">{c.term === '(Intercept)' ? '—' : fmt(c.oddsRatio)}</td>}
                    <td className={`py-1.5 ${c.significant && c.term !== '(Intercept)' ? 'text-green font-medium' : 'text-label-2'}`}>{formatP(c.pValue)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="text-xs text-label-2 leading-relaxed">
            {result.kind === 'linear'
              ? `Each estimate is how much ${result.outcome} changes for one unit more of that column, with the others held fixed.`
              : `An odds ratio above 1 means higher odds of the outcome; below 1, lower odds — with the other columns held fixed.`}
            {' '}Green p-values are significant at {result.alpha}. Relationships here are associations, not proof of cause.
          </p>
          {[...result.notes, ...result.assumptions.map(a => `${a.name}: ${a.detail}`)].map(n => (
            <p key={n} className="text-xs text-label-3">{n}</p>
          ))}
        </div>
      )}
    </div>
  );
}
