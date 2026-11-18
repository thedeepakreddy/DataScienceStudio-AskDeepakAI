/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Database, HardDriveUpload, RotateCw, Trash2 } from 'lucide-react';
import type { Dataset } from '../../types';
import { engine, type DatasetMeta } from '../../engine/client';
import MethodPanel from '../stats/MethodPanel';
import { DataTable, num } from '../stats/methodKit';
import UseEngineDataset from './UseEngineDataset';
import Orb from '../Orb';
import { RUN_LOGGED_EVENT } from '../../swarm/interaction';

const EMPTY: Dataset = { filename: '', rows: [], columns: [], rowCount: 0, originalRowCount: 0 };
const mb = (b: number) => `${num(b / 1e6, 3)} MB`;

/** Files too big for the browser go straight to the engine's storage, then a sample opens in the studio. */
function LargeUpload({ onUploaded }: { onUploaded: () => void }) {
  const input = useRef<HTMLInputElement>(null);
  const [state, setState] = useState<{ phase: 'idle' | 'uploading' | 'done' | 'error'; message?: string; progress?: number; dataset?: DatasetMeta }>({ phase: 'idle' });
  const upload = async (file: File) => {
    setState({ phase: 'uploading', message: `Uploading ${file.name} (${mb(file.size)})`, progress: 0 });
    try {
      const name = file.name.replace(/\.[^.]+$/, '');
      // Up to ~30 MB goes straight to the engine; bigger files go to Cloud Storage first, then the engine reads them.
      const ds = file.size < 30e6
        ? await engine.datasets.upload(file, name)
        : await engine.datasets.uploadLarge(file, name, { onProgress: (p, m) => setState(s => ({ ...s, progress: p, message: m })) });
      setState({ phase: 'done', dataset: ds });
      onUploaded();
    } catch (err) {
      setState({ phase: 'error', message: (err as Error)?.message || 'The upload failed.' });
    }
  };
  return (
    <div className="card p-4 sm:p-5 space-y-3" data-agent="area-large-upload">
      <div>
        <h3 className="card-title flex items-center gap-2"><HardDriveUpload className="w-4 h-4" /> A large file</h3>
        <p className="mt-1 text-sm text-label-2">CSV, Excel, JSON or Parquet up to several GB goes straight to the engine (Cloud Storage), not through the browser. You can analyse all of it there and open up to 100,000 rows here.</p>
      </div>
      <input ref={input} type="file" accept=".csv,.tsv,.txt,.json,.jsonl,.parquet,.xlsx,.xls" className="hidden" onChange={e => { const f = e.target.files?.[0]; if (f) upload(f); e.target.value = ''; }} />
      <button type="button" className="btn btn-secondary" disabled={state.phase === 'uploading'} onClick={() => input.current?.click()}>
        {state.phase === 'uploading' ? <><Orb state="connecting" label="Uploading" /> {state.message}{state.progress != null ? ` · ${Math.round(state.progress * 100)}%` : ''}</> : 'Choose a file'}
      </button>
      {state.phase === 'error' && <p className="text-sm text-red" role="alert">{state.message}</p>}
      {state.phase === 'done' && state.dataset && (
        <div className="space-y-2">
          <p className="text-sm text-label">Uploaded “{state.dataset.name}”: {state.dataset.rows.toLocaleString()} rows × {state.dataset.columns.length} columns.</p>
          <UseEngineDataset dataset={state.dataset} mode="open" />
        </div>
      )}
    </div>
  );
}

/** Everything the engine holds: imports, scored and masked copies, recipe outputs. */
function EngineDatasets({ refreshKey }: { refreshKey: number }) {
  const [list, setList] = useState<DatasetMeta[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [preview, setPreview] = useState<{ id: string; rows: Record<string, unknown>[]; columns: string[] } | null>(null);
  const load = useCallback(() => {
    engine.datasets.list().then(l => { setList([...l].sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))); setError(null); }).catch(e => setError((e as Error).message));
  }, []);
  useEffect(load, [load, refreshKey]);
  // An import (or any engine run that saves data) finished: show it.
  useEffect(() => {
    const onRun = (e: Event) => { if ((e as CustomEvent).detail?.kind === 'engine') load(); };
    window.addEventListener(RUN_LOGGED_EVENT, onRun);
    return () => window.removeEventListener(RUN_LOGGED_EVENT, onRun);
  }, [load]);
  const remove = async (id: string) => { await engine.datasets.remove(id).catch(e => setError((e as Error).message)); setPreview(p => (p?.id === id ? null : p)); load(); };
  const show = async (id: string) => {
    if (preview?.id === id) { setPreview(null); return; }
    const p = await engine.datasets.preview(id, 10).catch(e => { setError((e as Error).message); return null; });
    if (p) setPreview({ id, ...p });
  };
  return (
    <div className="card p-4 sm:p-5 space-y-3" data-agent="area-engine-datasets">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h3 className="card-title flex items-center gap-2"><Database className="w-4 h-4" /> Data already in the engine</h3>
          <p className="mt-1 text-sm text-label-2">Imports, uploads and every dataset the engine made (scored, masked, prepared, segmented).</p>
        </div>
        <button type="button" className="btn btn-icon w-9 h-9" aria-label="Reload" onClick={load}><RotateCw className="w-4 h-4" /></button>
      </div>
      {error && <p className="text-sm text-red">{error}</p>}
      {list && !list.length && <p className="text-sm text-label-2">Nothing yet.</p>}
      {list && list.length > 0 && (
        <ul className="divide-y divide-separator">
          {list.slice(0, 30).map(d => (
            <li key={d.id} className="py-2.5 space-y-2">
              <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-medium text-label truncate">{d.name}</p>
                  <p className="text-xs text-label-3">{d.rows.toLocaleString()} rows × {d.columns.length} columns · {mb(d.bytes ?? 0)} · {String((d as any).source?.kind ?? 'upload')} · {new Date(d.createdAt).toLocaleString()}</p>
                </div>
                <button type="button" className="btn btn-sm btn-plain" onClick={() => show(d.id)}>{preview?.id === d.id ? 'Hide' : 'Preview'}</button>
                <UseEngineDataset dataset={d} mode="open" label="Open" />
                <button type="button" className="btn btn-icon w-8 h-8 text-red" aria-label={`Delete ${d.name}`} onClick={() => remove(d.id)}><Trash2 className="w-4 h-4" /></button>
              </div>
              {preview?.id === d.id && <DataTable rows={preview.rows} limit={10} columns={preview.columns.slice(0, 10).map(c => ({ key: c, label: c, format: (v: any) => (v == null ? '—' : String(v)) }))} />}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** Import from outside the browser: connectors, large files, and data the engine already has. */
export default function EngineImport() {
  const [refresh, setRefresh] = useState(0);
  return (
    <section aria-labelledby="engine-import-heading" className="space-y-4" data-agent="area-engine-import">
      <div>
        <h2 id="engine-import-heading" className="section-title">Bring in data from elsewhere</h2>
        <p className="mt-1 text-sm text-label-2">A web address, a database, BigQuery or Cloud Storage — or a file too large for the browser. It goes into the engine first, then opens here.</p>
      </div>
      <MethodPanel group="import" dataset={EMPTY} />
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 items-start">
        <LargeUpload onUploaded={() => setRefresh(n => n + 1)} />
        <EngineDatasets refreshKey={refresh} />
      </div>
    </section>
  );
}
