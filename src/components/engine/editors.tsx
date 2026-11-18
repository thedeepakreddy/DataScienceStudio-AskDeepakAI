/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useEffect, useState } from 'react';
import { ArrowDown, ArrowUp, Plus, X } from 'lucide-react';
import type { Dataset } from '../../types';
import { engine, type ModelMeta } from '../../engine/client';

type EditorProps<T> = { value: T; onChange: (v: T) => void; id: string; dataset?: Dataset };
const colsOf = (d?: Dataset) => d?.columns.map(c => c.name) ?? [];
const asNum = (x: string) => (x === '' ? undefined : Number(x));
const list = (x: string) => x.split(',').map(s => s.trim()).filter(Boolean);
const typed = (x: string) => (x !== '' && !Number.isNaN(Number(x)) ? Number(x) : x);

// ================================================================== data rules (data.validate)
export const RULE_KINDS = {
  not_null: 'Never empty',
  unique: 'Every value different',
  between: 'Between a minimum and maximum',
  in_set: 'Only these values',
  regex: 'Matches a pattern',
  max_missing_share: 'At most this share missing',
  min_distinct: 'At least this many different values',
  max_length: 'Text no longer than',
  type_is: 'Of this type',
  column_exists: 'Column exists',
  row_count_between: 'Number of rows between',
  expression: 'A condition every row meets (SQL)',
} as const;
type RuleKind = keyof typeof RULE_KINDS;
export interface RuleRow { kind: RuleKind; column: string; a: string; b: string }

const NO_COLUMN: RuleKind[] = ['row_count_between', 'expression'];
const RULE_INPUTS: Partial<Record<RuleKind, [string, string?]>> = {
  between: ['Minimum', 'Maximum'], in_set: ['Allowed values (comma-separated)'], regex: ['Pattern (regular expression)'],
  max_missing_share: ['Largest share missing (0–1)'], min_distinct: ['Fewest distinct values'], max_length: ['Most characters'],
  type_is: ['Type (integer, number, text, date, boolean)'], row_count_between: ['Fewest rows', 'Most rows'], expression: ['Condition, e.g. price >= 0 AND qty > 0'],
};

export const initialRules = (): RuleRow[] => [{ kind: 'not_null', column: '', a: '', b: '' }];
export function checkRules(rows: RuleRow[]): string | null {
  if (!rows.length) return 'Add at least one rule.';
  for (const r of rows) {
    if (!NO_COLUMN.includes(r.kind) && !r.column) return `Choose the column for “${RULE_KINDS[r.kind]}”.`;
    const need = RULE_INPUTS[r.kind];
    if (need && need.some((_, i) => !(i ? r.b : r.a).trim())) return `Fill in “${RULE_KINDS[r.kind]}”.`;
  }
  return null;
}
export const rulesToParams = (rows: RuleRow[]) => rows.map(r => {
  const base: Record<string, unknown> = { kind: r.kind, ...(NO_COLUMN.includes(r.kind) ? {} : { column: r.column }) };
  switch (r.kind) {
    case 'between': return { ...base, min: asNum(r.a), max: asNum(r.b) };
    case 'in_set': return { ...base, values: list(r.a).map(typed) };
    case 'regex': return { ...base, pattern: r.a };
    case 'max_missing_share': return { ...base, share: Number(r.a) };
    case 'min_distinct': case 'max_length': return { ...base, count: Number(r.a) };
    case 'type_is': return { ...base, type: r.a.trim() };
    case 'row_count_between': return { ...base, min: asNum(r.a), max: asNum(r.b) };
    case 'expression': return { ...base, expression: r.a };
    default: return base;
  }
});

