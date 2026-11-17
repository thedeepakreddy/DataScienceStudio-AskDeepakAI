import { describe, expect, it, vi } from 'vitest';
import { parseCSV } from '../utils/csvParser';
import { runReadOnlySql } from '../utils/safeSql';
import type { MLResult } from '../types';
import { AGENTS, AgentRole } from './agents';
import { CAPABILITIES } from './catalog';
import { SKILLS, skillsForPlanner } from './skills';
import { designDashboard } from './dashboardDesign';
import { OUTCOME_RE, chooseTarget, rulePlan, validatePlan } from './plan';
import { auditRun } from './orchestratorReview';
import { STAGE_ORDER } from '../stages';
import { fakePort, make, runToEnd } from './testkit';

// A richer dataset: dates, money, categories, an ID and a yes/no outcome.
const rows = Array.from({ length: 120 }, (_, i) => {
  const contract = ['Monthly', 'Yearly', 'Two-year'][i % 3];
  const region = ['North', 'South', 'East', 'West'][i % 4];
  const tenure = (i * 7) % 60 + 1;
  const charges = 20 + ((i * 13) % 80) + (contract === 'Monthly' ? 15 : 0);
  const churn = contract === 'Monthly' && tenure < 30 ? 'true' : 'false';
  const month = `2024-${String((i % 12) + 1).padStart(2, '0')}-01`;
  return `C${i},${month},${contract},${region},${tenure},${charges},${charges * tenure},${churn}`;
});
const csv = ['customer_id,signup_month,contract,region,tenure,monthly_charges,total_revenue,churn', ...rows].join('\n');
const ds = () => parseCSV(csv, 'customers.csv');

describe('the team', () => {
  it('has 23 agents, each with a skill sheet and at least one real capability', () => {
    const roles = Object.keys(AGENTS) as AgentRole[];
    expect(roles.length).toBe(23);
    for (const r of roles) {
      expect(SKILLS[r], r).toBeDefined();
      expect(SKILLS[r].knows.length, r).toBeGreaterThan(0);
      expect(SKILLS[r].playbook.length, r).toBeGreaterThan(0);
      const owned = Object.values(CAPABILITIES).filter(c => c.defaultRole === r);
      expect(owned.length, `${r} owns no capability`).toBeGreaterThan(0);
      for (const h of SKILLS[r].handsOffTo) expect(AGENTS[h], `${r} hands off to unknown ${h}`).toBeDefined();
    }
  });

  it('gives every capability one owner and covers all seven steps', () => {
    for (const c of Object.values(CAPABILITIES)) expect(AGENTS[c.defaultRole], c.id).toBeDefined();
    const steps = new Set(Object.values(CAPABILITIES).map(c => c.step));
    for (const s of STAGE_ORDER) expect(steps.has(s), s).toBe(true);
  });

  it('tells the AI planner what each specialist knows', () => {
    const text = skillsForPlanner();
    expect(text).toContain('dashboard_designer:');
    expect(text).toContain('Holm');
  });
});

describe('dashboard designer (chart grammar)', () => {
  it('follows the words: metric by dimension over time', () => {
    const d = designDashboard(ds(), { focus: 'dashboard of monthly charges by region over time' });
    const types = d.recommendedComponents.map(c => `${c.type}:${c.columnsToUse.slice(0, 2).join('|')}`);
    expect(types).toContain('Line Chart:signup_month|monthly_charges');
    expect(types).toContain('Bar Chart:region|monthly_charges');
    expect(d.recommendedComponents[0].type).toBe('KPI Cards');
    expect(d.topKPIs[0]).toBe('monthly_charges');
  });

  it('never puts an ID on an axis, keeps pies small and caps the charts', () => {
    const d = designDashboard(ds(), {});
    const visual = d.recommendedComponents.filter(c => !['KPI Cards', 'Filters Panel', 'Data Table'].includes(c.type));
    expect(visual.length).toBeLessThanOrEqual(8);
    for (const c of d.recommendedComponents) expect(c.columnsToUse).not.toContain('customer_id');
    const pie = d.recommendedComponents.find(c => c.type === 'Pie Chart');
    if (pie) expect(ds().columns.find(c => c.name === pie.columnsToUse[0])!.distinctCount).toBeLessThanOrEqual(6);
    expect(d.detectedProblem).toBe('Customer Churn Analysis');
  });

  it('builds the chart types the user names, and uses the model’s drivers for breakdowns', () => {
    const model = { target: 'churn', featureImportance: [{ feature: 'contract', score: 0.5 }, { feature: 'tenure', score: 0.3 }] } as unknown as MLResult;
    const d = designDashboard(ds(), { focus: 'a pie chart and a scatter plot' }, model);
    const types = d.recommendedComponents.map(c => c.type);
    expect(types).toContain('Pie Chart');
    expect(types).toContain('Scatter Plot');
    expect(d.filterColumns[0]).toBe('churn');
  });
});

