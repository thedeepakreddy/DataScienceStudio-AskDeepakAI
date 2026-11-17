import { describe, expect, it } from 'vitest';
import { runWorkflow, workflowSteps } from './workflows';
import { parseCSV } from '../utils/csvParser';
import type { DatasetVersion } from '../utils/workspaceStore';

describe('workflows', () => {
  it('collects replayable steps and names the ones that are not', () => {
    const chain = [
      { label: 'Imported' },
      { label: 'Removed “id”', operation: { op: 'drop_columns', params: { columns: ['id'] } } },
      { label: 'Kept the result of a SQL query' },
      { label: 'Filled', operation: { op: 'fill_missing', params: { column: 'age', strategy: 'median' } } },
    ] as unknown as DatasetVersion[];
    const r = workflowSteps(chain);
    expect(r.steps.map(s => s.op)).toEqual(['drop_columns', 'fill_missing']);
    expect(r.skipped).toEqual(['Kept the result of a SQL query']);
  });

  it('replays steps on new data, loading join tables from saved versions', async () => {
    const fresh = parseCSV('id,age,product\n1,30,A\n2,,B\n3,50,A', 'new.csv');
    const products = parseCSV('product,category\nA,Tools\nB,Toys', 'p.csv');
    const result = await runWorkflow(fresh, [
      { op: 'drop_columns', params: { columns: ['id'] } },
      { op: 'fill_missing', params: { column: 'age', strategy: 'median' } },
      { op: 'join', params: { right: { name: 'p.csv', versionId: 'pv' }, leftKey: 'product', rightKey: 'product', how: 'left' } },
    ], async id => (id === 'pv' ? ({ id, dataset: products } as DatasetVersion) : undefined));
    expect(result.dataset.rows).toEqual([
      { age: 30, product: 'A', category: 'Tools' },
      { age: 40, product: 'B', category: 'Toys' },
      { age: 50, product: 'A', category: 'Tools' },
    ]);
    expect(result.stepSummaries).toHaveLength(3);
  });

  it('explains which step fails on incompatible data', async () => {
    const other = parseCSV('x\n1\n2', 'o.csv');
    await expect(runWorkflow(other, [{ op: 'drop_columns', params: { columns: ['id'] } }], async () => undefined))
      .rejects.toThrow('Step 1 (drop columns) couldn’t run on this data: There is no column called “id”.');
  });
});
