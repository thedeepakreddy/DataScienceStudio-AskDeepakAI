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
// request at all.
//
// It keeps going until the work is done: a step that failed again gets a
// different method where one exists (AutoML → the quick model), and work held
// up by a step that can't be fixed continues without it when it doesn't need
// that step's result (a report, a dashboard), saying what it ran without. Up
// to MAX_ROUNDS rounds of at most MAX_FIXES tasks each; normal approvals.

export const MAX_FIXES = 10;
export const MAX_ROUNDS = 3;

export interface ReviewFix {
  capability: string;
  params: Record<string, unknown>;
  reason: string;
  /** The task this replaces, when it is a redo. */
  redoOf?: string;
  /** Ids (of the run, or of other fixes as `fix:N`) it must wait for. */
  dependsOn?: string[];
  /** Failed tasks this one continues without. */
  waive?: string[];
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

/** A task the review itself added (a redo, an alternative, a continuation). */
export const isFix = (t: TaskState) => !!t.dynamic && (/\.redo\d*$/.test(t.id) || t.id.startsWith('review.'));

/** The engine (or the network) wasn't there: another method may still work. */
const UNAVAILABLE = /unreachable|unavailable|waking|timed? ?out|failed to fetch|network|503|502|504|load failed|parse url/i;

/** A different way to get the same answer, when a step failed again. */
const ALTERNATIVE: Record<string, (t: TaskState) => Omit<ReviewFix, 'redoOf'> | null> = {
  'models.automl': t => ({ capability: 'models.train', params: { target: (t.params as any).target }, reason: 'AutoML didn’t finish; train the quick model instead.' }),
  'models.explain_engine': () => ({ capability: 'models.explain', params: {}, reason: 'Explain the quick model instead.' }),
  'models.forecast': t => (Number((t.params as any).horizon ?? 6) > 3 ? { capability: 'models.forecast', params: { ...t.params, horizon: 3 }, reason: 'Forecast a shorter horizon.' } : null),
};

/** Work that is meaningless without a model from the step it waited for. */
const MODEL_USERS = new Set(['models.explain', 'models.explain_engine', 'models.monitor', 'models.score', 'models.retrain', 'dashboard.pin', 'verify.review']);
const needsResultOf = (t: TaskState, dep: TaskState) =>
  t.capability === 'verify.review' || (MODEL_USERS.has(t.capability) && CAPABILITIES[dep.capability]?.sideEffect === 'model');

function informativeFeatures(ds: Dataset, target: string, exclude: string[]) {
  return ds.columns
    .filter(c => c.name !== target && !exclude.includes(c.name) && !isIdentifierColumn(c, ds.rowCount) && c.type !== 'datetime')
    .map(c => c.name);
}

/** Deterministic audit: what went wrong, and the fixes that address it. */
export function auditRun(run: SwarmRun, ds: Dataset | null, round = 1): AuditResult {
  const issues: string[] = [];
  const fixes: ReviewFix[] = [];
  const byId = new Map(run.tasks.map(t => [t.id, t]));
  const redone = new Map<string, string>(); // task id -> fix key
  const replaced = new Set<string>(); // tasks redone by a different method

  const addFix = (f: ReviewFix) => {
    if (fixes.length >= MAX_FIXES) return;
    const key = `${f.capability}|${JSON.stringify(f.params)}`;
    if (fixes.some(x => `${x.capability}|${JSON.stringify(x.params)}` === key)) return;
    fixes.push(f);
    if (f.redoOf) redone.set(f.redoOf, `fix:${fixes.length - 1}`);
  };

  // A fix waits for what it depends on, or for that step's own fix.
  const depsFor = (t: TaskState) => t.dependsOn.map(d => redone.get(d) ?? d).filter(d => d.startsWith('fix:') || byId.get(d)?.status === 'completed');

  for (const t of run.tasks) {
    if (t.status !== 'failed' || t.supersededBy || t.waived) continue;
    const err = t.error ?? t.note ?? 'failed';
    const incident = (run.incidents ?? []).find(i => i.taskId === t.id);
    // A second failure (a fix that failed, a repair that didn't help, the engine away):
    // try a different method where there is one, never the same thing again.
    const alt = ALTERNATIVE[t.capability]?.(t);
    if ((isFix(t) || incident?.repair || UNAVAILABLE.test(err) || round > 1) && !INPUT_ERROR.test(err)) {
      if (alt) {
        issues.push(`${label(t)} failed (${err.slice(0, 80)}); trying another way.`);
        addFix({ ...alt, redoOf: t.id, dependsOn: depsFor(t) });
        replaced.add(t.id);
        continue;
      }
      if (isFix(t) || incident?.repair) { issues.push(`${label(t)} still failed: ${err}`); continue; }
    }

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
    addFix({ capability: t.capability, params: t.params, reason: `Redo: it failed (“${err.slice(0, 80)}”).`, redoOf: t.id, dependsOn: depsFor(t) });
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

  // 7. Work held up by a failure carries on: after the step's fix when there is one, or
  //    without that step when it doesn't need its result (a report, a dashboard, other
  //    analyses), saying so. Chains of held-up work follow in order.
  for (const t of run.tasks) {
    if (t.status !== 'blocked' || t.supersededBy) continue;
    const holders = [...new Set([...t.dependsOn, ...(t.blockedBy ? [t.blockedBy] : [])])].map(d => byId.get(d)).filter((d): d is TaskState => !!d && d.status !== 'completed');
    const waive: string[] = [];
    let stuck: TaskState | null = null;
    for (const h of holders) {
      if (redone.has(h.id)) continue;
      if (h.status === 'failed' && !needsResultOf(t, h)) waive.push(h.id);
      else if (h.status === 'blocked') stuck = h; // its own continuation (if any) was handled above it
      else if (h.status === 'failed') stuck = h;
    }
    if (stuck) { issues.push(`${label(t)} needs “${label(stuck)}”, which ${stuck.status === 'failed' ? 'failed' : 'couldn’t run'}.`); continue; }
    const fixedHolders = holders.filter(h => redone.has(h.id));
    if (!waive.length && !fixedHolders.length) continue;
    const without = waive.map(w => label(byId.get(w)!));
    if (without.length) issues.push(`${label(t)} continues without ${without.join(', ')} (it failed).`);
    const deps = [...t.dependsOn.filter(d => byId.get(d)?.status === 'completed'), ...fixedHolders.map(h => redone.get(h.id)!)];
    // The step it waited for is being done another way: follow it (e.g. explain the quick model, not the AutoML one).
    const alt = fixedHolders.some(h => replaced.has(h.id)) ? ALTERNATIVE[t.capability]?.(t) : null;
    if (alt) {
      addFix({ ...alt, redoOf: t.id, waive, dependsOn: deps });
      replaced.add(t.id);
      continue;
    }
    addFix({
      capability: t.capability, params: t.params, redoOf: t.id, waive,
      reason: without.length ? `Carry on without ${without.join(', ')}, which failed.` : 'Redo: it was held up by a step that is being fixed.',
      dependsOn: deps,
    });
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
