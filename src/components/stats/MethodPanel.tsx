/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useEffect, useMemo, useState } from 'react';
import { ChevronLeft, Compass, Plus, X } from 'lucide-react';
import type { Dataset } from '../../types';
import { useCapability } from '../../engine/useCapability';
import { useLogRun } from '../../contexts/WorkspaceContext';
import RunBar from '../engine/RunBar';
import Provenance from '../engine/Provenance';
import { ResultFooter } from '../pins/PinButton';
import { columnsFor, type Field, type GuideStep, type Method, type Values } from './methodKit';
import { ENGINE_METHODS, GROUP_METHODS, GUIDES, type GroupId } from './methods';

/** A method that is an existing studio panel rather than an engine spec. */
export interface BuiltinMethod { title: string; answers: string; render: () => React.ReactNode }

// ------------------------------------------------------------------ "Help me choose"
const Guide: React.FC<{ guide: GuideStep; onPick: (id: string) => void }> = ({ guide, onPick }) => {
  const [open, setOpen] = useState(false);
  const [path, setPath] = useState<GuideStep[]>([guide]);
  const step = path[path.length - 1];
  if (!open) {
    return (
      <button type="button" className="btn btn-plain -ml-2 text-sm" onClick={() => setOpen(true)}>
        <Compass className="w-4 h-4" /> Not sure which method? Help me choose
      </button>
    );
  }
  return (
    <div className="rounded-2xl border border-separator p-4 space-y-3 animate-fade-in">
      <div className="flex items-start justify-between gap-3">
        <p className="text-sm font-semibold text-label">{step.question}</p>
        <button type="button" aria-label="Close the guide" className="text-label-3 hover:text-label" onClick={() => { setOpen(false); setPath([guide]); }}><X className="w-4 h-4" /></button>
      </div>
      <div className="flex flex-wrap gap-2">
        {step.options.map(o => (
          <button key={o.label} type="button" className="btn btn-secondary !text-sm"
            onClick={() => { if (o.next) setPath([...path, o.next]); else if (o.method) { onPick(o.method); setOpen(false); setPath([guide]); } }}>
            {o.label}
          </button>
        ))}
      </div>
      {path.length > 1 && <button type="button" className="text-xs text-label-2 inline-flex items-center gap-1" onClick={() => setPath(path.slice(0, -1))}><ChevronLeft className="w-3.5 h-3.5" /> Back</button>}
    </div>
  );
};

// ------------------------------------------------------------------ the form
export function initialValues(fields: Field[], dataset: Dataset): Values {
  const v: Values = {};
  const used = new Set<string>();
  for (const f of fields) {
    if (f.kind === 'column') {
      const first = f.optional ? '' : columnsFor(dataset, f.filter).find(c => !used.has(c)) ?? '';
      if (first) used.add(first);
      v[f.key] = first;
    } else if (f.kind === 'columns') v[f.key] = [];
    else if (f.kind === 'select') v[f.key] = f.default;
    else if (f.kind === 'number') v[f.key] = f.default ?? '';
    else if (f.kind === 'toggle') v[f.key] = f.default;
    else if (f.kind === 'arms') v[f.key] = [{ name: 'A', successes: '', trials: '' }, { name: 'B', successes: '', trials: '' }];
    else if (f.kind === 'custom') v[f.key] = f.initial();
    else v[f.key] = f.default ?? '';
  }
  return v;
}

export const shown = (f: Field, v: Values) => !f.when || f.when(v);

export function problems(fields: Field[], v: Values): string | null {
  for (const f of fields) {
    if (!shown(f, v)) continue;
    if (f.kind === 'column' && !f.optional && !v[f.key]) return `Choose ${f.label.toLowerCase()}.`;
    if (f.kind === 'columns' && (v[f.key]?.length ?? 0) < (f.min ?? 0)) return `Choose at least ${f.min} for “${f.label}”.`;
    if (f.kind === 'number' && !f.optional && (v[f.key] === '' || Number.isNaN(Number(v[f.key])))) return `Enter ${f.label.toLowerCase()}.`;
    if (f.kind === 'text' && !f.optional && !String(v[f.key]).trim()) return `Enter ${f.label.toLowerCase()}.`;
    if (f.kind === 'custom' && f.check) { const issue = f.check(v[f.key]); if (issue) return issue; }
    if (f.kind === 'arms' && (v[f.key] as any[]).some(a => !a.name || a.trials === '' || a.successes === '' || Number(a.successes) > Number(a.trials))) return 'Fill in each option’s successes and trials (successes ≤ trials).';
  }
  return null;
}

/** Parameters as they may be stored (history, pins): secret fields (passwords) left out. */
export function storedParams(m: Method, params: Record<string, unknown>): Record<string, unknown> {
  const secret = new Set(m.fields.filter(f => f.kind === 'text' && f.secret).map(f => f.key));
  return secret.size ? Object.fromEntries(Object.entries(params).filter(([k]) => !secret.has(k))) : params;
}
const storedValues = (m: Method, v: Values) => storedParams(m, v) as Values;

