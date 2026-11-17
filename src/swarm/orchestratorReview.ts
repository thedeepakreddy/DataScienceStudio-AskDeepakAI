/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Dataset } from '../types';
import { isIdentifierColumn } from '../utils/csvParser';
import { CAPABILITIES } from './catalog';
import type { SwarmRun, TaskState } from './runtime';

// The Orchestrator's final review (docs/AGENTS_PLAN.md §7a). Before reporting,
// it audits the run: what failed, what an independent review contradicted,
// what the explanation flagged. Where a concrete fix exists it redoes the work
// with that fix — retrain without leaky columns, tune a model that didn't beat
// the baseline, redesign a dashboard that didn't render, re-run work that was
// blocked. A plain repeat of something self-healing already retried is never
// added. An optional AI check (one call) asks whether the results answer the
// request at all. One round, at most MAX_FIXES tasks, normal approvals.

export const MAX_FIXES = 6;

export interface ReviewFix {
  capability: string;
  params: Record<string, unknown>;
  reason: string;
  /** The task this replaces, when it is a redo. */
  redoOf?: string;
  /** Ids (of the run, or of other fixes as `fix:N`) it must wait for. */
  dependsOn?: string[];
}

export interface AuditResult { issues: string[]; fixes: ReviewFix[] }

export interface OrchestratorReview {
  verdict: 'complete' | 'fixing' | 'fixed' | 'needs_you';
  summary: string;
  issues: string[];
  /** Labels of the tasks added to fix the run. */
  fixes: string[];
  fixIds: string[];
  usedAi: boolean;
}

/** Errors no redo can fix (the input itself is wrong). */
const INPUT_ERROR = /no column called|isn’t a choice|isn’t on the page|choose|needs? (at least|a |one )|no dataset|give the|there is no trained model|no other informative|none of .* appear/i;

const label = (t: TaskState) => CAPABILITIES[t.capability]?.label(t.params) ?? t.capability;

function informativeFeatures(ds: Dataset, target: string, exclude: string[]) {
  return ds.columns
    .filter(c => c.name !== target && !exclude.includes(c.name) && !isIdentifierColumn(c, ds.rowCount) && c.type !== 'datetime')
    .map(c => c.name);
}

/** Deterministic audit: what went wrong, and the fixes that address it. */
export function auditRun(run: SwarmRun, ds: Dataset | null): AuditResult {
  const issues: string[] = [];
  const fixes: ReviewFix[] = [];
  const byId = new Map(run.tasks.map(t => [t.id, t]));
  const redone = new Map<string, string>(); // task id -> fix key

  const addFix = (f: ReviewFix) => {
    if (fixes.length >= MAX_FIXES) return;
    const key = `${f.capability}|${JSON.stringify(f.params)}`;
    if (fixes.some(x => `${x.capability}|${JSON.stringify(x.params)}` === key)) return;
    fixes.push(f);
    if (f.redoOf) redone.set(f.redoOf, `fix:${fixes.length - 1}`);
  };

  for (const t of run.tasks) {
    if (t.status !== 'failed' || t.id.includes('.redo')) continue;
    const err = t.error ?? t.note ?? 'failed';
    const incident = (run.incidents ?? []).find(i => i.taskId === t.id);

    // 1. Leakage found by the model's self-check → retrain without those columns.
    const leak = t.capability === 'models.train' && err.match(/Possible leakage: (.+?)\.?$/);
    if (leak && ds) {
      const leaky = leak[1].split(/,\s*/);
      const target = String((t.params as any).target);
      issues.push(`The model for “${target}” used leaky columns (${leaky.join(', ')}).`);
      addFix({ capability: 'models.train', params: { ...t.params, features: informativeFeatures(ds, target, leaky) }, reason: `Retrain without ${leaky.join(', ')} (leakage).`, redoOf: t.id });
      continue;
    }
    // 2. Input problems can't be fixed by trying again.
    if (INPUT_ERROR.test(err)) { issues.push(`${label(t)}: ${err}`); continue; }
    // 3. Self-healing already tried a repair: don't repeat it.
    if (incident?.repair) { issues.push(`${label(t)} still failed after “${incident.repairLabel ?? incident.repair}”: ${err}`); continue; }
    // 4. Anything else (an unexplained failure, a dashboard that didn't render): one fresh attempt.
    issues.push(`${label(t)} failed: ${err}`);
    addFix({ capability: t.capability, params: t.params, reason: `Redo: it failed (“${err.slice(0, 80)}”).`, redoOf: t.id, dependsOn: t.dependsOn.filter(d => byId.get(d)?.status === 'completed') });
  }

  // 5. A model that didn't pass the independent validation gate → try a tuned one.
  for (const r of run.tasks.filter(t => t.capability === 'verify.review' && t.status === 'completed' && !(t.result?.data as any)?.agrees)) {
    const target = (r.params as any)?.target;
    if (target?.capability === 'models.train') {
      const p = target.params ?? {};
      issues.push(`The independent review rejected the model for “${p.target}”: ${String(r.result?.summary ?? '').slice(0, 160)}`);
      if (!p.tune) addFix({ capability: 'models.train', params: { ...p, algorithm: p.algorithm && p.algorithm !== 'auto' ? p.algorithm : 'random_forest', tune: true }, reason: 'The model didn’t pass the validation gate; try a tuned model.' });
    } else if (target) {
      issues.push(`The independent review disagreed with “${target.label}” — reported, not hidden.`);
    }
  }

  // 6. An ID-like column dominating the model → retrain without it.
  for (const e of run.tasks.filter(t => t.capability === 'models.explain' && t.status === 'completed')) {
    const d = e.result?.data as any;
    if (d?.alarmFeatures?.length && ds && d.target) {
      issues.push(`The model leaned on ID-like column(s): ${d.alarmFeatures.join(', ')}.`);
      addFix({ capability: 'models.train', params: { target: d.target, features: informativeFeatures(ds, d.target, d.alarmFeatures) }, reason: `Retrain without ${d.alarmFeatures.join(', ')} (an ID can’t generalise).` });
    }
  }

  // 7. Work blocked by a task that is now being redone runs again after it.
  for (const t of run.tasks.filter(t => t.status === 'blocked')) {
    const blockers = t.dependsOn.filter(d => redone.has(d));
    if (!blockers.length) continue;
    addFix({ capability: t.capability, params: t.params, reason: 'Redo: it was blocked by a step that is being fixed.', redoOf: t.id, dependsOn: [...t.dependsOn.filter(d => !redone.has(d) && byId.get(d)?.status === 'completed'), ...blockers.map(b => redone.get(b)!)] });
  }

  return { issues, fixes };
}

/** What the AI check is given: the request and what each task produced (no raw data). */
export function reviewInput(run: SwarmRun) {
  return {
    request: run.request,
    tasks: run.tasks.map(t => ({
      id: t.id, capability: t.capability, params: t.params, status: t.status,
      summary: t.result?.summary?.slice(0, 300), check: t.check?.detail?.slice(0, 160), error: t.error?.slice(0, 160),
    })),
  };
}
