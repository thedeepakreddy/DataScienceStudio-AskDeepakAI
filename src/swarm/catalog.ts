/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Dataset, MLResult } from '../types';
import type { PipelineStage } from '../contexts/PipelineContext';
import { STAGE_ORDER } from '../stages';
import {
  AppliedOperation, OPERATIONS, OperationError, OperationId, OperationParams, applyOperation,
} from '../operations/registry';
import { isEmpty } from '../utils/columnProfile';
import { isIdentifierColumn } from '../utils/csvParser';
import { detectDuplicateRecords, findExtremeOutliers } from '../utils/edaEngine';
import { computeReportFindings } from '../utils/reportFindings';
import { runReadOnlySql } from '../utils/safeSql';
import type { AgentRole } from './agents';

// The capability catalog: every studio action the swarm may take (blueprint
// 5.3). Each one calls the same code the studio's own buttons use - the
// operation registry, the Python service or the shared analysis utilities -
// so there is no agent-only version of any feature (2.4, 5.5).

export const CATALOG_VERSION = 1;

/** How much an action changes, which decides whether it needs approval (10.1). */
export type ApprovalClass = 'autonomous' | 'batch' | 'separate' | 'prohibited';
export type SideEffect = 'none' | 'new-version' | 'model' | 'navigation';

/** What the studio lends the swarm. Implemented by the App. */
export interface StudioPort {
  getDataset: () => Dataset | null;
  /** Saves a new data version (the same path as the Clean step). */
  commitDataset: (ds: Dataset, op: AppliedOperation | undefined, summary: string) => void;
  openStep: (step: PipelineStage) => void;
  train: (target: string, features: string[], modelType: 'classification' | 'regression', hyperparameters: Record<string, unknown>) => Promise<MLResult>;
  getModel: () => MLResult | null;
  /** Calls the studio's API (counts as a job; abortable). */
  api: (url: string, body: unknown, signal?: AbortSignal) => Promise<any>;
}

export interface CapabilityResult {
  summary: string;
  /** Structured result kept as evidence. */
  data?: unknown;
  /** Suggested follow-up tasks (bounded dynamic planning, 5.2). */
  followUps?: { capability: string; params: Record<string, unknown>; reason: string }[];
}

export interface Capability {
  id: string;
  studio: 'Data' | 'Explore' | 'Statistics' | 'Models' | 'Deploy' | 'Research';
  label: (p: any) => string;
  /** Which specialist usually does it (expertise, not permission). */
  defaultRole: AgentRole;
  approval: ApprovalClass;
  sideEffect: SideEffect;
  /** Runs on the Python service (can run in parallel with browser work). */
  backend: boolean;
  /** Safe to run again after an interruption without a duplicate effect. */
  idempotent: boolean;
  /** Which step the work happens on (for the on-page view). */
  step: PipelineStage;
  timeoutMs: number;
  /** Parameter description given to the AI planner. */
  params: string;
  validate: (p: any, ds: Dataset | null) => string | null;
  run: (p: any, port: StudioPort, signal: AbortSignal) => Promise<CapabilityResult>;
  /** The producing agent's own check of its output (labelled self-check, 9.3). */
  selfCheck: (p: any, before: Dataset | null, after: Dataset | null, result: CapabilityResult) => { ok: boolean; detail: string };
}

const col = (ds: Dataset | null, name: unknown) =>
  typeof name === 'string' ? ds?.columns.find(c => c.name === name || c.name.toLowerCase() === name.toLowerCase())?.name : undefined;

const requireCols = (ds: Dataset | null, names: unknown[]): string | null => {
  if (!ds) return 'No dataset is loaded.';
  for (const n of names) if (!col(ds, n)) return `There is no column called “${String(n)}”.`;
  return null;
};

// --- Data operations: one capability per registry operation ---------------

