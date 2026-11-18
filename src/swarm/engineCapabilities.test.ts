import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../engine/datasetSync', () => ({ syncDataset: vi.fn(async () => ({ id: 'ds_1' })) }));

import { engine } from '../engine/client';
import { ENGINE_METHODS } from '../components/stats/methods';
import { _resetConnectionForTests, addPin, deletePin, exportWorkspace, importWorkspace, listPins, movePin, recordRun } from '../utils/workspaceStore';
import { CAPABILITIES, catalogForPlanner } from './catalog';
import { ENGINE_AGENT_CAPABILITIES, describeFields, pinLatest, validateMethod, valuesFor } from './engineCapabilities';
import { toParams } from '../components/stats/MethodPanel';
import type { Dataset } from '../types';

const col = (name: string, type: any, distinctCount: number) => ({ name, type, distinctCount, missingCount: 0, statistics: {} });
const ds = { filename: 'd.csv', rows: [], rowCount: 600, originalRowCount: 600, columns: [
  col('spend', 'numeric', 590), col('visits', 'numeric', 40), col('treated', 'numeric', 2), col('segment', 'categorical', 3), col('when', 'datetime', 100),
] } as unknown as Dataset;

beforeEach(() => {
  _resetConnectionForTests();
  globalThis.indexedDB = new IDBFactory();
});

describe('engine analyses as agent capabilities', () => {
  it('every engine method is an agent capability, described for the planner', () => {
    for (const m of Object.values(ENGINE_METHODS)) {
      const c = CAPABILITIES[`analysis.${m.id}`];
      expect(c, m.id).toBeDefined();
      expect(c.label({})).toBe(m.title);
      expect(c.ui).toBeTypeOf('function');
    }
    for (const id of ['models.automl', 'models.explain_engine', 'models.monitor', 'models.score', 'dashboard.pin']) expect(CAPABILITIES[id], id).toBeDefined();
    expect(new Set(ENGINE_AGENT_CAPABILITIES.map(c => c.id)).size).toBe(ENGINE_AGENT_CAPABILITIES.length);
    expect(catalogForPlanner()).toContain('analysis.glm (Statistics; usually regression_analyst)');
    expect(describeFields(ENGINE_METHODS.glm.fields)).toBe('{ outcome: string /* column */, predictors: string[] /* columns, at least 1 */, family?: "gaussian"|"binomial"|"poisson"|"negative_binomial"|"gamma", robust?: "none"|"hc3" }');
    // Saving a model to the registry needs its own approval.
    expect(CAPABILITIES['models.automl'].approval).toBe('separate');
  });

  it('checks parameters like the form does', () => {
    const glm = ENGINE_METHODS.glm;
    expect(validateMethod(glm, { predictors: ['visits'] }, ds)).toMatch(/Say which column/);
    expect(validateMethod(glm, { outcome: 'nope', predictors: ['visits'] }, ds)).toBe('There is no column called “nope”.');
    expect(validateMethod(glm, { outcome: 'spend', predictors: [] }, ds)).toMatch(/at least 1/);
    expect(validateMethod(glm, { outcome: 'spend', predictors: ['visits'], family: 'cubic' }, ds)).toMatch(/family must be one of/);
    expect(validateMethod(glm, { outcome: 'spend', predictors: ['visits', 'segment'] }, ds)).toBeNull();
    expect(validateMethod(ENGINE_METHODS.km, { duration: 'segment', event: 'treated' }, ds)).toMatch(/needs a numeric column/);
    expect(validateMethod(glm, { outcome: 'spend', predictors: ['visits'] }, null)).toBe('No dataset is loaded.');
  });

  it('sends the engine the same parameters the form would', () => {
    const glm = ENGINE_METHODS.glm;
    const v = valuesFor(glm, { outcome: 'spend', predictors: ['visits'], family: 'poisson' }, ds);
    expect(toParams(glm, glm.fields, v)).toEqual({ outcome: 'spend', predictors: ['visits'], family: 'poisson', robust: 'none' });
    // Decisions without a dataset use the example when no inputs are given.
    const lp = ENGINE_METHODS.optimize;
    expect(validateMethod(lp, {}, null)).toBeNull();
    expect(toParams(lp, lp.fields, valuesFor(lp, {}, null))).toMatchObject({ variables: ['chairs', 'tables'], sense: 'maximize' });
  });

  it('runs directly on the engine, logs the run and can pin it', async () => {
    const spy = vi.spyOn(engine, 'runAndWait').mockResolvedValue({ runId: 'run_9', coefficients: [{ term: 'Intercept', estimate: 1, p: 0, statistic: 9 }, { term: 'visits', estimate: 2, ci: [1.5, 2.5], p: 1e-6, statistic: 8 }] } as any);
    const logged: any[] = [];
    const port: any = { getDataset: () => ds, logRun: (r: any) => { logged.push(r); recordRun({ ...r, versionId: 'v1' }); }, getPinTarget: () => ({ datasetId: 'lineage', versionId: 'v1' }) };
    const res = await CAPABILITIES['analysis.glm'].run({ outcome: 'spend', predictors: ['visits'] }, port, new AbortController().signal);
    expect(spy).toHaveBeenCalledWith('stats.glm', { outcome: 'spend', predictors: ['visits'], family: 'gaussian', robust: 'none' }, expect.objectContaining({ datasetId: 'ds_1' }));
    expect(res.summary).toBe('visits has the clearest effect on spend: +2 per unit (95% CI 1.5 to 2.5, p < 0.001).');
    expect(logged[0].params.view).toMatchObject({ kind: 'method', methodId: 'glm' });
    await new Promise(r => setTimeout(r, 20));
    const pinned = await pinLatest(port);
    expect(pinned.summary).toBe('Pinned “Regression for any outcome (GLM)” to the dashboard.');
    const pins = await listPins('lineage');
    expect(pins).toHaveLength(1);
    expect(pins[0]).toMatchObject({ capability: 'stats.glm', view: { kind: 'method', methodId: 'glm' }, versionId: 'v1' });
    await expect(pinLatest(port, 'survival')).rejects.toThrow('No engine analysis called “survival” has been run yet.');
    spy.mockRestore();
  });
});

