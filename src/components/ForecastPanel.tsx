/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useMemo, useState } from 'react';
import { AlertTriangle } from 'lucide-react';
import { Area, CartesianGrid, ComposedChart, Legend, Line, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { Dataset } from '../types';
import { apiFetch } from '../utils/api';
import { useLogRun } from '../contexts/WorkspaceContext';
import Orb from './Orb';

interface ForecastResult {
  frequency: string; seasonLength: number; points: number; horizon: number; folds: number; aggregation: string;
  best: string; bestLabel: string;
  leaderboard: { method: string; label: string; mae: number; rmse: number; mape: number | null }[];
  history: { date: string; value: number }[];
  forecast: { date: string; value: number; lo80: number; hi80: number; lo95: number; hi95: number }[];
  notes: string[];
  intervalMethod: string;
}

const fmt = (v: number | null | undefined) =>
  v === null || v === undefined || !Number.isFinite(v) ? '—' : v.toLocaleString(undefined, { maximumFractionDigits: Math.abs(v) >= 100 ? 0 : 2 });

/** Baseline forecasts, each checked by backtesting, for data with a date column. */
export default function ForecastPanel({ dataset }: { dataset: Dataset }) {
  const logRun = useLogRun();
  const dateCols = dataset.columns.filter(c => c.type === 'datetime').map(c => c.name);
  const numCols = dataset.columns.filter(c => c.type === 'numeric').map(c => c.name);
  const [dateCol, setDateCol] = useState(dateCols[0] ?? '');
  const [valueCol, setValueCol] = useState(numCols[0] ?? '');
  const [agg, setAgg] = useState<'sum' | 'mean'>('sum');
  const [freq, setFreq] = useState('auto');
  const [horizon, setHorizon] = useState(6);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<ForecastResult | null>(null);

  const chartData = useMemo(() => {
    if (!result) return [];
    return [
      ...result.history.map(h => ({ date: h.date, actual: h.value })),
      ...result.forecast.map(f => ({ date: f.date, forecast: f.value, band95: [f.lo95, f.hi95], band80: [f.lo80, f.hi80] })),
    ];
  }, [result]);

  if (dateCols.length === 0) {
    return (
      <section className="card p-5 sm:p-6">
        <h2 className="card-title">Forecast</h2>
        <p className="mt-1 text-sm text-label-2">Forecasting needs a date column. None was found; if dates are stored as text, change the column type to Date in Clean → More tools.</p>
      </section>
    );
  }

  const run = async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await apiFetch('/api/forecast', {
        method: 'POST',
        body: JSON.stringify({
          data: dataset.rows.map(r => ({ [dateCol]: r[dateCol], [valueCol]: r[valueCol] })),
          date_column: dateCol, value_column: valueCol, horizon, freq, agg,
        }),
      });
      const body = await res.json().catch(() => null);
      if (!res.ok || !body) throw new Error(body?.error || `The forecast couldn’t run (HTTP ${res.status}).`);
      setResult(body);
      const top = body.leaderboard[0];
      logRun({
        kind: 'forecast',
        title: `Forecast of ${valueCol}, ${body.horizon} ${body.frequency}s ahead`,
        summary: `${body.bestLabel} · backtest MAE ${fmt(top.mae)}`,
        status: 'succeeded',
        params: { dateCol, valueCol, horizon, freq, agg },
        result: { best: body.best, leaderboard: body.leaderboard, forecast: body.forecast },
      });
    } catch (err) {
      setResult(null);
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  };

  return (
    <section className="card p-5 sm:p-6 space-y-5" aria-labelledby="forecast-heading">
      <div>
        <h2 id="forecast-heading" className="card-title">Forecast</h2>
        <p className="mt-1 text-sm text-label-2">
          Simple, proven forecasting methods are each tested on your past data (backtesting); the most accurate one makes the forecast,
          and the shaded range comes from its real past errors.
        </p>
      </div>
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-5 gap-4">
        <div>
          <label className="field-label" htmlFor="fc-date">Date column</label>
          <select id="fc-date" className="input" value={dateCol} onChange={e => setDateCol(e.target.value)}>
            {dateCols.map(c => <option key={c} value={c}>{c}</option>)}
          </select>
        </div>
        <div>
          <label className="field-label" htmlFor="fc-value">Value to forecast</label>
          <select id="fc-value" className="input" value={valueCol} onChange={e => setValueCol(e.target.value)}>
            {numCols.map(c => <option key={c} value={c}>{c}</option>)}
          </select>
        </div>
        <div>
          <label className="field-label" htmlFor="fc-agg">Combine rows in a period by</label>
          <select id="fc-agg" className="input" value={agg} onChange={e => setAgg(e.target.value as 'sum' | 'mean')}>
            <option value="sum">Total</option>
            <option value="mean">Average</option>
          </select>
        </div>
        <div>
          <label className="field-label" htmlFor="fc-freq">Period</label>
          <select id="fc-freq" className="input" value={freq} onChange={e => setFreq(e.target.value)}>
            <option value="auto">Automatic</option>
            <option value="D">Day</option>
            <option value="W">Week</option>
            <option value="MS">Month</option>
            <option value="QS">Quarter</option>
            <option value="YS">Year</option>
          </select>
        </div>
        <div>
          <label className="field-label" htmlFor="fc-h">Periods ahead</label>
          <input id="fc-h" type="number" min={1} max={365} className="input" value={horizon} onChange={e => setHorizon(Math.max(1, Math.min(365, Number(e.target.value) || 1)))} />
        </div>
      </div>
      <button type="button" onClick={run} disabled={loading || !valueCol} aria-busy={loading} className="btn btn-primary">
        {loading ? <><Orb state="solving" onAccent label="Backtesting forecasts" /> Backtesting…</> : 'Forecast'}
      </button>
      {error && (
        <p role="alert" className="flex items-start gap-2 rounded-xl bg-red/10 px-3 py-2.5 text-sm text-red">
          <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" /> {error}
        </p>
      )}

      {result && (
        <div className="space-y-5 animate-fade-in" role="region" aria-label="Forecast result">
          <p className="text-sm text-label">
            Best method: <span className="font-semibold">{result.bestLabel}</span>, chosen by backtesting over {result.folds} past
            {result.folds === 1 ? ' window' : ' windows'} of {result.horizon} {result.frequency}s ({result.points} {result.frequency}s of data).
          </p>
          <div className="h-[300px] w-full">
            <ResponsiveContainer width="100%" height="100%">
              <ComposedChart data={chartData} margin={{ top: 10, right: 16, left: 0, bottom: 0 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="var(--chart-grid)" vertical={false} />
                <XAxis dataKey="date" tick={{ fill: 'var(--chart-axis)', fontSize: 11 }} minTickGap={24} />
                <YAxis tick={{ fill: 'var(--chart-axis)', fontSize: 11 }} width={56} />
                <Tooltip formatter={(v: any) => (Array.isArray(v) ? `${fmt(v[0])} – ${fmt(v[1])}` : fmt(v))} />
                <Legend wrapperStyle={{ fontSize: 12 }} />
                <Area dataKey="band95" name="95% range" stroke="none" fill="var(--chart-1)" fillOpacity={0.12} isAnimationActive={false} />
                <Area dataKey="band80" name="80% range" stroke="none" fill="var(--chart-1)" fillOpacity={0.22} isAnimationActive={false} />
                <Line dataKey="actual" name="Actual" stroke="var(--chart-axis)" dot={false} strokeWidth={1.5} isAnimationActive={false} />
                <Line dataKey="forecast" name="Forecast" stroke="var(--chart-1)" strokeDasharray="5 3" dot={false} strokeWidth={2} isAnimationActive={false} />
              </ComposedChart>
            </ResponsiveContainer>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-sm tabular-nums">
              <thead><tr className="text-left text-xs text-label-2">{['Method', 'MAE', 'RMSE', 'MAPE'].map(h => <th key={h} className="py-1.5 pr-4 font-medium">{h}</th>)}</tr></thead>
              <tbody className="divide-y divide-separator">
                {result.leaderboard.map((m, i) => (
                  <tr key={m.method}>
                    <td className={`py-1.5 pr-4 ${i === 0 ? 'text-label font-medium' : 'text-label-2'}`}>{m.label}{i === 0 ? ' (best)' : ''}</td>
                    <td className="py-1.5 pr-4 text-label-2">{fmt(m.mae)}</td>
                    <td className="py-1.5 pr-4 text-label-2">{fmt(m.rmse)}</td>
                    <td className="py-1.5 text-label-2">{m.mape === null ? '—' : `${m.mape.toFixed(1)}%`}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <p className="mt-2 text-xs text-label-3">Errors are averaged over the backtest windows: MAE is the average miss, in {valueCol}’s units.</p>
          </div>
          <details className="text-sm">
            <summary className="cursor-pointer text-label-2">Forecast values</summary>
            <table className="mt-2 w-full text-sm tabular-nums">
              <thead><tr className="text-left text-xs text-label-2">{['Period', 'Forecast', '80% range', '95% range'].map(h => <th key={h} className="py-1.5 pr-4 font-medium">{h}</th>)}</tr></thead>
              <tbody className="divide-y divide-separator">
                {result.forecast.map(f => (
                  <tr key={f.date}>
                    <td className="py-1.5 pr-4 text-label">{f.date}</td>
                    <td className="py-1.5 pr-4 text-label">{fmt(f.value)}</td>
                    <td className="py-1.5 pr-4 text-label-2">{fmt(f.lo80)} – {fmt(f.hi80)}</td>
                    <td className="py-1.5 text-label-2">{fmt(f.lo95)} – {fmt(f.hi95)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </details>
          {[...result.notes, result.intervalMethod].map(n => <p key={n} className="text-xs text-label-3">{n}</p>)}
        </div>
      )}
    </section>
  );
}