export const RulesEditor: React.FC<EditorProps<RuleRow[]>> = ({ value: rows, onChange, id, dataset }) => {
  const set = (i: number, patch: Partial<RuleRow>) => onChange(rows.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  return (
    <div className="space-y-2" role="group" aria-labelledby={id}>
      {rows.map((r, i) => {
        const inputs = RULE_INPUTS[r.kind] ?? [];
        return (
          <div key={i} className="grid grid-cols-1 sm:grid-cols-[minmax(0,1fr)_minmax(0,1.3fr)_repeat(2,minmax(0,1fr))_auto] gap-2 items-center rounded-xl sm:rounded-none bg-fill/50 sm:bg-transparent p-2 sm:p-0">
            <select aria-label="Column" className="input" value={r.column} disabled={NO_COLUMN.includes(r.kind)} onChange={e => set(i, { column: e.target.value })}>
              <option value="">{NO_COLUMN.includes(r.kind) ? 'Whole table' : 'Column…'}</option>
              {colsOf(dataset).map(c => <option key={c} value={c}>{c}</option>)}
            </select>
            <select aria-label="Rule" className="input" value={r.kind} onChange={e => set(i, { kind: e.target.value as RuleKind, a: '', b: '' })}>
              {(Object.keys(RULE_KINDS) as RuleKind[]).map(k => <option key={k} value={k}>{RULE_KINDS[k]}</option>)}
            </select>
            {[0, 1].map(k => inputs[k]
              ? <input key={k} aria-label={inputs[k]} placeholder={inputs[k]} className={`input ${inputs.length === 1 && k === 0 ? 'sm:col-span-2' : ''}`} value={k ? r.b : r.a} onChange={e => set(i, k ? { b: e.target.value } : { a: e.target.value })} />
              : inputs.length === 1 && k === 1 ? null : <span key={k} className="hidden sm:block" />)}
            <button type="button" aria-label="Remove rule" className="btn btn-icon w-8 h-8 text-label-3 disabled:opacity-30 justify-self-end" disabled={rows.length <= 1} onClick={() => onChange(rows.filter((_, j) => j !== i))}><X className="w-4 h-4" /></button>
          </div>
        );
      })}
      <button type="button" className="btn btn-plain -ml-2 !text-sm" onClick={() => onChange([...rows, { kind: 'not_null', column: '', a: '', b: '' }])}><Plus className="w-4 h-4" /> Add rule</button>
    </div>
  );
};

// ================================================================== preparation recipe (data.recipe)
type OpField = { key: string; label: string; type: 'column' | 'columns' | 'text' | 'number' | 'select' | 'list'; options?: string[] };
/** The steps people use most, with a form each; every other step (joins, pivots, windows, SQL…) is written as JSON. */
export const RECIPE_OPS: Record<string, { label: string; fields: OpField[] }> = {
  filter: { label: 'Keep rows where…', fields: [{ key: 'column', label: 'Column', type: 'column' }, { key: 'operator', label: 'Is', type: 'select', options: ['eq', 'ne', 'gt', 'ge', 'lt', 'le', 'in', 'not_in', 'contains', 'is_null', 'not_null'] }, { key: 'value', label: 'Value', type: 'text' }] },
  select: { label: 'Keep only these columns', fields: [{ key: 'columns', label: 'Columns', type: 'columns' }] },
  drop: { label: 'Remove columns', fields: [{ key: 'columns', label: 'Columns', type: 'columns' }] },
  rename: { label: 'Rename a column', fields: [{ key: 'column', label: 'Column', type: 'column' }, { key: 'name', label: 'New name', type: 'text' }] },
  fill_missing: { label: 'Fill missing values', fields: [{ key: 'columns', label: 'Columns', type: 'columns' }, { key: 'strategy', label: 'With', type: 'select', options: ['median', 'mean', 'mode', 'zero', 'constant', 'ffill', 'bfill'] }, { key: 'value', label: 'Constant (if chosen)', type: 'text' }] },
  drop_missing: { label: 'Remove rows with missing values', fields: [{ key: 'columns', label: 'In columns (all when empty)', type: 'columns' }] },
  dedupe: { label: 'Remove duplicate rows', fields: [{ key: 'columns', label: 'Judged on (all when empty)', type: 'columns' }, { key: 'keep', label: 'Keep', type: 'select', options: ['first', 'last'] }] },
  cast: { label: 'Change a column’s type', fields: [{ key: 'column', label: 'Column', type: 'column' }, { key: 'to', label: 'To', type: 'select', options: ['integer', 'number', 'text', 'date', 'datetime', 'boolean'] }] },
  derive: { label: 'New column from a formula (SQL)', fields: [{ key: 'name', label: 'Name', type: 'text' }, { key: 'expression', label: 'Formula, e.g. price * qty', type: 'text' }] },
  bin: { label: 'Group a number into bands', fields: [{ key: 'column', label: 'Column', type: 'column' }, { key: 'bins', label: 'Bands', type: 'number' }, { key: 'method', label: 'Bands of', type: 'select', options: ['equal_width', 'quantile'] }] },
  date_parts: { label: 'Split a date into parts', fields: [{ key: 'column', label: 'Date column', type: 'column' }, { key: 'parts', label: 'Parts (year, month, day, weekday, hour, quarter, week)', type: 'list' }] },
  text_clean: { label: 'Tidy text', fields: [{ key: 'columns', label: 'Columns', type: 'columns' }, { key: 'ops', label: 'Steps (trim, lower, upper, title, collapse_spaces, strip_punctuation)', type: 'list' }] },
  replace: { label: 'Replace a value', fields: [{ key: 'column', label: 'Column', type: 'column' }, { key: 'pattern', label: 'Find', type: 'text' }, { key: 'value', label: 'Replace with', type: 'text' }] },
  clip: { label: 'Cap extreme values', fields: [{ key: 'column', label: 'Column', type: 'column' }, { key: 'method', label: 'Limits are', type: 'select', options: ['quantile', 'value'] }, { key: 'lower', label: 'Low (quantile 0–1, or value)', type: 'number' }, { key: 'upper', label: 'High (quantile 0–1, or value)', type: 'number' }] },
  log: { label: 'Log-transform', fields: [{ key: 'columns', label: 'Columns', type: 'columns' }] },
  scale: { label: 'Standardise numbers', fields: [{ key: 'columns', label: 'Columns', type: 'columns' }, { key: 'method', label: 'Method', type: 'select', options: ['standard', 'minmax', 'robust'] }] },
  one_hot: { label: 'Split a category into yes/no columns', fields: [{ key: 'column', label: 'Column', type: 'column' }] },
  label_encode: { label: 'Turn categories into numbers (label encoding)', fields: [{ key: 'columns', label: 'Columns', type: 'columns' }, { key: 'method', label: 'Numbering', type: 'select', options: ['frequency', 'alphabetical'] }] },
  sort: { label: 'Sort', fields: [{ key: 'columns', label: 'By', type: 'columns' }] },
  sample: { label: 'Random sample', fields: [{ key: 'n', label: 'Rows', type: 'number' }, { key: 'share', label: 'Or share (0–1)', type: 'number' }] },
  limit: { label: 'First N rows', fields: [{ key: 'n', label: 'Rows', type: 'number' }] },
  sql: { label: 'Any SQL over the previous step (as “data”)', fields: [{ key: 'sql', label: 'SELECT …', type: 'text' }] },
};
export interface RecipeStep { op: string; [k: string]: unknown }
export interface RecipeValue { steps: RecipeStep[]; json: string | null }

export const initialRecipe = (): RecipeValue => ({ steps: [{ op: 'dedupe' }], json: null });
export function checkRecipe(v: RecipeValue): string | null {
  if (v.json !== null) {
    try { const s = JSON.parse(v.json); if (!Array.isArray(s) || !s.length) return 'The JSON must be a list of steps.'; } catch { return 'The JSON isn’t valid.'; }
    return null;
  }
  return v.steps.length ? null : 'Add at least one step.';
}
export function recipeToSteps(v: RecipeValue): RecipeStep[] {
  if (v.json !== null) return JSON.parse(v.json);
  return v.steps.map(st => {
    const spec = RECIPE_OPS[st.op];
    const out: RecipeStep = { op: st.op };
    for (const f of spec?.fields ?? []) {
      const x = st[f.key];
      if (x === undefined || x === '' || (Array.isArray(x) && !x.length)) continue;
      out[f.key] = f.type === 'number' ? Number(x) : f.type === 'list' ? list(String(x)) : f.key === 'value' ? typed(String(x)) : x;
    }
    if (st.op === 'filter' && (out.operator === 'in' || out.operator === 'not_in')) out.value = list(String(st.value ?? '')).map(typed);
    if (st.op === 'rename') return { op: 'rename', mapping: { [String(st.column ?? '')]: String(st.name ?? '') } };
    return out;
  });
}

export const RecipeEditor: React.FC<EditorProps<RecipeValue>> = ({ value, onChange, id, dataset }) => {
  const cols = colsOf(dataset);
  const steps = value.steps;
  const set = (i: number, patch: Partial<RecipeStep>) => onChange({ ...value, steps: steps.map((s, j) => (j === i ? { ...s, ...patch } : s)) });
  const move = (i: number, by: number) => { const n = [...steps]; const [x] = n.splice(i, 1); n.splice(i + by, 0, x); onChange({ ...value, steps: n }); };
  if (value.json !== null) {
    return (
      <div className="space-y-2" role="group" aria-labelledby={id}>
        <textarea aria-label="Recipe steps as JSON" className="input min-h-[10rem] font-mono text-xs" value={value.json} onChange={e => onChange({ ...value, json: e.target.value })} />
        <p className="text-xs text-label-3">Every step the engine knows: select, drop, rename, filter, cast, fill_missing, drop_missing, dedupe, sort, limit, sample, derive, bin, date_parts, text_clean, replace, split, one_hot, label_encode, scale, log, clip, group, pivot, unpivot, window, join, union, sql.</p>
        <button type="button" className="btn btn-plain -ml-2 !text-sm" onClick={() => onChange({ steps, json: null })}>Back to the step form</button>
      </div>
    );
  }
  return (
    <div className="space-y-2" role="group" aria-labelledby={id}>
      {steps.map((st, i) => {
        const spec = RECIPE_OPS[st.op];
        return (
          <div key={i} className="rounded-xl border border-separator p-3 space-y-2">
            <div className="flex items-center gap-2">
              <span className="text-xs text-label-3 tabular-nums w-5">{i + 1}.</span>
              <select aria-label={`Step ${i + 1}`} className="input flex-1" value={st.op} onChange={e => set(i, { op: e.target.value })}>
                {Object.entries(RECIPE_OPS).map(([k, o]) => <option key={k} value={k}>{o.label}</option>)}
              </select>
              <button type="button" className="btn btn-icon w-8 h-8" aria-label="Move up" disabled={i === 0} onClick={() => move(i, -1)}><ArrowUp className="w-4 h-4" /></button>
              <button type="button" className="btn btn-icon w-8 h-8" aria-label="Move down" disabled={i === steps.length - 1} onClick={() => move(i, 1)}><ArrowDown className="w-4 h-4" /></button>
              <button type="button" className="btn btn-icon w-8 h-8 text-label-3" aria-label="Remove step" onClick={() => onChange({ ...value, steps: steps.filter((_, j) => j !== i) })}><X className="w-4 h-4" /></button>
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-2 sm:pl-7">
              {spec?.fields.map(f => {
                const v = st[f.key];
                if (f.type === 'column') return <select key={f.key} aria-label={f.label} className="input" value={String(v ?? '')} onChange={e => set(i, { [f.key]: e.target.value })}><option value="">{f.label}…</option>{cols.map(c => <option key={c} value={c}>{c}</option>)}</select>;
                if (f.type === 'select') return <select key={f.key} aria-label={f.label} className="input" value={String(v ?? '')} onChange={e => set(i, { [f.key]: e.target.value })}><option value="">{f.label}…</option>{f.options!.map(o => <option key={o} value={o}>{o.replace(/_/g, ' ')}</option>)}</select>;
                if (f.type === 'columns') {
                  const sel = (v as string[]) ?? [];
                  return (
                    <div key={f.key} className="sm:col-span-3 flex flex-wrap gap-1.5" role="group" aria-label={f.label}>
                      <span className="text-xs text-label-2 w-full">{f.label}</span>
                      {cols.map(c => <button key={c} type="button" aria-pressed={sel.includes(c)} onClick={() => set(i, { [f.key]: sel.includes(c) ? sel.filter(x => x !== c) : [...sel, c] })}
                        className={`px-2 py-0.5 rounded-full text-xs border ${sel.includes(c) ? 'bg-blue text-white border-blue' : 'border-separator text-label'}`}>{c}</button>)}
                    </div>
                  );
                }
                return <input key={f.key} aria-label={f.label} placeholder={f.label} className={`input ${f.key === 'sql' || f.key === 'expression' ? 'sm:col-span-2 font-mono text-sm' : ''}`} type={f.type === 'number' ? 'number' : 'text'} value={String(v ?? '')} onChange={e => set(i, { [f.key]: e.target.value })} />;
              })}
            </div>
          </div>
        );
      })}
      <div className="flex flex-wrap gap-2">
        <button type="button" className="btn btn-plain -ml-2 !text-sm" onClick={() => onChange({ ...value, steps: [...steps, { op: 'filter' }] })}><Plus className="w-4 h-4" /> Add step</button>
        <button type="button" className="btn btn-plain !text-sm" onClick={() => onChange({ steps, json: JSON.stringify(recipeToSteps(value), null, 2) })}>Edit as JSON (joins, pivots, windows…)</button>
      </div>
    </div>
  );
};

// ================================================================== a saved model (for model checks)
export const ModelSelectEditor: React.FC<EditorProps<string>> = ({ value, onChange, id }) => {
  const [models, setModels] = useState<ModelMeta[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    engine.models.list().then(list => {
      const sorted = [...list].sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
      setModels(sorted);
      if (!value && sorted[0]) onChange(sorted[0].id);
    }).catch(err => setError((err as Error).message));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return (
    <div>
      <select aria-labelledby={id} className="input" value={value} onChange={e => onChange(e.target.value)} disabled={!models?.length}>
        {!models?.length && <option value="">{models ? 'No saved models yet — train one with AutoML' : 'Loading models…'}</option>}
        {models?.map(m => <option key={m.id} value={m.id}>{m.name ? `${m.name} v${m.version}` : `${m.label} · ${m.id.slice(-6)}`} — predicts {m.target}</option>)}
      </select>
      {error && <p className="mt-1 text-xs text-red">{error}</p>}
    </div>
  );
};

// ================================================================== numbers typed as a list
export const parseNumbers = (s: string) => s.split(/[\s,;]+/).filter(Boolean).map(Number);
export const checkNumbers = (min: number, what: string, range?: [number, number]) => (s: string) => {
  const xs = parseNumbers(s);
  if (xs.length < min) return `Enter at least ${min} ${what}, separated by commas.`;
  if (xs.some(x => !Number.isFinite(x))) return `Every ${what.replace(/s$/, '')} must be a number.`;
  if (range && xs.some(x => x < range[0] || x > range[1])) return `Each must be between ${range[0]} and ${range[1]}.`;
  return null;
};
