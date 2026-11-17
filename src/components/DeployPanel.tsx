/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useCallback, useEffect, useState } from 'react';
import { AlertTriangle, CheckCircle2, Download, FileText, Trash2, Upload, XCircle } from 'lucide-react';
import { Dataset, MLResult } from '../types';
import { apiFetch } from '../utils/api';
import { useLogRun } from '../contexts/WorkspaceContext';
import {
  GateCheck, RegisteredModel, buildSchema, checkInput, gateBlocks, modelCardMarkdown, validationGate,
} from '../utils/modelRegistry';
import {
  deleteRegisteredModel, getVersion, listRegisteredModels, saveRegisteredModel, setActiveModel,
} from '../utils/workspaceStore';
import { ACCEPT_ATTRIBUTE, readDataFile } from '../utils/fileImport';
import Orb from './Orb';

type Tab = 'models' | 'predict' | 'monitor';

const pct = (v?: number) => (typeof v === 'number' ? `${(v * 100).toFixed(1)}%` : '—');
const scoreText = (m: RegisteredModel['metrics'], task: string) =>
  task === 'classification' ? `${pct(m.accuracy)} accuracy` : `R² ${typeof m.r2Score === 'number' ? m.r2Score.toFixed(3) : '—'}`;

function download(filename: string, text: string, type: string) {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

function toCsv(rows: Record<string, unknown>[], columns: string[]) {
  const cell = (v: unknown) => {
    if (v === null || v === undefined) return '';
    const s = String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return [columns.map(cell).join(','), ...rows.map(r => columns.map(c => cell(r[c])).join(','))].join('\n');
}

/**
 * Predicts with a registered model. If the ML service has restarted and lost
 * it, the model is rebuilt from its recipe - the same data version, columns,
 * settings and seed - which reproduces it, and the prediction is retried.
 */
async function predictWith(model: RegisteredModel, rows: Record<string, unknown>[], onRestored: (m: RegisteredModel, note: string) => void): Promise<unknown[]> {
  const call = async (modelId: string | null) => {
    if (!modelId) return null;
    const res = await apiFetch('/api/predict', { method: 'POST', body: JSON.stringify({ model_id: modelId, features: rows }) });
    if (res.status === 404) return null;
    const body = await res.json().catch(() => null);
    if (!res.ok || !body) throw new Error(body?.error || `Prediction failed (HTTP ${res.status}).`);
    return body.predictions as unknown[];
  };
  const first = await call(model.modelId);
  if (first) return first;

  const version = await getVersion(model.versionId);
  if (!version) throw new Error('This model’s training data is no longer saved in this browser, so it can’t be rebuilt. Train and register it again.');
  const res = await apiFetch('/api/run-ml-prediction', {
    method: 'POST',
    body: JSON.stringify({
      target: model.recipe.target, features: model.recipe.features, modelType: model.recipe.modelType,
      hyperparameters: { ...model.recipe.hyperparameters, selectedAlgorithmId: model.modelKey },
      datasetRows: version.dataset.rows, skipNarrative: true,
    }),
  });
  const body = await res.json().catch(() => null);
  if (!res.ok || !body?.modelId) throw new Error(body?.error || 'The model couldn’t be rebuilt.');
  const key = model.task === 'classification' ? 'accuracy' : 'r2Score';
  const same = body.metrics?.[key] === model.metrics[key as keyof typeof model.metrics];
  const restored = { ...model, modelId: body.modelId };
  onRestored(restored, same
    ? 'The ML service had restarted, so the model was rebuilt from its recipe; its test score matches the registered one exactly.'
    : 'The ML service had restarted, so the model was rebuilt from its recipe; its test score differs slightly from the registered one.');
  const second = await call(body.modelId);
  if (!second) throw new Error('The rebuilt model couldn’t be used. Try again.');
  return second;
}

export default function DeployPanel({ dataset, datasetId, activeVersionId, mlResult }: {
  dataset: Dataset;
  datasetId: string | null;
  activeVersionId: string | null;
  mlResult: MLResult | null;
}) {
  const logRun = useLogRun();
  const [tab, setTab] = useState<Tab>('models');
  const [models, setModels] = useState<RegisteredModel[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const refresh = useCallback(() => {
    if (!datasetId) return;
    listRegisteredModels(datasetId).then(setModels).catch(err => setError(String(err?.message || err)));
  }, [datasetId]);
  useEffect(refresh, [refresh]);

  const active = models.find(m => m.active) ?? null;
  const onRestored = async (m: RegisteredModel, note: string) => {
    await saveRegisteredModel(m);
    setNotice(note);
    refresh();
  };

  return (
    <section className="card p-5 sm:p-6 space-y-5" aria-labelledby="deploy-heading">
      <div>
        <h2 id="deploy-heading" className="card-title">Deploy & monitor</h2>
        <p className="mt-1 text-sm text-label-2">
          Register a trained model after it passes validation, use it for predictions, and check new data against what it was trained on.
          Registered models are kept in this browser; switching the active model is an instant rollback.
        </p>
      </div>
      <div className="segmented w-max" role="tablist" aria-label="Deploy and monitor">
        {([['models', 'Models'], ['predict', 'Predict'], ['monitor', 'Monitor']] as [Tab, string][]).map(([id, label]) => (
          <button key={id} type="button" role="tab" data-agent={`deploy-tab-${id}`} aria-selected={tab === id} onClick={() => { setTab(id); setError(null); }}>{label}</button>
        ))}
      </div>
      {notice && <p role="status" className="rounded-xl bg-blue/10 px-3 py-2.5 text-sm text-label">{notice}</p>}
      {error && (
        <p role="alert" className="flex items-start gap-2 rounded-xl bg-red/10 px-3 py-2.5 text-sm text-red">
          <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" /> {error}
        </p>
      )}

      {tab === 'models' && (
        <ModelsTab
          dataset={dataset} datasetId={datasetId} activeVersionId={activeVersionId} mlResult={mlResult}
          models={models} refresh={refresh} setError={setError} logRun={logRun}
        />
      )}
      {tab === 'predict' && (active
        ? <PredictTab model={active} onRestored={onRestored} setError={setError} />
        : <p className="text-sm text-label-2">Register a model and make it active to predict with it.</p>)}
      {tab === 'monitor' && (active
        ? <MonitorTab model={active} onRestored={onRestored} setError={setError} logRun={logRun} />
        : <p className="text-sm text-label-2">Register a model and make it active to monitor it.</p>)}
    </section>
  );
}

function GateList({ gate }: { gate: GateCheck[] }) {
  return (
    <ul className="space-y-1.5">
      {gate.map(g => (
        <li key={g.id} className="flex items-start gap-2 text-sm">
          {g.status === 'pass' ? <CheckCircle2 className="w-4 h-4 text-green shrink-0 mt-0.5" aria-label="Passed" />
            : g.status === 'warn' ? <AlertTriangle className="w-4 h-4 text-orange shrink-0 mt-0.5" aria-label="Warning" />
            : <XCircle className="w-4 h-4 text-red shrink-0 mt-0.5" aria-label="Failed" />}
          <span><span className="text-label">{g.title}.</span> <span className="text-label-2">{g.detail}</span></span>
        </li>
      ))}
    </ul>
  );
}

function ModelsTab({ dataset, datasetId, activeVersionId, mlResult, models, refresh, setError, logRun }: {
  dataset: Dataset; datasetId: string | null; activeVersionId: string | null; mlResult: MLResult | null;
  models: RegisteredModel[]; refresh: () => void; setError: (e: string | null) => void; logRun: ReturnType<typeof useLogRun>;
}) {
  const [name, setName] = useState('');
  const [use, setUse] = useState('');
  const [makeActive, setMakeActive] = useState(true);
  const gate = mlResult ? validationGate(mlResult, dataset) : [];
  const registered = mlResult?.modelId && models.some(m => m.modelId === mlResult.modelId);
  const canRegister = !!(mlResult?.modelId && mlResult.modelKey && datasetId && activeVersionId && !registered);

  const register = async () => {
    if (!mlResult || !canRegister) return;
    if (gateBlocks(gate)) return;
    try {
      const version = Math.max(0, ...models.map(m => m.version)) + 1;
      const entry: RegisteredModel = {
        id: crypto.randomUUID(),
        name: name.trim() || `${mlResult.target} model`,
        version, datasetId: datasetId!, versionId: activeVersionId!,
        recipe: {
          target: mlResult.target ?? '', features: mlResult.features ?? [],
          modelType: mlResult.modelType, hyperparameters: mlResult.hyperparameters ?? {},
        },
        modelKey: mlResult.modelKey!, modelId: mlResult.modelId ?? null,
        algorithm: mlResult.modelAlgorithm, task: mlResult.modelType,
        metrics: mlResult.metrics, cv: mlResult.cv as RegisteredModel['cv'], split: mlResult.split, seed: mlResult.seed, tuning: mlResult.tuning,
        topFeatures: (mlResult.featureImportance || []).slice(0, 10),
        schema: buildSchema(dataset, mlResult.features ?? []),
        gate, intendedUse: use, createdAt: Date.now(), active: false,
      };
      await saveRegisteredModel(entry);
      if (makeActive || models.length === 0) await setActiveModel(datasetId!, entry.id);
      logRun({ kind: 'other', title: `Registered ${entry.name} v${version}`, summary: scoreText(entry.metrics, entry.task), status: 'succeeded' });
      setName('');
      setUse('');
      refresh();
    } catch (err) {
      setError(`Couldn’t register the model: ${(err as Error).message}`);
    }
  };

  const card = async (m: RegisteredModel) => {
    const v = await getVersion(m.versionId).catch(() => undefined);
    download(`${m.name.replace(/[^A-Za-z0-9]+/g, '_')}_v${m.version}_model_card.md`, modelCardMarkdown(m, dataset.filename, v?.label ?? 'no longer saved'), 'text/markdown');
  };

  return (
    <div className="space-y-6">
      {mlResult?.modelId ? (
        <div className="rounded-2xl bg-well p-4 space-y-4">
          <p className="text-sm font-semibold text-label">Register the current model: {mlResult.modelAlgorithm} predicting {mlResult.target}</p>
          <GateList gate={gate} />
          {registered ? (
            <p className="text-sm text-label-2" data-agent="deploy-registered">This model is already registered.</p>
          ) : gateBlocks(gate) ? (
            <p className="text-sm text-red">It can’t be registered until the failed checks are fixed.</p>
          ) : (
            <>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div>
                  <label className="field-label" htmlFor="reg-name">Name</label>
                  <input id="reg-name" data-agent="deploy-name" className="input" value={name} onChange={e => setName(e.target.value)} placeholder={`${mlResult.target} model`} />
                </div>
                <div>
                  <label className="field-label" htmlFor="reg-use">Intended use (for the model card)</label>
                  <input id="reg-use" data-agent="deploy-use" className="input" value={use} onChange={e => setUse(e.target.value)} placeholder="e.g. Rank customers for retention calls" />
                </div>
              </div>
              <label className="flex items-center gap-2 text-sm text-label">
                <input type="checkbox" checked={makeActive} onChange={e => setMakeActive(e.target.checked)} /> Make it the active model
              </label>
              <button type="button" data-agent="deploy-register" onClick={register} disabled={!canRegister} className="btn btn-primary">Register Model</button>
              {!activeVersionId && <p className="text-xs text-label-2">Waiting for the data version to be saved…</p>}
            </>
          )}
        </div>
      ) : (
        <p className="text-sm text-label-2">Train a model above to register it.</p>
      )}

      {models.length > 0 && (
        <div className="overflow-x-auto">
          <table className="w-full text-sm tabular-nums">
            <thead><tr className="text-left text-xs text-label-2">{['Model', 'Algorithm', 'Score', 'Checks', 'Registered', ''].map(h => <th key={h} className="py-2 pr-4 font-medium">{h}</th>)}</tr></thead>
            <tbody className="divide-y divide-separator">
              {models.map(m => {
                const warns = m.gate.filter(g => g.status === 'warn').length;
                return (
                  <tr key={m.id}>
                    <td className="py-2 pr-4 text-label whitespace-nowrap">
                      {m.name} <span className="text-label-3">v{m.version}</span> {m.active && <span className="tag bg-green/12 text-green ml-1">Active</span>}
                    </td>
                    <td className="py-2 pr-4 text-label-2">{m.algorithm}</td>
                    <td className="py-2 pr-4 text-label">{scoreText(m.metrics, m.task)}</td>
                    <td className="py-2 pr-4 text-label-2">{warns ? `${warns} warning${warns === 1 ? '' : 's'}` : 'All passed'}</td>
                    <td className="py-2 pr-4 text-label-2 whitespace-nowrap">{new Date(m.createdAt).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}</td>
                    <td className="py-2 whitespace-nowrap space-x-1">
                      {!m.active && (
                        <button type="button" className="btn btn-sm btn-secondary" onClick={async () => { await setActiveModel(m.datasetId, m.id); refresh(); }}>
                          Make Active
                        </button>
                      )}
                      <button type="button" className="btn btn-sm btn-plain" onClick={() => card(m)}><FileText className="w-3.5 h-3.5" /> Model Card</button>
                      <button
                        type="button"
                        className="btn btn-icon w-8 h-8 text-red hover:bg-red/10"
                        aria-label={`Delete ${m.name} v${m.version}`}
                        onClick={async () => { if (window.confirm(`Delete ${m.name} v${m.version} from the registry?`)) { await deleteRegisteredModel(m.id); refresh(); } }}
                      >
                        <Trash2 className="w-4 h-4" />
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function PredictTab({ model, onRestored, setError }: {
  model: RegisteredModel; onRestored: (m: RegisteredModel, note: string) => void; setError: (e: string | null) => void;
}) {
  const initial = Object.fromEntries(model.schema.map(f => [f.name, f.type === 'numeric' ? (f.mean !== undefined ? String(Number(f.mean.toFixed(2))) : '') : (f.values?.[0] ?? '')]));
  const [inputs, setInputs] = useState<Record<string, string>>(initial);
  const [busy, setBusy] = useState<'one' | 'file' | null>(null);
  const [prediction, setPrediction] = useState<unknown>(undefined);
  const [batch, setBatch] = useState<{ name: string; rows: Record<string, unknown>[]; columns: string[]; warnings: number } | null>(null);

  const row = Object.fromEntries(model.schema.map(f => {
    const v = inputs[f.name];
    return [f.name, v === '' ? null : f.type === 'numeric' ? Number(v) : f.type === 'boolean' ? v === 'true' : v];
  }));
  const warnings = checkInput(model.schema, row);

  const predictOne = async () => {
    setBusy('one');
    setError(null);
    try {
      const [p] = await predictWith(model, [row], onRestored);
      setPrediction(p);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(null);
    }
  };

  const predictFile = async (file: File | undefined) => {
    if (!file) return;
    setBusy('file');
    setError(null);
    setBatch(null);
    try {
      const { dataset } = await readDataFile(file);
      const missing = model.recipe.features.filter(f => !dataset.columns.some(c => c.name === f));
      if (missing.length) throw new Error(`The file is missing ${missing.length === 1 ? 'a column' : 'columns'} the model needs: ${missing.join(', ')}.`);
      const out: unknown[] = [];
      for (let i = 0; i < dataset.rows.length; i += 2000) {
        const chunk = dataset.rows.slice(i, i + 2000).map(r => Object.fromEntries(model.recipe.features.map(f => [f, r[f]])));
        out.push(...await predictWith(model, chunk, onRestored));
      }
      const col = `predicted_${model.recipe.target}`;
      const rows = dataset.rows.map((r, i) => ({ ...r, [col]: out[i] }));
      const warn = dataset.rows.filter(r => checkInput(model.schema, r).some(w => !w.includes('is empty'))).length;
      setBatch({ name: file.name.replace(/\.[^.]+$/, ''), rows, columns: [...dataset.columns.map(c => c.name), col], warnings: warn });
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="space-y-6">
      <p className="text-sm text-label-2">Using <span className="font-medium text-label">{model.name} v{model.version}</span> ({model.algorithm}).</p>
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
        {model.schema.map(f => (
          <div key={f.name}>
            <label className="field-label" htmlFor={`pred-${f.name}`}>{f.name}</label>
            {f.type !== 'numeric' && f.values && f.values.length <= 50 ? (
              <select id={`pred-${f.name}`} data-agent={`pred-${f.name}`} className="input" value={inputs[f.name] ?? ''} onChange={e => setInputs({ ...inputs, [f.name]: e.target.value })}>
                <option value="">(empty)</option>
                {f.values.map(v => <option key={v} value={v}>{v}</option>)}
              </select>
            ) : (
              <input id={`pred-${f.name}`} data-agent={`pred-${f.name}`} className="input" inputMode={f.type === 'numeric' ? 'decimal' : undefined} value={inputs[f.name] ?? ''} onChange={e => setInputs({ ...inputs, [f.name]: e.target.value })} />
            )}
            {f.type === 'numeric' && f.min !== undefined && <p className="mt-1 text-[11px] text-label-3">Training range {f.min} – {f.max}</p>}
          </div>
        ))}
      </div>
      {warnings.length > 0 && (
        <ul className="space-y-1">{warnings.map(w => <li key={w} className="flex items-start gap-2 text-xs text-orange"><AlertTriangle className="w-3.5 h-3.5 shrink-0 mt-0.5" />{w}</li>)}</ul>
      )}
      <div className="flex flex-wrap items-center gap-3">
        <button type="button" data-agent="deploy-predict" onClick={predictOne} disabled={!!busy} aria-busy={busy === 'one'} className="btn btn-primary">
          {busy === 'one' ? <><Orb state="solving" onAccent label="Predicting" /> Predicting…</> : 'Predict'}
        </button>
        {prediction !== undefined && (
          <p role="status" data-agent="deploy-prediction" className="text-[17px] text-label">Predicted {model.recipe.target}: <span className="font-semibold">{typeof prediction === 'number' ? Number(prediction.toFixed(4)).toLocaleString() : String(prediction)}</span></p>
        )}
      </div>

      <div className="pt-5 border-t border-separator space-y-3">
        <p className="text-sm font-semibold text-label">Predict a whole file</p>
        <label className="btn btn-secondary cursor-pointer w-max">
          {busy === 'file' ? <><Orb state="solving" label="Predicting the file" /> Predicting…</> : <><Upload className="w-4 h-4" /> Choose a File</>}
          <input type="file" accept={ACCEPT_ATTRIBUTE} className="hidden" onChange={e => { predictFile(e.target.files?.[0]); e.target.value = ''; }} />
        </label>
        {batch && (
          <div className="space-y-2">
            <p className="text-sm text-label">
              Predicted {batch.rows.length.toLocaleString()} rows.
              {batch.warnings > 0 && <span className="text-orange"> {batch.warnings.toLocaleString()} have values outside the training data.</span>}
            </p>
            <button type="button" className="btn btn-sm btn-secondary" onClick={() => download(`${batch.name}_predictions.csv`, toCsv(batch.rows, batch.columns), 'text/csv')}>
              <Download className="w-4 h-4" /> Download CSV
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

interface DriftFeature {
  feature: string; type?: string; level?: string; psi?: number; pValue?: number; test?: string; skipped?: string; missingColumn?: boolean;
  reference?: { mean: number }; current?: { mean: number }; unseenValues?: string[]; unseenRows?: number; outsideTrainingRange?: number;
}

function MonitorTab({ model, onRestored, setError, logRun }: {
  model: RegisteredModel; onRestored: (m: RegisteredModel, note: string) => void; setError: (e: string | null) => void; logRun: ReturnType<typeof useLogRun>;
}) {
  const [busy, setBusy] = useState(false);
  const [report, setReport] = useState<{ file: string; rows: number; overall: string; features: DriftFeature[]; performance?: string } | null>(null);

  const run = async (file: File | undefined) => {
    if (!file) return;
    setBusy(true);
    setError(null);
    setReport(null);
    try {
      const [{ dataset: current }, version] = await Promise.all([readDataFile(file), getVersion(model.versionId)]);
      if (!version) throw new Error('This model’s training data is no longer saved in this browser, so there’s nothing to compare against.');
      const pick = (rows: Record<string, any>[]) => {
        const step = Math.max(1, Math.ceil(rows.length / 20000));
        return rows.filter((_, i) => i % step === 0).map(r => Object.fromEntries(model.recipe.features.map(f => [f, r[f] ?? null])));
      };
      const res = await apiFetch('/api/monitor/drift', {
        method: 'POST',
        body: JSON.stringify({ reference_data: pick(version.dataset.rows), current_data: pick(current.rows), features: model.recipe.features }),
      });
      const body = await res.json().catch(() => null);
      if (!res.ok || !body) throw new Error(body?.error || `The drift check failed (HTTP ${res.status}).`);

      // If the new data includes the real outcome, measure how the model does on it.
      let performance: string | undefined;
      const target = model.recipe.target;
      const labelled = current.rows.filter(r => r[target] !== null && r[target] !== undefined && r[target] !== '');
      if (labelled.length >= 10 && model.recipe.features.every(f => current.columns.some(c => c.name === f))) {
        const rows = labelled.slice(0, 5000);
        const preds = await predictWith(model, rows.map(r => Object.fromEntries(model.recipe.features.map(f => [f, r[f]]))), onRestored);
        if (model.task === 'classification') {
          const acc = preds.filter((p, i) => String(p) === String(rows[i][target])).length / rows.length;
          performance = `${pct(acc)} accuracy on ${rows.length.toLocaleString()} new labelled rows (registered: ${pct(model.metrics.accuracy)}).`;
        } else {
          const ys = rows.map(r => Number(r[target]));
          const mean = ys.reduce((a, b) => a + b, 0) / ys.length;
          const ssTot = ys.reduce((a, y) => a + (y - mean) ** 2, 0);
          const ssRes = ys.reduce((a, y, i) => a + (y - Number(preds[i])) ** 2, 0);
          performance = `R² ${(1 - ssRes / ssTot).toFixed(3)} on ${rows.length.toLocaleString()} new labelled rows (registered: ${model.metrics.r2Score?.toFixed(3)}).`;
        }
      }
      setReport({ file: file.name, rows: current.rows.length, overall: body.overall, features: body.features, performance });
      logRun({ kind: 'other', title: `Drift check: ${model.name} v${model.version} vs ${file.name}`, summary: `${body.overall} drift${performance ? ` · ${performance.split(' on ')[0]}` : ''}`, status: 'succeeded', result: body });
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const tone = (l?: string) => (l === 'major' ? 'bg-red/12 text-red' : l === 'moderate' ? 'bg-orange/12 text-orange' : 'bg-green/12 text-green');

  return (
    <div className="space-y-5">
      <p className="text-sm text-label-2">
        Choose a file of newer data. Each feature is compared with <span className="font-medium text-label">{model.name} v{model.version}</span>’s training data
        (population stability index plus a KS or chi-squared test). If the file also has the real {model.recipe.target}, the model’s accuracy on it is measured too.
      </p>
      <label className="btn btn-secondary cursor-pointer w-max">
        {busy ? <><Orb state="searching" label="Checking for drift" /> Checking…</> : <><Upload className="w-4 h-4" /> Choose New Data</>}
        <input type="file" accept={ACCEPT_ATTRIBUTE} className="hidden" onChange={e => { run(e.target.files?.[0]); e.target.value = ''; }} />
      </label>
      {report && (
        <div className="space-y-4 animate-fade-in" role="region" aria-label="Drift report">
          <p className="text-[17px] font-semibold text-label">
            {report.overall === 'stable' ? 'No meaningful drift' : report.overall === 'moderate' ? 'Some features have shifted' : 'Major drift: the new data differs from the training data'}
            <span className="ml-2 text-sm font-normal text-label-2">({report.rows.toLocaleString()} rows in {report.file})</span>
          </p>
          {report.performance && <p className="text-sm text-label">{report.performance}</p>}
          <div className="overflow-x-auto">
            <table className="w-full text-sm tabular-nums">
              <thead><tr className="text-left text-xs text-label-2">{['Feature', 'Shift', 'PSI', 'Test p', 'Details'].map(h => <th key={h} className="py-1.5 pr-4 font-medium">{h}</th>)}</tr></thead>
              <tbody className="divide-y divide-separator">
                {report.features.map(f => (
                  <tr key={f.feature}>
                    <td className="py-1.5 pr-4 text-label">{f.feature}</td>
                    <td className="py-1.5 pr-4">{f.level && <span className={`tag ${tone(f.level)}`}>{f.missingColumn ? 'missing' : f.level}</span>}</td>
                    <td className="py-1.5 pr-4 text-label-2">{typeof f.psi === 'number' ? f.psi.toFixed(3) : '—'}</td>
                    <td className="py-1.5 pr-4 text-label-2">{typeof f.pValue === 'number' ? (f.pValue < 0.001 ? '< 0.001' : f.pValue.toFixed(3)) : '—'}</td>
                    <td className="py-1.5 text-label-2">
                      {f.missingColumn ? 'Not in the new data.'
                        : f.skipped ? f.skipped
                        : f.type === 'numeric' ? `Average ${Number(f.reference?.mean?.toFixed(2))} → ${Number(f.current?.mean?.toFixed(2))}${f.outsideTrainingRange ? `; ${f.outsideTrainingRange} values outside the training range` : ''}`
                        : f.unseenRows ? `${f.unseenRows} rows with values never seen in training (${(f.unseenValues ?? []).slice(0, 3).join(', ')})` : 'Category mix compared.'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="text-xs text-label-3">PSI under 0.1 is stable, 0.1–0.25 a moderate shift, above 0.25 a major shift.</p>
        </div>
      )}
    </div>
  );
}