export function toParams(m: Method, fields: Field[], v: Values): Record<string, unknown> {
  const clean: Values = {};
  for (const f of fields) {
    if (!shown(f, v)) continue;
    const x = v[f.key];
    if (x === '' || x === undefined || (Array.isArray(x) && x.length === 0 && f.kind !== 'columns')) continue;
    if (f.kind === 'number') clean[f.key] = Number(x);
    else if (f.kind === 'arms') clean[f.key] = (x as any[]).map(a => ({ name: a.name, successes: Number(a.successes), trials: Number(a.trials) }));
    else clean[f.key] = x;
  }
  return m.params ? m.params(clean) : clean;
}

const FieldInput: React.FC<{ field: Field; dataset: Dataset; value: any; onChange: (v: any) => void; taken: string[]; id: string }> = ({ field: f, dataset, value, onChange, taken, id }) => {
  const label = <label className="field-label" htmlFor={id}>{f.label}</label>;
  if (f.kind === 'column') {
    const cols = columnsFor(dataset, f.filter);
    return <div>{label}<select id={id} data-agent={`field-${id}`} className="input" value={value} onChange={e => onChange(e.target.value)}>
      {f.optional && <option value="">None</option>}
      {cols.length === 0 && !f.optional && <option value="">No suitable column</option>}
      {cols.map(c => <option key={c} value={c}>{c}</option>)}
    </select></div>;
  }
  if (f.kind === 'columns') {
    const cols = columnsFor(dataset, f.filter).filter(c => !taken.includes(c));
    const sel: string[] = value ?? [];
    const toggle = (c: string) => onChange(sel.includes(c) ? sel.filter(x => x !== c) : f.max && sel.length >= f.max ? sel : [...sel, c]);
    return <div className="sm:col-span-2 lg:col-span-4">
      <span className="field-label" id={id}>{f.label}{f.max ? ` (up to ${f.max})` : ''}</span>
      <div className="flex flex-wrap gap-1.5" role="group" aria-labelledby={id}>
        {cols.map(c => (
          <button key={c} type="button" aria-pressed={sel.includes(c)} onClick={() => toggle(c)} data-agent={`field-${id}-${c}`}
            className={`px-2.5 py-1 rounded-full text-sm border transition-colors ${sel.includes(c) ? 'bg-blue text-white border-blue' : 'border-separator text-label hover:bg-fill'}`}>
            {c}
          </button>
        ))}
        {cols.length === 0 && <span className="text-sm text-label-3">No suitable columns.</span>}
      </div>
    </div>;
  }
  if (f.kind === 'select') return <div>{label}<select id={id} data-agent={`field-${id}`} className="input" value={value} onChange={e => onChange(e.target.value)}>{f.options.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}</select></div>;
  if (f.kind === 'number') return <div>{label}<input id={id} data-agent={`field-${id}`} className="input" type="number" inputMode="decimal" value={value} min={f.min} max={f.max} step={f.step ?? 'any'} placeholder={f.optional ? 'Optional' : ''} onChange={e => onChange(e.target.value)} /></div>;
  if (f.kind === 'toggle') return <label className="flex items-center gap-2 text-sm text-label self-end pb-2"><input data-agent={`field-${id}`} type="checkbox" checked={!!value} onChange={e => onChange(e.target.checked)} /> {f.label}</label>;
  if (f.kind === 'text' && f.multiline) return <div className="sm:col-span-2 lg:col-span-4">{label}<textarea id={id} data-agent={`field-${id}`} className="input min-h-[5rem] font-mono text-sm" value={value} placeholder={f.placeholder} onChange={e => onChange(e.target.value)} /></div>;
  if (f.kind === 'text') return <div className="sm:col-span-2">{label}<input id={id} type={f.secret ? 'password' : 'text'} autoComplete={f.secret ? 'off' : undefined} data-agent={`field-${id}`} className="input" value={value} placeholder={f.placeholder} onChange={e => onChange(e.target.value)} /></div>;
  if (f.kind === 'custom') { const Editor = f.editor; return <div className="sm:col-span-2 lg:col-span-4"><span className="field-label" id={id}>{f.label}</span><Editor value={value} onChange={onChange} id={id} dataset={dataset} /></div>; }
  // arms: results so far, one row per option
  const arms: any[] = value;
  const set = (i: number, k: string, x: string) => onChange(arms.map((a, j) => (j === i ? { ...a, [k]: x } : a)));
  return <div className="sm:col-span-2 lg:col-span-4 space-y-2">
    <span className="field-label">{f.label}</span>
    {arms.map((a, i) => (
      <div key={i} className="grid grid-cols-[1fr_1fr_1fr_auto] gap-2 items-center">
        <input className="input" aria-label="Option name" value={a.name} onChange={e => set(i, 'name', e.target.value)} />
        <input className="input" aria-label="Successes" type="number" inputMode="numeric" placeholder="Successes" value={a.successes} onChange={e => set(i, 'successes', e.target.value)} />
        <input className="input" aria-label="Trials" type="number" inputMode="numeric" placeholder="Trials" value={a.trials} onChange={e => set(i, 'trials', e.target.value)} />
        <button type="button" aria-label="Remove option" className="text-label-3 disabled:opacity-30" disabled={arms.length <= 2} onClick={() => onChange(arms.filter((_, j) => j !== i))}><X className="w-4 h-4" /></button>
      </div>
    ))}
    <button type="button" className="btn btn-plain -ml-2 !text-sm" onClick={() => onChange([...arms, { name: String.fromCharCode(65 + arms.length), successes: '', trials: '' }])}><Plus className="w-4 h-4" /> Add option</button>
  </div>;
};

