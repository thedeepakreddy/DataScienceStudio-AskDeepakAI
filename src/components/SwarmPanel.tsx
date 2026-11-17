/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useEffect, useState } from 'react';
import { motion } from 'motion/react';
import { AlertTriangle, CheckCircle2, CircleSlash, Pause, Play, Square, Users, X, XCircle } from 'lucide-react';
import Orb from './Orb';
import { AGENTS } from '../swarm/agents';
import { CAPABILITIES } from '../swarm/catalog';
import type { PlanOutcome } from '../swarm/gateway';
import type { SwarmRun, TaskState } from '../swarm/runtime';

interface SwarmPanelProps {
  onClose: () => void;
  hasDataset: boolean;
  run: SwarmRun | null;
  planning: boolean;
  lastPlan: PlanOutcome | null;
  onPlan: (request: string) => Promise<PlanOutcome>;
  onApproveAndRun: () => void;
  onApproveTask: (id: string) => void;
  onPause: () => void;
  onResume: () => void;
  onCancel: () => void;
  onCancelTask: (id: string) => void;
  onDiscard: () => void;
  onUndoAll: (versionId: string) => void;
}

const EXAMPLES = ['Clean the data and train a model', 'Do a full analysis and write a report', 'Test which columns relate to the outcome'];

const STATUS_TEXT: Record<string, string> = {
  awaiting_approval: 'Waiting for your approval', running: 'Working', paused: 'Paused', cancelling: 'Cancelling…',
  completed: 'Completed', partial: 'Partly completed', failed: 'Failed', cancelled: 'Cancelled',
};

function TaskIcon({ t }: { t: TaskState }) {
  if (t.status === 'running' || t.status === 'verifying') return <Orb state={t.status === 'verifying' ? 'searching' : 'working'} label={t.status} />;
  if (t.status === 'completed') return <CheckCircle2 className="w-4 h-4 text-green" aria-label="Completed" />;
  if (t.status === 'failed') return <XCircle className="w-4 h-4 text-red" aria-label="Failed" />;
  if (t.status === 'blocked' || t.status === 'awaiting_approval') return <AlertTriangle className="w-4 h-4 text-orange" aria-label={t.status} />;
  if (t.status === 'cancelled') return <CircleSlash className="w-4 h-4 text-label-3" aria-label="Cancelled" />;
  return <span className="w-2 h-2 rounded-full bg-fill-strong" aria-label="Waiting" />;
}

