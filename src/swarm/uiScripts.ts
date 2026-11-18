/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Dataset } from '../types';
import { OperationId, applyOperation } from '../operations/registry';
import { Driver, UiError, findTarget, waitForLoggedRun } from './interaction';
import type { CapabilityResult, StudioPort } from './catalog';
import { deepEdaResult } from './findings';
import { designDashboard } from './dashboardDesign';

export const DASHBOARD_APPLY_EVENT = 'studio:dashboard-apply';
export const DASHBOARD_APPLIED_EVENT = 'studio:dashboard-applied';

/** Sends a design or filters to the dashboard and waits for its reply (what rendered). */
function applyToDashboard(detail: unknown, signal: AbortSignal): Promise<{ rendered: string[]; expected: string[] }> {
  return new Promise((resolve, reject) => {
    const done = (e: Event) => { cleanup(); resolve((e as CustomEvent).detail); };
    const timer = setTimeout(() => { cleanup(); reject(new UiError('The dashboard didn’t respond (is it open?).')); }, 15_000);
    const onAbort = () => { cleanup(); reject(Object.assign(new Error('Cancelled.'), { cancelled: true })); };
    const cleanup = () => { clearTimeout(timer); window.removeEventListener(DASHBOARD_APPLIED_EVENT, done); signal.removeEventListener('abort', onAbort); };
    window.addEventListener(DASHBOARD_APPLIED_EVENT, done);
    signal.addEventListener('abort', onAbort, { once: true });
    window.dispatchEvent(new CustomEvent(DASHBOARD_APPLY_EVENT, { detail }));
  });
}

const SAMPLE_MATCH: Record<string, string> = { churn: 'churn', saas: 'saas', hardware: 'hardware' };

// How each capability is done on the user's page: open the step, claim the
// card, set the real fields, press the real button, then read the outcome
// from the studio (a new data version, or the run the button logged). The
// buttons call the same operations the swarm would call directly, so the
// result is identical either way.

export interface UiPort extends StudioPort {
  settle: () => Promise<string | null>;
}

export type UiScript = (p: any, d: Driver, port: UiPort, signal: AbortSignal) => Promise<CapabilityResult>;

const pageAlert = () => (typeof document !== 'undefined' ? [...document.querySelectorAll('[role="alert"]')].find(el => !el.closest('[hidden]'))?.textContent?.trim() : undefined);

/** Presses the control that changes the data and confirms a new version was saved. */
async function changeData(d: Driver, port: UiPort, op: OperationId, params: any, press: () => Promise<void>): Promise<CapabilityResult> {
  const before = port.getDataset() as Dataset;
  const v0 = await port.settle();
  await press();
  const v1 = await port.settle();
  if (v1 === v0) {
    const msg = pageAlert();
    d.fail('The change wasn’t applied');
    throw new UiError(msg ? `The page said: ${msg}` : 'The change wasn’t applied.');
  }
  // The summary is the operation's own description of what it did.
  const summary = applyOperation(before, op, params).summary;
  const after = port.getDataset();
  d.done(summary);
  return { summary, data: { rows: after?.rows.length, columns: after?.columns.length, versionId: v1 } };
}

const pf = (p: number) => (p < 0.001 ? '< 0.001' : `= ${p.toFixed(3)}`);

async function moreTool(d: Driver, tab: string, label: string) {
  await d.navigate('clean', 'Opening Clean');
  await d.claim('area-more-tools', label);
  await d.click(`more-tab-${tab}`, `Opening ${tab}`);
}

