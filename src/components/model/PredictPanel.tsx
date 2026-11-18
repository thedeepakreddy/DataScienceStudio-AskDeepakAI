/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useEffect, useMemo, useState } from 'react';
import { Table as TableIcon } from 'lucide-react';
import type { Dataset } from '../../types';
import { engine, type ModelMeta, type PredictResponse } from '../../engine/client';
import { useCapability } from '../../engine/useCapability';
import { useLogRun } from '../../contexts/WorkspaceContext';
import { datasetFromRecords } from '../../utils/csvParser';
import RunBar from '../engine/RunBar';
import Provenance from '../engine/Provenance';
import Orb from '../Orb';
import { DataTable, num, pct } from '../stats/methodKit';
import { Bars } from './charts';
import { showValue } from './ExplainPanel';
import { ModelPicker, modelName, useSelectedModel } from './models';

const NUMERIC = new Set(['integer', 'number', 'numeric', 'float']);

/** A starting row for the form: the median of each numeric feature and the most common value of the others. */
export function typicalRow(model: Pick<ModelMeta, 'features' | 'featureTypes'>, dataset: Dataset): Record<string, string> {
  const out: Record<string, string> = {};
  for (const f of model.features) {
    const col = dataset.columns.find(c => c.name === f);
    const numeric = NUMERIC.has(String(model.featureTypes?.[f])) || col?.type === 'numeric';
    if (numeric && col?.statistics?.median != null) { out[f] = String(Number(col.statistics.median.toPrecision(6))); continue; }
    const counts = new Map<string, number>();
    for (const r of dataset.rows.slice(0, 5000)) { const v = r[f]; if (v !== null && v !== undefined && v !== '') counts.set(String(v), (counts.get(String(v)) ?? 0) + 1); }
    out[f] = [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? '';
  }
  return out;
}

function choicesFor(f: string, dataset: Dataset): string[] | null {
  const col = dataset.columns.find(c => c.name === f);
  if (!col || col.type === 'numeric' || col.distinctCount > 40) return null;
  return [...new Set(dataset.rows.slice(0, 5000).map(r => r[f]).filter(v => v !== null && v !== undefined && v !== '').map(String))].sort().slice(0, 40);
}

function SinglePrediction({ model, dataset }: { model: ModelMeta; dataset: Dataset }) {
  const [values, setValues] = useState<Record<string, string>>(() => typicalRow(model, dataset));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [res, setRes] = useState<PredictResponse | null>(null);
  useEffect(() => { setValues(typicalRow(model, dataset)); setRes(null); setError(null); }, [model, dataset]);
  const choices = useMemo(() => Object.fromEntries(model.features.map(f => [f, choicesFor(f, dataset)])), [model, dataset]);

  const predict = async () => {
    setBusy(true); setError(null);
    try {
      const row = Object.fromEntries(model.features.map(f => {
        const v = values[f];
        const numeric = NUMERIC.has(String(model.featureTypes?.[f]));
        return [f, v === '' ? null : numeric && !Number.isNaN(Number(v)) ? Number(v) : v];
      }));
      setRes(await engine.models.predict(model.id, [row], { explain: true, reasons: 5 }));
    } catch (err) {
      setError((err as Error)?.message || 'The prediction failed.');
    } finally { setBusy(false); }
  };

  const p = res?.predictions[0];
  const probs = p ? Object.entries(p).filter(([k]) => k.startsWith('probability_')).map(([k, v]) => [k.slice(12), v as number] as const).sort((a, b) => b[1] - a[1]) : [];
  return (
    <div className="card p-4 sm:p-5 space-y-4">
      <div>
        <h3 className="card-title">Predict one case</h3>
        <p className="mt-1 text-sm text-label-2">Start from a typical row, change what you like, and see the prediction with the reasons behind it.</p>
      </div>
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        {model.features.map(f => (
          <div key={f}>
            <label className="field-label" htmlFor={`pred-${f}`}>{f}</label>
            {choices[f]
              ? <select id={`pred-${f}`} className="input" value={values[f] ?? ''} onChange={e => setValues(v => ({ ...v, [f]: e.target.value }))}>
                  <option value="">(missing)</option>
                  {!choices[f]!.includes(values[f]) && values[f] && <option value={values[f]}>{values[f]}</option>}
                  {choices[f]!.map(c => <option key={c} value={c}>{c}</option>)}
                </select>
              : <input id={`pred-${f}`} className="input" value={values[f] ?? ''} inputMode={NUMERIC.has(String(model.featureTypes?.[f])) ? 'decimal' : 'text'} onChange={e => setValues(v => ({ ...v, [f]: e.target.value }))} />}
          </div>
        ))}
      </div>
      <div className="flex items-center gap-3">
        <button type="button" className="btn btn-primary" onClick={predict} disabled={busy} data-agent="predict-one">
          {busy ? <><Orb state="solving" onAccent label="Predicting" /> Predicting…</> : 'Predict'}
        </button>
        <button type="button" className="btn btn-plain" onClick={() => setValues(typicalRow(model, dataset))}>Reset to typical</button>
      </div>
      {error && <p className="text-sm text-red">{error}</p>}
      {p && (
        <div className="rounded-2xl bg-fill/60 p-4 space-y-3 animate-fade-in" role="status">
          <p className="text-[17px] font-semibold text-label">
            {model.task === 'classification'
              ? <>Prediction: {String(p.decision ?? p.prediction)}{probs[0] ? ` (${pct(probs.find(([c]) => c === String(p.decision ?? p.prediction))?.[1] ?? probs[0][1])} likely)` : ''}</>
              : <>Prediction: {num(p.prediction as number, 5)}{p.lower != null ? `, likely between ${num(p.lower, 4)} and ${num(p.upper, 4)}` : ''}</>}
          </p>
          {model.task === 'classification' && p.prediction_set && p.prediction_set.length > 1 && (
            <p className="text-sm text-label-2">The model can’t rule out: {p.prediction_set.join(', ')}.</p>
          )}
          {model.threshold != null && model.task === 'classification' && (
            <p className="text-xs text-label-3">Flags {model.positiveClass} above {pct(model.threshold)} (the cut-off chosen when it was trained).</p>
          )}
          {probs.length > 1 && <Bars rows={probs.map(([c, v]) => ({ label: c, value: v }))} format={v => pct(v, 1)} />}
          {p.reasons && p.reasons.length > 0 && (
            <div className="space-y-1.5">
              <p className="text-sm font-semibold text-label">Why</p>
              <ul className="text-sm text-label-2 space-y-1">
                {p.reasons.map(x => (
                  <li key={x.feature}>
                    <span className={x.effect >= 0 ? 'text-blue' : 'text-orange'}>{x.effect >= 0 ? '▲' : '▼'}</span>{' '}
                    <b className="text-label">{x.feature}</b> is {showValue(x.value)} (typical {showValue(x.typical)}){' '}
                    {model.task === 'classification' ? `— ${x.effect >= 0 ? 'raises' : 'lowers'} the chance of ${model.positiveClass ?? 'the predicted class'} by ${Math.abs(x.effect * 100).toFixed(1)} points` : `— ${x.effect >= 0 ? 'adds' : 'takes off'} ${num(Math.abs(x.effect), 3)}`}
                  </li>
                ))}
              </ul>
            </div>
          )}
          <p className="text-xs text-label-3">{modelName(model)} answered in {Math.round(res!.milliseconds)} ms. Logged for monitoring.</p>
        </div>
      )}
    </div>
  );
}

const PAGE = 10_000;
const MAX_IMPORT = 100_000;

function BatchPrediction({ model, dataset, onUseDataset }: { model: ModelMeta; dataset: Dataset; onUseDataset?: (d: Dataset, summary: string) => void }) {
  const run = useCapability('ml.predict', dataset);
  const logRun = useLogRun();
  const [preview, setPreview] = useState<{ columns: string[]; rows: Record<string, unknown>[] } | null>(null);
  const [importing, setImporting] = useState(false);
  const [importError, setImportError] = useState<string | null>(null);
  const r = run.result as any;
  const missing = model.features.filter(f => !dataset.columns.some(c => c.name === f));

  useEffect(() => {
    if (!r?.dataset?.id) return;
    setPreview(null);
    engine.datasets.preview(r.dataset.id, 20).then(setPreview).catch(() => setPreview(null));
    logRun({ kind: 'engine', title: `Scored ${dataset.filename} with ${modelName(model)}`, summary: `Predicted ${model.target} for ${Number(r.rows).toLocaleString()} rows.`, status: 'succeeded', params: { capability: 'ml.predict', params: { model_id: model.id }, runId: r.runId }, result: r });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [r]);

  const useScored = async () => {
    if (!onUseDataset || !r?.dataset?.id) return;
    setImporting(true); setImportError(null);
    try {
      const rows: Record<string, unknown>[] = [];
      let columns: string[] = [];
      for (let offset = 0; offset < Math.min(r.rows, MAX_IMPORT); offset += PAGE) {
        const page = await engine.datasets.query(r.dataset.id, `SELECT * FROM data LIMIT ${PAGE} OFFSET ${offset}`, PAGE);
        columns = page.columns;
        rows.push(...page.rows);
      }
      const next = datasetFromRecords(columns, rows, `${dataset.filename} (scored)`);
      onUseDataset(next, `Added ${modelName(model)}’s predictions for ${rows.length.toLocaleString()} rows`);
    } catch (err) {
      setImportError((err as Error)?.message || 'Could not load the scored data.');
    } finally { setImporting(false); }
  };

  return (
    <div className="card p-4 sm:p-5 space-y-4">
      <div>
        <h3 className="card-title">Score the whole dataset</h3>
        <p className="mt-1 text-sm text-label-2">Adds a prediction to every row of {dataset.filename} ({dataset.rowCount.toLocaleString()} rows){model.task === 'classification' ? ', with each class’s probability and the set of answers it can’t rule out' : ', with a range for each prediction'}.</p>
      </div>
      <RunBar run={run} label="Score all rows" agent="predict-batch" disabled={missing.length > 0} onRun={() => run.run({ model_id: model.id })} />
      {missing.length > 0 && <p className="text-xs text-label-3">This data lacks columns the model needs: {missing.join(', ')}.</p>}
      {r && (
        <div className="space-y-3 animate-fade-in">
          <p className="text-[17px] font-semibold text-label">Scored {Number(r.rows).toLocaleString()} rows.</p>
          {preview && <DataTable rows={preview.rows} limit={10} columns={[...model.features.slice(0, 3), ...preview.columns.filter(c => c === 'decision' || c === 'prediction' || c.startsWith('probability_') || c === 'lower' || c === 'upper' || c === 'prediction_set')]
            .filter(c => !(c === 'prediction' && preview.columns.includes('decision')))
            .map(c => ({ key: c, label: c === 'decision' ? `prediction (cut-off ${pct(model.threshold ?? 0.5)})` : c.startsWith('probability_') ? `P(${c.slice(12)})` : c === 'prediction_set' ? 'can’t rule out' : c,
              format: (v: any) => (c.startsWith('probability_') && typeof v === 'number' ? pct(v, 1) : typeof v === 'number' ? num(v, 4) : String(v ?? '—')) }))} />}
          {onUseDataset && (
            <button type="button" className="btn btn-secondary" onClick={useScored} disabled={importing}>
              {importing ? <><Orb state="connecting" label="Loading" /> Loading…</> : <><TableIcon className="w-4 h-4" /> Use the scored data in the studio</>}
            </button>
          )}
          {r.rows > MAX_IMPORT && <p className="text-xs text-label-3">The studio will load the first {MAX_IMPORT.toLocaleString()} rows; the engine keeps all {Number(r.rows).toLocaleString()}.</p>}
          {importError && <p className="text-sm text-red">{importError}</p>}
          <div className="border-t border-separator pt-3"><Provenance manifest={r.manifest} runId={r.runId} notes={r.notes} /></div>
        </div>
      )}
    </div>
  );
}

export default function PredictPanel({ dataset, onUseDataset }: { dataset: Dataset; onUseDataset?: (d: Dataset, summary: string) => void }) {
  const model = useSelectedModel();
  return (
    <div className="space-y-6" data-agent="area-predict">
      <div className="card p-4 sm:p-5 grid grid-cols-1 sm:grid-cols-2 gap-4">
        <ModelPicker id="predict-model" label="Predict with" />
        {model && <p className="text-sm text-label-2 self-end pb-2">Predicts <b className="text-label">{model.target}</b> from {model.features.length} column{model.features.length === 1 ? '' : 's'}.</p>}
      </div>
      {model ? <>
        <SinglePrediction model={model} dataset={dataset} />
        <BatchPrediction model={model} dataset={dataset} onUseDataset={onUseDataset} />
      </> : <p className="text-sm text-label-2">Train a model with AutoML (or choose a saved one) to make predictions.</p>}
    </div>
  );
}
