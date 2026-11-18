/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Download, FileText, RotateCw } from 'lucide-react';
import type { Dataset } from '../../types';
import { engine, type AuditEvent, type CapabilityName, type EngineInfo, type EngineJob, type RunRecord, type TextModelInfo } from '../../engine/client';
import { syncDataset } from '../../engine/datasetSync';
import { useLogRun } from '../../contexts/WorkspaceContext';
import { DataTable, num } from '../stats/methodKit';
import Provenance from './Provenance';
import Orb from '../Orb';

type Tab = 'runs' | 'jobs' | 'experiments' | 'tools' | 'audit' | 'about';
const TABS: { id: Tab; label: string; hint: string }[] = [
  { id: 'runs', label: 'Engine runs', hint: 'Every analysis the engine ran: its settings, methods text and a notebook that reproduces it. Pick several to compare.' },
  { id: 'jobs', label: 'Jobs', hint: 'Long work the engine is doing or has done (AutoML, scoring, pipelines): progress, results, and a way to stop it.' },
  { id: 'experiments', label: 'Experiments', hint: 'Runs grouped by experiment name.' },
  { id: 'tools', label: 'All engine tools', hint: 'Every engine capability with every option, as a form built from the engine’s own description of it.' },
  { id: 'audit', label: 'Audit log', hint: 'Every request the engine received: when, what, the outcome and how long it took.' },
  { id: 'about', label: 'About the engine', hint: 'Version, libraries, storage, upload limit and the language models installed.' },
];

const show = (v: unknown): string => (v === null || v === undefined ? '—' : typeof v === 'number' ? num(v, 4) : typeof v === 'object' ? JSON.stringify(v) : String(v));

// ------------------------------------------------------------------ runs and comparison
function RunDetail({ run }: { run: RunRecord }) {
  const [full, setFull] = useState<any>(null);
  const [methods, setMethods] = useState<{ markdown: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => { engine.runs.get(run.id).then(setFull).catch(e => setError((e as Error).message)); }, [run.id]);
  const loadMethods = async () => { try { setMethods(await engine.runs.methods(run.id)); } catch (e) { setError((e as Error).message); } };
  const saveMethods = () => {
    if (!methods) return;
    const url = URL.createObjectURL(new Blob([methods.markdown], { type: 'text/markdown' }));
    Object.assign(document.createElement('a'), { href: url, download: `${run.id}-methods.md` }).click();
    URL.revokeObjectURL(url);
  };
  return (
    <div className="rounded-xl bg-fill/50 p-3 space-y-3">
      <div className="flex flex-wrap gap-2">
        <button type="button" className="btn btn-sm btn-secondary" onClick={methods ? saveMethods : loadMethods}><FileText className="w-3.5 h-3.5" /> {methods ? 'Save methods as Markdown' : 'Methods text'}</button>
        <a className="btn btn-sm btn-secondary" href={engine.runs.notebookUrl(run.id)} download><Download className="w-3.5 h-3.5" /> Notebook (.ipynb)</a>
      </div>
      {methods && <pre className="text-xs whitespace-pre-wrap bg-surface rounded-lg p-3 max-h-64 overflow-y-auto">{methods.markdown}</pre>}
      <DataTable rows={Object.entries(run.params ?? {}).map(([k, v]) => ({ k, v }))} columns={[{ key: 'k', label: 'Setting' }, { key: 'v', label: 'Value', format: show }]} limit={40} />
      {full?.result?.manifest && <Provenance manifest={full.result.manifest} runId={run.id} notes={full.result.notes} />}
      {full?.result && <details><summary className="text-xs text-label-2 cursor-pointer">Full result (JSON)</summary><pre className="mt-2 text-[11px] bg-surface rounded-lg p-3 max-h-80 overflow-auto">{JSON.stringify(full.result, null, 2).slice(0, 60000)}</pre></details>}
      {error && <p className="text-sm text-red">{error}</p>}
    </div>
  );
}

