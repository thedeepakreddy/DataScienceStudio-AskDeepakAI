/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Dataset, MLResult } from '../types';
import type { DatasetVersion, PinRecord, PinView, RunRecord, SavedDashboard } from '../utils/workspaceStore';
import type { RegisteredModel } from '../utils/modelRegistry';
import type { ReportFindings } from '../utils/reportFindings';
import { describeRun } from '../utils/provenance';
import { checkFormula, evaluateFormula, formatKpi } from '../utils/kpiFormula';
import { pandasScript } from './pandasCode';

// The report as data: sections of blocks, assembled from everything done in the
// studio for this dataset. The page renders it; Markdown and HTML exports read
// the same structure. Every number comes from the data, the engine or a saved
// run; AI-written text is labelled as such.

export type Block =
  | { id: string; kind: 'paragraph'; text: string }
  | { id: string; kind: 'bullets'; title?: string; items: string[] }
  | { id: string; kind: 'stats'; items: [string, string][] }
  | { id: string; kind: 'table'; caption?: string; columns: { key: string; label: string; align?: 'right' }[]; rows: Record<string, string | number | null>[] }
  | { id: string; kind: 'bars'; caption: string; data: { label: string; value: number }[]; format?: 'pct' | 'num' }
  | { id: string; kind: 'histogram'; caption: string; data: { label: string; value: number }[] }
  | { id: string; kind: 'heatmap'; caption: string; columns: string[]; matrix: (number | null)[][] }
  | { id: string; kind: 'code'; caption: string; language: 'python' | 'sql'; code: string }
  | { id: string; kind: 'callout'; tone: 'info' | 'warn' | 'ai'; title?: string; text: string }
  | { id: string; kind: 'analysis'; title: string; headline: string; lines: string[]; when: number; view?: PinView; result?: unknown; capability?: string; runId?: string };

export interface Section { id: string; title: string; intro: string; blocks: Block[] }
export interface ReportDoc { sections: Section[]; generatedAt: number; dataset: string }

export interface ReportInputs {
  dataset: Dataset;
  findings: ReportFindings;
  mlResult: MLResult | null;
  aiAnalysis: any;
  chain: DatasetVersion[];
  runs: RunRecord[];
  activeModel: RegisteredModel | null;
  pins: PinRecord[];
  dashboards: SavedDashboard[];
  engineInfo?: { engineVersion: string; libraries: Record<string, string> } | null;
}

const f = (v: unknown, d = 3) => (typeof v === 'number' && Number.isFinite(v) ? Number(v.toPrecision(d)).toLocaleString(undefined, { maximumFractionDigits: 6 }) : v === null || v === undefined ? '—' : String(v));
const pct = (v: number, d = 1) => `${(v * 100).toFixed(d)}%`;
/** Midnight timestamps as plain dates; long text shortened. */
const shortValue = (v: unknown) => { const t = String(v).replace(/^(\d{4}-\d{2}-\d{2})T00:00:00(?:\.0+)?Z?$/, '$1'); return t.length > 40 ? `${t.slice(0, 40)}…` : t; };
const isNum = (v: unknown) => typeof v === 'number' && Number.isFinite(v);

// ------------------------------------------------------------------ data summaries computed here
function histogram(values: number[], bins = 12): { label: string; value: number }[] {
  if (!values.length) return [];
  let lo = Infinity, hi = -Infinity;
  for (const v of values) { if (v < lo) lo = v; if (v > hi) hi = v; }
  if (lo === hi) return [{ label: f(lo), value: values.length }];
  const w = (hi - lo) / bins;
  const counts = new Array(bins).fill(0);
  for (const v of values) counts[Math.min(bins - 1, Math.floor((v - lo) / w))]++;
  return counts.map((c, i) => ({ label: f(lo + i * w, 3), value: c }));
}

function pearson(a: number[], b: number[]): number | null {
  const n = a.length;
  if (n < 3) return null;
  let ma = 0, mb = 0;
  for (let i = 0; i < n; i++) { ma += a[i]; mb += b[i]; }
  ma /= n; mb /= n;
  let sab = 0, saa = 0, sbb = 0;
  for (let i = 0; i < n; i++) { const x = a[i] - ma, y = b[i] - mb; sab += x * y; saa += x * x; sbb += y * y; }
  return saa && sbb ? sab / Math.sqrt(saa * sbb) : null;
}

