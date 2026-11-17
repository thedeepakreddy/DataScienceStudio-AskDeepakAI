/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState } from 'react';
import { AlertTriangle, CheckCircle2, MinusCircle, XCircle } from 'lucide-react';
import { Dataset } from '../types';
import { apiFetch } from '../utils/api';
import { useLogRun } from '../contexts/WorkspaceContext';
import { ADJUST_LABELS, AdjustMethod, adjustPValues, formatP } from '../utils/pAdjust';
import Orb from './Orb';

interface Assumption { name: string; passed: boolean | null; detail: string; pValue?: number }
interface CompareResult {
  test: string;
  family: string;
  statistic: number | null;
  statisticName: string;
  df: number | number[] | null;
  pValue: number | null;
  significant: boolean;
  alpha: number;
  alternative: string;
  rowsUsed: number;
  rowsDropped: number;
  estimate?: { name: string; value: number | null; ci: (number | null)[]; level: number };
  effectSize?: { name: string; value: number | null; magnitude?: string; rSquared?: number; omegaSquared?: number };
  groups?: { name: string; n: number; mean: number | null; sd: number | null; median: number | null }[];
  assumptions: Assumption[];
  nonParametric?: { test: string; statistic?: number | null; statisticName?: string; pValue?: number | null; significant?: boolean; error?: string } | null;
  recommendNonParametric?: boolean;
  postHoc?: { test: string; comparisons: { groups: string[]; difference: number | null; ci: (number | null)[]; pValue: number | null; significant: boolean }[] };
  contingency?: { rows: string[]; columns: string[]; counts: number[][] };
  valueColumn?: string;
  groupColumn?: string;
}

const num = (v: number | null | undefined, digits = 3) =>
  v === null || v === undefined || !Number.isFinite(v) ? '—' : Number(v.toPrecision(Math.max(digits, 1))).toLocaleString(undefined, { maximumFractionDigits: 6 });
const short = (v: number | null | undefined) => (v === null || v === undefined || !Number.isFinite(v) ? '—' : Number.isInteger(v) ? String(v) : Math.abs(v) >= 100 ? v.toFixed(1) : v.toFixed(3));

/** Plain-language one-line conclusion for a result. */
function headline(r: CompareResult, a: string, b: string): string {
  const what = r.family === 'correlation' ? `a relationship between ${a} and ${b}`
    : r.family === 'categories' ? `a link between ${a} and ${b}`
    : r.family === 'paired' ? `a difference between ${a} and ${b}`
    : `a difference in ${r.valueColumn ?? a} between the ${r.groupColumn ?? b} groups`;
  return r.significant
    ? `There is statistically significant evidence of ${what} (p ${formatP(r.pValue).startsWith('<') ? formatP(r.pValue) : `= ${formatP(r.pValue)}`}).`
    : `No statistically significant evidence of ${what} at the ${r.alpha} level (p = ${formatP(r.pValue)}). This doesn’t prove there is none.`;
}

export interface SessionTest { id: string; label: string; pValue: number }