function Runs() {
  const [runs, setRuns] = useState<RunRecord[] | null>(null);
  const [experiment, setExperiment] = useState('');
  const [open, setOpen] = useState<string | null>(null);
  const [picked, setPicked] = useState<string[]>([]);
  const [cmp, setCmp] = useState<any>(null);
  const [shown, setShown] = useState(15);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(() => {
    engine.runs.list({ limit: 100, ...(experiment ? { experiment } : {}) }).then(r => { setRuns(r); setError(null); }).catch(e => setError((e as Error).message));
  }, [experiment]);
  useEffect(load, [load]);
  const compare = async () => { try { setCmp(await engine.runs.compare(picked)); } catch (e) { setError((e as Error).message); } };
  const experiments = useMemo(() => [...new Set((runs ?? []).map(r => r.experiment).filter(Boolean))] as string[], [runs]);
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end gap-3">
        <div><label className="field-label" htmlFor="runs-exp">Experiment</label>
          <select id="runs-exp" className="input" value={experiment} onChange={e => setExperiment(e.target.value)}><option value="">All runs</option>{experiments.map(x => <option key={x} value={x}>{x}</option>)}</select>
        </div>
        <button type="button" className="btn btn-secondary" disabled={picked.length < 2} onClick={compare} data-agent="runs-compare">Compare {picked.length || ''} runs</button>
        <button type="button" className="btn btn-icon w-9 h-9" aria-label="Reload runs" onClick={load}><RotateCw className="w-4 h-4" /></button>
      </div>
      {error && <p className="text-sm text-red">{error}</p>}
      {cmp && (
        <div className="card p-4 space-y-3">
          <h4 className="text-sm font-semibold text-label">Comparison</h4>
          <DataTable limit={60} rows={[...cmp.params.filter((p: any) => p.differs).map((p: any) => ({ name: p.param, kind: 'setting', values: p.values })), ...cmp.metrics.map((m: any) => ({ name: m.metric, kind: 'result', values: m.values }))]}
            columns={[{ key: 'name', label: 'What' }, { key: 'kind', label: '' }, ...cmp.runs.map((r: any, i: number) => ({ key: `v${i}`, label: `${r.capability} · ${new Date(r.startedAt).toLocaleTimeString()}`, format: (_: any, row: any) => show(row.values[i]) }))]} />
          <p className="text-xs text-label-3">Only settings that differ are shown.</p>
        </div>
      )}
      {!runs && <p className="text-sm text-label-2">Loading…</p>}
      {runs && !runs.length && <p className="text-sm text-label-2">No engine runs yet.</p>}
      <ul className="divide-y divide-separator">
        {(runs ?? []).slice(0, shown).map(r => (
          <li key={r.id} className="py-2 space-y-2">
            <div className="flex items-center gap-3">
              <input type="checkbox" aria-label={`Compare ${r.capability}`} checked={picked.includes(r.id)} onChange={e => setPicked(p => (e.target.checked ? [...p, r.id] : p.filter(x => x !== r.id)))} />
              <button type="button" className="flex-1 min-w-0 text-left" onClick={() => setOpen(o => (o === r.id ? null : r.id))}>
                <span className="block text-sm text-label truncate">{r.capability}{r.cached ? ' (from cache)' : ''}</span>
                <span className="block text-xs text-label-3 truncate">{new Date(r.startedAt).toLocaleString()} · {r.dataset?.name ?? 'no dataset'} · {r.source}{r.experiment ? ` · ${r.experiment}` : ''} · seed {r.seed}</span>
              </button>
              <span className={`text-xs ${r.status === 'error' ? 'text-red' : r.status === 'done' ? 'text-green' : 'text-label-2'}`}>{r.status}</span>
            </div>
            {open === r.id && <RunDetail run={r} />}
          </li>
        ))}
      </ul>
      {(runs?.length ?? 0) > shown && <button type="button" className="btn btn-sm btn-plain -ml-2" onClick={() => setShown(n => n + 25)}>Show more ({(runs?.length ?? 0) - shown} older)</button>}
    </div>
  );
}

