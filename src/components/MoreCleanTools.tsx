/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useEffect, useMemo, useState } from 'react';
import { AlertTriangle, CheckCircle2, Plus, Trash2, Upload, X } from 'lucide-react';
import { Dataset } from '../types';
import {
  AggregateFn, AppliedOperation, ColumnType, FilterOperator, OperationError, OperationId, OperationParams,
  OperationResult, TableInput, applyOperation,
} from '../operations/registry';
import { QualityRule, RuleKind, evaluateRules, validateRule } from '../operations/qualityRules';
import {
  DatasetVersion, SavedWorkflow, deleteWorkflow, getVersion, listVersions, listWorkflows, loadRules, saveRules, saveVersion, saveWorkflow,
} from '../utils/workspaceStore';
import { lineage } from '../utils/provenance';
import { runWorkflow, workflowSteps } from '../operations/workflows';
import { ACCEPT_ATTRIBUTE, readDataFile } from '../utils/fileImport';
import Orb from './Orb';

type Tab = 'standardise' | 'filter' | 'duplicates' | 'rules' | 'combine' | 'summarise' | 'workflows';

interface Preview {
  result: OperationResult;
  /** The single operation, or undefined for a multi-step workflow. */
  applied?: AppliedOperation;
  /** The data and tab it was made for; it's stale once either changes. */
  source: Dataset;
  tab: Tab;
}

interface MoreCleanToolsProps {
  dataset: Dataset;
  datasetId: string | null;
  activeVersionId?: string | null;
  onApply: (result: OperationResult, applied?: AppliedOperation) => void;
}

const AGG_LABELS: Record<AggregateFn, string> = {
  count: 'Count', count_distinct: 'Count distinct', sum: 'Sum', mean: 'Average', median: 'Median', min: 'Minimum', max: 'Maximum',
};
const OPERATOR_LABELS: Record<FilterOperator, string> = {
  equals: 'is', not_equals: 'is not', contains: 'contains', greater_than: 'is greater than', less_than: 'is less than',
  is_empty: 'is empty', is_not_empty: 'is not empty',
};
const RULE_LABELS: Record<RuleKind, string> = {
  not_empty: 'Is never empty', unique: 'Has no repeated values', range: 'Is within a range',
  allowed_values: 'Is one of a list', pattern: 'Matches a pattern',
};

