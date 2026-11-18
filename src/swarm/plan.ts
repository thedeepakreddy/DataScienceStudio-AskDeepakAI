/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Dataset } from '../types';
import { isIdentifierColumn } from '../utils/csvParser';
import { AgentRole, isAgentRole } from './agents';
import { CAPABILITIES } from './catalog';
import { clusterColumns } from './findings';

// Task plans (blueprint 5): a request becomes a graph of tasks with
// dependencies, each a contract naming the one capability it may use.

export const LIMITS = {
  /** Most tasks in one plan, including ones added while running. */
  maxTasks: 40,
  /** Most tasks the swarm may add on its own while running (bounded, 4.2). */
  maxDynamicTasks: 14,
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

export { mentionedColumns } from './text';
import { mentionedColumns } from './text';

const has = (text: string, ...words: string[]) => words.some(w => new RegExp(`\\b${w}`, 'i').test(text));

export interface RulePlan { tasks: TaskSpec[]; reply: string }

/**
 * Plans common requests from keywords and the data's columns. Returns no tasks
 * when it can't tell what is wanted, so the AI planner (or the user) decides.
 */
export function rulePlan(request: string, ds: Dataset | null, opts: { hasModel?: boolean; engine?: 'starting' | 'ready' | 'error' } = {}): RulePlan {
  const hasModel = !!opts.hasModel;
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

  const everything = has(text, 'everything', 'full analysis', 'end to end', 'end-to-end', 'complete analysis', 'whole pipeline', 'all (the )?steps', 'analy[sz]e (this|the|my) data');
  const wants = {
    clean: everything || has(text, 'clean', 'prepare', 'tidy', 'fix (the )?data', 'quality'),
    profile: everything || has(text, 'profile', 'overview', 'describe', 'explore'),
    deepEda: everything || has(text, 'deep analysis', 'in depth', 'pandas', 'skew', 'outliers?', 'correlation matrix', 'distributions?'),
    drivers: has(text, 'drives?', 'drivers', 'what (affects|influences|explains|predicts)', 'which (factors|columns|features|variables)', 'key factors', 'why do'),
    test: has(text, 'test', 'significan', 'relationship', 'correlat', 'compare', 'differ', 'associat', 'hypothes'),
    regression: has(text, 'regress'),
    // “Monitor the model for drift” is about a saved model, not training a new one.
    train: everything || (has(text, 'train', 'model', 'predict', 'classif') && !(has(text, 'drift', 'monitor') && !has(text, 'train'))),
    tune: has(text, 'tune', 'tuning', 'optimi[sz]e', 'improve the model', 'hyperparameter'),
    explain: has(text, 'explain', 'feature importance', 'shap', 'what did the model learn'),
    forecast: has(text, 'forecast', 'predict next', 'future', 'next (month|week|quarter|year)'),
    cluster: has(text, 'segment', 'cluster', 'personas', 'groups of (customers|users|people)'),
    // “Pin it to the dashboard” adds to the dashboard; it doesn't redesign it.
    dashboard: everything || (has(text, 'dashboard', 'visuali[sz]', 'charts?') && !(has(text, '\\bpin') && !has(text, '(build|design|make|create) (a |the )?dashboard'))),
    report: everything || has(text, 'report', 'write.?up', 'findings'),
    pdf: everything || has(text, 'pdf'),
    pack: has(text, 'package', 'zip', 'reproducib'),
    // A full analysis uses AutoML on the engine; the quick model only when the engine is down.
    automl: has(text, 'automl', 'auto ml', 'best model', 'compare (all |every )?models', 'every model', 'all models') || (everything && opts.engine !== 'error'),
    monitor: has(text, 'drift', 'monitor') && !has(text, 'retrain'),
    retrain: has(text, 'retrain'),
    pin: has(text, '\\bpin'),
  };

  // The outcome: only when the user names it or a column clearly is one —
  // a confident model of the wrong column is worse than none.
  const target = chooseTarget(request, ds, cols);
  const tcol = target ? ds.columns.find(c => c.name === target) : undefined;
  const skipped: string[] = [];

  let cleanDone: string | undefined;
  if (wants.clean) cleanDone = add('quality.check', {}, 'Find missing values, duplicates, constant and ID columns; fixes are added as tasks for you to approve.');
  const afterClean = cleanDone ? [cleanDone] : [];
  const analyses: string[] = [];

  if (wants.profile) add('explore.profile', {}, 'Summarise size, types, missing cells and outlying values.', afterClean);
  if (wants.deepEda) analyses.push(add('explore.deep_eda', { planModel: !!target && wants.train }, 'Skew, outliers and correlations from the pandas engine on every row.', afterClean));

  // Statistics.
  const numericMentioned = cols.filter(c => ds.columns.find(x => x.name === c)?.type === 'numeric');
  if (wants.regression && cols.length >= 2) {
    analyses.push(add('stats.regression', { outcome: cols[0], predictors: cols.slice(1, 6) }, `Model “${cols[0]}” on ${cols.slice(1, 6).join(', ')} with a regression.`, afterClean));
  } else if (wants.test && !wants.forecast && !wants.drivers && cols.length >= 2) {
    analyses.push(add('stats.compare', { columnA: cols[0], columnB: cols[1] }, `Test whether “${cols[0]}” and “${cols[1]}” are related.`, afterClean));
  } else if ((wants.drivers || everything || (wants.test && !wants.forecast)) && target) {
    analyses.push(add('stats.screen', { target }, `Test “${target}” against every informative column, Holm-corrected, and rank the drivers.`, afterClean));
  } else if (wants.drivers || (wants.test && !wants.forecast)) {
    skipped.push('the drivers screen (name the outcome, e.g. “what drives churn”)');
  }

  // Models.
  let trainId: string | undefined;
  if (wants.forecast || everything) {
    const dateCol = ds.columns.find(c => c.type === 'datetime');
    const value = numericMentioned[0] ?? ds.columns.find(c => c.type === 'numeric' && !isIdentifierColumn(c, ds.rowCount))?.name;
    if (dateCol && value) analyses.push(add('models.forecast', { dateColumn: dateCol.name, valueColumn: value, horizon: 6 }, `Forecast “${value}” from “${dateCol.name}” with backtested methods.`, afterClean));
    else if (wants.forecast) skipped.push('the forecast (it needs a date column and a number)');
  }
  // AutoML on the engine: every model family, tuned and compared; the winner is saved for explaining and monitoring.
  if (wants.automl) {
    if (target) {
      trainId = add('models.automl', { target }, `Try every model family on the engine to predict “${target}”, compare them with intervals and save the best.`, afterClean);
      analyses.push(trainId);
      if (wants.explain || everything) analyses.push(add('models.explain_engine', {}, 'Explain the saved model: what matters overall, per-row reasons and readable rules.', [trainId]));
    } else skipped.push('AutoML (no column looks like an outcome — add “predict <column>”)');
  }
  if (wants.retrain) analyses.push(add('models.retrain', {}, 'Check the newest saved model for drift on this data and retrain it if the data has drifted.', [...afterClean, ...analyses.filter(a => a === trainId)]));
  if (wants.monitor) analyses.push(add('models.monitor', target ? { target } : {}, 'Check the newest saved model for drift on this data.', [...afterClean, ...analyses.filter(a => a === trainId)]));
  if (!wants.automl && (wants.train || wants.tune || (wants.explain && !hasModel)) && !(wants.forecast && !everything && !wants.train)) {
    if (target) {
      const algorithm = /random forest/.test(text) ? 'random_forest' : /xgboost/.test(text) ? 'xgboost' : /gradient boost/.test(text) ? 'gradient_boosting' : /\b(linear|logistic)\b/.test(text) ? 'linear' : /\b(mlp|neural)\b/.test(text) ? 'mlp' : wants.tune ? 'random_forest' : undefined;
      trainId = add('models.train', { target, ...(algorithm ? { algorithm } : {}), ...(wants.tune ? { tune: true } : {}) },
        wants.tune ? `Tune ${algorithm?.replace('_', ' ')} with cross-validated search to predict “${target}”.` : `Train and compare models that predict “${target}”; the winner is chosen by cross-validation.`, afterClean);
      analyses.push(trainId);
    } else if (wants.train || wants.tune) {
      skipped.push('modelling (no column looks like an outcome — add “predict <column>”)');
    }
  }
  // Training adds the explanation itself; explain on its own reads the current model.
  if (wants.explain && !trainId && hasModel && !wants.automl) analyses.push(add('models.explain', {}, 'Read what the current model learned and check for leakage.'));
  if (wants.cluster || everything) {
    const ccols = clusterColumns(ds, numericMentioned.length >= 2 ? numericMentioned : undefined);
    if (ccols.length >= 2) analyses.push(add('models.cluster', numericMentioned.length >= 2 ? { columns: numericMentioned } : {}, `Find natural segments in ${ccols.slice(0, 4).join(', ')}${ccols.length > 4 ? '…' : ''}; the number is chosen by silhouette.`, afterClean));
    else if (wants.cluster) skipped.push('segments (they need at least two informative numeric columns)');
  }

  // A full analysis adds the specialised methods the data clearly fits, each with its reason.
  // They run on the engine, so only when it isn't known to be down.
  if (everything && opts.engine !== 'error') for (const sp of specialisedAnalyses(ds, target)) analyses.push(add(sp.capability, sp.params, sp.why, afterClean));

  // Dashboard: designed from the user's words, after the analyses it can draw on.
  if (wants.dashboard) {
    const design = add('dashboard.design', { focus: request, ...(target ? { target } : {}) }, 'Choose charts, KPIs and filters from your request and the data (chart grammar, no AI call).', [...afterClean, ...analyses]);
    let last = design;
    if (tcol?.type === 'boolean' && (everything || /\bkpis?\b/.test(text) || cols.includes(target!))) {
      const ref = /^[A-Za-z_][A-Za-z0-9_]*$/.test(target!) ? target : `[${target}]`;
      last = add('dashboard.add_kpi', { name: `${target} rate`, formula: `AVG(${ref})`, format: 'percent' }, `Track the ${target} rate as a KPI.`, [design]);
    }
    if (everything || has(text, 'save')) add('dashboard.save', { name: `${titleCase(target ?? ds.filename.replace(/\.[^.]+$/, ''))} — agents` }, 'Save the dashboard so it reopens with this data.', [last]);
  }

  // Pin the engine analysis to the dashboard once it's done.
  if (wants.pin) {
    if (analyses.length) add('dashboard.pin', {}, 'Pin the result to the dashboard so it can be refreshed when the data changes.', [analyses[analyses.length - 1]]);
    else add('dashboard.pin', {}, 'Pin the latest engine analysis to the dashboard.');
  }

  // Report.
  let reportId: string | undefined;
  if (wants.report || wants.pdf || wants.pack) reportId = add('report.build', {}, 'Compile observations, risks and recommendations from the results above.', [...afterClean, ...analyses]);
  if (wants.pdf && reportId) add('report.pdf', {}, 'Download the report as a PDF.', [reportId]);
  if (wants.pack && reportId) add('report.package', {}, 'Download data, lineage, analyses and a notebook in one ZIP.', [reportId]);

  if (tasks.length === 0) return { tasks, reply: skipped.length ? `I couldn’t plan that: ${skipped.join('; ')}.` : '' };
  const roles = [...new Set(tasks.map(t => t.role))].length;
  const steps = [...new Set(tasks.map(t => STEP_LABEL[CAPABILITIES[t.capability].step]))];
  return {
    tasks,
    reply: `I’ve planned ${tasks.length} task${tasks.length === 1 ? '' : 's'} for ${roles} specialist${roles === 1 ? '' : 's'}${steps.length > 1 ? ` across ${steps.join(' → ')}` : ''}.${skipped.length ? ` Skipped ${skipped.join('; ')}.` : ''}`,
  };
}

const STEP_LABEL: Record<string, string> = { ingest: 'Import', clean: 'Clean', eda: 'Explore', stats: 'Statistics', ml: 'Model', dashboard: 'Dashboard', reports: 'Report' };
const titleCase = (s: string) => s.replace(/[_-]+/g, ' ').replace(/\b\w/g, c => c.toUpperCase());

/** Names that usually mean "the outcome". */
export const OUTCOME_RE = /^(y|target|label|class)$|churn|outcome|default|fraud|converted|conversion|survived|attrition|cancel+ed|purchased|clicked|is_?active/i;

/** The outcome column: named by the user, or clearly an outcome; otherwise none. */
export function chooseTarget(request: string, ds: Dataset, cols: string[] = mentionedColumns(request, ds)): string | undefined {
  const after = request.match(/\b(?:predict(?:s|ing)?|target|drives?|drivers of|affects?|influences?|explains?|for)\b(.*)$/i);
  const named = after ? mentionedColumns(after[1], ds)[0] : undefined;
  if (named) return named;
  const outcomeMentioned = cols.find(c => OUTCOME_RE.test(c));
  if (outcomeMentioned) return outcomeMentioned;
  const likely = ds.columns.find(c => OUTCOME_RE.test(c.name) && !isIdentifierColumn(c, ds.rowCount) && c.distinctCount >= 2);
  if (likely) return likely.name;
  // The last column, only if it looks like a label (yes/no or a few categories).
  const last = ds.columns[ds.columns.length - 1];
  if (last && !isIdentifierColumn(last, ds.rowCount) && (last.type === 'boolean' || (last.type === 'categorical' && last.distinctCount >= 2 && last.distinctCount <= 6))) return last.name;
  return undefined;
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
  // "Show only Monthly contracts in the dashboard" / "filter the dashboard to Yearly"
  if (/\bdashboard\b/.test(text) && /\b(only|filter|just|limit)\b/.test(text)) {
    for (const c of ds.columns.filter(c => (c.type === 'categorical' || c.type === 'boolean') && c.distinctCount <= 30)) {
      const values = [...new Set(ds.rows.map(r => String(r[c.name] ?? '')))].filter(v => v && new RegExp(`\\b${v.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i').test(request));
      if (values.length) return [{ capability: 'dashboard.filter', params: { column: c.name, values }, why: `Show only rows where ${c.name} is ${values.join(' or ')}.` }];
    }
  }

  if (/\b(open|go to|show|take me to|switch to|navigate to)\b/.test(text)) {
    const step = STEP_WORDS.find(([re]) => re.test(text))?.[1];
    if (step && !/\b(train|test|forecast|build|run)\b/.test(text)) return [{ capability: 'nav.open_step', params: { step }, why: `Open the ${step} step.` }];
  }
  if (has(text, 'ai scan', 'advisory', 'ai insight', 'ai analysis')) return [{ capability: 'explore.ai_advisory', params: {}, why: 'Run the AI advisory on the dataset.' }];

  // "Load the churn sample"
  const sample = text.match(/\b(churn|saas|hardware)\b.*\bsample|\bsample\b.*\b(churn|saas|hardware)\b/);
  if (sample && /\b(load|open|use|switch|try|start)\b/.test(text)) {
    const name = sample[1] ?? sample[2];
    return [{ capability: 'import.sample', params: { name }, why: `Load the ${name} sample dataset (replaces the current data — Undo can’t bring it back, so it needs its own approval).` }];
  }

  // "Average charges by contract" → a read-only query (the data isn't reshaped).
  const agg = text.match(/\b(average|avg|mean|total|sum|median|max(?:imum)?|min(?:imum)?|count|number of)\b.*\bby\b/);
  if (agg && !/\b(dashboard|chart|plot|train|model|forecast|segment|cluster|test)\b/.test(text)) {
    const metric = cols.find(c => ds.columns.find(x => x.name === c)?.type === 'numeric');
    const dim = cols.find(c => c !== metric && ds.columns.find(x => x.name === c)?.type !== 'numeric') ?? cols.find(c => c !== metric);
    if (dim && (metric || /count|number of/.test(agg[1]))) {
      const q = (n: string) => (/^[A-Za-z_][A-Za-z0-9_]*$/.test(n) ? n : `[${n}]`);
      const fn = /total|sum/.test(agg[1]) ? 'SUM' : /median/.test(agg[1]) ? 'MEDIAN' : /max/.test(agg[1]) ? 'MAX' : /min/.test(agg[1]) ? 'MIN' : /count|number/.test(agg[1]) ? 'COUNT' : 'AVG';
      const value = fn === 'COUNT' || !metric ? 'COUNT(*) AS n' : `${fn}(${q(metric)}) AS ${fn.toLowerCase()}_${metric.replace(/\W+/g, '_')}, COUNT(*) AS n`;
      return [{ capability: 'sql.query', params: { sql: `SELECT ${q(dim)}, ${value} FROM dataset GROUP BY ${q(dim)} ORDER BY 2 DESC` }, why: `Summarise ${metric ?? 'rows'} by ${dim} with a read-only query.` }];
    }
  }
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

const DURATION_RE = /(tenure|duration|days|weeks|months|years|lifetime|time[_ ]?to|survival|age_?at)/i;
const EVENT_RE = /(churn|event|died|death|failed|failure|default|cancel|left|attrition|status|exited|outcome)/i;
const VARIANT_RE = /(variant|group|arm|treatment|experiment|test|cohort|version|bucket|ab)/i;
const METRIC_RE = /(convert|conversion|purchase|click|signup|sign_up|revenue|order|success|bought|subscribed)/i;

/** Free-text columns: mostly distinct values with a typical length of several words. */
export function textColumns(ds: Dataset): string[] {
  return ds.columns.filter(c => {
    if (c.type !== 'categorical' || c.distinctCount < Math.max(10, ds.rowCount * 0.3)) return false;
    const sample = ds.rows.slice(0, 200).map(r => r[c.name]).filter(v => typeof v === 'string') as string[];
    if (!sample.length) return false;
    const words = sample.reduce((n, v) => n + v.trim().split(/\s+/).length, 0) / sample.length;
    return words >= 4;
  }).map(c => c.name);
}

/**
 * The specialised analyses a full analysis adds when the data clearly fits them:
 * text analysis for free-text columns, survival curves for a duration with an
 * event, and an A/B comparison for a variant column with a measurable outcome.
 */
export function specialisedAnalyses(ds: Dataset, target?: string): { capability: string; params: Record<string, unknown>; why: string }[] {
  const out: { capability: string; params: Record<string, unknown>; why: string }[] = [];
  const usable = ds.columns.filter(c => !isIdentifierColumn(c, ds.rowCount));
  const texts = textColumns(ds);
  if (texts[0] && CAPABILITIES['analysis.text-overview']) {
    out.push({ capability: 'analysis.text-overview', params: { column: texts[0] }, why: `“${texts[0]}” is free text: sentiment, keywords and topics.` });
  }
  const duration = usable.find(c => c.type === 'numeric' && DURATION_RE.test(c.name) && c.distinctCount > 5);
  const event = usable.find(c => c.distinctCount === 2 && (c.name === target || EVENT_RE.test(c.name)));
  if (duration && event && CAPABILITIES['analysis.km']) {
    const group = usable.find(c => c.name !== event.name && (c.type === 'categorical' || c.type === 'boolean') && c.distinctCount >= 2 && c.distinctCount <= 6);
    out.push({ capability: 'analysis.km', params: { duration: duration.name, event: event.name, ...(group ? { group: group.name } : {}) },
      why: `“${duration.name}” is a time and “${event.name}” an event: how long until it happens${group ? `, by ${group.name}` : ''}.` });
  }
  const variant = usable.find(c => (c.type === 'categorical' || c.type === 'boolean') && c.distinctCount >= 2 && c.distinctCount <= 5 && VARIANT_RE.test(c.name));
  const metric = variant && usable.find(c => c.name !== variant.name && (c.type === 'numeric' || c.distinctCount === 2) && METRIC_RE.test(c.name));
  if (variant && metric && CAPABILITIES['analysis.ab']) {
    out.push({ capability: 'analysis.ab', params: { variant: variant.name, metric: metric.name }, why: `“${variant.name}” looks like test groups and “${metric.name}” an outcome: compare them as an A/B test.` });
  }
  return out;
}