const DATA_OPS: Partial<Record<OperationId, { label: (p: any) => string; params: string; columns: (p: any) => unknown[] }>> = {
  drop_columns: { label: p => `Remove ${p.columns?.length === 1 ? `the column “${p.columns[0]}”` : `${p.columns?.length} columns`}`, params: '{ columns: string[] }', columns: p => p.columns ?? [] },
  rename_column: { label: p => `Rename “${p.from}” to “${p.to}”`, params: '{ from: string, to: string }', columns: p => [p.from] },
  fill_missing: { label: p => `Fill missing values in “${p.column}” (${p.strategy})`, params: '{ column: string, strategy: "mean"|"median"|"mode"|"zero" }', columns: p => [p.column] },
  filter_rows: { label: p => `Keep rows where “${p.column}” ${String(p.operator).replace(/_/g, ' ')} ${p.value ?? ''}`.trim(), params: '{ column: string, operator: "equals"|"not_equals"|"greater_than"|"less_than"|"contains"|"is_empty"|"is_not_empty", value?: string|number }', columns: p => [p.column] },
  remove_duplicates: { label: () => 'Remove duplicate rows', params: '{}', columns: () => [] },
  standardize_text: { label: p => `Tidy the text in “${p.column}”`, params: '{ column: string, case?: "none"|"lower"|"upper"|"title" }', columns: p => [p.column] },
  replace_values: { label: p => `Replace “${p.from}” with “${p.to}” in “${p.column}”`, params: '{ column: string, from: string, to: string }', columns: p => [p.column] },
  convert_type: { label: p => `Change “${p.column}” to ${p.to}`, params: '{ column: string, to: "numeric"|"categorical"|"boolean"|"datetime" }', columns: p => [p.column] },
  derive_column: { label: p => `Create a ${p.transform} column from “${p.source}”`, params: '{ source: string, transform: "log"|"sqrt"|"square"|"minmax"|"standard"|"multiply"|"divide", other?: string, name?: string }', columns: p => [p.source, ...(p.other ? [p.other] : [])] },
  one_hot_encode: { label: p => `Split “${p.column}” into yes/no columns`, params: '{ column: string }', columns: p => [p.column] },
};

function dataCapability(op: OperationId): Capability {
  const meta = DATA_OPS[op]!;
  return {
    id: `data.${op}`,
    studio: 'Data',
    label: meta.label,
    defaultRole: 'data_engineer',
    // Every change makes a new version that Undo can return from, so a group
    // of them can be approved together (10.1 batch-approvable).
    approval: 'batch',
    sideEffect: 'new-version',
    backend: false,
    idempotent: false,
    step: 'clean',
    timeoutMs: 30_000,
    params: meta.params,
    validate: (p, ds) => {
      const missing = requireCols(ds, meta.columns(p ?? {}));
      if (missing) return missing;
      try {
        applyOperation(ds!, op, p);
        return null;
      } catch (err) {
        return err instanceof OperationError ? err.message : String((err as Error).message ?? err);
      }
    },
    run: async (p, port) => {
      const ds = port.getDataset();
      if (!ds) throw new OperationError('No dataset is loaded.');
      const r = applyOperation(ds, op, p as OperationParams[typeof op]);
      port.commitDataset(r.dataset, { op, params: p } as AppliedOperation, r.summary);
      return { summary: r.summary, data: { rows: r.dataset.rows.length, columns: r.dataset.columns.length } };
    },
    selfCheck: (p, before, after) => {
      if (!after || !before) return { ok: false, detail: 'No data after the change.' };
      if (op === 'fill_missing') {
        const left = after.rows.filter(r => isEmpty(r[col(after, p.column) ?? p.column])).length;
        return left === 0 ? { ok: true, detail: `No missing values left in “${p.column}”.` } : { ok: false, detail: `${left} values are still missing.` };
      }
      if (op === 'drop_columns') {
        const still = (p.columns as string[]).filter(c => col(after, c));
        return still.length ? { ok: false, detail: `Still present: ${still.join(', ')}.` } : { ok: true, detail: `Removed; ${after.columns.length} columns remain.` };
      }
      if (op === 'remove_duplicates') {
        const dups = detectDuplicateRecords(after.rows).length;
        return dups === 0 ? { ok: true, detail: `No duplicates left; ${after.rows.length} rows.` } : { ok: false, detail: `${dups} duplicate groups remain.` };
      }
      return { ok: true, detail: `Data is now ${after.rows.length.toLocaleString()} rows × ${after.columns.length} columns.` };
    },
  };
}

// --- Other capabilities ------------------------------------------------------

const passthroughCheck = (_p: unknown, _b: Dataset | null, _a: Dataset | null, r: CapabilityResult) =>
  r.data !== undefined ? { ok: true, detail: 'Result produced by the studio engine.' } : { ok: false, detail: 'No result was produced.' };