/** Previewable cleaning and reshaping tools, all running the shared operation registry. */
export default function MoreCleanTools({ dataset, datasetId, activeVersionId = null, onApply }: MoreCleanToolsProps) {
  const [tab, setTab] = useState<Tab>('standardise');
  const [preview, setPreview] = useState<Preview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const names = dataset.columns.map(c => c.name);
  const numeric = dataset.columns.filter(c => c.type === 'numeric').map(c => c.name);
  const first = names[0] ?? '';

  // Any change to the inputs, the tab or the data makes an old preview stale.
  const reset = () => { setPreview(null); setError(null); };
  const livePreview = preview && preview.source === dataset && preview.tab === tab ? preview : null;
  // A column picked earlier may have been removed since; fall back to the first.
  const valid = (v: string, fallback = first) => (names.includes(v) ? v : fallback);

  const runPreview = <K extends OperationId>(op: K, params: OperationParams[K], recorded?: OperationParams[K]) => {
    setError(null);
    try {
      const result = applyOperation(dataset, op, params);
      setPreview({ result, applied: { op, params: (recorded ?? params) as OperationParams[OperationId] } as AppliedOperation, source: dataset, tab });
    } catch (err) {
      setPreview(null);
      setError(err instanceof OperationError ? err.message : `Something went wrong: ${(err as Error)?.message || err}`);
    }
  };

  const apply = () => {
    if (!livePreview) return;
    onApply(livePreview.result, livePreview.applied);
    setPreview(null);
  };

  // --- Standardise --------------------------------------------------------
  const [stdColumn, setStdColumn] = useState(first);
  const [stdAction, setStdAction] = useState<'tidy' | 'type' | 'replace'>('tidy');
  const [stdCase, setStdCase] = useState<'none' | 'lower' | 'upper' | 'title'>('none');
  const [stdType, setStdType] = useState<ColumnType>('numeric');
  const [replaceFrom, setReplaceFrom] = useState('');
  const [replaceTo, setReplaceTo] = useState('');

  // --- Filter ---------------------------------------------------------------
  const [fColumn, setFColumn] = useState(first);
  const [fOp, setFOp] = useState<FilterOperator>('equals');
  const [fValue, setFValue] = useState('');

  // --- Rules ----------------------------------------------------------------
  const [rules, setRules] = useState<QualityRule[]>([]);
  const [rulesError, setRulesError] = useState<string | null>(null);
  const [rColumn, setRColumn] = useState(first);
  const [rKind, setRKind] = useState<RuleKind>('not_empty');
  const [rMin, setRMin] = useState('');
  const [rMax, setRMax] = useState('');
  const [rList, setRList] = useState('');
  const [rPattern, setRPattern] = useState('');
  useEffect(() => {
    if (!datasetId) return;
    let cancelled = false;
    loadRules(datasetId).then(r => { if (!cancelled) setRules(r); }).catch(() => {});
    return () => { cancelled = true; };
  }, [datasetId]);
  const ruleResults = useMemo(() => evaluateRules(dataset, rules), [dataset, rules]);
  const persistRules = (next: QualityRule[]) => {
    setRules(next);
    if (datasetId) saveRules(datasetId, next).catch(err => setRulesError(`Rules couldn’t be saved: ${err?.message || err}`));
  };
  const addRule = () => {
    const rule: QualityRule = {
      id: crypto.randomUUID(),
      column: valid(rColumn),
      kind: rKind,
      ...(rKind === 'range' ? { min: rMin === '' ? undefined : Number(rMin), max: rMax === '' ? undefined : Number(rMax) } : {}),
      ...(rKind === 'allowed_values' ? { allowed: rList.split(',').map(v => v.trim()).filter(Boolean) } : {}),
      ...(rKind === 'pattern' ? { pattern: rPattern } : {}),
    };
    try {
      if (rule.kind === 'range' && [rule.min, rule.max].some(v => v !== undefined && !Number.isFinite(v))) throw new Error('Minimum and maximum must be numbers.');
      validateRule(rule);
    } catch (err) {
      setRulesError((err as Error).message);
      return;
    }
    setRulesError(null);
    persistRules([...rules, rule]);
    setRMin(''); setRMax(''); setRList(''); setRPattern('');
  };

  // --- Combine --------------------------------------------------------------
  const [right, setRight] = useState<(TableInput & { rows: Record<string, any>[]; columns: { name: string; type: ColumnType }[] }) | null>(null);
  const [rightLoading, setRightLoading] = useState(false);
  const [combineMode, setCombineMode] = useState<'join' | 'append'>('join');
  const [leftKey, setLeftKey] = useState(first);
  const [rightKey, setRightKey] = useState('');
  const [joinHow, setJoinHow] = useState<'left' | 'inner'>('left');
  const loadRight = async (file: File | undefined) => {
    if (!file) return;
    reset();
    setRightLoading(true);
    try {
      const { dataset: other } = await readDataFile(file);
      // Kept as its own dataset in the history, so the join records where its data came from.
      const v = await saveVersion(other, { parentId: null, label: 'Imported for combining' }).catch(() => null);
      const columns = other.columns.map(c => ({ name: c.name, type: c.type }));
      setRight({ name: other.filename, versionId: v?.id, rows: other.rows, columns });
      const sameName = columns.find(c => c.name.toLowerCase() === leftKey.toLowerCase());
      setRightKey(sameName?.name ?? columns[0]?.name ?? '');
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setRightLoading(false);
    }
  };
  const recordedRight = (t: TableInput): TableInput => ({ name: t.name, versionId: t.versionId });

  // --- Summarise ------------------------------------------------------------
  const [sumMode, setSumMode] = useState<'group' | 'pivot'>('group');
  const [groupBy, setGroupBy] = useState<string[]>([first]);
  const [aggs, setAggs] = useState<{ column: string; fn: AggregateFn }[]>([{ column: numeric[0] ?? first, fn: numeric[0] ? 'sum' : 'count' }]);
  const [pIndex, setPIndex] = useState(first);
  const [pColumns, setPColumns] = useState(names[1] ?? first);
  const [pValues, setPValues] = useState(numeric[0] ?? first);
  const [pFn, setPFn] = useState<AggregateFn>(numeric[0] ? 'sum' : 'count');

  const columnSelect = (id: string, value: string, onChange: (v: string) => void, options = names) => (
    <select id={id} className="input" value={options.includes(value) ? value : options[0] ?? ''} onChange={e => { onChange(e.target.value); reset(); }}>
      {options.map(n => <option key={n} value={n}>{n}</option>)}
    </select>
  );

  const stdCol = dataset.columns.find(c => c.name === valid(stdColumn));
  const topValues = stdCol?.statistics.mostCommon?.map(m => m.value) ?? [];

  return (
    <section aria-labelledby="more-tools-heading" className="space-y-5">
      <div>
        <h2 id="more-tools-heading" className="section-title">More tools</h2>
        <p className="mt-1 text-sm text-label-2">Preview a change before you apply it. Every change is saved as a new version you can undo.</p>
      </div>

      <div className="overflow-x-auto scrollbar-none -mx-4 px-4 sm:mx-0 sm:px-0">
        <div className="segmented w-max" role="tablist" aria-label="More cleaning tools">
          {([
            ['standardise', 'Standardise'], ['filter', 'Filter rows'], ['duplicates', 'Duplicates'],
            ['rules', 'Quality rules'], ['combine', 'Combine'], ['summarise', 'Summarise'], ['workflows', 'Workflows'],
          ] as [Tab, string][]).map(([id, label]) => (
            <button key={id} type="button" role="tab" aria-selected={tab === id} onClick={() => { setTab(id); setError(null); }}>{label}</button>
          ))}
        </div>
      </div>

      <div className="card p-5 sm:p-6">
        {tab === 'standardise' && (
          <div className="space-y-4">
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div>
                <label className="field-label" htmlFor="std-col">Column</label>
                {columnSelect('std-col', stdColumn, setStdColumn)}
              </div>
              <div>
                <label className="field-label" htmlFor="std-action">Change</label>
                <select id="std-action" className="input" value={stdAction} onChange={e => { setStdAction(e.target.value as typeof stdAction); reset(); }}>
                  <option value="tidy">Tidy text (spaces and capitals)</option>
                  <option value="type">Change the column type</option>
                  <option value="replace">Replace a value</option>
                </select>
              </div>
            </div>
            {stdAction === 'tidy' && (
              <div>
                <label className="field-label" htmlFor="std-case">Capitals</label>
                <select id="std-case" className="input" value={stdCase} onChange={e => { setStdCase(e.target.value as typeof stdCase); reset(); }}>
                  <option value="none">Keep as they are</option>
                  <option value="lower">all lowercase</option>
                  <option value="upper">ALL UPPERCASE</option>
                  <option value="title">Title Case</option>
                </select>
                <p className="mt-1.5 text-xs text-label-2">Also trims spaces at the ends and collapses repeated spaces, so “ Paris ” and “Paris” become one value.</p>
              </div>
            )}
            {stdAction === 'type' && (
              <div>
                <label className="field-label" htmlFor="std-type">New type <span className="text-label-3">(now {stdCol?.type})</span></label>
                <select id="std-type" className="input" value={stdType} onChange={e => { setStdType(e.target.value as ColumnType); reset(); }}>
                  <option value="numeric">Number</option>
                  <option value="categorical">Text</option>
                  <option value="boolean">True/false</option>
                  <option value="datetime">Date</option>
                </select>
                <p className="mt-1.5 text-xs text-label-2">Numbers like “$1,200”, “(300)” and “1.234,5” are understood. Values that can’t be converted become empty, and the preview says how many.</p>
              </div>
            )}
            {stdAction === 'replace' && (
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div>
                  <label className="field-label" htmlFor="rep-from">Replace</label>
                  <input id="rep-from" className="input" list="rep-from-values" value={replaceFrom} onChange={e => { setReplaceFrom(e.target.value); reset(); }} placeholder="Value to find" />
                  <datalist id="rep-from-values">{topValues.map(v => <option key={v} value={v} />)}</datalist>
                </div>
                <div>
                  <label className="field-label" htmlFor="rep-to">With</label>
                  <input id="rep-to" className="input" value={replaceTo} onChange={e => { setReplaceTo(e.target.value); reset(); }} placeholder="Leave blank to make it empty" />
                </div>
              </div>
            )}
            <PreviewButton onClick={() => {
              if (stdAction === 'tidy') runPreview('standardize_text', { column: valid(stdColumn), trim: true, collapseSpaces: true, case: stdCase });
              else if (stdAction === 'type') runPreview('convert_type', { column: valid(stdColumn), to: stdType });
              else if (!replaceFrom) setError('Enter the value to replace.');
              else runPreview('replace_values', { column: valid(stdColumn), from: replaceFrom, to: replaceTo });
            }} />
          </div>
        )}

        {tab === 'filter' && (
          <div className="space-y-4">
            <p className="text-sm text-label-2">Keep only the rows that match. The others are removed from this version.</p>
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
              <div>
                <label className="field-label" htmlFor="f-col">Keep rows where</label>
                {columnSelect('f-col', fColumn, setFColumn)}
              </div>
              <div>
                <label className="field-label" htmlFor="f-op">Condition</label>
                <select id="f-op" className="input" value={fOp} onChange={e => { setFOp(e.target.value as FilterOperator); reset(); }}>
                  {(Object.keys(OPERATOR_LABELS) as FilterOperator[]).map(o => <option key={o} value={o}>{OPERATOR_LABELS[o]}</option>)}
                </select>
              </div>
              {fOp !== 'is_empty' && fOp !== 'is_not_empty' && (
                <div>
                  <label className="field-label" htmlFor="f-val">Value</label>
                  <input id="f-val" className="input" value={fValue} onChange={e => { setFValue(e.target.value); reset(); }} />
                </div>
              )}
            </div>
            <PreviewButton onClick={() => runPreview('filter_rows', { column: valid(fColumn), operator: fOp, value: fValue })} />
          </div>
        )}

        {tab === 'duplicates' && (
          <div className="space-y-4">
            <p className="text-sm text-label-2">Finds rows that are identical in every column and keeps the first of each.</p>
            <PreviewButton onClick={() => runPreview('remove_duplicates', {})} />
          </div>
        )}

        {tab === 'rules' && (
          <div className="space-y-5">
            <p className="text-sm text-label-2">
              Rules describe what correct data looks like. They’re saved with this dataset and re-checked after every change.
            </p>
            {ruleResults.length > 0 && (
              <ul className="rounded-2xl bg-well divide-y divide-separator">
                {ruleResults.map(r => (
                  <li key={r.rule.id} className="flex flex-wrap items-center gap-3 px-4 py-3">
                    {r.problem ? <AlertTriangle className="w-4 h-4 text-orange shrink-0" />
                      : r.failing.length ? <X className="w-4 h-4 text-red shrink-0" />
                      : <CheckCircle2 className="w-4 h-4 text-green shrink-0" />}
                    <div className="min-w-0 flex-1">
                      <p className="text-sm text-label">{r.label}</p>
                      <p className="text-xs text-label-2 tabular-nums">
                        {r.problem ?? (r.failing.length
                          ? `${r.failing.length.toLocaleString()} row${r.failing.length === 1 ? '' : 's'} break this rule (e.g. row${r.failing.length === 1 ? '' : 's'} ${r.failing.slice(0, 5).map(i => i + 1).join(', ')})`
                          : 'All rows pass')}
                      </p>
                    </div>
                    {r.failing.length > 0 && (
                      <button
                        type="button"
                        className="btn btn-sm btn-secondary"
                        onClick={() => runPreview('delete_rows', { indices: r.failing })}
                      >
                        Preview Removing Them
                      </button>
                    )}
                    <button
                      type="button"
                      onClick={() => persistRules(rules.filter(x => x.id !== r.rule.id))}
                      className="btn btn-icon w-8 h-8 text-red hover:bg-red/10"
                      aria-label={`Delete rule: ${r.label}`}
                    >
                      <Trash2 className="w-4 h-4" />
                    </button>
                  </li>
                ))}
              </ul>
            )}
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 items-end">
              <div>
                <label className="field-label" htmlFor="r-col">Column</label>
                <select id="r-col" className="input" value={valid(rColumn)} onChange={e => setRColumn(e.target.value)}>
                  {names.map(n => <option key={n} value={n}>{n}</option>)}
                </select>
              </div>
              <div>
                <label className="field-label" htmlFor="r-kind">Rule</label>
                <select id="r-kind" className="input" value={rKind} onChange={e => setRKind(e.target.value as RuleKind)}>
                  {(Object.keys(RULE_LABELS) as RuleKind[]).map(k => <option key={k} value={k}>{RULE_LABELS[k]}</option>)}
                </select>
              </div>
              {rKind === 'range' && (
                <div className="grid grid-cols-2 gap-2">
                  <div>
                    <label className="field-label" htmlFor="r-min">Min</label>
                    <input id="r-min" className="input" inputMode="decimal" value={rMin} onChange={e => setRMin(e.target.value)} />
                  </div>
                  <div>
                    <label className="field-label" htmlFor="r-max">Max</label>
                    <input id="r-max" className="input" inputMode="decimal" value={rMax} onChange={e => setRMax(e.target.value)} />
                  </div>
                </div>
              )}
              {rKind === 'allowed_values' && (
                <div>
                  <label className="field-label" htmlFor="r-list">Allowed values</label>
                  <input id="r-list" className="input" value={rList} onChange={e => setRList(e.target.value)} placeholder="Comma-separated" />
                </div>
              )}
              {rKind === 'pattern' && (
                <div>
                  <label className="field-label" htmlFor="r-pattern">Pattern (regular expression)</label>
                  <input id="r-pattern" className="input font-code" value={rPattern} onChange={e => setRPattern(e.target.value)} placeholder="^[^@]+@[^@]+$" />
                </div>
              )}
            </div>
            <button type="button" onClick={addRule} className="btn btn-secondary"><Plus className="w-4 h-4" /> Add Rule</button>
            {rulesError && <p role="alert" className="text-sm text-red">{rulesError}</p>}
          </div>
        )}

        {tab === 'combine' && (
          <div className="space-y-4">
            <p className="text-sm text-label-2">Bring in a second file: join it on a shared column, or add its rows below yours.</p>
            <div className="flex flex-wrap items-center gap-3">
              <label className="btn btn-secondary cursor-pointer">
                {rightLoading ? <><Orb state="working" label="Reading the file" /> Reading…</> : <><Upload className="w-4 h-4" /> {right ? 'Choose Another File' : 'Choose a File'}</>}
                <input type="file" accept={ACCEPT_ATTRIBUTE} className="hidden" onChange={e => { loadRight(e.target.files?.[0]); e.target.value = ''; }} />
              </label>
              {right && <span className="tag">{right.name} · {right.rows.length.toLocaleString()} rows × {right.columns.length} columns</span>}
            </div>
            {right && (
              <>
                <div className="segmented w-max" role="group" aria-label="How to combine">
                  <button type="button" aria-pressed={combineMode === 'join'} onClick={() => { setCombineMode('join'); reset(); }}>Join on a column</button>
                  <button type="button" aria-pressed={combineMode === 'append'} onClick={() => { setCombineMode('append'); reset(); }}>Add its rows</button>
                </div>
                {combineMode === 'join' ? (
                  <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
                    <div>
                      <label className="field-label" htmlFor="j-left">Your column</label>
                      {columnSelect('j-left', leftKey, setLeftKey)}
                    </div>
                    <div>
                      <label className="field-label" htmlFor="j-right">Matches its column</label>
                      {columnSelect('j-right', rightKey, setRightKey, right.columns.map(c => c.name))}
                    </div>
                    <div>
                      <label className="field-label" htmlFor="j-how">Rows without a match</label>
                      <select id="j-how" className="input" value={joinHow} onChange={e => { setJoinHow(e.target.value as 'left' | 'inner'); reset(); }}>
                        <option value="left">Keep them (left join)</option>
                        <option value="inner">Drop them (inner join)</option>
                      </select>
                    </div>
                  </div>
                ) : (
                  <p className="text-xs text-label-2">Columns are matched by name (ignoring capitals). Columns only one file has are kept and left empty for the other’s rows.</p>
                )}
                <PreviewButton onClick={() => combineMode === 'join'
                  ? runPreview('join', { right, leftKey: valid(leftKey), rightKey, how: joinHow }, { right: recordedRight(right), leftKey: valid(leftKey), rightKey, how: joinHow })
                  : runPreview('append_rows', { right }, { right: recordedRight(right) })} />
              </>
            )}
          </div>
        )}

        {tab === 'summarise' && (
          <div className="space-y-4">
            <div className="segmented w-max" role="group" aria-label="Summary type">
              <button type="button" aria-pressed={sumMode === 'group'} onClick={() => { setSumMode('group'); reset(); }}>Group and summarise</button>
              <button type="button" aria-pressed={sumMode === 'pivot'} onClick={() => { setSumMode('pivot'); reset(); }}>Pivot</button>
            </div>
            <p className="text-xs text-label-2">The result replaces the current data with the summary table as a new version. Undo or History brings the full data back.</p>
            {sumMode === 'group' ? (
              <>
                <div>
                  <span className="field-label">Group by</span>
                  <div className="flex flex-wrap gap-2">
                    {groupBy.map((g, i) => (
                      <div key={i} className="flex items-center gap-1">
                        <select className="input w-auto" aria-label={`Group by column ${i + 1}`} value={valid(g)} onChange={e => { setGroupBy(groupBy.map((x, j) => (j === i ? e.target.value : x))); reset(); }}>
                          {names.map(n => <option key={n} value={n}>{n}</option>)}
                        </select>
                        {groupBy.length > 1 && (
                          <button type="button" className="btn btn-icon w-8 h-8" aria-label="Remove grouping column" onClick={() => { setGroupBy(groupBy.filter((_, j) => j !== i)); reset(); }}>
                            <X className="w-4 h-4" />
                          </button>
                        )}
                      </div>
                    ))}
                    {groupBy.length < 3 && (
                      <button type="button" className="btn btn-sm btn-plain" onClick={() => { setGroupBy([...groupBy, names.find(n => !groupBy.includes(n)) ?? first]); reset(); }}>
                        <Plus className="w-4 h-4" /> Add
                      </button>
                    )}
                  </div>
                </div>
                <div>
                  <span className="field-label">Summaries</span>
                  <div className="space-y-2">
                    {aggs.map((a, i) => (
                      <div key={i} className="flex flex-wrap items-center gap-2">
                        <select className="input w-auto" aria-label={`Summary ${i + 1}`} value={a.fn} onChange={e => { setAggs(aggs.map((x, j) => (j === i ? { ...x, fn: e.target.value as AggregateFn } : x))); reset(); }}>
                          {(Object.keys(AGG_LABELS) as AggregateFn[]).map(f => <option key={f} value={f}>{AGG_LABELS[f]}</option>)}
                        </select>
                        <span className="text-sm text-label-2">of</span>
                        <select className="input w-auto" aria-label={`Summary ${i + 1} column`} value={valid(a.column)} onChange={e => { setAggs(aggs.map((x, j) => (j === i ? { ...x, column: e.target.value } : x))); reset(); }}>
                          {names.map(n => <option key={n} value={n}>{n}</option>)}
                        </select>
                        {aggs.length > 1 && (
                          <button type="button" className="btn btn-icon w-8 h-8" aria-label="Remove summary" onClick={() => { setAggs(aggs.filter((_, j) => j !== i)); reset(); }}>
                            <X className="w-4 h-4" />
                          </button>
                        )}
                      </div>
                    ))}
                    <button type="button" className="btn btn-sm btn-plain" onClick={() => { setAggs([...aggs, { column: numeric[0] ?? first, fn: numeric[0] ? 'mean' : 'count' }]); reset(); }}>
                      <Plus className="w-4 h-4" /> Add Summary
                    </button>
                  </div>
                </div>
                <PreviewButton onClick={() => runPreview('group_aggregate', { by: groupBy.map(g => valid(g)), aggregations: aggs.map(a => ({ ...a, column: valid(a.column) })) })} />
              </>
            ) : (
              <>
                <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
                  <div><label className="field-label" htmlFor="p-index">Rows</label>{columnSelect('p-index', pIndex, setPIndex)}</div>
                  <div><label className="field-label" htmlFor="p-cols">Columns from</label>{columnSelect('p-cols', pColumns, setPColumns)}</div>
                  <div><label className="field-label" htmlFor="p-vals">Values</label>{columnSelect('p-vals', pValues, setPValues)}</div>
                  <div>
                    <label className="field-label" htmlFor="p-fn">Combine with</label>
                    <select id="p-fn" className="input" value={pFn} onChange={e => { setPFn(e.target.value as AggregateFn); reset(); }}>
                      {(Object.keys(AGG_LABELS) as AggregateFn[]).map(f => <option key={f} value={f}>{AGG_LABELS[f]}</option>)}
                    </select>
                  </div>
                </div>
                <PreviewButton onClick={() => runPreview('pivot', { index: valid(pIndex), columns: valid(pColumns), values: valid(pValues, numeric[0] ?? first), fn: pFn })} />
              </>
            )}
          </div>
        )}

        {tab === 'workflows' && (
          <WorkflowsTab
            dataset={dataset}
            datasetId={datasetId}
            activeVersionId={activeVersionId}
            onPreview={(result) => { setError(null); setPreview({ result, source: dataset, tab: 'workflows' }); }}
            onError={setError}
          />
        )}

        {error && (
          <p role="alert" className="mt-4 flex items-start gap-2 rounded-xl bg-red/10 px-3 py-2.5 text-sm text-red">
            <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" /> {error}
          </p>
        )}

        {livePreview && <PreviewPanel before={dataset} preview={livePreview} onApply={apply} onCancel={reset} />}
      </div>
    </section>
  );
}

