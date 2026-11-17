/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Dataset } from '../types';
import { apiFetch } from '../utils/api';
import { getCachedPlan, setCachedPlan } from '../utils/workspaceStore';
import { CATALOG_VERSION, catalogForPlanner } from './catalog';
import { PlanProblem, TaskSpec, normaliseAiTasks, rulePlan, validatePlan } from './plan';

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
}

const normaliseRequest = (s: string) => s.toLowerCase().replace(/\s+/g, ' ').trim();
const schemaKey = (ds: Dataset) => ds.columns.map(c => `${c.name}:${c.type}`).join('|');

export function planCacheKey(request: string, ds: Dataset) {
  return `v${CATALOG_VERSION}::${normaliseRequest(request)}::${schemaKey(ds)}`;
}

export async function planRequest(request: string, ds: Dataset | null, opts: { allowAi?: boolean } = {}): Promise<PlanOutcome> {
  const empty = { aiCalls: 0, inputTokens: 0, outputTokens: 0, cacheHit: false };
  const rules = rulePlan(request, ds);
  if (rules.tasks.length || !ds) {
    return { ...empty, tasks: rules.tasks, reply: rules.reply, plannedBy: 'rules', problems: rules.tasks.length ? validatePlan(rules.tasks, ds) : [] };
  }

  const key = planCacheKey(request, ds);
  const cached = await getCachedPlan(key).catch(() => undefined) as { tasks: TaskSpec[]; reply: string } | undefined;
  if (cached?.tasks?.length) {
    const problems = validatePlan(cached.tasks, ds);
    if (!problems.length) return { ...empty, tasks: cached.tasks, reply: cached.reply, plannedBy: 'cache', problems, cacheHit: true };
  }

  if (opts.allowAi === false) {
    return { ...empty, tasks: [], reply: 'I couldn’t plan that with the built-in rules.', plannedBy: 'rules', problems: [{ taskId: null, message: 'No plan.' }] };
  }

  const res = await apiFetch('/api/swarm/plan', {
    method: 'POST',
    body: JSON.stringify({
      request,
      catalog: catalogForPlanner(),
      dataset: { filename: ds.filename, rows: ds.rows.length, columns: ds.columns.map(c => ({ name: c.name, type: c.type, missing: c.missingCount })) },
    }),
  });
  const body = await res.json().catch(() => null);
  if (!res.ok || !body) {
    return {
      ...empty, tasks: [], plannedBy: 'ai', aiCalls: res.status === 503 && body?.reason === 'ai_unavailable' ? 0 : 1,
      reply: body?.error || `Planning failed (HTTP ${res.status}).`, problems: [{ taskId: null, message: body?.error || 'Planning failed.' }],
    };
  }
  const tasks = normaliseAiTasks(body.tasks);
  const problems = tasks.length ? validatePlan(tasks, ds) : [{ taskId: null, message: body.reply || 'The planner returned no tasks.' }];
  // Only plans that passed validation are reused (6.3).
  if (tasks.length && !problems.length) await setCachedPlan(key, { tasks, reply: body.reply }).catch(() => {});
  return {
    tasks, reply: body.reply || '', plannedBy: 'ai', problems,
    aiCalls: 1, inputTokens: body.usage?.inputTokens ?? 0, outputTokens: body.usage?.outputTokens ?? 0, cacheHit: false,
  };
}
