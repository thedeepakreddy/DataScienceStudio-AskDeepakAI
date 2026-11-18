/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React from 'react';
import { Area, Bar, BarChart, CartesianGrid, ComposedChart, Line, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { CHART_CURSOR } from '../../utils/chartTheme';
import { DataTable, Note, Section, StatGrid, num, pct, type Method } from '../stats/methodKit';
import { LpEditor, VariablesEditor, checkProblem, checkVariables, initialProblem, initialVariables, problemToParams, variablesToParams } from './decideEditors';

const axis = { tick: { fontSize: 11, fill: 'var(--label-2)' } };
const article = (s: string) => (/^(8|11(?!\d)|18(?!\d))/.test(s) ? 'an' : 'a');
const day = (d: string) => (typeof d === 'string' ? d.slice(0, 10) : String(d));
const NAMES: Record<string, string> = { naive: 'Naive (last value)', seasonal_naive: 'Seasonal naive', drift: 'Drift', ets: 'Exponential smoothing (ETS)', arima: 'ARIMA', theta: 'Theta', ml_lags: 'LightGBM on lags', ensemble: 'Ensemble of the best three' };

// ================================================================== forecasting
const forecast: Method = {
  id: 'forecast', cap: 'ts.forecast', title: 'Forecast with backtesting',
  answers: 'Tries seven forecasting methods, scores each on the past (rolling backtests), and forecasts with the best — with a realistic range.',
  fields: [
    { key: 'date', label: 'Date column', kind: 'column', filter: 'date' },
    { key: 'value', label: 'Value to forecast', kind: 'column', filter: 'numeric' },
    { key: 'horizon', label: 'Periods ahead', kind: 'number', default: 12, min: 1, max: 365, step: 1 },
    { key: 'agg', label: 'Combine rows in a period by', kind: 'select', default: 'sum', options: [{ value: 'sum', label: 'Sum' }, { value: 'mean', label: 'Average' }, { value: 'last', label: 'Last value' }] },
  ],
  headline: r => {
    const f = r.forecast?.[0];
    const naive = r.leaderboard?.find((x: any) => x.model === 'naive');
    const best = r.leaderboard?.find((x: any) => x.model === r.best);
    const gain = naive && best && naive.mase > 0 ? ` — ${Math.round((1 - best.mase / naive.mase) * 100)}% more accurate than repeating the last value` : '';
    return f ? `Next period (${day(f.date)}): ${num(f.value, 4)}${f.lower != null ? `, likely between ${num(f.lower, 4)} and ${num(f.upper, 4)}` : ''}. Best method: ${NAMES[r.best] ?? r.best}${gain}.` : 'Forecast ready.';
  },
  tone: () => 'good',
  render: r => {
    const data = [
      ...(r.history ?? []).map((h: any) => ({ date: day(h.date), actual: h.value })),
      ...(r.forecast ?? []).map((f: any) => ({ date: day(f.date), forecast: f.value, band: f.lower != null ? [f.lower, f.upper] : undefined })),
    ];
    return <>
      <div className="h-64">
        <ResponsiveContainer>
          <ComposedChart data={data} margin={{ left: -5, right: 8 }}>
            <CartesianGrid stroke="var(--separator)" vertical={false} />
            <XAxis dataKey="date" {...axis} minTickGap={24} /><YAxis {...axis} domain={['auto', 'auto']} />
            <Tooltip formatter={(v: any) => (Array.isArray(v) ? `${num(v[0], 4)} – ${num(v[1], 4)}` : num(v, 4))} />
            <Area dataKey="band" stroke="none" fill="var(--blue)" fillOpacity={0.15} name={`${Math.round((r.level ?? 0.9) * 100)}% range`} isAnimationActive={false} />
            <Line dataKey="actual" stroke="var(--label-2)" dot={false} name="Actual" isAnimationActive={false} />
            <Line dataKey="forecast" stroke="var(--blue)" strokeWidth={2} dot={false} name="Forecast" isAnimationActive={false} />
          </ComposedChart>
        </ResponsiveContainer>
      </div>
      <Section title={`How each method did on the past (${r.backtestWindows} backtest windows; lower error is better)`}>
        <DataTable rows={r.leaderboard} columns={[{ key: 'model', label: 'Method', format: (m: string) => <span className={m === r.best ? 'font-semibold text-green' : ''}>{NAMES[m] ?? m}</span> },
          { key: 'mase', label: 'MASE' }, { key: 'smape', label: 'sMAPE', format: (x: number) => x == null ? '—' : pct(x, 1) }, { key: 'mae', label: 'MAE' }]} />
        <p className="text-xs text-label-3">MASE below 1 means better than a seasonal-naive forecast.</p>
      </Section>
      <DataTable rows={r.forecast} columns={[{ key: 'date', label: 'Period', format: day }, { key: 'value', label: 'Forecast' }, { key: 'lower', label: 'Low' }, { key: 'upper', label: 'High' }]} limit={24} />
    </>;
  },
};

const hierarchical: Method = {
  id: 'hierarchical', cap: 'ts.hierarchical', title: 'Forecasts that add up (hierarchical)',
  answers: 'Forecasts the total and every region, store or product, reconciled so the parts add up to the totals.',
  fields: [
    { key: 'date', label: 'Date column', kind: 'column', filter: 'date' },
    { key: 'value', label: 'Value', kind: 'column', filter: 'numeric' },
    { key: 'levels', label: 'Hierarchy, top level first', kind: 'columns', filter: 'categorical', min: 1, max: 3 },
    { key: 'horizon', label: 'Periods ahead', kind: 'number', default: 6, min: 1, max: 60, step: 1 },
  ],
  headline: r => {
    const total = r.series?.find((s: any) => s.level === 0);
    const f = total?.forecast?.[0];
    return f ? `Total next period (${day(f.date)}): ${num(f.reconciled, 4)}, split across ${r.bottomSeries} series that add up exactly.` : 'Forecast ready.';
  },
  render: r => <>
    <DataTable limit={30} rows={(r.series ?? []).map((s: any) => ({ node: s.node.join(' › '), level: s.level, next: s.forecast[0]?.reconciled, sum: s.forecast.reduce((a: number, f: any) => a + f.reconciled, 0) }))}
      columns={[{ key: 'node', label: 'Series', format: (n: string, row: any) => <span style={{ paddingLeft: row.level * 12 }}>{n}</span> }, { key: 'next', label: 'Next period' }, { key: 'sum', label: `Total over ${r.series?.[0]?.forecast.length} periods` }]} />
    <Note>Base forecasts (ETS per series) were reconciled by OLS. Before reconciling they disagreed by up to {num(r.baseIncoherence)}; now every level adds up.</Note>
  </>,
};

// ================================================================== decide
const monteCarlo: Method = {
  id: 'montecarlo', cap: 'opt.monte_carlo', title: 'Simulate an uncertain outcome (Monte Carlo)',
  answers: 'When inputs are uncertain — price, demand, cost — what range of results to expect, how likely you are to hit a target, and which input matters most.',
  fields: [
    { key: 'variables', label: 'Uncertain inputs', kind: 'custom', initial: initialVariables, editor: VariablesEditor, check: checkVariables },
    { key: 'formula', label: 'Outcome formula (use the names above; + − * / ** and min, max, log, exp, sqrt)', kind: 'text', default: 'price * volume - fixed_cost', placeholder: 'e.g. price * volume - fixed_cost' },
    { key: 'threshold', label: 'Target to beat (optional)', kind: 'number', optional: true },
  ],
  params: v => ({ ...v, variables: variablesToParams(v.variables) }),
  headline: (r, v) => `Average ${num(r.mean, 4)}; 90% of outcomes fall between ${num(r.percentiles.p5, 4)} and ${num(r.percentiles.p95, 4)}${r.probabilityAbove != null ? `, with ${article(pct(r.probabilityAbove))} ${pct(r.probabilityAbove)} chance of beating ${num(Number(v.threshold), 4)}` : ''}. ${r.sensitivity?.[0] ? `${r.sensitivity[0].variable} matters most.` : ''}`,
  render: r => <>
    <div className="h-48"><ResponsiveContainer><BarChart data={(r.histogram ?? []).map((h: any) => ({ x: num((h.from + h.to) / 2, 3), c: h.count }))} margin={{ left: -15, right: 4 }}><XAxis dataKey="x" {...axis} interval="preserveStartEnd" /><YAxis {...axis} /><Tooltip cursor={CHART_CURSOR} /><Bar dataKey="c" name="simulations" fill="var(--blue)" /></BarChart></ResponsiveContainer></div>
    <StatGrid items={[['5th percentile', num(r.percentiles.p5, 4)], ['Median', num(r.percentiles.p50, 4)], ['95th percentile', num(r.percentiles.p95, 4)], ['Simulations', r.simulations?.toLocaleString()]]} />
    <Section title="What drives the outcome (rank correlation)">
      {(r.sensitivity ?? []).map((s: any) => (
        <div key={s.variable} className="grid grid-cols-[minmax(0,8rem)_1fr_3.5rem] items-center gap-3 text-sm">
          <span className="truncate text-label">{s.variable}</span>
          <div className="relative h-2.5 rounded-full bg-fill"><div className={`absolute top-0 h-full rounded-full ${s.rankCorrelation >= 0 ? 'bg-blue left-1/2' : 'bg-orange right-1/2'}`} style={{ width: `${Math.abs(s.rankCorrelation) * 50}%` }} /></div>
          <span className="tabular-nums text-label-2 text-right">{num(s.rankCorrelation, 2)}</span>
        </div>
      ))}
    </Section>
  </>,
};

const linearProgram: Method = {
  id: 'optimize', cap: 'opt.linear_program', title: 'Best decision under limits (optimisation)',
  answers: 'The best mix, plan or allocation given budgets and capacities — and what one more unit of each limit is worth (shadow prices).',
  fields: [{ key: 'problem', label: 'Decisions, goal and limits', kind: 'custom', initial: initialProblem, editor: LpEditor, check: checkProblem }],
  params: v => problemToParams(v.problem),
  headline: r => r.feasible ? `Best ${num(r.objective, 5)} with ${Object.entries(r.solution).map(([k, x]) => `${k} = ${num(x as number, 4)}`).join(', ')}.` : `No solution satisfies every limit (${r.status}).`,
  tone: r => (r.feasible ? 'good' : 'warn'),
  render: r => r.feasible ? <>
    <DataTable rows={Object.entries(r.solution).map(([k, x]) => ({ k, x }))} columns={[{ key: 'k', label: 'Decision' }, { key: 'x', label: 'Best value' }]} />
    <Section title="Limits">
      <DataTable rows={r.constraints} columns={[{ key: 'name', label: 'Limit' }, { key: 'activity', label: 'Used' }, { key: 'rhs', label: 'Available' },
        { key: 'binding', label: '', format: (b: boolean) => b ? <span className="text-orange">fully used</span> : '' },
        { key: 'shadowPrice', label: 'Worth of one more unit', format: (x: number) => x == null ? '—' : num(x) }]} />
    </Section>
  </> : null,
};

export const MODEL_METHODS: Method[] = [forecast, hierarchical, monteCarlo, linearProgram];