function PreviewButton({ onClick }: { onClick: () => void }) {
  return <button type="button" onClick={onClick} className="btn btn-secondary">Preview</button>;
}

function PreviewPanel({ before, preview, onApply, onCancel }: { before: Dataset; preview: Preview; onApply: () => void; onCancel: () => void }) {
  const after = preview.result.dataset;
  const cols = after.columns.slice(0, 8).map(c => c.name);
  const rows = after.rows.slice(0, 5);
  const fmt = (v: unknown) => (v === null || v === undefined || v === '' ? '—' : typeof v === 'number' ? String(parseFloat(v.toFixed(4))) : String(v));
  return (
    <div className="mt-5 rounded-2xl bg-well p-4 animate-fade-in" role="region" aria-label="Preview">
      <p className="text-sm font-semibold text-label">Preview</p>
      <p className="mt-1 text-sm text-label">{preview.result.summary}</p>
      <p className="mt-1 text-xs text-label-2 tabular-nums">
        {before.rows.length.toLocaleString()} rows × {before.columns.length} columns → {after.rows.length.toLocaleString()} rows × {after.columns.length} columns
      </p>
      {rows.length > 0 && (
        <div className="mt-3 overflow-x-auto rounded-xl border border-separator bg-surface">
          <table className="w-full text-xs tabular-nums">
            <thead>
              <tr>{cols.map(c => <th key={c} className="text-left font-medium text-label-2 px-3 py-2 whitespace-nowrap">{c}</th>)}</tr>
            </thead>
            <tbody className="divide-y divide-separator">
              {rows.map((r, i) => (
                <tr key={i}>{cols.map(c => <td key={c} className="px-3 py-1.5 text-label whitespace-nowrap max-w-[200px] truncate">{fmt(r[c])}</td>)}</tr>
              ))}
            </tbody>
          </table>
          {after.columns.length > cols.length && (
            <p className="px-3 py-1.5 text-[11px] text-label-3">First {cols.length} of {after.columns.length} columns shown.</p>
          )}
        </div>
      )}
      <div className="mt-4 flex gap-2">
        <button type="button" onClick={onApply} className="btn btn-primary">Apply</button>
        <button type="button" onClick={onCancel} className="btn btn-secondary">Cancel</button>
      </div>
    </div>
  );
}

