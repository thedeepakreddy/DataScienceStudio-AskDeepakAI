/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Dataset } from '../types';
import { isIdentifierColumn } from '../utils/csvParser';
import { AgentRole, isAgentRole } from './agents';
import { CAPABILITIES } from './catalog';

// Task plans (blueprint 5): a request becomes a graph of tasks with
// dependencies, each a contract naming the one capability it may use.

export const LIMITS = {
  /** Most tasks in one plan, including ones added while running. */
  maxTasks: 20,
  /** Most tasks the swarm may add on its own while running (bounded, 4.2). */
  maxDynamicTasks: 8,
  /** Backend jobs running at once (the free ML service is small). */
  maxConcurrentBackend: 2,
  maxRetries: 2,
};

export type TaskStatus =
  | 'pending' | 'ready' | 'awaiting_approval' | 'running' | 'blocked' | 'verifying' | 'completed' | 'failed' | 'cancelled';

export interface TaskSpec {
  id: string;
  capability: string;
  params: Record<string, unknown>;
  role: AgentRole;
  dependsOn: string[];
  /** Why this task is in the plan, in plain words. */
  why: string;
  /** Added by the swarm while running (follow-up), not in the approved plan. */
  dynamic?: boolean;
}

export interface PlanProblem { taskId: string | null; message: string }

/** Checks a plan: known capabilities, valid inputs, existing and acyclic dependencies, limits. */
export function validatePlan(tasks: TaskSpec[], ds: Dataset | null): PlanProblem[] {
  const problems: PlanProblem[] = [];
  if (tasks.length === 0) problems.push({ taskId: null, message: 'The plan has no tasks.' });
  if (tasks.length > LIMITS.maxTasks) problems.push({ taskId: null, message: `The plan has ${tasks.length} tasks; the limit is ${LIMITS.maxTasks}.` });
  const ids = new Set<string>();
  for (const t of tasks) {
    if (ids.has(t.id)) problems.push({ taskId: t.id, message: `Duplicate task id “${t.id}”.` });
    ids.add(t.id);
  }
  for (const t of tasks) {
    const cap = CAPABILITIES[t.capability];
    if (!cap) { problems.push({ taskId: t.id, message: `Unknown capability “${t.capability}”.` }); continue; }
    if (cap.approval === 'prohibited') problems.push({ taskId: t.id, message: `“${t.capability}” is not allowed.` });
    if (!isAgentRole(t.role)) problems.push({ taskId: t.id, message: `Unknown role “${t.role}”.` });
    for (const d of t.dependsOn) if (!ids.has(d)) problems.push({ taskId: t.id, message: `Depends on a task that doesn’t exist (“${d}”).` });
    // Inputs are checked against the data the task will see. Tasks after a
    // data change are re-checked just before they run.
    const afterDataChange = tasks.some(o => t.dependsOn.includes(o.id) && CAPABILITIES[o.capability]?.sideEffect === 'new-version');
    if (!afterDataChange) {
      const err = cap.validate(t.params, ds);
      if (err) problems.push({ taskId: t.id, message: err });
    }
  }
  // Cycle check (depth-first).
  const state = new Map<string, 0 | 1 | 2>();
  const byId = new Map(tasks.map(t => [t.id, t]));
  const visit = (id: string): boolean => {
    if (state.get(id) === 1) return true;
    if (state.get(id) === 2) return false;
    state.set(id, 1);
    for (const d of byId.get(id)?.dependsOn ?? []) if (byId.has(d) && visit(d)) return true;
    state.set(id, 2);
    return false;
  };
  for (const t of tasks) if (visit(t.id)) { problems.push({ taskId: t.id, message: 'The plan has a dependency loop.' }); break; }
  return problems;
}

// --- Rule planner: common requests planned without an AI call (6.1) --------

// Lower case, camelCase split, punctuation to spaces: "MonthlyCharges" -> "monthly charges".
const norm = (s: string) => s.replace(/([a-z0-9])([A-Z])/g, '$1 $2').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

/** Columns named in the request, longest names first so "monthly charges" beats "charges". */
export function mentionedColumns(request: string, ds: Dataset): string[] {
  const text = ` ${norm(request)} `;
  const found: { name: string; at: number }[] = [];
  const names = [...ds.columns.map(c => c.name)].sort((a, b) => b.length - a.length);
  let masked = text;
  for (const name of names) {
    const variants = [` ${norm(name)} `, ` ${name.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()} `];
    const n = variants.find(v => v.trim() && masked.includes(v)) ?? variants[0];
    const at = n.trim() ? masked.indexOf(n) : -1;
    if (at >= 0) {
      found.push({ name, at });
      masked = masked.slice(0, at) + ' '.repeat(n.length) + masked.slice(at + n.length);
    }
  }
  return found.sort((a, b) => a.at - b.at).map(f => f.name);
}

const has = (text: string, ...words: string[]) => words.some(w => new RegExp(`\\b${w}`, 'i').test(text));

