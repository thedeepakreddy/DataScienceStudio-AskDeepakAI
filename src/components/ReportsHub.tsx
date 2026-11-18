/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useEffect, useMemo, useState } from 'react';
import { Check, Code2, Download, Eye, FileText, Globe, Package, Pencil, Printer, RotateCcw, Undo2 } from 'lucide-react';
import { DatasetVersion, PinRecord, RunRecord, SavedDashboard, listDashboards, listPins, listRegisteredModels, listRuns, listVersions, PINS_CHANGED_EVENT } from '../utils/workspaceStore';
import { buildNotebook, lineage, rowsToCsv } from '../utils/provenance';
import { RegisteredModel, modelCardMarkdown } from '../utils/modelRegistry';
import { workflowSteps } from '../operations/workflows';
import { ZipEntry, createZip } from '../utils/zip';
import { Dataset, MLResult } from '../types';
import { computeReportFindings } from '../utils/reportFindings';
import { engine } from '../engine/client';
import { RUN_LOGGED_EVENT } from '../swarm/interaction';
import { buildReport } from '../report/buildReport';
import { shapeReport, toMarkdown, useReportLayout } from '../report/layout';
import { download, printReport, toHtml, toPdf } from '../report/exporters';
import ReportDocument from '../report/ReportDocument';
import ExecutivePDFReport from './ExecutivePDFReport';
import ETLPipelineExport from './ETLPipelineExport';
import EngineWorkbench from './engine/EngineWorkbench';
import { usePipelineContext } from '../contexts/PipelineContext';

interface ReportsHubProps {
  dataset: Dataset;
  aiAnalysis: any;
  mlResult: MLResult | null;
  datasetId?: string | null;
  activeVersionId?: string | null;
}

/**
 * The Report step: a structured report assembled from everything done in the
 * studio for this dataset — the data, its quality and preparation (with the
 * pandas and SQL), exploration, statistics, models, forecasts, the dashboard's
 * KPIs and pins, and how to reproduce it all. You shape it (remove parts,
 * reorder, rename, add commentary) and export it as PDF, HTML or Markdown.
 */
