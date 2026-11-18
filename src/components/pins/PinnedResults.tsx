/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useCallback, useEffect, useState } from 'react';
import { ArrowDown, ArrowUp, Pin, RotateCw, Trash2 } from 'lucide-react';
import type { Dataset } from '../../types';
import { CAPABILITIES, EngineApiError, engine, type CapabilityName } from '../../engine/client';
import { syncDataset } from '../../engine/datasetSync';
import { useLogRun } from '../../contexts/WorkspaceContext';
import { PINS_CHANGED_EVENT, deletePin, listPins, movePin, updatePin, type PinRecord } from '../../utils/workspaceStore';
import { ENGINE_METHODS } from '../stats/methods';
import { DataTable, StatGrid, num } from '../stats/methodKit';
import { Bars } from '../model/charts';
import { metricLabel, metricValue } from '../model/models';
import { automlHeadline } from '../model/AutoMLPanel';
import { explainHeadline } from '../model/ExplainPanel';
import { StatusPill, monitorHeadline } from '../model/MonitorPanel';
import Orb from '../Orb';

/** The headline for a pin, recomputed from its result so it always matches what's shown. */
export function pinHeadline(pin: Pick<PinRecord, 'view' | 'result' | 'headline'>): string {
  const r: any = pin.result;
  try {
    switch (pin.view.kind) {
      case 'method': return ENGINE_METHODS[pin.view.methodId]?.headline(r, pin.view.values) ?? pin.headline;
      case 'automl': return automlHeadline(r);
      case 'explain': return explainHeadline(r);
      case 'monitor': return monitorHeadline(r);
      default: return pin.headline;
    }
  } catch {
    return pin.headline;
  }
}

/** Whether the pin can be recomputed on today's data from the dashboard. */
export const refreshable = (pin: Pick<PinRecord, 'view'>) => pin.view.kind !== 'automl' && pin.view.kind !== 'predict';

/** Does running this pin's capability need the studio's data? */
export function pinNeedsData(pin: Pick<PinRecord, 'view' | 'capability'>): boolean {
  if (CAPABILITIES[pin.capability as CapabilityName]?.needsDataset) return true;
  if (pin.view.kind === 'monitor') return true;
  if (pin.view.kind === 'method') return !!ENGINE_METHODS[pin.view.methodId]?.fields.some(f => f.kind === 'column' || f.kind === 'columns');
  return false;
}

export function PinBody({ pin }: { pin: Pick<PinRecord, "view" | "result"> }) {
  const r: any = pin.result;
  try {
    switch (pin.view.kind) {
      case 'method': {
        const m = ENGINE_METHODS[pin.view.methodId];
        return m ? <>{m.render(r, pin.view.values)}</> : null;
      }
      case 'automl': {
        const lb = (r.leaderboard ?? []).slice(0, 6).map((x: any) => ({ label: x.label, value: metricValue(r.scoring, x.cvMean) ?? 0 }));
        const test = r.test ?? {};
        const keys = r.task === 'classification' ? ['rocAuc', 'accuracy', 'f1', 'recall'] : ['r2', 'rmse', 'mae'];
        return <>
          <StatGrid items={keys.filter(k => test[k] != null).map(k => [`${metricLabel(k)} (test)`, num(test[k])] as [string, React.ReactNode])} />
          <Bars rows={lb} from={metricValue(r.scoring, r.baseline?.cvMean) ?? undefined} lowerIsBetter={String(r.scoring).startsWith('neg_')} />
          {r.model?.name && <p className="text-xs text-label-3">Saved as {r.model.name} v{r.model.version}.</p>}
        </>;
      }
      case 'explain':
        return <Bars rows={(r.shapGlobal ?? []).slice(0, 8).map((x: any) => ({ label: x.feature, value: x.meanAbsShap }))} format={v => num(v, 2)} />;
      case 'monitor':
        return <div className="space-y-2">
          <StatusPill status={r.summary?.status} />
          {(r.alerts ?? []).length > 0 && <ul className="text-sm text-label-2 list-disc pl-5">{r.alerts.slice(0, 5).map((a: any, i: number) => <li key={i}>{a.message}</li>)}</ul>}
        </div>;
      case 'scenarios':
        return <DataTable limit={12} rows={(r.scenarios ?? []).map((s: any) => ({ ...s.inputs, prediction: s.prediction }))}
          columns={[...Object.keys(r.scenarios?.[0]?.inputs ?? {}).map(k => ({ key: k, label: k })), { key: 'prediction', label: 'Prediction' }]} />;
      default:
        return null;
    }
  } catch {
    return <p className="text-sm text-label-2">This result can’t be drawn any more; refresh it or remove it.</p>;
  }
}

