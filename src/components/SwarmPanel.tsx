/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useEffect, useState } from 'react';
import { motion } from 'motion/react';
import { Pause, Play, Square, Users, X } from 'lucide-react';
import { AGENTS } from '../swarm/agents';
import { CAPABILITIES } from '../swarm/catalog';
import type { SwarmRun, TaskState } from '../swarm/runtime';
import { STATUS_TEXT, TaskIcon, canUndo, plannedByText, taskLabel } from './swarmBits';
import { SKILLS } from '../swarm/skills';
import type { AgentRole } from '../swarm/agents';

interface SwarmPanelProps {
  onClose: () => void;
  run: SwarmRun | null;
  /** Recent runs, newest first. */
  history: SwarmRun[];
  onApproveAndRun: () => void;
  onApproveTask: (id: string) => void;
  onPause: () => void;
  onResume: () => void;
  onCancel: () => void;
  onCancelTask: (id: string) => void;
  onDiscard: () => void;
  onUndoAll: (versionId: string) => void;
}

/** Groups tasks into levels: a task sits one level after the last task it waits for. */
export function taskLevels(tasks: TaskState[]): TaskState[][] {
  const level = new Map<string, number>();
  const byId = new Map(tasks.map(t => [t.id, t]));
  const of = (t: TaskState, seen = new Set<string>()): number => {
    if (level.has(t.id)) return level.get(t.id)!;
    if (seen.has(t.id)) return 0;
    seen.add(t.id);
    const deps = t.dependsOn.map(d => byId.get(d)).filter(Boolean) as TaskState[];
    const l = deps.length ? Math.max(...deps.map(d => of(d, seen))) + 1 : 0;
    level.set(t.id, l);
    return l;
  };
  const out: TaskState[][] = [];
  for (const t of tasks) (out[of(t)] ??= []).push(t);
  return out.filter(Boolean);
}

const INCIDENT_TEXT = { detected: 'Detected', diagnosing: 'Diagnosing', repairing: 'Repairing', validating: 'Checking the repair', closed: 'Fixed', escalated: 'Needs you' } as const;

