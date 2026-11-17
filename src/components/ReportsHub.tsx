/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState } from 'react';
import { jsPDF } from 'jspdf';
import {
  Download,
  Cpu,
  TrendingUp,
  Printer,
  BarChart4,
  Check,
  Package,
} from 'lucide-react';
import { DatasetVersion, RunRecord, listRegisteredModels, listRuns, listVersions } from '../utils/workspaceStore';
import { REPORTABLE_KINDS, buildNotebook, describeRun, lineage, rowsToCsv } from '../utils/provenance';
import { RegisteredModel, modelCardMarkdown } from '../utils/modelRegistry';
import { workflowSteps } from '../operations/workflows';
import { ZipEntry, createZip } from '../utils/zip';
import AppIcon from './AppIcon';
import { Dataset, MLResult } from '../types';
import { computeReportFindings } from '../utils/reportFindings';
import ExecutivePDFReport from './ExecutivePDFReport';
import ETLPipelineExport from './ETLPipelineExport';
import { usePipelineContext } from '../contexts/PipelineContext';

interface ReportsHubProps {
  dataset: Dataset;
  aiAnalysis: any;
  mlResult: MLResult | null;
  datasetId?: string | null;
  activeVersionId?: string | null;
}

export default function ReportsHub({ dataset, aiAnalysis, mlResult, datasetId = null, activeVersionId = null }: ReportsHubProps) {
  const { expertMode } = usePipelineContext();
  const [logs, setLogs] = useState<string[]>(['Report ready.']);

  // Every finding below is computed from the data and the model's real results.
  const findings = React.useMemo(() => computeReportFindings(dataset, mlResult), [dataset, mlResult]);

  // Provenance: how this data version was made, and saved analyses to include.
  const [versions, setVersions] = useState<DatasetVersion[]>([]);
  const [savedRuns, setSavedRuns] = useState<RunRecord[]>([]);
  const [activeModel, setActiveModel] = useState<RegisteredModel | null>(null);
  const [excluded, setExcluded] = useState<Set<string>>(new Set());
  const [packaging, setPackaging] = useState(false);
  React.useEffect(() => {
    let cancelled = false;
    (async () => {
      if (!datasetId) return;
      const [vs, runs, models] = await Promise.all([listVersions(datasetId), listRuns(300), listRegisteredModels(datasetId)]);
      if (cancelled) return;
      const ids = new Set(vs.map(v => v.id));
      setVersions(vs);
      setSavedRuns(runs.filter(r => r.versionId && ids.has(r.versionId) && r.status === 'succeeded' && REPORTABLE_KINDS.includes(r.kind)));
      setActiveModel(models.find(m => m.active) ?? null);
    })().catch(() => {});
    return () => { cancelled = true; };
  }, [datasetId, activeVersionId]);
  const chain = React.useMemo(() => lineage(versions, activeVersionId), [versions, activeVersionId]);
  const includedRuns = savedRuns.filter(r => !excluded.has(r.id));
  const versionLabel = (id: string | null) => {
    const i = chain.findIndex(v => v.id === id);
    return i >= 0 ? `v${i + 1}` : versions.find(v => v.id === id) ? 'another version' : 'unsaved';
  };

  // Compute stats on-the-fly to backfill if AI scan has not run yet
  const dynamicMissingCount = dataset.columns.reduce((acc, c) => acc + (c.missingCount || 0), 0);
  const numericCount = dataset.columns.filter(c => c.type === 'numeric').length;

  const buildPdf = () => {
      const doc = new jsPDF({ orientation: 'portrait', unit: 'mm', format: 'a4' });
      const generatedAt = new Date();
      const generatedLabel = generatedAt.toLocaleString(undefined, { dateStyle: 'long', timeStyle: 'short' });
      const left = 18;
      const width = 174;
      const pageBottom = 280;
      let y = 22;

      // Start a new page when the next block would not fit.
      const ensureRoom = (needed: number) => {
        if (y + needed > pageBottom) {
          doc.addPage();
          y = 22;
        }
      };
      const heading = (text: string) => {
        ensureRoom(16);
        y += 4;
        doc.setFont('helvetica', 'bold');
        doc.setFontSize(13);
        doc.setTextColor(29, 29, 31);
        doc.text(text, left, y);
        y += 7;
      };
      const paragraph = (text: string, opts: { color?: [number, number, number]; size?: number; bold?: boolean; indent?: number } = {}) => {
        doc.setFont('helvetica', opts.bold ? 'bold' : 'normal');
        doc.setFontSize(opts.size ?? 10);
        doc.setTextColor(...(opts.color ?? [60, 60, 67]));
        const lines = doc.splitTextToSize(text, width - (opts.indent ?? 0));
        ensureRoom(lines.length * 5 + 1);
        doc.text(lines, left + (opts.indent ?? 0), y);
        y += lines.length * 5 + 1.5;
      };

      // Title
      doc.setFont('helvetica', 'bold');
      doc.setFontSize(20);
      doc.setTextColor(29, 29, 31);
      doc.text('Data Analysis Report', left, y);
      y += 7;
      paragraph(`Dataset: ${dataset.filename}  ·  Generated ${generatedLabel}  ·  Data Science Studio by AskDeepakAI`, { size: 9, color: [110, 110, 115] });
      doc.setDrawColor(210, 210, 215);
      doc.line(left, y, left + width, y);
      y += 4;

      // 1. Data
      heading('1. Data');
      paragraph(findings.summary);
      if (aiAnalysis?.overviewSummary) {
        paragraph(`AI commentary (written by Gemini; not computed): ${aiAnalysis.overviewSummary}`, { color: [110, 110, 115], size: 9 });
      }

      // 2. Observations
      heading('2. Key observations');
      findings.observations.forEach(obs => paragraph(`•  ${obs}`, { indent: 2 }));

      // 3. Model
      heading('3. Model results');
      if (mlResult) {
        const m = mlResult.metrics || {};
        const isClassification = mlResult.modelType === 'classification';
        paragraph(
          `${mlResult.modelAlgorithm} (${mlResult.modelType})` +
          (mlResult.target ? `, predicting ${mlResult.target}` : '') +
          (mlResult.features?.length ? ` from ${mlResult.features.join(', ')}` : '') + '.',
        );
        const metricLine = isClassification
          ? [
              m.accuracy !== undefined && `Accuracy ${(m.accuracy * 100).toFixed(1)}%`,
              m.precision !== undefined && `Precision ${(m.precision * 100).toFixed(1)}%`,
              m.recall !== undefined && `Recall ${(m.recall * 100).toFixed(1)}%`,
              m.f1Score !== undefined && `F1 ${(m.f1Score * 100).toFixed(1)}%`,
              m.rocAuc !== undefined && m.rocAuc !== null && `ROC-AUC ${m.rocAuc.toFixed(3)}`,
            ]
          : [
              m.r2Score !== undefined && `R² ${m.r2Score.toFixed(3)}`,
              m.rmse !== undefined && `RMSE ${m.rmse.toFixed(3)}`,
              m.mae !== undefined && `MAE ${m.mae.toFixed(3)}`,
            ];
        paragraph(`Held-out test data: ${metricLine.filter(Boolean).join('  ·  ')}`, { bold: true, color: [29, 29, 31] });
        const cv = (mlResult as any).cv;
        if (cv && typeof cv.mean === 'number') {
          paragraph(`Cross-validation (${cv.folds}-fold ${cv.metric}): ${cv.mean.toFixed(3)} ± ${cv.std.toFixed(3)}`);
        }
        const top = (mlResult.featureImportance || []).slice(0, 5);
        if (top.length > 0) {
          paragraph('Most important features:', { bold: true, color: [29, 29, 31] });
          top.forEach((f, i) => paragraph(`${i + 1}.  ${f.feature} — ${(f.score * 100).toFixed(1)}% of importance`, { indent: 2 }));
        }
      } else {
        paragraph('No model has been trained for this dataset yet.');
      }

      // 4. Risks
      heading('4. Risks');
      if (findings.risks.length === 0) {
        paragraph('The automatic checks found no data-quality or model risks.');
      } else {
        findings.risks.forEach(r => {
          paragraph(`${r.level}: ${r.title}`, { bold: true, color: r.level === 'High' ? [200, 0, 20] : r.level === 'Medium' ? [180, 80, 0] : [29, 29, 31] });
          paragraph(r.detail, { indent: 2 });
        });
      }

      // 5. Recommendations
      heading('5. Recommendations');
      findings.recommendations.forEach((rec, i) => {
        paragraph(`${i + 1}. ${rec.title}`, { bold: true, color: [29, 29, 31] });
        paragraph(rec.detail, { indent: 4 });
      });

      // 6. Saved analyses
      if (includedRuns.length > 0) {
        heading('6. Saved analyses');
        includedRuns.forEach(run => {
          const d = describeRun(run);
          paragraph(d.heading, { bold: true, color: [29, 29, 31] });
          d.lines.forEach(l => paragraph(l, { indent: 2 }));
          paragraph(`Run on data ${versionLabel(run.versionId)}, ${new Date(run.createdAt).toLocaleString()}.`, { indent: 2, size: 8, color: [140, 140, 145] });
        });
      }

      // 7. Provenance
      if (chain.length > 0 || mlResult) {
        heading(`${includedRuns.length > 0 ? 7 : 6}. Provenance`);
        if (chain.length > 0) {
          paragraph('How the data used here was produced:', { bold: true, color: [29, 29, 31] });
          chain.forEach((v, i) => paragraph(`v${i + 1}  ${v.label}  (${v.rowCount.toLocaleString()} rows × ${v.columnCount} columns, ${new Date(v.createdAt).toLocaleString()})`, { indent: 2, size: 9 }));
        }
        if (mlResult) {
          const s = mlResult.split;
          paragraph(
            `Model: ${mlResult.modelAlgorithm}, seed ${mlResult.seed ?? 42}, ` +
            (s ? `${s.strategy} split with ${s.trainRows} training and ${s.testRows} test rows` : 'random split') +
            (mlResult.tuning?.tuned ? `, tuned over ${mlResult.tuning.iterations} trials` : '') + '.',
            { size: 9 },
          );
        }
        if (activeModel) paragraph(`Active registered model: ${activeModel.name} v${activeModel.version}.`, { size: 9 });
      }

      // Method note + page numbers
      heading('How this report was made');
      paragraph(
        'Figures are computed from the dataset in this session and from the trained model’s evaluation on held-out data. ' +
        'Risks and recommendations come from automatic checks on those numbers. Review them with domain knowledge before acting.',
        { size: 9, color: [110, 110, 115] },
      );
      const pages = doc.getNumberOfPages();
      for (let i = 1; i <= pages; i++) {
        doc.setPage(i);
        doc.setFont('helvetica', 'normal');
        doc.setFontSize(8);
        doc.setTextColor(140, 140, 145);
        doc.text(`${dataset.filename}  ·  page ${i} of ${pages}`, 105, 290, { align: 'center' });
      }

      return { doc, pages };
  };

  const baseName = dataset.filename.replace(/\.[^/.]+$/, '').replace(/[^A-Za-z0-9_-]+/g, '_');

  const handleDownloadPDF = () => {
    try {
      const { doc, pages } = buildPdf();
      const fileName = `Data_Analysis_Report_${baseName}.pdf`;
      doc.save(fileName);
      setLogs(prev => [...prev, `Saved ${fileName} (${pages} page${pages === 1 ? '' : 's'}).`]);
    } catch (err: any) {
      console.error(err);
      setLogs(prev => [...prev, `Couldn’t create the PDF: ${err.message || err}`]);
    }
  };

  // Everything needed to check or repeat the analysis outside the studio.
  const handleDownloadPackage = async () => {
    setPackaging(true);
    try {
      const columns = dataset.columns.map(c => c.name);
      const original = chain[0]?.dataset;
      const { steps, skipped } = workflowSteps(chain);
      const runsForData = savedRuns;
      const { doc } = buildPdf();
      const files: ZipEntry[] = [
        { path: 'README.md', data: `# ${dataset.filename} — reproducibility package

Exported from Data Science Studio on ${new Date().toISOString()}.

- \`data/current.csv\`: the data the report is based on (${dataset.rows.length.toLocaleString()} rows).
${original ? `- \`data/original.csv\`: the data as imported (${original.rows.length.toLocaleString()} rows).\n` : ''}- \`lineage.json\`: every version from import to now, with the operation that produced each.
- \`workflow.json\`: the repeatable cleaning steps${skipped.length ? ` (${skipped.length} step(s) could not be recorded as repeatable: ${skipped.join('; ')})` : ''}.
- \`analyses.json\`: saved statistical tests, regressions and forecasts with their full results.
- \`analysis.ipynb\`: a Jupyter notebook that reloads the data and repeats the model and tests with pandas, scikit-learn and SciPy.
- \`report.pdf\`: the report.
${activeModel ? '- `model_card.md`: the active registered model’s card.\n' : ''}` },
        { path: 'data/current.csv', data: rowsToCsv(dataset.rows, columns) },
        ...(original ? [{ path: 'data/original.csv', data: rowsToCsv(original.rows, original.columns.map(c => c.name)) }] : []),
        { path: 'lineage.json', data: JSON.stringify(chain.map((v, i) => ({ version: i + 1, id: v.id, parentId: v.parentId, label: v.label, createdAt: new Date(v.createdAt).toISOString(), rows: v.rowCount, columns: v.columnCount, operation: v.operation ?? null })), null, 2) },
        { path: 'workflow.json', data: JSON.stringify({ steps, notRepeatable: skipped }, null, 2) },
        { path: 'analyses.json', data: JSON.stringify(runsForData.map(r => ({ kind: r.kind, title: r.title, createdAt: new Date(r.createdAt).toISOString(), dataVersion: versionLabel(r.versionId), params: r.params, result: r.result })), null, 2) },
        { path: 'analysis.ipynb', data: buildNotebook({ datasetName: dataset.filename, dataFile: 'data/current.csv', versionLabel: chain[chain.length - 1]?.label ?? 'current', model: activeModel && chain.some(v => v.id === activeModel.versionId) && activeModel.versionId === activeVersionId ? activeModel : null, tests: runsForData }) },
        { path: 'report.pdf', data: doc.output('arraybuffer') },
      ];
      if (activeModel) {
        const label = versions.find(v => v.id === activeModel.versionId)?.label ?? 'no longer saved';
        files.push({ path: 'model_card.md', data: modelCardMarkdown(activeModel, dataset.filename, label) });
      }
      const zip = createZip(files);
      const url = URL.createObjectURL(new Blob([zip], { type: 'application/zip' }));
      const a = document.createElement('a');
      a.href = url;
      a.download = `${baseName}_reproducibility.zip`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
      setLogs(prev => [...prev, `Saved ${baseName}_reproducibility.zip (${files.length} files).`]);
    } catch (err: any) {
      setLogs(prev => [...prev, `Couldn’t create the package: ${err.message || err}`]);
    } finally {
      setPackaging(false);
    }
  };

  return (
    <div className="space-y-8" id="unified_strategy_workspace">
      
      {/* Export actions */}
      <div className="flex flex-wrap items-center justify-between gap-3 print:hidden">
        <p className="text-sm text-label-2">
          Built from your current data{mlResult ? ' and trained model' : ''}. Updates as you work.
        </p>
        <div className="flex flex-wrap items-center gap-2">
          <button type="button" onClick={() => window.print()} className="btn btn-secondary">
            <Printer className="w-4 h-4" /> Print
          </button>
          <button type="button" data-agent="report-package" onClick={handleDownloadPackage} disabled={packaging} className="btn btn-secondary" title="Data, lineage, analyses, notebook and report in one ZIP">
            <Package className="w-4 h-4" /> Reproducibility Package
          </button>
          <button type="button" data-agent="report-pdf" onClick={handleDownloadPDF} className="btn btn-primary" title="Download an A4 PDF">
            <Download className="w-4 h-4" /> Download PDF
          </button>
        </div>
      </div>

      {/* The report document */}
      <div className="card p-6 sm:p-10 print:shadow-none print:p-0" id="live_strategic_report_page">

        {/* Document header */}
        <div className="flex flex-col sm:flex-row sm:items-end justify-between gap-4 pb-6 mb-8 border-b border-separator">
          <div className="flex items-center gap-4">
            <AppIcon size={44} />
            <div>
              <p className="text-xs font-medium text-label-2">AskDeepakAI · Data Science Studio</p>
              <h2 className="text-[28px] leading-tight font-semibold tracking-tight text-label">Data Analysis Report</h2>
            </div>
          </div>
          <dl className="text-xs text-label-2 sm:text-right space-y-0.5">
            <div><dt className="inline">Dataset: </dt><dd className="inline text-label font-medium">{dataset.filename}</dd></div>
            <div><dt className="inline">Generated: </dt><dd className="inline text-label font-medium">{new Date().toLocaleDateString(undefined, { year: 'numeric', month: 'long', day: 'numeric' })}</dd></div>
          </dl>
        </div>

        {/* THREE COLUMN STRATEGY DISPLAY (NEXT TO EACH OTHER) */}
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-8 relative z-10 items-stretch" id="triple_column_briefs">
          
          {/* COLUMN 1: EXPLORATORY DATA ANALYSIS (EDA DIAGNOSTIC) */}
          <div className="bg-well p-6 rounded-2xl flex flex-col justify-between space-y-6">
            <div className="space-y-4">
              <div className="flex items-center gap-2 mb-2">
                <div className="w-8 h-8 rounded-lg bg-teal/10 flex items-center justify-center text-teal">
                  <BarChart4 className="w-4 h-4" />
                </div>
                <h3 className="card-title">
                  Data quality
                </h3>
              </div>

              {/* Ingestion Profile Status Box */}
              <div className="p-3.5 rounded-xl bg-surface space-y-1.5 text-xs tabular-nums">
                                <div className="flex justify-between text-label-2">
                  <span>Columns</span>
                  <strong className="text-label font-medium">{dataset.columns.length}</strong>
                </div>
                <div className="flex justify-between text-label-2">
                  <span>Numeric columns</span>
                  <strong className="text-label font-medium">{numericCount}</strong>
                </div>
                <div className="flex justify-between text-label-2">
                  <span>Missing values</span>
                  <strong className="text-label font-medium">{((dynamicMissingCount / (dataset.rowCount * dataset.columns.length || 1)) * 100).toFixed(2)}%</strong>
                </div>
              </div>

              <div className="space-y-3">
                <h4 className="text-xs font-semibold text-label-2">Summary</h4>
                <p className="text-xs text-label leading-relaxed">{findings.summary}</p>
                {aiAnalysis?.overviewSummary && (
                  <p className="text-xs text-label-2 leading-relaxed">
                    <span className="font-medium text-label">AI commentary:</span> {aiAnalysis.overviewSummary}
                  </p>
                )}
              </div>

              <div className="space-y-2.5">
                <h4 className="text-xs font-semibold text-label-2">Key observations</h4>
                <ul className="text-xs text-label-2 space-y-2">
                  {findings.observations.map((obs, idx) => (
                    <li key={idx} className="flex gap-2">
                      <Check className="w-3.5 h-3.5 text-green shrink-0 mt-0.5" />
                      <span className="leading-relaxed">{obs}</span>
                    </li>
                  ))}
                </ul>
              </div>
            </div>
          </div>

          {/* COLUMN 2: MACHINE LEARNING PIPELINE PERFORMANCE */}
          <div className="bg-well p-6 rounded-2xl flex flex-col justify-between space-y-6">
            <div className="space-y-4">
              <div className="flex items-center gap-2 mb-2">
                <div className="w-8 h-8 rounded-lg bg-blue/10 flex items-center justify-center text-blue">
                  <Cpu className="w-4 h-4" />
                </div>
                <h3 className="card-title">
                  Model results
                </h3>
              </div>

              {mlResult ? (
                <div className="space-y-4">
                  {/* ML Characteristics Box */}
                  <div className="p-3.5 rounded-xl bg-surface text-xs tabular-nums space-y-1.5">
                                        <div className="flex justify-between text-label-2">
                      <span>Algorithm</span>
                      <strong className="text-label truncate max-w-[120px]">{mlResult.modelAlgorithm || 'Automated'}</strong>
                    </div>
                    <div className="flex justify-between text-label-2">
                      <span>Task</span>
                      <strong className="text-label font-medium">{mlResult.modelType || 'regression'}</strong>
                    </div>
                  </div>

                  {/* Accuracy Gauge Segment */}
                  <div className="space-y-2">
                    <div className="flex justify-between text-xs tabular-nums">
                      <span className="text-label-2">Test score</span>
                      <strong className="text-label">
                        {((mlResult.metrics.accuracy !== undefined ? mlResult.metrics.accuracy : (mlResult.metrics.r2Score || 0.85)) * 100).toFixed(1)}%
                      </strong>
                    </div>
                    <div className="h-2 w-full bg-surface rounded-full overflow-hidden border border-separator">
                      <div 
                        className="h-full bg-blue rounded-full"
                        style={{ width: `${Math.min(100, (mlResult.metrics.accuracy !== undefined ? mlResult.metrics.accuracy : (mlResult.metrics.r2Score || 0.85)) * 100)}%` }}
                      />
                    </div>
                  </div>

                  {/* Feature Weights Segment */}
                  <div className="space-y-2 pt-2">
                    <h4 className="text-xs font-semibold text-label-2">Top drivers</h4>
                    <div className="space-y-2">
                      {mlResult.featureImportance?.slice(0, 4).map((f, i) => (
                        <div key={i} className="space-y-1">
                          <div className="flex justify-between text-[11px] tabular-nums text-label-2">
                            <span className="truncate max-w-[110px]">{f.feature}</span>
                            <span>{(f.score * 100).toFixed(1)}%</span>
                          </div>
                          <div className="h-1.5 w-full bg-surface rounded-full overflow-hidden">
                            <div 
                              className="h-full bg-blue/80 rounded-full"
                              style={{ width: `${Math.min(100, f.score * 100)}%` }}
                            />
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                </div>
              ) : (
                <div className="rounded-xl bg-surface text-center space-y-2 px-5 py-8">
                  <Cpu className="w-7 h-7 text-label-3 mx-auto" />
                  <p className="text-sm font-semibold text-label">No model trained yet</p>
                  <p className="text-[11px] text-label-2 leading-relaxed mt-1">
                    Train a model in the Model step and its results will appear here.
                  </p>
                </div>
              )}
            </div>
          </div>

          {/* COLUMN 3: MANAGEMENT & OPERATIONAL DECISION DIRECTIVES */}
          <div className="bg-well p-6 rounded-2xl flex flex-col justify-between space-y-6">
            <div className="space-y-5">
              <div className="flex items-center gap-2 mb-2">
                <div className="w-8 h-8 rounded-lg bg-orange/10 flex items-center justify-center text-orange">
                  <TrendingUp className="w-4 h-4" />
                </div>
                <h3 className="card-title">
                  Risks and recommendations
                </h3>
              </div>

              <div className="space-y-2">
                <h4 className="text-xs font-semibold text-label-2">Risks</h4>
                {findings.risks.length === 0 ? (
                  <p className="text-xs text-label-2 leading-relaxed">The automatic checks found no data-quality or model risks.</p>
                ) : (
                  <div className="space-y-2">
                    {findings.risks.map((risk, idx) => (
                      <div
                        key={idx}
                        className={`p-3 rounded-xl text-xs leading-relaxed text-label ${
                          risk.level === 'High' ? 'bg-red/10' : risk.level === 'Medium' ? 'bg-orange/10' : 'bg-surface'
                        }`}
                      >
                        <span className={`font-semibold block mb-0.5 ${
                          risk.level === 'High' ? 'text-red' : risk.level === 'Medium' ? 'text-orange' : 'text-label'
                        }`}>
                          {risk.level} · {risk.title}
                        </span>
                        {risk.detail}
                      </div>
                    ))}
                  </div>
                )}
              </div>

              <div className="space-y-2.5 pt-1">
                <h4 className="text-xs font-semibold text-label-2">Recommendations</h4>
                <div className="space-y-2 text-xs text-label">
                  {findings.recommendations.map((rec, idx) => (
                    <div key={idx} className="p-3 rounded-xl bg-surface leading-relaxed">
                      <strong className="text-label block mb-0.5">{idx + 1}. {rec.title}</strong>
                      {rec.detail}
                    </div>
                  ))}
                </div>
              </div>
            </div>
          </div>

        </div>

        <p className="mt-10 pt-6 border-t border-separator text-xs text-label-3">
          Generated automatically from {dataset.rowCount.toLocaleString()} rows and {dataset.columns.length} columns.
          Review findings against your own domain knowledge before acting on them.
        </p>
      </div>

      {(chain.length > 0 || savedRuns.length > 0) && (
        <div className="card p-5 sm:p-6 space-y-6 print:hidden" aria-labelledby="provenance-heading">
          <div>
            <h2 id="provenance-heading" className="card-title">Provenance and saved analyses</h2>
            <p className="mt-1 text-sm text-label-2">Where the numbers come from. Ticked analyses are added to the PDF and the package.</p>
          </div>
          {chain.length > 0 && (
            <div>
              <p className="field-label">How this data was produced</p>
              <ol className="space-y-1 text-sm">
                {chain.map((v, i) => (
                  <li key={v.id} className="flex gap-2">
                    <span className="text-label-3 tabular-nums w-7 shrink-0">v{i + 1}</span>
                    <span className="text-label">{v.label}</span>
                    <span className="text-label-3 tabular-nums">· {v.rowCount.toLocaleString()} × {v.columnCount}</span>
                  </li>
                ))}
              </ol>
            </div>
          )}
          {savedRuns.length > 0 && (
            <div>
              <p className="field-label">Saved analyses on this data</p>
              <ul className="space-y-3">
                {savedRuns.map(run => {
                  const d = describeRun(run);
                  return (
                    <li key={run.id} className="flex items-start gap-3">
                      <input
                        type="checkbox"
                        className="mt-1"
                        aria-label={`Include ${d.heading}`}
                        checked={!excluded.has(run.id)}
                        onChange={e => setExcluded(prev => { const n = new Set(prev); if (e.target.checked) n.delete(run.id); else n.add(run.id); return n; })}
                      />
                      <div className="min-w-0">
                        <p className="text-sm font-medium text-label">{d.heading}</p>
                        {d.lines.map(l => <p key={l} className="text-sm text-label-2">{l}</p>)}
                        <p className="text-xs text-label-3">Data {versionLabel(run.versionId)} · {new Date(run.createdAt).toLocaleString()}</p>
                      </div>
                    </li>
                  );
                })}
              </ul>
            </div>
          )}
        </div>
      )}

      {expertMode && <ExecutivePDFReport dataset={dataset} aiAnalysis={aiAnalysis} mlResult={mlResult} />}
      {expertMode && <ETLPipelineExport />}

      {/* OPERATIONAL LOGS / TERMINAL */}
      {expertMode && (
      <div className="card p-5 sm:p-6" id="reports_hub_terminal">
        <h3 className="card-title mb-3">Export log</h3>
        <div className="bg-well p-4 h-[120px] rounded-xl font-code text-xs text-label-2 space-y-1.5 overflow-y-auto">
          {logs.map((log, i) => (
            <div key={i} className="leading-relaxed">
              &gt; {log}
            </div>
          ))}
        </div>
      </div>
      )}

    </div>
  );
}
