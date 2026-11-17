import { vi } from 'vitest';
import type { Dataset, MLResult } from '../types';
import { RuntimeOptions, RuntimePort, SwarmRun, SwarmRuntime, newRun } from './runtime';
import type { TaskSpec } from './plan';

// Shared test helpers for the swarm: a small dataset and a fake studio port.

export const csv = `id,MonthlyCharges,Contract,const,Churn
1,50,Monthly,x,Yes
2,,Yearly,x,No
3,70,Monthly,x,Yes
3,70,Monthly,x,Yes
4,20,Yearly,x,No`;

export function fakePort(start: Dataset, over: Partial<RuntimePort> = {}) {
  let ds = start;
  let version = 0;
  let model: MLResult | null = null;
  const applied: { parent: number; capability: string }[] = [];
  const port: RuntimePort & { commits: string[]; steps: string[] } = {
    commits: [], steps: [],
    getDataset: () => ds,
    commitDataset: (next, _op, summary) => { ds = next; version++; port.commits.push(summary); },
    openStep: s => { port.steps.push(s); },
    train: vi.fn(async (target: string) => (model = { target, modelType: 'classification', modelAlgorithm: 'RF', metrics: { accuracy: 0.9 }, cv: { mean: 0.88, std: 0.02 }, modelId: 'm1', leakageWarnings: [], featureImportance: [] } as unknown as MLResult)),
    getModel: () => model,
    api: vi.fn(async () => ({ test: 'Welch’s t-test', pValue: 0.01, significant: true, rowsUsed: 4, assumptions: [] })),
    resetOriginal: () => start,
    runCode: async (_code, d) => d,
    runAdvisory: async () => ({ recommendedTarget: 'Churn' }),
    settle: async () => `v${version}`,
    findAppliedVersion: async () => { void applied; return null; },
    ...over,
  };
  return port;
}

export async function runToEnd(rt: SwarmRuntime) {
  for (let i = 0; i < 200 && !['completed', 'partial', 'failed', 'cancelled'].includes(rt.run.status); i++) await new Promise(r => setTimeout(r, 5));
  return rt.run;
}

export const make = (tasks: TaskSpec[], port: RuntimePort, opts: RuntimeOptions = {}) => {
  const saved: SwarmRun[] = [];
  const rt = new SwarmRuntime(newRun({ request: 'x', reply: '', plannedBy: 'rules', tasks, datasetId: 'd', startVersionId: 'v0' }), port, async r => { saved.push(r); }, () => {}, opts);
  return { rt, saved };
};