/** The team's work in detail: task map, steps, reviews, incidents and messages. Requests are made in the Ask AI chat. */
export default function SwarmPanel(props: SwarmPanelProps) {
  const { run } = props;
  const [showMessages, setShowMessages] = useState(false);
  const [view, setView] = useState<'work' | 'team'>('work');

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') props.onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [props]);

  const active = run && !['completed', 'partial', 'failed', 'cancelled'].includes(run.status);
  const t = run?.telemetry;

  return (
    <div className="fixed inset-0 z-50 flex justify-end" data-swarm-ui>
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

        <div className="segmented w-full" role="tablist" aria-label="Agents view">
          <button type="button" role="tab" className="flex-1" aria-selected={view === 'work'} onClick={() => setView('work')}>Work</button>
          <button type="button" role="tab" className="flex-1" aria-selected={view === 'team'} onClick={() => setView('team')}>Team ({Object.keys(AGENTS).length})</button>
        </div>

        {view === 'team' && <TeamView />}

        {view === 'work' && !run && (
          <div className="space-y-4">
            <p className="text-sm text-label-2">Ask the team in the <span className="text-label font-medium">Ask AI</span> chat — for example “Clean the data and train a model”. You’ll see each agent working on this page, and the details appear here.</p>
            {props.history.length > 0 && (
              <section aria-labelledby="recent-runs" className="space-y-2">
                <h3 id="recent-runs" className="section-title">Recent runs</h3>
                <ul className="space-y-1.5">
                  {props.history.slice(0, 8).map(h => (
                    <li key={h.id} className="rounded-xl bg-well px-3 py-2 text-sm">
                      <p className="text-label truncate">“{h.request}”</p>
                      <p className="text-xs text-label-2">{STATUS_TEXT[h.status]} · {h.tasks.length} tasks · {new Date(h.createdAt).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' })}</p>
                      {h.report && <p className="text-xs text-label-3">{h.report.headline}</p>}
                    </li>
                  ))}
                </ul>
              </section>
            )}
          </div>
        )}

        {view === 'work' && run && (
          <div className="space-y-5">
            <div className="rounded-2xl bg-well p-4 space-y-1">
              <p className="text-sm text-label-2">“{run.request}”</p>
              {run.reply && <p className="text-sm text-label">{run.reply}</p>}
              <p className="text-xs text-label-3">
                Planned by {plannedByText(run)} · {STATUS_TEXT[run.status]}
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
              {!active && <button type="button" className="btn btn-secondary" onClick={props.onDiscard}>Clear</button>}
              {run.status === 'awaiting_approval' && run.tasks.every(x => x.status === 'pending' || x.status === 'awaiting_approval') && (
                <button type="button" className="btn btn-plain" onClick={props.onDiscard}>Discard Plan</button>
              )}
            </div>

            <section aria-labelledby="task-map" className="space-y-2">
              <h3 id="task-map" className="section-title">Task map</h3>
              <div className="flex gap-2 overflow-x-auto pb-1">
                {taskLevels(run.tasks).map((lvl, i) => (
                  <div key={i} className="flex flex-col gap-1.5 min-w-[150px]">
                    <span className="text-[11px] text-label-3">{i === 0 ? 'First' : `Then (${i + 1})`}</span>
                    {lvl.map(t => (
                      <div key={t.id} className="rounded-xl border px-2 py-1.5 text-xs flex items-start gap-1.5" style={{ borderColor: AGENTS[t.role].color }}>
                        <span className="w-4 h-4 flex items-center justify-center shrink-0"><TaskIcon t={t} /></span>
                        <span className="text-label leading-snug">{taskLabel(t)}</span>
                      </div>
                    ))}
                  </div>
                ))}
              </div>
            </section>

            <ol className="space-y-2">
              {run.tasks.map(task => {
                const cap = CAPABILITIES[task.capability];
                const agent = AGENTS[task.role];
                return (
                  <li key={task.id} className="rounded-2xl border border-separator p-3">
                    <div className="flex items-start gap-3">
                      <span className="w-5 h-5 flex items-center justify-center shrink-0 mt-0.5"><TaskIcon t={task} /></span>
                      <div className="min-w-0 flex-1">
                        <p className="text-sm text-label">{taskLabel(task)}</p>
                        <p className="text-xs text-label-2">
                          <span className="font-medium" style={{ color: agent.color }}>{agent.name}</span>
                          {task.dynamic && ' · added while running'}
                          {task.dependsOn.length > 0 && ` · after ${task.dependsOn.join(', ')}`}
                          {cap?.approval === 'separate' && ' · needs its own approval'}
                        </p>
                        {task.why && task.status === 'pending' && <p className="mt-1 text-xs text-label-3">{task.why}</p>}
                        {task.result?.summary && <p className="mt-1 text-xs text-label">{task.result.summary}</p>}
                        {task.check && <p className={`mt-0.5 text-xs ${task.check.ok ? 'text-label-2' : 'text-red'}`}>{task.check.kind === 'independent' ? 'Independent review' : 'Self-check'}: {task.check.detail}</p>}
                        {task.usedPage && <p className="mt-0.5 text-xs text-label-3">Done through the controls on the page.</p>}
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
                {run.report.orchestrator && (
                  <div className="text-sm space-y-0.5">
                    <p className="text-label"><span className="font-medium" style={{ color: AGENTS.orchestrator.color }}>Orchestrator review</span>{run.report.orchestrator.usedAi ? ' (AI-checked)' : ''}: {run.report.orchestrator.summary}</p>
                    {run.report.orchestrator.issues.map((i, k) => <p key={k} className="text-xs text-label-2">• {i}</p>)}
                    {run.report.orchestrator.fixes.length > 0 && <p className="text-xs text-label-2">Redone: {run.report.orchestrator.fixes.join('; ')}.</p>}
                  </div>
                )}
                {run.report.reviews.length > 0 && (
                  <ul className="text-sm list-disc pl-5 space-y-0.5">{run.report.reviews.map(r => <li key={r.label} className={r.agrees ? 'text-label-2' : 'text-orange'}>{r.agrees ? 'Review agrees' : 'Contradiction'} — {r.label}: {r.detail}</li>)}</ul>
                )}
                {run.report.limitations.map(l => <p key={l} className="text-xs text-label-2">{l}</p>)}
                {canUndo(run) && (
                  <button type="button" className="btn btn-sm btn-secondary" onClick={() => props.onUndoAll(run.startVersionId!)}>Undo All Data Changes</button>
                )}
              </section>
            )}

            {(run.incidents?.length ?? 0) > 0 && (
              <section aria-labelledby="incidents" className="space-y-2">
                <h3 id="incidents" className="section-title">Incidents</h3>
                <ul className="space-y-1.5">
                  {run.incidents!.map(i => (
                    <li key={i.id} className="rounded-xl bg-well px-3 py-2 text-xs space-y-0.5">
                      <p className={i.state === 'escalated' ? 'text-orange font-medium' : 'text-label font-medium'}>{INCIDENT_TEXT[i.state]}: {i.diagnosis}</p>
                      {i.repairLabel && <p className="text-label-2">Repair: {i.repairLabel}</p>}
                      {i.log.map((l, k) => <p key={k} className="text-label-3">{l}</p>)}
                    </li>
                  ))}
                </ul>
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

/** Every agent with what it knows, how it decides and what it can do. */
function TeamView() {
  const owns = (role: AgentRole) => Object.values(CAPABILITIES).filter(c => c.defaultRole === role);
  return (
    <ul className="space-y-2">
      {(Object.keys(AGENTS) as AgentRole[]).map(role => {
        const a = AGENTS[role];
        const s = SKILLS[role];
        return (
          <li key={role} className="rounded-2xl border border-separator">
            <details className="group">
              <summary className="list-none cursor-pointer p-3 flex items-start gap-3">
                <span className="w-3 h-3 rounded-full mt-1.5 shrink-0" style={{ background: a.color }} aria-hidden="true" />
                <span className="min-w-0 flex-1">
                  <span className="block text-sm font-semibold text-label">{a.name}</span>
                  <span className="block text-xs text-label-2">{s.mission}</span>
                </span>
                <span className="text-xs text-label-3 shrink-0 mt-0.5">{owns(role).length} skills</span>
              </summary>
              <div className="px-3 pb-3 pl-9 space-y-2 text-xs">
                <SkillList title="Knows" items={s.knows} />
                <SkillList title="How it decides" items={s.playbook} />
                <SkillList title="Quality bar" items={s.qualityBar} />
                <div>
                  <p className="font-medium text-label-2 mb-1">Can do</p>
                  <div className="flex flex-wrap gap-1">
                    {owns(role).map(c => <span key={c.id} className="tag text-[11px]">{c.id}</span>)}
                  </div>
                </div>
                {s.handsOffTo.length > 0 && (
                  <p className="text-label-3">Hands off to {s.handsOffTo.map(r => AGENTS[r].name).join(', ')}.</p>
                )}
              </div>
            </details>
          </li>
        );
      })}
    </ul>
  );
}

function SkillList({ title, items }: { title: string; items: string[] }) {
  return (
    <div>
      <p className="font-medium text-label-2 mb-0.5">{title}</p>
      <ul className="list-disc pl-4 space-y-0.5 text-label">{items.map(i => <li key={i}>{i}</li>)}</ul>
    </div>
  );
}
