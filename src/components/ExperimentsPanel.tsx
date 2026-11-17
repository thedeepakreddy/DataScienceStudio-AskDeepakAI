/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useEffect, useState } from 'react';
import { RotateCcw } from 'lucide-react';
import { DatasetVersion, RunRecord, getVersion, listRuns } from '../utils/workspaceStore';

interface TrainingParams {
  target: string;
  features: string[];
  modelType: 'classification' | 'regression' | 'timeseries';
  hyperparameters: Record<string, any>;
}
interface TrainingResult {
  algorithm?: string;
  metrics?: Record<string, number>;
  cv?: { mean?: number; std?: number; metric?: string };
  split?: { strategy?: string };
  tuning?: { tuned?: boolean };
}

const pct = (v?: number) => (typeof v === 'number' ? `${(v * 100).toFixed(1)}%` : '—');
const num = (v?: number) => (typeof v === 'number' ? v.toFixed(3) : '—');

/**
 * Every model trained on this dataset, with the settings and data version it
 * used, so results can be compared over time and any run repeated exactly.
 */
export default function ExperimentsPanel({ datasetId, activeVersionId, refreshKey, onRerun, onOpenVersion }: {
  datasetId: string | null;
  activeVersionId: string | null;
  refreshKey: unknown;
  onRerun: (p: TrainingParams) => void;
  onOpenVersion: (v: DatasetVersion) => void;
}) {
  const [runs, setRuns] = useState<(RunRecord & { version?: DatasetVersion })[] | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const all = (await listRuns(200)).filter(r => r.kind === 'model-training' && r.status === 'succeeded');
      const withVersions = await Promise.all(all.map(async r => ({ ...r, version: r.versionId ? await getVersion(r.versionId) : undefined })));
      if (!cancelled) setRuns(withVersions.filter(r => !datasetId || r.version?.datasetId === datasetId).slice(0, 30));
    })().catch(() => { if (!cancelled) setRuns([]); });
    return () => { cancelled = true; };
  }, [datasetId, refreshKey]);

  if (!runs || runs.length === 0) return null;

  return (
    <section className="card p-5 sm:p-6" aria-labelledby="experiments-heading">
      <h2 id="experiments-heading" className="card-title">Experiments</h2>
      <p className="mt-1 text-sm text-label-2">
        Every model trained on this dataset, newest first. Re-run repeats it with the same data version, columns, settings and seed.
      </p>
      <div className="mt-4 overflow-x-auto">
        <table className="w-full text-sm tabular-nums">
          <thead>
            <tr className="text-left text-xs text-label-2">
              {['When', 'Model', 'Predicting', 'Test score', 'Cross-validation', 'Split · seed', 'Data', ''].map(h => (
                <th key={h} className="py-2 pr-4 font-medium whitespace-nowrap">{h}</th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y divide-separator">
            {runs.map(r => {
              const p = r.params as TrainingParams | undefined;
              const res = (r.result ?? {}) as TrainingResult;
              const isClf = p?.modelType === 'classification' || typeof res.metrics?.accuracy === 'number';
              const score = isClf ? pct(res.metrics?.accuracy) : `R² ${num(res.metrics?.r2Score)}`;
              const cv = typeof res.cv?.mean === 'number' ? `${isClf ? pct(res.cv.mean) : num(res.cv.mean)} ± ${isClf ? pct(res.cv.std) : num(res.cv.std)}` : '—';
              const sameVersion = r.versionId === activeVersionId;
              return (
                <tr key={r.id}>
                  <td className="py-2 pr-4 text-label-2 whitespace-nowrap">{new Date(r.createdAt).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}</td>
                  <td className="py-2 pr-4 text-label whitespace-nowrap">{res.algorithm ?? '—'}{res.tuning?.tuned ? ' (tuned)' : ''}</td>
                  <td className="py-2 pr-4 text-label-2">{p?.target ?? '—'} <span className="text-label-3">· {p?.features?.length ?? 0} cols</span></td>
                  <td className="py-2 pr-4 text-label font-medium">{score}</td>
                  <td className="py-2 pr-4 text-label-2 whitespace-nowrap">{cv}</td>
                  <td className="py-2 pr-4 text-label-2 whitespace-nowrap">{res.split?.strategy ?? 'random'} · {p?.hyperparameters?.seed ?? 42}</td>
                  <td className="py-2 pr-4 text-label-2 max-w-[180px] truncate" title={r.version?.label}>{r.version ? r.version.label : 'deleted version'}</td>
                  <td className="py-2 whitespace-nowrap">
                    {p && r.version && (sameVersion ? (
                      <button type="button" className="btn btn-sm btn-secondary" onClick={() => onRerun(p)}>
                        <RotateCcw className="w-3.5 h-3.5" /> Re-run
                      </button>
                    ) : (
                      <button type="button" className="btn btn-sm btn-plain" onClick={() => onOpenVersion(r.version!)} title="Switch to the data this model was trained on">
                        Open Its Data
                      </button>
                    ))}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </section>
  );
}
