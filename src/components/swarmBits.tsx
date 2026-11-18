/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React from 'react';
import { AlertTriangle, CheckCircle2, CircleSlash, XCircle } from 'lucide-react';
import Orb from './Orb';
import { CAPABILITIES } from '../swarm/catalog';
import type { ApprovalMode, RunStatus, SwarmRun, TaskState } from '../swarm/runtime';
import { AGENT_SPEED_KEY, agentSpeed, type AgentSpeed } from '../swarm/interaction';

// Shared pieces of the agent views (the chat's run card and the Agents panel).

export const STATUS_TEXT: Record<RunStatus, string> = {
  awaiting_approval: 'Waiting for your approval', running: 'Working', paused: 'Paused', cancelling: 'Cancelling…',
  completed: 'Completed', partial: 'Partly completed', failed: 'Failed', cancelled: 'Cancelled',
};

export const isActive = (run: SwarmRun) => ['running', 'paused', 'cancelling', 'awaiting_approval'].includes(run.status);

export const taskLabel = (t: TaskState) => CAPABILITIES[t.capability]?.label(t.params) ?? t.capability;

export const plannedByText = (run: SwarmRun) =>
  run.plannedBy === 'rules' ? 'built-in rules, no AI call' : run.plannedBy === 'cache' ? 'a saved plan, no AI call' : 'AI, 1 call';

export function TaskIcon({ t }: { t: TaskState }) {
  if (t.status === 'running' || t.status === 'verifying') return <Orb state={t.status === 'verifying' ? 'searching' : 'working'} label={t.status} />;
  if (t.status === 'completed') return <CheckCircle2 className="w-4 h-4 text-green" aria-label="Completed" />;
  if (t.status === 'failed') return <XCircle className="w-4 h-4 text-red" aria-label="Failed" />;
  if (t.status === 'blocked' || t.status === 'awaiting_approval') return <AlertTriangle className="w-4 h-4 text-orange" aria-label={t.status} />;
  if (t.status === 'cancelled') return <CircleSlash className="w-4 h-4 text-label-3" aria-label="Cancelled" />;
  return <span className="w-2 h-2 rounded-full bg-fill-strong" aria-label="Waiting" />;
}

/** Whether the run is waiting for the user to start it. */
export const canStart = (run: SwarmRun) =>
  run.status === 'awaiting_approval' && run.tasks.every(x => x.status === 'pending' || x.status === 'awaiting_approval');

/** The data changes made by a finished run can be undone in one step. */
export const canUndo = (run: SwarmRun) =>
  !isActive(run) && !!run.startVersionId && !!run.report && run.report.data.endVersionId !== run.startVersionId;

/** Whether agents run on their own (you watch) or wait for your approval before changing anything. */
export function ApprovalSwitch({ mode, onChange, compact = false }: { mode: ApprovalMode; onChange: (m: ApprovalMode) => void; compact?: boolean }) {
  return (
    <div className="space-y-1">
      <div className="segmented w-full" role="group" aria-label="Agent approval">
        <button type="button" className="flex-1" aria-pressed={mode === 'auto'} onClick={e => { e.stopPropagation(); onChange('auto'); }}>Watch them work</button>
        <button type="button" className="flex-1" aria-pressed={mode === 'ask'} onClick={e => { e.stopPropagation(); onChange('ask'); }}>Ask me first</button>
      </div>
      {!compact && (
        <p className="text-xs text-label-3">
          {mode === 'auto'
            ? 'Agents start at once and you watch. Every change is a saved version you can undo; pause or stop them any time.'
            : 'Agents plan first. Changes to your data, models and dashboards wait for you to approve them.'}
        </p>
      )}
    </div>
  );
}

/** How fast agents move on the page. Reduced motion always means Instant. */
export function SpeedSwitch() {
  const [speed, setSpeed] = React.useState<AgentSpeed>(() => agentSpeed());
  const pick = (v: AgentSpeed) => { setSpeed(v); try { localStorage.setItem(AGENT_SPEED_KEY, v); } catch { /* private window */ } };
  return (
    <div className="flex items-center gap-2">
      <span className="text-xs text-label-2 shrink-0">Speed</span>
      <div className="segmented flex-1" role="group" aria-label="Agent speed">
        {(['natural', 'fast', 'instant'] as AgentSpeed[]).map(v => (
          <button key={v} type="button" className="flex-1" aria-pressed={speed === v} onClick={() => pick(v)}>{v[0].toUpperCase() + v.slice(1)}</button>
        ))}
      </div>
    </div>
  );
}