/** Ask the agent team for something, review its plan, and follow the work. */
export default function SwarmPanel(props: SwarmPanelProps) {
  const { run, planning, lastPlan } = props;
  const [request, setRequest] = useState('');
  const [showMessages, setShowMessages] = useState(false);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') props.onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [props]);

  const submit = async (text: string) => {
    if (!text.trim() || planning) return;
    await props.onPlan(text.trim());
  };

  const active = run && !['completed', 'partial', 'failed', 'cancelled'].includes(run.status);
  const t = run?.telemetry;

  return (
    <div className="fixed inset-0 z-50 flex justify-end">
      <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} onClick={props.onClose} className="absolute inset-0 bg-[var(--scrim)]" />
      <motion.aside
        role="dialog"
        aria-modal="true"
        aria-labelledby="swarm-title"
        initial={{ x: 40, opacity: 0 }}
        animate={{ x: 0, opacity: 1 }}
        exit={{ x: 40, opacity: 0 }}
        transition={{ duration: 0.25, ease: [0.28, 0.11, 0.32, 1] }}
        className="relative z-10 w-full sm:max-w-xl h-full bg-raised shadow-xl overflow-y-auto p-6 space-y-6"
      >
        <div className="flex items-start justify-between gap-3">
          <div className="flex items-center gap-3">
            <span className="w-10 h-10 rounded-xl bg-blue/12 text-blue flex items-center justify-center"><Users className="w-5 h-5" /></span>
            <div>
              <h2 id="swarm-title" className="text-xl font-semibold tracking-tight text-label">Agents</h2>
              <p className="text-xs text-label-2">A team of specialists that works through the studio for you.</p>
            </div>
          </div>
          <button type="button" onClick={props.onClose} className="btn btn-icon" aria-label="Close agents"><X className="w-4 h-4" /></button>
        </div>

        {!run && (
          <form onSubmit={e => { e.preventDefault(); submit(request); }} className="space-y-3">
            <label htmlFor="swarm-request" className="field-label">What do you need?</label>
            <textarea
              id="swarm-request"
              rows={3}
              className="w-full bg-well border border-separator rounded-xl p-3 text-sm text-label focus:outline-none focus:border-blue/50 resize-none"
              placeholder="e.g. Clean the data, test what relates to churn, train a model and write a report"
              value={request}
              onChange={e => setRequest(e.target.value)}
              disabled={!props.hasDataset}
            />
            <div className="flex flex-wrap gap-2">
              {EXAMPLES.map(x => (
                <button key={x} type="button" className="tag hover:bg-fill-strong" disabled={!props.hasDataset} onClick={() => { setRequest(x); submit(x); }}>{x}</button>
              ))}
            </div>
            <button type="submit" className="btn btn-primary" disabled={!request.trim() || planning || !props.hasDataset} aria-busy={planning}>
              {planning ? <><Orb state="weaving" onAccent label="Planning" /> Planning…</> : 'Plan'}
            </button>
            {!props.hasDataset && <p className="text-sm text-label-2">Import a dataset first.</p>}
            {lastPlan && lastPlan.problems.length > 0 && (
              <div role="alert" className="rounded-xl bg-orange/10 px-3 py-2.5 text-sm text-label space-y-1">
                <p className="font-medium">{lastPlan.reply || 'The plan couldn’t be used.'}</p>
                {lastPlan.problems.map((p, i) => <p key={i} className="text-xs text-label-2">{p.taskId ? `${p.taskId}: ` : ''}{p.message}</p>)}
              </div>
            )}
          </form>
        )}

        {run && (
          <div className="space-y-5">
            <div className="rounded-2xl bg-well p-4 space-y-1">
              <p className="text-sm text-label-2">“{run.request}”</p>
              {run.reply && <p className="text-sm text-label">{run.reply}</p>}
              <p className="text-xs text-label-3">
                Planned by {run.plannedBy === 'rules' ? 'built-in rules (no AI call)' : run.plannedBy === 'cache' ? 'a saved plan (no AI call)' : 'AI (1 call)'} · {STATUS_TEXT[run.status]}
              </p>
            </div>

            <div className="flex flex-wrap gap-2">
              {run.status === 'awaiting_approval' && run.tasks.some(x => !x.approved && CAPABILITIES[x.capability]?.approval === 'batch') && (
                <button type="button" className="btn btn-primary" onClick={props.onApproveAndRun}><Play className="w-4 h-4" /> Approve and Run</button>
              )}
              {run.status === 'awaiting_approval' && run.tasks.every(x => x.approved) && run.tasks.every(x => x.status === 'pending') && (
                <button type="button" className="btn btn-primary" onClick={props.onApproveAndRun}><Play className="w-4 h-4" /> Run</button>
              )}
              {run.status === 'running' && <button type="button" className="btn btn-secondary" onClick={props.onPause}><Pause className="w-4 h-4" /> Pause</button>}
              {run.status === 'paused' && <button type="button" className="btn btn-secondary" onClick={props.onResume}><Play className="w-4 h-4" /> Resume</button>}
              {active && <button type="button" className="btn btn-secondary" onClick={props.onCancel}><Square className="w-4 h-4" /> Cancel All</button>}
              {!active && <button type="button" className="btn btn-secondary" onClick={props.onDiscard}>New Request</button>}
              {run.status === 'awaiting_approval' && run.tasks.every(x => x.status === 'pending' || x.status === 'awaiting_approval') && (
                <button type="button" className="btn btn-plain" onClick={props.onDiscard}>Discard Plan</button>
              )}
            </div>

            <ol className="space-y-2">
              {run.tasks.map(task => {
                const cap = CAPABILITIES[task.capability];
                const agent = AGENTS[task.role];
                return (
                  <li key={task.id} className="rounded-2xl border border-separator p-3">
                    <div className="flex items-start gap-3">
                      <span className="w-5 h-5 flex items-center justify-center shrink-0 mt-0.5"><TaskIcon t={task} /></span>
                      <div className="min-w-0 flex-1">
                        <p className="text-sm text-label">{cap?.label(task.params) ?? task.capability}</p>
                        <p className="text-xs text-label-2">
                          <span className="font-medium" style={{ color: agent.color }}>{agent.name}</span>
                          {task.dynamic && ' · added while running'}
                          {task.dependsOn.length > 0 && ` · after ${task.dependsOn.join(', ')}`}
                          {cap?.approval === 'separate' && ' · needs its own approval'}
                        </p>
                        {task.why && task.status === 'pending' && <p className="mt-1 text-xs text-label-3">{task.why}</p>}
                        {task.result?.summary && <p className="mt-1 text-xs text-label">{task.result.summary}</p>}
                        {task.check && <p className={`mt-0.5 text-xs ${task.check.ok ? 'text-label-2' : 'text-red'}`}>Self-check: {task.check.detail}</p>}
                        {(task.error || task.note) && task.status !== 'completed' && <p className="mt-0.5 text-xs text-orange">{task.error ?? task.note}</p>}
                      </div>
                      <div className="flex flex-col gap-1 shrink-0">
                        {task.status === 'awaiting_approval' && run.status !== 'awaiting_approval' && (
                          <button type="button" className="btn btn-sm btn-primary" onClick={() => props.onApproveTask(task.id)}>Approve</button>
                        )}
                        {['pending', 'ready', 'awaiting_approval', 'running'].includes(task.status) && active && (
                          <button type="button" className="btn btn-sm btn-plain" onClick={() => props.onCancelTask(task.id)}>{task.cancelRequested ? 'Stopping…' : 'Cancel'}</button>
                        )}
                      </div>
                    </div>
                  </li>
                );
              })}
            </ol>

            {run.report && (
              <section className="rounded-2xl bg-well p-4 space-y-2" aria-labelledby="report-heading">
                <h3 id="report-heading" className="text-[15px] font-semibold text-label">Completion report</h3>
                <p className="text-sm text-label">{run.report.headline}</p>
                {run.report.done.length > 0 && (
                  <ul className="text-sm text-label-2 list-disc pl-5 space-y-0.5">{run.report.done.map(d => <li key={d.label}>{d.label}: {d.summary}</li>)}</ul>
                )}
                {run.report.problems.length > 0 && (
                  <ul className="text-sm text-orange list-disc pl-5 space-y-0.5">{run.report.problems.map(p => <li key={p.label}>{p.label} — {p.status}: {p.reason}</li>)}</ul>
                )}
                {run.report.limitations.map(l => <p key={l} className="text-xs text-label-2">{l}</p>)}
                {run.startVersionId && run.report.data.endVersionId !== run.startVersionId && (
                  <button type="button" className="btn btn-sm btn-secondary" onClick={() => props.onUndoAll(run.startVersionId!)}>Undo All Data Changes</button>
                )}
              </section>
            )}

            {t && (
              <p className="text-xs text-label-3 tabular-nums">
                AI calls: {t.aiCalls}{t.aiCalls ? ` (${t.inputTokens + t.outputTokens} tokens)` : ''} · Studio operations: {t.deterministicOps} · Cached plans used: {t.cacheHits} · Retries: {t.retries} · Failures: {t.failures}
              </p>
            )}

            <div>
              <button type="button" className="btn btn-plain btn-sm -ml-2" onClick={() => setShowMessages(s => !s)} aria-expanded={showMessages}>
                {showMessages ? 'Hide' : 'Show'} team messages ({run.messages.length})
              </button>
              {showMessages && (
                <ul className="mt-2 space-y-1.5 text-xs">
                  {run.messages.map(m => (
                    <li key={m.id} className="text-label-2">
                      <span className="tabular-nums text-label-3">{new Date(m.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}</span>{' '}
                      <span className="font-medium" style={{ color: AGENTS[m.from].color }}>{AGENTS[m.from].name}</span>
                      {' → '}{m.to === 'user' ? 'you' : AGENTS[m.to].name}: {m.text}
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </div>
        )}
      </motion.aside>
    </div>
  );
}