const OTHER: Capability[] = [
  {
    id: 'nav.open_step', studio: 'Research', label: p => `Open the ${p.step} step`, defaultRole: 'orchestrator',
    approval: 'autonomous', sideEffect: 'navigation', backend: false, idempotent: true, step: 'ingest', timeoutMs: 5_000,
    params: `{ step: ${STAGE_ORDER.map(s => `"${s}"`).join('|')} }`,
    validate: p => (STAGE_ORDER.includes(p?.step) ? null : `There is no “${p?.step}” step.`),
    run: async (p, port) => { port.openStep(p.step); return { summary: `Opened ${p.step}.`, data: { step: p.step } }; },
    selfCheck: passthroughCheck,
  },
  {
    id: 'explore.profile', studio: 'Explore', label: () => 'Profile the dataset', defaultRole: 'data_scientist',
    approval: 'autonomous', sideEffect: 'none', backend: false, idempotent: true, step: 'eda', timeoutMs: 20_000, params: '{}',
    validate: (_p, ds) => (ds ? null : 'No dataset is loaded.'),
    run: async (_p, port) => {
      const ds = port.getDataset()!;
      const numeric = ds.columns.filter(c => c.type === 'numeric');
      const missing = ds.columns.reduce((a, c) => a + c.missingCount, 0);
      const outliers = findExtremeOutliers(ds.rows, ds.columns).reduce((a, o) => a + o.outliers.length, 0);
      return {
        summary: `${ds.rows.length.toLocaleString()} rows × ${ds.columns.length} columns (${numeric.length} numeric); ${missing} missing cells; ${outliers} outlying values.`,
        data: { rows: ds.rows.length, columns: ds.columns.length, numeric: numeric.length, missingCells: missing, outliers },
      };
    },
    selfCheck: passthroughCheck,
  },
  {
    id: 'quality.check', studio: 'Data', label: () => 'Check data quality', defaultRole: 'data_quality',
    approval: 'autonomous', sideEffect: 'none', backend: false, idempotent: true, step: 'clean', timeoutMs: 20_000, params: '{}',
    validate: (_p, ds) => (ds ? null : 'No dataset is loaded.'),
    run: async (_p, port) => {
      const ds = port.getDataset()!;
      const issues: string[] = [];
      const followUps: CapabilityResult['followUps'] = [];
      const dupRows = detectDuplicateRecords(ds.rows).reduce((a, g) => a + g.indices.length - 1, 0);
      if (dupRows) {
        issues.push(`${dupRows} duplicate rows`);
        followUps.push({ capability: 'data.remove_duplicates', params: {}, reason: `${dupRows} rows are exact duplicates.` });
      }
      const constant = ds.columns.filter(c => c.distinctCount <= 1 && ds.rows.length > 1).map(c => c.name);
      if (constant.length) {
        issues.push(`constant columns: ${constant.join(', ')}`);
        followUps.push({ capability: 'data.drop_columns', params: { columns: constant }, reason: 'These columns have a single value and carry no information.' });
      }
      for (const c of ds.columns.filter(c => c.missingCount > 0)) {
        const share = c.missingCount / ds.rows.length;
        issues.push(`“${c.name}” ${Math.round(share * 100)}% missing`);
        if (share < 0.5 && !constant.includes(c.name)) {
          followUps.push({
            capability: 'data.fill_missing',
            params: { column: c.name, strategy: c.type === 'numeric' ? 'median' : 'mode' },
            reason: `${c.missingCount} missing values (${Math.round(share * 100)}%).`,
          });
        }
      }
      const ids = ds.columns.filter(c => isIdentifierColumn(c, ds.rowCount)).map(c => c.name);
      if (ids.length) issues.push(`ID-like columns (exclude from models): ${ids.join(', ')}`);
      return {
        summary: issues.length ? `Found ${issues.join('; ')}.` : 'No missing values, duplicates or constant columns found.',
        data: { duplicateRows: dupRows, constantColumns: constant, idColumns: ids, missing: ds.columns.filter(c => c.missingCount).map(c => ({ column: c.name, count: c.missingCount })) },
        followUps,
      };
    },
    selfCheck: passthroughCheck,
  },
  {
    id: 'stats.compare', studio: 'Statistics', label: p => `Test “${p.columnA}” against “${p.columnB}”`, defaultRole: 'statistician',
    approval: 'autonomous', sideEffect: 'none', backend: true, idempotent: true, step: 'stats', timeoutMs: 90_000,
    params: '{ columnA: string, columnB: string, alpha?: number }',
    validate: (p, ds) => requireCols(ds, [p?.columnA, p?.columnB]) ?? (col(ds, p.columnA) === col(ds, p.columnB) ? 'Choose two different columns.' : null),
    run: async (p, port, signal) => {
      const ds = port.getDataset()!;
      const a = col(ds, p.columnA)!;
      const b = col(ds, p.columnB)!;
      const body = await port.api('/api/stats/compare', { data: ds.rows.map(r => ({ [a]: r[a], [b]: r[b] })), columnA: a, columnB: b, alpha: p.alpha ?? 0.05 }, signal);
      const pv = typeof body.pValue === 'number' ? (body.pValue < 0.001 ? '< 0.001' : body.pValue.toFixed(3)) : '—';
      return { summary: `${body.test}: p ${pv.startsWith('<') ? pv : `= ${pv}`} — ${body.significant ? 'significant' : 'not significant'}${body.effectSize?.value != null ? `; ${body.effectSize.name} ${Number(body.effectSize.value).toFixed(3)} (${body.effectSize.magnitude})` : ''}.`, data: body };
    },
    selfCheck: (_p, _b, _a, r) => {
      const d = r.data as any;
      return typeof d?.pValue === 'number' && d.pValue >= 0 && d.pValue <= 1
        ? { ok: true, detail: `p-value in range; ${d.rowsUsed} rows used; ${(d.assumptions ?? []).filter((x: any) => x.passed === false).length} assumption(s) not met.` }
        : { ok: false, detail: 'The test returned no valid p-value.' };
    },
  },
  {
    id: 'stats.regression', studio: 'Statistics', label: p => `Regress “${p.outcome}” on ${p.predictors?.length ?? 0} columns`, defaultRole: 'statistician',
    approval: 'autonomous', sideEffect: 'none', backend: true, idempotent: true, step: 'stats', timeoutMs: 90_000,
    params: '{ outcome: string, predictors: string[], kind?: "linear"|"logistic" }',
    validate: (p, ds) => requireCols(ds, [p?.outcome, ...(p?.predictors ?? [])]) ?? (!p.predictors?.length ? 'Choose at least one predictor.' : null),
    run: async (p, port, signal) => {
      const ds = port.getDataset()!;
      const cols = [col(ds, p.outcome)!, ...p.predictors.map((x: string) => col(ds, x)!)];
      const outcomeCol = ds.columns.find(c => c.name === cols[0])!;
      const kind = p.kind ?? (outcomeCol.type === 'numeric' && outcomeCol.distinctCount > 2 ? 'linear' : 'logistic');
      const body = await port.api('/api/stats/regression', { data: ds.rows.map(r => Object.fromEntries(cols.map(c => [c, r[c]]))), outcome: cols[0], predictors: cols.slice(1), kind }, signal);
      const fit = kind === 'linear' ? `R² ${Number(body.fit.rSquared).toFixed(3)}` : `pseudo R² ${Number(body.fit.pseudoRSquared).toFixed(3)}`;
      return { summary: `${kind === 'linear' ? 'Linear' : 'Logistic'} regression: ${fit} on ${body.n} rows.`, data: body };
    },
    selfCheck: (_p, _b, _a, r) => ((r.data as any)?.coefficients?.length ? { ok: true, detail: 'Coefficients and fit statistics returned.' } : { ok: false, detail: 'No coefficients returned.' }),
  },
  {
    id: 'models.train', studio: 'Models', label: p => `Train a model to predict “${p.target}”`, defaultRole: 'ml_engineer',
    approval: 'autonomous', sideEffect: 'model', backend: true, idempotent: true, step: 'ml', timeoutMs: 600_000,
    params: '{ target: string, features?: string[], algorithm?: "auto"|"random_forest"|"gradient_boosting"|"xgboost"|"linear"|"mlp", seed?: number }',
    validate: (p, ds) => requireCols(ds, [p?.target, ...(p?.features ?? [])]),
    run: async (p, port) => {
      const ds = port.getDataset()!;
      const target = col(ds, p.target)!;
      const tcol = ds.columns.find(c => c.name === target)!;
      const features = (p.features?.length ? p.features.map((f: string) => col(ds, f)!) : ds.columns.filter(c => c.name !== target && !isIdentifierColumn(c, ds.rowCount) && c.type !== 'datetime').map(c => c.name)) as string[];
      const modelType = tcol.type === 'numeric' && tcol.distinctCount > 15 ? 'regression' : 'classification';
      const result = await port.train(target, features, modelType, { selectedAlgorithmId: p.algorithm ?? 'auto', seed: p.seed ?? 42 });
      const m = result.metrics || {};
      const score = modelType === 'classification' ? `accuracy ${((m.accuracy ?? 0) * 100).toFixed(1)}%` : `R² ${(m.r2Score ?? 0).toFixed(3)}`;
      return { summary: `${result.modelAlgorithm}: ${score} on held-out rows.`, data: { algorithm: result.modelAlgorithm, metrics: m, cv: result.cv, modelId: result.modelId, leakage: result.leakageWarnings ?? [] } };
    },
    selfCheck: (_p, _b, _a, r) => {
      const d = r.data as any;
      if (!d?.metrics || Object.keys(d.metrics).length === 0) return { ok: false, detail: 'No metrics returned.' };
      if (d.leakage?.length) return { ok: false, detail: `Possible leakage: ${d.leakage.map((l: any) => l.column).join(', ')}.` };
      return { ok: true, detail: `Evaluated on held-out rows${d.cv?.mean != null ? `; cross-validation ${Number(d.cv.mean).toFixed(3)} ± ${Number(d.cv.std).toFixed(3)}` : ''}.` };
    },
  },
  {
    id: 'models.forecast', studio: 'Models', label: p => `Forecast “${p.valueColumn}” ${p.horizon ?? 6} periods ahead`, defaultRole: 'data_scientist',
    approval: 'autonomous', sideEffect: 'none', backend: true, idempotent: true, step: 'ml', timeoutMs: 120_000,
    params: '{ dateColumn: string, valueColumn: string, horizon?: number }',
    validate: (p, ds) => requireCols(ds, [p?.dateColumn, p?.valueColumn]),
    run: async (p, port, signal) => {
      const ds = port.getDataset()!;
      const d = col(ds, p.dateColumn)!;
      const v = col(ds, p.valueColumn)!;
      const body = await port.api('/api/forecast', { data: ds.rows.map(r => ({ [d]: r[d], [v]: r[v] })), date_column: d, value_column: v, horizon: p.horizon ?? 6 }, signal);
      return { summary: `${body.bestLabel} chosen by backtesting (MAE ${Number(body.leaderboard[0].mae).toFixed(2)}); next ${body.horizon} ${body.frequency}s forecast.`, data: body };
    },
    selfCheck: (_p, _b, _a, r) => ((r.data as any)?.forecast?.length ? { ok: true, detail: 'Forecast and backtest returned.' } : { ok: false, detail: 'No forecast returned.' }),
  },
  {
    id: 'sql.query', studio: 'Explore', label: () => 'Run a read-only SQL query', defaultRole: 'data_scientist',
    approval: 'autonomous', sideEffect: 'none', backend: false, idempotent: true, step: 'eda', timeoutMs: 20_000,
    params: '{ sql: string }  // one SELECT over the table named dataset',
    validate: (p, ds) => {
      if (!ds) return 'No dataset is loaded.';
      try { runReadOnlySql(p?.sql ?? '', [], 1); return null; } catch (err) { return (err as Error).message; }
    },
    run: async (p, port) => {
      const r = runReadOnlySql(p.sql, port.getDataset()!.rows, 50);
      return { summary: `${r.total.toLocaleString()} rows returned.`, data: r };
    },
    selfCheck: passthroughCheck,
  },
  {
    id: 'report.build', studio: 'Research', label: () => 'Compile the report findings', defaultRole: 'research_analyst',
    approval: 'autonomous', sideEffect: 'none', backend: false, idempotent: true, step: 'reports', timeoutMs: 20_000, params: '{}',
    validate: (_p, ds) => (ds ? null : 'No dataset is loaded.'),
    run: async (_p, port) => {
      const f = computeReportFindings(port.getDataset()!, port.getModel());
      const n = (k: number, w: string) => `${k} ${w}${k === 1 ? '' : 's'}`;
      return { summary: `${n(f.observations.length, 'observation')}, ${n(f.risks.length, 'risk')}, ${n(f.recommendations.length, 'recommendation')}.`, data: f };
    },
    selfCheck: passthroughCheck,
  },
];

export const CAPABILITIES: Record<string, Capability> = Object.fromEntries(
  [...(Object.keys(DATA_OPS) as OperationId[]).filter(op => op in OPERATIONS).map(dataCapability), ...OTHER].map(c => [c.id, c]),
);

/** The catalog as text for the AI planner (ids, studios, parameters). */
export function catalogForPlanner(): string {
  return Object.values(CAPABILITIES)
    .filter(c => c.approval !== 'prohibited')
    .map(c => `- ${c.id} (${c.studio}; usually ${c.defaultRole}): params ${c.params}`)
    .join('\n');
}
