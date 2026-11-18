/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React from 'react';
import { Bar, BarChart, CartesianGrid, Line, LineChart, ReferenceLine, ResponsiveContainer, Scatter, ScatterChart, Tooltip, XAxis, YAxis } from 'recharts';
import { CHART_CURSOR } from '../../utils/chartTheme';
import { num, pct } from '../stats/methodKit';

const axis = { tick: { fontSize: 11, fill: 'var(--label-2)' }, stroke: 'var(--separator)' };

const Frame: React.FC<{ title: string; note?: string; children: React.ReactElement }> = ({ title, note, children }) => (
  <figure className="space-y-1.5 min-w-0">
    <figcaption className="text-sm font-semibold text-label">{title}</figcaption>
    <div className="h-48">
      <ResponsiveContainer>{children}</ResponsiveContainer>
    </div>
    {note && <p className="text-xs text-label-3">{note}</p>}
  </figure>
);

export function RocChart({ points, auc }: { points: { fpr: number; tpr: number }[]; auc?: number }) {
  return (
    <Frame title={`ROC curve${auc != null ? ` (AUC ${num(auc)})` : ''}`} note="Higher and further left is better; the diagonal is guessing.">
      <LineChart data={points} margin={{ left: -18, right: 8, top: 4 }}>
        <CartesianGrid stroke="var(--separator)" />
        <XAxis dataKey="fpr" type="number" domain={[0, 1]} {...axis} tickFormatter={v => pct(v)} />
        <YAxis type="number" domain={[0, 1]} {...axis} tickFormatter={v => pct(v)} />
        <Tooltip formatter={(v: any) => pct(v, 1)} labelFormatter={v => `False alarms ${pct(Number(v), 1)}`} />
        <ReferenceLine segment={[{ x: 0, y: 0 }, { x: 1, y: 1 }]} stroke="var(--label-3)" strokeDasharray="4 4" />
        <Line dataKey="tpr" name="Caught" stroke="var(--blue)" strokeWidth={2} dot={false} isAnimationActive={false} />
      </LineChart>
    </Frame>
  );
}

export function PrChart({ points, base }: { points: { recall: number; precision: number }[]; base?: number }) {
  const data = [...points].sort((a, b) => a.recall - b.recall);
  return (
    <Frame title="Precision vs recall" note="How many flagged rows are right (precision) as you catch more of the positives (recall).">
      <LineChart data={data} margin={{ left: -18, right: 8, top: 4 }}>
        <CartesianGrid stroke="var(--separator)" />
        <XAxis dataKey="recall" type="number" domain={[0, 1]} {...axis} tickFormatter={v => pct(v)} />
        <YAxis type="number" domain={[0, 1]} {...axis} tickFormatter={v => pct(v)} />
        <Tooltip formatter={(v: any) => pct(v, 1)} labelFormatter={v => `Recall ${pct(Number(v), 1)}`} />
        {base != null && <ReferenceLine y={base} stroke="var(--label-3)" strokeDasharray="4 4" />}
        <Line dataKey="precision" name="Precision" stroke="var(--blue)" strokeWidth={2} dot={false} isAnimationActive={false} />
      </LineChart>
    </Frame>
  );
}

export function CalibrationChart({ bins, ece }: { bins: { predicted: number; observed: number }[]; ece?: number }) {
  return (
    <Frame title="Are the probabilities honest?" note={`Points on the diagonal mean “70%” really happens 70% of the time${ece != null ? ` (average gap ${pct(ece, 1)})` : ''}.`}>
      <LineChart data={bins} margin={{ left: -18, right: 8, top: 4 }}>
        <CartesianGrid stroke="var(--separator)" />
        <XAxis dataKey="predicted" type="number" domain={[0, 1]} {...axis} tickFormatter={v => pct(v)} />
        <YAxis type="number" domain={[0, 1]} {...axis} tickFormatter={v => pct(v)} />
        <Tooltip formatter={(v: any) => pct(v, 1)} labelFormatter={v => `Predicted ${pct(Number(v), 1)}`} />
        <ReferenceLine segment={[{ x: 0, y: 0 }, { x: 1, y: 1 }]} stroke="var(--label-3)" strokeDasharray="4 4" />
        <Line dataKey="observed" name="Actually happened" stroke="var(--blue)" strokeWidth={2} isAnimationActive={false} />
      </LineChart>
    </Frame>
  );
}

export function LiftChart({ deciles }: { deciles: { decile: number; lift: number; cumulativeGain: number }[] }) {
  const top = deciles.find(d => d.decile === 1);
  return (
    <Frame title="Lift by decile" note={top ? `The top 10% the model scores highest contain ${num(top.lift, 2)}× the average rate.` : undefined}>
      <BarChart data={deciles} margin={{ left: -18, right: 8, top: 4 }}>
        <CartesianGrid stroke="var(--separator)" vertical={false} />
        <XAxis dataKey="decile" {...axis} tickFormatter={v => `${v * 10}%`} />
        <YAxis {...axis} />
        <Tooltip cursor={CHART_CURSOR} formatter={(v: any) => `${num(v, 3)}×`} labelFormatter={v => `Top ${Number(v) * 10}% (decile ${v})`} />
        <ReferenceLine y={1} stroke="var(--label-3)" strokeDasharray="4 4" />
        <Bar dataKey="lift" name="Lift" fill="var(--blue)" isAnimationActive={false} />
      </BarChart>
    </Frame>
  );
}

