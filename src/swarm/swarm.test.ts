import { describe, expect, it, vi } from 'vitest';
import { parseCSV } from '../utils/csvParser';
import { mentionedColumns, rulePlan, validatePlan } from './plan';
import { SwarmRun, SwarmRuntime, newRun } from './runtime';

import { csv, fakePort, make, runToEnd } from './testkit';

describe('rule planner', () => {
  const ds = parseCSV(csv, 'c.csv');

  it('finds mentioned columns, longest names first', () => {
    expect(mentionedColumns('does monthly charges relate to churn?', ds)).toEqual(['MonthlyCharges', 'Churn']);
  });

  it('plans a full analysis with dependencies and no AI', () => {
    const p = rulePlan('Do a full analysis and write a report', ds);
    expect(p.tasks.map(t => t.capability)).toEqual(['quality.check', 'explore.profile', 'explore.deep_eda', 'stats.screen', 'models.train', 'dashboard.design', 'dashboard.add_kpi', 'dashboard.save', 'report.build', 'report.pdf']);
    const report = p.tasks.find(t => t.capability === 'report.build')!;
    expect(report.dependsOn).toEqual(['t1', 't3', 't4', 't5']);
    expect(validatePlan(p.tasks, ds)).toEqual([]);
  });

  it('plans a test between two named columns', () => {
    const p = rulePlan('test if Contract is related to churn', ds);
    expect(p.tasks).toHaveLength(1);
    expect(p.tasks[0]).toMatchObject({ capability: 'stats.compare', params: { columnA: 'Contract', columnB: 'Churn' }, role: 'statistician' });
  });

  it('trains on the column named after “predict”', () => {
    const p = rulePlan('test if Contract relates to churn and train a model to predict churn', ds);
    expect(p.tasks.find(t => t.capability === 'models.train')!.params).toEqual({ target: 'Churn' });
  });

  it('returns nothing for requests it doesn’t understand', () => {
    expect(rulePlan('write me a poem', ds).tasks).toEqual([]);
  });
});

describe('plan validation', () => {
  const ds = parseCSV(csv, 'c.csv');
  it('rejects unknown capabilities, bad inputs, missing dependencies and loops', () => {
    const problems = validatePlan([
      { id: 'a', capability: 'shell.exec', params: {}, role: 'orchestrator', dependsOn: [], why: '' },
      { id: 'b', capability: 'stats.compare', params: { columnA: 'nope', columnB: 'Churn' }, role: 'statistician', dependsOn: ['zzz'], why: '' },
      { id: 'c', capability: 'explore.profile', params: {}, role: 'data_scientist', dependsOn: ['d'], why: '' },
      { id: 'd', capability: 'explore.profile', params: {}, role: 'data_scientist', dependsOn: ['c'], why: '' },
    ], ds).map(p => p.message);
    expect(problems).toEqual(expect.arrayContaining([
      'Unknown capability “shell.exec”.',
      'There is no column called “nope”.',
      'Depends on a task that doesn’t exist (“zzz”).',
      'The plan has a dependency loop.',
    ]));
  });
});

