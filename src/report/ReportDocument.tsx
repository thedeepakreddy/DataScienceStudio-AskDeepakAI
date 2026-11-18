/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useMemo, useState } from 'react';
import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { ArrowDown, ArrowUp, Check, Copy, EyeOff, Pencil, X } from 'lucide-react';
import type { Block, Section } from './buildReport';
import type { ReportLayout } from './layout';
import { PinBody } from '../components/pins/PinnedResults';

const axis = { tick: { fontSize: 10, fill: '#6e6e73' }, stroke: 'rgba(0,0,0,0.12)' };
const fmt = (v: number) => Number(v.toPrecision(3)).toLocaleString();

// ------------------------------------------------------------------ blocks
function CodeBlock({ b }: { b: Extract<Block, { kind: 'code' }> }) {
  const [copied, setCopied] = useState(false);
  return (
    <figure className="space-y-1.5">
      <div className="flex items-center justify-between gap-2">
        <figcaption className="text-[13px] font-semibold text-label">{b.caption}</figcaption>
        <button type="button" className="report-edit-only btn btn-sm btn-plain !text-xs" onClick={() => { navigator.clipboard?.writeText(b.code).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1500); }); }}>
          {copied ? <><Check className="w-3.5 h-3.5" /> Copied</> : <><Copy className="w-3.5 h-3.5" /> Copy</>}
        </button>
      </div>
      <pre className="text-[11.5px] leading-relaxed font-mono bg-[#f5f5f7] border border-black/5 rounded-lg p-3 overflow-x-auto text-[#1d1d1f]"><code>{b.code}</code></pre>
    </figure>
  );
}

function BlockView({ b, n }: { b: Block; n: number }) {
  switch (b.kind) {
    case 'paragraph': return <p className="text-[14px] leading-relaxed text-label whitespace-pre-wrap">{b.text}</p>;
    case 'bullets': return (
      <div className="space-y-1.5">
        {b.title && <h4 className="text-[13px] font-semibold text-label">{b.title}</h4>}
        <ul className="list-disc pl-5 space-y-1 text-[14px] leading-relaxed text-label">{b.items.map((x, i) => <li key={i}>{x}</li>)}</ul>
      </div>
    );
    case 'stats': return (
      <dl className="grid grid-cols-2 sm:grid-cols-4 border border-black/10 rounded-lg overflow-hidden divide-x divide-y divide-black/10 [&>*]:border-black/10">
        {b.items.map(([k, v]) => (
          <div key={k} className="px-3 py-2.5 bg-white">
            <dt className="text-[11px] uppercase tracking-wide text-label-3">{k}</dt>
            <dd className="mt-0.5 text-[14px] font-semibold text-label tabular-nums break-words">{v}</dd>
          </div>
        ))}
      </dl>
    );
    case 'table': {
      return (
        <figure className="space-y-1.5">
          {b.caption && <figcaption className="text-[13px] font-semibold text-label">Table {n}. {b.caption}</figcaption>}
          <div className="overflow-x-auto border border-black/10 rounded-lg">
            <table className="w-full text-[12.5px] tabular-nums">
              <thead className="bg-[#f5f5f7]"><tr>{b.columns.map(c => <th key={c.key} className={`px-3 py-2 font-semibold text-label-2 border-b border-black/10 ${c.align === 'right' ? 'text-right' : 'text-left'}`}>{c.label}</th>)}</tr></thead>
              <tbody>{b.rows.map((r, i) => <tr key={i} className="even:bg-[#fafafa]">{b.columns.map(c => <td key={c.key} className={`px-3 py-1.5 border-b border-black/5 text-label align-top ${c.align === 'right' ? 'text-right' : ''}`}>{r[c.key] ?? '—'}</td>)}</tr>)}</tbody>
            </table>
          </div>
        </figure>
      );
    }
    case 'bars': case 'histogram': {
      const horizontal = b.kind === 'bars';
      return (
        <figure className="space-y-1.5">
          <figcaption className="text-[13px] font-semibold text-label">Figure {n}. {b.caption}</figcaption>
          <div data-report-visual={b.id} style={{ height: horizontal ? Math.max(140, b.data.length * 24 + 30) : 200 }} className="border border-black/10 rounded-lg p-2 bg-white">
            <ResponsiveContainer>
              {horizontal ? (
                <BarChart data={b.data} layout="vertical" margin={{ left: 8, right: 24, top: 4, bottom: 4 }}>
                  <CartesianGrid stroke="rgba(0,0,0,0.06)" horizontal={false} />
                  <XAxis type="number" {...axis} tickFormatter={fmt} /><YAxis type="category" dataKey="label" width={120} {...axis} interval={0} />
                  <Tooltip formatter={(v: any) => fmt(Number(v))} /><Bar dataKey="value" fill="#0071e3" radius={[0, 3, 3, 0]} isAnimationActive={false} />
                </BarChart>
              ) : (
                <BarChart data={b.data} margin={{ left: -8, right: 8, top: 4, bottom: 4 }}>
                  <CartesianGrid stroke="rgba(0,0,0,0.06)" vertical={false} />
                  <XAxis dataKey="label" {...axis} interval="preserveStartEnd" /><YAxis {...axis} />
                  <Tooltip /><Bar dataKey="value" name="rows" fill="#0071e3" isAnimationActive={false} />
                </BarChart>
              )}
            </ResponsiveContainer>
          </div>
        </figure>
      );
    }
    case 'heatmap': {
      return (
        <figure className="space-y-1.5">
          <figcaption className="text-[13px] font-semibold text-label">Figure {n}. {b.caption}</figcaption>
          <div className="overflow-x-auto">
            <table data-report-visual={b.id} className="text-[11px] tabular-nums border-separate border-spacing-0.5 bg-white">
              <thead><tr><th />{b.columns.map(c => <th key={c} className="px-1 font-medium text-label-2 max-w-[5.5rem] truncate">{c}</th>)}</tr></thead>
              <tbody>{b.matrix.map((row, i) => (
                <tr key={i}><th className="pr-2 text-left font-medium text-label-2 max-w-[8rem] truncate">{b.columns[i]}</th>
                  {row.map((v, j) => <td key={j} className="w-14 h-8 text-center rounded" style={{ background: v == null ? '#f5f5f7' : `color-mix(in srgb, ${v >= 0 ? '#0071e3' : '#c05300'} ${Math.round(Math.abs(v) * 55)}%, white)`, color: v != null && Math.abs(v) > 0.6 ? '#fff' : '#1d1d1f' }}>{v == null ? '—' : v.toFixed(2)}</td>)}
                </tr>))}</tbody>
            </table>
          </div>
        </figure>
      );
    }
    case 'code': return <CodeBlock b={b} />;
    case 'callout': return (
      <div className={`rounded-lg border px-4 py-3 text-[13.5px] leading-relaxed ${b.tone === 'warn' ? 'border-[#c05300]/30 bg-[#c05300]/5' : b.tone === 'ai' ? 'border-[#8944ab]/25 bg-[#8944ab]/5' : 'border-black/10 bg-[#f5f5f7]'}`}>
        {b.title && <p className="font-semibold text-label mb-0.5">{b.title}</p>}
        <p className="text-label whitespace-pre-wrap">{b.text}</p>
      </div>
    );
    case 'analysis': return (
      <article className="border border-black/10 rounded-lg p-4 space-y-3">
        <header>
          <h4 className="text-[14px] font-semibold text-label">{b.title}</h4>
          <p className="text-[11.5px] text-label-3">{new Date(b.when).toLocaleString()}{b.capability ? ` · ${b.capability}` : ''}{b.runId ? ` · run ${b.runId}` : ''}</p>
        </header>
        <p className="text-[14px] font-medium text-label leading-relaxed">{b.headline}</p>
        {b.lines.length > 0 && <ul className="list-disc pl-5 text-[13px] text-label-2 space-y-0.5">{b.lines.map((l, i) => <li key={i}>{l}</li>)}</ul>}
        {b.view && b.result != null && <div className="pt-1 bg-white" data-report-visual={b.id}><PinBody pin={{ view: b.view, result: b.result }} /></div>}
      </article>
    );
  }
}