function Jobs() {
  const [jobs, setJobs] = useState<EngineJob[] | null>(null);
  const [open, setOpen] = useState<{ id: string; result: any } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(() => { engine.jobs.list(50).then(j => { setJobs(j); setError(null); }).catch(e => setError((e as Error).message)); }, []);
  useEffect(() => {
    load();
    const t = setInterval(load, 4000); // progress moves while you watch
    return () => clearInterval(t);
  }, [load]);
  const view = async (id: string) => {
    if (open?.id === id) { setOpen(null); return; }
    try { setOpen({ id, result: await engine.jobs.result(id) }); } catch (e) { setError((e as Error).message); }
  };
  return (
    <div className="space-y-2">
      {error && <p className="text-sm text-red">{error}</p>}
      {jobs && !jobs.length && <p className="text-sm text-label-2">No jobs yet.</p>}
      <ul className="divide-y divide-separator">
        {(jobs ?? []).map(j => (
          <li key={j.id} className="py-2 space-y-2">
            <div className="flex flex-wrap items-center gap-3">
              <div className="flex-1 min-w-0">
                <p className="text-sm text-label truncate">{j.label} <span className="text-label-3">({j.kind})</span></p>
                <p className="text-xs text-label-3 truncate">{new Date(j.createdAt).toLocaleString()} · {j.message}{j.error ? ` · ${j.error.message}` : ''}</p>
              </div>
              {['queued', 'running'].includes(j.status)
                ? <><span className="text-xs text-label-2 tabular-nums">{Math.round(j.progress * 100)}%</span><button type="button" className="btn btn-sm btn-plain text-red" onClick={() => engine.jobs.cancel(j.id).then(load)}>Stop</button></>
                : <span className={`text-xs ${j.status === 'done' ? 'text-green' : j.status === 'error' ? 'text-red' : 'text-label-2'}`}>{j.status}</span>}
              {j.status === 'done' && <button type="button" className="btn btn-sm btn-plain" onClick={() => view(j.id)}>{open?.id === j.id ? 'Hide' : 'Result'}</button>}
            </div>
            {open?.id === j.id && <pre className="text-[11px] bg-fill rounded-lg p-3 max-h-80 overflow-auto">{JSON.stringify({ ...open.result, manifest: undefined }, null, 2).slice(0, 60000)}</pre>}
          </li>
        ))}
      </ul>
    </div>
  );
}

function Experiments() {
  const [rows, setRows] = useState<any[] | null>(null);
  useEffect(() => { engine.experiments().then(setRows).catch(() => setRows([])); }, []);
  if (!rows) return <p className="text-sm text-label-2">Loading…</p>;
  if (!rows.length) return <p className="text-sm text-label-2">No experiments yet. Runs started with an experiment name are grouped here.</p>;
  return <DataTable rows={rows} columns={[{ key: 'experiment', label: 'Experiment' }, { key: 'runs', label: 'Runs' }, { key: 'capabilities', label: 'What ran', format: (c: string[]) => c.join(', ') }, { key: 'lastRunAt', label: 'Last run', format: (v: string) => new Date(v).toLocaleString() }]} />;
}

function Audit() {
  const [rows, setRows] = useState<AuditEvent[] | null>(null);
  const load = () => engine.audit(200).then(setRows).catch(() => setRows([]));
  useEffect(() => { load(); }, []);
  return (
    <div className="space-y-2">
      <button type="button" className="btn btn-sm btn-secondary" onClick={load}><RotateCw className="w-3.5 h-3.5" /> Reload</button>
      <DataTable limit={200} rows={rows ?? []} columns={[{ key: 'at', label: 'When', format: (v: string) => new Date(v).toLocaleString() }, { key: 'method', label: '' }, { key: 'path', label: 'Request' }, { key: 'status', label: 'Status' }, { key: 'ms', label: 'ms', format: (v: number) => num(v, 3) }, { key: 'actor', label: 'Who', format: show }]} />
    </div>
  );
}

function About() {
  const [info, setInfo] = useState<EngineInfo | null>(null);
  const [models, setModels] = useState<TextModelInfo[]>([]);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    engine.info().then(setInfo).catch(e => setError((e as Error).message));
    engine.textModels().then(setModels).catch(() => {});
  }, []);
  if (error) return <p className="text-sm text-red">{error}</p>;
  if (!info) return <p className="text-sm text-label-2">Loading…</p>;
  return (
    <div className="space-y-4">
      <p className="text-sm text-label">Engine {info.engineVersion} · {info.capabilities} capabilities in {info.areas.length} areas ({info.areas.join(', ')}) · storage: {info.storage === 'gcs' ? 'Google Cloud Storage' : 'local disk'} · uploads up to {info.maxUploadMb.toLocaleString()} MB.</p>
      <DataTable limit={40} rows={Object.entries(info.libraries).map(([k, v]) => ({ k, v }))} columns={[{ key: 'k', label: 'Library' }, { key: 'v', label: 'Version' }]} />
      {models.length > 0 && <DataTable rows={models} columns={[{ key: 'title', label: 'Language model' }, { key: 'task', label: 'Task' }, { key: 'languages', label: 'Languages' }, { key: 'license', label: 'Licence' }, { key: 'installed', label: 'Installed', format: (b: boolean) => (b ? 'yes' : 'no') }]} />}
    </div>
  );
}

