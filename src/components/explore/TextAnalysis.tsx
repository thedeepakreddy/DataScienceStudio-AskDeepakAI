/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useMemo, useState } from 'react';
import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Scatter, ScatterChart, Tooltip, XAxis, YAxis, ZAxis } from 'recharts';
import { Plus, Search, X } from 'lucide-react';
import type { Dataset } from '../../types';
import { useCapability } from '../../engine/useCapability';
import { CHART_COLORS, CHART_CURSOR } from '../../utils/chartTheme';
import RunBar from '../engine/RunBar';
import Provenance from '../engine/Provenance';

type Tool = 'sentiment' | 'topics' | 'labels' | 'entities' | 'search';

/** Columns that hold free text: several words per value on average, not short codes or categories. */
export function textColumns(dataset: Dataset): string[] {
  const sample = dataset.rows.slice(0, 300);
  return dataset.columns
    .filter(c => c.type === 'categorical')
    .filter(c => {
      const vals = sample.map(r => r[c.name]).filter(v => typeof v === 'string' && v.trim()) as string[];
      if (vals.length < 3) return false;
      const words = vals.reduce((s, v) => s + v.trim().split(/\s+/).length, 0) / vals.length;
      const chars = vals.reduce((s, v) => s + v.length, 0) / vals.length;
      return words >= 3 && chars >= 15;
    })
    .map(c => c.name);
}

const pct = (v: number) => `${Math.round(v * 100)}%`;
/** Repeated texts (common in real data) are shown once. */
const distinct = <T extends { text: string }>(items: T[] = []): T[] => {
  const seen = new Set<string>();
  return items.filter(i => !seen.has(i.text) && seen.add(i.text));
};
const SENTIMENT_COLOR: Record<string, string> = { positive: 'var(--green)', neutral: 'var(--label-3)', negative: 'var(--red)' };

function ResultCard({ children, result }: { children: React.ReactNode; result: any }) {
  return (
    <div className="card p-4 sm:p-5 space-y-5 animate-fade-in" role="region" aria-label="Result">
      {children}
      <div className="border-t border-separator pt-3 space-y-1">
        {result.model && (
          <p className="text-xs text-label-3">
            Model: <a className="underline" href={result.model.source} target="_blank" rel="noreferrer">{result.model.title}</a> · {result.model.license}
            {result.model.attribution && <> · {result.model.attribution}</>}
          </p>
        )}
        <Provenance manifest={result.manifest} runId={result.runId} notes={result.notes} />
      </div>
    </div>
  );
}

