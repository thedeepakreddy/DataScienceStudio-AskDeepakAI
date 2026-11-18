/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useEffect, useState } from 'react';
import { CalendarClock, Play, RefreshCcw } from 'lucide-react';
import { engine, type CapabilityName, type EngineJob, type PipelineStep, type RunRecord } from '../../engine/client';
import { syncDataset } from '../../engine/datasetSync';
import type { Dataset } from '../../types';
import Orb from '../Orb';
import { ModelPicker, metricLabel, modelName, useModels, useSelectedModel } from './models';

const EVERY = [{ label: 'Every day', minutes: 1440 }, { label: 'Every week', minutes: 10080 }, { label: 'Every hour', minutes: 60 }, { label: 'Every 6 hours', minutes: 360 }];

/**
 * Watches a model and retrains it when its data drifts or its accuracy decays: one
 * engine step (check → retrain with the model's own settings → register → promote),
 * run now or on a schedule. The new data is this dataset, or a fresh re-import.
 */
export default function RetrainPanel({ dataset, onScheduled }: { dataset: Dataset | null; onScheduled: () => void }) {
  const model = useSelectedModel();
  const { refresh } = useModels();
  const [imports, setImports] = useState<RunRecord[]>([]);
  const [source, setSource] = useState('current');
  const [when, setWhen] = useState<'alert' | 'warning' | 'always'>('alert');
  const [promote, setPromote] = useState<'staging' | 'production_if_better' | 'none'>('staging');
  const [every, setEvery] = useState(1440);
  const [busy, setBusy] = useState<string | null>(null);
  const [job, setJob] = useState<EngineJob | null>(null);
  const [result, setResult] = useState<any>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    engine.runs.list({ limit: 60 }).then(rs => {
      const seen = new Set<string>();
      setImports(rs.filter(r => r.status === 'done' && r.capability.startsWith('connect.') && r.capability !== 'connect.sql')
        .filter(r => { const k = `${r.capability}|${r.paramsFingerprint}`; if (seen.has(k)) return false; seen.add(k); return true; }));
    }).catch(() => setImports([]));
  }, []);
  useEffect(() => { if (source === 'current' && !dataset) setSource(imports[0]?.id ?? 'current'); }, [dataset, imports, source]);

  useEffect(() => {
    if (!job || ['done', 'error', 'cancelled'].includes(job.status)) return;
    const t = setTimeout(() => engine.jobs.get(job.id).then(setJob).catch(() => {}), 1500);
    return () => clearTimeout(t);
  }, [job]);
  useEffect(() => {
    if (job?.status !== 'done') return;
    engine.jobs.result<any>(job.id).then(r => { setResult(r.final ?? r); refresh(); }).catch(e => setError((e as Error).message));
  }, [job?.status, job?.id, refresh]);

  const steps = async (): Promise<PipelineStep[]> => {
    const params = { model: model!.name ? `${model!.name}@${model!.stage === 'production' ? 'production' : 'latest'}` : model!.id, retrain_when: when, promote };
    if (source === 'current') {
      const meta = await syncDataset(dataset!);
      return [{ capability: 'mlops.retrain_if_drift' as CapabilityName, dataset_id: meta.id, params }];
    }
    const imp = imports.find(r => r.id === source)!;
    return [{ capability: imp.capability as CapabilityName, dataset_id: null, params: imp.params }, { capability: 'mlops.retrain_if_drift' as CapabilityName, dataset_id: '$prev', params }];
  };
  const act = async (label: string, fn: () => Promise<unknown>) => {
    setBusy(label); setError(null);
    try { await fn(); } catch (e) { setError((e as Error).message); } finally { setBusy(null); }
  };
  const label = model ? `Retrain ${modelName(model)} when drift is found` : '';
  const issue = !model ? 'Choose a model.' : source === 'current' && !dataset ? 'Load data, or pick a re-import.' : !model.target ? 'This model has no target to retrain on.' : null;

  return (
    <div className="card p-4 sm:p-5 space-y-4" data-agent="area-retrain">
      <div>
        <h3 className="card-title flex items-center gap-2"><RefreshCcw className="w-4 h-4 text-blue" /> Retrain when drift is found</h3>
        <p className="mt-1 text-sm text-label-2">Checks the model against new data. If the data has drifted or accuracy has dropped, it retrains with the model’s own AutoML settings, saves a new version and, if you choose, promotes it. Production only changes when the new version beats the current one on the new data.</p>
      </div>
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        <ModelPicker id="retrain-model" label="Model" />
        <div>
          <label className="field-label" htmlFor="retrain-source">New data</label>
          <select id="retrain-source" data-agent="retrain-source" className="input" value={source} onChange={e => setSource(e.target.value)}>
            {dataset && <option value="current">This data ({dataset.filename})</option>}
            {imports.map(r => <option key={r.id} value={r.id}>Fresh re-import: {String((r.params as any)?.name ?? (r.params as any)?.url ?? r.dataset?.name ?? r.capability)}</option>)}
          </select>
        </div>
        <div>
          <label className="field-label" htmlFor="retrain-when">Retrain when</label>
          <select id="retrain-when" data-agent="retrain-when" className="input" value={when} onChange={e => setWhen(e.target.value as any)}>
            <option value="alert">Clear drift or decay (alert)</option>
            <option value="warning">Any sign of drift (warning)</option>
            <option value="always">Always (every run)</option>
          </select>
        </div>
        <div>
          <label className="field-label" htmlFor="retrain-promote">New version goes to</label>
          <select id="retrain-promote" data-agent="retrain-promote" className="input" value={promote} onChange={e => setPromote(e.target.value as any)}>
            <option value="staging">Staging (you approve)</option>
            <option value="production_if_better">Production, if it’s better</option>
            <option value="none">Saved only</option>
          </select>
        </div>
        <div>
          <label className="field-label" htmlFor="retrain-every">Check</label>
          <select id="retrain-every" data-agent="retrain-every" className="input" value={every} onChange={e => setEvery(Number(e.target.value))}>
            {EVERY.map(x => <option key={x.minutes} value={x.minutes}>{x.label}</option>)}
          </select>
        </div>
        <div className="sm:col-span-1 lg:col-span-3 flex flex-wrap gap-2 items-end">
          <button type="button" className="btn btn-secondary" disabled={!!issue || !!busy || ['queued', 'running'].includes(job?.status ?? '')} data-agent="retrain-run"
            onClick={() => act('run', async () => { setResult(null); setJob((await engine.pipelines.run({ steps: await steps(), name: label })).job); })}>
            <Play className="w-4 h-4" /> Check now
          </button>
          <button type="button" className="btn btn-primary" disabled={!!issue || !!busy} data-agent="retrain-schedule"
            onClick={() => act('schedule', async () => { await engine.schedules.create({ steps: await steps(), every_minutes: every, name: label }); onScheduled(); })}>
            <CalendarClock className="w-4 h-4" /> {busy === 'schedule' ? 'Scheduling…' : 'Schedule it'}
          </button>
          {issue && <span className="text-xs text-label-3 pb-2">{issue}</span>}
        </div>
      </div>
      {error && <p className="text-sm text-red" role="alert">{error}</p>}
      {job && ['queued', 'running'].includes(job.status) && <p className="text-sm text-label-2" role="status"><Orb state="solving" label="Running" /> {job.message} · {Math.round(job.progress * 100)}%</p>}
      {job?.status === 'error' && <p className="text-sm text-red" role="alert">{job.error?.message}</p>}
      {result && (
        <div className={`rounded-xl px-3 py-2.5 text-sm ${result.retrained ? 'bg-green/10' : 'bg-fill'}`} role="status" data-agent="retrain-result">
          <p className="font-medium text-label">{result.decision}</p>
          <p className="mt-1 text-xs text-label-2">
            {result.summary?.featuresDrifted ?? 0} of {result.summary?.featuresChecked ?? 0} columns drifted{result.alerts?.length ? ` · ${result.alerts.map((a: any) => a.message).join(' ')}` : ''}
          </p>
          {result.retrained && result.comparison?.metric && (
            <p className="mt-1 text-xs text-label-2">
              {metricLabel(result.comparison.metric)}: current model {fmt(result.comparison.currentModelOnNewData)} on the new data · new version {fmt(result.comparison.newModelOnTest)} on held-out rows
              {result.comparison.newIsBetter != null ? (result.comparison.newIsBetter ? ' — the new version is better.' : ' — the new version is not better, so production is unchanged.') : '.'}
            </p>
          )}
        </div>
      )}
    </div>
  );
}

const fmt = (x: unknown) => (typeof x === 'number' ? x.toFixed(3) : '—');