describe('planner: smarter and longer', () => {
  it('runs a full analysis through all seven steps’ worth of specialists', () => {
    const p = rulePlan('Do a full analysis of this data end to end', ds());
    const caps = p.tasks.map(t => t.capability);
    expect(caps).toEqual(expect.arrayContaining(['quality.check', 'explore.profile', 'explore.deep_eda', 'stats.screen', 'models.train', 'models.forecast', 'models.cluster', 'dashboard.design', 'dashboard.add_kpi', 'dashboard.save', 'report.build', 'report.pdf']));
    expect(new Set(p.tasks.map(t => t.role)).size).toBeGreaterThanOrEqual(9);
    expect(validatePlan(p.tasks, ds())).toEqual([]);
    // Dashboards and reports come after the analyses they use.
    const design = p.tasks.find(t => t.capability === 'dashboard.design')!;
    expect(design.dependsOn).toEqual(expect.arrayContaining([p.tasks.find(t => t.capability === 'models.train')!.id]));
  });

  it('understands drivers, segments, tuning, samples, filters and quick summaries', () => {
    expect(rulePlan('what drives churn?', ds()).tasks[0]).toMatchObject({ capability: 'stats.screen', params: { target: 'churn' }, role: 'statistician' });
    expect(rulePlan('segment the customers', ds()).tasks[0]).toMatchObject({ capability: 'models.cluster', role: 'segmentation_analyst' });
    expect(rulePlan('tune a model to predict churn', ds()).tasks[0]).toMatchObject({ capability: 'models.train', params: { target: 'churn', algorithm: 'random_forest', tune: true } });
    expect(rulePlan('load the saas sample', ds()).tasks[0]).toMatchObject({ capability: 'import.sample', params: { name: 'saas' } });
    expect(rulePlan('show only Monthly contracts in the dashboard', ds()).tasks[0]).toMatchObject({ capability: 'dashboard.filter', params: { column: 'contract', values: ['Monthly'] } });
    const q = rulePlan('average monthly charges by contract', ds()).tasks[0];
    expect(q).toMatchObject({ capability: 'sql.query', role: 'sql_analyst' });
    expect(runReadOnlySql(String(q.params.sql), ds().rows, 10).rows.length).toBe(3);
    const dash = rulePlan('build a dashboard of total revenue by region', ds()).tasks;
    expect(dash[0]).toMatchObject({ capability: 'dashboard.design', params: { focus: 'build a dashboard of total revenue by region' } });
  });

  it('doesn’t guess an outcome when nothing looks like one', () => {
    const noOutcome = parseCSV('a,b,c\n1,2,10\n3,4,20\n5,6,30\n7,8,40', 'n.csv');
    expect(chooseTarget('train a model', noOutcome)).toBeUndefined();
    expect(rulePlan('train a model', noOutcome).reply).toContain('no column looks like an outcome');
    // Columns ending in “y” (salary, city) are not outcomes.
    expect(OUTCOME_RE.test('salary') || OUTCOME_RE.test('city')).toBe(false);
    expect(OUTCOME_RE.test('Churn') && OUTCOME_RE.test('is_active')).toBe(true);
  });
});

describe('new specialists at work', () => {
  it('screens drivers with Holm correction and hands the numeric ones to the Regression Analyst', async () => {
    const api = vi.fn(async (_url: string, body: any) => {
      const strong = ['contract', 'tenure'].includes(body.columnA);
      return { test: 'x', pValue: strong ? 0.001 : 0.4, significant: strong, effectSize: { name: 'r', value: strong ? 0.5 : 0.02, magnitude: strong ? 'large' : 'negligible' } };
    });
    const { rt } = make([{ id: 't1', capability: 'stats.screen', params: { target: 'churn' }, role: 'statistician', dependsOn: [], why: '' }], fakePort(ds(), { api }));
    rt.start();
    const run = await runToEnd(rt);
    const screen = run.tasks[0];
    expect((screen.result!.data as any).drivers).toEqual(['contract', 'tenure']);
    expect(screen.result!.summary).toContain('after Holm correction');
    expect(run.tasks.find(t => t.capability === 'stats.regression')).toMatchObject({ role: 'regression_analyst', params: { outcome: 'churn', predictors: ['tenure'] } });
  });

  it('finds segments and chooses how many by silhouette', async () => {
    const blobs = parseCSV(['x,y', ...Array.from({ length: 90 }, (_, i) => { const c = i % 3; return `${c * 100 + (i % 4) * 0.5},${c * 100 + ((i * 7) % 5) * 0.5}`; })].join('\n'), 'b.csv');
    const { rt } = make([{ id: 't1', capability: 'models.cluster', params: {}, role: 'segmentation_analyst', dependsOn: [], why: '' }], fakePort(blobs));
    rt.start();
    const run = await runToEnd(rt);
    expect((run.tasks[0].result!.data as any).k).toBe(3);
    expect(run.tasks[0].check!.ok).toBe(true);
  });
});