export const UI_SCRIPTS: Record<string, UiScript> = {
  'nav.open_step': async (p, d) => {
    await d.navigate(p.step, `Opening ${p.step}`);
    d.done(`Opened ${p.step}`);
    return { summary: `Opened ${p.step}.`, data: { step: p.step } };
  },

  'data.fill_missing': async (p, d, port) => {
    await d.navigate('clean', 'Opening Clean');
    await d.claim('area-fill', `Filling “${p.column}”`);
    await d.select('fill-column', p.column, `Choosing “${p.column}”`);
    await d.click(`fill-strategy-${p.strategy}`, `Using the ${p.strategy}`);
    return changeData(d, port, 'fill_missing', p, () => d.click('fill-apply', 'Fill Missing Values'));
  },

  'data.drop_columns': async (p, d, port) => {
    await d.navigate('clean', 'Opening Clean');
    await d.claim('area-remove-columns', 'Removing columns');
    const cols = p.columns as string[];
    if (cols.length !== 1) throw new UiError('Several columns are removed directly.');
    return changeData(d, port, 'drop_columns', p, () => d.click(`remove-column-${cols[0]}`, `Remove “${cols[0]}”`));
  },

  'data.standardize_text': async (p, d, port) => {
    await moreTool(d, 'standardise', `Tidying “${p.column}”`);
    await d.select('std-col', p.column, `Choosing “${p.column}”`);
    await d.select('std-action', 'tidy', 'Tidy text');
    await d.select('std-case', p.case ?? 'none', 'Choosing capitals');
    await d.click('tool-preview', 'Preview');
    return changeData(d, port, 'standardize_text', { trim: true, collapseSpaces: true, ...p }, () => d.click('tool-apply', 'Apply'));
  },

  'data.replace_values': async (p, d, port) => {
    await moreTool(d, 'standardise', `Replacing in “${p.column}”`);
    await d.select('std-col', p.column, `Choosing “${p.column}”`);
    await d.select('std-action', 'replace', 'Replace a value');
    await d.type('rep-from', String(p.from), 'Typing the value to find');
    await d.type('rep-to', String(p.to ?? ''), 'Typing the replacement');
    await d.click('tool-preview', 'Preview');
    return changeData(d, port, 'replace_values', p, () => d.click('tool-apply', 'Apply'));
  },

  'data.convert_type': async (p, d, port) => {
    await moreTool(d, 'standardise', `Changing “${p.column}” to ${p.to}`);
    await d.select('std-col', p.column, `Choosing “${p.column}”`);
    await d.select('std-action', 'type', 'Change the type');
    await d.select('std-type', p.to, `Choosing ${p.to}`);
    await d.click('tool-preview', 'Preview');
    return changeData(d, port, 'convert_type', p, () => d.click('tool-apply', 'Apply'));
  },

  'data.filter_rows': async (p, d, port) => {
    await moreTool(d, 'filter', `Filtering on “${p.column}”`);
    await d.select('f-col', p.column, `Choosing “${p.column}”`);
    await d.select('f-op', p.operator, 'Choosing the condition');
    if (!['is_empty', 'is_not_empty'].includes(p.operator)) await d.type('f-val', String(p.value ?? ''), 'Typing the value');
    await d.click('tool-preview', 'Preview');
    return changeData(d, port, 'filter_rows', p, () => d.click('tool-apply', 'Apply'));
  },

  'data.remove_duplicates': async (_p, d, port) => {
    await moreTool(d, 'duplicates', 'Removing duplicates');
    await d.click('tool-preview', 'Preview');
    return changeData(d, port, 'remove_duplicates', {}, () => d.click('tool-apply', 'Apply'));
  },

  'stats.compare': async (p, d, _port, signal) => {
    await d.navigate('stats', 'Opening Statistics');
    await d.click('stats-tab-compare', 'Compare & relate');
    await d.claim('area-compare', `Testing “${p.columnA}” vs “${p.columnB}”`);
    await d.select('cmp-a', p.columnA, `First column: ${p.columnA}`);
    await d.select('cmp-b', p.columnB, `Second column: ${p.columnB}`);
    if (p.alpha) await d.select('cmp-alpha', String(p.alpha), `Level ${p.alpha}`);
    const result = waitForLoggedRun('hypothesis-test', signal);
    await d.click('cmp-run', 'Run Test');
    d.release('Waiting for the test');
    const run: any = await result;
    const r = run.result ?? {};
    d.done(`p ${pf(r.pValue)}`);
    return {
      summary: `${r.test}: p ${pf(r.pValue)} — ${r.significant ? 'significant' : 'not significant'}${r.effectSize?.value != null ? `; ${r.effectSize.name} ${Number(r.effectSize.value).toFixed(3)} (${r.effectSize.magnitude})` : ''}.`,
      data: r,
    };
  },

  'stats.regression': async (p, d, port, signal) => {
    await d.navigate('stats', 'Opening Statistics');
    await d.click('stats-tab-regression', 'Regression');
    await d.claim('area-regression', `Regressing “${p.outcome}”`);
    await d.select('reg-outcome', p.outcome, `Outcome: ${p.outcome}`);
    if (p.kind) await d.select('reg-kind', p.kind, `${p.kind} model`);
    for (const c of port.getDataset()?.columns ?? []) {
      if (c.name === p.outcome) continue;
      if (findTarget(`reg-pred-${c.name}`)) await d.check(`reg-pred-${c.name}`, (p.predictors as string[]).includes(c.name), `${(p.predictors as string[]).includes(c.name) ? 'Using' : 'Not using'} ${c.name}`);
    }
    const result = waitForLoggedRun('regression', signal);
    await d.click('reg-run', 'Run Regression');
    d.release('Waiting for the fit');
    const run: any = await result;
    d.done(run.summary);
    return { summary: run.summary, data: run.result };
  },

  'stats.power': async (p, d, _port, signal) => {
    await d.navigate('stats', 'Opening Statistics');
    await d.click('stats-tab-power', 'Sample size');
    await d.claim('area-power', 'Planning the sample size');
    await d.select('pw-test', p.test, 'Choosing the design');
    await d.type('pw-effect', String(p.effect), 'Typing the effect size');
    const result = waitForLoggedRun('power', signal);
    await d.click('pw-run', 'Calculate');
    d.release('Waiting for the calculation');
    const run: any = await result;
    d.done(run.summary);
    return { summary: `${run.summary}.`, data: run.result };
  },

  'models.train': async (p, d, port, signal) => {
    if (p.features?.length) throw new UiError('Chosen features are set directly.');
    await d.navigate('ml', 'Opening Model');
    await d.click('model-tab-train', 'Quick model');
    await d.select('ml-target', p.target, `Predict: ${p.target}`);
    if (p.algorithm && p.algorithm !== 'auto') await d.select('ml-algorithm', p.algorithm, `Algorithm: ${p.algorithm}`);
    // Tuning lives in the Expert settings; if it isn't on the page the task
    // falls back to the direct operation (self-healing), which tunes the same way.
    if (p.tune) await d.check('ml-tune', true, 'Tune with cross-validated search');
    const result = waitForLoggedRun('model-training', signal, 600_000);
    await d.click('ml-train', 'Train Model');
    d.release('Waiting for training');
    const run: any = await result;
    // The studio stores the model a moment after logging the run; wait for it
    // so the review that follows checks this model, not an older one.
    const id = run.result?.modelId;
    for (let i = 0; i < 40 && !(port.getModel() && (!id || port.getModel()!.modelId === id)); i++) await new Promise(r => setTimeout(r, 50));
    const m = run.result?.metrics ?? {};
    d.done(run.summary);
    return {
      summary: `${run.result?.algorithm ?? 'Model'}: ${run.summary} on held-out rows${run.result?.tuning?.tuned ? ' (tuned)' : ''}.`,
      data: { algorithm: run.result?.algorithm, metrics: m, cv: run.result?.cv, modelId: run.result?.modelId, leakage: run.result?.leakageWarnings ?? [] },
      followUps: [{ capability: 'models.explain', params: {}, reason: 'Read what the model learned and check for leakage.' }],
    };
  },

  'explore.deep_eda': async (p, d, _port, signal) => {
    await d.navigate('eda', 'Opening Explore');
    await d.click('eda-tab-deepeda', 'Deep Analysis');
    const result = waitForLoggedRun('deep-eda', signal, 180_000);
    await d.click('eda-deep-run', 'Run the pandas analysis');
    d.release('Waiting for the analysis');
    const run: any = await result;
    const r = deepEdaResult(run.result, !!p?.planModel);
    d.done(r.summary.slice(0, 80));
    return r;
  },

  'import.sample': async (p, d, port, signal) => {
    await d.navigate('ingest', 'Opening Import');
    await d.claim('area-samples', 'Samples');
    const before = port.getDataset();
    await d.click(`sample-${p.name}`, `Load the ${p.name} sample`);
    d.wait('Loading the sample');
    for (let i = 0; i < 150; i++) {
      if (signal.aborted) throw Object.assign(new Error('Cancelled.'), { cancelled: true });
      const ds = port.getDataset();
      if (ds && ds !== before && ds.filename.toLowerCase().includes(SAMPLE_MATCH[p.name])) {
        await port.settle();
        d.done(`${ds.rows.length} rows loaded`);
        return { summary: `Loaded ${ds.filename}: ${ds.rows.length.toLocaleString()} rows × ${ds.columns.length} columns.`, data: { filename: ds.filename, rows: ds.rows.length, columns: ds.columns.length } };
      }
      await new Promise(r => setTimeout(r, 100));
    }
    throw new UiError('The sample didn’t load.');
  },

  'dashboard.design': async (p, d, port, signal) => {
    await d.navigate('dashboard', 'Opening Dashboard');
    const ds = port.getDataset()!;
    // The playbook: the user's words and the data decide the charts (no AI call).
    const design = designDashboard(ds, p, port.getModel());
    d.wait(`Designing: ${design.recommendedComponents.filter(c => c.type !== 'Filters Panel').length} components`);
    const reply = await applyToDashboard({ design }, signal);
    // Visit every chart that was placed, with what it answers.
    const charts = design.recommendedComponents.filter(c => c.type !== 'Filters Panel');
    const seen = new Map<string, number>();
    for (const c of charts) {
      const n = (seen.get(c.type) ?? 0) + 1;
      seen.set(c.type, n);
      const id = (n === 1 ? c.type : `${c.type}#${n}`).toLowerCase().replace(/[^a-z0-9]+/g, '-');
      if (findTarget(`dash-chart-${id}`)) await d.claim(`dash-chart-${id}`, `${c.type}: ${c.columnsToUse.slice(0, 2).join(' × ')}`);
    }
    d.done(`${reply.rendered.length} components on the dashboard`);
    return {
      summary: `Built a ${design.detectedProblem.toLowerCase()} dashboard: ${charts.map(c => `${c.type} (${c.columnsToUse.slice(0, 2).join(', ')})`).join('; ')}.`,
      data: { ...design, rendered: reply.rendered, expected: reply.expected },
    };
  },

  'dashboard.filter': async (p, d, port, signal) => {
    await d.navigate('dashboard', 'Opening Dashboard');
    const ds = port.getDataset()!;
    const column = ds.columns.find(c => c.name.toLowerCase() === String(p.column).toLowerCase())!.name;
    // Values are matched to the data's own spelling.
    const present = new Set(ds.rows.map(r => String(r[column] ?? 'Unknown')));
    const values = (p.values as unknown[]).map(v => [...present].find(x => x.toLowerCase() === String(v).toLowerCase())).filter((v): v is string => !!v);
    if (p.values.length && !values.length) throw Object.assign(new Error(`None of ${p.values.join(', ')} appear in “${column}”.`), { permanent: true });
    d.wait(values.length ? `Filter: ${column} = ${values.join(', ')}` : `Clear the ${column} filter`);
    await applyToDashboard({ filters: { [column]: values } }, signal);
    const kept = values.length ? ds.rows.filter(r => values.includes(String(r[column] ?? 'Unknown'))).length : ds.rows.length;
    d.done(`${kept.toLocaleString()} rows in view`);
    return { summary: values.length ? `Showing ${kept.toLocaleString()} rows where ${column} is ${values.join(' or ')}.` : `Cleared the ${column} filter.`, data: { column, values, rows: kept } };
  },

  'models.forecast': async (p, d, _port, signal) => {
    await d.navigate('ml', 'Opening Model');
    await d.claim('area-forecast', `Forecasting “${p.valueColumn}”`);
    await d.select('fc-date', p.dateColumn, `Dates: ${p.dateColumn}`);
    await d.select('fc-value', p.valueColumn, `Value: ${p.valueColumn}`);
    await d.type('fc-h', String(p.horizon ?? 6), 'Periods ahead');
    const result = waitForLoggedRun('forecast', signal);
    await d.click('fc-run', 'Forecast');
    d.release('Waiting for backtesting');
    const run: any = await result;
    d.done(run.summary);
    return { summary: `${run.summary}.`, data: run.result };
  },

  'explore.ai_advisory': async (_p, d, _port, signal) => {
    await d.navigate('eda', 'Opening Explore');
    const result = waitForLoggedRun('ai-advisory', signal);
    await d.click('eda-run-ai', 'Run AI Advisory');
    d.release('Waiting for the advisory');
    const run: any = await result;
    d.done(run.summary);
    return { summary: run.summary, data: { usedAi: run.result?.source !== 'rules', ...run.result } };
  },

  'dashboard.add_kpi': async (p, d) => {
    await d.navigate('dashboard', 'Opening Dashboard');
    await d.click('dash-add-kpi', 'Add KPI');
    await d.type('kpi-name', p.name, 'Naming the KPI');
    await d.type('kpi-formula', p.formula, 'Writing the formula');
    if (p.format) await d.select('kpi-format', p.format, 'Choosing the format');
    await d.click('kpi-add', 'Add KPI');
    if (findTarget('kpi-add')) {
      const msg = pageAlert();
      throw new UiError(msg ? `The page said: ${msg}` : 'The KPI wasn’t added.');
    }
    d.done(`Added “${p.name}”`);
    return { summary: `Added the KPI “${p.name}” (${p.formula}).`, data: { name: p.name, formula: p.formula } };
  },

  'dashboard.save': async (p, d) => {
    await d.navigate('dashboard', 'Opening Dashboard');
    await d.click('dash-save-new', 'Save Dashboard');
    await d.type('dash-name', p.name, 'Naming the dashboard');
    await d.click('dash-save-confirm', 'Save');
    const msg = await d.waitFor('dash-message', 4000);
    d.done(msg.textContent ?? 'Saved');
    return { summary: msg.textContent ?? `Saved “${p.name}”.`, data: { name: p.name } };
  },

  'quality.add_rule': async (p, d) => {
    await moreTool(d, 'rules', `Adding a rule for “${p.column}”`);
    await d.select('r-col', p.column, `Column: ${p.column}`);
    await d.select('r-kind', p.kind, 'Choosing the rule');
    if (p.kind === 'range') {
      if (p.min !== undefined) await d.type('r-min', String(p.min), 'Minimum');
      if (p.max !== undefined) await d.type('r-max', String(p.max), 'Maximum');
    }
    if (p.kind === 'allowed_values') await d.type('r-list', (p.allowed ?? []).join(', '), 'Allowed values');
    if (p.kind === 'pattern') await d.type('r-pattern', p.pattern, 'Pattern');
    await d.click('rule-add', 'Add Rule');
    const msg = pageAlert();
    if (msg && /rule|enter|minimum|pattern|list/i.test(msg)) throw new UiError(`The page said: ${msg}`);
    d.done('Rule added');
    return { summary: `Added a ${p.kind.replace(/_/g, ' ')} rule for “${p.column}”.`, data: p };
  },

  'workflow.save': async (p, d) => {
    await moreTool(d, 'workflows', 'Saving the cleaning steps');
    await d.type('workflow-name', p.name, 'Naming the workflow');
    await d.click('workflow-save', 'Save Workflow');
    d.done(`Saved “${p.name}”`);
    return { summary: `Saved the workflow “${p.name}”.`, data: { name: p.name } };
  },

  'workflow.apply': async (p, d, port) => {
    await moreTool(d, 'workflows', `Running “${p.name}”`);
    const before = port.getDataset();
    const v0 = await port.settle();
    await d.click(`workflow-run-${p.name}`, 'Preview on This Data');
    await d.click('tool-apply', 'Apply');
    const v1 = await port.settle();
    if (v1 === v0) throw new UiError(pageAlert() ?? 'The workflow wasn’t applied.');
    const after = port.getDataset();
    d.done('Workflow applied');
    return { summary: `Ran the workflow “${p.name}”: ${before?.rows.length} → ${after?.rows.length} rows, ${before?.columns.length} → ${after?.columns.length} columns.`, data: { versionId: v1 } };
  },

  'report.pdf': async (_p, d) => {
    await d.navigate('reports', 'Opening Report');
    await d.click('report-pdf', 'Download PDF');
    d.done('PDF downloaded');
    return { summary: 'Downloaded the report as a PDF.', data: { file: 'pdf' } };
  },

  'report.package': async (_p, d) => {
    await d.navigate('reports', 'Opening Report');
    await d.click('report-package', 'Reproducibility Package');
    d.done('Package downloaded');
    return { summary: 'Downloaded the reproducibility package.', data: { file: 'zip' } };
  },

  'deploy.register': async (p, d) => {
    await d.navigate('ml', 'Opening Model');
    await d.click('deploy-tab-models', 'Models');
    if (p.name) await d.type('deploy-name', p.name, 'Naming the model');
    if (p.intendedUse) await d.type('deploy-use', p.intendedUse, 'Intended use');
    await d.click('deploy-register', 'Register Model');
    await d.waitFor('deploy-registered', 4000);
    d.done('Registered');
    return { summary: `Registered the current model${p.name ? ` as “${p.name}”` : ''}.`, data: p };
  },

  'deploy.predict': async (p, d) => {
    await d.navigate('ml', 'Opening Model');
    await d.click('deploy-tab-predict', 'Predict');
    for (const [k, v] of Object.entries(p.values ?? {})) {
      const el = await d.waitFor(`pred-${k}`);
      if (el instanceof HTMLSelectElement) await d.select(`pred-${k}`, String(v), k);
      else await d.type(`pred-${k}`, String(v), k);
    }
    await d.click('deploy-predict', 'Predict');
    const out = await d.waitFor('deploy-prediction', 120_000);
    d.done(out.textContent ?? 'Predicted');
    return { summary: out.textContent?.trim() ?? 'Predicted.', data: { text: out.textContent } };
  },
};