function makeWorkflow(name: string, steps: AppliedOperation[], datasetName: string, versionLabel: string): SavedWorkflow {
  return { id: crypto.randomUUID(), name, steps, createdAt: Date.now(), source: { datasetName, versionLabel } };
}

function WorkflowsTab({ dataset, datasetId, activeVersionId, onPreview, onError }: {
  dataset: Dataset; datasetId: string | null; activeVersionId: string | null;
  onPreview: (r: OperationResult) => void; onError: (e: string | null) => void;
}) {
  const [chain, setChain] = useState<DatasetVersion[]>([]);
  const [saved, setSaved] = useState<SavedWorkflow[]>([]);
  const [name, setName] = useState('');
  const [message, setMessage] = useState<string | null>(null);
  const [running, setRunning] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const [versions, workflows] = await Promise.all([datasetId ? listVersions(datasetId) : Promise.resolve([]), listWorkflows()]);
      if (cancelled) return;
      setChain(lineage(versions, activeVersionId));
      setSaved(workflows);
    })().catch(err => onError(String(err?.message || err)));
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [datasetId, activeVersionId]);

  const { steps, skipped } = workflowSteps(chain);

  const save = async () => {
    const w = makeWorkflow(name.trim() || `Steps from ${dataset.filename}`, steps, dataset.filename, chain[chain.length - 1]?.label ?? '');
    await saveWorkflow(w);
    setSaved(prev => [w, ...prev]);
    setName('');
    setMessage(`Saved “${w.name}” with ${steps.length} step${steps.length === 1 ? '' : 's'}.`);
  };

  const preview = async (w: SavedWorkflow) => {
    setRunning(w.id);
    onError(null);
    try {
      const r = await runWorkflow(dataset, w.steps, getVersion);
      onPreview({ dataset: r.dataset, summary: `Applied workflow “${w.name}”: ${r.stepSummaries.join(' ')}` });
    } catch (err) {
      onError((err as Error).message);
    } finally {
      setRunning(null);
    }
  };

  return (
    <div className="space-y-6">
      <div className="space-y-3">
        <p className="text-sm text-label-2">
          A workflow is the list of cleaning steps that produced this version. Save it, then run it on a new file
          (for example next month’s export) to clean it the same way.
        </p>
        {steps.length === 0 ? (
          <p className="text-sm text-label-3">No repeatable steps yet: steps made with the Clean tools and More tools can be saved.</p>
        ) : (
          <>
            <ol className="list-decimal pl-5 text-sm text-label space-y-0.5">
              {chain.slice(1).filter(v => v.operation).map(v => <li key={v.id}>{v.label}</li>)}
            </ol>
            {skipped.length > 0 && (
              <p className="text-xs text-orange">Not repeatable, so left out: {skipped.join('; ')}.</p>
            )}
            <div className="flex flex-wrap gap-2">
              <input className="input w-64" aria-label="Workflow name" placeholder="Workflow name" value={name} onChange={e => setName(e.target.value)} />
              <button type="button" onClick={save} className="btn btn-secondary">Save Workflow</button>
            </div>
            {message && <p role="status" className="text-sm text-green">{message}</p>}
          </>
        )}
      </div>

      {saved.length > 0 && (
        <div>
          <p className="field-label">Saved workflows</p>
          <ul className="rounded-2xl bg-well divide-y divide-separator">
            {saved.map(w => (
              <li key={w.id} className="flex flex-wrap items-center gap-3 px-4 py-3">
                <div className="min-w-0 flex-1">
                  <p className="text-sm text-label">{w.name}</p>
                  <p className="text-xs text-label-2">{w.steps.length} step{w.steps.length === 1 ? '' : 's'} · from {w.source.datasetName}</p>
                </div>
                <button type="button" className="btn btn-sm btn-secondary" disabled={running === w.id} onClick={() => preview(w)}>
                  {running === w.id ? <><Orb state="working" label="Running the workflow" /> Running…</> : 'Preview on This Data'}
                </button>
                <button
                  type="button"
                  className="btn btn-icon w-8 h-8 text-red hover:bg-red/10"
                  aria-label={`Delete workflow ${w.name}`}
                  onClick={async () => { await deleteWorkflow(w.id); setSaved(prev => prev.filter(x => x.id !== w.id)); }}
                >
                  <Trash2 className="w-4 h-4" />
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
