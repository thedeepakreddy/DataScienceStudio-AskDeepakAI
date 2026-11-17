/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Dataset } from '../types';
import { STAGE_ORDER, STAGES } from '../stages';
import { isEmpty } from '../utils/columnProfile';

// The assistant's tools. Whatever plans an action - Gemini, or the built-in
// rules when AI is unavailable - produces the same command objects; each is
// checked against the data before running (plan), and its effect is checked
// afterwards (verify), so the completion report says what really happened.

export type ToolName =
  | 'SELECT_TAB' | 'DROP_COLUMN' | 'FILL_MISSING' | 'FILTER_ROWS' | 'ADD_COLUMN' | 'ADD_ROW' | 'DELETE_ROW'
  | 'RESET_DATASET' | 'RUN_EDA_SCAN' | 'RUN_ML' | 'EXECUTE_DATASET_JS';

export interface PlanStep {
  id: string;
  command: Record<string, any> & { type: ToolName };
  label: string;
  /** Changes the data or runs something slow: needs the user's go-ahead. */
  needsConfirm: boolean;
  /** Why it can't run on the current data, if it can't. */
  problem?: string;
}

export interface StepOutcome {
  stepId: string;
  label: string;
  status: 'done' | 'failed' | 'skipped';
  detail: string;
}

const col = (ds: Dataset | null, name: unknown) =>
  typeof name === 'string' ? ds?.columns.find(c => c.name.toLowerCase() === name.toLowerCase())?.name : undefined;

const TOOL_LABEL: Record<ToolName, (c: any) => string> = {
  SELECT_TAB: c => `Open the ${STAGES[c.tab as keyof typeof STAGES]?.label ?? c.tab} step`,
  DROP_COLUMN: c => `Remove the column “${c.column}”`,
  FILL_MISSING: c => `Fill missing values in “${c.column}” (${c.strategy ?? 'mean'})`,
  FILTER_ROWS: c => `Keep rows where “${c.column}” ${c.operator} ${JSON.stringify(c.value)}`,
  ADD_COLUMN: c => `Add a column “${c.column}”${c.value !== undefined ? ` set to ${JSON.stringify(c.value)}` : ''}`,
  ADD_ROW: () => 'Add a row',
  DELETE_ROW: c => `Delete row ${Number(c.index) + 1}`,
  RESET_DATASET: () => 'Restore the original data',
  RUN_EDA_SCAN: () => 'Analyze the dataset',
  RUN_ML: c => `Train a model to predict “${c.targetColumn}”`,
  EXECUTE_DATASET_JS: c => `Run a transformation${c.explanation ? `: ${c.explanation}` : ''}`,
};

/** Turns the planner's commands into checked plan steps. Unknown tools are dropped. */
export function buildPlan(commands: any[], ds: Dataset | null): PlanStep[] {
  let working = ds;
  const removed = new Set<string>();
  const added = new Set<string>();
  return (Array.isArray(commands) ? commands : [])
    .filter(c => c && typeof c.type === 'string' && c.type in TOOL_LABEL)
    .map((command, i) => {
      const t = command.type as ToolName;
      let problem: string | undefined;
      const known = (n: unknown) => !!col(working, n) && !removed.has(String(col(working, n))) || added.has(String(n).toLowerCase());
      if (t !== 'SELECT_TAB' && t !== 'RUN_EDA_SCAN' && !working) problem = 'No dataset is loaded.';
      else if (t === 'SELECT_TAB' && !STAGE_ORDER.includes(command.tab)) problem = `There is no “${command.tab}” step.`;
      else if (['DROP_COLUMN', 'FILL_MISSING', 'FILTER_ROWS'].includes(t) && !known(command.column)) problem = `There is no column called “${command.column}”.`;
      else if (t === 'ADD_COLUMN' && (!command.column || known(command.column))) problem = command.column ? `A column called “${command.column}” already exists.` : 'No column name was given.';
      else if (t === 'DELETE_ROW' && !(Number.isInteger(Number(command.index)) && Number(command.index) >= 0 && Number(command.index) < (working?.rows.length ?? 0))) problem = `Row ${Number(command.index) + 1} doesn’t exist.`;
      else if (t === 'RUN_ML' && !known(command.targetColumn)) problem = `There is no column called “${command.targetColumn}” to predict.`;
      else if (t === 'FILTER_ROWS' && !['==', '!=', '>', '<'].includes(command.operator)) problem = `“${command.operator}” isn’t a supported comparison.`;
      if (!problem && t === 'DROP_COLUMN') removed.add(String(col(working, command.column)));
      if (!problem && t === 'ADD_COLUMN') added.add(String(command.column).toLowerCase());
      if (t === 'RESET_DATASET') { removed.clear(); added.clear(); }
      if (!working && ds) working = ds;
      return {
        id: `step-${i}`,
        command,
        label: TOOL_LABEL[t](command),
        needsConfirm: t !== 'SELECT_TAB',
        problem,
      };
    });
}

