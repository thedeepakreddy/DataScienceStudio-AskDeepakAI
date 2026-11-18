/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Dataset } from '../types';
import type { PipelineStage } from '../contexts/PipelineContext';
import { CAPABILITIES as ENGINE_CAPS, engine, type CapabilityName } from '../engine/client';
import { syncDataset } from '../engine/datasetSync';
import { ENGINE_METHODS, GROUP_METHODS, type GroupId } from '../components/stats/methods';
import { columnsFor, type Field, type Method, type Values } from '../components/stats/methodKit';
import { initialValues, problems, toParams } from '../components/stats/MethodPanel';
import { automlHeadline } from '../components/model/AutoMLPanel';
import { explainHeadline } from '../components/model/ExplainPanel';
import { monitorHeadline } from '../components/model/MonitorPanel';
import { addPin, listRuns, type PinView } from '../utils/workspaceStore';
import type { AgentRole } from './agents';
import type { Capability, CapabilityResult, StudioPort } from './catalog';
import { Driver, UiError, findTarget, waitForLoggedRun } from './interaction';
import type { UiPort, UiScript } from './uiScripts';

// The engine's analyses as agent capabilities. Each runs the same engine
// capability with the same parameters as the studio's own form, so an agent's
// result is the one a person would get. On the page, the agent opens the
// method, fills the same fields and presses Run.

/** Which part of the studio each group of methods lives in, and who does it. */
const GROUPS: Record<GroupId, { stage: PipelineStage; tab: string; studio: Capability['studio']; role: AgentRole }> = {
  compare: { stage: 'stats', tab: 'stats-tab-compare', studio: 'Statistics', role: 'statistician' },
  regression: { stage: 'stats', tab: 'stats-tab-regression', studio: 'Statistics', role: 'regression_analyst' },
  causal: { stage: 'stats', tab: 'stats-tab-causal', studio: 'Statistics', role: 'experimentation_scientist' },
  power: { stage: 'stats', tab: 'stats-tab-power', studio: 'Statistics', role: 'experimentation_scientist' },
  survival: { stage: 'stats', tab: 'stats-tab-survival', studio: 'Statistics', role: 'statistician' },
  bayesian: { stage: 'stats', tab: 'stats-tab-bayesian', studio: 'Statistics', role: 'statistician' },
  hypothesis: { stage: 'stats', tab: 'stats-tab-hypothesis', studio: 'Statistics', role: 'statistician' },
  forecast: { stage: 'ml', tab: 'model-tab-forecast', studio: 'Models', role: 'time_series_analyst' },
  decide: { stage: 'ml', tab: 'model-tab-decide', studio: 'Research', role: 'insights_strategist' },
};

const groupOf = (id: string): GroupId | undefined => (Object.keys(GROUP_METHODS) as GroupId[]).find(g => GROUP_METHODS[g].includes(id));

const FILTER_WORDS: Record<string, string> = { numeric: 'numeric column', categorical: 'category column', binary: 'yes/no column', date: 'date column', group: 'group column', any: 'column' };

/** The parameters of a method, described for the AI planner. */
export function describeFields(fields: Field[]): string {
  const parts = fields.map(f => {
    switch (f.kind) {
      case 'column': return `${f.key}${f.optional ? '?' : ''}: string /* ${FILTER_WORDS[f.filter]} */`;
      case 'columns': return `${f.key}${f.min ? '' : '?'}: string[] /* ${FILTER_WORDS[f.filter]}s${f.min ? `, at least ${f.min}` : ''}${f.max ? `, at most ${f.max}` : ''} */`;
      case 'select': return `${f.key}?: ${f.options.map(o => `"${o.value}"`).join('|')}`;
      case 'number': return `${f.key}${f.optional || f.default !== undefined ? '?' : ''}: number${f.default !== undefined ? ` /* default ${f.default} */` : ''}`;
      case 'toggle': return `${f.key}?: boolean`;
      case 'text': return `${f.key}${f.optional || f.default !== undefined ? '?' : ''}: string`;
      case 'arms': return `${f.key}: { name: string, successes: number, trials: number }[]`;
      case 'custom': return `${f.key}?: object /* ${f.label}; leave out to use the example */`;
    }
  });
  return `{ ${parts.join(', ')} }`;
}

