/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useEffect, useMemo, useState } from 'react';
import { CartesianGrid, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import type { Dataset } from '../../types';
import { useCapability } from '../../engine/useCapability';
import { useLogRun } from '../../contexts/WorkspaceContext';
import RunBar from '../engine/RunBar';
import Provenance from '../engine/Provenance';
import { ResultFooter } from '../pins/PinButton';
import { DataTable, num, pct } from '../stats/methodKit';
import { CHART_COLORS } from '../../utils/chartTheme';
import { ModelPicker, modelName, useSelectedModel } from './models';
import { typicalRow } from './PredictPanel';

const NUMERIC = new Set(['integer', 'number', 'numeric', 'float']);

/** Suggested values to try: five even steps across a numeric column, or its categories. */
function suggest(f: string, dataset: Dataset): string {
  const col = dataset.columns.find(c => c.name === f);
  if (col?.type === 'numeric' && col.statistics.min != null && col.statistics.max != null) {
    const { min, max } = col.statistics as { min: number; max: number };
    return Array.from({ length: 5 }, (_, i) => Number((min + ((max - min) * i) / 4).toPrecision(3))).join(', ');
  }
  return [...new Set(dataset.rows.slice(0, 2000).map(r => r[f]).filter(v => v !== null && v !== undefined && v !== '').map(String))].slice(0, 8).join(', ');
}

export default function ScenariosPanel({ dataset }: { dataset: Dataset }) {
  const model = useSelectedModel();
  const run = useCapability('opt.scenarios', dataset);
  const logRun = useLogRun();
  const [base, setBase] = useState<Record<string, string>>({});
  const [vary, setVary] = useState<{ feature: string; values: string }[]>([]);
  useEffect(() => {
    if (!model) return;
    setBase(typicalRow(model, dataset));
    setVary(model.features[0] ? [{ feature: model.features[0], values: suggest(model.features[0], dataset) }] : []);
  }, [model, dataset]);

  const typed = (f: string, v: string) => (NUMERIC.has(String(model?.featureTypes?.[f])) && v.trim() !== '' && !Number.isNaN(Number(v)) ? Number(v) : v.trim());
  const params = useMemo(() => {
    if (!model) return null;
    return {
      model_id: model.id,
      base: Object.fromEntries(model.features.map(f => [f, base[f] === '' || base[f] === undefined ? null : typed(f, base[f])])),
      vary: Object.fromEntries(vary.filter(v => v.feature).map(v => [v.feature, v.values.split(',').map(x => x.trim()).filter(Boolean).map(x => typed(v.feature, x))])),
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [model, base, vary]);
  const combos: number = params ? (Object.values(params.vary) as unknown[][]).reduce((a: number, v) => a * Math.max(1, v.length), 1) : 0;
  const issue = !model ? 'Train or choose a saved model first.' : !vary.length || vary.some(v => !v.values.trim()) ? 'List the values to try for each input you vary.' : combos > 10000 ? 'Too many combinations (limit 10,000).' : null;

  const r = run.result as any;
  const cls = model?.task === 'classification';
  const positive = model?.positiveClass ?? model?.classes?.[1];
  const keys = r?.scenarios?.[0] ? Object.keys(r.scenarios[0].inputs) : [];
  const valueOf = (s: any) => (cls && s.probabilities && positive ? s.probabilities[positive] : typeof s.prediction === 'number' ? s.prediction : null);

  useEffect(() => {
    if (!r || !model) return;
    const vals = r.scenarios.map(valueOf).filter((v: any) => v != null) as number[];
    const range = vals.length ? `${cls ? pct(Math.min(...vals)) : num(Math.min(...vals), 4)} to ${cls ? pct(Math.max(...vals)) : num(Math.max(...vals), 4)}` : '';
    logRun({ kind: 'engine', title: `What-if with ${modelName(model)}`, summary: `Changing ${keys.join(' and ')} moves the ${cls ? `chance of ${positive}` : `predicted ${model.target}`} from ${range}.`, status: 'succeeded', params: { capability: 'opt.scenarios', params, runId: r.runId, view: { kind: 'scenarios' } }, result: r });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [r]);

  // One varied input → a line; two → one line per value of the second.
  const chart = useMemo(() => {
    if (!r?.scenarios?.length || !keys.length) return null;
    const [x, series] = keys;
    const groups = series ? [...new Set(r.scenarios.map((s: any) => String(s.inputs[series])))] as string[] : ['value'];
    const xs = [...new Set(r.scenarios.map((s: any) => s.inputs[x]))];
    const data = xs.map(xv => Object.fromEntries([[x, xv], ...groups.map(g => [g, valueOf(r.scenarios.find((s: any) => s.inputs[x] === xv && (!series || String(s.inputs[series]) === g)) ?? {})])]));
    return { x, groups, data, numericX: xs.every(v => typeof v === 'number') };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [r]);

  return (
    <div className="space-y-6">
      <div className="card p-4 sm:p-5 space-y-4" data-agent="area-scenarios">
        <div>
          <h3 className="card-title">What-if with a model</h3>
          <p className="mt-1 text-sm text-label-2">Start from a typical case, change one or two inputs across values you choose, and see how the model’s prediction responds.</p>
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4"><ModelPicker id="scenario-model" /></div>
        {model && <>
          <div className="space-y-2">
            <span className="field-label">Inputs to vary (comma-separated values)</span>
            {vary.map((v, i) => (
              <div key={i} className="grid grid-cols-1 sm:grid-cols-[minmax(0,12rem)_1fr_auto] gap-2 items-center">
                <select aria-label="Input to vary" className="input" value={v.feature} onChange={e => setVary(vs => vs.map((x, j) => (j === i ? { feature: e.target.value, values: suggest(e.target.value, dataset) } : x)))}>
                  {model.features.filter(f => f === v.feature || !vary.some(x => x.feature === f)).map(f => <option key={f} value={f}>{f}</option>)}
                </select>
                <input aria-label={`Values of ${v.feature}`} className="input" value={v.values} onChange={e => setVary(vs => vs.map((x, j) => (j === i ? { ...x, values: e.target.value } : x)))} />
                <button type="button" className="btn btn-plain !text-sm" disabled={vary.length <= 1} onClick={() => setVary(vs => vs.filter((_, j) => j !== i))}>Remove</button>
              </div>
            ))}
            {vary.length < 2 && model.features.length > 1 && (
              <button type="button" className="btn btn-plain -ml-2 !text-sm" onClick={() => { const f = model.features.find(x => !vary.some(v => v.feature === x))!; setVary(vs => [...vs, { feature: f, values: suggest(f, dataset) }]); }}>+ Vary a second input</button>
            )}
          </div>
          <details className="rounded-xl border border-separator p-3">
            <summary className="text-sm text-label cursor-pointer">Starting case (the other inputs stay at these values)</summary>
            <div className="mt-3 grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
              {model.features.filter(f => !vary.some(v => v.feature === f)).map(f => (
                <div key={f}><label className="field-label" htmlFor={`scn-${f}`}>{f}</label><input id={`scn-${f}`} className="input" value={base[f] ?? ''} onChange={e => setBase(b => ({ ...b, [f]: e.target.value }))} /></div>
              ))}
            </div>
          </details>
        </>}
        <RunBar run={run} label={`Try ${combos || ''} scenario${combos === 1 ? '' : 's'}`} agent="scenarios-run" disabled={!!issue} onRun={() => run.run(params as any)} />
        {issue && run.phase === 'idle' && <p className="text-xs text-label-3">{issue}</p>}
      </div>

      {r && chart && (
        <div className="card p-4 sm:p-5 space-y-4 animate-fade-in" role="region" aria-label="Scenarios">
          <p className="text-[17px] font-semibold text-label">{cls ? `Chance of ${positive}` : `Predicted ${model?.target}`} as {chart.x} changes{keys[1] ? `, for each ${keys[1]}` : ''}</p>
          <div className="h-64">
            <ResponsiveContainer>
              <LineChart data={chart.data} margin={{ left: -5, right: 8, top: 4 }}>
                <CartesianGrid stroke="var(--separator)" />
                <XAxis dataKey={chart.x} type={chart.numericX ? 'number' : 'category'} domain={['dataMin', 'dataMax']} tick={{ fontSize: 11, fill: 'var(--label-2)' }} />
                <YAxis tick={{ fontSize: 11, fill: 'var(--label-2)' }} tickFormatter={v => (cls ? pct(v) : num(v, 3))} domain={cls ? [0, 1] : ['auto', 'auto']} />
                <Tooltip formatter={(v: any) => (cls ? pct(v, 1) : num(v, 4))} />
                {chart.groups.map((g, i) => <Line key={g} dataKey={g} name={keys[1] ? `${keys[1]} = ${g}` : cls ? `P(${positive})` : 'Prediction'} stroke={CHART_COLORS[i % CHART_COLORS.length]} strokeWidth={2} isAnimationActive={false} />)}
              </LineChart>
            </ResponsiveContainer>
          </div>
          <DataTable rows={r.scenarios.map((s: any) => ({ ...s.inputs, prediction: s.prediction, p: valueOf(s) }))} limit={30}
            columns={[...keys.map(k => ({ key: k, label: k })), { key: 'prediction', label: 'Prediction' }, ...(cls ? [{ key: 'p', label: `P(${positive})`, format: (v: number) => pct(v, 1) }] : [])]} />
          <ResultFooter agent="pin-scenarios" provenance={<Provenance manifest={r.manifest} runId={r.runId} notes={r.notes} />}
            pin={{ title: `What-if with ${model ? modelName(model) : 'a model'}`, headline: `${cls ? `Chance of ${positive}` : `Predicted ${model?.target}`} as ${chart.x} changes${keys[1] ? `, for each ${keys[1]}` : ''}.`, view: { kind: 'scenarios' }, capability: 'opt.scenarios', params: params as Record<string, unknown>, result: r }} />
        </div>
      )}
    </div>
  );
}