export interface RulePlan { tasks: TaskSpec[]; reply: string }

/**
 * Plans common requests from keywords and the data's columns. Returns no tasks
 * when it can't tell what is wanted, so the AI planner (or the user) decides.
 */
export function rulePlan(request: string, ds: Dataset | null): RulePlan {
  const text = request.toLowerCase();
  if (!ds) return { tasks: [], reply: 'Import a dataset first, then tell me what you need.' };
  const cols = mentionedColumns(request, ds);
  const tasks: TaskSpec[] = [];
  const add = (capability: string, params: Record<string, unknown>, why: string, dependsOn: string[] = []) => {
    const id = `t${tasks.length + 1}`;
    tasks.push({ id, capability, params, role: CAPABILITIES[capability].defaultRole, dependsOn, why });
    return id;
  };
  // Direct commands ("drop the X column", "fill missing values with mean",
  // "open the dashboard") are planned exactly, before the broader keywords.
  const direct = commandPlan(request, text, ds, cols);
  if (direct.length) {
    direct.forEach((d, i) => add(d.capability, d.params, d.why, i > 0 && CAPABILITIES[d.capability].sideEffect === 'new-version' ? [`t${i}`] : []));
    return { tasks, reply: tasks.length === 1 ? `I’ll ${tasks[0].why.charAt(0).toLowerCase()}${tasks[0].why.slice(1)}` : `I’ve planned ${tasks.length} tasks.` };
  }

  const everything = has(text, 'everything', 'full analysis', 'end to end', 'end-to-end', 'complete analysis', 'whole pipeline', 'analy[sz]e (this|the|my) data');

  const wantsClean = everything || has(text, 'clean', 'prepare', 'tidy', 'fix (the )?data', 'quality');
  const wantsProfile = everything || has(text, 'profile', 'explore', 'overview', 'describe', 'eda');
  const wantsTest = has(text, 'test', 'significan', 'relationship', 'correlat', 'compare', 'differ', 'associat', 'hypothes');
  const wantsTrain = everything || has(text, 'train', 'model', 'predict', 'classif');
  const wantsForecast = has(text, 'forecast', 'predict next', 'future');
  const wantsReport = everything || has(text, 'report', 'summar');
  const wantsDashboard = has(text, 'dashboard');

  // Target: the column named after "predict"/"target"/"for", else an
  // outcome-like mentioned column, else an outcome-like column, else the last.
  const outcomeRe = /(target|label|churn|outcome|default|fraud|converted|survived|y)$/i;
  const afterPredict = (() => {
    const m = request.match(/\b(?:predict(?:s|ing)?|target|forecast(?:ing)?)\b(.*)$/i);
    return m ? mentionedColumns(m[1], ds)[0] : undefined;
  })();
  const outcomeLike = ds.columns.find(c => outcomeRe.test(c.name));
  const target = afterPredict ?? cols.find(c => outcomeRe.test(c)) ?? cols[0] ?? outcomeLike?.name ?? ds.columns[ds.columns.length - 1]?.name;

  let cleanDone: string | undefined;
  if (wantsClean) cleanDone = add('quality.check', {}, 'Find missing values, duplicates and constant columns; fixes are added as follow-up tasks.');
  const afterClean = cleanDone ? [cleanDone] : [];

  if (wantsProfile) add('explore.profile', {}, 'Summarise the data.', afterClean);

  const analyses: string[] = [];
  if (wantsTest && !wantsForecast) {
    if (cols.length >= 2) {
      analyses.push(add('stats.compare', { columnA: cols[0], columnB: cols[1] }, `Test whether “${cols[0]}” and “${cols[1]}” are related.`, afterClean));
    } else if (target) {
      // Test the outcome against up to three other informative columns.
      const others = ds.columns
        .filter(c => c.name !== target && !isIdentifierColumn(c, ds.rowCount) && c.type !== 'datetime' && c.distinctCount > 1)
        .slice(0, 3);
      for (const o of others) analyses.push(add('stats.compare', { columnA: o.name, columnB: target }, `Test whether “${o.name}” relates to “${target}”.`, afterClean));
    }
  } else if (everything && target) {
    const other = ds.columns.find(c => c.name !== target && c.type === 'numeric' && !isIdentifierColumn(c, ds.rowCount));
    if (other) analyses.push(add('stats.compare', { columnA: other.name, columnB: target }, `Test whether “${other.name}” relates to “${target}”.`, afterClean));
  }

  if (wantsForecast) {
    const dateCol = ds.columns.find(c => c.type === 'datetime');
    const value = cols.find(c => ds.columns.find(x => x.name === c)?.type === 'numeric') ?? ds.columns.find(c => c.type === 'numeric')?.name;
    if (dateCol && value) analyses.push(add('models.forecast', { dateColumn: dateCol.name, valueColumn: value, horizon: 6 }, `Forecast “${value}” from “${dateCol.name}”.`, afterClean));
  } else if (wantsTrain && target) {
    analyses.push(add('models.train', { target }, `Train and compare models that predict “${target}”.`, afterClean));
  }

  if (wantsReport) add('report.build', {}, 'Compile findings, risks and recommendations from the results.', [...afterClean, ...analyses]);
  if (wantsDashboard) add('nav.open_step', { step: 'dashboard' }, 'Open the dashboard.', tasks.map(t => t.id));

  if (tasks.length === 0) return { tasks, reply: '' };
  const roles = [...new Set(tasks.map(t => t.role))].length;
  return { tasks, reply: `I’ve planned ${tasks.length} task${tasks.length === 1 ? '' : 's'} for ${roles} specialist${roles === 1 ? '' : 's'}.` };
}

