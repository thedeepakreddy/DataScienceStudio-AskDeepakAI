/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { getEngineState } from '../engine/engineState';
import type { Dataset } from '../types';
import { apiFetch } from '../utils/api';
import { getCachedPlan, setCachedPlan } from '../utils/workspaceStore';
import { CATALOG_VERSION, catalogForPlanner } from './catalog';
import { skillsForPlanner } from './skills';
import { reviewInput } from './orchestratorReview';
import { PlanProblem, TaskSpec, mentionedColumns, normaliseAiTasks, rulePlan, validatePlan } from './plan';

// Planning with as few AI calls as possible (blueprint 6.1): the built-in
// rules first, then a verified cached plan for the same request and columns,
// and only then one AI call. Every plan, whatever produced it, is validated.
// The AI provider sits behind the server's /api/swarm/plan, so swapping
// Gemini for another provider doesn't change the swarm.

export interface PlanOutcome {
  tasks: TaskSpec[];
  reply: string;
  plannedBy: 'rules' | 'ai' | 'cache';
  problems: PlanProblem[];
  aiCalls: number;
  inputTokens: number;
  outputTokens: number;
  cacheHit: boolean;
  /** The reply answers a question; there is nothing to run. */
  answer?: boolean;
}

export interface ChatTurn { role: 'user' | 'assistant'; content: string }

/** Answers simple questions about the data without AI, and says what can be asked. */
export function offlineReply(request: string, ds: Dataset | null): string {
  if (!ds) return 'Import a dataset first (Import step), then ask me to clean it, explore it, test relationships, train a model or build a report.';
  const t = request.toLowerCase();
  const missing = ds.columns.filter(c => c.missingCount > 0);
  // A statistic of a named column, from the studio's own column profile.
  const named = ds.columns.find(c => c.name === mentionedColumns(request, ds)[0]);
  if (named) {
    const st = named.statistics ?? {};
    const num = (v?: number) => (v == null ? null : Number(v.toPrecision(6)).toLocaleString());
    const stat: [RegExp, string, string | null][] = [
      [/\b(average|mean)\b/, 'average', num(st.mean)], [/\bmedian\b/, 'median', num(st.median)],
      [/\b(min|minimum|lowest|smallest)\b/, 'lowest value', num(st.min)], [/\b(max|maximum|highest|largest|biggest)\b/, 'highest value', num(st.max)],
      [/\b(std|standard deviation|spread)\b/, 'standard deviation', num(st.stdDev)],
    ];
    for (const [re, what, v] of stat) if (re.test(t) && v != null) return `The ${what} of ${named.name} is ${v} (${(ds.rows.length - named.missingCount).toLocaleString()} non-empty values).`;
    if (/most (common|frequent)|top values?/.test(t) && st.mostCommon?.length) return `Most common in ${named.name}: ${st.mostCommon.slice(0, 5).map(m => `${m.value} (${m.count.toLocaleString()})`).join(', ')}.`;
    if (/unique|distinct/.test(t)) return `${named.name} has ${named.distinctCount.toLocaleString()} distinct values.`;
  }
  if (/how many (rows|records)|row count|size of/.test(t)) return `${ds.filename} has ${ds.rows.length.toLocaleString()} rows and ${ds.columns.length} columns.`;
  if (/missing|null|empty|blank/.test(t)) {
    return missing.length
      ? `Missing values: ${missing.map(c => `${c.name} ${c.missingCount.toLocaleString()}`).join(', ')}. Say “fill missing values with median” to fix them.`
      : 'No column has missing values.';
  }
  if (/how many columns|which columns|what columns|list (the )?columns|column names/.test(t)) return `${ds.columns.length} columns: ${ds.columns.map(c => `${c.name} (${c.type})`).join(', ')}.`;
  return `I couldn’t match that to an action, and AI planning isn’t available right now. ${ds.filename} has ${ds.rows.length.toLocaleString()} rows × ${ds.columns.length} columns. Try:
- Clean the data
- Drop the ${ds.columns[0]?.name ?? 'X'} column
- Fill missing values with median
- Test ${ds.columns[0]?.name ?? 'A'} against ${ds.columns[1]?.name ?? 'B'}
- Train a model to predict ${ds.columns[ds.columns.length - 1]?.name ?? 'Y'}
- Full analysis with a report
- SELECT * FROM dataset LIMIT 10`;
}

