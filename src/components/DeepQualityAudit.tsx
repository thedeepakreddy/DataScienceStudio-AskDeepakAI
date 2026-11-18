import React, { useState } from 'react';
import { Dataset } from '../types';
import { Microscope, AlertTriangle, Download, Code, ShieldCheck, RotateCw } from 'lucide-react';
import { usePipelineContext } from '../contexts/PipelineContext';
import { buildQualityFixes } from '../utils/qualityAuditFixes';
import Orb from './Orb';

interface DeepQualityAuditProps {
  dataset: Dataset;
}

interface Issue {
  issueName: string;
  severity: string;
  description: string;
  pythonFix: string;
}

export default function DeepQualityAudit({ dataset }: DeepQualityAuditProps) {
  const { setHasRunAudit } = usePipelineContext();
  const [loading, setLoading] = useState(false);
  const [issues, setIssues] = useState<Issue[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  // The data the last audit checked, so a change since then is pointed out.
  const [auditedFor, setAuditedFor] = useState<Dataset | null>(null);

  // Everything is computed here, from every row, by fixed rules: no AI and no server round trip.
  const runAudit = () => {
    setLoading(true);
    setError(null);
    setAuditedFor(dataset);

    try {
      // 1. Calculate Audit Summary locally
      const duplicateCount = calculateDuplicates();
      const columnIssues = dataset.columns.map(col => {
        const uniqueValues = new Set();
        let stringCount = 0;
        let numberCount = 0;
        
        dataset.rows.forEach(row => {
           const val = row[col.name];
           if (val !== undefined && val !== null) {
              uniqueValues.add(val);
              if (typeof val === 'string') stringCount++;
              if (typeof val === 'number') numberCount++;
           }
        });

        const numUnique = uniqueValues.size;
        const cardinalityRatio = numUnique / dataset.rowCount;

        const report = {
           name: col.name,
           missingCount: col.missingCount,
           missingPercentage: ((col.missingCount / dataset.rowCount) * 100).toFixed(2) + '%',
           uniqueValues: numUnique,
           isConstant: numUnique === 1,
           isHighCardinality: col.type === 'categorical' && cardinalityRatio > 0.5 && numUnique > 50,
           typeMismatchWarning: (stringCount > 0 && numberCount > 0) ? true : false,
        };
        return report;
      });

      const auditSummary = {
        totalRows: dataset.rowCount,
        totalColumns: dataset.columns.length,
        duplicateRows: duplicateCount,
        columnIssues: columnIssues.filter(c => c.missingCount > 0 || c.isConstant || c.isHighCardinality || c.typeMismatchWarning)
      };

      // 2. A fix for each finding, from the audit's own rules.
      setIssues(buildQualityFixes(auditSummary));
      setHasRunAudit(true);
    } catch (err: any) {
      setError(err?.message || 'The audit could not finish.');
    } finally {
      setLoading(false);
    }
  };

  const calculateDuplicates = () => {
     let duplicates = 0;
     const seen = new Set();
     dataset.rows.forEach(row => {
        const str = JSON.stringify(row);
        if (seen.has(str)) duplicates++;
        else seen.add(str);
     });
     return duplicates;
  };

  const downloadReport = () => {
    if (!issues) return;
    let reportText = `Data Quality Audit Report\nDataset: ${dataset.filename}\nTotal Rows: ${dataset.rowCount}\n\n`;
    issues.forEach((issue, idx) => {
      reportText += `${idx + 1}. [${issue.severity.toUpperCase()}] ${issue.issueName}\n`;
      reportText += `Description: ${issue.description}\n`;
      reportText += `Python Fix:\n${issue.pythonFix}\n\n`;
    });

    const blob = new Blob([reportText], { type: 'text/plain;charset=utf-8;' });
    const link = document.createElement('a');
    link.href = URL.createObjectURL(blob);
    link.download = `DeepQualityAudit_${dataset.filename}.txt`;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  };

  return (
    <section aria-labelledby="audit-heading">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h2 id="audit-heading" className="section-title">Quality audit</h2>
          <p className="mt-1 text-sm text-label-2">
            Checks every row for duplicates, missing values, constant and mixed-type columns, with a pandas fix for each. Done by the studio’s rules, instantly — no AI.
          </p>
        </div>
        {issues && !loading && (
          <div className="flex flex-wrap items-center gap-2">
            {auditedFor && auditedFor !== dataset && <span className="text-xs text-orange">The data changed since this audit.</span>}
            <button type="button" onClick={runAudit} data-agent="audit-redo" className="btn btn-sm btn-plain" title="Run the audit again on the current data">
              <RotateCw className="w-3.5 h-3.5" /> Run again
            </button>
            {issues.length > 0 && (
              <button type="button" onClick={downloadReport} className="btn btn-secondary">
                <Download className="w-4 h-4" /> Download Report
              </button>
            )}
          </div>
        )}
      </div>

      <div className="card mt-5 p-4 sm:p-5">
        {!issues && !loading && !error && (
          <div className="flex flex-col sm:flex-row sm:items-center gap-4">
            <div className="w-12 h-12 rounded-xl bg-blue/12 text-blue flex items-center justify-center shrink-0">
              <Microscope className="w-6 h-6" />
            </div>
            <div className="flex-1 min-w-0">
              <p className="card-title">Check this dataset for hidden issues</p>
              <p className="mt-0.5 text-sm text-label-2">
                Scans all {dataset.columns.length} columns and suggests a fix for anything it finds.
              </p>
            </div>
            <button type="button" onClick={runAudit} className="btn btn-primary btn-lg shrink-0">
              Run Audit
            </button>
          </div>
        )}

        {loading && (
          <div className="flex flex-col items-center justify-center py-10 text-center">
            <Orb state="searching" size={64} label="Auditing data quality" />
            <p className="mt-4 text-base font-semibold text-label">Auditing {dataset.columns.length} columns…</p>
            <p className="mt-1 text-sm text-label-2">Checking types, duplicates and unusual values.</p>
          </div>
        )}

        {error && (
          <div className="flex flex-col sm:flex-row sm:items-center gap-3">
            <p role="alert" className="flex-1 flex items-start gap-2 text-sm text-red">
              <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" />
              {error}
            </p>
            {!loading && (
              <button type="button" onClick={runAudit} className="btn btn-secondary shrink-0">Try Again</button>
            )}
          </div>
        )}

        {issues && !loading && (
          <div className="animate-fade-in">
            {issues.length === 0 ? (
              <div className="text-center py-8">
                <ShieldCheck className="w-12 h-12 text-green mx-auto" />
                <h3 className="mt-3 text-lg font-semibold tracking-tight text-label">No issues found</h3>
                <p className="mt-1 text-sm text-label-2">No duplicates, type mismatches or anomalies were detected.</p>
              </div>
            ) : (
              <ul className="divide-y divide-separator -my-5">
                {issues.map((issue, idx) => {
                  const severity = issue.severity.toLowerCase();
                  const tone = severity === 'high' ? 'bg-red/12 text-red' : severity === 'medium' ? 'bg-orange/12 text-orange' : 'bg-blue/12 text-blue';
                  return (
                    <li key={idx} className="py-5">
                      <div className="flex items-start justify-between gap-3">
                        <h3 className="text-base font-semibold tracking-tight text-label">{issue.issueName}</h3>
                        <span className={`tag capitalize shrink-0 ${tone}`}>{issue.severity}</span>
                      </div>
                      <p className="mt-1 text-sm text-label-2 leading-relaxed max-w-3xl">{issue.description}</p>
                      <div className="mt-3 rounded-xl bg-well p-3">
                        <p className="flex items-center gap-1.5 text-xs font-medium text-label-2">
                          <Code className="w-3.5 h-3.5" /> Suggested fix
                        </p>
                        <pre className="mt-2 text-xs text-label overflow-x-auto whitespace-pre-wrap">{issue.pythonFix}</pre>
                      </div>
                    </li>
                  );
                })}
              </ul>
            )}
          </div>
        )}
      </div>
    </section>
  );
}