export default function StatsCompare({ dataset, sessionTests, onTestRun }: {
  dataset: Dataset;
  sessionTests: SessionTest[];
  onTestRun: (t: SessionTest) => void;
}) {
  const logRun = useLogRun();
  const names = dataset.columns.map(c => c.name);
  const numeric = dataset.columns.filter(c => c.type === 'numeric').map(c => c.name);
  const [colA, setColA] = useState(numeric[0] ?? names[0] ?? '');
  const [colB, setColB] = useState(dataset.columns.find(c => c.type !== 'numeric' && c.distinctCount <= 12)?.name ?? names[1] ?? '');
  const [paired, setPaired] = useState(false);
  const [alternative, setAlternative] = useState<'two-sided' | 'greater' | 'less'>('two-sided');
  const [alpha, setAlpha] = useState(0.05);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<{ r: CompareResult; a: string; b: string } | null>(null);
  const [adjust, setAdjust] = useState<AdjustMethod>('holm');

  const valid = (v: string) => (names.includes(v) ? v : names[0] ?? '');
  const a = valid(colA);
  const b = valid(colB);
  const bothNumeric = numeric.includes(a) && numeric.includes(b);

  const run = async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await apiFetch('/api/stats/compare', {
        method: 'POST',
        body: JSON.stringify({
          data: dataset.rows.map(r => ({ [a]: r[a], [b]: r[b] })),
          columnA: a, columnB: b, paired: paired && bothNumeric, alpha, alternative,
        }),
      });
      const body = await res.json().catch(() => null);
      if (!res.ok || !body) throw new Error(body?.error || `The test couldn’t run (HTTP ${res.status}).`);
      setResult({ r: body, a, b });
      const label = `${body.test}: ${a} vs ${b}`;
      if (typeof body.pValue === 'number') onTestRun({ id: crypto.randomUUID(), label, pValue: body.pValue });
      logRun({
        kind: 'hypothesis-test',
        title: label,
        summary: `p = ${formatP(body.pValue)} · ${body.significant ? 'significant' : 'not significant'}${body.effectSize?.value != null ? ` · ${body.effectSize.name} ${short(body.effectSize.value)}` : ''}`,
        status: 'succeeded',
        params: { columnA: a, columnB: b, paired, alpha, alternative },
        result: body,
      });
    } catch (err) {
      setResult(null);
      setError((err as Error).message);
      logRun({ kind: 'hypothesis-test', title: `Test: ${a} vs ${b}`, summary: 'Failed', status: 'failed', error: (err as Error).message });
    } finally {
      setLoading(false);
    }
  };

  const adjusted = sessionTests.length >= 2 ? adjustPValues(sessionTests.map(t => t.pValue), adjust) : [];

  return (
    <div className="space-y-6">
      <div className="card p-5 sm:p-6 space-y-4">
        <div>
          <h3 className="card-title" data-agent="area-compare">Compare or relate two columns</h3>
          <p className="mt-1 text-sm text-label-2">
            The right test is chosen from the column types: numbers vs groups compares averages, two number columns are correlated,
            and two category columns are tested for a link. Every result comes with its effect size, a confidence interval and the
            assumptions behind it.
          </p>
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
          <div>
            <label className="field-label" htmlFor="cmp-a">First column</label>
            <select id="cmp-a" data-agent="cmp-a" className="input" value={a} onChange={e => setColA(e.target.value)}>
              {names.map(n => <option key={n} value={n}>{n}</option>)}
            </select>
          </div>
          <div>
            <label className="field-label" htmlFor="cmp-b">Second column</label>
            <select id="cmp-b" data-agent="cmp-b" className="input" value={b} onChange={e => setColB(e.target.value)}>
              {names.map(n => <option key={n} value={n}>{n}</option>)}
            </select>
          </div>
          <div>
            <label className="field-label" htmlFor="cmp-alt">Direction</label>
            <select id="cmp-alt" data-agent="cmp-alt" className="input" value={alternative} onChange={e => setAlternative(e.target.value as typeof alternative)}>
              <option value="two-sided">Any difference (two-sided)</option>
              <option value="greater">First is greater (one-sided)</option>
              <option value="less">First is smaller (one-sided)</option>
            </select>
          </div>
          <div>
            <label className="field-label" htmlFor="cmp-alpha">Significance level</label>
            <select id="cmp-alpha" data-agent="cmp-alpha" className="input" value={alpha} onChange={e => setAlpha(Number(e.target.value))}>
              <option value={0.01}>0.01 (99% confidence)</option>
              <option value={0.05}>0.05 (95% confidence)</option>
              <option value={0.1}>0.10 (90% confidence)</option>
            </select>
          </div>
        </div>
        {bothNumeric && (
          <label className="flex items-center gap-2 text-sm text-label">
            <input type="checkbox" checked={paired} onChange={e => setPaired(e.target.checked)} />
            These are two measurements of the same thing on each row (before/after) — compare them as pairs
          </label>
        )}
        <button type="button" data-agent="cmp-run" onClick={run} disabled={loading || !a || !b} aria-busy={loading} className="btn btn-primary">
          {loading ? <><Orb state="solving" onAccent label="Running the test" /> Running…</> : 'Run Test'}
        </button>
        {error && (
          <p role="alert" className="flex items-start gap-2 rounded-xl bg-red/10 px-3 py-2.5 text-sm text-red">
            <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" /> {error}
          </p>
        )}
      </div>

      {result && <ResultCard r={result.r} a={result.a} b={result.b} />}

      {sessionTests.length >= 2 && (
        <div className="card p-5 sm:p-6 space-y-3">
          <h3 className="card-title">Correct for running several tests</h3>
          <p className="text-sm text-label-2">
            You’ve run {sessionTests.length} tests. The more tests, the more likely one looks significant by chance; adjusted p-values account for that.
          </p>
          <select className="input w-auto" aria-label="Correction method" value={adjust} onChange={e => setAdjust(e.target.value as AdjustMethod)}>
            {(Object.keys(ADJUST_LABELS) as AdjustMethod[]).map(m => <option key={m} value={m}>{ADJUST_LABELS[m]}</option>)}
          </select>
          <div className="overflow-x-auto">
            <table className="w-full text-sm tabular-nums">
              <thead><tr className="text-left text-xs text-label-2"><th className="py-1.5 pr-4 font-medium">Test</th><th className="py-1.5 pr-4 font-medium">p</th><th className="py-1.5 font-medium">Adjusted p</th></tr></thead>
              <tbody className="divide-y divide-separator">
                {sessionTests.map((t, i) => (
                  <tr key={t.id}>
                    <td className="py-1.5 pr-4 text-label">{t.label}</td>
                    <td className="py-1.5 pr-4 text-label-2">{formatP(t.pValue)}</td>
                    <td className={`py-1.5 font-medium ${adjusted[i] < 0.05 ? 'text-green' : 'text-label-2'}`}>{formatP(adjusted[i])}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}

function AssumptionIcon({ passed }: { passed: boolean | null }) {
  if (passed === true) return <CheckCircle2 className="w-4 h-4 text-green shrink-0" aria-label="Met" />;
  if (passed === false) return <XCircle className="w-4 h-4 text-orange shrink-0" aria-label="Not met" />;
  return <MinusCircle className="w-4 h-4 text-label-3 shrink-0" aria-label="Not checked" />;
}

function ResultCard({ r, a, b }: { r: CompareResult; a: string; b: string }) {
  const df = Array.isArray(r.df) ? r.df.map(x => short(x)).join(', ') : short(r.df as number);
  const stats: [string, string][] = [
    ['Test', r.test],
    [`${r.statisticName}${r.df !== null ? ` (df ${df})` : ''}`, short(r.statistic)],
    ['p-value', formatP(r.pValue)],
  ];
  if (r.effectSize) stats.push([r.effectSize.name, `${short(r.effectSize.value)}${r.effectSize.magnitude && r.effectSize.magnitude !== 'unknown' ? ` (${r.effectSize.magnitude})` : ''}`]);
  return (
    <div className="card p-5 sm:p-6 space-y-5 animate-fade-in" role="region" aria-label="Test result">
      <p className={`text-[17px] font-semibold ${r.significant ? 'text-green' : 'text-label'}`}>{headline(r, a, b)}</p>
      <dl className="grid grid-cols-2 lg:grid-cols-4 gap-px bg-separator rounded-xl overflow-hidden">
        {stats.map(([k, v]) => (
          <div key={k} className="bg-surface px-4 py-3">
            <dt className="text-xs text-label-2">{k}</dt>
            <dd className="mt-0.5 text-[17px] font-semibold tabular-nums text-label">{v}</dd>
          </div>
        ))}
      </dl>
      {r.estimate && (
        <p className="text-sm text-label">
          <span className="font-medium">{r.estimate.name}:</span> {num(r.estimate.value, 4)}
          {r.estimate.ci[0] !== null && <> — {Math.round(r.estimate.level * 100)}% confidence interval {num(r.estimate.ci[0], 4)} to {num(r.estimate.ci[1], 4)}</>}
        </p>
      )}
      <p className="text-xs text-label-3">
        {r.rowsUsed.toLocaleString()} rows used{r.rowsDropped ? `; ${r.rowsDropped.toLocaleString()} skipped because a value was missing` : ''}.
        {r.alternative !== 'two-sided' && ` One-sided test (${r.alternative}).`}
      </p>

      {r.groups && r.groups.length > 0 && (
        <div className="overflow-x-auto">
          <table className="w-full text-sm tabular-nums">
            <thead><tr className="text-left text-xs text-label-2">{['Group', 'Rows', 'Mean', 'Std. dev.', 'Median'].map(h => <th key={h} className="py-1.5 pr-4 font-medium">{h}</th>)}</tr></thead>
            <tbody className="divide-y divide-separator">
              {r.groups.map(g => (
                <tr key={g.name}>
                  <td className="py-1.5 pr-4 text-label">{g.name}</td>
                  <td className="py-1.5 pr-4 text-label-2">{g.n.toLocaleString()}</td>
                  <td className="py-1.5 pr-4 text-label-2">{num(g.mean, 4)}</td>
                  <td className="py-1.5 pr-4 text-label-2">{num(g.sd, 4)}</td>
                  <td className="py-1.5 text-label-2">{num(g.median, 4)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {r.contingency && (
        <div className="overflow-x-auto">
          <table className="text-sm tabular-nums">
            <thead><tr><th />{r.contingency.columns.map(c => <th key={c} className="px-3 py-1.5 text-xs font-medium text-label-2 text-right">{c}</th>)}</tr></thead>
            <tbody>
              {r.contingency.rows.map((row, i) => (
                <tr key={row}><th className="pr-3 py-1.5 text-left text-xs font-medium text-label-2">{row}</th>{r.contingency!.counts[i].map((n, j) => <td key={j} className="px-3 py-1.5 text-right text-label">{n}</td>)}</tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <div>
        <h4 className="text-sm font-semibold text-label">Assumptions</h4>
        <ul className="mt-2 space-y-1.5">
          {r.assumptions.map(x => (
            <li key={x.name} className="flex items-start gap-2 text-sm">
              <AssumptionIcon passed={x.passed} />
              <span><span className="text-label">{x.name}.</span> <span className="text-label-2">{x.detail}</span></span>
            </li>
          ))}
        </ul>
      </div>

      {r.nonParametric && !r.nonParametric.error && (
        <div className={`rounded-xl px-4 py-3 text-sm ${r.recommendNonParametric ? 'bg-orange/10' : 'bg-well'}`}>
          <p className="text-label">
            <span className="font-medium">{r.recommendNonParametric ? 'Use this instead — ' : 'Check: '}{r.nonParametric.test}</span>
            {' '}gives {r.nonParametric.statisticName ?? 'statistic'} = {short(r.nonParametric.statistic)}, p = {formatP(r.nonParametric.pValue)}
            {' '}({r.nonParametric.significant ? 'significant' : 'not significant'}).
          </p>
          {r.recommendNonParametric && (
            <p className="mt-1 text-xs text-label-2">An assumption above isn’t met, so this test, which doesn’t rely on it, is the safer one to report.</p>
          )}
        </div>
      )}

      {r.postHoc && r.postHoc.comparisons.length > 0 && (
        <div>
          <h4 className="text-sm font-semibold text-label">Which groups differ ({r.postHoc.test})</h4>
          <div className="mt-2 overflow-x-auto">
            <table className="w-full text-sm tabular-nums">
              <thead><tr className="text-left text-xs text-label-2">{['Groups', 'Difference', 'Confidence interval', 'Adjusted p'].map(h => <th key={h} className="py-1.5 pr-4 font-medium">{h}</th>)}</tr></thead>
              <tbody className="divide-y divide-separator">
                {r.postHoc.comparisons.map(c => (
                  <tr key={c.groups.join('|')}>
                    <td className="py-1.5 pr-4 text-label">{c.groups[0]} − {c.groups[1]}</td>
                    <td className="py-1.5 pr-4 text-label-2">{num(c.difference, 4)}</td>
                    <td className="py-1.5 pr-4 text-label-2">{num(c.ci[0], 4)} to {num(c.ci[1], 4)}</td>
                    <td className={`py-1.5 ${c.significant ? 'text-green font-medium' : 'text-label-2'}`}>{formatP(c.pValue)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}
