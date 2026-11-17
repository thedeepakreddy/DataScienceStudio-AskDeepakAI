/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React from 'react';
import { AlertTriangle, CheckCircle2, CircleSlash, XCircle } from 'lucide-react';
import Orb from './Orb';
import { CAPABILITIES } from '../swarm/catalog';
import type { RunStatus, SwarmRun, TaskState } from '../swarm/runtime';

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