const PinCard: React.FC<{ pin: PinRecord; first: boolean; last: boolean; dataset: Dataset; versionId: string | null }> = ({ pin, first, last, dataset, versionId }) => {
  const logRun = useLogRun();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const stale = !!versionId && !!pin.versionId && pin.versionId !== versionId;

  const refresh = async () => {
    setBusy(true); setError(null);
    try {
      const datasetId = pinNeedsData(pin) ? (await syncDataset(dataset)).id : null;
      const res: any = await engine.runAndWait(pin.capability as CapabilityName, pin.params as never, { datasetId });
      const next: PinRecord = { ...pin, result: res, versionId, computedAt: Date.now() };
      next.headline = pinHeadline(next);
      await updatePin(next);
      logRun({ kind: 'engine', title: `Refreshed: ${pin.title}`, summary: next.headline, status: 'succeeded', params: { capability: pin.capability, params: pin.params, runId: res.runId, view: pin.view }, result: res });
    } catch (err) {
      setError(err instanceof EngineApiError ? err.message : (err as Error)?.message || 'Refreshing failed.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <article className="card p-4 sm:p-5 space-y-4" aria-label={pin.title} data-agent={`pinned-${pin.id}`}>
      <header className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <h3 className="card-title">{pin.title}</h3>
          <p className="mt-0.5 text-xs text-label-3">
            Computed {new Date(pin.computedAt).toLocaleString()} by the engine
            {stale && <span className="ml-1 text-orange">· the data has changed since</span>}
          </p>
        </div>
        <div className="flex items-center gap-1">
          {refreshable(pin) && (
            <button type="button" className="btn btn-sm btn-secondary" onClick={refresh} disabled={busy} title="Recompute on the current data">
              {busy ? <><Orb state="solving" label="Refreshing" /> Refreshing…</> : <><RotateCw className="w-3.5 h-3.5" /> Refresh</>}
            </button>
          )}
          <button type="button" className="btn btn-icon w-8 h-8" aria-label="Move up" disabled={first || busy} onClick={() => movePin(pin, -1)}><ArrowUp className="w-4 h-4" /></button>
          <button type="button" className="btn btn-icon w-8 h-8" aria-label="Move down" disabled={last || busy} onClick={() => movePin(pin, 1)}><ArrowDown className="w-4 h-4" /></button>
          <button type="button" className="btn btn-icon w-8 h-8 text-red" aria-label={`Remove “${pin.title}”`} disabled={busy} onClick={() => deletePin(pin)}><Trash2 className="w-4 h-4" /></button>
        </div>
      </header>
      <p className="text-[17px] font-semibold text-label">{pinHeadline(pin)}</p>
      <PinBody pin={pin} />
      {!refreshable(pin) && stale && <p className="text-xs text-label-3">To update this, run it again in the Model step and pin the new result.</p>}
      {error && <p className="text-sm text-red" role="alert">{error}</p>}
    </article>
  );
};

/** The dashboard's pinned engine results, for one dataset. */
export default function PinnedResults({ dataset, datasetId, versionId }: { dataset: Dataset; datasetId: string | null; versionId: string | null }) {
  const [pins, setPins] = useState<PinRecord[] | null>(null);
  const load = useCallback(() => {
    if (!datasetId) { setPins([]); return; }
    listPins(datasetId).then(setPins).catch(() => setPins([]));
  }, [datasetId]);
  useEffect(() => {
    load();
    const onChange = (e: Event) => { if ((e as CustomEvent).detail?.datasetId === datasetId) load(); };
    window.addEventListener(PINS_CHANGED_EVENT, onChange);
    return () => window.removeEventListener(PINS_CHANGED_EVENT, onChange);
  }, [load, datasetId]);

  if (!pins) return null;
  if (!pins.length) {
    return (
      <p className="mb-6 text-sm text-label-2 flex items-center gap-2" data-agent="pinned-empty">
        <Pin className="w-4 h-4 text-label-3" /> Pin any result from Statistics or Model and it will appear here, ready to refresh when the data changes.
      </p>
    );
  }
  return (
    <section className="mb-8 space-y-4" aria-labelledby="pinned-title" data-agent="pinned-results">
      <div className="flex items-baseline justify-between gap-3">
        <h2 id="pinned-title" className="text-xl font-semibold text-label">Pinned analyses</h2>
        <span className="text-sm text-label-2">{pins.length} pinned</span>
      </div>
      <div className="grid grid-cols-1 xl:grid-cols-2 gap-4">
        {pins.map((p, i) => <PinCard key={p.id} pin={p} first={i === 0} last={i === pins.length - 1} dataset={dataset} versionId={versionId} />)}
      </div>
    </section>
  );
}