function ShareBar({ shares, colors }: { shares: Record<string, number>; colors?: Record<string, string> }) {
  const entries = Object.entries(shares);
  return (
    <div className="space-y-2">
      <div className="flex h-3 rounded-full overflow-hidden bg-fill" aria-hidden>
        {entries.map(([k, v], i) => (
          <div key={k} style={{ width: `${v * 100}%`, background: colors?.[k] ?? CHART_COLORS[i % CHART_COLORS.length] }} />
        ))}
      </div>
      <ul className="flex flex-wrap gap-x-4 gap-y-1 text-sm">
        {entries.map(([k, v], i) => (
          <li key={k} className="flex items-center gap-1.5">
            <span className="w-2.5 h-2.5 rounded-full" style={{ background: colors?.[k] ?? CHART_COLORS[i % CHART_COLORS.length] }} />
            <span className="text-label capitalize">{k}</span> <span className="tabular-nums text-label-2">{pct(v)}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

const Quote: React.FC<{ text: string; meta?: string }> = ({ text, meta }) => {
  return (
    <blockquote className="rounded-xl bg-fill px-3 py-2 text-sm text-label">
      “{text}”{meta && <span className="ml-2 text-xs text-label-3 tabular-nums">{meta}</span>}
    </blockquote>
  );
};

// ------------------------------------------------------------------ sentiment
const SentimentTool: React.FC<{ dataset: Dataset; column: string; groups: string[] }> = ({ dataset, column, groups }) => {
  const run = useCapability('text.sentiment', dataset);
  const [group, setGroup] = useState('');
  const r = run.result as any;
  const histogram = r?.histogram?.map((count: number, i: number) => ({ score: (-1 + (i + 0.5) * 0.1).toFixed(2), count })) ?? [];
  const leading = r && Object.entries(r.shares as Record<string, number>).sort((a, b) => b[1] - a[1])[0];
  return (
    <div className="space-y-6">
      <div className="card p-4 sm:p-5 space-y-4">
        <p className="text-sm text-label-2">Reads each text with a RoBERTa language model and classifies it as negative, neutral or positive. It handles sarcasm, negation and context much better than word lists.</p>
        {groups.length > 0 && (
          <div className="max-w-xs">
            <label className="field-label" htmlFor="sent-group">Compare by (optional)</label>
            <select id="sent-group" className="input" value={group} onChange={e => setGroup(e.target.value)}>
              <option value="">No comparison</option>
              {groups.map(g => <option key={g} value={g}>{g}</option>)}
            </select>
          </div>
        )}
        <RunBar run={run} label="Analyse sentiment" agent="text-sentiment-run" onRun={() => run.run({ column, group: group || null })} />
      </div>
      {r && (
        <ResultCard result={r}>
          <p className="text-[17px] font-semibold text-label">
            {leading[1] > 0.5 ? `Mostly ${leading[0]}` : `${leading[0][0].toUpperCase()}${leading[0].slice(1)} is the largest share`}: {pct(leading[1])} of {r.rows.toLocaleString()} texts. Average score {r.meanScore >= 0 ? '+' : ''}{r.meanScore.toFixed(2)} on a −1 to +1 scale.
          </p>
          <ShareBar shares={r.shares} colors={SENTIMENT_COLOR} />
          <div className="h-44">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={histogram} margin={{ top: 4, right: 4, bottom: 0, left: -20 }}>
                <CartesianGrid vertical={false} stroke="var(--separator)" />
                <XAxis dataKey="score" tick={{ fontSize: 11, fill: 'var(--label-2)' }} interval={3} />
                <YAxis allowDecimals={false} tick={{ fontSize: 11, fill: 'var(--label-2)' }} />
                <Tooltip cursor={CHART_CURSOR} formatter={(v: number) => [v, 'texts']} labelFormatter={l => `score ≈ ${l}`} />
                <Bar dataKey="count" fill="var(--blue)" radius={[3, 3, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
          </div>
          {r.byGroup && (
            <div className="space-y-2">
              <h4 className="text-sm font-semibold text-label">By {group}</h4>
              {(r.byGroup as any[]).sort((a, b) => b.meanScore - a.meanScore).slice(0, 12).map(g => (
                <div key={g.group} className="grid grid-cols-[minmax(0,8rem)_1fr_auto] items-center gap-3 text-sm">
                  <span className="truncate text-label">{g.group}</span>
                  <div className="flex h-2.5 rounded-full overflow-hidden bg-fill">
                    {['negative', 'neutral', 'positive'].map(k => <div key={k} style={{ width: `${(g[`${k}Share`] ?? 0) * 100}%`, background: SENTIMENT_COLOR[k] }} />)}
                  </div>
                  <span className="tabular-nums text-label-2 text-xs">{g.meanScore >= 0 ? '+' : ''}{g.meanScore.toFixed(2)} · {g.n}</span>
                </div>
              ))}
            </div>
          )}
          <div className="grid gap-4 md:grid-cols-3">
            {(['positive', 'neutral', 'negative'] as const).map(k => (
              <div key={k} className="space-y-2">
                <h4 className="text-sm font-semibold capitalize" style={{ color: SENTIMENT_COLOR[k] }}>Most {k}</h4>
                {distinct(r.examples[k]).slice(0, 2).map((e: any, i: number) => <Quote key={i} text={e.text} meta={pct(e.probability)} />)}
              </div>
            ))}
          </div>
        </ResultCard>
      )}
    </div>
  );
};

// ------------------------------------------------------------------ topics
const TopicsTool: React.FC<{ dataset: Dataset; column: string }> = ({ dataset, column }) => {
  const run = useCapability('text.semantic_topics', dataset);
  const [count, setCount] = useState<string>('auto');
  const r = run.result as any;
  const byTopic = useMemo(() => {
    const groups: Record<number, any[]> = {};
    for (const p of r?.map ?? []) (groups[p.topic] ??= []).push(p);
    return groups;
  }, [r]);
  return (
    <div className="space-y-6">
      <div className="card p-4 sm:p-5 space-y-4">
        <p className="text-sm text-label-2">Finds the themes people write about by meaning rather than shared words. Two texts can share a topic without sharing a single word.</p>
        <div className="max-w-xs">
          <label className="field-label" htmlFor="topic-count">Number of topics</label>
          <select id="topic-count" className="input" value={count} onChange={e => setCount(e.target.value)}>
            <option value="auto">Find them automatically</option>
            {[2, 3, 4, 5, 6, 8, 10, 12].map(n => <option key={n} value={n}>{n}</option>)}
          </select>
        </div>
        <RunBar run={run} label="Find topics" agent="text-topics-run" onRun={() => run.run({
          column, n_topics: count === 'auto' ? null : Number(count),
          min_topic_size: Math.max(5, Math.min(50, Math.round(dataset.rowCount / 40))),
        })} />
      </div>
      {r && (
        <ResultCard result={r}>
          <p className="text-[17px] font-semibold text-label">
            {r.topics.length} topics across {r.rows.toLocaleString()} texts{r.outlierShare > 0.01 ? `; ${pct(r.outlierShare)} didn’t fit any clearly` : ''}.
          </p>
          <div className="grid gap-3 md:grid-cols-2">
            {r.topics.map((t: any, i: number) => (
              <div key={t.topic} className="rounded-xl border border-separator p-3 space-y-2">
                <div className="flex items-center justify-between gap-2">
                  <span className="flex items-center gap-2 text-sm font-semibold text-label">
                    <span className="w-2.5 h-2.5 rounded-full" style={{ background: CHART_COLORS[i % CHART_COLORS.length] }} /> Topic {t.topic}
                  </span>
                  <span className="text-xs tabular-nums text-label-2">{pct(t.share)} · {t.size}</span>
                </div>
                <div className="flex flex-wrap gap-1.5">{t.keywords.slice(0, 6).map((k: string) => <span key={k} className="px-2 py-0.5 rounded-full bg-fill text-xs text-label">{k}</span>)}</div>
                {t.typical[0] && <Quote text={t.typical[0]} />}
              </div>
            ))}
          </div>
          <div className="h-72">
            <ResponsiveContainer width="100%" height="100%">
              <ScatterChart margin={{ top: 4, right: 4, bottom: 0, left: -20 }}>
                <XAxis dataKey="x" type="number" hide domain={['dataMin', 'dataMax']} /><YAxis dataKey="y" type="number" hide domain={['dataMin', 'dataMax']} /><ZAxis range={[24, 24]} />
                <Tooltip cursor={false} content={(props: any) => props.payload?.[0] ? <div className="card px-2 py-1 text-xs max-w-[240px]">{props.payload[0].payload.text}</div> : null} />
                {(Object.entries(byTopic) as [string, any[]][]).map(([topic, pts]) => (
                  <Scatter key={topic} data={pts} fill={Number(topic) === 0 ? 'var(--label-3)' : CHART_COLORS[(Number(topic) - 1) % CHART_COLORS.length]} fillOpacity={0.7} />
                ))}
              </ScatterChart>
            </ResponsiveContainer>
          </div>
          <p className="text-xs text-label-3 -mt-3">A map of meaning: texts that say similar things sit close together. Grey points didn’t fit a topic.</p>
        </ResultCard>
      )}
    </div>
  );
};

// ------------------------------------------------------------------ your labels (zero-shot)
const LabelsTool: React.FC<{ dataset: Dataset; column: string }> = ({ dataset, column }) => {
  const run = useCapability('text.zero_shot', dataset);
  const [labels, setLabels] = useState<string[]>([]);
  const [draft, setDraft] = useState('');
  const [multi, setMulti] = useState(false);
  const r = run.result as any;
  const add = () => {
    const parts = draft.split(',').map(s => s.trim()).filter(Boolean);
    if (parts.length) setLabels(prev => Array.from(new Set([...prev, ...parts])).slice(0, 20));
    setDraft('');
  };
  return (
    <div className="space-y-6">
      <div className="card p-4 sm:p-5 space-y-4">
        <p className="text-sm text-label-2">Sorts texts into categories you name, with no training data. Write each category in plain words, such as “delivery”, “price” or “product quality”.</p>
        <div>
          <label className="field-label" htmlFor="zs-label">Categories (at least two)</label>
          <div className="flex gap-2">
            <input id="zs-label" className="input" placeholder="e.g. delivery, price, quality" value={draft} onChange={e => setDraft(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); add(); } }} />
            <button type="button" className="btn btn-secondary" onClick={add} aria-label="Add category"><Plus className="w-4 h-4" /></button>
          </div>
          {labels.length > 0 && (
            <div className="mt-2 flex flex-wrap gap-1.5">
              {labels.map(l => (
                <span key={l} className="inline-flex items-center gap-1 px-2.5 py-1 rounded-full bg-blue/12 text-blue text-sm">
                  {l}<button type="button" aria-label={`Remove ${l}`} onClick={() => setLabels(labels.filter(x => x !== l))}><X className="w-3.5 h-3.5" /></button>
                </span>
              ))}
            </div>
          )}
        </div>
        <label className="flex items-center gap-2 text-sm text-label">
          <input type="checkbox" checked={multi} onChange={e => setMulti(e.target.checked)} /> A text can belong to several categories
        </label>
        <RunBar run={run} label="Sort into categories" agent="text-labels-run" disabled={labels.length < 2}
          onRun={() => run.run({ column, labels, multi_label: multi, max_rows: 3000 })} />
        <p className="text-xs text-label-3">Reads each text once per category, so it covers the first 3,000 texts.</p>
      </div>
      {r && (
        <ResultCard result={r}>
          {(() => {
            const top = Object.entries(r.shares as Record<string, number>).sort((a, b) => b[1] - a[1])[0];
            return <p className="text-[17px] font-semibold text-label">“{top[0]}” is the largest category: {pct(top[1])} of {r.rows.toLocaleString()} texts.</p>;
          })()}
          <div className="space-y-2">
            {Object.entries(r.shares as Record<string, number>).sort((a, b) => b[1] - a[1]).map(([k, v], i) => (
              <div key={k} className="grid grid-cols-[minmax(0,10rem)_1fr_3rem] items-center gap-3 text-sm">
                <span className="truncate text-label">{k}</span>
                <div className="h-2.5 rounded-full bg-fill overflow-hidden"><div className="h-full rounded-full" style={{ width: `${v * 100}%`, background: CHART_COLORS[i % CHART_COLORS.length] }} /></div>
                <span className="tabular-nums text-label-2 text-right">{pct(v)}</span>
              </div>
            ))}
          </div>
          {r.multiLabel && r.noLabelShare > 0 && <p className="text-sm text-label-2">{pct(r.noLabelShare)} fit none of the categories.</p>}
          <div className="grid gap-4 md:grid-cols-2">
            {r.labels.map((l: string) => (
              <div key={l} className="space-y-2">
                <h4 className="text-sm font-semibold text-label">Clearest “{l}”</h4>
                {distinct(r.examples[l]).slice(0, 2).map((e: any, i: number) => <Quote key={i} text={e.text} meta={pct(e.score)} />)}
              </div>
            ))}
          </div>
        </ResultCard>
      )}
    </div>
  );
};

// ------------------------------------------------------------------ entities
const ENTITY_STYLE: Record<string, { label: string; color: string }> = {
  PER: { label: 'People', color: 'var(--blue)' }, ORG: { label: 'Organisations', color: 'var(--purple, #a855f7)' },
  LOC: { label: 'Places', color: 'var(--green)' }, MISC: { label: 'Other names', color: 'var(--orange)' },
};

function Highlighted({ text, entities }: { text: string; entities: any[] }) {
  const parts: React.ReactNode[] = [];
  let at = 0;
  for (const e of [...entities].sort((a, b) => a.start - b.start)) {
    if (e.start < at || e.end > text.length) continue;
    if (e.start > at) parts.push(text.slice(at, e.start));
    const style = ENTITY_STYLE[e.type];
    parts.push(<mark key={e.start} className="rounded px-0.5" style={{ background: `color-mix(in srgb, ${style?.color ?? 'var(--blue)'} 18%, transparent)`, color: 'inherit' }} title={style?.label}>{text.slice(e.start, e.end)}</mark>);
    at = e.end;
  }
  parts.push(text.slice(at));
  return <p className="text-sm text-label leading-relaxed">{parts}</p>;
}

const EntitiesTool: React.FC<{ dataset: Dataset; column: string }> = ({ dataset, column }) => {
  const run = useCapability('text.entities', dataset);
  const r = run.result as any;
  return (
    <div className="space-y-6">
      <div className="card p-4 sm:p-5 space-y-4">
        <p className="text-sm text-label-2">Finds the people, organisations and places mentioned in each text, and counts which come up most.</p>
        <RunBar run={run} label="Find names" agent="text-entities-run" onRun={() => run.run({ column, top: 15 })} />
      </div>
      {r && (
        <ResultCard result={r}>
          <p className="text-[17px] font-semibold text-label">
            {r.rowsWithEntities.toLocaleString()} of {r.rows.toLocaleString()} texts mention a name{r.byType.length ? `; ${r.byType.map((t: any) => `${t.distinct} ${ENTITY_STYLE[t.type]?.label.toLowerCase() ?? t.label}`).join(', ')}` : ''}.
          </p>
          <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
            {r.byType.map((t: any) => (
              <div key={t.type} className="rounded-xl border border-separator p-3 space-y-2">
                <h4 className="text-sm font-semibold" style={{ color: ENTITY_STYLE[t.type]?.color }}>{ENTITY_STYLE[t.type]?.label ?? t.label}</h4>
                <ol className="space-y-1">
                  {t.top.slice(0, 8).map((x: any) => (
                    <li key={x.text} className="flex justify-between gap-2 text-sm"><span className="truncate text-label">{x.text}</span><span className="tabular-nums text-label-2">{x.count}</span></li>
                  ))}
                </ol>
              </div>
            ))}
          </div>
          <div className="space-y-2">
            <h4 className="text-sm font-semibold text-label">In context</h4>
            {distinct(r.sample.filter((s: any) => s.entities.length)).slice(0, 5).map((s: any, i: number) => (
              <div key={i} className="rounded-xl bg-fill px-3 py-2"><Highlighted text={s.text} entities={s.entities} /></div>
            ))}
          </div>
        </ResultCard>
      )}
    </div>
  );
};

// ------------------------------------------------------------------ search by meaning
const SearchTool: React.FC<{ dataset: Dataset; column: string }> = ({ dataset, column }) => {
  const search = useCapability('text.semantic_search', dataset);
  const dupes = useCapability('text.semantic_search', dataset);
  const [query, setQuery] = useState('');
  const r = search.result as any;
  const d = dupes.result as any;
  return (
    <div className="space-y-6">
      <div className="card p-4 sm:p-5 space-y-4">
        <p className="text-sm text-label-2">Ask in your own words. It finds the texts that mean the same thing, even when they use different words.</p>
        <form className="flex gap-2" onSubmit={e => { e.preventDefault(); if (query.trim()) search.run({ column, query: query.trim(), top: 10 }); }}>
          <input className="input" placeholder="e.g. customers who want a refund" value={query} onChange={e => setQuery(e.target.value)} aria-label="Search by meaning" />
          <button type="submit" className="btn btn-primary" disabled={!query.trim() || search.phase === 'running' || search.phase === 'syncing'} data-agent="text-search-run">
            <Search className="w-4 h-4" /> Search
          </button>
        </form>
        {(search.phase === 'running' || search.phase === 'syncing' || search.error) && <RunBar run={search} label="Search" onRun={() => search.run({ column, query, top: 10 })} />}
      </div>
      {r && (
        <ResultCard result={r}>
          <p className="text-[17px] font-semibold text-label">Closest in meaning to “{r.results[0].query}”</p>
          <ol className="space-y-2">
            {r.results[0].matches.map((m: any, i: number) => (
              <li key={i} className="grid grid-cols-[1fr_auto] gap-3 items-center rounded-xl bg-fill px-3 py-2">
                <span className="text-sm text-label">{m.text}</span>
                <span className="text-right">
                  <span className="block text-xs tabular-nums text-label-2">{pct(Math.max(0, m.similarity))} match</span>
                  {m.count > 1 && <span className="block text-xs text-label-3">×{m.count} rows</span>}
                </span>
              </li>
            ))}
          </ol>
        </ResultCard>
      )}
      <div className="card p-4 sm:p-5 space-y-4">
        <div>
          <h4 className="card-title">Texts that say the same thing</h4>
          <p className="mt-1 text-sm text-label-2">Groups texts that are near-duplicates in meaning, such as repeated complaints or copy-pasted messages.</p>
        </div>
        <RunBar run={dupes} label="Find near-duplicates" onRun={() => dupes.run({ column, duplicate_threshold: 0.9, top: 10 })} />
        {d && (
          <div className="space-y-2 animate-fade-in">
            <p className="text-sm font-semibold text-label">{d.groupCount ? `${d.groupCount} groups of texts that say the same thing` : 'No near-duplicates found.'}</p>
            {d.duplicateGroups?.slice(0, 6).map((g: any, i: number) => (
              <div key={i} className="rounded-xl border border-separator p-3 space-y-1">
                <p className="text-xs text-label-2">{g.rows.length} texts</p>
                {g.texts.slice(0, 3).map((t: string, j: number) => <p key={j} className="text-sm text-label truncate">“{t}”</p>)}
              </div>
            ))}
            <Provenance manifest={d.manifest} runId={d.runId} notes={d.notes} />
          </div>
        )}
      </div>
    </div>
  );
};

// ------------------------------------------------------------------ the tab
const TOOLS: { id: Tool; label: string }[] = [
  { id: 'sentiment', label: 'Sentiment' },
  { id: 'topics', label: 'Topics' },
  { id: 'labels', label: 'Your categories' },
  { id: 'entities', label: 'People & places' },
  { id: 'search', label: 'Search by meaning' },
];

/** Explore → Text: language models over the dataset's free-text columns. */
export default function TextAnalysis({ dataset }: { dataset: Dataset }) {
  const cols = useMemo(() => textColumns(dataset), [dataset]);
  const groups = useMemo(() => dataset.columns.filter(c => (c.type === 'categorical' || c.type === 'boolean') && !cols.includes(c.name) && c.distinctCount >= 2 && c.distinctCount <= 30).map(c => c.name), [dataset, cols]);
  const [column, setColumn] = useState(cols[0] ?? '');
  const [tool, setTool] = useState<Tool>('sentiment');

  if (!cols.length) {
    return <div className="card p-5 text-sm text-label-2">This dataset has no free-text column (such as reviews, comments or messages), so there’s nothing to read here.</div>;
  }
  return (
    <div className="space-y-6">
      <div className="flex flex-col sm:flex-row sm:items-end gap-4">
        <div className="sm:w-64">
          <label className="field-label" htmlFor="text-col">Text column</label>
          <select id="text-col" className="input" value={column} onChange={e => setColumn(e.target.value)} data-agent="text-column">
            {cols.map(c => <option key={c} value={c}>{c}</option>)}
          </select>
        </div>
        <div className="overflow-x-auto scrollbar-none -mx-4 px-4 sm:mx-0 sm:px-0">
          <div className="segmented w-max" role="tablist" aria-label="Text tools">
            {TOOLS.map(t => (
              <button key={t.id} type="button" role="tab" aria-selected={tool === t.id} data-agent={`text-tab-${t.id}`} onClick={() => setTool(t.id)}>{t.label}</button>
            ))}
          </div>
        </div>
      </div>
      {/* Each tool keeps its own result while you switch between them. */}
      <div hidden={tool !== 'sentiment'}><SentimentTool key={`s-${column}`} dataset={dataset} column={column} groups={groups} /></div>
      <div hidden={tool !== 'topics'}><TopicsTool key={`t-${column}`} dataset={dataset} column={column} /></div>
      <div hidden={tool !== 'labels'}><LabelsTool key={`l-${column}`} dataset={dataset} column={column} /></div>
      <div hidden={tool !== 'entities'}><EntitiesTool key={`e-${column}`} dataset={dataset} column={column} /></div>
      <div hidden={tool !== 'search'}><SearchTool key={`q-${column}`} dataset={dataset} column={column} /></div>
    </div>
  );
}
