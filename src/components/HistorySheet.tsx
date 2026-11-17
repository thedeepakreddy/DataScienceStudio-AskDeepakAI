/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useEffect, useRef, useState } from 'react';
import { motion } from 'motion/react';
import { AlertTriangle, CheckCircle2, Download, History, Lock, Upload, XCircle } from 'lucide-react';
import Orb from './Orb';
import { DatasetVersion, RunRecord, listRuns, listVersions } from '../utils/workspaceStore';

const RUN_KIND_LABEL: Record<RunRecord['kind'], string> = {
  'ai-advisory': 'AI advisory',
  'model-training': 'Model',
  'hypothesis-test': 'Statistics',
  'ab-test': 'A/B test',
  'quality-audit': 'Quality audit',
  'sql-query': 'SQL',
  regression: 'Regression',
  other: 'Run',
};

function when(ts: number) {
  const d = new Date(ts);
  const sameDay = d.toDateString() === new Date().toDateString();
  return sameDay
    ? d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    : d.toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

interface HistorySheetProps {
  onClose: () => void;
  datasetId: string | null;
  activeVersionId: string | null;
  onUseVersion: (version: DatasetVersion) => void;
  onClear: () => Promise<void>;
  onExport: () => Promise<void>;
  onImport: (file: File) => Promise<{ versions: number; runs: number; models: number }>;
  storageError: string | null;
}

/** Saved versions of the current dataset and the history of analysis runs. */
export default function HistorySheet({ onClose, datasetId, activeVersionId, onUseVersion, onClear, onExport, onImport, storageError }: HistorySheetProps) {
  const fileInput = useRef<HTMLInputElement>(null);
  const [transfer, setTransfer] = useState<{ busy?: 'export' | 'import'; message?: string; error?: string }>({});

  const runExport = async () => {
    setTransfer({ busy: 'export' });
    try {
      await onExport();
      setTransfer({ message: 'Workspace exported.' });
    } catch (err: any) {
      setTransfer({ error: `Export failed: ${err?.message || err}` });
    }
  };

  const runImport = async (file: File | undefined) => {
    if (!file) return;
    if (!window.confirm('Importing replaces everything saved in this browser with the file’s contents. Continue?')) return;
    setTransfer({ busy: 'import' });
    try {
      const c = await onImport(file);
      const n = (k: number, w: string) => `${k} ${w}${k === 1 ? '' : 's'}`;
      setTransfer({ message: `Imported ${n(c.versions, 'version')}, ${n(c.runs, 'run')} and ${n(c.models, 'model file')}.` });
    } catch (err: any) {
      setTransfer({ error: err?.message || String(err) });
    } finally {
      if (fileInput.current) fileInput.current.value = '';
    }
  };
  const [versions, setVersions] = useState<DatasetVersion[] | null>(null);
  const [runs, setRuns] = useState<RunRecord[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [confirmClear, setConfirmClear] = useState(false);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  useEffect(() => {
    let cancelled = false;
    Promise.all([datasetId ? listVersions(datasetId) : Promise.resolve([]), listRuns(50)])
      .then(([v, r]) => { if (!cancelled) { setVersions(v.reverse()); setRuns(r); } })
      .catch(err => { if (!cancelled) setLoadError(err?.message || 'Could not read saved work.'); });
    return () => { cancelled = true; };
  }, [datasetId, activeVersionId]);

  const versionNumber = (id: string | null) => {
    if (!id || !versions) return null;
    const i = versions.length - versions.findIndex(v => v.id === id);
    return i > versions.length ? null : i;
  };

  const error = storageError || loadError;

  return (
    <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center sm:p-4">
      <motion.div
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        exit={{ opacity: 0 }}
        transition={{ duration: 0.2 }}
        onClick={onClose}
        className="absolute inset-0 bg-[var(--scrim)]"
      />
      <motion.div
        role="dialog"
        aria-modal="true"
        aria-labelledby="history-title"
        initial={{ opacity: 0, y: 24, scale: 0.98 }}
        animate={{ opacity: 1, y: 0, scale: 1 }}
        exit={{ opacity: 0, y: 24, scale: 0.98 }}
        transition={{ duration: 0.3, ease: [0.28, 0.11, 0.32, 1] }}
        className="relative z-10 w-full sm:max-w-lg bg-raised rounded-t-3xl sm:rounded-3xl shadow-xl p-6 sm:p-7 max-h-[90vh] overflow-y-auto"
      >
        <div className="flex items-start justify-between gap-3">
          <div className="flex items-center gap-3">
            <span className="w-10 h-10 rounded-xl bg-blue/12 text-blue flex items-center justify-center shrink-0">
              <History className="w-5 h-5" />
            </span>
            <h2 id="history-title" className="text-xl font-semibold tracking-tight text-label">History</h2>
          </div>
          <button type="button" onClick={onClose} className="btn btn-plain font-semibold -mr-2 -mt-1">Done</button>
        </div>

        {error && (
          <p role="alert" className="mt-4 flex items-start gap-2 rounded-2xl bg-red/10 px-4 py-3 text-sm text-red">
            <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" /> {error}
          </p>
        )}

        <section className="mt-5">
          <h3 className="text-[15px] font-semibold text-label">Versions of this dataset</h3>
          <p className="mt-1 text-xs text-label-2">
            Every change you make is saved as a new version. Switch back to any of them.
          </p>
          {!datasetId ? (
            <p className="mt-3 text-sm text-label-3">Import a dataset to start a history.</p>
          ) : versions === null && !error ? (
            <p className="mt-3 text-sm text-label-3">Loading…</p>
          ) : (
            <ul className="mt-3 rounded-2xl bg-well divide-y divide-separator">
              {(versions ?? []).map(v => {
                const isActive = v.id === activeVersionId;
                const parentNo = versionNumber(v.parentId);
                return (
                  <li key={v.id} className="flex items-center justify-between gap-3 px-4 py-3">
                    <div className="min-w-0">
                      <p className="text-sm text-label">
                        <span className="text-label-3 tabular-nums mr-1.5">v{versionNumber(v.id)}</span>
                        {v.label}
                      </p>
                      <p className="mt-0.5 text-xs text-label-2 tabular-nums">
                        {v.rowCount.toLocaleString()} rows × {v.columnCount} columns · {when(v.createdAt)}
                        {v.parentId && parentNo && parentNo !== (versionNumber(v.id) ?? 0) - 1 ? ` · from v${parentNo}` : ''}
                      </p>
                    </div>
                    {isActive ? (
                      <span className="tag shrink-0">Current</span>
                    ) : (
                      <button type="button" onClick={() => onUseVersion(v)} className="btn btn-sm btn-secondary shrink-0">
                        Use This
                      </button>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
        </section>

        <section className="mt-6">
          <h3 className="text-[15px] font-semibold text-label">Runs</h3>
          {runs === null && !error ? (
            <p className="mt-3 text-sm text-label-3">Loading…</p>
          ) : (runs ?? []).length === 0 ? (
            <p className="mt-2 text-sm text-label-3">No analyses run yet.</p>
          ) : (
            <ul className="mt-3 rounded-2xl bg-well divide-y divide-separator">
              {(runs ?? []).map(r => (
                <li key={r.id} className="flex items-start gap-3 px-4 py-3">
                  {r.status === 'succeeded'
                    ? <CheckCircle2 className="w-4 h-4 text-green shrink-0 mt-0.5" aria-label="Succeeded" />
                    : <XCircle className="w-4 h-4 text-red shrink-0 mt-0.5" aria-label="Failed" />}
                  <div className="min-w-0 flex-1">
                    <p className="text-sm text-label break-words">{r.title}</p>
                    <p className="mt-0.5 text-xs text-label-2 break-words">
                      {RUN_KIND_LABEL[r.kind]} · {r.status === 'failed' ? (r.error || 'Failed') : r.summary} · {when(r.createdAt)}
                    </p>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </section>

        <section className="mt-6">
          <h3 className="text-[15px] font-semibold text-label">Back up or move your work</h3>
          <p className="mt-1 text-xs text-label-2">
            Export saves every version, run and model file to one file. Import it here or in another browser.
          </p>
          <div className="mt-3 flex flex-wrap gap-2">
            <button type="button" onClick={runExport} disabled={!!transfer.busy} aria-busy={transfer.busy === 'export'} className="btn btn-sm btn-secondary">
              {transfer.busy === 'export' ? <><Orb state="composing" label="Exporting" /> Exporting…</> : <><Download className="w-4 h-4" /> Export Workspace</>}
            </button>
            <button type="button" onClick={() => fileInput.current?.click()} disabled={!!transfer.busy} aria-busy={transfer.busy === 'import'} className="btn btn-sm btn-secondary">
              {transfer.busy === 'import' ? <><Orb state="working" label="Importing" /> Importing…</> : <><Upload className="w-4 h-4" /> Import Workspace</>}
            </button>
            <input
              ref={fileInput}
              type="file"
              accept="application/json,.json"
              className="hidden"
              aria-label="Workspace file to import"
              onChange={e => runImport(e.target.files?.[0])}
            />
          </div>
          {transfer.message && <p role="status" className="mt-2 text-sm text-green">{transfer.message}</p>}
          {transfer.error && <p role="alert" className="mt-2 text-sm text-red">{transfer.error}</p>}
        </section>

        <div className="mt-6 pt-4 border-t border-separator space-y-3">
          <p className="flex items-start gap-2 text-xs text-label-3 leading-relaxed">
            <Lock className="w-3.5 h-3.5 shrink-0 mt-0.5" />
            Saved only in this browser, on this device. Nothing is kept on the server. Clearing your browser data
            removes it, so export a copy of anything you want to keep.
          </p>
          {confirmClear ? (
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-sm text-label">Delete all saved versions and runs?</span>
              <button
                type="button"
                onClick={async () => { await onClear(); setConfirmClear(false); onClose(); }}
                className="btn btn-sm bg-red text-white hover:bg-red/90"
              >
                Delete
              </button>
              <button type="button" onClick={() => setConfirmClear(false)} className="btn btn-sm btn-secondary">Cancel</button>
            </div>
          ) : (
            <button type="button" onClick={() => setConfirmClear(true)} className="btn btn-sm bg-red/10 text-red hover:bg-red/15">
              Clear Saved Work
            </button>
          )}
        </div>
      </motion.div>
    </div>
  );
}
