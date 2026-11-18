/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useCallback, useEffect, useState } from 'react';
import { AlertTriangle, CheckCircle2, Info } from 'lucide-react';
import type { Dataset } from '../../types';
import { engine } from '../../engine/client';
import { useCapability } from '../../engine/useCapability';
import { useLogRun } from '../../contexts/WorkspaceContext';
import RunBar from '../engine/RunBar';
import Provenance from '../engine/Provenance';
import { ResultFooter } from '../pins/PinButton';
import { DataTable, Section, num, pct } from '../stats/methodKit';
import { ModelPicker, metricLabel, modelName, useSelectedModel } from './models';

const STATUS = {
  ok: { label: 'Healthy', cls: 'bg-green/12 text-green', Icon: CheckCircle2 },
  warning: { label: 'Watch', cls: 'bg-orange/12 text-orange', Icon: AlertTriangle },
  alert: { label: 'Action needed', cls: 'bg-red/12 text-red', Icon: AlertTriangle },
  insufficient_data: { label: 'Too little data', cls: 'bg-fill text-label-2', Icon: Info },
} as const;

export const StatusPill = ({ status }: { status: string }) => {
  const s = STATUS[status as keyof typeof STATUS] ?? STATUS.insufficient_data;
  return <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium ${s.cls}`}><s.Icon className="w-3.5 h-3.5" /> {s.label}</span>;
};

/** One sentence on a monitoring report. */
export function monitorHeadline(r: any): string {
  if (r?.summary?.status === 'insufficient_data') return `Only ${r.summary.rows} rows — too few to judge drift reliably.`;
  const perf = r?.performance?.relativeDrop != null
    ? `; ${metricLabel(r.performance.primaryMetric)} is ${r.performance.relativeDrop > 0.005 ? `${pct(r.performance.relativeDrop)} worse than` : 'as good as'} at training` : '';
  return `${r?.summary?.featuresDrifted ?? 0} of ${r?.summary?.featuresChecked ?? 0} columns have drifted${perf}.`;
}

const PSI_HELP = 'PSI (population stability index): below 0.1 is stable, 0.1–0.25 a moderate shift, above 0.25 a large shift.';

export default function MonitorPanel({ dataset }: { dataset: Dataset }) {
  const model = useSelectedModel();
  const run = useCapability('mlops.monitor', dataset);
  const logRun = useLogRun();
  const [history, setHistory] = useState<any[]>([]);
  const hasTarget = !!model && dataset.columns.some(c => c.name === model.target);
  const [useTarget, setUseTarget] = useState(true);
  const r = run.result as any;
  const [ranParams, setRanParams] = useState<Record<string, unknown>>({});

  const loadHistory = useCallback(() => {
    if (!model) { setHistory([]); return; }
    engine.models.monitoring(model.id, 20).then(setHistory).catch(() => setHistory([]));
  }, [model]);
  useEffect(loadHistory, [loadHistory]);

  useEffect(() => {
    if (!r) return;
    loadHistory();
    logRun({ kind: 'engine', title: `Monitor ${model ? modelName(model) : 'model'}`, summary: `${STATUS[r.summary?.status as keyof typeof STATUS]?.label ?? r.summary?.status}: ${r.summary?.featuresDrifted ?? 0} of ${r.summary?.featuresChecked ?? 0} columns drifted${r.alerts?.length ? `; ${r.alerts.map((a: any) => a.message).join(' ')}` : '.'}`, status: 'succeeded', params: { capability: 'mlops.monitor', params: ranParams, runId: r.runId, view: { kind: 'monitor' } }, result: r });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [r]);

  return (
    <div className="space-y-6">
      <div className="card p-4 sm:p-5 space-y-4" data-agent="area-monitor">
        <div>
          <h3 className="card-title">Monitor a model</h3>
          <p className="mt-1 text-sm text-label-2">Checks whether new data still looks like what the model learned from (drift), whether its predictions have shifted, and — if the data includes the real outcomes — whether it has become less accurate.</p>
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <ModelPicker id="monitor-model" />
          {hasTarget && <label className="flex items-center gap-2 text-sm text-label self-end pb-2"><input type="checkbox" checked={useTarget} onChange={e => setUseTarget(e.target.checked)} /> This data has the real {model!.target} — check accuracy too</label>}
        </div>
        <RunBar run={run} label={`Check against ${dataset.filename}`} agent="monitor-run" disabled={!model}
          onRun={() => { const p = { model: model!.id, source: 'dataset', ...(hasTarget && useTarget ? { target: model!.target } : {}) }; setRanParams(p); run.run(p, { withDataset: true }); }} />
        {!model && <p className="text-xs text-label-3">Train or choose a saved model first.</p>}
      </div>

      {r && (
        <div className="card p-4 sm:p-5 space-y-5 animate-fade-in" role="region" aria-label="Monitoring report">
          <div className="flex flex-wrap items-center gap-3">
            <StatusPill status={r.summary?.status} />
            <p className="text-[17px] font-semibold text-label">{monitorHeadline(r)}</p>
          </div>
          {r.alerts?.length > 0 && (
            <ul className="space-y-1.5">
              {r.alerts.map((a: any, i: number) => (
                <li key={i} className={`rounded-xl px-3 py-2 text-sm ${a.level === 'alert' ? 'bg-red/10 text-red' : 'bg-orange/10 text-orange'}`}><b className="capitalize">{a.kind}:</b> {a.message}</li>
              ))}
            </ul>
          )}
          {r.performance?.current && (
            <Section title="Accuracy then and now">
              <DataTable rows={Object.keys(r.performance.current).filter(k => r.performance.reference?.[k] != null).slice(0, 8).map(k => ({ metric: metricLabel(k), then: r.performance.reference[k], now: r.performance.current[k] }))}
                columns={[{ key: 'metric', label: 'Measure' }, { key: 'then', label: 'At training (test rows)' }, { key: 'now', label: `On ${r.performance.rows?.toLocaleString()} new rows` }]} />
            </Section>
          )}
          <Section title="Drift per column">
            <DataTable rows={r.features ?? []} limit={30} columns={[
              { key: 'feature', label: 'Column' },
              { key: 'status', label: '', format: (s: string) => <StatusPill status={s} /> },
              { key: 'psi', label: 'PSI', format: (v: number) => num(v, 2) },
              { key: 'referenceMean', label: 'Was', format: (v: any, row: any) => (row.kind === 'numeric' ? num(v, 4) : row.newCategories?.length ? `new: ${row.newCategories.slice(0, 3).join(', ')}` : '—') },
              { key: 'currentMean', label: 'Now', format: (v: any, row: any) => (row.kind === 'numeric' ? num(v, 4) : '—') },
              { key: 'issue', label: 'Note', format: (v: any, row: any) => v ?? (row.missing?.current > row.missing?.reference + 0.05 ? `${pct(row.missing.current)} missing` : '') },
            ]} />
            <p className="text-xs text-label-3">{PSI_HELP}</p>
          </Section>
          {r.predictionDrift && (
            <p className="text-sm text-label-2">Predictions: PSI {num(r.predictionDrift.psi, 2)}{r.predictionDrift.shares ? ` — ${r.predictionDrift.shares.filter((s: any) => s.value !== '(other)').map((s: any) => `${s.value} ${pct(s.reference)} → ${pct(s.current)}`).join(', ')}` : ''}.</p>
          )}
          <ResultFooter agent="pin-monitor" provenance={<Provenance manifest={r.manifest} runId={r.runId} notes={r.notes} />}
            pin={{ title: `Health of ${model ? modelName(model) : 'the model'}`, headline: monitorHeadline(r), view: { kind: 'monitor' }, capability: 'mlops.monitor', params: ranParams, result: r }} />
        </div>
      )}

      {history.length > 0 && (
        <div className="card p-4 sm:p-5 space-y-3">
          <h3 className="card-title">Past checks of {model ? modelName(model) : 'this model'}</h3>
          <DataTable rows={history} limit={20} columns={[
            { key: 'checkedAt', label: 'When', format: (v: string) => (v ? new Date(v).toLocaleString() : '—') },
            { key: 'summary', label: 'Status', format: (s: any) => <StatusPill status={s?.status} /> },
            { key: 'source', label: 'Data', format: (s: any) => (s ? `${s.name ?? s.kind} (${Number(s.rows ?? 0).toLocaleString()} rows)` : '—') },
            { key: 'drifted', label: 'Drifted', format: (_: any, row: any) => (row.summary ? `${row.summary.featuresDrifted} of ${row.summary.featuresChecked}` : '—') },
          ]} />
        </div>
      )}
    </div>
  );
}