/** Form values from an agent's parameters: the method's defaults, overridden by what was given. */
export function valuesFor(m: Method, p: Record<string, unknown>, ds: Dataset | null): Values {
  // Without data, column fields stay empty and everything else takes its default.
  const base = initialValues(m.fields, ds ?? ({ filename: '', rows: [], columns: [], rowCount: 0, originalRowCount: 0 } as Dataset));
  const v: Values = { ...base };
  for (const f of m.fields) {
    const given = p?.[f.key];
    if (f.kind === 'column') v[f.key] = given ?? (f.optional ? '' : base[f.key]);
    else if (given !== undefined) v[f.key] = f.kind === 'number' ? String(given) : given;
  }
  return v;
}

const colName = (ds: Dataset, name: unknown) => (typeof name === 'string' ? ds.columns.find(c => c.name === name)?.name : undefined);

/** Checks an agent's parameters the way the form would. */
export function validateMethod(m: Method, p: Record<string, unknown>, ds: Dataset | null): string | null {
  const needsData = m.fields.some(f => f.kind === 'column' || f.kind === 'columns') || ENGINE_CAPS[m.cap]?.needsDataset;
  if (needsData && !ds) return 'No dataset is loaded.';
  for (const f of m.fields) {
    const given = p?.[f.key];
    if (f.kind === 'column') {
      if (given === undefined || given === '') { if (!f.optional) return `Say which column to use for “${f.label}” (${f.key}).`; continue; }
      if (!colName(ds!, given)) return `There is no column called “${String(given)}”.`;
      if (!columnsFor(ds!, f.filter).includes(String(given))) return `“${String(given)}” can’t be used for “${f.label}” (it needs a ${FILTER_WORDS[f.filter]}).`;
    }
    if (f.kind === 'columns' && given !== undefined) {
      if (!Array.isArray(given)) return `${f.key} must be a list of columns.`;
      for (const c of given) if (!colName(ds!, c)) return `There is no column called “${String(c)}”.`;
    }
    if (f.kind === 'select' && given !== undefined && !f.options.some(o => o.value === given)) return `${f.key} must be one of ${f.options.map(o => o.value).join(', ')}.`;
    if (f.kind === 'number' && given !== undefined && !Number.isFinite(Number(given))) return `${f.key} must be a number.`;
  }
  return problems(m.fields, valuesFor(m, p, ds));
}

/** Runs a method on the engine directly (without the page). */
export async function runMethod(m: Method, p: Record<string, unknown>, port: StudioPort, signal: AbortSignal): Promise<CapabilityResult> {
  const ds = port.getDataset();
  const values = valuesFor(m, p, ds);
  const params = toParams(m, m.fields, values);
  const withData = !!ds && (ENGINE_CAPS[m.cap]?.needsDataset || m.fields.some(f => f.kind === 'column' || f.kind === 'columns'));
  const datasetId = withData ? (await syncDataset(ds!)).id : null;
  const res: any = await engine.runAndWait(m.cap, params as never, { datasetId, signal });
  const summary = m.headline(res, values);
  const view: PinView = { kind: 'method', methodId: m.id, values };
  port.logRun?.({ kind: 'engine', title: m.title, summary, status: 'succeeded', params: { capability: m.cap, params, runId: res.runId, view }, result: res });
  return { summary, data: { capability: m.cap, runId: res.runId, view, result: res } };
}

