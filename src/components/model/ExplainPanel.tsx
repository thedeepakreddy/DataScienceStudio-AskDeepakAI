/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useEffect, useState } from 'react';
import { Bar, BarChart, CartesianGrid, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import type { Dataset } from '../../types';
import { useCapability } from '../../engine/useCapability';
import { useLogRun } from '../../contexts/WorkspaceContext';
import RunBar from '../engine/RunBar';
import Provenance from '../engine/Provenance';
import { Note, Section, num, pct } from '../stats/methodKit';
import { CHART_CURSOR } from '../../utils/chartTheme';
import { Bars } from './charts';
import { ModelPicker, modelName, useSelectedModel } from './models';

/** Midnight timestamps read as plain dates. */
export const showValue = (v: unknown) => (typeof v === 'string' ? v.replace(/^(\d{4}-\d{2}-\d{2})T00:00:00(?:\.0+)?(?:Z|[+-]00:?00)?$/, '$1') : String(v));

const axis = { tick: { fontSize: 11, fill: 'var(--label-2)' }, stroke: 'var(--separator)' };

/** Parses "1, 5, 20-22" into row positions (0-based for the engine; people count from 1). */
export function parseRows(text: string, max: number): number[] | null {
  const out: number[] = [];
  for (const part of text.split(/[,\s]+/).filter(Boolean)) {
    const m = part.match(/^(\d+)(?:-(\d+))?$/);
    if (!m) return null;
    const a = Number(m[1]), b = m[2] ? Number(m[2]) : a;
    for (let i = Math.min(a, b); i <= Math.max(a, b) && out.length < 20; i++) if (i >= 1 && i <= max) out.push(i - 1);
  }
  return [...new Set(out)];
}

const Dependence: React.FC<{ pd: { feature: string; grid: (number | string)[]; average: number[]; ice?: number[][] }; cls: boolean }> = ({ pd, cls }) => {
  const categorical = pd.grid.some(g => typeof g === 'string');
  // Enough decimals to tell ticks apart when the effect is small.
  const span = Math.max(...pd.average) - Math.min(...pd.average);
  const fmt = (v: number) => (cls ? pct(v, span < 0.02 ? 2 : 1) : num(v, span > 0 && span < 1e-2 ? 6 : 4));
  const data = pd.grid.map((g, i) => ({ x: g, avg: pd.average[i], ...Object.fromEntries((pd.ice ?? []).slice(0, 25).map((row, k) => [`i${k}`, row[i]])) }));
  return (
    <figure className="space-y-1.5 min-w-0">
      <figcaption className="text-sm font-semibold text-label truncate">{pd.feature}</figcaption>
      <div className="h-44">
        <ResponsiveContainer>
          {categorical ? (
            <BarChart data={data} margin={{ left: -12, right: 8 }}>
              <CartesianGrid stroke="var(--separator)" vertical={false} />
              <XAxis dataKey="x" {...axis} interval={0} /><YAxis {...axis} tickFormatter={fmt} domain={[(min: number) => Math.min(0, min), 'auto']} />
              <Tooltip cursor={CHART_CURSOR} formatter={(v: any) => fmt(v)} />
              <Bar dataKey="avg" name="Average prediction" fill="var(--blue)" isAnimationActive={false} />
            </BarChart>
          ) : (
            <LineChart data={data} margin={{ left: -12, right: 8 }}>
              <CartesianGrid stroke="var(--separator)" />
              <XAxis dataKey="x" type="number" domain={['dataMin', 'dataMax']} {...axis} tickFormatter={v => num(v, 3)} /><YAxis {...axis} tickFormatter={fmt} domain={['auto', 'auto']} />
              <Tooltip formatter={(v: any) => fmt(v)} labelFormatter={v => `${pd.feature} = ${num(Number(v), 4)}`} />
              {(pd.ice ?? []).slice(0, 25).map((_, k) => <Line key={k} dataKey={`i${k}`} stroke="var(--label-3)" strokeOpacity={0.35} dot={false} legendType="none" tooltipType="none" isAnimationActive={false} />)}
              <Line dataKey="avg" name="Average prediction" stroke="var(--blue)" strokeWidth={2.5} dot={false} isAnimationActive={false} />
            </LineChart>
          )}
        </ResponsiveContainer>
      </div>
    </figure>
  );
};

export default function ExplainPanel({ dataset }: { dataset: Dataset }) {
  const model = useSelectedModel();
  const run = useCapability('ml.explain', dataset);
  const logRun = useLogRun();
  const [rows, setRows] = useState('1-3');
  const [depth, setDepth] = useState(3);
  const parsed = parseRows(rows, dataset.rowCount);
  const missing = model ? model.features.filter(f => !dataset.columns.some(c => c.name === f)) : [];
  const issue = !model ? 'Train or choose a saved model first.' : missing.length ? `This data lacks columns the model needs: ${missing.join(', ')}.` : parsed === null ? 'Rows: use numbers like 1, 5, 10-12.' : null;
  const r = run.result as any;
  const cls = model?.task === 'classification';

  useEffect(() => {
    if (!r) return;
    const top = r.shapGlobal?.[0]?.feature;
    logRun({ kind: 'engine', title: `Explain ${r.model?.name ?? 'model'}`, summary: top ? `${top} has the biggest influence on its predictions (SHAP); a ${r.surrogate?.depth}-level rule tree matches it ${pct(r.surrogate?.fidelity)} of the time.` : 'Model explained.', status: 'succeeded', params: { capability: 'ml.explain', params: { model_id: model?.id }, runId: r.runId }, result: r });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [r]);

  const shap = r?.shapGlobal ?? [];
  const total = shap.reduce((a: number, s: any) => a + s.meanAbsShap, 0) || 1;
  // Permutation SHAP on a classifier explains probabilities; tree SHAP explains the model's raw score (log-odds for boosting).
  const probUnits = cls && String(r?.shapMethod ?? '').startsWith('Permutation');
  const units = !cls ? `units of ${model?.target}` : probUnits ? 'probability points' : 'the model’s internal score (log-odds), so compare sizes rather than read them as percentages';
  return (
    <div className="space-y-6">
      <div className="card p-4 sm:p-5 space-y-4" data-agent="area-explain">
        <div>
          <h3 className="card-title">Explain a model</h3>
          <p className="mt-1 text-sm text-label-2">Why the model predicts what it does: which columns matter overall (SHAP), how each one moves the prediction (partial dependence), the reasons behind individual rows, and plain if-then rules that mimic it.</p>
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
          <div className="sm:col-span-2"><ModelPicker id="explain-model" /></div>
          <div>
            <label className="field-label" htmlFor="explain-rows">Rows to explain one by one</label>
            <input id="explain-rows" className="input" value={rows} onChange={e => setRows(e.target.value)} placeholder="e.g. 1, 5, 10-12" />
          </div>
          <div>
            <label className="field-label" htmlFor="explain-depth">Rule depth</label>
            <select id="explain-depth" className="input" value={depth} onChange={e => setDepth(Number(e.target.value))}>
              {[2, 3, 4, 5].map(d => <option key={d} value={d}>{d} levels{d === 3 ? ' (readable)' : d >= 5 ? ' (detailed)' : ''}</option>)}
            </select>
          </div>
        </div>
        <RunBar run={run} label="Explain" agent="explain-run" disabled={!!issue}
          onRun={() => run.run({ model_id: model!.id, rows: parsed && parsed.length ? parsed : undefined, surrogate_depth: depth })} />
        {issue && run.phase === 'idle' && <p className="text-xs text-label-3">{issue}</p>}
      </div>

      {r && (
        <div className="card p-4 sm:p-5 space-y-6 animate-fade-in" role="region" aria-label="Explanation">
          <p className="text-[17px] font-semibold text-label">
            {shap[0] ? `${shap[0].feature} drives ${pct(shap[0].meanAbsShap / total)} of what moves ${model ? modelName(model) : 'the model'}’s predictions${shap[1] ? `, then ${shap[1].feature} (${pct(shap[1].meanAbsShap / total)})` : ''}.` : 'Explanation ready.'}
          </p>
          <Section title="What matters overall (average size of each column’s effect)">
            <Bars rows={shap.slice(0, 15).map((s: any) => ({ label: s.feature, value: s.meanAbsShap }))} format={v => num(v, 2)} />
            <p className="text-xs text-label-3">In {units}; computed with {r.shapMethod ?? 'SHAP'}.</p>
          </Section>

          {r.partialDependence?.length > 0 && (
            <Section title="How each column moves the prediction (blue: average; grey: individual rows)">
              <div className="grid grid-cols-1 md:grid-cols-2 gap-6">{r.partialDependence.map((pd: any) => <Dependence key={pd.feature} pd={pd} cls={cls} />)}</div>
            </Section>
          )}

          {r.local?.length > 0 && (
            <Section title="Reasons for individual rows">
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                {r.local.map((l: any) => (
                  <div key={l.row} className="rounded-xl border border-separator p-3 space-y-2">
                    <p className="text-sm font-semibold text-label">Row {l.row + 1}</p>
                    <p className="text-xs text-label-2 truncate" title={Object.entries(l.values).map(([k, v]) => `${k}: ${showValue(v)}`).join(' · ')}>
                      {Object.entries(l.values).slice(0, 6).map(([k, v]) => `${k}: ${showValue(v)}`).join(' · ')}
                    </p>
                    <Bars signed rows={l.reasons.slice(0, 6).map((x: any) => ({ label: x.feature, value: x.contribution }))} format={v => (probUnits ? `${v >= 0 ? '+' : ''}${(v * 100).toFixed(1)} pt` : `${v >= 0 ? '+' : ''}${num(v, 3)}`)} />
                  </div>
                ))}
              </div>
              <p className="text-xs text-label-3">Blue pushes the prediction up{cls ? ' (towards the positive class)' : ''}, orange pushes it down.</p>
            </Section>
          )}

          {r.surrogate?.rules && (
            <Section title={`The model as simple rules (${r.surrogate.depth} levels)`}>
              <Note tone={r.surrogate.fidelity >= 0.85 ? 'plain' : 'warn'}>
                These rules give the same answer as the model {pct(r.surrogate.fidelity)} of the time{r.surrogate.fidelityMeaning === 'r2' ? ' (R²)' : ''}.
                {r.surrogate.fidelity < 0.85 ? ' That’s too low to treat them as the model’s logic — use them as a rough sketch.' : ' A fair summary of its logic.'}
              </Note>
              <pre className="text-xs leading-relaxed bg-fill rounded-xl p-3 overflow-x-auto text-label">{r.surrogate.rules}</pre>
            </Section>
          )}
          <div className="border-t border-separator pt-3"><Provenance manifest={r.manifest} runId={r.runId} notes={r.notes} /></div>
        </div>
      )}
    </div>
  );
}
