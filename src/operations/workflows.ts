/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Dataset } from '../types';
import { AppliedOperation, OperationError, OperationResult, TableInput, applyOperation } from './registry';
import type { DatasetVersion } from '../utils/workspaceStore';

/** The replayable steps that turned the import into `chain`'s last version. */
export function workflowSteps(chain: DatasetVersion[]): { steps: AppliedOperation[]; skipped: string[] } {
  const steps: AppliedOperation[] = [];
  const skipped: string[] = [];
  chain.slice(1).forEach(v => {
    if (v.operation) steps.push(v.operation);
    else skipped.push(v.label);
  });
  return { steps, skipped };
}

/**
 * Runs saved steps on a dataset. Join/append steps load their second table
 * from the saved data version they recorded.
 */
export async function runWorkflow(
  dataset: Dataset,
  steps: AppliedOperation[],
  loadTable: (versionId: string) => Promise<DatasetVersion | undefined>,
): Promise<OperationResult & { stepSummaries: string[] }> {
  let current = dataset;
  const stepSummaries: string[] = [];
  for (const [i, step] of steps.entries()) {
    let params = step.params as any;
    if ((step.op === 'join' || step.op === 'append_rows') && params.right && !params.right.rows) {
      const v = params.right.versionId ? await loadTable(params.right.versionId) : undefined;
      if (!v) throw new OperationError(`Step ${i + 1} needs “${params.right.name}”, which is no longer saved in this browser.`);
      const right: TableInput = { name: params.right.name, versionId: v.id, rows: v.dataset.rows, columns: v.dataset.columns.map(c => ({ name: c.name, type: c.type })) };
      params = { ...params, right };
    }
    try {
      const r = applyOperation(current, step.op, params);
      current = r.dataset;
      stepSummaries.push(r.summary);
    } catch (err) {
      if (err instanceof OperationError) throw new OperationError(`Step ${i + 1} (${step.op.replace(/_/g, ' ')}) couldn’t run on this data: ${err.message}`);
      throw err;
    }
  }
  return { dataset: current, summary: `Ran ${steps.length} step${steps.length === 1 ? '' : 's'}.`, stepSummaries };
}