// ------------------------------------------------------------------ the document
export default function ReportDocument({ sections, layout, editing, onHide, onMove, onRename, onNote, onSummary, generatedAt, datasetName }: {
  sections: (Section & { note: string })[];
  layout: ReportLayout;
  editing: boolean;
  onHide: (id: string) => void;
  onMove: (id: string, by: -1 | 1) => void;
  onRename: (id: string, title: string) => void;
  onNote: (id: string, text: string) => void;
  onSummary: (text: string) => void;
  generatedAt: number;
  datasetName: string;
}) {
  const [renaming, setRenaming] = useState<string | null>(null);
  // Tables and figures are numbered in reading order (separately), once per render.
  const numbers = useMemo(() => {
    const out = new Map<string, number>();
    let t = 0, fg = 0;
    for (const s of sections) for (const b of s.blocks) {
      if (b.kind === 'table' && b.caption) out.set(b.id, ++t);
      else if (b.kind === 'bars' || b.kind === 'histogram' || b.kind === 'heatmap') out.set(b.id, ++fg);
    }
    return out;
  }, [sections]);
  const date = new Date(generatedAt).toLocaleDateString(undefined, { dateStyle: 'long' });
  return (
    <div id="report-document" className="report-paper rounded-2xl shadow-sm border border-black/5 px-6 sm:px-12 py-10 sm:py-14 max-w-[860px] mx-auto">
      {/* Cover */}
      <header className="pb-8 mb-8 border-b-2 border-[#1d1d1f]">
        <p className="text-[11px] uppercase tracking-[0.18em] text-label-3">{layout.organisation || 'Data Science Studio'}</p>
        <h1 className="mt-3 text-[34px] leading-tight font-semibold tracking-tight text-label">{layout.title || 'Data Analysis Report'}</h1>
        {layout.subtitle && <p className="mt-2 text-[17px] text-label-2">{layout.subtitle}</p>}
        <dl className="mt-6 grid grid-cols-1 sm:grid-cols-3 gap-3 text-[12.5px]">
          <div><dt className="text-label-3">Dataset</dt><dd className="text-label font-medium truncate">{datasetName}</dd></div>
          <div><dt className="text-label-3">Prepared by</dt><dd className="text-label font-medium">{layout.author || '—'}</dd></div>
          <div><dt className="text-label-3">Date</dt><dd className="text-label font-medium">{date}</dd></div>
        </dl>
      </header>

      {layout.showContents && sections.length > 1 && (
        <nav aria-label="Contents" className="mb-10">
          <h2 className="text-[12px] uppercase tracking-[0.14em] text-label-3 mb-2">Contents</h2>
          <ol className="grid sm:grid-cols-2 gap-x-8 gap-y-1 text-[13.5px]">
            {sections.map((s, i) => <li key={s.id}><a href={`#report-${s.id}`} className="text-label hover:text-[#0071e3]"><span className="tabular-nums text-label-3 mr-2">{i + 1}.</span>{s.title}</a></li>)}
          </ol>
        </nav>
      )}

      {sections.map((s, i) => (
        <section key={s.id} id={`report-${s.id}`} className={`report-section ${i === 0 ? 'report-first' : ''} pt-2 pb-8 ${i ? 'border-t border-black/10 mt-2' : ''}`} aria-labelledby={`report-h-${s.id}`}>
          <div className="flex items-start justify-between gap-3 pt-6">
            {renaming === s.id ? (
              <input autoFocus aria-label="Section title" className="input text-[20px] font-semibold flex-1" defaultValue={s.title}
                onBlur={e => { onRename(s.id, e.target.value.trim()); setRenaming(null); }} onKeyDown={e => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); if (e.key === 'Escape') setRenaming(null); }} />
            ) : (
              <h2 id={`report-h-${s.id}`} className="text-[21px] font-semibold tracking-tight text-label"><span className="text-label-3 tabular-nums mr-2">{i + 1}</span>{s.title}</h2>
            )}
            {editing && (
              <div className="report-edit-only flex items-center gap-0.5 shrink-0">
                <button type="button" className="btn btn-icon w-8 h-8" aria-label={`Rename “${s.title}”`} onClick={() => setRenaming(s.id)}><Pencil className="w-3.5 h-3.5" /></button>
                <button type="button" className="btn btn-icon w-8 h-8" aria-label="Move section up" disabled={i === 0} onClick={() => onMove(s.id, -1)}><ArrowUp className="w-4 h-4" /></button>
                <button type="button" className="btn btn-icon w-8 h-8" aria-label="Move section down" disabled={i === sections.length - 1} onClick={() => onMove(s.id, 1)}><ArrowDown className="w-4 h-4" /></button>
                <button type="button" className="btn btn-icon w-8 h-8 text-[#c00013]" aria-label={`Remove section “${s.title}”`} onClick={() => onHide(s.id)}><EyeOff className="w-4 h-4" /></button>
              </div>
            )}
          </div>
          <p className="mt-1 text-[13px] text-label-2 italic">{s.intro}</p>

          {editing ? (
            <textarea className="report-edit-only input mt-4 min-h-[3.5rem] text-[14px]" placeholder="Add your own commentary for this section (optional)" value={s.note} onChange={e => onNote(s.id, e.target.value)} />
          ) : s.note.trim() ? <p className="mt-4 text-[14px] leading-relaxed text-label whitespace-pre-wrap border-l-2 border-[#0071e3] pl-3">{s.note}</p> : null}

          <div className="mt-5 space-y-6">
            {s.blocks.map(b => (
              <div key={b.id} className="report-block relative group">
                {editing && (
                  <button type="button" className="report-edit-only absolute -top-2 -right-2 z-10 w-7 h-7 rounded-full bg-white border border-black/15 shadow-sm flex items-center justify-center text-[#c00013] opacity-70 group-hover:opacity-100"
                    aria-label="Remove from the report" title="Remove from the report" onClick={() => onHide(b.id)}><X className="w-3.5 h-3.5" /></button>
                )}
                {editing && b.id === 'summary-text' ? (
                  <textarea className="report-edit-only input min-h-[6rem] text-[14px] leading-relaxed" value={layout.summary || (b.kind === 'paragraph' ? b.text : '')} onChange={e => onSummary(e.target.value)} aria-label="Executive summary" />
                ) : <BlockView b={b} n={numbers.get(b.id) ?? 0} />}
              </div>
            ))}
          </div>
        </section>
      ))}

      <footer className="mt-10 pt-4 border-t border-black/10 text-[11px] text-label-3 flex flex-wrap justify-between gap-2">
        <span>Generated by Data Science Studio by AskDeepakAI · {new Date(generatedAt).toLocaleString()}</span>
        <span>Numbers are computed from the data; AI-written text is labelled.</span>
      </footer>
    </div>
  );
}