describe('the Orchestrator’s final review', () => {
  it('retrains without leaky columns, then reports the fix', async () => {
    let calls = 0;
    let model: MLResult | null = null;
    const port = fakePort(ds(), {
      getModel: () => model,
      train: vi.fn(async (target: string, features: string[]) => (model = {
        target, modelType: 'classification', modelAlgorithm: 'RF', metrics: { accuracy: 0.9 }, cv: { mean: 0.88, std: 0.02 }, modelId: `m${++calls}`, featureImportance: [{ feature: 'tenure', score: 1 }],
        // The first model leaks; the retrain (without total_revenue) doesn't.
        leakageWarnings: features.includes('total_revenue') ? [{ column: 'total_revenue' }] : [],
      } as unknown as MLResult)),
    });
    const { rt } = make([{ id: 't1', capability: 'models.train', params: { target: 'churn' }, role: 'ml_engineer', dependsOn: [], why: '' }], port);
    rt.start();
    const run = await runToEnd(rt);
    expect(run.tasks[0]).toMatchObject({ status: 'failed', supersededBy: 't1.redo' });
    const redo = run.tasks.find(t => t.id === 't1.redo')!;
    expect(redo.status).toBe('completed');
    expect((redo.params as any).features).not.toContain('total_revenue');
    expect(run.orchestratorReview).toMatchObject({ verdict: 'fixed' });
    expect(run.status).toBe('completed');
    expect(run.report!.headline).toContain('The Orchestrator found and fixed 1 issue');
  });

  it('does not repeat work that failed for a reason a redo can’t fix', () => {
    const run = { tasks: [{ id: 't1', capability: 'stats.compare', params: {}, status: 'failed', error: 'There is no column called “x”.', dependsOn: [], role: 'statistician', attempts: 1, approved: true, why: '' }], incidents: [] } as any;
    const audit = auditRun(run, ds());
    expect(audit.fixes).toEqual([]);
    expect(audit.issues[0]).toContain('no column called');
  });

  it('uses one AI check when available and runs its corrective tasks', async () => {
    const aiReview = vi.fn(async () => ({ summary: 'The request asked for segments, which were missing.', issues: ['No segmentation was run.'], tasks: [{ id: 'f1', capability: 'models.cluster', params: {}, role: 'segmentation_analyst' as AgentRole, dependsOn: [], why: 'Add the missing segments.' }], inputTokens: 500, outputTokens: 60 }));
    const { rt } = make([
      { id: 't1', capability: 'explore.profile', params: {}, role: 'data_scientist', dependsOn: [], why: '' },
      { id: 't2', capability: 'quality.check', params: {}, role: 'data_quality', dependsOn: [], why: '' },
      { id: 't3', capability: 'report.build', params: {}, role: 'research_analyst', dependsOn: ['t1'], why: '' },
    ], fakePort(ds()), { aiReview });
    rt.start();
    // The quality check proposes fixes that wait for approval; approve them.
    for (let i = 0; i < 60 && rt.run.status !== 'completed' && rt.run.status !== 'partial'; i++) { rt.approveBatch(); await new Promise(r => setTimeout(r, 10)); }
    const run = await runToEnd(rt);
    expect(aiReview).toHaveBeenCalledTimes(1);
    expect(run.tasks.find(t => t.id === 'review.1')).toMatchObject({ capability: 'models.cluster', status: 'completed' });
    expect(run.telemetry.aiCalls).toBe(1);
    expect(run.orchestratorReview).toMatchObject({ verdict: 'fixed', usedAi: true });
  });
});

describe('a long run', () => {
  it('completes a full analysis of ~20 tasks with the fake studio (page-only steps excluded)', async () => {
    const plan = rulePlan('Do a full analysis of this data end to end', ds()).tasks
      // Dashboard and PDF steps need the page; everything else runs directly here.
      .filter(t => !CAPABILITIES[t.capability].uiOnly);
    const port = fakePort(ds(), {
      api: vi.fn(async (url: string) => {
        if (url === '/api/eda') return { rowCount: 120, columnCount: 8, numericSummaries: [], outliers: [], correlation: null };
        if (url === '/api/forecast') return { bestLabel: 'Seasonal naive', leaderboard: [{ mae: 3.2 }], horizon: 6, frequency: 'month', forecast: [1, 2, 3] };
        return { test: 'x', pValue: 0.01, significant: true, rowsUsed: 120, assumptions: [], effectSize: { name: 'r', value: 0.3, magnitude: 'medium' } };
      }),
    });
    const { rt } = make(plan, port);
    rt.start();
    for (let i = 0; i < 100 && !['completed', 'partial', 'failed'].includes(rt.run.status); i++) { rt.approveBatch(); await new Promise(r => setTimeout(r, 10)); }
    const run = await runToEnd(rt);
    expect(run.tasks.length).toBeGreaterThanOrEqual(10);
    expect(run.status).toBe('completed');
    expect(run.report!.bySteps!.map(b => b.step)).toEqual(expect.arrayContaining(['Clean', 'Explore', 'Statistics', 'Model', 'Report']));
    expect(new Set(run.tasks.map(t => t.role)).size).toBeGreaterThanOrEqual(8);
  });
});
