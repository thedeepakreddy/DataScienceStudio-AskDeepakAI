/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState } from 'react';
import {
  AreaChart,
  TrendingUp,
  AlertTriangle,
  Sparkles,
  Table,
  Binary,
  Layers,
  Percent,
  Dot,
  CheckCircle2,
  Info,
  Database,
} from 'lucide-react';
import { Dataset, DatasetColumn, EdaReport as EdaReportType } from '../types';
import {
  calculateFullNumericSummaries,
  mapAllMissingValues,
  detectDuplicateRecords,
  findExtremeOutliers,
  computeCorrelationMatrix,
  computeCategoricalFrequencies,
  NumericSummary,
  MissingValueDetails,
  OutlierDetail,
  CategoricalValue
} from '../utils/edaEngine';
import SQLAssistant from './SQLAssistant';
import { usePipelineContext } from '../contexts/PipelineContext';
import { apiFetch } from '../utils/api';
import Orb from './Orb';

interface EDAReportProps {
  dataset: Dataset;
  /** Makes a SQL query result the working data. */
  onUseQueryResult?: (dataset: Dataset, summary: string) => void;
  aiAnalysis: {
    /** 'rules' when built from column statistics because AI was unavailable. */
    source?: 'rules';
    overviewSummary?: string;
    recommendedTarget?: string;
    modelType?: string;
    suggestedFeatures?: string[];
    scientistFocus?: string;
    scientistRationale?: string;
    strategicSlicer?: string;
    insights?: string[];
  } | null;
  loadingAI: boolean;
  onTriggerAI: () => void;
}