describe('swarm runtime', () => {
  it('runs a cleaning plan: quality check adds fixes, which need approval, then the model trains on clean data', async () => {
    const port = fakePort(parseCSV(csv, 'c.csv'));
    const plan = rulePlan('clean the data and train a model to predict Churn', port.getDataset());
    const { rt } = make(plan.tasks, port);
    rt.start();
    expect(rt.run.status).toBe('running'); // check + train are autonomous
    for (let i = 0; i < 50 && !rt.run.tasks.some(t => t.status === 'awaiting_approval'); i++) await new Promise(r => setTimeout(r, 5));
    const fixes = rt.run.tasks.filter(t => t.dynamic);
    expect(fixes.map(f => f.capability)).toEqual(['data.remove_duplicates', 'data.drop_columns', 'data.fill_missing']);
    expect(rt.run.tasks.find(t => t.capability === 'models.train')!.status).toBe('pending'); // waits for the fixes
    rt.approveBatch();
    const run = await runToEnd(rt);
    expect(run.status).toBe('completed');
    expect(port.commits).toEqual(['Removed 1 duplicate row.', 'Removed “const”.', expect.stringContaining('Filled 1 missing value in “MonthlyCharges”')]);
    expect(port.train).toHaveBeenCalledTimes(1);
    expect(run.report!.headline).toBe('Done: all 6 tasks completed and self-checked; 1 independently reviewed.');
    // Training hands off to the Explainability Analyst.
    expect(run.tasks.find(t => t.capability === 'models.explain')).toMatchObject({ role: 'explainability_analyst', status: 'completed', dynamic: true });
    expect(run.report!.reviews).toEqual([expect.objectContaining({ label: 'Train a model to predict “Churn”', agrees: true })]);
    expect(run.report!.limitations[0]).toContain('self-check');
    expect(run.telemetry.aiCalls).toBe(0);
    expect(run.messages.some(m => m.type === 'handoff' && m.to === 'ml_engineer')).toBe(true);
  });

  it('retries a temporary failure, then succeeds', async () => {
    let calls = 0;
    const port = fakePort(parseCSV(csv, 'c.csv'), { api: vi.fn(async () => { if (++calls === 1) throw new Error('HTTP 503'); return { test: 'x', pValue: 0.5, significant: false, rowsUsed: 4, assumptions: [] }; }) });
    const { rt } = make([{ id: 't1', capability: 'stats.compare', params: { columnA: 'MonthlyCharges', columnB: 'Churn' }, role: 'statistician', dependsOn: [], why: '' }], port);
    rt.start();
    const run = await new Promise<SwarmRun>(res => { const iv = setInterval(() => { if (rt.run.status === 'completed') { clearInterval(iv); res(rt.run); } }, 20); });
    expect(run.telemetry.retries).toBe(1);
    expect(calls).toBe(2);
  });

  it('blocks dependents of a failed task and reports a partial result', async () => {
    const port = fakePort(parseCSV(csv, 'c.csv'), { api: vi.fn(async () => { throw new Error('There is no column called “x”.'); }) });
    const { rt } = make([
      { id: 't1', capability: 'stats.compare', params: { columnA: 'MonthlyCharges', columnB: 'Churn' }, role: 'statistician', dependsOn: [], why: '' },
      { id: 't2', capability: 'report.build', params: {}, role: 'research_analyst', dependsOn: ['t1'], why: '' },
      { id: 't3', capability: 'explore.profile', params: {}, role: 'data_scientist', dependsOn: [], why: '' },
    ], port);
    rt.start();
    const run = await runToEnd(rt);
    expect(run.status).toBe('partial');
    expect(run.tasks.find(t => t.id === 't2')!.status).toBe('blocked');
    expect(run.report!.problems.map(p => p.status)).toEqual(['failed', 'blocked']);
  });

  it('pauses before new work and cancels the rest', async () => {
    const port = fakePort(parseCSV(csv, 'c.csv'));
    const { rt } = make([
      { id: 't1', capability: 'explore.profile', params: {}, role: 'data_scientist', dependsOn: [], why: '' },
      { id: 't2', capability: 'report.build', params: {}, role: 'research_analyst', dependsOn: ['t1'], why: '' },
    ], port);
    rt.pause(); // not running yet: no-op
    rt.start();
    rt.pause();
    await new Promise(r => setTimeout(r, 30));
    expect(rt.run.status).toBe('paused');
    expect(rt.run.tasks.find(t => t.id === 't2')!.status).toBe('pending');
    rt.cancel();
    expect(rt.run.status).toBe('cancelled');
    expect(rt.run.tasks.find(t => t.id === 't2')!.status).toBe('cancelled');
  });

  it('recovers after a reload without repeating an applied change', async () => {
    const port = fakePort(parseCSV(csv, 'c.csv'), { findAppliedVersion: async (parent, cap) => (parent === 'v7' && cap === 'data.remove_duplicates' ? 'v8' : null) });
    const run = newRun({ request: 'x', reply: '', plannedBy: 'rules', datasetId: 'd', startVersionId: 'v7', tasks: [
      { id: 't1', capability: 'data.remove_duplicates', params: {}, role: 'data_engineer', dependsOn: [], why: '' },
      { id: 't2', capability: 'explore.profile', params: {}, role: 'data_scientist', dependsOn: [], why: '' },
    ] });
    run.status = 'running';
    run.tasks = run.tasks.map(t => ({ ...t, status: 'running', approved: true, inputVersionId: 'v7' }));
    const rt = new SwarmRuntime(run, port, async () => {}, () => {});
    await rt.recover();
    expect(rt.run.tasks[0]).toMatchObject({ status: 'completed', outputVersionId: 'v8' });
    expect(rt.run.tasks[1].status).toBe('pending');
    expect(port.commits).toEqual([]);
    expect(rt.run.messages.filter(m => m.type === 'recovery')).toHaveLength(2);
  });
});

