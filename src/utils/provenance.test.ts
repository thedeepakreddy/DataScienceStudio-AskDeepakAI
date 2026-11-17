import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { buildNotebook, describeRun, lineage, rowsToCsv } from './provenance';
import type { DatasetVersion, RunRecord } from './workspaceStore';
import type { RegisteredModel } from './modelRegistry';

const v = (id: string, parentId: string | null, label: string) => ({ id, parentId, label, datasetId: 'd' } as DatasetVersion);

const hasPythonStack = (() => {
  try {
    execFileSync('python3', ['-c', 'import pandas, sklearn, scipy, fastapi, httpx'], { stdio: 'ignore' });
    return true;
  } catch { return false; }
})();

describe('provenance', () => {
  it('walks the version chain back to the import', () => {
    const vs = [v('a', null, 'Imported'), v('b', 'a', 'Removed 1 row'), v('c', 'b', 'Filled'), v('x', 'a', 'Other branch')];
    expect(lineage(vs, 'c').map(x => x.label)).toEqual(['Imported', 'Removed 1 row', 'Filled']);
    expect(lineage(vs, null)).toEqual([]);
  });

  it('describes a saved test with its real numbers', () => {
    const run = { kind: 'hypothesis-test', title: 'Welch’s t-test: a vs g', summary: '', status: 'succeeded', id: '1', createdAt: 0, versionId: null,
      result: { test: 'Welch’s t-test', statistic: 2.5, statisticName: 't', pValue: 0.0123, significant: true, alpha: 0.05,
        effectSize: { name: 'Hedges’ g', value: 0.61, magnitude: 'medium' }, estimate: { name: 'Difference', value: 1.2, ci: [0.3, 2.1], level: 0.95 }, rowsUsed: 80 } } as RunRecord;
    const d = describeRun(run);
    expect(d.lines[0]).toBe('Welch’s t-test: t = 2.500, p = 0.012 — statistically significant at the 0.05 level.');
    expect(d.lines[2]).toBe('Difference: 1.200, 95% CI 0.300 to 2.100.');
  });

  it('writes CSV that round-trips quotes and commas', () => {
    expect(rowsToCsv([{ a: 'x, "y"', b: null }], ['a', 'b'])).toBe('a,b\n"x, ""y""",\n');
  });

  it.skipIf(!hasPythonStack)('exports a notebook that reproduces the studio’s exact score and p-value', () => {
    const dir = mkdtempSync(join(tmpdir(), 'nb-'));
    const service = resolve(__dirname, '../../mlops_service');
    // 1. Train and test with the real service code to get the studio's numbers.
    const studio = JSON.parse(execFileSync('python3', ['-c', `
import sys, json, random
sys.path.insert(0, ${JSON.stringify(service)})
from fastapi.testclient import TestClient
import main
random.seed(4)
rows = []
for i in range(200):
    t = random.randint(0, 72); plan = random.choice(["A", "B", "C"])
    churn = "Yes" if random.random() < (0.7 if plan == "A" and t < 15 else 0.1) else "No"
    rows.append({"tenure": t, "spend": round(random.uniform(10, 90), 2), "plan": plan, "churn": churn})
import csv
with open(${JSON.stringify(join(dir, 'data.csv'))}, "w", newline="") as f:
    w = csv.DictWriter(f, fieldnames=list(rows[0])); w.writeheader(); w.writerows(rows)
c = TestClient(main.app)
tr = c.post("/train", json={"data": rows, "target": "churn", "features": ["tenure", "spend", "plan"], "models": ["random_forest"], "random_state": 11}).json()
st = c.post("/stats/compare", json={"data": rows, "columnA": "spend", "columnB": "churn"}).json()
print(json.dumps({"acc": tr["champion"]["metrics"]["accuracy"], "split": tr["split"], "test": st}))
`], { cwd: dir }).toString().trim().split('\n').pop()!);

    const model = {
      id: 'm', name: 'Churn', version: 1, datasetId: 'd', versionId: 'v', modelKey: 'random_forest', modelId: null,
      recipe: { target: 'churn', features: ['tenure', 'spend', 'plan'], modelType: 'classification', hyperparameters: { seed: 11 } },
      algorithm: 'Random Forest Classifier', task: 'classification', metrics: { accuracy: studio.acc }, split: studio.split, seed: 11,
      topFeatures: [], schema: [], gate: [], intendedUse: '', createdAt: 0, active: true,
    } as unknown as RegisteredModel;
    const test = { kind: 'hypothesis-test', title: 'spend vs churn', params: { columnA: 'spend', columnB: 'churn' }, result: studio.test } as unknown as RunRecord;
    const nb = JSON.parse(buildNotebook({ datasetName: 'x', dataFile: 'data.csv', versionLabel: 'v1', model, tests: [test] }));

    // 2. Run the notebook's code cells and read what they print.
    const code = nb.cells.filter((c: any) => c.cell_type === 'code').map((c: any) => c.source.join('')).join('\n\n');
    writeFileSync(join(dir, 'nb.py'), code);
    const out = execFileSync('python3', ['nb.py'], { cwd: dir }).toString();
    const here = Number(out.match(/Accuracy here: ([0-9.]+)/)![1]);
    expect(here).toBeCloseTo(studio.acc, 4);
    const p = Number(out.match(/p = ([0-9.e-]+)\s+\|/)![1]);
    expect(p).toBeCloseTo(studio.test.pValue, 6);
  }, 60000);
});