// ------------------------------------------------------------------ every capability, every option
type Schema = { type?: string | string[]; enum?: unknown[]; anyOf?: Schema[]; items?: Schema; $ref?: string; default?: unknown; description?: string; title?: string; minimum?: number; maximum?: number; properties?: Record<string, Schema>; required?: string[]; $defs?: Record<string, Schema> };

function resolve(s: Schema, defs: Record<string, Schema>): Schema {
  if (s.$ref) return resolve(defs[s.$ref.split('/').pop()!] ?? {}, defs);
  if (s.anyOf) {
    const real = s.anyOf.filter(x => x.type !== 'null');
    if (real.length === 1) return { ...resolve(real[0], defs), default: s.default, description: s.description };
  }
  return s;
}

const SchemaField: React.FC<{ name: string; required?: boolean; s: Schema; value: any; onChange: (v: any) => void; columns: string[] }> = ({ name, required, s, value, onChange, columns }) => {
  const id = `tool-${name}`;
  const label = <label className="field-label" htmlFor={id}>{name}{required ? ' *' : ''}{s.description ? <span className="text-label-3 font-normal"> — {s.description}</span> : null}</label>;
  if (s.enum) return <div>{label}<select id={id} className="input" value={value ?? ''} onChange={e => onChange(e.target.value === '' ? undefined : e.target.value)}><option value="">{s.default !== undefined ? `Default (${String(s.default)})` : '—'}</option>{s.enum.map(v => <option key={String(v)} value={String(v)}>{String(v)}</option>)}</select></div>;
  if (s.type === 'boolean') return <label className="flex items-center gap-2 text-sm text-label self-end pb-2"><input id={id} type="checkbox" checked={value ?? !!s.default} onChange={e => onChange(e.target.checked)} /> {name}{s.description ? ` — ${s.description}` : ''}</label>;
  if (s.type === 'integer' || s.type === 'number') return <div>{label}<input id={id} className="input" type="number" step={s.type === 'integer' ? 1 : 'any'} min={s.minimum} max={s.maximum} placeholder={s.default !== undefined ? String(s.default) : ''} value={value ?? ''} onChange={e => onChange(e.target.value === '' ? undefined : Number(e.target.value))} /></div>;
  if (s.type === 'string') {
    const isColumn = /^(column|target|date|value|group|treatment|outcome|duration|event|time_column|group_column|item|transaction|color_by|running|instrument)$/.test(name);
    return <div>{label}{isColumn && columns.length
      ? <select id={id} className="input" value={value ?? ''} onChange={e => onChange(e.target.value || undefined)}><option value="">—</option>{columns.map(c => <option key={c} value={c}>{c}</option>)}</select>
      : <input id={id} className="input" value={value ?? ''} placeholder={s.default !== undefined ? String(s.default) : ''} onChange={e => onChange(e.target.value === '' ? undefined : e.target.value)} />}</div>;
  }
  if (s.type === 'array' && s.items && ['string', 'number', 'integer'].includes(String(s.items.type))) {
    return <div className="sm:col-span-2">{label}<input id={id} className="input" placeholder="comma-separated" value={Array.isArray(value) ? value.join(', ') : value ?? ''}
      onChange={e => { const xs = e.target.value.split(',').map(x => x.trim()).filter(Boolean); onChange(xs.length ? (s.items!.type === 'string' ? xs : xs.map(Number)) : undefined); }} /></div>;
  }
  // Objects, lists of objects, unions: JSON.
  return <div className="sm:col-span-2">{label}<textarea id={id} className="input font-mono text-xs min-h-[4rem]" placeholder="JSON" defaultValue={value !== undefined ? JSON.stringify(value) : ''}
    onBlur={e => { try { onChange(e.target.value.trim() ? JSON.parse(e.target.value) : undefined); } catch { /* left as typed until valid */ } }} /></div>;
};