describe('approval mode', () => {
  it('auto pre-approves every allowed task; ask keeps each capability’s rule', async () => {
    const { preApproved } = await import('./runtime');
    const { CAPABILITIES } = await import('./catalog');
    const ids = Object.keys(CAPABILITIES);
    const pick = (rule: string) => ids.find(id => CAPABILITIES[id].approval === rule)!;
    const tasks = ['batch', 'separate'].map((rule, i) => ({ id: `t${i}`, capability: pick(rule), params: {}, role: CAPABILITIES[pick(rule)].defaultRole, dependsOn: [], why: '' }));
    const auto = newRun({ approvalMode: 'auto', request: 'x', reply: '', plannedBy: 'rules', tasks, datasetId: null, startVersionId: null });
    expect(auto.tasks.map(t => t.approved)).toEqual([true, true]);
    const ask = newRun({ approvalMode: 'ask', request: 'x', reply: '', plannedBy: 'rules', tasks, datasetId: null, startVersionId: null });
    expect(ask.tasks.map(t => t.approved)).toEqual([false, false]);
    expect(preApproved('no.such.capability', 'auto')).toBe(false);
  });
});

describe('strict step order', () => {
  it('runs later steps only after earlier ones end, even when the plan forgot the links', async () => {
    const order: string[] = [];
    let release!: () => void;
    const slowClean = new Promise<void>(r => { release = r; });
    const port = fakePort(parseCSV(csv, 'c.csv'), {
      train: vi.fn(async (target: string) => { order.push('train'); return { target, modelType: 'classification', modelAlgorithm: 'RF', metrics: { accuracy: 0.9 }, cv: { mean: 0.9, std: 0 }, modelId: 'm', leakageWarnings: [], featureImportance: [] } as any; }),
      api: vi.fn(async () => { order.push('stats'); return { test: 't', pValue: 0.5, significant: false, rowsUsed: 4, assumptions: [] }; }),
    });
    const origCommit = port.commitDataset;
    port.commitDataset = (...a: any[]) => { order.push('clean'); (origCommit as any)(...a); };
    const settle = port.settle;
    port.settle = async () => { await slowClean; return settle(); };
    // Listed out of order, with no links between them.
    const rt = new SwarmRuntime(newRun({ approvalMode: 'auto', request: 'x', reply: '', plannedBy: 'rules', datasetId: 'd', startVersionId: 'v0', tasks: [
      { id: 'm', capability: 'models.train', params: { target: 'Churn' }, role: 'ml_engineer', dependsOn: [], why: '' },
      { id: 's', capability: 'stats.compare', params: { columnA: 'MonthlyCharges', columnB: 'Churn' }, role: 'statistician', dependsOn: [], why: '' },
      { id: 'c', capability: 'data.remove_duplicates', params: {}, role: 'data_engineer', dependsOn: [], why: '' },
    ] }), port, async () => {}, () => {});
    rt.start();
    await new Promise(r => setTimeout(r, 40));
    expect(order).not.toContain('train');
    expect(order).not.toContain('stats');
    expect(rt.run.tasks.find(t => t.id === 'm')!.note).toMatch(/Waiting for step \d \(/);
    release();
    const run = await runToEnd(rt);
    expect(['completed', 'partial']).toContain(run.status);
    expect(order).toContain('train');
    expect(order.indexOf('stats')).toBeLessThan(order.indexOf('train'));
    expect(order.indexOf('clean')).toBeLessThan(order.indexOf('stats'));
  });
});
