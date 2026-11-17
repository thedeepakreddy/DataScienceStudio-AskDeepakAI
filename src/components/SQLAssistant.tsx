/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useEffect, useState } from 'react';
import { AlertCircle, Copy, CheckCircle, Database, Play, Sparkles, Table as TableIcon } from 'lucide-react';
import { Dataset } from '../types';
import { apiFetch } from '../utils/api';
import { SqlError, SqlResult, runReadOnlySql } from '../utils/safeSql';
import { datasetFromRecords } from '../utils/csvParser';
import { listRuns } from '../utils/workspaceStore';
import { useLogRun } from '../contexts/WorkspaceContext';
import Orb from './Orb';

interface SQLAssistantProps {
  dataset: Dataset;
  /** Makes a query result the working data (saved as a new version). */
  onUseResult?: (dataset: Dataset, summary: string) => void;
}

/**
 * Read-only SQL over the active dataset, run in the browser. Write SQL, or ask
 * in plain English and have AI write it; either way the same safety checks
 * apply before anything runs.
 */
export default function SQLAssistant({ dataset, onUseResult }: SQLAssistantProps) {
  const logRun = useLogRun();
  const [sql, setSql] = useState('SELECT *\nFROM dataset\nLIMIT 20');
  const [question, setQuestion] = useState('');
  const [aiLoading, setAiLoading] = useState(false);
  const [explanation, setExplanation] = useState<string | null>(null);
  const [aiError, setAiError] = useState<string | null>(null);
  const [result, setResult] = useState<SqlResult | null>(null);
  const [ranSql, setRanSql] = useState('');
  const [sqlError, setSqlError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [recent, setRecent] = useState<string[]>([]);

  const refreshRecent = () => {
    listRuns(200)
      .then(runs => {
        const seen = new Set<string>();
        setRecent(runs
          .filter(r => r.kind === 'sql-query' && r.status === 'succeeded')
          .map(r => String((r.params as { sql?: string })?.sql ?? ''))
          .filter(q => q && !seen.has(q) && seen.add(q))
          .slice(0, 8));
      })
      .catch(() => {});
  };
  useEffect(refreshRecent, []);

  const run = (query = sql) => {
    setSqlError(null);
    try {
      const r = runReadOnlySql(query, dataset.rows);
      setResult(r);
      setRanSql(query);
      logRun({
        kind: 'sql-query',
        title: query.replace(/\s+/g, ' ').slice(0, 80),
        summary: `${r.total.toLocaleString()} row${r.total === 1 ? '' : 's'}`,
        status: 'succeeded',
        params: { sql: query },
      });
      setTimeout(refreshRecent, 100);
    } catch (err) {
      setResult(null);
      const message = err instanceof SqlError ? err.message : String((err as Error)?.message || err);
      setSqlError(message);
    }
  };

  const askAi = async () => {
    if (!question.trim()) return;
    setAiError(null);
    setAiLoading(true);
    try {
      const schema = `Table: dataset\nColumns: ${dataset.columns.map(c => `${c.name} (${c.type})`).join(', ')}`;
      const response = await apiFetch('/api/sql-assistant', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ schema, question }),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok || !data.sql) throw new Error(data.error || 'AI couldn’t write a query for that.');
      setSql(data.sql);
      setExplanation(data.explanation || null);
      run(data.sql);
    } catch (err) {
      setAiError((err as Error).message || 'AI couldn’t write a query for that.');
    } finally {
      setAiLoading(false);
    }
  };

  const useResult = () => {
    if (!result || !onUseResult || result.truncated) return;
    const records = result.rows.map(r => ({ ...r }));
    const next = datasetFromRecords(result.columns, records, `${dataset.filename} (query)`);
    onUseResult(next, `Kept the result of a SQL query (${next.rows.length.toLocaleString()} rows)`);
  };

  const fmt = (v: unknown) => (v === null || v === undefined ? null : typeof v === 'object' ? JSON.stringify(v) : String(v));

  return (
    <div className="bg-surface rounded-2xl border border-separator p-6 sm:p-8 shadow-sm relative overflow-hidden mt-8">
      <div className="flex items-center gap-3 mb-6">
        <div className="w-10 h-10 bg-blue/10 rounded-lg flex items-center justify-center border border-blue/20">
          <Database className="w-5 h-5 text-blue" />
        </div>
        <div>
          <h2 className="text-xl font-semibold text-label tracking-tight">SQL</h2>
          <p className="text-xs text-label-2 mt-1">
            Query your data with SQL; the table is called <code className="font-code">dataset</code>. Queries are read-only and run in your browser.
          </p>
        </div>
      </div>

      <div className="space-y-5">
        <div>
          <label htmlFor="sql-question" className="field-label">Ask in plain English (optional)</label>
          <div className="flex gap-2">
            <input
              id="sql-question"
              type="text"
              value={question}
              onChange={e => setQuestion(e.target.value)}
              onKeyDown={e => e.key === 'Enter' && askAi()}
              className="input flex-1"
              placeholder="e.g. Average monthly charges by contract type"
            />
            <button type="button" onClick={askAi} disabled={aiLoading || !question.trim()} aria-busy={aiLoading} className="btn btn-secondary shrink-0">
              {aiLoading ? <><Orb state="composing" label="Writing SQL" /> Writing…</> : <><Sparkles className="w-4 h-4" /> Write SQL</>}
            </button>
          </div>
          {aiError && <p role="alert" className="mt-1.5 text-xs text-red">{aiError}</p>}
        </div>

        <div>
          <div className="flex items-center justify-between">
            <label htmlFor="sql-editor" className="field-label">Query</label>
            <button
              type="button"
              onClick={() => { navigator.clipboard.writeText(sql); setCopied(true); setTimeout(() => setCopied(false), 1500); }}
              className="btn btn-plain btn-sm -mr-2"
            >
              {copied ? <CheckCircle className="w-3.5 h-3.5 text-green" /> : <Copy className="w-3.5 h-3.5" />} {copied ? 'Copied' : 'Copy'}
            </button>
          </div>
          <textarea
            id="sql-editor"
            value={sql}
            onChange={e => setSql(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); run(); } }}
            spellCheck={false}
            rows={6}
            className="w-full bg-well border border-separator rounded-xl p-3 text-sm font-code text-label focus:outline-none focus:border-blue/50 resize-y"
          />
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <button type="button" onClick={() => run()} className="btn btn-primary"><Play className="w-4 h-4" /> Run</button>
            <span className="text-xs text-label-3">⌘/Ctrl + Enter</span>
          </div>
          {explanation && (
            <p className="mt-3 text-sm text-label-2 leading-relaxed"><span className="font-medium text-label">AI’s explanation: </span>{explanation}</p>
          )}
        </div>

        {recent.length > 0 && (
          <div>
            <p className="field-label">Recent queries</p>
            <div className="flex flex-wrap gap-2">
              {recent.map(q => (
                <button key={q} type="button" onClick={() => setSql(q)} className="tag max-w-[320px] hover:bg-fill-strong" title={q}>
                  <span className="truncate font-code">{q.replace(/\s+/g, ' ')}</span>
                </button>
              ))}
            </div>
          </div>
        )}

        {sqlError && (
          <div role="alert" className="p-3 bg-red/10 text-red rounded-xl text-xs flex items-start gap-2">
            <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" />
            <p className="whitespace-pre-line font-code">{sqlError}</p>
          </div>
        )}

        {result && (
          <div className="bg-well border border-separator rounded-xl overflow-hidden animate-fade-in">
            <div className="bg-surface border-b border-separator px-4 py-3 flex flex-wrap items-center gap-3">
              <TableIcon className="w-4 h-4 text-blue" />
              <h3 className="text-sm font-semibold text-label flex-1">
                {result.truncated
                  ? `First ${result.rows.length.toLocaleString()} of ${result.total.toLocaleString()} rows`
                  : `${result.total.toLocaleString()} row${result.total === 1 ? '' : 's'}`}
              </h3>
              {onUseResult && result.rows.length > 0 && ranSql === sql && (
                <button
                  type="button"
                  onClick={useResult}
                  disabled={result.truncated}
                  className="btn btn-sm btn-secondary"
                  title={result.truncated ? 'Add a LIMIT or filter so the result fits, then try again' : 'Make this result the working data'}
                >
                  Use as Data
                </button>
              )}
            </div>
            {result.rows.length === 0 ? (
              <p className="p-6 text-center text-sm text-label-3">The query returned no rows.</p>
            ) : (
              <div className="overflow-auto max-h-[360px]">
                <table className="w-full text-left border-collapse text-xs tabular-nums">
                  <thead className="sticky top-0 bg-surface">
                    <tr>
                      {result.columns.map(k => (
                        <th key={k} className="py-2 px-3 font-semibold text-label border-b border-separator whitespace-nowrap">{k}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-separator">
                    {result.rows.map((row, i) => (
                      <tr key={i}>
                        {result.columns.map(k => {
                          const v = fmt(row[k]);
                          return (
                            <td key={k} className="py-1.5 px-3 text-label-2 whitespace-nowrap max-w-[240px] truncate">
                              {v === null ? <span className="text-label-3">—</span> : v}
                            </td>
                          );
                        })}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