/** Sets a method's fields on the page the way a person would, then presses Run. */
async function fillAndRun(m: Method, p: Record<string, unknown>, d: Driver, port: UiPort, signal: AbortSignal): Promise<CapabilityResult> {
  const g = GROUPS[groupOf(m.id)!];
  await d.navigate(g.stage, `Opening ${g.stage === 'stats' ? 'Statistics' : 'Model'}`);
  await d.click(g.tab, 'Opening the group');
  if (findTarget(`method-${m.id}`)) await d.click(`method-${m.id}`, m.title);
  await d.claim(`area-${m.id}`, m.title);
  for (const f of m.fields) {
    const given = p?.[f.key];
    if (given === undefined) continue;
    const target = `field-${m.id}-${f.key}`;
    if (f.kind === 'column' || f.kind === 'select') await d.select(target, String(given), `${f.label}: ${String(given)}`);
    else if (f.kind === 'number' || f.kind === 'text') await d.type(target, String(given), `${f.label}: ${String(given)}`);
    else if (f.kind === 'toggle') await d.check(target, !!given, f.label);
    else if (f.kind === 'columns') {
      for (const c of port.getDataset()?.columns ?? []) {
        const chip = findTarget(`${target}-${c.name}`);
        if (!chip) continue;
        const want = (given as string[]).includes(c.name);
        if ((chip.getAttribute('aria-pressed') === 'true') !== want) await d.click(`${target}-${c.name}`, `${want ? 'Using' : 'Not using'} ${c.name}`);
      }
    } else throw new UiError(`“${f.label}” is set directly.`); // custom editors and arms: the direct run does the same work
  }
  const logged = waitForLoggedRun('engine', signal, 600_000);
  await d.click(`${m.id}-run`, 'Run');
  d.release('Waiting for the engine');
  const run: any = await logged;
  d.done(run.summary);
  return { summary: run.summary, data: { capability: m.cap, runId: run.params?.runId, view: run.params?.view, result: run.result } };
}

const engineCheck = (_p: unknown, _b: Dataset | null, _a: Dataset | null, r: CapabilityResult) => {
  const d = r.data as { runId?: string } | undefined;
  return d?.runId ? { ok: true, detail: `Computed by the engine (run ${d.runId}).` } : { ok: false, detail: 'The engine returned no run.' };
};

function methodCapability(m: Method): Capability {
  const g = GROUPS[groupOf(m.id) ?? 'compare'];
  return {
    id: `analysis.${m.id}`,
    studio: g.studio,
    label: () => m.title,
    defaultRole: g.role,
    approval: 'autonomous',
    sideEffect: 'none',
    backend: true,
    idempotent: true,
    step: g.stage,
    timeoutMs: 600_000,
    params: `${describeFields(m.fields)}  // ${m.answers}`,
    validate: (p, ds) => validateMethod(m, p ?? {}, ds),
    run: (p, port, signal) => runMethod(m, p ?? {}, port, signal),
    ui: ((p, d, port, signal) => fillAndRun(m, p ?? {}, d, port, signal)) as UiScript,
    selfCheck: engineCheck,
  };
}

// ------------------------------------------------------------------ model stage
async function syncIfNeeded(port: StudioPort): Promise<string> {
  const ds = port.getDataset();
  if (!ds) throw new Error('No dataset is loaded.');
  return (await syncDataset(ds)).id;
}

async function runCap(name: CapabilityName, params: Record<string, unknown>, port: StudioPort, signal: AbortSignal, withData: boolean) {
  const datasetId = withData ? await syncIfNeeded(port) : null;
  return engine.runAndWait(name, params as never, { datasetId, signal }) as Promise<any>;
}

/** The newest saved model, or the one named. */
async function resolveModel(ref?: string): Promise<string> {
  if (ref) return ref;
  const list = await engine.models.list();
  const latest = list.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))[0];
  if (!latest) throw new Error('There are no saved models yet; train one with AutoML first.');
  return latest.id;
}

