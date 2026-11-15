/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState, useRef } from 'react';
import { Upload, FileSpreadsheet, AlertTriangle, Sparkles, ArrowRight, ChevronRight, Users, TrendingUp, Activity, Loader2, type LucideIcon } from 'lucide-react';
import { Dataset } from '../types';
import { parseCSV, loadSampleDataset } from '../utils/csvParser';
import PipelineBuilder from './PipelineBuilder';
import { usePipelineContext } from '../contexts/PipelineContext';

interface DataUploaderProps {
  onDatasetLoaded: (dataset: Dataset) => void;
  currentDataset: Dataset | null;
  onProceed: () => void;
}

const SAMPLES: { key: 'churn' | 'saas' | 'hardware'; match: string; title: string; description: string; icon: LucideIcon; tint: string }[] = [
  {
    key: 'churn',
    match: 'churn',
    title: 'Customer churn',
    description: 'Telecom subscribers with contracts, tenure and charges. Predict who is likely to leave.',
    icon: Users,
    tint: 'bg-blue/12 text-blue',
  },
  {
    key: 'saas',
    match: 'saas',
    title: 'SaaS performance',
    description: 'Recurring revenue, daily usage, support tickets and success ratings by customer segment.',
    icon: TrendingUp,
    tint: 'bg-purple/12 text-purple',
  },
  {
    key: 'hardware',
    match: 'hardware',
    title: 'Machine maintenance',
    description: 'Sensor readings for temperature, vibration and uptime. Predict equipment failure.',
    icon: Activity,
    tint: 'bg-orange/12 text-orange',
  },
];

const TYPE_TAG: Record<string, string> = {
  numeric: 'bg-blue/12 text-blue',
  datetime: 'bg-purple/12 text-purple',
  boolean: 'bg-green/12 text-green',
};