/** Compact facts about the data for the AI: types, gaps, ranges and a few rows. */
function datasetContext(ds: Dataset) {
  return {
    filename: ds.filename,
    rows: ds.rows.length,
    columns: ds.columns.slice(0, 200).map(c => ({
      name: c.name, type: c.type, missing: c.missingCount, distinct: c.distinctCount,
      mean: c.statistics?.mean, min: c.statistics?.min, max: c.statistics?.max,
      top: c.statistics?.mostCommon?.slice(0, 3)?.map((m: any) => m.value ?? m),
    })),
    sample: ds.rows.slice(0, 3),
  };
}

const normaliseRequest = (s: string) => s.toLowerCase().replace(/\s+/g, ' ').trim();
const schemaKey = (ds: Dataset) => ds.columns.map(c => `${c.name}:${c.type}`).join('|');

export function planCacheKey(request: string, ds: Dataset) {
  return `v${CATALOG_VERSION}::${normaliseRequest(request)}::${schemaKey(ds)}`;
}

export async function planRequest(request: string, ds: Dataset | null, opts: { allowAi?: boolean; history?: ChatTurn[]; hasModel?: boolean } = {}): Promise<PlanOutcome> {
  const empty = { aiCalls: 0, inputTokens: 0, outputTokens: 0, cacheHit: false };
  const rules = rulePlan(request, ds, { hasModel: opts.hasModel, engine: getEngineState() });
  if (rules.tasks.length || !ds) {
    return { ...empty, tasks: rules.tasks, reply: rules.reply, plannedBy: 'rules', problems: rules.tasks.length ? validatePlan(rules.tasks, ds) : [], answer: !rules.tasks.length };
  }

  const key = planCacheKey(request, ds);
  const cached = await getCachedPlan(key).catch(() => undefined) as { tasks: TaskSpec[]; reply: string } | undefined;
  if (cached?.tasks?.length) {
    const problems = validatePlan(cached.tasks, ds);
    if (!problems.length) return { ...empty, tasks: cached.tasks, reply: cached.reply, plannedBy: 'cache', problems, cacheHit: true };
  }

  if (opts.allowAi === false) {
    return { ...empty, tasks: [], reply: offlineReply(request, ds), plannedBy: 'rules', problems: [], answer: true };
  }

  const res = await apiFetch('/api/swarm/plan', {
    method: 'POST',
    body: JSON.stringify({
      request,
      catalog: catalogForPlanner(),
      skills: skillsForPlanner(),
      dataset: datasetContext(ds),
      history: (opts.history ?? []).slice(-8).map(h => ({ role: h.role, content: h.content.slice(0, 600) })),
    }),
  });
  const body = await res.json().catch(() => null);
  if (!res.ok || !body) {
    // No AI: answer what can be answered from the data itself.
    return {
      ...empty, tasks: [], plannedBy: 'rules', aiCalls: res.status === 503 && body?.reason === 'ai_unavailable' ? 0 : 1,
      reply: offlineReply(request, ds), problems: [], answer: true,
    };
  }
  const tasks = normaliseAiTasks(body.tasks);
  // No tasks means the AI answered a question.
  if (!tasks.length) {
    return { ...empty, tasks, reply: body.reply || offlineReply(request, ds), plannedBy: 'ai', problems: [], answer: true, aiCalls: 1, inputTokens: body.usage?.inputTokens ?? 0, outputTokens: body.usage?.outputTokens ?? 0 };
  }
  const problems = validatePlan(tasks, ds);
  // Only plans that passed validation are reused (6.3).
  if (tasks.length && !problems.length) await setCachedPlan(key, { tasks, reply: body.reply }).catch(() => {});
  return {
    tasks, reply: body.reply || '', plannedBy: 'ai', problems,
    aiCalls: 1, inputTokens: body.usage?.inputTokens ?? 0, outputTokens: body.usage?.outputTokens ?? 0, cacheHit: false,
  };
}

/** The Orchestrator's AI check of a finished run (one call); null when AI is unavailable. */
export async function aiReviewRun(run: import('./runtime').SwarmRun, ds: Dataset | null) {
  try {
    const res = await apiFetch('/api/swarm/review', {
      method: 'POST',
      body: JSON.stringify({ ...reviewInput(run), catalog: catalogForPlanner(), dataset: ds ? { columns: ds.columns.map(c => ({ name: c.name, type: c.type })) } : null }),
    });
    if (!res.ok) return null;
    const body = await res.json().catch(() => null);
    if (!body) return null;
    return {
      summary: String(body.summary ?? ''),
      issues: Array.isArray(body.issues) ? body.issues.map(String) : [],
      tasks: normaliseAiTasks(body.tasks).slice(0, 4),
      inputTokens: body.usage?.inputTokens ?? 0,
      outputTokens: body.usage?.outputTokens ?? 0,
    };
  } catch {
    return null;
  }
}