const MODEL_CAPS: Capability[] = [
  {
    id: 'models.automl', studio: 'Models', label: p => `Find the best model to predict “${p.target}” (AutoML)`, defaultRole: 'ml_engineer',
    // It saves a model to the registry, so it's approved on its own.
    approval: 'separate', sideEffect: 'model', backend: true, idempotent: false, step: 'ml', timeoutMs: 1_200_000,
    params: '{ target: string, features?: string[], time_budget_s?: 30|120|600, metric?: string, name?: string /* register under this name */ }',
    validate: (p, ds) => (!ds ? 'No dataset is loaded.' : !colName(ds, p?.target) ? `There is no column called “${String(p?.target)}”.`
      : (p?.features ?? []).find((c: string) => !colName(ds, c)) ? `There is no column called “${(p.features as string[]).find(c => !colName(ds, c))}”.` : null),
    run: async (p, port, signal) => {
      const params = { target: p.target, ...(p.features?.length ? { features: p.features } : {}), time_budget_s: p.time_budget_s ?? 120, ...(p.metric ? { metric: p.metric } : {}), ...(p.name ? { name: p.name } : {}) };
      const r = await runCap('ml.automl', params, port, signal, true);
      const summary = automlHeadline(r);
      port.logRun?.({ kind: 'engine', title: `AutoML: predict ${r.target}`, summary, status: 'succeeded', params: { capability: 'ml.automl', params, runId: r.runId, view: { kind: 'automl' } }, result: r });
      return { summary, data: { capability: 'ml.automl', runId: r.runId, view: { kind: 'automl' }, result: r, modelId: r.model?.id } };
    },
    ui: async (p, d, _port, signal) => {
      if (p.features?.length || p.metric) throw new UiError('Chosen features and metrics are set directly.');
      await d.navigate('ml', 'Opening Model');
      await d.click('model-tab-automl', 'AutoML');
      await d.claim('area-automl', `Predicting “${p.target}”`);
      await d.select('automl-target', p.target, `Predict: ${p.target}`);
      if (p.time_budget_s) await d.select('automl-budget', String(p.time_budget_s), 'Search time');
      if (p.name) await d.type('automl-name', p.name, `Save as ${p.name}`);
      const logged = waitForLoggedRun('engine', signal, 1_200_000);
      await d.click('automl-run', 'Find the best model');
      d.release('Waiting for AutoML');
      const run: any = await logged;
      d.done(run.summary);
      return { summary: run.summary, data: { capability: 'ml.automl', runId: run.params?.runId, view: run.params?.view, result: run.result, modelId: run.result?.model?.id } };
    },
    selfCheck: engineCheck,
  },
  {
    id: 'models.explain_engine', studio: 'Models', label: p => `Explain ${p.model ? `the model “${p.model}”` : 'the newest model'}`, defaultRole: 'explainability_analyst',
    approval: 'autonomous', sideEffect: 'none', backend: true, idempotent: true, step: 'ml', timeoutMs: 600_000,
    params: '{ model?: string /* id or name; the newest saved model when left out */ }',
    validate: (_p, ds) => (ds ? null : 'No dataset is loaded.'),
    run: async (p, port, signal) => {
      const params = { model_id: await resolveModel(p.model) };
      const r = await runCap('ml.explain', params, port, signal, true);
      const summary = explainHeadline(r);
      port.logRun?.({ kind: 'engine', title: `Explain ${r.model?.name ?? 'model'}`, summary, status: 'succeeded', params: { capability: 'ml.explain', params, runId: r.runId, view: { kind: 'explain' } }, result: r });
      return { summary, data: { capability: 'ml.explain', runId: r.runId, view: { kind: 'explain' }, result: r } };
    },
    selfCheck: engineCheck,
  },
  {
    id: 'models.monitor', studio: 'Deploy', label: p => `Check ${p.model ? `“${p.model}”` : 'the newest model'} for drift on this data`, defaultRole: 'mlops_engineer',
    approval: 'autonomous', sideEffect: 'none', backend: true, idempotent: true, step: 'ml', timeoutMs: 600_000,
    params: '{ model?: string, target?: string /* the true outcome column, to check accuracy too */ }',
    validate: (p, ds) => (!ds ? 'No dataset is loaded.' : p?.target && !colName(ds, p.target) ? `There is no column called “${p.target}”.` : null),
    run: async (p, port, signal) => {
      const params = { model: await resolveModel(p.model), source: 'dataset', ...(p.target ? { target: p.target } : {}) };
      const r = await runCap('mlops.monitor', params, port, signal, true);
      const summary = monitorHeadline(r);
      port.logRun?.({ kind: 'engine', title: 'Monitor a model', summary, status: 'succeeded', params: { capability: 'mlops.monitor', params, runId: r.runId, view: { kind: 'monitor' } }, result: r });
      return { summary, data: { capability: 'mlops.monitor', runId: r.runId, view: { kind: 'monitor' }, result: r } };
    },
    selfCheck: engineCheck,
  },
  {
    id: 'models.score', studio: 'Deploy', label: p => `Score every row with ${p.model ? `“${p.model}”` : 'the newest model'}`, defaultRole: 'mlops_engineer',
    approval: 'autonomous', sideEffect: 'none', backend: true, idempotent: true, step: 'ml', timeoutMs: 900_000,
    params: '{ model?: string }  // saves a scored copy in the engine; the studio data is unchanged',
    validate: (_p, ds) => (ds ? null : 'No dataset is loaded.'),
    run: async (p, port, signal) => {
      const params = { model_id: await resolveModel(p.model) };
      const r = await runCap('ml.predict', params, port, signal, true);
      const summary = `Scored ${Number(r.rows).toLocaleString()} rows with ${r.model?.name ? `${r.model.name} v${r.model.version}` : 'the model'}.`;
      port.logRun?.({ kind: 'engine', title: 'Score the dataset', summary, status: 'succeeded', params: { capability: 'ml.predict', params, runId: r.runId, view: { kind: 'predict' } }, result: r });
      return { summary, data: { capability: 'ml.predict', runId: r.runId, view: { kind: 'predict' }, result: r, scoredDataset: r.dataset?.id } };
    },
    selfCheck: engineCheck,
  },
  {
    id: 'dashboard.pin', studio: 'Research', label: p => (p.title ? `Pin “${p.title}” to the dashboard` : 'Pin the latest analysis to the dashboard'), defaultRole: 'bi_analyst',
    approval: 'autonomous', sideEffect: 'none', backend: false, idempotent: false, step: 'dashboard', timeoutMs: 30_000,
    params: '{ title?: string /* which analysis, by its title; the latest engine analysis when left out */ }',
    validate: (_p, ds) => (ds ? null : 'No dataset is loaded.'),
    run: async (p, port) => pinLatest(port, p?.title),
    selfCheck: (_p, _b, _a, r) => ((r.data as any)?.pinId ? { ok: true, detail: 'Pinned to the dashboard.' } : { ok: false, detail: 'Nothing was pinned.' }),
  },
];