export default function ReportsHub({ dataset, aiAnalysis, mlResult, datasetId = null, activeVersionId = null }: ReportsHubProps) {
  const { expertMode } = usePipelineContext();
  const findings = useMemo(() => computeReportFindings(dataset, mlResult), [dataset, mlResult]);

  // Everything the report draws on, reloaded as work happens elsewhere in the studio.
  const [versions, setVersions] = useState<DatasetVersion[]>([]);
  const [runs, setRuns] = useState<RunRecord[]>([]);
  const [activeModel, setActiveModel] = useState<RegisteredModel | null>(null);
  const [pins, setPins] = useState<PinRecord[]>([]);
  const [dashboards, setDashboards] = useState<SavedDashboard[]>([]);
  const [engineInfo, setEngineInfo] = useState<{ engineVersion: string; libraries: Record<string, string> } | null>(null);
  const [tick, setTick] = useState(0);
  useEffect(() => {
    const bump = () => setTick(t => t + 1);
    window.addEventListener(RUN_LOGGED_EVENT, bump);
    window.addEventListener(PINS_CHANGED_EVENT, bump);
    return () => { window.removeEventListener(RUN_LOGGED_EVENT, bump); window.removeEventListener(PINS_CHANGED_EVENT, bump); };
  }, []);
  useEffect(() => {
    let cancelled = false;
    (async () => {
      if (!datasetId) return;
      const [vs, rs, models, ps, ds] = await Promise.all([listVersions(datasetId), listRuns(600), listRegisteredModels(datasetId), listPins(datasetId), listDashboards(datasetId)]);
      if (cancelled) return;
      const ids = new Set(vs.map(v => v.id));
      setVersions(vs);
      setRuns(rs.filter(r => r.versionId && ids.has(r.versionId) && r.status === 'succeeded'));
      setActiveModel(models.find(m => m.active) ?? null);
      setPins(ps);
      setDashboards(ds);
    })().catch(() => {});
    return () => { cancelled = true; };
  }, [datasetId, activeVersionId, tick]);
  useEffect(() => { engine.info().then(i => setEngineInfo(i)).catch(() => setEngineInfo(null)); }, []);

  const chain = useMemo(() => lineage(versions, activeVersionId), [versions, activeVersionId]);
  const doc = useMemo(() => buildReport({ dataset, findings, mlResult, aiAnalysis, chain, runs, activeModel, pins, dashboards, engineInfo }),
    [dataset, findings, mlResult, aiAnalysis, chain, runs, activeModel, pins, dashboards, engineInfo]);

  const { layout, update, reset } = useReportLayout(datasetId, dataset.filename);
  const { sections, removed } = useMemo(() => shapeReport(doc, layout), [doc, layout]);
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  const baseName = (layout.subtitle || dataset.filename).replace(/\.[^/.]+$/, '').replace(/[^A-Za-z0-9_-]+/g, '_') || 'report';
  const hide = (id: string) => update(l => ({ hidden: [...new Set([...l.hidden, id])] }));
  const restore = (id: string) => update(l => ({ hidden: l.hidden.filter(x => x !== id) }));
  const move = (id: string, by: -1 | 1) => update(() => {
    const ids = sections.map(s => s.id);
    const i = ids.indexOf(id), j = i + by;
    if (i < 0 || j < 0 || j >= ids.length) return {};
    [ids[i], ids[j]] = [ids[j], ids[i]];
    // Keep hidden sections' places after the visible ones.
    return { order: [...ids, ...doc.sections.map(s => s.id).filter(x => !ids.includes(x))] };
  });
  const notify = (t: string) => { setMessage(t); setTimeout(() => setMessage(m => (m === t ? null : m)), 4000); };

  const downloadPdf = () => { toPdf(sections, layout, dataset.filename, doc.generatedAt).save(`${baseName}_report.pdf`); notify('Saved the PDF.'); };
  const downloadHtml = () => {
    const el = document.getElementById('report-document');
    if (el) { download(`${baseName}_report.html`, toHtml(el, layout.title), 'text/html'); notify('Saved the HTML report (charts included).'); }
  };
  const downloadMarkdown = () => { download(`${baseName}_report.md`, toMarkdown(sections, layout, doc.generatedAt), 'text/markdown'); notify('Saved the Markdown report.'); };

  const downloadPackage = async () => {
    setBusy('package');
    try {
      const columns = dataset.columns.map(c => c.name);
      const original = chain[0]?.dataset;
      const { steps, skipped } = workflowSteps(chain);
      const el = document.getElementById('report-document');
      const prep = doc.sections.find(s => s.id === 'preparation')?.blocks.find(b => b.id === 'prep-pandas');
      const files: ZipEntry[] = [
        { path: 'README.md', data: `# ${layout.title} — ${dataset.filename}\n\nExported from Data Science Studio on ${new Date().toISOString()}.\n\n- \`report.pdf\`, \`report.html\`, \`report.md\`: the report (HTML keeps the charts).\n- \`data/current.csv\`: the data the report is based on (${dataset.rows.length.toLocaleString()} rows).\n${original ? `- \`data/original.csv\`: the data as imported (${original.rows.length.toLocaleString()} rows).\n` : ''}- \`prepare.py\`: the cleaning steps as pandas code.\n- \`analysis.ipynb\`: a notebook that reloads the data and repeats the model and tests.\n- \`lineage.json\`, \`workflow.json\`, \`analyses.json\`: every data version, the repeatable steps${skipped.length ? ` (not repeatable: ${skipped.join('; ')})` : ''}, and every saved analysis with its full result.\n${activeModel ? '- `model_card.md`: the active registered model’s card.\n' : ''}` },
        { path: 'report.pdf', data: toPdf(sections, layout, dataset.filename, doc.generatedAt).output('arraybuffer') },
        ...(el ? [{ path: 'report.html', data: toHtml(el, layout.title) }] : []),
        { path: 'report.md', data: toMarkdown(sections, layout, doc.generatedAt) },
        { path: 'data/current.csv', data: rowsToCsv(dataset.rows, columns) },
        ...(original ? [{ path: 'data/original.csv', data: rowsToCsv(original.rows, original.columns.map(c => c.name)) }] : []),
        ...(prep && prep.kind === 'code' ? [{ path: 'prepare.py', data: prep.code }] : []),
        { path: 'lineage.json', data: JSON.stringify(chain.map((v, i) => ({ version: i + 1, id: v.id, parentId: v.parentId, label: v.label, createdAt: new Date(v.createdAt).toISOString(), rows: v.rowCount, columns: v.columnCount, operation: v.operation ?? null })), null, 2) },
        { path: 'workflow.json', data: JSON.stringify({ steps, notRepeatable: skipped }, null, 2) },
        { path: 'analyses.json', data: JSON.stringify(runs.map(r => ({ kind: r.kind, title: r.title, summary: r.summary, createdAt: new Date(r.createdAt).toISOString(), params: r.params, result: r.result })), null, 2) },
        { path: 'analysis.ipynb', data: buildNotebook({ datasetName: dataset.filename, dataFile: 'data/current.csv', versionLabel: chain[chain.length - 1]?.label ?? 'current', model: activeModel && activeModel.versionId === activeVersionId ? activeModel : null, tests: runs }) },
      ];
      if (activeModel) files.push({ path: 'model_card.md', data: modelCardMarkdown(activeModel, dataset.filename, versions.find(v => v.id === activeModel.versionId)?.label ?? 'no longer saved') });
      download(`${baseName}_reproducibility.zip`, createZip(files), 'application/zip');
      notify(`Saved ${baseName}_reproducibility.zip (${files.length} files).`);
    } catch (err) {
      notify(`Couldn’t create the package: ${(err as Error).message}`);
    } finally { setBusy(null); }
  };

  const counts = useMemo(() => new Map(sections.map(s => [s.id, s.blocks.length])), [sections]);

  return (
    <div className="space-y-6" id="unified_strategy_workspace">
      {/* Toolbar */}
      <div className="card p-4 sm:p-5 space-y-4 print:hidden">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="min-w-0">
            <h2 className="card-title">Your report</h2>
            <p className="mt-0.5 text-sm text-label-2">
              Built from everything you did on {dataset.filename}: {sections.length} sections, {sections.reduce((a, s) => a + s.blocks.length, 0)} parts. It updates as you work; your edits are kept.
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <button type="button" className={`btn ${editing ? 'btn-primary' : 'btn-secondary'}`} onClick={() => setEditing(e => !e)} data-agent="report-edit" aria-pressed={editing}>
              {editing ? <><Check className="w-4 h-4" /> Done editing</> : <><Pencil className="w-4 h-4" /> Edit report</>}
            </button>
            <button type="button" className="btn btn-secondary" onClick={printReport} title="Print, or choose “Save as PDF” — keeps the charts"><Printer className="w-4 h-4" /> Print</button>
            <button type="button" className="btn btn-secondary" onClick={downloadHtml} title="One file that opens in any browser, charts included"><Globe className="w-4 h-4" /> HTML</button>
            <button type="button" className="btn btn-secondary" onClick={downloadMarkdown}><FileText className="w-4 h-4" /> Markdown</button>
            <button type="button" data-agent="report-package" onClick={downloadPackage} disabled={busy === 'package'} className="btn btn-secondary" title="Report, data, pandas code, notebook and lineage in one ZIP"><Package className="w-4 h-4" /> Package</button>
            <button type="button" data-agent="report-pdf" onClick={downloadPdf} className="btn btn-primary" title="Download an A4 PDF"><Download className="w-4 h-4" /> Download PDF</button>
          </div>
        </div>
        {message && <p className="text-sm text-green" role="status">{message}</p>}

        {editing && (
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3 pt-3 border-t border-separator animate-fade-in">
            <div><label className="field-label" htmlFor="rep-title">Title</label><input id="rep-title" className="input" value={layout.title} onChange={e => update({ title: e.target.value })} /></div>
            <div><label className="field-label" htmlFor="rep-subtitle">Subtitle</label><input id="rep-subtitle" className="input" value={layout.subtitle} onChange={e => update({ subtitle: e.target.value })} /></div>
            <div><label className="field-label" htmlFor="rep-author">Prepared by</label><input id="rep-author" className="input" value={layout.author} placeholder="Your name" onChange={e => update({ author: e.target.value })} /></div>
            <div><label className="field-label" htmlFor="rep-org">Organisation</label><input id="rep-org" className="input" value={layout.organisation} placeholder="Optional" onChange={e => update({ organisation: e.target.value })} /></div>
          </div>
        )}
      </div>

      <div className="grid grid-cols-1 xl:grid-cols-[260px_minmax(0,1fr)] gap-6 items-start">
        {/* Outline */}
        <aside className="card p-4 space-y-4 xl:sticky xl:top-24 print:hidden" aria-label="Report outline">
          <div>
            <h3 className="text-sm font-semibold text-label">Outline</h3>
            <p className="text-xs text-label-3 mt-0.5">Tick to include. Use Edit report to reorder, rename, remove parts and add your commentary.</p>
          </div>
          <ul className="space-y-1">
            {doc.sections.map(s => {
              const included = !layout.hidden.includes(s.id);
              const shown = sections.find(x => x.id === s.id);
              return (
                <li key={s.id}>
                  <label className={`flex items-center gap-2 text-sm rounded-lg px-2 py-1.5 ${shown ? 'text-label' : 'text-label-3'} hover:bg-fill/60 cursor-pointer`}>
                    <input type="checkbox" checked={included} onChange={e => (e.target.checked ? restore(s.id) : hide(s.id))} />
                    <a href={shown ? `#report-${s.id}` : undefined} className="flex-1 truncate" onClick={e => { if (!shown) e.preventDefault(); }}>{layout.titles[s.id] || s.title}</a>
                    <span className="text-xs tabular-nums text-label-3">{shown ? counts.get(s.id) : included ? 'empty' : 'off'}</span>
                  </label>
                </li>
              );
            })}
          </ul>
          <label className="flex items-center gap-2 text-sm text-label px-2"><input type="checkbox" checked={layout.showContents} onChange={e => update({ showContents: e.target.checked })} /> Table of contents</label>
          {removed.length > 0 && (
            <div className="pt-3 border-t border-separator space-y-1.5">
              <p className="text-xs font-medium text-label-2">Removed ({removed.length})</p>
              <ul className="space-y-1 max-h-56 overflow-y-auto">
                {removed.map(r => (
                  <li key={r.id} className="flex items-center gap-2 text-xs text-label-2">
                    <span className="flex-1 truncate" title={r.label}>{r.label}</span>
                    <button type="button" className="btn btn-sm btn-plain !text-xs !px-1.5" onClick={() => restore(r.id)}><Undo2 className="w-3 h-3" /> Restore</button>
                  </li>
                ))}
              </ul>
            </div>
          )}
          <button type="button" className="btn btn-sm btn-plain -ml-2 text-label-2" onClick={() => { reset(); notify('The report is back to its original layout.'); }}><RotateCcw className="w-3.5 h-3.5" /> Reset layout</button>
        </aside>

        {/* The document */}
        <div className="min-w-0">
          {editing && <p className="mb-3 text-xs text-label-2 flex items-center gap-1.5 print:hidden"><Eye className="w-3.5 h-3.5" /> Editing: the × on each part removes it; section controls rename, move or remove. Exports never include these controls.</p>}
          <ReportDocument
            sections={sections}
            layout={layout}
            editing={editing}
            onHide={hide}
            onMove={move}
            onRename={(id, title) => update(l => ({ titles: { ...l.titles, [id]: title } }))}
            onNote={(id, text) => update(l => ({ notes: { ...l.notes, [id]: text } }))}
            onSummary={text => update({ summary: text })}
            generatedAt={doc.generatedAt}
            datasetName={dataset.filename}
          />
        </div>
      </div>

      {expertMode && (
        <details className="card p-4 sm:p-5 print:hidden">
          <summary className="card-title cursor-pointer flex items-center gap-2"><Code2 className="w-4 h-4" /> More exports (AI-written)</summary>
          <div className="mt-4 space-y-6">
            <ExecutivePDFReport dataset={dataset} aiAnalysis={aiAnalysis} mlResult={mlResult} />
            <ETLPipelineExport />
          </div>
        </details>
      )}

      <div className="mt-10 print:hidden"><EngineWorkbench dataset={dataset} /></div>
    </div>
  );
}