export function ResidualChart({ points }: { points: { predicted: number; actual: number }[] }) {
  const xs = points.flatMap(p => [p.predicted, p.actual]);
  const lo = Math.min(...xs), hi = Math.max(...xs);
  return (
    <Frame title="Predicted vs actual" note="Points on the diagonal are exact predictions.">
      <ScatterChart margin={{ left: -10, right: 8, top: 4 }}>
        <CartesianGrid stroke="var(--separator)" />
        <XAxis dataKey="predicted" type="number" name="Predicted" domain={[lo, hi]} {...axis} tickFormatter={v => num(v, 3)} />
        <YAxis dataKey="actual" type="number" name="Actual" domain={[lo, hi]} {...axis} tickFormatter={v => num(v, 3)} />
        <Tooltip formatter={(v: any) => num(v, 4)} />
        <ReferenceLine segment={[{ x: lo, y: lo }, { x: hi, y: hi }]} stroke="var(--label-3)" strokeDasharray="4 4" />
        <Scatter data={points} fill="var(--blue)" fillOpacity={0.55} isAnimationActive={false} />
      </ScatterChart>
    </Frame>
  );
}

/** Horizontal bars with optional intervals: importance, SHAP, reasons. Signed values grow left/right from the centre. */
export function Bars({ rows, signed = false, from, lowerIsBetter = false, format = (v: number) => num(v) }: {
  rows: { label: string; value: number; ci?: [number, number] | null; hint?: string }[];
  signed?: boolean;
  /** Where bars start (e.g. a baseline score), so close values are still told apart. Defaults to 0. */
  from?: number;
  /** For errors (RMSE, log loss): bars show how far below `from` each value is. */
  lowerIsBetter?: boolean;
  format?: (v: number) => string;
}) {
  const lo = signed ? 0 : from ?? 0;
  const gain = (v: number) => (signed ? Math.abs(v) : lowerIsBetter ? lo - v : v - lo);
  const max = Math.max(1e-12, ...rows.flatMap(r => [gain(r.value), ...(r.ci ?? []).map(gain)]));
  const w = (v: number) => `${Math.max(0, Math.min(1, gain(v) / max)) * (signed ? 50 : 100)}%`;
  return (
    <div className="space-y-1.5">
      {rows.map(r => (
        <div key={r.label} className="grid grid-cols-[minmax(0,8rem)_1fr_4rem] sm:grid-cols-[minmax(0,13rem)_1fr_4.5rem] items-center gap-3 text-sm" title={r.hint}>
          <span className="truncate text-label" title={r.label}>{r.label}</span>
          <div className="relative h-2.5 rounded-full bg-fill">
            {signed && <div className="absolute inset-y-[-3px] left-1/2 w-px bg-separator" />}
            <div className={`absolute top-0 h-full rounded-full ${r.value >= 0 ? 'bg-blue' : 'bg-orange'} ${signed ? (r.value >= 0 ? 'left-1/2' : 'right-1/2') : 'left-0'}`} style={{ width: w(r.value) }} />
            {!signed && r.ci && <div className="absolute top-1/2 h-px bg-label-2" style={{ left: lowerIsBetter ? w(r.ci[1]) : w(r.ci[0]), width: `calc(${lowerIsBetter ? w(r.ci[0]) : w(r.ci[1])} - ${lowerIsBetter ? w(r.ci[1]) : w(r.ci[0])})` }} />}
          </div>
          <span className="tabular-nums text-label-2 text-right">{format(r.value)}</span>
        </div>
      ))}
    </div>
  );
}

export function ConfusionMatrix({ labels, matrix }: { labels: string[]; matrix: number[][] }) {
  const total = matrix.flat().reduce((a, b) => a + b, 0) || 1;
  const max = Math.max(...matrix.flat(), 1);
  return (
    <div className="overflow-x-auto">
      <table className="text-sm tabular-nums border-separate border-spacing-1">
        <thead>
          <tr><th /><th colSpan={labels.length} className="text-xs font-medium text-label-2 text-left pl-1">Predicted</th></tr>
          <tr>
            <th className="text-xs font-medium text-label-2 text-left pr-2">Actual</th>
            {labels.map(l => <th key={l} className="text-xs font-medium text-label-2 px-2 max-w-[8rem] truncate">{l}</th>)}
          </tr>
        </thead>
        <tbody>
          {matrix.map((row, i) => (
            <tr key={labels[i]}>
              <th className="text-xs font-medium text-label-2 text-left pr-2 max-w-[8rem] truncate">{labels[i]}</th>
              {row.map((v, j) => (
                <td key={j} className={`px-3 py-2 rounded-lg text-center min-w-[4rem] ${i === j ? 'text-label' : 'text-label'}`}
                  style={{ background: `color-mix(in srgb, var(${i === j ? '--blue' : '--orange'}) ${Math.round((v / max) * 35)}%, transparent)` }}>
                  <div className="font-semibold">{v.toLocaleString()}</div>
                  <div className="text-[11px] text-label-2">{pct(v / total, 1)}</div>
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