const TONE = { good: 'text-green', warn: 'text-orange', plain: 'text-label' };

export const EngineMethod: React.FC<{ method: Method; dataset: Dataset }> = ({ method: m, dataset }) => {
  const run = useCapability(m.cap, dataset);
  const logRun = useLogRun();
  const [values, setValues] = useState<Values>(() => initialValues(m.fields, dataset));
  const [ran, setRan] = useState<Values | null>(null);
  const issue = problems(m.fields, values) ?? m.check?.(values) ?? null;
  const singles = m.fields.filter(f => f.kind === 'column').map(f => values[f.key]).filter(Boolean);
  const r = run.result as any;

  useEffect(() => {
    if (!r || !ran) return;
    let headline = '';
    try { headline = m.headline(r, ran); } catch { headline = m.title; }
    logRun({ kind: 'engine', title: m.title, summary: headline, status: 'succeeded', params: { capability: m.cap, params: storedParams(m, toParams(m, m.fields, ran)), runId: r.runId, view: { kind: 'method', methodId: m.id, values: storedValues(m, ran) } }, result: r });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [r]);

  let headline = '', tone: keyof typeof TONE = 'plain', body: React.ReactNode = null;
  if (r && ran) {
    try { headline = m.headline(r, ran); tone = m.tone?.(r, ran) ?? 'plain'; body = m.render(r, ran); }
    catch { headline = 'The result arrived but couldn’t be displayed fully.'; }
  }
  return (
    <div className="space-y-6">
      <div className="card p-4 sm:p-5 space-y-4" data-agent={`area-${m.id}`}>
        <div>
          <h3 className="card-title">{m.title}</h3>
          <p className="mt-1 text-sm text-label-2">{m.answers}</p>
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
          {m.fields.filter(f => shown(f, values)).map(f => (
            <FieldInput key={f.key} id={`${m.id}-${f.key}`} field={f} dataset={dataset} value={values[f.key]}
              taken={f.kind === 'columns' ? singles : []} onChange={x => setValues(prev => ({ ...prev, [f.key]: x }))} />
          ))}
        </div>
        <RunBar run={run} label="Run" agent={`${m.id}-run`} disabled={!!issue}
          onRun={() => { setRan(values); run.run(toParams(m, m.fields, values), { withDataset: m.fields.some(f => f.kind === 'column' || f.kind === 'columns') }); }} />
        {issue && run.phase === 'idle' && <p className="text-xs text-label-3">{issue}</p>}
      </div>
      {r && ran && (
        <div className="card p-4 sm:p-5 space-y-5 animate-fade-in" role="region" aria-label="Result">
          <p className={`text-[17px] font-semibold ${TONE[tone]}`}>{headline}</p>
          {body}
          <ResultFooter agent={`pin-${m.id}`} provenance={<Provenance manifest={r.manifest} runId={r.runId} notes={r.notes} />}
            pin={{ title: m.title, headline, view: { kind: 'method', methodId: m.id, values: storedValues(m, ran) }, capability: m.cap, params: storedParams(m, toParams(m, m.fields, ran)), result: r }} />
        </div>
      )}
    </div>
  );
};

/** One group of the Statistics stage: a guide, method chips, and the chosen method. */
export default function MethodPanel({ group, dataset, builtins = {} }: { group: GroupId; dataset: Dataset; builtins?: Record<string, BuiltinMethod> }) {
  const ids = useMemo(() => GROUP_METHODS[group].filter(id => builtins[id] || ENGINE_METHODS[id]), [group, builtins]);
  const [active, setActive] = useState(ids[0]);
  const guide = GUIDES[group];
  const title = (id: string) => builtins[id]?.title ?? ENGINE_METHODS[id]?.title ?? id;
  return (
    <div className="space-y-4">
      {ids.length > 1 && (
        <div className="space-y-2">
          <div className="flex flex-wrap gap-2" role="tablist" aria-label="Methods">
            {ids.map(id => (
              <button key={id} type="button" role="tab" aria-selected={active === id} data-agent={`method-${id}`} onClick={() => setActive(id)}
                className={`px-3 py-1.5 rounded-full text-sm transition-colors ${active === id ? 'bg-label text-surface' : 'bg-fill text-label hover:bg-fill-strong'}`}>
                {title(id)}
              </button>
            ))}
          </div>
          {guide && <Guide guide={guide} onPick={setActive} />}
        </div>
      )}
      {ids.map(id => (
        <div key={id} hidden={active !== id}>
          {builtins[id] ? builtins[id].render() : <EngineMethod method={ENGINE_METHODS[id]} dataset={dataset} />}
        </div>
      ))}
    </div>
  );
}
