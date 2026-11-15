import React, { useState, useEffect } from 'react';
import { Database, Search, Code, CheckCircle, Copy, AlertCircle, Loader2, Table as TableIcon } from 'lucide-react';
import alasql from 'alasql';
import { Dataset } from '../types';

interface SQLAssistantProps {
  dataset?: Dataset;
}

export default function SQLAssistant({ dataset }: SQLAssistantProps) {
  const [schema, setSchema] = useState('');
  const [question, setQuestion] = useState('');
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<{ sql: string; explanation: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [sqlResults, setSqlResults] = useState<any[] | null>(null);
  const [sqlError, setSqlError] = useState<string | null>(null);

  // Auto-fill schema from dataset if available
  useEffect(() => {
    if (dataset && dataset.columns.length > 0) {
      const headerString = dataset.columns.map(c => `${c.name} (${c.type})`).join(', ');
      setSchema(`Table: dataset\nColumns: ${headerString}`);
    }
  }, [dataset]);

  const generateSQL = async () => {
    if (!schema || !question) {
      setError('Please provide both a schema and a question.');
      return;
    }
    setError(null);
    setLoading(true);
    setResult(null);
    setSqlResults(null);
    setSqlError(null);

    try {
      const response = await fetch('/api/sql-assistant', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ schema, question }),
      });
      const data = await response.json();
      if (response.ok) {
        setResult(data);
        if (dataset && data.sql) {
          executeSQL(data.sql);
        }
      } else {
        setError(data.error || 'Failed to generate SQL.');
      }
    } catch (err: any) {
      setError('Network error analyzing SQL request.');
    } finally {
      setLoading(false);
    }
  };

  const executeSQL = (sqlString: string) => {
    if (!dataset) return;
    try {
      // Create a clean temporary SQL query by replacing table references with ?
      // alasql lets you pass data as an array parameter
      
      // We will create a local table in alasql and query it
      alasql('DROP TABLE IF EXISTS dataset');
      alasql('CREATE TABLE dataset');
      
      // Determine what table name the LLM might have used.
      // Easiest is just to execute it by passing the dataset directly if it's a simple SELECT
      // Often, alasql is run like: alasql('SELECT * FROM ?', [dataset.data])
      // We'll replace the table name with ? 
      // Or we can populate a table:
      
      alasql.tables.dataset.data = dataset.rows;
      
      // The LLM will probably write SELECT ... FROM dataset ...
      const res = alasql(sqlString);
      if (Array.isArray(res)) {
         setSqlResults(res.slice(0, 50)); // Limit to 50 rows
      } else {
         setSqlResults([{ result: res }]);
      }
    } catch (err: any) {
      console.warn("Alasql execution failed", err);
      setSqlError(err.message || 'Could not execute the generated SQL locally.');
    }
  };

  const copyToClipboard = () => {
    if (result?.sql) {
      navigator.clipboard.writeText(result.sql);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }
  };

  return (
    <div className="bg-surface rounded-2xl border border-separator p-6 sm:p-8 shadow-sm relative overflow-hidden mt-8">
      <div className="flex items-center gap-3 mb-6">
        <div className="w-10 h-10 bg-blue/10 rounded-lg flex items-center justify-center border border-blue/20">
          <Database className="w-5 h-5 text-blue" />
        </div>
        <div>
          <h2 className="text-xl font-semibold text-label tracking-tight">SQL assistant</h2>
          <p className="text-xs text-label-2 mt-1">Translate plain English to optimized SQL queries for your schemas.</p>
        </div>
      </div>

      <div className="space-y-5">
        {!dataset && (
          <div>
            <label className="block text-xs font-medium text-label mb-2">1. Paste Schema or CSV Headers</label>
            <textarea
              value={schema}
              onChange={(e) => setSchema(e.target.value)}
              className="w-full h-24 bg-well border border-separator rounded-xl p-3 text-sm font-code text-label placeholder:text-label-3 focus:outline-none focus:border-blue/50 transition-colors resize-none tabular-nums"
              placeholder="E.g. Table: dataset&#10;Columns: id INT, name VARCHAR..."
            />
          </div>
        )}

        <div>
           <label className="block text-xs font-medium text-label mb-2">
             {dataset ? 'Ask Your Question in English' : '2. Ask Your Question in English'}
           </label>
           <div className="relative">
             <Search className="w-4 h-4 text-label-3 absolute left-3 top-3.5" />
             <input
                type="text"
                value={question}
                onChange={(e) => setQuestion(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && generateSQL()}
                className="w-full bg-well border border-separator rounded-xl py-3 pl-10 pr-4 text-sm text-label placeholder:text-label-3 focus:outline-none focus:border-blue/50 transition-colors"
                placeholder="E.g. Show me the top 10 customers by revenue last month..."
             />
           </div>
        </div>

        <button
          onClick={generateSQL}
          disabled={loading}
          className="w-full bg-blue hover:bg-blue disabled:bg-fill disabled:text-label-3 text-white font-semibold text-sm py-3 px-6 rounded-xl transition-all duration-300"
        >
          {loading ? (
             <span className="flex items-center justify-center gap-2"><Loader2 className="w-4 h-4 animate-spin" /> Analyzing Schema...</span>
          ) : (
             'Generate SQL'
          )}
        </button>

        {error && (
           <div className="p-4 bg-red/10 border border-red/20 text-red rounded-xl text-xs flex items-start gap-3">
             <AlertCircle className="w-4 h-4 text-red shrink-0 mt-0.5" />
             <p>{error}</p>
           </div>
        )}

        {result && (
          <div className="mt-6 border-t border-separator pt-6 animate-fade-in grid grid-cols-1 md:grid-cols-2 gap-6">
             <div className="space-y-4">
               <div className="flex items-center justify-between">
                  <h3 className="text-sm font-semibold text-label flex items-center gap-2">
                    <Code className="w-4 h-4 text-blue" /> Generated SQL
                  </h3>
                  <button
                    onClick={copyToClipboard}
                    className="flex items-center gap-1.5 px-3 py-1.5 bg-fill hover:bg-fill-strong rounded-lg text-xs font-semibold text-label transition-colors"
                  >
                    {copied ? <CheckCircle className="w-3.5 h-3.5 text-green" /> : <Copy className="w-3.5 h-3.5" />}
                    {copied ? 'Copied' : 'Copy SQL'}
                  </button>
               </div>
               <pre className="bg-well border border-separator p-4 rounded-xl overflow-x-auto text-sm text-label tabular-nums leading-relaxed" style={{ WebkitOverflowScrolling: 'touch' }}>
                 <code>{result.sql}</code>
               </pre>
               
               <div className="bg-blue/10 border border-blue/20 rounded-xl p-4 mt-4">
                  <h4 className="text-xs font-medium text-blue mb-2">Explanation</h4>
                  <p className="text-sm text-label leading-relaxed whitespace-pre-line text-left">
                    {result.explanation}
                  </p>
               </div>
             </div>
             
             {/* SQL Output Results Pane */}
             <div className="bg-well border border-separator rounded-xl flex flex-col overflow-hidden">
                <div className="bg-surface border-b border-separator px-4 py-3 flex items-center gap-2">
                  <TableIcon className="w-4 h-4 text-blue" />
                  <h3 className="text-sm font-semibold text-label">Query Results {sqlResults && `(${sqlResults.length} rows)`}</h3>
                </div>
                <div className="p-4 flex-1 overflow-auto">
                   {sqlError ? (
                     <div className="p-3 bg-orange/10 border border-orange/20 text-orange rounded-lg text-xs flex items-start gap-2">
                       <AlertCircle className="w-4 h-4 shrink-0 mt-0.5 text-orange" />
                       <p>Could not execute this query locally: {sqlError}</p>
                     </div>
                   ) : sqlResults && sqlResults.length > 0 ? (
                     <div className="overflow-x-auto overflow-y-auto max-h-[300px]">
                       <table className="w-full text-left border-collapse text-xs">
                         <thead className="sticky top-0 bg-surface outline outline-1 outline-separator">
                           <tr>
                             {Object.keys(sqlResults[0]).map(key => (
                               <th key={key} className="py-2 px-3 font-semibold text-label border-b border-separator-strong whitespace-nowrap">
                                 {key}
                               </th>
                             ))}
                           </tr>
                         </thead>
                         <tbody className="divide-y divide-separator">
                           {sqlResults.map((row, idx) => (
                             <tr key={idx} className="hover:bg-fill transition-colors">
                               {Object.keys(sqlResults[0]).map(key => (
                                 <td key={key} className="py-2 px-3 text-label-2 whitespace-nowrap">
                                   {row[key] !== null && row[key] !== undefined ? String(row[key]) : <span className="text-label-3 italic">null</span>}
                                 </td>
                               ))}
                             </tr>
                           ))}
                         </tbody>
                       </table>
                     </div>
                   ) : sqlResults && sqlResults.length === 0 ? (
                     <div className="flex h-full items-center justify-center text-sm text-label-3">
                       Query returned 0 rows.
                     </div>
                   ) : (
                     <div className="flex h-full items-center justify-center text-sm text-label-3">
                       Executing query...
                     </div>
                   )}
                </div>
             </div>
          </div>
        )}
      </div>
    </div>
  );
}