/** Whether the plan can run straight away (only navigation) or needs confirming. */
export const planNeedsConfirm = (plan: PlanStep[]) => plan.some(s => s.needsConfirm);

/**
 * Checks that a step did what it said, by comparing the data before and after.
 * Returns a plain sentence; `ok` is false when the effect isn't there.
 */
export function verifyStep(step: PlanStep, before: Dataset | null, after: Dataset | null, extra: { tab?: string; mlOk?: boolean } = {}): { ok: boolean; detail: string } {
  const c = step.command;
  const name = col(before, c.column) ?? c.column;
  switch (c.type) {
    case 'SELECT_TAB':
      return extra.tab === c.tab ? { ok: true, detail: 'The step is open.' } : { ok: false, detail: 'The step didn’t open.' };
    case 'DROP_COLUMN':
      return after && !after.columns.some(x => x.name === name)
        ? { ok: true, detail: `“${name}” is gone; ${after.columns.length} columns remain.` }
        : { ok: false, detail: `“${name}” is still there.` };
    case 'FILL_MISSING': {
      const left = after?.rows.filter(r => isEmpty(r[name])).length ?? -1;
      const was = before?.rows.filter(r => isEmpty(r[name])).length ?? 0;
      return left === 0 ? { ok: true, detail: `${was} missing value${was === 1 ? '' : 's'} filled; none left.` } : { ok: false, detail: `${left} values are still missing.` };
    }
    case 'FILTER_ROWS': {
      if (!after || !before) return { ok: false, detail: 'No data.' };
      const v = c.value;
      const okRow = (r: Record<string, any>) => {
        const x = r[name];
        if (c.operator === '>') return Number(x) > Number(v);
        if (c.operator === '<') return Number(x) < Number(v);
        const same = !isEmpty(x) && String(x).toLowerCase() === String(v).toLowerCase();
        return c.operator === '==' ? same : !same;
      };
      const bad = after.rows.filter(r => !okRow(r)).length;
      return bad === 0
        ? { ok: true, detail: `${after.rows.length.toLocaleString()} of ${before.rows.length.toLocaleString()} rows kept; all match.` }
        : { ok: false, detail: `${bad} kept rows don’t match the condition.` };
    }
    case 'ADD_COLUMN':
      return after?.columns.some(x => x.name.toLowerCase() === String(c.column).toLowerCase())
        ? { ok: true, detail: `“${c.column}” added.` } : { ok: false, detail: 'The column wasn’t added.' };
    case 'ADD_ROW':
      return after && before && after.rows.length === before.rows.length + 1
        ? { ok: true, detail: `Now ${after.rows.length.toLocaleString()} rows.` } : { ok: false, detail: 'No row was added.' };
    case 'DELETE_ROW':
      return after && before && after.rows.length === before.rows.length - 1
        ? { ok: true, detail: `Now ${after.rows.length.toLocaleString()} rows.` } : { ok: false, detail: 'No row was deleted.' };
    case 'RESET_DATASET':
      return after ? { ok: true, detail: `Back to the original ${after.rows.length.toLocaleString()} rows × ${after.columns.length} columns.` } : { ok: false, detail: 'No original data to restore.' };
    case 'RUN_ML':
      return extra.mlOk ? { ok: true, detail: 'A model was trained and evaluated on held-out rows.' } : { ok: false, detail: 'Training didn’t finish.' };
    case 'RUN_EDA_SCAN':
      return { ok: true, detail: 'Analysis finished.' };
    case 'EXECUTE_DATASET_JS':
      return after && before
        ? { ok: true, detail: `Ran; the data went from ${before.rows.length.toLocaleString()} × ${before.columns.length} to ${after.rows.length.toLocaleString()} × ${after.columns.length}.` }
        : { ok: false, detail: 'It didn’t produce data.' };
  }
}
