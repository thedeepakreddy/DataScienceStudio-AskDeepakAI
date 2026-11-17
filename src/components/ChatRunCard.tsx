/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React from 'react';
import { Pause, Play, Square, Undo2 } from 'lucide-react';
import { AGENTS } from '../swarm/agents';
import { CAPABILITIES } from '../swarm/catalog';
import type { SwarmRun } from '../swarm/runtime';
import { STATUS_TEXT, TaskIcon, canStart, canUndo, isActive, plannedByText, taskLabel } from './swarmBits';

interface ChatRunCardProps {
  run: SwarmRun;
  /** Only the current run can be controlled; older ones are a record. */
  live: boolean;
  onRun: () => void;
  onApproveTask: (id: string) => void;
  onPause: () => void;
  onResume: () => void;
  onCancel: () => void;
  onDiscard: () => void;
  onUndo?: (versionId: string) => void;
  onDetails: () => void;
}

/** The agent team's work for one chat request: plan, live steps and the report. */
export default function ChatRunCard({ run, live, ...on }: ChatRunCardProps) {
  const active = live && isActive(run);
  const approvalOf = (c: string) => CAPABILITIES[c]?.approval;
  // "Approve and Run" covers the tasks that may be approved together; a task
  // that needs its own approval (custom code, registering a model) gets its own button.
  const batchWaiting = run.tasks.some(t => !t.approved && approvalOf(t.capability) === 'batch');
  const onlySeparate = run.tasks.every(t => t.approved || approvalOf(t.capability) === 'separate');
  const report = run.report;
  return (
    <div className="mt-2 pt-2 border-t border-separator space-y-2 text-[11px]" data-swarm-ui>
      <p className="text-label-3">{STATUS_TEXT[run.status]} · planned by {plannedByText(run)}</p>

      <ol className="space-y-1.5">
        {run.tasks.map(t => {
          const agent = AGENTS[t.role];
          return (
            <li key={t.id} className="flex items-start gap-1.5">
              <span className="w-4 h-4 flex items-center justify-center shrink-0 mt-px"><TaskIcon t={t} /></span>
              <div className="min-w-0 flex-1">
                <p className="text-label leading-snug">{taskLabel(t)}</p>
                <p className="text-label-2 leading-snug">
                  <span className="font-medium" style={{ color: agent.color }}>{agent.name}</span>
                  {t.dynamic && ' · added while working'}
                  {CAPABILITIES[t.capability]?.approval === 'separate' && t.status !== 'completed' && ' · needs its own approval'}
                </p>
                {t.result?.summary && t.status === 'completed' && <p className="text-label-2 leading-snug">{t.result.summary}</p>}
                {t.capability === 'sql.query' && t.status === 'completed' && <SqlPreview data={t.result?.data} />}
                {(t.error || t.note) && t.status !== 'completed' && <p className="text-orange leading-snug">{t.error ?? t.note}</p>}
              </div>
              {live && !t.approved && !['completed', 'failed', 'cancelled', 'blocked'].includes(t.status) && (approvalOf(t.capability) === 'separate' || (t.status === 'awaiting_approval' && run.status !== 'awaiting_approval')) && (
                <button type="button" className="btn btn-sm btn-primary min-h-0 py-0.5 px-2 text-[11px]" onClick={() => on.onApproveTask(t.id)}>Approve</button>
              )}
            </li>
          );
        })}
      </ol>

      {report && (
        <div className="rounded-xl bg-well px-2.5 py-2 space-y-1">
          <p className="text-label font-medium">{report.headline}</p>
          {report.bySteps && report.bySteps.length > 1 && (
            <p className="text-label-2">{report.bySteps.map(b => `${b.step} ${b.count}`).join(' · ')}</p>
          )}
          {report.orchestrator && (
            <div className={report.orchestrator.verdict === 'needs_you' ? 'text-orange' : 'text-label-2'}>
              <p><span className="font-medium" style={{ color: AGENTS.orchestrator.color }}>Orchestrator review</span>{report.orchestrator.usedAi ? ' (AI-checked)' : ''}: {report.orchestrator.summary}</p>
              {report.orchestrator.verdict === 'needs_you' && report.orchestrator.issues.slice(0, 4).map((i, k) => <p key={k}>• {i}</p>)}
            </div>
          )}
          {report.reviews.filter(r => !r.agrees).map(r => <p key={r.label} className="text-orange">Contradiction — {r.label}: {r.detail}</p>)}
          {report.incidents.map((i, k) => (
            <p key={k} className={i.state === 'closed' ? 'text-label-2' : 'text-orange'}>
              {i.state === 'closed' ? 'Fixed on its own' : 'Needs you'}: {i.diagnosis}{i.repair ? ` (${i.repair})` : ''}
            </p>
          ))}
          {report.problems.map(p => <p key={p.label} className="text-orange">{p.label}: {p.reason}</p>)}
        </div>
      )}

      <div className="flex flex-wrap gap-1.5">
        {live && canStart(run) && !onlySeparate && (
          <button type="button" className="btn btn-sm btn-primary" onClick={on.onRun}>
            <Play className="w-3.5 h-3.5" /> {batchWaiting ? 'Approve and Run' : 'Run'}
          </button>
        )}
        {live && canStart(run) && <button type="button" className="btn btn-sm btn-plain" onClick={on.onDiscard}>Cancel</button>}
        {active && run.status === 'running' && <button type="button" className="btn btn-sm btn-secondary" onClick={on.onPause}><Pause className="w-3.5 h-3.5" /> Pause</button>}
        {active && run.status === 'paused' && <button type="button" className="btn btn-sm btn-secondary" onClick={on.onResume}><Play className="w-3.5 h-3.5" /> Resume</button>}
        {active && !canStart(run) && <button type="button" className="btn btn-sm btn-plain" onClick={on.onCancel}><Square className="w-3.5 h-3.5" /> Stop</button>}
        {on.onUndo && canUndo(run) && (
          <button type="button" className="btn btn-sm btn-secondary" onClick={() => on.onUndo!(run.startVersionId!)}><Undo2 className="w-3.5 h-3.5" /> Undo All</button>
        )}
        <button type="button" className="btn btn-sm btn-plain" onClick={on.onDetails}>Details</button>
      </div>
    </div>
  );
}

/** The first rows of a query result, so the answer is right in the chat. */
function SqlPreview({ data }: { data: unknown }) {
  const r = data as { columns?: string[]; rows?: Record<string, unknown>[]; total?: number } | undefined;
  if (!r?.columns?.length || !r.rows) return null;
  const rows = r.rows.slice(0, 8);
  return (
    <div className="mt-1 overflow-x-auto rounded-lg bg-well">
      <table className="text-[11px] tabular-nums">
        <thead><tr>{r.columns.map(c => <th key={c} className="px-2 py-1 text-left font-medium text-label-2 whitespace-nowrap">{c}</th>)}</tr></thead>
        <tbody>
          {rows.map((row, i) => (
            <tr key={i} className="border-t border-separator">
              {r.columns!.map(c => <td key={c} className="px-2 py-1 text-label whitespace-nowrap">{row[c] == null ? '' : String(row[c])}</td>)}
            </tr>
          ))}
        </tbody>
      </table>
      {(r.total ?? rows.length) > rows.length && <p className="px-2 py-1 text-label-3">Showing {rows.length} of {r.total?.toLocaleString()} rows.</p>}
    </div>
  );
}