export default function DataUploader({ onDatasetLoaded, currentDataset, onProceed }: DataUploaderProps) {
  const [errorLine, setErrorLine] = useState<string | null>(null);
  const [isDragging, setIsDragging] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  
  const { 
    expertMode,
    setDatasetProfile, 
    businessProblem, 
    setBusinessProblem, 
    pipelineIntelligence, 
    setPipelineIntelligence 
  } = usePipelineContext();
  
  const [problemInput, setProblemInput] = useState('');
  const [isGeneratingIntel, setIsGeneratingIntel] = useState(false);
  const [intelError, setIntelError] = useState<string | null>(null);

  const fetchPipelineIntelligence = async (dataset: Dataset, problem: string) => {
    setIsGeneratingIntel(true);
    setIntelError(null);
    setBusinessProblem(problem); // Store it globally immediately
    const profile = {
      filename: dataset.filename,
      rowCount: dataset.rowCount,
      columns: dataset.columns.map(c => ({
        name: c.name, type: c.type, missingCount: c.missingCount, distinctCount: c.distinctCount
      }))
    };
    setDatasetProfile(profile);

    try {
      const response = await fetch('/api/pipeline-intelligence', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ datasetProfile: profile, businessProblem: problem })
      });
      if (!response.ok) {
        throw new Error(`Server responded with ${response.status}`);
      }
      const data = await response.json();
      setPipelineIntelligence(data);
    } catch (err: any) {
      console.error('Failed to fetch intelligence', err);
      setIntelError(err.message || 'Could not analyze this dataset. Check that the backend server is running and try again.');
    } finally {
      setIsGeneratingIntel(false);
    }
  };

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) {
      processFile(file);
    }
  };

  const processFile = (file: File) => {
    setErrorLine(null);
    if (!file.name.endsWith('.csv') && !file.name.endsWith('.txt')) {
      setErrorLine('Only standard CSV or delimited TXT files are supported directly in the browser. Try loading a sample dataset below!');
      return;
    }

    const reader = new FileReader();
    reader.onload = (e) => {
      try {
        const text = e.target?.result as string;
        const parsed = parseCSV(text, file.name);
        onDatasetLoaded(parsed);
        // Automatically fetch intel using the current problem input
        fetchPipelineIntelligence(parsed, problemInput);
      } catch (err: any) {
        setErrorLine(err.message || 'Error occurred while parsing the CSV file. Verify columns and formatting.');
      }
    };
    reader.onerror = () => {
      setErrorLine('File read failed. Try again or check details.');
    };
    reader.readAsText(file);
  };

  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(true);
  };

  const handleDragLeave = () => {
    setIsDragging(false);
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(false);
    const file = e.dataTransfer.files?.[0];
    if (file) {
      processFile(file);
    }
  };

  const loadSample = (key: 'churn' | 'saas' | 'hardware') => {
    setErrorLine(null);
    try {
      const parsed = loadSampleDataset(key);
      onDatasetLoaded(parsed);
      fetchPipelineIntelligence(parsed, problemInput);
    } catch (err: any) {
      setErrorLine('Failed to load sample dataset: ' + err.message);
    }
  };

  const handleSetContext = () => {
    if (currentDataset) {
      fetchPipelineIntelligence(currentDataset, problemInput);
    }
  };

  const numericCount = currentDataset?.columns.filter(c => c.type === 'numeric').length ?? 0;
  const missingCells = currentDataset?.columns.reduce((sum, c) => sum + c.missingCount, 0) ?? 0;

  const dropZone = (compact: boolean) => (
    <div
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
      onClick={() => fileInputRef.current?.click()}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          fileInputRef.current?.click();
        }
      }}
      role="button"
      tabIndex={0}
      aria-label="Upload a CSV file"
      className={`flex-1 rounded-2xl border-2 border-dashed text-center flex flex-col items-center justify-center ${
        compact ? 'px-6 py-8' : 'px-6 py-14 sm:py-20'
      } ${isDragging ? 'border-blue bg-blue/8' : 'border-separator-strong hover:border-blue hover:bg-blue/5'}`}
      id="file_drop_zone"
    >
      <input type="file" ref={fileInputRef} onChange={handleFileChange} accept=".csv,.txt" className="hidden" />
      <div className="w-14 h-14 rounded-full bg-blue/12 text-blue flex items-center justify-center">
        <Upload className="w-6 h-6" />
      </div>
      <p className="mt-4 text-xl font-semibold tracking-tight text-label">
        {isDragging ? 'Drop to import' : 'Drop a CSV file here'}
      </p>
      <p className="mt-1 text-sm text-label-2">or</p>
      <span className="btn btn-primary mt-3">Choose File</span>
      <p className="mt-4 text-xs text-label-3">Comma-separated .csv or .txt with a header row</p>
    </div>
  );

  return (
    <div className="space-y-10" id="uploader_module">
      {/* Loaded dataset summary — the first thing you see once data is in. */}
      {currentDataset && (
        <section className="card p-5 sm:p-6 animate-fade-in" aria-label="Current dataset">
          <div className="flex flex-col sm:flex-row sm:items-center gap-4">
            <div className="flex items-center gap-4 min-w-0 flex-1">
              <div className="w-12 h-12 rounded-xl bg-green/12 text-green flex items-center justify-center shrink-0">
                <FileSpreadsheet className="w-6 h-6" />
              </div>
              <div className="min-w-0">
                <h2 className="text-lg font-semibold tracking-tight text-label truncate">{currentDataset.filename}</h2>
                <p className="text-sm text-label-2">Imported and ready to clean</p>
              </div>
            </div>
            <button type="button" onClick={onProceed} className="btn btn-primary btn-lg shrink-0">
              Continue to Clean <ArrowRight className="w-4 h-4" />
            </button>
          </div>

          <dl className="mt-6 grid grid-cols-2 lg:grid-cols-4 gap-px bg-separator rounded-xl overflow-hidden">
            {[
              ['Rows', currentDataset.rowCount.toLocaleString()],
              ['Columns', currentDataset.columns.length.toLocaleString()],
              ['Numeric columns', numericCount.toLocaleString()],
              ['Missing values', missingCells.toLocaleString()],
            ].map(([label, value]) => (
              <div key={label} className="bg-surface px-4 py-3">
                <dt className="text-xs text-label-2">{label}</dt>
                <dd className="mt-0.5 text-2xl font-semibold tracking-tight tabular-nums text-label">{value}</dd>
              </div>
            ))}
          </dl>
        </section>
      )}

      {/* AI recommendation for this dataset + goal. */}
      {currentDataset && (isGeneratingIntel || pipelineIntelligence) && (
        <section className="card p-5 sm:p-6 animate-fade-in" aria-label="Recommended approach">
          <div className="flex items-center gap-2">
            <Sparkles className="w-[18px] h-[18px] text-blue" />
            <h2 className="text-lg font-semibold tracking-tight text-label">Recommended approach</h2>
          </div>

          {isGeneratingIntel ? (
            <p className="mt-4 flex items-center gap-2 text-sm text-label-2">
              <Loader2 className="w-4 h-4 animate-spin" /> Analyzing your dataset…
            </p>
          ) : pipelineIntelligence && (
            <dl className="mt-4 grid grid-cols-1 sm:grid-cols-3 gap-x-8 gap-y-5 text-sm">
              <div>
                <dt className="text-xs text-label-2">Domain</dt>
                <dd className="mt-0.5 text-label">{pipelineIntelligence.detectedDomain}</dd>
              </div>
              <div>
                <dt className="text-xs text-label-2">{businessProblem ? 'Your goal' : 'Suggested goal'}</dt>
                <dd className="mt-0.5 text-label">{pipelineIntelligence.inferredProblem}</dd>
              </div>
              <div>
                <dt className="text-xs text-label-2">Column to predict</dt>
                <dd className="mt-1">
                  <span className="tag bg-blue/12 text-blue">{pipelineIntelligence.recommendedTarget}</span>
                </dd>
              </div>
              <div className="sm:col-span-3">
                <dt className="text-xs text-label-2">Strategy</dt>
                <dd className="mt-0.5 text-label leading-relaxed max-w-4xl">{pipelineIntelligence.pipelineStrategy}</dd>
              </div>
            </dl>
          )}
        </section>
      )}

      {/* Goal — optional, and editable at any time. */}
      <section aria-labelledby="goal-heading">
        <h2 id="goal-heading" className="text-xl font-semibold tracking-tight text-label">
          What do you want to find out? <span className="font-normal text-label-3">Optional</span>
        </h2>
        <p className="mt-1 text-sm text-label-2">
          A goal helps the AI suggest what to predict and how to approach your data.
        </p>
        <form
          className="mt-4 flex flex-col sm:flex-row gap-3"
          onSubmit={(e) => {
            e.preventDefault();
            handleSetContext();
          }}
        >
          <input
            type="text"
            value={problemInput}
            onChange={(e) => setProblemInput(e.target.value)}
            placeholder="For example: predict which customers are likely to churn"
            aria-labelledby="goal-heading"
            className="field flex-1"
          />
          {currentDataset && (
            <button type="submit" disabled={isGeneratingIntel} className="btn btn-secondary btn-lg shrink-0">
              {isGeneratingIntel ? (
                <>
                  <Loader2 className="w-4 h-4 animate-spin" /> Analyzing…
                </>
              ) : (
                'Update Recommendation'
              )}
            </button>
          )}
        </form>
        {intelError && (
          <p role="alert" className="mt-3 flex items-start gap-2 text-sm text-red">
            <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" />
            {intelError}
          </p>
        )}
      </section>

      {/* Data source */}
      <section aria-labelledby="source-heading">
        <h2 id="source-heading" className="text-xl font-semibold tracking-tight text-label">
          {currentDataset ? 'Use a different dataset' : 'Add your data'}
        </h2>
        <p className="mt-1 text-sm text-label-2">
          {expertMode
            ? 'Upload a file or connect a database. Your data stays in this session.'
            : 'Upload a file from your computer. Your data stays in this session.'}
        </p>

        <div className={`mt-4 grid grid-cols-1 gap-5 ${expertMode ? 'lg:grid-cols-2' : ''}`}>
          <div className="card p-3 flex flex-col">{dropZone(!!currentDataset)}</div>

          {expertMode && (
            <div className="animate-fade-in">
              <PipelineBuilder onDatasetLoaded={(dataset) => {
                onDatasetLoaded(dataset);
                fetchPipelineIntelligence(dataset, problemInput);
              }} />
            </div>
          )}
        </div>

        {errorLine && (
          <div role="alert" className="mt-4 flex items-start gap-3 rounded-2xl bg-red/10 px-4 py-3 text-sm animate-fade-in">
            <AlertTriangle className="w-[18px] h-[18px] text-red shrink-0 mt-0.5" />
            <div>
              <p className="font-semibold text-label">This file couldn’t be imported</p>
              <p className="mt-0.5 text-label-2">{errorLine}</p>
            </div>
          </div>
        )}
      </section>

      {/* Samples */}
      <section aria-labelledby="samples-heading">
        <h2 id="samples-heading" className="text-xl font-semibold tracking-tight text-label">
          {currentDataset ? 'Or switch to a sample' : 'Or start with a sample'}
        </h2>
        <p className="mt-1 text-sm text-label-2">Ready-made datasets for trying the full workflow.</p>

        <div className="mt-4 grid grid-cols-1 md:grid-cols-3 gap-4">
          {SAMPLES.map(({ key, match, title, description, icon: Icon, tint }) => {
            const isActive = !!currentDataset?.filename.includes(match);
            return (
              <button
                key={key}
                type="button"
                onClick={() => loadSample(key)}
                aria-pressed={isActive}
                className={`card group text-left p-5 flex items-start gap-4 hover:shadow-md ${
                  isActive ? 'ring-2 ring-blue' : ''
                }`}
              >
                <span className={`w-11 h-11 rounded-xl flex items-center justify-center shrink-0 ${tint}`}>
                  <Icon className="w-5 h-5" />
                </span>
                <span className="flex-1 min-w-0">
                  <span className="flex items-center gap-2">
                    <span className="text-base font-semibold tracking-tight text-label">{title}</span>
                    {isActive && <span className="tag bg-blue/12 text-blue">In use</span>}
                  </span>
                  <span className="mt-1 block text-sm text-label-2 leading-snug">{description}</span>
                </span>
                <ChevronRight className="w-4 h-4 text-label-3 shrink-0 mt-1 group-hover:text-label-2" />
              </button>
            );
          })}
        </div>
      </section>

      {/* Columns */}
      {currentDataset && (
        <section aria-labelledby="columns-heading" className="animate-fade-in">
          <h2 id="columns-heading" className="text-xl font-semibold tracking-tight text-label">Columns</h2>
          <p className="mt-1 text-sm text-label-2">
            {currentDataset.columns.length} columns detected in {currentDataset.filename}.
          </p>

          <div className="card mt-4 overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead>
                <tr className="border-b border-separator text-xs">
                  <th className="px-5 py-3">Name</th>
                  <th className="px-5 py-3">Type</th>
                  <th className="px-5 py-3 text-right">Distinct</th>
                  <th className="px-5 py-3 text-right">Missing</th>
                  <th className="px-5 py-3">Summary</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-separator">
                {currentDataset.columns.map((col) => {
                  const missingRate = ((col.missingCount / currentDataset.rowCount) * 100).toFixed(1);
                  return (
                    <tr key={col.name}>
                      <td className="px-5 py-3 font-medium text-label">{col.name}</td>
                      <td className="px-5 py-3">
                        <span className={`tag capitalize ${TYPE_TAG[col.type] ?? ''}`}>{col.type}</span>
                      </td>
                      <td className="px-5 py-3 text-right text-label-2">{col.distinctCount.toLocaleString()}</td>
                      <td className={`px-5 py-3 text-right ${col.missingCount > 0 ? 'text-red font-medium' : 'text-label-3'}`}>
                        {col.missingCount > 0 ? `${col.missingCount.toLocaleString()} (${missingRate}%)` : 'None'}
                      </td>
                      <td className="px-5 py-3 text-label-2 max-w-sm truncate">
                        {col.type === 'numeric' ? (
                          <>
                            Mean <span className="text-label">{col.statistics.mean}</span>
                            <span className="text-label-3"> · </span>
                            Range {col.statistics.min} – {col.statistics.max}
                          </>
                        ) : col.statistics.mostCommon?.[0] ? (
                          <>
                            Most common <span className="text-label">{String(col.statistics.mostCommon[0].value)}</span>
                            <span className="text-label-3"> · </span>
                            {col.statistics.mostCommon[0].count}×
                          </>
                        ) : (
                          '—'
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </section>
      )}
    </div>
  );
}
