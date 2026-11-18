/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { useCallback, useEffect, useState } from 'react';
import type { Block, ReportDoc, Section } from './buildReport';

/** How the user has shaped the report: kept per dataset in this browser. */
export interface ReportLayout {
  title: string;
  subtitle: string;
  author: string;
  organisation: string;
  /** Sections and blocks removed from the report (ids). */
  hidden: string[];
  /** Section order (ids); sections not listed keep their place at the end. */
  order: string[];
  /** Renamed section titles. */
  titles: Record<string, string>;
  /** The user's own text, per section (shown under its heading). */
  notes: Record<string, string>;
  /** A replacement for the generated executive summary, when written. */
  summary: string;
  showContents: boolean;
}

export const defaultLayout = (dataset: string): ReportLayout => ({
  title: 'Data Analysis Report', subtitle: dataset.replace(/\.[^.]+$/, ''), author: '', organisation: '',
  hidden: [], order: [], titles: {}, notes: {}, summary: '', showContents: true,
});

const key = (datasetId: string | null, dataset: string) => `report-layout:${datasetId ?? dataset}`;

export function useReportLayout(datasetId: string | null, dataset: string) {
  const [layout, setLayout] = useState<ReportLayout>(() => defaultLayout(dataset));
  useEffect(() => {
    try {
      const raw = localStorage.getItem(key(datasetId, dataset));
      setLayout(raw ? { ...defaultLayout(dataset), ...JSON.parse(raw) } : defaultLayout(dataset));
    } catch { setLayout(defaultLayout(dataset)); }
  }, [datasetId, dataset]);
  const update = useCallback((patch: Partial<ReportLayout> | ((l: ReportLayout) => Partial<ReportLayout>)) => {
    setLayout(prev => {
      const next = { ...prev, ...(typeof patch === 'function' ? patch(prev) : patch) };
      try { localStorage.setItem(key(datasetId, dataset), JSON.stringify(next)); } catch { /* private mode: keep it for this visit */ }
      return next;
    });
  }, [datasetId, dataset]);
  const reset = useCallback(() => update(defaultLayout(dataset)), [update, dataset]);
  return { layout, update, reset };
}

/** The report as shaped by the layout: sections in order, removed parts dropped, titles and notes applied. */
export function shapeReport(doc: ReportDoc, layout: ReportLayout): { sections: (Section & { note: string })[]; removed: { id: string; label: string }[] } {
  const byId = new Map(doc.sections.map(s => [s.id, s]));
  const ordered = [...layout.order.filter(id => byId.has(id)), ...doc.sections.map(s => s.id).filter(id => !layout.order.includes(id))].map(id => byId.get(id)!);
  const hidden = new Set(layout.hidden);
  const removed: { id: string; label: string }[] = [];
  const sections = ordered.flatMap(s => {
    const title = layout.titles[s.id] || s.title;
    if (hidden.has(s.id)) { removed.push({ id: s.id, label: `Section: ${title}` }); return []; }
    const blocks = s.blocks.filter(b => {
      if (!hidden.has(b.id)) return true;
      removed.push({ id: b.id, label: `${title} — ${blockLabel(b)}` });
      return false;
    }).map(b => (b.id === 'summary-text' && layout.summary.trim() ? { ...b, text: layout.summary } as Block : b));
    // Empty sections (nothing was done there) are left out of the report.
    if (!blocks.length && !layout.notes[s.id]?.trim()) return [];
    return [{ ...s, title, blocks, note: layout.notes[s.id] ?? '' }];
  });
  return { sections, removed };
}

export function blockLabel(b: Block): string {
  switch (b.kind) {
    case 'analysis': return b.title;
    case 'table': case 'bars': case 'histogram': case 'heatmap': case 'code': return b.caption ?? b.kind;
    case 'bullets': return b.title ?? 'List';
    case 'callout': return b.title ?? b.text.slice(0, 40);
    case 'stats': return 'Key figures';
    default: return b.text.slice(0, 48);
  }
}

// ------------------------------------------------------------------ Markdown export
const mdTable = (columns: { key: string; label: string }[], rows: Record<string, unknown>[]) => [
  `| ${columns.map(c => c.label).join(' | ')} |`, `| ${columns.map(() => '---').join(' | ')} |`,
  ...rows.map(r => `| ${columns.map(c => String(r[c.key] ?? '—').replace(/\|/g, '\\|').replace(/\n/g, ' ')).join(' | ')} |`),
].join('\n');

export function toMarkdown(sections: ReturnType<typeof shapeReport>['sections'], layout: ReportLayout, generatedAt: number): string {
  const out: string[] = [`# ${layout.title}`, ''];
  if (layout.subtitle) out.push(`**${layout.subtitle}**`, '');
  out.push([layout.author && `Prepared by ${layout.author}`, layout.organisation, new Date(generatedAt).toLocaleDateString(undefined, { dateStyle: 'long' })].filter(Boolean).join(' · '), '');
  if (layout.showContents) { out.push('## Contents', ''); sections.forEach((s, i) => out.push(`${i + 1}. ${s.title}`)); out.push(''); }
  sections.forEach((s, i) => {
    out.push(`## ${i + 1}. ${s.title}`, '', `_${s.intro}_`, '');
    if (s.note.trim()) out.push(s.note.trim(), '');
    for (const b of s.blocks) {
      switch (b.kind) {
        case 'paragraph': out.push(b.text, ''); break;
        case 'bullets': if (b.title) out.push(`**${b.title}**`, ''); b.items.forEach(x => out.push(`- ${x}`)); out.push(''); break;
        case 'stats': out.push(mdTable([{ key: 'k', label: 'Measure' }, { key: 'v', label: 'Value' }], b.items.map(([k, v]) => ({ k, v }))), ''); break;
        case 'table': if (b.caption) out.push(`**${b.caption}**`, ''); out.push(mdTable(b.columns, b.rows), ''); break;
        case 'bars': case 'histogram': out.push(`**${b.caption}**`, '', mdTable([{ key: 'label', label: 'Value' }, { key: 'value', label: 'Count / score' }], b.data), ''); break;
        case 'heatmap': out.push(`**${b.caption}**`, '', mdTable([{ key: 'c', label: '' }, ...b.columns.map((c, j) => ({ key: `m${j}`, label: c }))], b.columns.map((c, i2) => ({ c, ...Object.fromEntries(b.matrix[i2].map((v, j) => [`m${j}`, v == null ? '—' : v.toFixed(2)])) }))), ''); break;
        case 'code': out.push(`**${b.caption}**`, '', '```' + b.language, b.code, '```', ''); break;
        case 'callout': out.push(`> ${b.title ? `**${b.title}** ` : ''}${b.text}`, ''); break;
        case 'analysis': out.push(`### ${b.title}`, '', `**${b.headline}**`, ...b.lines.map(l => `- ${l}`), b.runId ? `\n_Engine run ${b.runId}._` : '', ''); break;
      }
    }
  });
  out.push('---', `_Generated by Data Science Studio by AskDeepakAI on ${new Date(generatedAt).toLocaleString()}._`);
  return out.join('\n');
}