export default function EDAReport({ dataset, aiAnalysis, loadingAI, onTriggerAI, onUseQueryResult }: EDAReportProps) {
  const { expertMode } = usePipelineContext();
  // State for Sub-Workspaces
  const [activeSubTab, setActiveSubTab] = useState<'overview' | 'summaries' | 'integrity' | 'outliers' | 'correlation' | 'distributions' | 'categorical' | 'sql' | 'deepeda'>('overview');

  // Real server-side EDA (Python/pandas) — computed on-demand since it hits the network.
  const [deepEdaResult, setDeepEdaResult] = useState<EdaReportType | null>(null);
  const [loadingDeepEda, setLoadingDeepEda] = useState<boolean>(false);
  const [deepEdaError, setDeepEdaError] = useState<string | null>(null);

  const runDeepEda = async () => {
    setLoadingDeepEda(true);
    setDeepEdaError(null);
    try {
      const res = await apiFetch('/api/eda', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ datasetRows: dataset.rows })
      });
      const text = await res.text();
      let body: any = null;
      try { body = text ? JSON.parse(text) : null; } catch { /* host returned a non-JSON gateway page */ }
      if (!res.ok) throw new Error(body?.error || body?.hint || `EDA request failed (HTTP ${res.status}). The ML compute service may still be waking up from an idle sleep — try again in a moment.`);
      setDeepEdaResult(body);
    } catch (err: any) {
      setDeepEdaError(err.message || 'Real EDA computation failed — is the ML compute service running?');
    } finally {
      setLoadingDeepEda(false);
    }
  };

  
  // Interactive distribution selections
  const numericColsObj = dataset.columns.filter(c => c.type === 'numeric');
  const [selectedNumCol, setSelectedNumCol] = useState<string>(numericColsObj[0]?.name || '');
  
  const categoricalColsObj = dataset.columns.filter(c => c.type === 'categorical' || c.type === 'boolean');
  const [selectedCatCol, setSelectedCatCol] = useState<string>(categoricalColsObj[0]?.name || '');

  // Detailed coordinate list viewing toggles
  const [expandedMissingCol, setExpandedMissingCol] = useState<string | null>(null);
  const [expandedOutlierCol, setExpandedOutlierCol] = useState<string | null>(null);

  // Run analytic calculations
  const numSummaries = React.useMemo(() => calculateFullNumericSummaries(dataset.rows, dataset.columns), [dataset]);
  const missingDetails = React.useMemo(() => mapAllMissingValues(dataset.rows, dataset.columns), [dataset]);
  const duplicates = React.useMemo(() => detectDuplicateRecords(dataset.rows), [dataset]);
  const outlierDetails = React.useMemo(() => findExtremeOutliers(dataset.rows, dataset.columns), [dataset]);
  const corrMatrix = React.useMemo(() => computeCorrelationMatrix(dataset.rows, dataset.columns), [dataset]);

  // Compute total missing count across entire workspace
  const totalMissingCells = missingDetails.reduce((sum, col) => sum + col.count, 0);
  const totalCellsCount = dataset.rowCount * dataset.columns.length;
  const overallMissingnessPercent = totalCellsCount > 0 ? parseFloat(((totalMissingCells / totalCellsCount) * 100).toFixed(2)) : 0;

  // Compute total outliers count
  const totalOutliersCount = outlierDetails.reduce((sum, col) => sum + col.outliers.length, 0);

  // Helper for computing active numerical values of selected column
  const activeColValues = selectedNumCol 
    ? dataset.rows.map(r => r[selectedNumCol]).filter((v): v is number => typeof v === 'number' && !isNaN(v) && v !== null)
    : [];

  // Helper to calculate Histogram bins
  const histogramBinsCount = 10;
  const histogramData = selectedNumCol && activeColValues.length > 0
    ? (() => {
        const min = activeColValues.reduce((a, b) => (a < b ? a : b), activeColValues[0]);
        const max = activeColValues.reduce((a, b) => (a > b ? a : b), activeColValues[0]);
        const range = max - min;
        
        if (range === 0) {
          return [{
            binStart: min,
            binEnd: max,
            label: `${min.toFixed(2)}`,
            count: activeColValues.length,
            percentage: 100,
            relativeHeight: 1
          }];
        }

        const binSize = range / histogramBinsCount;
        const bins = Array.from({ length: histogramBinsCount }, (_, i) => {
          const start = min + i * binSize;
          const end = start + binSize;
          return {
            binStart: start,
            binEnd: end,
            label: `${start.toFixed(2)} - ${end.toFixed(2)}`,
            count: 0
          };
        });

        activeColValues.forEach(v => {
          let index = Math.floor((v - min) / binSize);
          if (index >= histogramBinsCount) index = histogramBinsCount - 1;
          if (index < 0) index = 0;
          bins[index].count++;
        });

        const maxCount = Math.max(...bins.map(b => b.count), 1);
        return bins.map(b => ({
          ...b,
          percentage: parseFloat(((b.count / activeColValues.length) * 100).toFixed(2)),
          relativeHeight: b.count / maxCount
        }));
      })()
    : [];

  // Categorical Data Fetching
  const activeCatDistribution = selectedCatCol
    ? computeCategoricalFrequencies(dataset.rows, selectedCatCol)
    : [];

  return (
    <div className="space-y-6" id="eda_interactive_workspace">

      {/* AI advisory — the one action this stage is built around. */}
      {!aiAnalysis && (
        <section className="card p-5 sm:p-6 flex flex-col sm:flex-row sm:items-center gap-4" aria-label="AI advisory">
          <div className="w-12 h-12 rounded-xl bg-blue/12 text-blue flex items-center justify-center shrink-0">
            <Sparkles className="w-6 h-6" />
          </div>
          <div className="flex-1 min-w-0">
            <h2 className="card-title">Get AI insights on this dataset</h2>
            <p className="mt-0.5 text-sm text-label-2 max-w-2xl">
              AskDeepakAI reads your columns and recommends what to predict, which features to use and how to segment
              the data.
            </p>
          </div>
          <button type="button" onClick={onTriggerAI} disabled={loadingAI} aria-busy={loadingAI} className="btn btn-primary btn-lg shrink-0">
            {loadingAI ? (
              <>
                <Orb state="breathing" onAccent label="AI is thinking about your data" />
                Thinking…
              </>
            ) : (
              'Run AI Advisory'
            )}
          </button>
        </section>
      )}

      {aiAnalysis && (
        <section className="card p-5 sm:p-6 animate-fade-in" aria-label="AI advisory results">
          <div className="flex items-center gap-2">
            <Sparkles className="w-[18px] h-[18px] text-blue" />
            <h2 className="card-title">{aiAnalysis.source === 'rules' ? 'Automatic summary' : 'AI insights'}</h2>
            {aiAnalysis.source === 'rules' && <span className="tag">Computed from column statistics — AI unavailable</span>}
          </div>
          <p className="mt-3 text-base text-label leading-relaxed max-w-4xl">{aiAnalysis.overviewSummary}</p>

          <dl className="mt-5 grid grid-cols-1 md:grid-cols-3 gap-4">
            <div className="rounded-xl bg-well p-4">
              <dt className="text-xs text-label-2">Recommended target</dt>
              <dd className="mt-1 text-lg font-semibold tracking-tight text-label break-all">
                {aiAnalysis.recommendedTarget || 'Not specified'}
              </dd>
              <dd className="mt-1 text-xs text-label-2 capitalize">
                {aiAnalysis.modelType || 'Model type not specified'} · {(aiAnalysis.suggestedFeatures || []).length} suggested features
              </dd>
            </div>
            <div className="rounded-xl bg-well p-4">
              <dt className="text-xs text-label-2">Where to look first</dt>
              <dd className="mt-1 text-lg font-semibold tracking-tight text-label break-all">{aiAnalysis.scientistFocus}</dd>
              <dd className="mt-1 text-xs text-label-2 leading-relaxed">{aiAnalysis.scientistRationale}</dd>
            </div>
            <div className="rounded-xl bg-well p-4">
              <dt className="text-xs text-label-2">Best column to segment by</dt>
              <dd className="mt-1 text-lg font-semibold tracking-tight text-label break-all">{aiAnalysis.strategicSlicer}</dd>
              <dd className="mt-1 text-xs text-label-2 leading-relaxed">
                Splitting the data by this column gives the clearest separation between groups.
              </dd>
            </div>
          </dl>

          {(aiAnalysis.suggestedFeatures || []).length > 0 && (
            <div className="mt-4 flex flex-wrap items-center gap-2">
              <span className="text-xs text-label-2 mr-1">Suggested features</span>
              {(aiAnalysis.suggestedFeatures || []).map((f: string) => (
                <span key={f} className="tag">{f}</span>
              ))}
            </div>
          )}
        </section>
      )}

      {/* Views */}
      <div className="overflow-x-auto scrollbar-none -mx-4 px-4 sm:mx-0 sm:px-0" id="eda_tabs_nav">
        <div className="segmented w-max" role="tablist" aria-label="Exploration views">
          {[
            { id: 'overview', label: 'Overview' },
            { id: 'summaries', label: 'Statistics' },
            { id: 'integrity', label: 'Data Quality' },
            { id: 'deepeda', label: 'Deep Analysis' },
            ...(expertMode ? [
              { id: 'sql', label: 'SQL' },
              { id: 'outliers', label: 'Outliers' },
              { id: 'correlation', label: 'Correlation' },
              { id: 'distributions', label: 'Distributions' },
              { id: 'categorical', label: 'Categories' }
            ] : [])
          ].map(tab => (
            <button
              key={tab.id}
              type="button"
              role="tab"
              aria-selected={activeSubTab === tab.id}
              onClick={() => setActiveSubTab(tab.id as any)}
            >
              {tab.label}
            </button>
          ))}
        </div>
      </div>

      {/* 🚀 WORKSPACE CONTENT DECIDER */}
      <div className="min-h-[400px]">

        {/* 1. DATA STRUCTURE OVERVIEW SUBTAB */}
        {activeSubTab === 'overview' && (
          <div className="space-y-6 animate-fade-in">
            {/* Summary tiles */}
            <dl className="grid grid-cols-2 lg:grid-cols-4 gap-4">
              <div className="card p-4">
                <dt className="text-xs text-label-2">Rows</dt>
                <dd className="mt-1 text-[28px] leading-none font-semibold tracking-tight tabular-nums text-label">{dataset.rowCount.toLocaleString()}</dd>
              </div>
              <div className="card p-4">
                <dt className="text-xs text-label-2">Columns</dt>
                <dd className="mt-1 text-[28px] leading-none font-semibold tracking-tight tabular-nums text-label">{dataset.columns.length}</dd>
              </div>
              <div className="card p-4">
                <dt className="text-xs text-label-2">Missing values</dt>
                <dd className={`mt-1 text-[28px] leading-none font-semibold tracking-tight tabular-nums ${totalMissingCells > 0 ? 'text-orange' : 'text-label'}`}>{overallMissingnessPercent}%</dd>
                <dd className="mt-1.5 text-xs text-label-3">{totalMissingCells.toLocaleString()} empty {totalMissingCells === 1 ? 'cell' : 'cells'}</dd>
              </div>
              <div className="card p-4">
                <dt className="text-xs text-label-2">Duplicate rows</dt>
                <dd className={`mt-1 text-[28px] leading-none font-semibold tracking-tight tabular-nums ${duplicates.length > 0 ? 'text-red' : 'text-label'}`}>{duplicates.length}</dd>
                <dd className="mt-1.5 text-xs text-label-3">{duplicates.length === 0 ? 'Every row is unique' : duplicates.length === 1 ? 'group of identical rows' : 'groups of identical rows'}</dd>
              </div>
            </dl>

            {/* Column Schema Details Table */}
            <div className="bg-surface rounded-xl border border-separator p-5 overflow-hidden shadow-sm">
              <h4 className="text-label text-sm font-semibold flex items-center gap-2 mb-4">
                Columns
              </h4>
              <div className="overflow-x-auto">
                <table className="w-full text-left text-xs border-collapse">
                  <thead>
                    <tr className="border-b border-separator text-label-2 tabular-nums text-[11px]">
                      <th className="py-2 px-3">#</th>
                      <th className="py-2 px-3">Name</th>
                      <th className="py-2 px-3">Type</th>
                      <th className="py-2 px-3">Distinct</th>
                      <th className="py-2 px-3">Missing</th>
                      <th className="py-2 px-3 text-right">Complete</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-separator">
                    {dataset.columns.map((col, idx) => {
                      const missingPercent = parseFloat(((col.missingCount / dataset.rowCount) * 100).toFixed(1));
                      const completenessPercent = 100 - missingPercent;
                      return (
                        <tr key={idx} className="hover:bg-fill text-label">
                          <td className="py-3 px-3 tabular-nums text-label-3">{idx + 1}</td>
                          <td className="py-3 px-3 tabular-nums font-semibold text-label max-w-[200px] truncate">{col.name}</td>
                          <td className="py-3 px-3">
                            <span className={`px-2 py-0.5 rounded text-[11px] tabular-nums font-semibold ${
                              col.type === 'numeric' ? 'bg-blue/10 text-blue border border-blue/20' :
                              col.type === 'categorical' ? 'bg-purple/10 text-purple border border-purple/20' :
                              col.type === 'boolean' ? 'bg-teal/10 text-teal border border-teal/20' :
                              'bg-orange/10 text-orange border border-orange/20'
                            }`}>
                              {col.type}
                            </span>
                          </td>
                          <td className="py-3 px-3 tabular-nums">{col.distinctCount.toLocaleString()}</td>
                          <td className="py-3 px-3 tabular-nums text-label-2">{col.missingCount.toLocaleString()} <span className="text-[11px] text-label-3">({missingPercent}%)</span></td>
                          <td className="py-3 px-3 text-right">
                            <div className="flex items-center justify-end gap-2.5 tabular-nums">
                              <span className="text-label">{completenessPercent.toFixed(1)}%</span>
                              <div className="w-16 h-1.5 bg-fill rounded-full overflow-hidden inline-block border border-separator-strong">
                                <div 
                                  className={`h-full rounded-full ${completenessPercent === 100 ? 'bg-green' : completenessPercent > 80 ? 'bg-blue' : 'bg-orange'}`}
                                  style={{ width: `${completenessPercent}%` }}
                                />
                              </div>
                            </div>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </div>
          </div>
        )}

        {/* 2. COMPREHENSIVE SUMMARY STATISTICS SUBTAB */}
        {activeSubTab === 'summaries' && (
          <div className="space-y-6 animate-fade-in">
            <div className="bg-surface rounded-xl border border-separator p-5 shadow-sm space-y-4">
              <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-3">
                <div>
                  <h4 className="text-label text-sm font-semibold flex items-center gap-2">
                    <Binary className="w-4.5 h-4.5 text-blue" /> Summary statistics
                  </h4>
                  <p className="text-xs text-label-2 mt-1">
                    Complete statistical distributions detailing central tendencies, variation coefficients, standard deviation, and quartile limits.
                  </p>
                </div>
                <div className="bg-blue/10 border border-blue/20 px-3 py-1.5 rounded-lg text-[11px] tabular-nums text-blue">
                  Calculated values are double-precision floating points
                </div>
              </div>

              {numSummaries.length === 0 ? (
                <div className="text-center p-8 text-xs text-label-3 border border-dashed border-separator rounded-xl">
                  No numerical columns found in the active dataset. Change type or upload numeric inputs.
                </div>
              ) : (
                <div className="overflow-x-auto select-text">
                  <table className="w-full text-left text-xs border-collapse">
                    <thead>
                      <tr className="border-b border-separator text-label-2 tabular-nums text-[11px]">
                        <th className="py-3 px-3">Variable</th>
                        <th className="py-3 px-3 text-right">Observation Count</th>
                        <th className="py-3 px-3 text-right">Minimum Value</th>
                        <th className="py-3 px-3 text-right">Quartile 1 (25%)</th>
                        <th className="py-3 px-3 text-right">Median (50%)</th>
                        <th className="py-3 px-3 text-right">Quartile 3 (75%)</th>
                        <th className="py-3 px-3 text-right">Maximum Value</th>
                        <th className="py-3 px-3 text-right">Mean (μ)</th>
                        <th className="py-3 px-3 text-right">Standard Deviation (σ)</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-separator">
                      {numSummaries.map((s, idx) => (
                        <tr key={idx} className="hover:bg-fill text-label">
                          <td className="py-3.5 px-3 tabular-nums font-semibold text-label truncate max-w-[160px]">{s.columnName}</td>
                          <td className="py-3.5 px-3 text-right tabular-nums text-label-2">{s.count.toLocaleString()}</td>
                          <td className="py-3.5 px-3 text-right tabular-nums text-green">{s.min.toLocaleString()}</td>
                          <td className="py-3.5 px-3 text-right tabular-nums text-blue">{s.q1.toLocaleString()}</td>
                          <td className="py-3.5 px-3 text-right tabular-nums text-blue font-semibold">{s.median.toLocaleString()}</td>
                          <td className="py-3.5 px-3 text-right tabular-nums text-blue">{s.q3.toLocaleString()}</td>
                          <td className="py-3.5 px-3 text-right tabular-nums text-red">{s.max.toLocaleString()}</td>
                          <td className="py-3.5 px-3 text-right tabular-nums text-label font-medium">{s.mean.toLocaleString()}</td>
                          <td className="py-3.5 px-3 text-right tabular-nums text-label-2">{s.stdDev.toLocaleString()}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
            
            <div className="bg-surface p-4 rounded-xl border border-separator flex gap-3 text-xs leading-relaxed text-label-2">
              <Info className="w-5 h-5 text-blue shrink-0 mt-0.5" />
              <div>
                <strong className="text-label">Data Science Definition Guide:</strong>
                <ul className="list-disc list-inside mt-1.5 space-y-1">
                  <li><strong className="text-label">Standard Deviation (σ)</strong>: Measures the amount of variation or dispersion from the mean value. Lower indicates compact clustering.</li>
                  <li><strong className="text-label">Quartiles (25%, 50%, 75%)</strong>: Splits the sorted values list into four equal clusters. Visualizes skewness and potential outlier limits.</li>
                </ul>
              </div>
            </div>
          </div>
        )}

        {/* 3. MISSING & DUPLICATES DATA INTEGRITY SCAN SUBTAB */}
        {activeSubTab === 'integrity' && (
          <div className="space-y-6 animate-fade-in text-xs">
            
            {/* Missing Values Detail Block */}
            <div className="bg-surface border border-separator p-5 rounded-xl shadow-sm space-y-4">
              <div className="flex justify-between items-center pb-2 border-b border-separator">
                <h4 className="text-label text-sm font-semibold flex items-center gap-2">
                  <Percent className="w-4 h-4 text-blue" /> Missing values
                </h4>
                <span className="bg-blue/10 border border-blue/25 text-blue px-2 py-0.5 rounded tabular-nums font-semibold text-[11px]">
                  {totalMissingCells.toLocaleString()} TOTAL NULL COORD
                </span>
              </div>

              <p className="text-label-2">
                This table explicitly lists exact indices where nulls are observed. Locate missing records precisely before pipeline cleansing transformations.
              </p>

              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                {missingDetails.map((col, idx) => {
                  const isExpanded = expandedMissingCol === col.columnName;
                  return (
                    <div key={idx} className="bg-well border border-separator p-4 rounded-xl space-y-3">
                      <div className="flex justify-between items-center">
                        <span className="tabular-nums font-semibold text-label text-xs">{col.columnName}</span>
                        <div className="flex items-center gap-2">
                          <span className={`px-2 py-0.5 rounded text-[11px] tabular-nums ${col.count > 0 ? 'bg-orange/15 text-orange border border-orange/20' : 'bg-green/10 text-green'}`}>
                            {col.count} {col.count === 1 ? 'Null Row' : 'Null Rows'} ({col.percent}%)
                          </span>
                        </div>
                      </div>

                      {col.count === 0 ? (
                        <div className="text-green font-semibold tabular-nums text-[11px] flex items-center gap-1">
                          <CheckCircle2 className="w-3.5 h-3.5 text-green shrink-0" /> Integrity perfect. 100% complete
                        </div>
                      ) : (
                        <div className="space-y-2">
                          <div className="flex justify-between items-center text-[11px] text-label-3 tabular-nums">
                            <span>Coordinate Index Array:</span>
                            <button
                              onClick={() => setExpandedMissingCol(isExpanded ? null : col.columnName)}
                              className="text-blue hover:text-blue underline font-semibold bg-transparent border-0 cursor-pointer p-0"
                            >
                              {isExpanded ? 'Collapse' : `Show all ${col.count} coordinates`}
                            </button>
                          </div>
                          
                          <div className="flex flex-wrap gap-1.5 max-h-24 overflow-y-auto bg-surface p-2 rounded-lg border border-separator">
                            {col.locations.slice(0, isExpanded ? undefined : 15).map((loc, lIdx) => (
                              <span key={lIdx} className="px-1.5 py-0.5 rounded bg-well text-label tabular-nums text-[11px] border border-separator">
                                Row {loc}
                              </span>
                            ))}
                            {!isExpanded && col.locations.length > 15 && (
                              <span className="px-2 py-0.5 text-[11px] text-label-3 tabular-nums select-none">
                                + {col.locations.length - 15} more locations
                              </span>
                            )}
                          </div>
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>

            {/* Duplicate Records Detail Block */}
            <div className="bg-surface border border-separator p-5 rounded-xl shadow-sm space-y-4">
              <h4 className="text-label text-sm font-semibold flex items-center gap-2 pb-2 border-b border-separator">
                <Layers className="w-4.5 h-4.5 text-red" /> Duplicate rows
              </h4>
              
              <p className="text-label-2">
                Data redundancy compromises evaluation accuracy. Below is a list of all identical clusters having overlapping inputs across every single column coordinate.
              </p>

              {duplicates.length === 0 ? (
                <div className="bg-green/5 border border-green/25 text-green p-4 rounded-xl flex items-center gap-3 font-medium">
                  <CheckCircle2 className="w-5 h-5 text-green shrink-0" />
                  <span>Success: 0 duplicate records identified. Every row in this spreadsheet possesses distinct feature properties.</span>
                </div>
              ) : (
                <div className="space-y-3">
                  <div className="bg-red/10 border border-red/20 text-red p-4 rounded-xl font-medium">
                    Attention: We found <strong>{duplicates.length} duplicate groups</strong> in the active worksheet. Eliminating these redundant records is advised for robust ML training.
                  </div>

                  <div className="divide-y divide-separator border border-separator bg-well rounded-xl overflow-hidden">
                    {duplicates.map((group, idx) => (
                      <div key={idx} className="p-4 flex flex-col md:flex-row justify-between items-start md:items-center gap-4 hover:bg-surface">
                        <div className="space-y-1 flex-1">
                          <p className="tabular-nums text-label text-xs font-semibold">
                            Redundancy Group #{idx + 1}
                          </p>
                          <p className="text-[11px] tabular-nums text-label-3 truncate max-w-xl">
                            Payload Signature: {group.rowString}
                          </p>
                        </div>
                        <div className="flex flex-wrap gap-1 md:justify-end max-w-md">
                          <span className="text-[11px] tabular-nums font-medium text-red mr-2 self-center">
                            {group.indices.length} overlapping rows:
                          </span>
                          {group.indices.map((rNum, gIdx) => (
                            <span key={gIdx} className="px-2 py-0.5 rounded bg-surface text-label tabular-nums text-[11px] border border-separator shadow">
                              Row {rNum}
                            </span>
                          ))}
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>

          </div>
        )}

        {/* 4. IQR OUTLIER SCAN SUBTAB */}
        {activeSubTab === 'outliers' && (
          <div className="space-y-6 animate-fade-in text-xs">
            <div className="bg-surface border border-separator p-5 rounded-xl shadow-sm space-y-4">
              <div>
                <h4 className="text-label text-sm font-semibold flex items-center gap-2">
                  <Percent className="w-4 h-4 text-blue" /> Outliers
                </h4>
                <p className="text-label-2 mt-1">
                  Using structural Tukey limits. Numeric limits mapped dynamically as: <code className="bg-well px-1.5 py-0.5 rounded text-blue tabular-nums text-xs">[ Q1 - 1.5 × IQR , Q3 + 1.5 × IQR ]</code>. Values falling outside are flagged.
                </p>
              </div>

              <div className="grid grid-cols-1 lg:grid-cols-3 gap-6 pt-3">
                
                {/* Total Stats card */}
                <div className="bg-well p-5 rounded-xl border border-separator flex flex-col justify-between space-y-4">
                  <div className="space-y-2">
                    <span className="text-[11px] tabular-nums font-medium text-blue">AGGREGATE STATS</span>
                    <h5 className="font-semibold text-label text-sm mt-1">Outlier summary</h5>
                    <p className="text-xs text-label-2 leading-relaxed">
                      We observed {totalOutliersCount} anomalous parameters out of {activeColValues.length * numericColsObj.length} numeric observations in total.
                    </p>
                  </div>
                  <div className="p-4 bg-surface rounded-lg border border-separator text-center">
                    <p className="text-[11px] tabular-nums text-label-3">Extreme Outlier Points</p>
                    <p className={`text-4xl font-semibold tabular-nums mt-1 ${totalOutliersCount > 0 ? 'text-orange' : 'text-green'}`}>
                      {totalOutliersCount}
                    </p>
                    <span className="text-[11px] text-label-3">records require data checking</span>
                  </div>
                </div>

                {/* Columns Anomalytrend list */}
                <div className="lg:col-span-2 space-y-4">
                  <div className="overflow-x-auto border border-separator rounded-xl overflow-hidden">
                    <table className="w-full text-left text-xs border-collapse">
                      <thead>
                        <tr className="border-b border-separator bg-well text-label-2 tabular-nums text-[11px]">
                          <th className="p-3">Variable Metric</th>
                          <th className="p-3 text-center">IQR Range</th>
                          <th className="p-3 text-center">Boundary limits</th>
                          <th className="p-3 text-center">Anomaly Count</th>
                          <th className="p-3 text-right">View Coordinates</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-separator bg-surface">
                        {outlierDetails.map((det, idx) => {
                          const isExpanded = expandedOutlierCol === det.columnName;
                          const ratePercent = dataset.rowCount > 0 ? parseFloat(((det.outliers.length / dataset.rowCount) * 100).toFixed(1)) : 0;
                          return (
                            <React.Fragment key={idx}>
                              <tr className="hover:bg-fill text-label">
                                <td className="p-3 tabular-nums font-semibold text-label truncate max-w-[140px]">{det.columnName}</td>
                                <td className="p-3 text-center tabular-nums text-label-2">{det.iqr.toLocaleString()}</td>
                                <td className="p-3 text-center tabular-nums text-[11px] text-blue">
                                  [{det.lowerBound.toLocaleString()} , {det.upperBound.toLocaleString()}]
                                </td>
                                <td className="p-3 text-center">
                                  <span className={`px-2 py-0.5 rounded-full tabular-nums text-[11px] font-semibold ${
                                    det.outliers.length > 0 ? 'bg-orange/15 text-orange border border-orange/20' : 'bg-green/10 text-green'
                                  }`}>
                                    {det.outliers.length} ({ratePercent}%)
                                  </span>
                                </td>
                                <td className="p-3 text-right">
                                  {det.outliers.length > 0 ? (
                                    <button
                                      onClick={() => setExpandedOutlierCol(isExpanded ? null : det.columnName)}
                                      className="text-xs font-semibold text-blue hover:text-blue underline bg-transparent border-0 cursor-pointer"
                                    >
                                      {isExpanded ? 'Hide' : 'Expand'}
                                    </button>
                                  ) : (
                                    <span className="text-[11px] tabular-nums text-green bg-green/10 px-2 py-0.5 rounded">
                                      Healthy Q
                                    </span>
                                  )}
                                </td>
                              </tr>
                              
                              {/* Inline Outliers Coordinates expanded drawer */}
                              {isExpanded && det.outliers.length > 0 && (
                                <tr>
                                  <td colSpan={5} className="p-3 bg-well border-t border-separator">
                                    <div className="space-y-2">
                                      <p className="text-[11px] tabular-nums text-blue font-semibold">
                                        Anomalous Values Located (Row location & actual observation):
                                      </p>
                                      <div className="flex flex-wrap gap-2 max-h-40 overflow-y-auto p-1">
                                        {det.outliers.map((out, outIdx) => (
                                          <span key={outIdx} className="px-2.5 py-1 rounded bg-surface border border-red/15 text-label tabular-nums text-xs flex items-center shadow">
                                            <span className="font-semibold text-red mr-1.5">Row {out.rowIndex}:</span>
                                            <span className="text-label font-semibold">{out.value.toLocaleString()}</span>
                                          </span>
                                        ))}
                                      </div>
                                    </div>
                                  </td>
                                </tr>
                              )}
                            </React.Fragment>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                </div>

              </div>
            </div>
          </div>
        )}

        {/* 5. COVARIANCE & PEARSON CORRELATION MATRIX SUBTAB */}
        {activeSubTab === 'correlation' && (
          <div className="space-y-6 animate-fade-in text-xs">
            <div className="bg-surface border border-separator p-5 rounded-xl shadow-sm space-y-4">
              <div>
                <h4 className="text-label text-sm font-semibold flex items-center gap-2">
                  <AreaChart className="w-4.5 h-4.5 text-blue" /> Correlation strength
                </h4>
                <p className="text-label-2 mt-1">
                  Covariance normalization mapped as numerical coefficients <code className="bg-well px-1 rounded text-teal tabular-nums">r ∈ [-1, +1]</code>. Quantifies bidirectional linear feature associations.
                </p>
              </div>

              {corrMatrix.features.length < 2 ? (
                <div className="text-center p-8 text-xs text-label-3 border border-dashed border-separator rounded-xl">
                  Correlation matrix requires at least 2 numeric variables. Add other numeric properties in raw files or change category assignments under the cleaning tab.
                </div>
              ) : (
                <div className="space-y-6">
                  
                  {/* Graphical Heatmap */}
                  <div className="overflow-x-auto border border-separator rounded-xl p-4 bg-well">
                    <div className="min-w-[600px] flex flex-col items-center">
                      <p className="text-[11px] tabular-nums font-medium text-blue mb-6 bg-blue/5 px-3 py-1 rounded-full border border-blue/10">
                        Bidirectional Interactive Correlation Heatmap
                      </p>
                      
                      {/* Grid representation */}
                      <div className="flex flex-col gap-1 w-full max-w-3xl">
                        
                        {/* Header labels */}
                        <div className="flex text-xs tabular-nums font-semibold text-label-2 text-center pb-2">
                          <div className="w-1/4 text-left self-center text-[11px] text-label-3">Variable Y / X</div>
                          {corrMatrix.features.map(feat => (
                            <div key={feat} className="flex-1 truncate px-1 text-[11px] font-semibold" title={feat}>
                              {feat}
                            </div>
                          ))}
                        </div>

                        {/* Heated Rows */}
                        {corrMatrix.features.map(rowFeat => (
                          <div key={rowFeat} className="flex gap-1 text-center tabular-nums">
                            {/* Row selector label */}
                            <div className="w-1/4 text-xs font-semibold text-label text-left self-center truncate pr-2" title={rowFeat}>
                              {rowFeat}
                            </div>

                            {/* Correlation cells */}
                            {corrMatrix.features.map(colFeat => {
                              const r = corrMatrix.matrix[rowFeat][colFeat];
                              const isSelf = rowFeat === colFeat;
                              
                              // Shading logic depending on positive or negative correlation strength
                              let cellStyle = 'bg-surface border border-separator text-label-2 transition-all text-xs';
                              if (isSelf) {
                                cellStyle = 'bg-blue font-semibold border border-blue text-white tabular-nums shadow';
                              } else if (r > 0.7) {
                                cellStyle = 'bg-green/50 font-semibold text-label border border-green/60 transition-all';
                              } else if (r > 0.4) {
                                cellStyle = 'bg-green/25 text-green border border-green/30 transition-all';
                              } else if (r > 0.1) {
                                cellStyle = 'bg-green/10 text-green border border-green/15 transition-all';
                              } else if (r < -0.7) {
                                cellStyle = 'bg-red/50 font-semibold text-label border border-red/60 transition-all';
                              } else if (r < -0.4) {
                                cellStyle = 'bg-red/25 text-red border border-red/30 transition-all';
                              } else if (r < -0.1) {
                                cellStyle = 'bg-red/10 text-red border border-red/15 transition-all';
                              }

                              return (
                                <div
                                  key={colFeat}
                                  className={`flex-1 py-3 text-xs tabular-nums rounded-md flex items-center justify-center select-none cursor-help ${cellStyle}`}
                                  title={`${rowFeat} ↔ ${colFeat}: r = ${r}`}
                                >
                                  {r > 0 && !isSelf ? `+${r.toFixed(3)}` : r.toFixed(3)}
                                </div>
                              );
                            })}
                          </div>
                        ))}
                      </div>

                      {/* Legends */}
                      <div className="flex gap-6 mt-6 justify-center text-[11px] tabular-nums text-label-3 bg-surface px-4 py-2 rounded-lg border border-separator">
                        <div className="flex items-center gap-1.5">
                          <span className="w-3.5 h-3.5 rounded bg-red/50 block" />
                          <span>Strong Negative (r ≤ -0.7)</span>
                        </div>
                        <div className="flex items-center gap-1.5">
                          <span className="w-3.5 h-3.5 rounded bg-surface border border-separator block" />
                          <span>Near Neutral (|r| &lt; 0.1)</span>
                        </div>
                        <div className="flex items-center gap-1.5">
                          <span className="w-3.5 h-3.5 rounded bg-green/50 block" />
                          <span>Strong Positive (r ≥ 0.7)</span>
                        </div>
                      </div>
                    </div>
                  </div>

                  {/* Scatter plot Feature Relationship visualizer */}
                  <FeatureRelationshipScatter dataset={dataset} numericCols={corrMatrix.features} />

                </div>
              )}
            </div>
          </div>
        )}

        {/* 6. NUMERIC DISTRIBUTIONS DYNAMIC VISUALIZER (HISTOGRAM + BOXPLOT) */}
        {activeSubTab === 'distributions' && (
          <div className="space-y-6 animate-fade-in text-xs">
            <div className="bg-surface border border-separator p-5 rounded-xl shadow-sm space-y-4">
              
              <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4 pb-2 border-b border-separator">
                <div>
                  <h4 className="text-label text-sm font-semibold flex items-center gap-2">
                    <TrendingUp className="w-4.5 h-4.5 text-blue" /> Distributions
                  </h4>
                  <p className="text-label-2 mt-1">
                    Pick a numeric column to see how its values are spread.
                  </p>
                </div>
                
                {/* Column variable selector drops */}
                <div className="flex items-center gap-2.5">
                  <span className="tabular-nums text-label-3 font-medium">Column</span>
                  <select
                    value={selectedNumCol}
                    onChange={(e) => setSelectedNumCol(e.target.value)}
                    className="bg-surface border border-separator-strong text-label px-3 py-1.5 rounded-xl text-xs tabular-nums focus:outline-none focus:border-blue transition-colors cursor-pointer"
                  >
                    {numericColsObj.map(c => (
                      <option key={c.name} value={c.name}>{c.name}</option>
                    ))}
                  </select>
                </div>
              </div>

              {!selectedNumCol ? (
                <div className="text-center p-8 text-xs text-label-3 border border-dashed border-separator rounded-xl">
                  No numeric columns available to compile histograms. Convert column parameters.
                </div>
              ) : (
                <div className="grid grid-cols-1 lg:grid-cols-3 gap-6 pt-2">
                  
                  {/* Left Column stats report */}
                  <div className="bg-well p-5 rounded-xl border border-separator space-y-4">
                    <span className="text-[11px] tabular-nums font-medium text-blue bg-teal/10 border border-teal/20 px-2 py-0.5 rounded">
                      Statistics
                    </span>
                    <h5 className="font-semibold text-label text-base tabular-nums truncate">{selectedNumCol}</h5>
                    
                    {(() => {
                      const sumStats = numSummaries.find(s => s.columnName === selectedNumCol);
                      if (!sumStats) return null;
                      return (
                        <div className="space-y-3 pt-2 tabular-nums">
                          <div className="flex justify-between border-b border-separator pb-2.5">
                            <span className="text-label-2 text-xs">Mean</span>
                            <span className="text-label font-semibold">{sumStats.mean.toLocaleString()}</span>
                          </div>
                          <div className="flex justify-between border-b border-separator pb-2.5">
                            <span className="text-label-2 text-xs">Standard deviation</span>
                            <span className="text-label">{sumStats.stdDev.toLocaleString()}</span>
                          </div>
                          <div className="flex justify-between border-b border-separator pb-2.5">
                            <span className="text-label-2 text-xs">Median</span>
                            <span className="text-label font-semibold">{sumStats.median.toLocaleString()}</span>
                          </div>
                          <div className="flex justify-between border-b border-separator pb-2.5">
                            <span className="text-label-2 text-xs">25th Percentile (Q1)</span>
                            <span className="text-blue font-semibold">{sumStats.q1.toLocaleString()}</span>
                          </div>
                          <div className="flex justify-between border-b border-separator pb-2.5">
                            <span className="text-label-2 text-xs">75th Percentile (Q3)</span>
                            <span className="text-blue font-semibold">{sumStats.q3.toLocaleString()}</span>
                          </div>
                          <div className="flex justify-between text-xs text-label-3 pt-1.5">
                            <span>Min: {sumStats.min.toLocaleString()}</span>
                            <span>Max: {sumStats.max.toLocaleString()}</span>
                          </div>
                        </div>
                      );
                    })()}
                  </div>

                  {/* Histogram and Box plot column view */}
                  <div className="lg:col-span-2 space-y-6">
                    
                    {/* SVG HISTOGRAM PROBABILITY BINS */}
                    <div className="bg-well p-4 rounded-xl border border-separator">
                      <p className="text-[11px] tabular-nums font-medium text-blue mb-4 text-center">
                        Histogram
                      </p>
                      
                      <div className="h-60 w-full flex items-end gap-1.5 pt-4 px-2 select-none relative">
                        
                        {/* Normalized baseline axis */}
                        <div className="absolute left-0 bottom-0 w-full h-[1px] bg-fill-strong" />
                        
                        {histogramData.map((bin, bIdx) => (
                          <div
                            key={bIdx}
                            className="flex-1 flex flex-col justify-end items-center group relative cursor-help"
                            style={{ height: '100%' }}
                          >
                            {/* Hover Coordinate Info Card Tooltips */}
                            <div className="absolute bottom-full mb-3 hidden group-hover:block bg-surface border border-separator-strong p-2.5 rounded-lg shadow-xl z-10 w-44 pointer-events-none text-left">
                              <p className="tabular-nums text-blue text-[11px] font-medium">Bin Bounds:</p>
                              <p className="text-xs text-label tabular-nums mt-0.5">{bin.label}</p>
                              <p className="tabular-nums text-green text-[11px] font-medium mt-2">Row Count / %:</p>
                              <p className="text-xs text-label tabular-nums mt-0.5">{bin.count.toLocaleString()} rows ({bin.percentage}%)</p>
                            </div>

                            {/* Actual Histogram bar */}
                            <div
                              className="w-full bg-gradient-to-t from-blue/80 to-blue/95 hover:brightness-125 transition-all duration-300 rounded-t border-t border-teal/20"
                              style={{ height: `${Math.max(4, bin.relativeHeight * 85)}%` }}
                            />

                            {/* Small Count marker above bar if hover */}
                            <span className="text-[11px] tabular-nums text-label-3 mt-1 opacity-0 group-hover:opacity-100 transition-opacity absolute bottom-[5%] bg-well px-1 py-0.5 rounded border border-separator">
                              {bin.count}
                            </span>
                          </div>
                        ))}
                      </div>

                      {/* X and Y Axis helpers */}
                      <div className="flex justify-between items-center text-[11px] tabular-nums text-label-3 mt-2 px-2.5 border-t border-separator pt-1.5">
                        <span>Min {activeColValues.length > 0 ? activeColValues.reduce((a, b) => (a < b ? a : b)).toLocaleString() : '0'}</span>
                        <span>10 equal-width bins</span>
                        <span>Max {activeColValues.length > 0 ? activeColValues.reduce((a, b) => (a > b ? a : b)).toLocaleString() : '0'}</span>
                      </div>
                    </div>

                    {/* SVG QUARTILE BOX PLOT DRAW */}
                    <div className="bg-well p-4 rounded-xl border border-separator space-y-4">
                      <p className="text-[11px] tabular-nums font-medium text-blue text-center">
                        Box plot
                      </p>

                      {(() => {
                        const sumStats = numSummaries.find(s => s.columnName === selectedNumCol);
                        if (!sumStats || sumStats.min === sumStats.max) return null;
                        
                        const min = sumStats.min;
                        const max = sumStats.max;
                        const range = max - min;
                        
                        // Percentage map function
                        const getPct = (val: number) => ((val - min) / range) * 100;
                        
                        const q1Pct = getPct(sumStats.q1);
                        const medianPct = getPct(sumStats.median);
                        const q3Pct = getPct(sumStats.q3);
                        
                        return (
                          <div className="pt-6 pb-4 px-4 select-none relative">
                            {/* Whisker Line */}
                            <div className="absolute left-[10%] w-[80%] h-[1px] bg-blue/40 top-[50%] -translate-y-1/2" style={{
                              left: '0%',
                              width: '100%'
                            }} />

                            {/* Min cap */}
                            <div className="absolute w-[1px] h-4 bg-blue top-[50%] -translate-y-1/2" style={{ left: '0%' }} />
                            
                            {/* Max cap */}
                            <div className="absolute w-[1px] h-4 bg-blue top-[50%] -translate-y-1/2" style={{ left: '100%' }} />

                            {/* Interquartile Box */}
                            <div className="absolute h-8 bg-gradient-to-r from-blue/60 to-blue/60 rounded border border-blue/50 top-[50%] -translate-y-1/2 shadow-sm" style={{
                              left: `${q1Pct}%`,
                              width: `${q3Pct - q1Pct}%`
                            }} />

                            {/* Median Line */}
                            <div className="absolute h-8 w-1 bg-blue hover:bg-white transition-colors top-[50%] -translate-y-1/2 shadow" style={{
                              left: `${medianPct}%`
                            }} />

                            {/* Spacing alignment spacers */}
                            <div className="h-10 w-full" />

                            {/* Dynamic coordinates text */}
                            <div className="flex justify-between items-center text-[11px] tabular-nums text-label-3 pt-4 border-t border-separator">
                              <span className="text-label-2">Min: <strong className="text-label">{min.toLocaleString()}</strong></span>
                              <span className="text-blue font-semibold">Q1 (25%): <strong className="text-label">{sumStats.q1.toLocaleString()}</strong></span>
                              <span className="text-blue font-semibold">Median: <strong className="text-label">{sumStats.median.toLocaleString()}</strong></span>
                              <span className="text-blue font-semibold">Q3 (75%): <strong className="text-label">{sumStats.q3.toLocaleString()}</strong></span>
                              <span className="text-label-2">Max: <strong className="text-label">{max.toLocaleString()}</strong></span>
                            </div>
                          </div>
                        );
                      })()}
                    </div>

                  </div>
                </div>
              )}
            </div>
          </div>
        )}

        {/* 7. CATEGORICAL DISTRIBUTIONS WORKSPACE */}
        {activeSubTab === 'categorical' && (
          <div className="space-y-6 animate-fade-in text-xs">
            <div className="bg-surface border border-separator p-5 rounded-xl shadow-sm space-y-4">
              
              <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4 pb-2 border-b border-separator">
                <div>
                  <h4 className="text-label text-sm font-semibold flex items-center gap-2">
                    <Layers className="w-4.5 h-4.5 text-blue" /> Category counts
                  </h4>
                  <p className="text-label-2 mt-1">
                    Select a text or category coordinate to compile unique label frequencies, observation occurrences, and probability weights.
                  </p>
                </div>

                <div className="flex items-center gap-2.5">
                  <span className="tabular-nums text-label-3 font-medium">Category variable:</span>
                  <select
                    value={selectedCatCol}
                    onChange={(e) => setSelectedCatCol(e.target.value)}
                    className="bg-surface border border-separator-strong text-label px-3 py-1.5 rounded-xl text-xs tabular-nums focus:outline-none focus:border-blue transition-colors cursor-pointer"
                  >
                    {categoricalColsObj.map(c => (
                      <option key={c.name} value={c.name}>{c.name}</option>
                    ))}
                  </select>
                </div>
              </div>

              {!selectedCatCol ? (
                <div className="text-center p-8 text-xs text-label-3 border border-dashed border-separator rounded-xl">
                  No categorical columns identified in the active workbook parameters. Add columns containing text labels.
                </div>
              ) : (
                <div className="space-y-4">
                  <div className="bg-well p-4 border border-separator rounded-xl space-y-1 mb-2 tabular-nums flex justify-between text-xs text-label-2">
                    <span>Selected Category: <strong className="text-label">{selectedCatCol}</strong></span>
                    <span>Analyzed Unique States: <strong className="text-blue">{activeCatDistribution.length} distinct levels</strong></span>
                  </div>

                  <div className="space-y-4 bg-well p-5 rounded-xl border border-separator">
                    {activeCatDistribution.slice(0, 15).map((item, idx) => (
                      <div key={idx} className="space-y-2">
                        <div className="flex justify-between items-center text-xs tabular-nums">
                          <span className="text-label font-semibold truncate max-w-[240px]">
                            {item.value === 'null' || item.value === '' ? (
                              <em className="text-label-3">[Empty Field Value]</em>
                            ) : item.value}
                          </span>
                          <span className="text-label-2 text-xs">
                            {item.count.toLocaleString()} occurrences <span className="text-label-3 mr-1">|</span> <strong className="text-blue font-semibold">{item.percent}%</strong>
                          </span>
                        </div>
                        <div className="w-full h-2.5 bg-surface rounded-full overflow-hidden border border-separator relative">
                          <div
                            className="bg-gradient-to-r from-blue to-blue h-full rounded-full transition-all duration-500"
                            style={{ width: `${item.percent}%` }}
                          />
                        </div>
                      </div>
                    ))}
                    {activeCatDistribution.length > 15 && (
                      <p className="text-[11px] text-label-3 text-center tabular-nums pt-3 border-t border-separator">
                        ... list truncated. Showing top 15 highest-frequency discrete unique levels.
                      </p>
                    )}
                  </div>
                </div>
              )}
            </div>
          </div>
        )}

        {/* 10. SQL ASSISTANT */}
        {activeSubTab === 'sql' && (
          <SQLAssistant dataset={dataset} onUseResult={onUseQueryResult} />
        )}

        {/* 11. DEEP EDA — REAL SERVER-SIDE PANDAS/NUMPY COMPUTATION */}
        {activeSubTab === 'deepeda' && (
          <div className="space-y-6 animate-fade-in">
            {!deepEdaResult && (
              <div className="relative bg-surface text-label p-6 sm:p-8 rounded-2xl border border-blue/20 shadow-sm flex flex-col md:flex-row justify-between items-start md:items-center gap-6 overflow-hidden">
                <div className="relative z-10 space-y-2.5">
                  <span className="text-[11px] tabular-nums font-medium text-blue bg-blue/15 px-3 py-1 rounded-full border border-blue/25">
                    REAL SERVER-SIDE ANALYSIS
                  </span>
                  <h3 className="text-base sm:text-lg font-semibold tracking-tight flex items-center gap-2 mt-1">
                    <Database className="w-5 h-5 text-blue" /> Deep analysis (Python / pandas)
                  </h3>
                  <p className="text-xs text-label max-w-xl leading-relaxed">
                    Runs genuine pandas/numpy computation on your dataset — skewness, IQR outliers, Pearson correlation, and a missing-value report — then asks Gemini to narrate strictly those exact numbers, nothing invented.
                  </p>
                </div>
                <button
                  onClick={runDeepEda}
                  disabled={loadingDeepEda}
                  aria-busy={loadingDeepEda}
                  className="relative z-10 bg-blue hover:bg-blue text-white font-semibold text-xs py-3 px-6 rounded-xl flex items-center justify-center gap-2.5 transition-all duration-300 shadow-sm border-0 cursor-pointer disabled:opacity-75 disabled:cursor-not-allowed shrink-0"
                >
                  {loadingDeepEda ? (
                    <>
                      <Orb state="working" onAccent label="Computing statistics" />
                      Computing Real Stats...
                    </>
                  ) : (
                    <>
                      <Database className="w-4.5 h-4.5 text-label" />
                      Run Real Deep EDA
                    </>
                  )}
                </button>
              </div>
            )}

            {deepEdaError && (
              <div className="p-4 bg-red/10 border border-red/20 text-red rounded-xl text-xs flex items-start gap-3">
                <AlertTriangle className="w-4 h-4 text-red shrink-0 mt-0.5" />
                <p>{deepEdaError}</p>
              </div>
            )}

            {deepEdaResult && (
              <div className="space-y-6">
                <div className="flex items-center justify-between">
                  <span className="text-[11px] tabular-nums text-label-3">
                    {deepEdaResult.rowCount.toLocaleString()} rows × {deepEdaResult.columnCount} columns scanned
                  </span>
                  <button
                    onClick={runDeepEda}
                    disabled={loadingDeepEda}
                    className="text-[11px] tabular-nums text-blue hover:text-blue disabled:opacity-50 cursor-pointer"
                  >
                    {loadingDeepEda ? 'Re-running…' : 'Re-run scan'}
                  </button>
                </div>

                {/* Narrative panel — real numbers, AI (or template) narrated */}
                {deepEdaResult.narrative && (
                  <div className="bg-gradient-to-r from-surface to-blue/40 rounded-2xl border border-blue/15 p-5 sm:p-6 shadow-sm">
                    <span className="text-[11px] tabular-nums font-medium text-blue bg-blue/10 px-2 py-0.5 rounded border border-blue/20">
                      Real Numbers, AI-Narrated
                    </span>
                    <p className="text-xs text-label leading-relaxed bg-well p-4 rounded-xl border border-separator mt-3">
                      {deepEdaResult.narrative.summary}
                    </p>

                    {deepEdaResult.narrative.dataQualityFlags.length > 0 && (
                      <div className="mt-4 space-y-1.5">
                        <span className="text-[11px] tabular-nums font-medium text-orange">Data Quality Flags</span>
                        {deepEdaResult.narrative.dataQualityFlags.map((f, i) => (
                          <div key={i} className="text-xs bg-well p-2 rounded border border-separator flex items-center gap-2">
                            <span className={`px-1.5 py-0.5 rounded text-[11px] font-medium shrink-0 ${f.severity === 'High' ? 'bg-red/15 text-red' : f.severity === 'Medium' ? 'bg-orange/15 text-orange' : 'bg-fill text-label-2'}`}>{f.severity}</span>
                            <strong className="text-label">{f.column}:</strong>
                            <span className="text-label-2">{f.issue}</span>
                          </div>
                        ))}
                      </div>
                    )}

                    {deepEdaResult.narrative.recommendedNextSteps.length > 0 && (
                      <div className="mt-4">
                        <span className="text-[11px] tabular-nums font-medium text-green">Recommended Next Steps</span>
                        <ul className="mt-1.5 space-y-1">
                          {deepEdaResult.narrative.recommendedNextSteps.map((s, i) => (
                            <li key={i} className="text-xs text-label flex items-start gap-1.5">
                              <Dot className="w-3.5 h-3.5 text-blue shrink-0 -mt-0.5" />{s}
                            </li>
                          ))}
                        </ul>
                      </div>
                    )}
                  </div>
                )}

                {/* Real per-column distribution stats including skew */}
                <div className="bg-surface border border-separator rounded-2xl p-6">
                  <h4 className="text-xs font-medium text-label tabular-nums mb-3">Distribution statistics</h4>
                  <div className="overflow-x-auto">
                    <table className="w-full text-left text-xs tabular-nums border-collapse">
                      <thead>
                        <tr className="border-b border-separator text-label-2 text-[11px]">
                          <th className="py-2 pr-3">Column</th>
                          <th className="py-2 pr-3">Mean</th>
                          <th className="py-2 pr-3">Median</th>
                          <th className="py-2 pr-3">Std</th>
                          <th className="py-2 pr-3">Skew</th>
                          <th className="py-2 pr-3">Min</th>
                          <th className="py-2 pr-3">Max</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-separator">
                        {deepEdaResult.numericSummaries.map((s, i) => (
                          <tr key={i}>
                            <td className="py-2 pr-3 text-label font-semibold">{s.column}</td>
                            <td className="py-2 pr-3 text-label">{s.mean}</td>
                            <td className="py-2 pr-3 text-label">{s.median}</td>
                            <td className="py-2 pr-3 text-label">{s.std}</td>
                            <td className={`py-2 pr-3 font-semibold ${Math.abs(s.skew) > 1 ? 'text-orange' : 'text-green'}`} title="Fisher-Pearson skewness: 0 = symmetric">{s.skew}</td>
                            <td className="py-2 pr-3 text-label-3">{s.min}</td>
                            <td className="py-2 pr-3 text-label-3">{s.max}</td>
                          </tr>
                        ))}
                        {deepEdaResult.numericSummaries.length === 0 && (
                          <tr><td colSpan={7} className="py-3 text-center text-label-3">No numeric columns to summarize.</td></tr>
                        )}
                      </tbody>
                    </table>
                  </div>
                </div>

                {/* Real outliers + missing report side by side */}
                <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
                  <div className="bg-surface border border-separator rounded-2xl p-6">
                    <h4 className="text-xs font-medium text-label tabular-nums mb-3">Outlier counts (IQR)</h4>
                    <div className="space-y-1.5">
                      {deepEdaResult.outliers.map((o, i) => (
                        <div key={i} className="flex justify-between items-center text-xs bg-well p-2 rounded border border-separator">
                          <span className="text-label tabular-nums">{o.column}</span>
                          <span className={`tabular-nums font-semibold ${o.outlierCount > 0 ? 'text-orange' : 'text-green'}`}>{o.outlierCount} ({o.outlierPercent}%)</span>
                        </div>
                      ))}
                      {deepEdaResult.outliers.length === 0 && (
                        <p className="text-xs text-label-3">No numeric columns to check for outliers.</p>
                      )}
                    </div>
                  </div>
                  <div className="bg-surface border border-separator rounded-2xl p-6">
                    <h4 className="text-xs font-medium text-label tabular-nums mb-3">Missing values</h4>
                    <div className="space-y-1.5">
                      {deepEdaResult.missingReport.filter(m => m.missingCount > 0).map((m, i) => (
                        <div key={i} className="flex justify-between items-center text-xs bg-well p-2 rounded border border-separator">
                          <span className="text-label tabular-nums">{m.column}</span>
                          <span className="tabular-nums font-semibold text-orange">{m.missingCount} ({m.missingPercent}%)</span>
                        </div>
                      ))}
                      {deepEdaResult.missingReport.every(m => m.missingCount === 0) && (
                        <p className="text-xs text-green">No missing values detected in any column.</p>
                      )}
                    </div>
                  </div>
                </div>

                {/* Real Pearson correlation matrix */}
                {deepEdaResult.correlation && deepEdaResult.correlation.columns.length >= 2 && (
                  <div className="bg-surface border border-separator rounded-2xl p-6">
                    <h4 className="text-xs font-medium text-label tabular-nums mb-3">Correlation matrix (Pearson)</h4>
                    <div className="overflow-x-auto">
                      <table className="text-[11px] tabular-nums border-collapse">
                        <thead>
                          <tr>
                            <th className="p-1.5 text-label-3"></th>
                            {deepEdaResult.correlation.columns.map(c => (
                              <th key={c} className="p-1.5 text-label-2 font-semibold whitespace-nowrap">{c}</th>
                            ))}
                          </tr>
                        </thead>
                        <tbody>
                          {deepEdaResult.correlation.matrix.map((row, rIdx) => (
                            <tr key={rIdx}>
                              <td className="p-1.5 text-label-2 font-semibold whitespace-nowrap">{deepEdaResult.correlation!.columns[rIdx]}</td>
                              {row.map((val, cIdx) => {
                                const v = val ?? 0;
                                const intensity = Math.min(1, Math.abs(v));
                                const bg = rIdx === cIdx
                                  ? 'var(--fill)'
                                  : `color-mix(in srgb, var(${v > 0 ? '--chart-1' : '--chart-5'}) ${Math.round(intensity * 60)}%, transparent)`;
                                return (
                                  <td key={cIdx} className="p-1.5 text-center text-label" style={{ background: bg }}>
                                    {val === null ? '—' : val.toFixed(2)}
                                  </td>
                                );
                              })}
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </div>
                )}
              </div>
            )}
          </div>
        )}

      </div>
    </div>
  );
}

/**
 * Highly interactive Scatter plot sub-component with SVG
 */
interface FeatureRelationshipScatterProps {
  dataset: Dataset;
  numericCols: string[];
}
function FeatureRelationshipScatter({ dataset, numericCols }: FeatureRelationshipScatterProps) {
  const [colX, setColX] = useState<string>(numericCols[0] || '');
  const [colY, setColY] = useState<string>(numericCols[1] || numericCols[0] || '');

  const allDataPoints = colX && colY
    ? dataset.rows.map((row, idx) => ({
        x: Number(row[colX]),
        y: Number(row[colY]),
        idx: idx + 1
      })).filter(pt => !isNaN(pt.x) && !isNaN(pt.y))
    : [];

  // Limit to 1500 points for browser rendering performance to prevent call stack issues / crashes
  const STEP = Math.max(1, Math.floor(allDataPoints.length / 1500));
  const dataPoints = allDataPoints.filter((_, i) => i % STEP === 0);

  const minX = dataPoints.length > 0 ? dataPoints.reduce((min, p) => (p.x < min ? p.x : min), dataPoints[0].x) : 0;
  const maxX = dataPoints.length > 0 ? dataPoints.reduce((max, p) => (p.x > max ? p.x : max), dataPoints[0].x) : 100;
  const minY = dataPoints.length > 0 ? dataPoints.reduce((min, p) => (p.y < min ? p.y : min), dataPoints[0].y) : 0;
  const maxY = dataPoints.length > 0 ? dataPoints.reduce((max, p) => (p.y > max ? p.y : max), dataPoints[0].y) : 100;

  const rangeX = maxX - minX || 1;
  const rangeY = maxY - minY || 1;

  // Margin spacing inside SVG coordinate systems
  const margin = 40;
  const svgWidth = 600;
  const svgHeight = 350;

  // Grid line levels
  const xGridTicks = 5;
  const yGridTicks = 4;

  return (
    <div className="bg-well p-5 border border-separator rounded-xl space-y-4">
      <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-3">
        <div>
          <span className="text-[11px] tabular-nums font-medium text-blue bg-blue/15 border border-blue/25 px-2.5 py-1 rounded">
            FEATURE CORATION MATRIX DIAGNOSTIC
          </span>
          <h5 className="font-semibold text-label text-sm mt-1.5 flex items-center gap-1.5">
            <Sparkles className="w-4 h-4 text-blue" /> Relationship between two columns
          </h5>
        </div>

        {/* Dropdown axis control pairs */}
        <div className="flex gap-2 text-xs tabular-nums">
          <div className="flex items-center gap-1.5">
            <span className="text-label-3">X-Axis:</span>
            <select
              value={colX}
              onChange={(e) => setColX(e.target.value)}
              className="bg-surface border border-separator-strong text-label py-1 px-2 rounded-lg"
            >
              {numericCols.map(f => (
                <option key={f} value={f}>{f}</option>
              ))}
            </select>
          </div>
          <div className="flex items-center gap-1.5">
            <span className="text-label-3">Y-Axis:</span>
            <select
              value={colY}
              onChange={(e) => setColY(e.target.value)}
              className="bg-surface border border-separator-strong text-label py-1 px-2 rounded-lg"
            >
              {numericCols.map(f => (
                <option key={f} value={f}>{f}</option>
              ))}
            </select>
          </div>
        </div>
      </div>

      <div className="overflow-x-auto w-full select-none">
        <div className="min-w-[550px] flex justify-center bg-well rounded-lg p-3 relative h-[380px]">
          <svg
            width="100%"
            height="100%"
            viewBox={`0 0 ${svgWidth} ${svgHeight}`}
            className="text-label-3 tabular-nums text-[11px] max-w-2xl"
          >
            {/* Draw Y Axis Grid lines */}
            {Array.from({ length: yGridTicks }).map((_, i) => {
              const fraction = i / (yGridTicks - 1);
              const yVal = minY + fraction * rangeY;
              const yCoord = svgHeight - margin - fraction * (svgHeight - 2 * margin);
              return (
                <g key={i}>
                  <line
                    x1={margin}
                    y1={yCoord}
                    x2={svgWidth - margin}
                    y2={yCoord}
                    stroke="var(--chart-grid)"
                    strokeDasharray="3,3"
                  />
                  <text x={margin - 8} y={yCoord + 3} textAnchor="end" fill="var(--chart-axis)">
                    {yVal.toFixed(1)}
                  </text>
                </g>
              );
            })}

            {/* Draw X Axis Grid lines */}
            {Array.from({ length: xGridTicks }).map((_, i) => {
              const fraction = i / (xGridTicks - 1);
              const xVal = minX + fraction * rangeX;
              const xCoord = margin + fraction * (svgWidth - 2 * margin);
              return (
                <g key={i}>
                  <line
                    x1={xCoord}
                    y1={margin}
                    x2={xCoord}
                    y2={svgHeight - margin}
                    stroke="var(--chart-grid)"
                    strokeDasharray="3,3"
                  />
                  <text x={xCoord} y={svgHeight - margin + 14} textAnchor="middle" fill="var(--chart-axis)">
                    {xVal.toFixed(1)}
                  </text>
                </g>
              );
            })}

            {/* Draw Scatter Dots */}
            {dataPoints.map((pt, i) => {
              const cx = margin + ((pt.x - minX) / rangeX) * (svgWidth - 2 * margin);
              const cy = svgHeight - margin - ((pt.y - minY) / rangeY) * (svgHeight - 2 * margin);
              return (
                <g key={i} className="group cursor-help">
                  <circle
                    cx={cx}
                    cy={cy}
                    r={5.5}
                    className="fill-blue stroke-teal hover:fill-teal hover:r-8 transition-all hover:stroke-white duration-150"
                  />
                  {/* Tooltip on dot hover inside SVG */}
                  <title>
                    {`Observation Row ${pt.idx}:\n[X] ${colX} = ${pt.x}\n[Y] ${colY} = ${pt.y}`}
                  </title>
                </g>
              );
            })}

            {/* Axis labels */}
            <text x={svgWidth / 2} y={svgHeight - 4} textAnchor="middle" className="fill-label-2 font-semibold tabular-nums">
              X Variable: {colX}
            </text>
            <text
              x={margin}
              y={margin - 12}
              textAnchor="start"
              className="fill-label-2 font-semibold tabular-nums"
            >
              Y Variable: {colY}
            </text>
          </svg>
        </div>
      </div>
    </div>
  );
}