function Tools({ dataset }: { dataset: Dataset }) {
  const [caps, setCaps] = useState<Awaited<ReturnType<typeof engine.capabilities>> | null>(null);
  const [name, setName] = useState<string>('');
  const [values, setValues] = useState<Record<string, unknown>>({});
  const [useData, setUseData] = useState(true);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<any>(null);
  const [error, setError] = useState<string | null>(null);
  const logRun = useLogRun();
  useEffect(() => { engine.capabilities().then(c => { setCaps(c); setName(c[0]?.name ?? ''); }).catch(e => setError((e as Error).message)); }, []);
  const cap = caps?.find(c => c.name === name);
  const schema = (cap?.params ?? {}) as Schema;
  const defs = schema.$defs ?? {};
  const props = Object.entries(schema.properties ?? {});
  const required = schema.required ?? [];
  const missing = required.filter(k => values[k] === undefined);
  const areas = useMemo(() => [...new Set((caps ?? []).map(c => c.area))], [caps]);

  const run = async () => {
    if (!cap) return;
    setBusy(true); setError(null); setResult(null);
    try {
      const datasetId = cap.needsDataset || useData ? (await syncDataset(dataset)).id : null;
      const res: any = await engine.runAndWait(cap.name as CapabilityName, values as never, { datasetId });
      setResult(res);
      logRun({ kind: 'engine', title: cap.title, summary: `Ran ${cap.name} from All engine tools.`, status: 'succeeded', params: { capability: cap.name, params: values, runId: res.runId }, result: res });
    } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  };

  if (error && !caps) return <p className="text-sm text-red">{error}</p>;
  if (!caps) return <p className="text-sm text-label-2">Loading the engine’s capabilities…</p>;
  return (
    <div className="space-y-4">
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <div><label className="field-label" htmlFor="tool-cap">Capability ({caps.length})</label>
          <select id="tool-cap" className="input" value={name} onChange={e => { setName(e.target.value); setValues({}); setResult(null); }} data-agent="tool-cap">
            {areas.map(a => <optgroup key={a} label={a}>{caps.filter(c => c.area === a).map(c => <option key={c.name} value={c.name}>{c.title} ({c.name})</option>)}</optgroup>)}
          </select>
        </div>
        {cap && !cap.needsDataset && <label className="flex items-center gap-2 text-sm text-label self-end pb-2"><input type="checkbox" checked={useData} onChange={e => setUseData(e.target.checked)} /> Send the current data ({dataset.filename})</label>}
      </div>
      {cap && <p className="text-sm text-label-2">{cap.summary}</p>}
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        {props.map(([k, raw]) => <SchemaField key={`${name}-${k}`} name={k} required={required.includes(k)} s={resolve(raw, defs)} value={values[k]} columns={dataset.columns.map(c => c.name)} onChange={v => setValues(prev => { const n = { ...prev }; if (v === undefined) delete n[k]; else n[k] = v; return n; })} />)}
      </div>
      <div className="flex items-center gap-3">
        <button type="button" className="btn btn-primary" disabled={busy || !cap || missing.length > 0} onClick={run} data-agent="tool-run">{busy ? <><Orb state="solving" onAccent label="Running" /> Running…</> : 'Run'}</button>
        {missing.length > 0 && <span className="text-xs text-label-3">Needs: {missing.join(', ')}</span>}
      </div>
      {error && <p className="text-sm text-red" role="alert">{error}</p>}
      {result && (
        <div className="card p-4 space-y-3">
          <pre className="text-[11px] bg-fill rounded-lg p-3 max-h-[28rem] overflow-auto">{JSON.stringify({ ...result, manifest: undefined }, null, 2).slice(0, 80000)}</pre>
          {result.manifest && <Provenance manifest={result.manifest} runId={result.runId} notes={result.notes} />}
        </div>
      )}
    </div>
  );
}

/** The engine itself, in the Report step: its run history, every tool, its audit log. */
export default function EngineWorkbench({ dataset }: { dataset: Dataset }) {
  const [tab, setTab] = useState<Tab>('runs');
  const current = TABS.find(t => t.id === tab)!;
  return (
    <section aria-labelledby="engine-workbench-heading" className="space-y-4" data-agent="area-engine-workbench">
      <div>
        <h2 id="engine-workbench-heading" className="section-title">The engine</h2>
        <p className="mt-1 text-sm text-label-2">How every number was computed, and every engine tool in one place.</p>
      </div>
      <div className="overflow-x-auto scrollbar-none -mx-4 px-4 sm:mx-0 sm:px-0">
        <div className="segmented w-max" role="tablist" aria-label="Engine">
          {TABS.map(t => <button key={t.id} type="button" role="tab" aria-selected={tab === t.id} data-agent={`engine-tab-${t.id}`} onClick={() => setTab(t.id)}>{t.label}</button>)}
        </div>
      </div>
      <p className="text-sm text-label-2">{current.hint}</p>
      <div className="card p-4 sm:p-5">
        {tab === 'runs' && <Runs />}
        {tab === 'jobs' && <Jobs />}
        {tab === 'experiments' && <Experiments />}
        {tab === 'tools' && <Tools dataset={dataset} />}
        {tab === 'audit' && <Audit />}
        {tab === 'about' && <About />}
      </div>
    </section>
  );
}