const numericCols = (ds: Dataset) => ds.columns.filter(c => c.type === 'numeric' && c.distinctCount > 2 && !/(^|_)(id|key|index)$/i.test(c.name));

// ------------------------------------------------------------------ where each engine analysis belongs
type Home = 'quality' | 'preparation' | 'exploration' | 'statistics' | 'models' | 'forecasts' | 'data';
export function homeOf(capability: string): Home {
  if (capability.startsWith('connect.')) return 'data';
  if (capability === 'data.recipe' || capability === 'data.pii_mask') return 'preparation';
  if (capability.startsWith('data.')) return 'quality';
  if (/^(unsup\.|text\.|ts\.(decompose|anomalies|changepoints)|stats\.(correlation_matrix|normality))/.test(capability)) return 'exploration';
  if (/^(ts\.(forecast|hierarchical)|opt\.)/.test(capability)) return 'forecasts';
  if (/^(ml\.|mlops\.)/.test(capability)) return 'models';
  return 'statistics';
}

/** The newest run of each distinct analysis (same capability and settings). */
function latestDistinct(runs: RunRecord[]): RunRecord[] {
  const seen = new Set<string>();
  return [...runs].sort((a, b) => b.createdAt - a.createdAt).filter(r => {
    const p = r.params as any;
    const k = `${r.kind}|${p?.capability ?? r.title}|${JSON.stringify(p?.params ?? p ?? {})}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

const analysisBlock = (r: RunRecord): Block => {
  const p = (r.params ?? {}) as any;
  const d = describeRun(r);
  // Engine analyses show their run details and full result below; the generic provenance line would repeat them.
  const lines = r.kind === 'engine' ? [] : d.lines.filter(l => l && l !== r.summary);
  return { id: `run-${r.id}`, kind: 'analysis', title: r.title, headline: r.summary, lines, when: r.createdAt, view: p.view, result: r.result, capability: p.capability, runId: p.runId };
};

// ------------------------------------------------------------------ the report
export function buildReport(x: ReportInputs): ReportDoc {
  const { dataset: ds, findings, mlResult: m, chain, aiAnalysis } = x;
  const runs = latestDistinct(x.runs);
  const engineRuns = runs.filter(r => r.kind === 'engine' && (r.params as any)?.capability);
  const at = (home: Home) => engineRuns.filter(r => homeOf((r.params as any).capability) === home).map(analysisBlock);
  const sections: Section[] = [];
  const missingCells = ds.columns.reduce((a, c) => a + (c.missingCount || 0), 0);
  const cells = Math.max(1, ds.rows.length * ds.columns.length);

  // 1. Executive summary
  const headlines: string[] = [];
  if (m) {
    const s = m.modelType === 'classification' ? `accuracy ${pct(m.metrics.accuracy ?? 0)}` : `R² ${f(m.metrics.r2Score)}`;
    headlines.push(`${m.modelAlgorithm} predicts ${m.target ?? 'the target'} with ${s} on held-out rows.`);
  }
  for (const r of engineRuns.slice(0, 6)) headlines.push(r.summary);
  for (const r of runs.filter(r => r.kind === 'hypothesis-test' && (r.result as any)?.significant).slice(0, 3)) headlines.push(`${r.title}: ${r.summary}.`);
  sections.push({
    id: 'summary', title: 'Executive summary', intro: 'What the analysis found, in brief.',
    blocks: [
      { id: 'summary-text', kind: 'paragraph', text: findings.summary },
      ...(headlines.length ? [{ id: 'summary-results', kind: 'bullets' as const, title: 'Key results', items: headlines }] : []),
      ...(findings.recommendations.length ? [{ id: 'summary-recs', kind: 'bullets' as const, title: 'Recommendations', items: findings.recommendations.map(r => `${r.title} — ${r.detail}`) }] : []),
      ...(aiAnalysis?.overviewSummary ? [{ id: 'summary-ai', kind: 'callout' as const, tone: 'ai' as const, title: 'AI commentary (written by Gemini from the column summary; not computed)', text: String(aiAnalysis.overviewSummary) }] : []),
    ],
  });

  // 2. The data
  const original = chain[0];
  sections.push({
    id: 'data', title: 'The data', intro: 'Where the data came from, its size and every column.',
    blocks: [
      { id: 'data-stats', kind: 'stats', items: [
        ['Rows', ds.rows.length.toLocaleString()], ['Columns', String(ds.columns.length)],
        ['Numeric columns', String(ds.columns.filter(c => c.type === 'numeric').length)], ['Missing cells', `${missingCells.toLocaleString()} (${pct(missingCells / cells)})`],
        ['Source file', ds.filename], ['Original size', original ? `${original.rowCount.toLocaleString()} × ${original.columnCount}` : `${ds.originalRowCount.toLocaleString()} rows`],
        ['Data versions', String(Math.max(1, chain.length))], ['Report date', new Date().toLocaleDateString(undefined, { dateStyle: 'long' })],
      ] },
      { id: 'data-dictionary', kind: 'table', caption: 'Data dictionary', columns: [{ key: 'name', label: 'Column' }, { key: 'type', label: 'Type' }, { key: 'missing', label: 'Missing', align: 'right' }, { key: 'distinct', label: 'Distinct', align: 'right' }, { key: 'summary', label: 'Summary' }],
        rows: ds.columns.map(c => ({
          name: c.name, type: c.type, missing: c.missingCount ? `${c.missingCount.toLocaleString()} (${pct(c.missingCount / Math.max(1, ds.rows.length))})` : '—', distinct: c.distinctCount,
          summary: c.type === 'numeric' ? `mean ${f(c.statistics.mean)}, median ${f(c.statistics.median)}, range ${f(c.statistics.min)} – ${f(c.statistics.max)}`
            : (c.statistics as any).mostCommon?.[0] ? `most common “${shortValue((c.statistics as any).mostCommon[0].value)}” (${(c.statistics as any).mostCommon[0].count}×)` : '—',
        })) },
      ...at('data'),
    ],
  });

  // 3. Data quality
  sections.push({
    id: 'quality', title: 'Data quality', intro: 'Problems found in the data and how serious they are.',
    blocks: [
      ...(findings.risks.length ? [{ id: 'quality-risks', kind: 'table' as const, caption: 'Issues found', columns: [{ key: 'level', label: 'Severity' }, { key: 'title', label: 'Issue' }, { key: 'detail', label: 'Detail' }], rows: findings.risks.map(r => ({ level: r.level, title: r.title, detail: r.detail })) }] : [{ id: 'quality-clean', kind: 'callout' as const, tone: 'info' as const, text: 'No data-quality risks were found.' }]),
      ...runs.filter(r => r.kind === 'quality-audit').map(analysisBlock),
      ...at('quality'),
    ],
  });

  // 4. Preparation
  const steps = chain.slice(1);
  const ops = steps.filter(v => v.operation).map(v => ({ label: v.label, op: v.operation! }));
  const sqlRuns = runs.filter(r => r.kind === 'sql-query' && (r.params as any)?.sql);
  sections.push({
    id: 'preparation', title: 'Data preparation', intro: 'Every change made to the data, in order, and the code that repeats it.',
    blocks: [
      ...(steps.length ? [{ id: 'prep-lineage', kind: 'table' as const, caption: 'Data versions', columns: [{ key: 'v', label: 'Version' }, { key: 'change', label: 'Change' }, { key: 'size', label: 'Rows × columns', align: 'right' as const }, { key: 'when', label: 'When' }],
        rows: chain.map((v, i) => ({ v: `v${i + 1}`, change: v.label, size: `${v.rowCount.toLocaleString()} × ${v.columnCount}`, when: new Date(v.createdAt).toLocaleString() })) }]
        : [{ id: 'prep-none', kind: 'callout' as const, tone: 'info' as const, text: 'The data was analysed as imported; no cleaning steps were applied.' }]),
      ...(ops.length ? [{ id: 'prep-pandas', kind: 'code' as const, caption: 'Python (pandas): the preparation steps', language: 'python' as const, code: pandasScript({ sourceFile: original?.filename ?? ds.filename, steps: ops, skipped: steps.filter(v => !v.operation).map(v => v.label) }) }] : []),
      ...sqlRuns.slice(0, 10).map(r => ({ id: `sql-${r.id}`, kind: 'code' as const, caption: `SQL query — ${r.summary}`, language: 'sql' as const, code: String((r.params as any).sql) })),
      ...at('preparation'),
    ],
  });

  // 5. Exploration
  const nums = numericCols(ds).slice(0, 6);
  const sample = ds.rows.length > 20000 ? ds.rows.filter((_, i) => i % Math.ceil(ds.rows.length / 20000) === 0) : ds.rows;
  const cats = ds.columns.filter(c => (c.type === 'categorical' || c.type === 'boolean') && c.distinctCount >= 2 && c.distinctCount <= 30).slice(0, 3);
  const corrCols = nums.slice(0, 8).map(c => c.name);
  const matrix = corrCols.map(a => corrCols.map(b => {
    if (a === b) return 1;
    const pairs = sample.map(row => [Number(row[a]), Number(row[b])]).filter(([u, v]) => isNum(u) && isNum(v));
    return pearson(pairs.map(p => p[0]), pairs.map(p => p[1]));
  }));
  sections.push({
    id: 'exploration', title: 'Exploratory analysis', intro: 'How the values are distributed and how the columns relate.',
    blocks: [
      ...findings.observations.length ? [{ id: 'eda-observations', kind: 'bullets' as const, title: 'Observations', items: findings.observations }] : [],
      ...nums.slice(0, 4).map(c => ({ id: `hist-${c.name}`, kind: 'histogram' as const, caption: `Distribution of ${c.name}`, data: histogram(sample.map(r => Number(r[c.name])).filter(isNum)) })),
      ...cats.map(c => {
        const counts = new Map<string, number>();
        for (const r of ds.rows) { const v = r[c.name]; if (v !== null && v !== undefined && v !== '') counts.set(String(v), (counts.get(String(v)) ?? 0) + 1); }
        return { id: `cat-${c.name}`, kind: 'bars' as const, caption: `Most common values of ${c.name}`, format: 'num' as const, data: [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10).map(([label, value]) => ({ label, value })) };
      }),
      ...(corrCols.length >= 2 ? [{ id: 'eda-corr', kind: 'heatmap' as const, caption: 'Correlation between numeric columns (Pearson r)', columns: corrCols, matrix }] : []),
      ...runs.filter(r => r.kind === 'deep-eda').slice(0, 1).map(r => {
        const e = r.result as any;
        return { id: `deep-${r.id}`, kind: 'table' as const, caption: `Deep analysis (pandas, ${Number(e?.rowCount ?? 0).toLocaleString()} rows): unusual values`, columns: [{ key: 'column', label: 'Column' }, { key: 'n', label: 'Unusual', align: 'right' as const }, { key: 'share', label: 'Share', align: 'right' as const }, { key: 'range', label: 'Usual range' }],
          rows: (e?.outliers ?? []).slice(0, 12).map((o: any) => ({ column: o.column, n: o.outlierCount, share: `${f(o.outlierPercent)}%`, range: `${f(o.lowerBound)} – ${f(o.upperBound)}` })) };
      }),
      ...at('exploration'),
    ],
  });

  // 6. Statistics
  sections.push({
    id: 'statistics', title: 'Statistical analysis', intro: 'Which differences, relationships and effects are real rather than chance.',
    blocks: [
      ...runs.filter(r => ['hypothesis-test', 'regression', 'power', 'ab-test'].includes(r.kind)).map(analysisBlock),
      ...at('statistics'),
    ],
  });

  // 7. Models
  const modelBlocks: Block[] = [];
  if (m) {
    const mm = m.metrics;
    modelBlocks.push({ id: 'model-metrics', kind: 'stats', items: [
      ['Algorithm', m.modelAlgorithm], ['Predicts', m.target ?? '—'], ['Task', m.modelType],
      ...(m.modelType === 'classification'
        ? [['Accuracy', pct(mm.accuracy ?? 0)], ['Precision', f(mm.precision)], ['Recall', f(mm.recall)], ['F1', f(mm.f1Score)], ...(mm.rocAuc != null ? [['ROC AUC', f(mm.rocAuc)]] : [])] as [string, string][]
        : [['R²', f(mm.r2Score)], ['RMSE', f(mm.rmse)], ['MAE', f(mm.mae)]] as [string, string][]),
      ...(m.cv ? [[`Cross-validated ${m.cv.metric}`, `${f(m.cv.mean)} ± ${f(m.cv.std)} (${m.cv.folds} folds)`]] as [string, string][] : []),
      ...(m.split ? [['Split', `${m.split.strategy}, ${m.split.trainRows?.toLocaleString()} train / ${m.split.testRows?.toLocaleString()} test, seed ${m.split.seed}`]] as [string, string][] : []),
    ] });
    if (m.featureImportance?.length) modelBlocks.push({ id: 'model-importance', kind: 'bars', caption: `What the model relies on (${m.modelAlgorithm})`, format: 'num', data: m.featureImportance.slice(0, 12).map(x => ({ label: x.feature, value: x.score })) });
    const cm = m.confusionMatrix as any;
    if (cm?.matrix) modelBlocks.push({ id: 'model-cm', kind: 'table', caption: 'Confusion matrix (rows: actual, columns: predicted)', columns: [{ key: 'a', label: 'Actual' }, ...cm.labels.map((l: string, i: number) => ({ key: `c${i}`, label: String(l), align: 'right' as const }))], rows: cm.matrix.map((row: number[], i: number) => ({ a: String(cm.labels[i]), ...Object.fromEntries(row.map((v, j) => [`c${j}`, v])) })) });
    else if (cm && 'tp' in cm) modelBlocks.push({ id: 'model-cm', kind: 'table', caption: `Confusion matrix (positive: ${cm.positiveLabel ?? 'positive'})`, columns: [{ key: 'a', label: 'Actual' }, { key: 'p', label: 'Predicted positive', align: 'right' }, { key: 'n', label: 'Predicted negative', align: 'right' }], rows: [{ a: 'Positive', p: cm.tp, n: cm.fn }, { a: 'Negative', p: cm.fp, n: cm.tn }] });
    if (m.comparison?.length) modelBlocks.push({ id: 'model-compare', kind: 'table', caption: 'Models compared', columns: [{ key: 'name', label: 'Model' }, { key: 'metric', label: 'Score', align: 'right' }, { key: 'cv', label: 'Cross-validated', align: 'right' }, { key: 'ms', label: 'Time', align: 'right' }],
      rows: m.comparison.map((c: any) => ({ name: c.modelName, metric: `${c.primaryMetric} ${f(c.metricValue)}`, cv: c.cv ? `${f(c.cv.mean)} ± ${f(c.cv.std)}` : '—', ms: `${Math.round(c.executionTimeMs)} ms` })) });
    if (m.leakageWarnings?.length) modelBlocks.push({ id: 'model-leakage', kind: 'callout', tone: 'warn', title: 'Possible leakage', text: m.leakageWarnings.map(w => `${w.column}: ${w.reason}`).join(' ') });
  }
  if (x.activeModel) {
    const am = x.activeModel;
    modelBlocks.push({ id: 'model-registered', kind: 'stats', items: [['Registered model', `${am.name} v${am.version}`], ['Algorithm', am.algorithm], ['Intended use', am.intendedUse || '—'], ['Registered', new Date(am.createdAt).toLocaleDateString()]] });
  }
  modelBlocks.push(...at('models'));
  if (!modelBlocks.length) modelBlocks.push({ id: 'model-none', kind: 'callout', tone: 'info', text: 'No model was trained in this analysis.' });
  sections.push({ id: 'models', title: 'Predictive models', intro: 'Models trained, how well they predict on rows they never saw, what drives them, and their checks.', blocks: modelBlocks });

  // 8. Forecasts and decisions
  sections.push({
    id: 'forecasts', title: 'Forecasts and decisions', intro: 'Where the numbers are heading, and the best decisions under uncertainty and limits.',
    blocks: [...runs.filter(r => r.kind === 'forecast').map(analysisBlock), ...at('forecasts')],
  });

  // 9. Dashboard
  const dash = x.dashboards[0];
  const kpiRows = (dash?.kpis ?? []).map(k => {
    let value = '—';
    try { value = formatKpi(evaluateFormula(checkFormula(k.formula, ds.columns.map(c => c.name)), ds.rows), k.format); } catch { value = '—'; }
    return { name: k.name, formula: k.formula, value };
  });
  sections.push({
    id: 'dashboard', title: 'Dashboard and KPIs', intro: 'The indicators being tracked and the analyses pinned to the dashboard.',
    blocks: [
      ...(kpiRows.length ? [{ id: 'dash-kpis', kind: 'table' as const, caption: `KPIs (dashboard “${dash!.name}”, on the current data)`, columns: [{ key: 'name', label: 'KPI' }, { key: 'value', label: 'Value', align: 'right' as const }, { key: 'formula', label: 'Formula' }], rows: kpiRows }] : []),
      ...(dash?.activeComponents?.length ? [{ id: 'dash-components', kind: 'bullets' as const, title: `Dashboard “${dash.name}” shows`, items: dash.activeComponents.map(c => c.replace('#', ' #')) }] : []),
      ...x.pins.map(p => ({ id: `pin-${p.id}`, kind: 'analysis' as const, title: p.title, headline: p.headline, lines: [], when: p.computedAt, view: p.view, result: p.result, capability: p.capability, runId: (p.result as any)?.runId })),
      ...(!kpiRows.length && !x.pins.length ? [{ id: 'dash-none', kind: 'callout' as const, tone: 'info' as const, text: 'No KPIs or pinned analyses yet. Save a dashboard with KPIs, or pin results, and they appear here.' }] : []),
    ],
  });

  // 10. Reproducibility
  const engineList = engineRuns.filter(r => (r.params as any)?.runId);
  sections.push({
    id: 'reproducibility', title: 'Reproducibility', intro: 'Everything needed to repeat the analysis and get the same numbers.',
    blocks: [
      { id: 'repro-env', kind: 'stats', items: [
        ['Data version', `v${Math.max(1, chain.length)} of ${Math.max(1, chain.length)}`], ['Rows analysed', ds.rows.length.toLocaleString()],
        ['Model seed', String(m?.split?.seed ?? m?.seed ?? '—')], ['Engine', x.engineInfo ? `AskDeepakAI engine ${x.engineInfo.engineVersion}` : 'AskDeepakAI engine'],
      ] },
      ...(x.engineInfo ? [{ id: 'repro-libs', kind: 'table' as const, caption: 'Engine libraries', columns: [{ key: 'lib', label: 'Library' }, { key: 'v', label: 'Version' }], rows: Object.entries(x.engineInfo.libraries).map(([lib, v]) => ({ lib, v })) }] : []),
      ...(engineList.length ? [{ id: 'repro-runs', kind: 'table' as const, caption: 'Engine runs (each has a methods section and a notebook that reproduces it: Report → The engine)', columns: [{ key: 'what', label: 'Analysis' }, { key: 'cap', label: 'Capability' }, { key: 'id', label: 'Run id' }, { key: 'when', label: 'When' }],
        rows: engineList.slice(0, 40).map(r => ({ what: r.title, cap: (r.params as any).capability, id: (r.params as any).runId, when: new Date(r.createdAt).toLocaleString() })) }] : []),
    ],
  });

  // 11. Appendix
  sections.push({
    id: 'appendix', title: 'Appendix: methods and limitations', intro: 'How to read the numbers, and what they do not show.',
    blocks: [
      { id: 'appx-methods', kind: 'bullets', title: 'Methods', items: [
        'Statistics, models and data checks were computed by the studio and the AskDeepakAI engine (pandas, SciPy, statsmodels, scikit-learn and others) on the data described above.',
        'Model scores are measured on rows held out from training; cross-validated scores show how much they vary.',
        'p-values below 0.05 are called significant; where many tests were run, corrected p-values are reported.',
        'Charts in this report are computed from the data itself; AI-written commentary is labelled and contains no numbers of its own.',
      ] },
      { id: 'appx-limits', kind: 'bullets', title: 'Limitations', items: [
        'Associations are not causes unless a causal method was used and its assumptions hold.',
        'Results describe this data; check models for drift before relying on them after the data changes.',
        ds.rows.length < 200 ? `With ${ds.rows.length} rows, estimates are imprecise.` : 'Small groups within the data have wider uncertainty than the totals.',
      ] },
    ],
  });

  return { sections, generatedAt: Date.now(), dataset: ds.filename };
}
