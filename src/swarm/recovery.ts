/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

// The self-healing recovery service (blueprint addendum 18). When a task
// fails, an incident is opened, the error is matched against known rules,
// and only safe, pre-approved repairs run automatically — waking the ML
// service, using the direct operation instead of the page, or one retry
// with more time. Each repair is validated by re-running the task; an
// incident is closed only when that succeeds. Anything unknown is escalated
// to the user. No AI call is needed for any of this (18.8).

export type IncidentState = 'detected' | 'diagnosing' | 'repairing' | 'validating' | 'closed' | 'escalated';
export type RepairKind = 'wake_ml' | 'direct' | 'more_time';

export interface Incident {
  id: string;
  taskId: string;
  /** Same root cause = same fingerprint (deduplication, 18.7). */
  fingerprint: string;
  state: IncidentState;
  diagnosis: string;
  repair?: RepairKind;
  repairLabel?: string;
  detectedAt: number;
  closedAt?: number;
  log: string[];
}

export const RECOVERY_LIMITS = { repairsPerTask: 1, repairsPerRun: 3 };

interface Rule { test: RegExp; diagnosis: string; repair: RepairKind | null; label?: string; when?: (ctx: { usedPage: boolean; uiOnly: boolean }) => boolean }

const RULES: Rule[] = [
  { test: /not responding|asleep|unreachable|waking|ECONNREFUSED|fetch failed|HTTP 50[234]|Gateway/i, diagnosis: 'The ML service was asleep or unreachable (free hosting sleeps when idle).', repair: 'wake_ml', label: 'Wake the ML service, then run the task again' },
  { test: /isn’t on the page|isn’t a choice|isn’t a list|isn’t a text field|change wasn’t applied/i, diagnosis: 'A control on the page wasn’t where the agent expected.', repair: 'direct', label: 'Run the same operation directly instead of through the page', when: c => c.usedPage && !c.uiOnly },
  { test: /timed out/i, diagnosis: 'The task took longer than its time limit.', repair: 'more_time', label: 'Run again once with twice the time' },
  { test: /no column called|doesn’t exist|not found/i, diagnosis: 'The task refers to data that isn’t there (perhaps renamed or removed by an earlier step).', repair: null },
];

export function fingerprint(capability: string, error: string) {
  return `${capability}:${error.replace(/\d+/g, '#').replace(/“[^”]*”/g, '“…”').slice(0, 120)}`;
}

export function diagnose(error: string, ctx: { usedPage: boolean; uiOnly: boolean }): { diagnosis: string; repair: RepairKind | null; label?: string } {
  for (const r of RULES) {
    if (r.test.test(error) && (!r.when || r.when(ctx))) return { diagnosis: r.diagnosis, repair: r.repair, label: r.label };
  }
  return { diagnosis: 'Unrecognised failure.', repair: null };
}