describe('pinned results', () => {
  const pin = (title: string) => ({ datasetId: 'd1', title, headline: 'h', view: { kind: 'explain' as const }, capability: 'ml.explain', params: {}, result: {}, versionId: null });
  it('keeps order, moves, deletes, and travels with the workspace export', async () => {
    const a = await addPin(pin('A')); const b = await addPin(pin('B')); await addPin({ ...pin('other'), datasetId: 'd2' });
    expect((await listPins('d1')).map(p => p.title)).toEqual(['A', 'B']);
    await movePin(b, -1);
    expect((await listPins('d1')).map(p => p.title)).toEqual(['B', 'A']);
    const text = await exportWorkspace();
    await deletePin(a);
    expect((await listPins('d1')).map(p => p.title)).toEqual(['B']);
    await importWorkspace(text);
    expect((await listPins('d1')).map(p => p.title)).toEqual(['B', 'A']);
    expect(await listPins('d2')).toHaveLength(1);
  });
});

describe('the built-in planner reaches the engine', () => {
  const churn = { filename: 'c.csv', rows: [], rowCount: 500, originalRowCount: 500, columns: [
    col('tenure', 'numeric', 70), col('charges', 'numeric', 480), col('contract', 'categorical', 3), col('churn', 'boolean', 2),
  ] } as unknown as Dataset;
  it('plans AutoML, explanation, drift checks and pinning from plain words', async () => {
    const { rulePlan } = await import('./plan');
    const a = rulePlan('find the best model to predict churn, explain it and pin it to the dashboard', churn).tasks;
    expect(a.map(t => t.capability)).toEqual(['models.automl', 'models.explain_engine', 'dashboard.pin']);
    expect(a[0].params).toEqual({ target: 'churn' });
    expect(a[2].dependsOn).toEqual([a[1].id]);
    expect(rulePlan('monitor the model for drift', churn).tasks.map(t => t.capability)).toEqual(['models.monitor']);
    expect(rulePlan('pin it', churn).tasks.map(t => t.capability)).toEqual(['dashboard.pin']);
    expect(rulePlan('train a model to predict churn', churn).tasks.map(t => t.capability)).toEqual(['models.train']);
  });
});