/** Pins the newest engine analysis (or the newest with that title) to the dashboard. */
export async function pinLatest(port: StudioPort, title?: string): Promise<CapabilityResult> {
  const { datasetId, versionId } = port.getPinTarget?.() ?? { datasetId: null, versionId: null };
  if (!datasetId) throw new Error('Open a dataset first.');
  const runs = await listRuns(200);
  const match = runs.find(r => r.kind === 'engine' && r.status === 'succeeded' && (r.params as any)?.view && (!title || r.title.toLowerCase().includes(title.toLowerCase())));
  if (!match) throw new Error(title ? `No engine analysis called “${title}” has been run yet.` : 'No engine analysis has been run yet.');
  const p = match.params as { capability: string; params: Record<string, unknown>; view: PinView };
  const pin = await addPin({ datasetId, versionId: match.versionId ?? versionId, title: match.title, headline: match.summary, view: p.view, capability: p.capability, params: p.params ?? {}, result: match.result, computedAt: match.createdAt });
  return { summary: `Pinned “${match.title}” to the dashboard.`, data: { pinId: pin.id, title: match.title } };
}

export const ENGINE_AGENT_CAPABILITIES: Capability[] = [
  ...Object.values(ENGINE_METHODS).filter(m => groupOf(m.id)).map(methodCapability),
  ...MODEL_CAPS,
];