const STEP_WORDS: [RegExp, string][] = [
  [/\b(import|upload)\b/, 'ingest'], [/\bclean(ing)?\b/, 'clean'], [/\b(explore|eda)\b/, 'eda'],
  [/\bstat(istic)?s?\b/, 'stats'], [/\b(model|ml|training)\b/, 'ml'], [/\bdashboard\b/, 'dashboard'], [/\breports?\b/, 'reports'],
];

type Direct = { capability: string; params: Record<string, unknown>; why: string };

/** Exact single commands. Returns nothing when the request isn't one. */
function commandPlan(request: string, text: string, ds: Dataset, cols: string[]): Direct[] {
  const out: Direct[] = [];
  if (/^\s*(select|with)\b/i.test(request)) return [{ capability: 'sql.query', params: { sql: request.trim() }, why: 'Run your SQL query on the data.' }];
  if (has(text, 'reset', 'restore (the )?(original|data)', 'undo everything')) return [{ capability: 'data.reset', params: {}, why: 'Restore the data as it was imported.' }];

  if (cols.length && /\b(drop|remove|delete)\b/.test(text) && /\bcolumns?\b/.test(text)) {
    return [{ capability: 'data.drop_columns', params: { columns: cols }, why: `Remove ${cols.map(c => `“${c}”`).join(', ')}.` }];
  }
  if (/\b(remove|drop|delete|dedupe|de-duplicate)\b.*\bduplicat/.test(text) || /^\s*dedupe/.test(text)) {
    return [{ capability: 'data.remove_duplicates', params: {}, why: 'Remove duplicate rows.' }];
  }
  if (/\b(fill|impute)\b/.test(text) && /\b(missing|empty|blank|null|nan|gaps?)\b/.test(text)) {
    const strategy = /\bmedian\b/.test(text) ? 'median' : /\b(mode|most common|most frequent)\b/.test(text) ? 'mode' : /\b(zero|0)\b/.test(text) ? 'zero' : 'mean';
    const targets = (cols.length ? cols : ds.columns.filter(c => c.missingCount > 0).map(c => c.name));
    for (const c of targets) {
      const column = ds.columns.find(x => x.name === c)!;
      if (!column.missingCount) continue;
      // Averages only make sense for numbers; text columns get the most common value.
      const s = column.type !== 'numeric' && (strategy === 'mean' || strategy === 'median') ? 'mode' : strategy;
      out.push({ capability: 'data.fill_missing', params: { column: c, strategy: s }, why: `Fill the missing values in “${c}” with the ${s === 'zero' ? 'value 0' : s}.` });
    }
    return out.slice(0, 12);
  }
  if (/\b(open|go to|show|take me to|switch to|navigate to)\b/.test(text)) {
    const step = STEP_WORDS.find(([re]) => re.test(text))?.[1];
    if (step && !/\b(train|test|forecast|build|run)\b/.test(text)) return [{ capability: 'nav.open_step', params: { step }, why: `Open the ${step} step.` }];
  }
  if (has(text, 'ai scan', 'advisory', 'ai insight', 'ai analysis')) return [{ capability: 'explore.ai_advisory', params: {}, why: 'Run the AI advisory on the dataset.' }];
  return out;
}

/** Normalises a plan from the AI planner into task specs (ids, defaults). */
export function normaliseAiTasks(raw: unknown): TaskSpec[] {
  if (!Array.isArray(raw)) return [];
  return raw.slice(0, LIMITS.maxTasks).map((t: any, i) => ({
    id: typeof t?.id === 'string' && t.id ? t.id.slice(0, 40) : `t${i + 1}`,
    capability: String(t?.capability ?? ''),
    params: t?.params && typeof t.params === 'object' && !Array.isArray(t.params) ? t.params : {},
    role: isAgentRole(t?.role) ? t.role : (CAPABILITIES[String(t?.capability)]?.defaultRole ?? 'orchestrator'),
    dependsOn: Array.isArray(t?.dependsOn) ? t.dependsOn.map(String) : [],
    why: typeof t?.why === 'string' ? t.why.slice(0, 200) : '',
  }));
}
