/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState, useEffect } from 'react';
import { Trash2, RotateCcw, CheckCircle, Plus, Minus, AlertTriangle, X } from 'lucide-react';
import { Dataset, CleaningOperation } from '../types';
import DeepQualityAudit from './DeepQualityAudit';
import { usePipelineContext } from '../contexts/PipelineContext';
import { describeCleaningOperation } from '../utils/cleaningOperations';
import {
  AppliedOperation, DeriveTransform, OperationError, OperationId, OperationParams, OperationResult, applyOperation,
} from '../operations/registry';

interface DataCleaningProps {
  dataset: Dataset;
  onUpdateDataset: (updated: Dataset, operation?: AppliedOperation) => void;
  onResetOriginal: () => void;
}

export default function DataCleaning({ dataset, onUpdateDataset, onResetOriginal }: DataCleaningProps) {
  const { expertMode, setCleaningSteps } = usePipelineContext();
  const [selectedCol, setSelectedCol] = useState(dataset.columns[0]?.name || '');
  const [imputeStrategy, setImputeStrategy] = useState<'mean' | 'median' | 'zero' | 'mode'>('mean');
  const [operations, setOperations] = useState<CleaningOperation[]>([]);
  const [successMsg, setSuccessMsg] = useState<string | null>(null);

  // Mirror the real, locally-tracked operations into shared context so other
  // stages (e.g. the ETL Code Exporter in Reports) can reference what was
  // actually done to this dataset, instead of guessing or hardcoding it.
  useEffect(() => {
    setCleaningSteps(operations);
  }, [operations, setCleaningSteps]);

  // States for Adding Column
  const [newColName, setNewColName] = useState('');
  const [newColType, setNewColType] = useState<'numeric' | 'categorical' | 'boolean'>('categorical');
  const [newColDefault, setNewColDefault] = useState('');

  // States for Deleting Row
  const [deleteIndexInput, setDeleteIndexInput] = useState('');

  // States for Group By
  const [groupByCol, setGroupByCol] = useState(dataset.columns[0]?.name || '');
  const [aggCol, setAggCol] = useState(dataset.columns[0]?.name || '');
  const [aggFunc, setAggFunc] = useState<'count' | 'sum' | 'mean' | 'min' | 'max'>('count');
  const [groupByResult, setGroupByResult] = useState<{ key: string; val: number }[] | null>(null);

  // States for Feature Engineering Studio
  const [feTransform, setFeTransform] = useState<'log' | 'sqrt' | 'square' | 'minmax' | 'standard' | 'interaction_mul' | 'interaction_div' | 'onehot'>('log');
  const [feSourceColA, setFeSourceColA] = useState(dataset.columns[0]?.name || '');
  const [feSourceColB, setFeSourceColB] = useState(dataset.columns[1]?.name || dataset.columns[0]?.name || '');
  const [feNewColName, setFeNewColName] = useState('');
  const [feResultDetails, setFeResultDetails] = useState<{msg: string, reason: string} | null>(null);

  // Sync columns structure when it updates
  React.useEffect(() => {
    if (dataset.columns.length > 0) {
      const names = dataset.columns.map(c => c.name);
      if (!names.includes(selectedCol)) {
        setSelectedCol(names[0]);
      }
      if (!names.includes(groupByCol)) {
        setGroupByCol(names[0]);
      }
      if (!names.includes(aggCol)) {
        setAggCol(names[0]);
      }
      if (!names.includes(feSourceColA)) {
        setFeSourceColA(names[0]);
      }
      if (!names.includes(feSourceColB)) {
        setFeSourceColB(names[1] || names[0]);
      }
    }
  }, [dataset.columns]);

  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const triggerSuccess = (msg: string) => {
    setErrorMsg(null);
    setSuccessMsg(msg);
    setTimeout(() => setSuccessMsg(null), 3000);
  };

  // Every change runs through the shared operation registry, so the Clean
  // step, the assistant and saved history all compute it the same way.
  const runOperation = <K extends OperationId>(
    op: K,
    params: OperationParams[K],
    record: Omit<CleaningOperation, 'id'>,
  ): OperationResult | null => {
    try {
      const result = applyOperation(dataset, op, params);
      setOperations(prev => [...prev, { id: crypto.randomUUID(), ...record }]);
      onUpdateDataset(result.dataset, { op, params } as AppliedOperation);
      triggerSuccess(result.summary);
      return result;
    } catch (err) {
      if (err instanceof OperationError) {
        setErrorMsg(err.message);
        return null;
      }
      throw err;
    }
  };

  // 1. DROP COLUMN
  const handleDropColumn = (colName: string) => {
    runOperation('drop_columns', { columns: [colName] }, { type: 'drop_column', column: colName, params: {} });
  };

  // 2. FILL MISSING VALUE
  const handleImputation = () => {
    if (!selectedCol) return;
    const col = dataset.columns.find(c => c.name === selectedCol);
    // Mean and median only make sense for numbers; text columns use the most common value.
    const strategy = col && col.type !== 'numeric' && imputeStrategy !== 'mode' ? 'mode' : imputeStrategy;
    const result = runOperation('fill_missing', { column: selectedCol, strategy }, {
      type: 'fill_missing', column: selectedCol, params: { strategy },
    });
    if (result) {
      const used = result.dataset.columns.find(c => c.name === selectedCol);
      setOperations(prev => prev.map((op, i) => i === prev.length - 1 ? { ...op, params: { strategy, missingBefore: col?.missingCount, missingAfter: used?.missingCount } } : op));
    }
  };

  // 3. ADD COLUMN
  const handleAddColumn = () => {
    const name = newColName.trim();
    const result = runOperation('add_column', { name, type: newColType, value: newColDefault === '' ? null : newColDefault }, {
      type: 'type_convert', column: name, params: { action: 'add_column', type: newColType, defaultValue: newColDefault },
    });
    if (result) {
      setNewColName('');
      setNewColDefault('');
    }
  };

  // 4. ADD NEW ROW
  const handleAddNewRow = () => {
    runOperation('add_row', {}, { type: 'add_row', column: '', params: { rowIndex: dataset.rows.length } });
  };

  // 5. DELETE ROW BY INDEX
  const handleDeleteRow = (index: number) => {
    runOperation('delete_rows', { indices: [index] }, { type: 'delete_row', column: '', params: { index } });
  };

  // 6. GROUP BY AND AGGREGATE
  const calculateGroupBy = () => {
    if (!groupByCol) return;
    
    const groups: Record<string, number[]> = {};
    dataset.rows.forEach(row => {
      const gKey = String(row[groupByCol] !== null && row[groupByCol] !== undefined && row[groupByCol] !== '' ? row[groupByCol] : 'N/A');
      if (!groups[gKey]) {
        groups[gKey] = [];
      }
      if (aggCol) {
        const val = row[aggCol];
        const numericVal = Number(val);
        if (!isNaN(numericVal) && val !== null && val !== '') {
          groups[gKey].push(numericVal);
        } else {
          groups[gKey].push(0);
        }
      } else {
        groups[gKey].push(1);
      }
    });

    const summary = Object.entries(groups).map(([key, vals]) => {
      let aggregatedVal = 0;
      if (aggFunc === 'count') {
        aggregatedVal = vals.length;
      } else if (aggFunc === 'sum') {
        aggregatedVal = vals.reduce((a, b) => a + b, 0);
      } else if (aggFunc === 'mean') {
        aggregatedVal = vals.length > 0 ? (vals.reduce((a, b) => a + b, 0) / vals.length) : 0;
      } else if (aggFunc === 'min') {
        aggregatedVal = vals.length > 0 ? vals.reduce((a, b) => (a < b ? a : b), vals[0]) : 0;
      } else if (aggFunc === 'max') {
        aggregatedVal = vals.length > 0 ? vals.reduce((a, b) => (a > b ? a : b), vals[0]) : 0;
      }
      return { key, val: parseFloat(aggregatedVal.toFixed(2)) };
    });

    summary.sort((a, b) => (typeof b.val === 'number' && typeof a.val === 'number' ? b.val - a.val : 0));
    setGroupByResult(summary);
    triggerSuccess(`Computed group aggregation metrics on "${groupByCol}".`);
  };

  const FE_REASONS: Record<string, string> = {
    log: 'A log transform compresses right-skewed data, bringing large values closer together.',
    sqrt: 'A square root handles right-skewed data less aggressively than log; useful for counts.',
    square: 'Squaring stretches the spread of values and emphasises large ones.',
    minmax: 'Min–max scaling maps values onto 0–1 using the column’s real minimum and maximum, without changing the shape.',
    standard: 'Standardising gives the column a mean of 0 and a standard deviation of 1, so features share a scale.',
    interaction_mul: `Multiplying ${feSourceColA} by ${feSourceColB} captures their combined effect.`,
    interaction_div: `Dividing ${feSourceColA} by ${feSourceColB} creates a ratio feature.`,
    onehot: 'Each category became its own 1/0 column, which models that need numbers can use.',
  };

  const handleApplyFeatureEngineering = () => {
    if (!feSourceColA) return;
    let result: OperationResult | null;
    if (feTransform === 'onehot') {
      const before = new Set(dataset.columns.map(c => c.name));
      result = runOperation('one_hot_encode', { column: feSourceColA, prefix: feNewColName.trim() || undefined }, {
        type: 'type_convert', column: feSourceColA, params: { action: 'onehot' },
      });
      if (result) {
        const added = result.dataset.columns.map(c => c.name).filter(n => !before.has(n));
        setOperations(prev => prev.map((op, i) => i === prev.length - 1 ? { ...op, params: { action: 'onehot', newColumns: added } } : op));
      }
    } else {
      const transform: DeriveTransform =
        feTransform === 'interaction_mul' ? 'multiply' : feTransform === 'interaction_div' ? 'divide' : feTransform;
      const before = new Set(dataset.columns.map(c => c.name));
      result = runOperation('derive_column', {
        source: feSourceColA,
        transform,
        other: transform === 'multiply' || transform === 'divide' ? feSourceColB : undefined,
        name: feNewColName.trim() || undefined,
      }, { type: 'type_convert', column: feSourceColA, params: { action: feTransform } });
      if (result) {
        const added = result.dataset.columns.map(c => c.name).find(n => !before.has(n));
        setOperations(prev => prev.map((op, i) => i === prev.length - 1 ? { ...op, params: { action: feTransform, newColumn: added } } : op));
      }
    }
    if (result) {
      setFeNewColName('');
      setFeResultDetails({ msg: result.summary, reason: FE_REASONS[feTransform] });
    }
  };

  const resetAll = () => {
    setOperations([]);
    setGroupByResult(null);
    onResetOriginal();
    triggerSuccess('Dataset completely restored to original raw state.');
  };

  const columnOptions = (withType = false) =>
    dataset.columns.map(c => (
      <option key={c.name} value={c.name}>
        {c.name}{withType ? ` (${c.type})` : ''}
      </option>
    ));

  return (
    <div className="space-y-12" id="cleaning_module">
      {errorMsg && (
        <div role="alert" className="fixed bottom-6 left-1/2 -translate-x-1/2 z-50 flex items-center gap-2 rounded-full bg-raised shadow-xl px-4 py-2.5 text-sm font-medium text-red animate-toast-in">
          <AlertTriangle className="w-4 h-4 shrink-0" />
          {errorMsg}
          <button type="button" onClick={() => setErrorMsg(null)} className="ml-1 -mr-1 p-0.5 rounded-full hover:bg-fill" aria-label="Dismiss">
            <X className="w-3.5 h-3.5" />
          </button>
        </div>
      )}

      {/* Confirmation — a brief, unobtrusive toast. */}
      {successMsg && (
        <div
          role="status"
          className="fixed bottom-6 left-1/2 -translate-x-1/2 z-50 flex items-center gap-2 rounded-full bg-raised shadow-xl px-4 py-2.5 text-sm font-medium text-label animate-toast-in"
        >
          <CheckCircle className="w-4 h-4 text-green shrink-0" />
          {successMsg}
        </div>
      )}

      <section aria-labelledby="tools-heading">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div>
            <h2 id="tools-heading" className="section-title">Fix and reshape</h2>
            <p className="mt-1 text-sm text-label-2">Every change applies instantly and shows up in the preview below.</p>
          </div>
          <button type="button" onClick={resetAll} className="btn btn-secondary" disabled={operations.length === 0}>
            <RotateCcw className="w-4 h-4" /> Reset to Original
          </button>
        </div>

        {operations.length > 0 && (
          <div className="mt-4 flex flex-wrap items-center gap-2" aria-label="Changes applied">
            <span className="text-xs font-medium text-label-2 mr-1">
              {operations.length} {operations.length === 1 ? 'change' : 'changes'} applied
            </span>
            {operations.map((op) => (
              <span key={op.id} className="tag bg-green/12 text-green">
                <CheckCircle className="w-3 h-3" />
                {describeCleaningOperation(op)}
              </span>
            ))}
          </div>
        )}

        <div className="mt-5 grid grid-cols-1 lg:grid-cols-2 gap-5">
          {/* Fill missing values */}
          <div className="card p-5 sm:p-6 flex flex-col">
            <h3 className="card-title">Fill missing values</h3>
            <p className="mt-1 text-sm text-label-2">Replace empty cells in a column with a sensible value.</p>

            <div className="mt-5 space-y-4 flex-1">
              <div>
                <label className="field-label" htmlFor="impute-col">Column</label>
                <select
                  id="impute-col"
                  value={selectedCol}
                  onChange={(e) => setSelectedCol(e.target.value)}
                  className="input"
                >
                  {dataset.columns.map(c => (
                    <option key={c.name} value={c.name}>
                      {c.name} — {c.missingCount === 0 ? 'no missing values' : `${c.missingCount} missing`}
                    </option>
                  ))}
                </select>
              </div>

              <div>
                <span className="field-label">Fill with</span>
                <div className="grid grid-cols-2 gap-2">
                  {[
                    { key: 'mean', title: 'Average', desc: 'Mean of the column' },
                    { key: 'median', title: 'Median', desc: 'Middle value' },
                    { key: 'zero', title: 'Zero', desc: 'Set empty cells to 0' },
                    { key: 'mode', title: 'Most common', desc: 'Best for categories' },
                  ].map((strategy) => (
                    <button
                      key={strategy.key}
                      type="button"
                      aria-pressed={imputeStrategy === strategy.key}
                      onClick={() => setImputeStrategy(strategy.key as any)}
                      className="option"
                    >
                      <span className="block text-sm font-medium text-label">{strategy.title}</span>
                      <span className="block text-xs text-label-2 mt-0.5">{strategy.desc}</span>
                    </button>
                  ))}
                </div>
              </div>
            </div>

            <button type="button" onClick={handleImputation} className="btn btn-primary w-full mt-5">
              Fill Missing Values
            </button>
          </div>

          {/* Remove columns */}
          <div className="card p-5 sm:p-6 flex flex-col">
            <h3 className="card-title">Remove columns</h3>
            <p className="mt-1 text-sm text-label-2">
              Drop IDs and anything that won’t help the analysis. IDs can mislead a model.
            </p>

            <ul className="mt-5 -mx-2 flex-1 max-h-[304px] overflow-y-auto divide-y divide-separator">
              {dataset.columns.map(col => {
                const isId = col.name.toLowerCase().includes('id') || col.name.toLowerCase() === 'index';
                return (
                  <li key={col.name} className="flex items-center justify-between gap-3 px-2 py-2">
                    <span className="flex items-center gap-2 min-w-0">
                      <span className="text-sm text-label truncate">{col.name}</span>
                      {isId && <span className="tag bg-orange/12 text-orange">Looks like an ID</span>}
                    </span>
                    <button
                      type="button"
                      onClick={() => handleDropColumn(col.name)}
                      className="btn btn-icon w-8 h-8 text-red hover:text-red hover:bg-red/10 shrink-0"
                      title={`Remove ${col.name}`}
                      aria-label={`Remove column ${col.name}`}
                    >
                      <Trash2 className="w-4 h-4" />
                    </button>
                  </li>
                );
              })}
            </ul>
          </div>

          {/* Add a column */}
          <div className="card p-5 sm:p-6 flex flex-col">
            <h3 className="card-title">Add a column</h3>
            <p className="mt-1 text-sm text-label-2">Create a new column with the same starting value in every row.</p>

            <div className="mt-5 grid grid-cols-1 sm:grid-cols-2 gap-4 flex-1 content-start">
              <div>
                <label className="field-label" htmlFor="new-col-name">Name</label>
                <input
                  id="new-col-name"
                  value={newColName}
                  onChange={(e) => setNewColName(e.target.value)}
                  placeholder="TenureInYears"
                  className="input"
                />
              </div>
              <div>
                <label className="field-label" htmlFor="new-col-type">Type</label>
                <select
                  id="new-col-type"
                  value={newColType}
                  onChange={(e) => setNewColType(e.target.value as any)}
                  className="input"
                >
                  <option value="categorical">Categorical</option>
                  <option value="numeric">Numeric</option>
                  <option value="boolean">Boolean</option>
                </select>
              </div>
              <div className="sm:col-span-2">
                <label className="field-label" htmlFor="new-col-default">Starting value</label>
                <input
                  id="new-col-default"
                  value={newColDefault}
                  onChange={(e) => setNewColDefault(e.target.value)}
                  placeholder="0, Unknown, or true"
                  className="input"
                />
              </div>
            </div>

            <button type="button" onClick={handleAddColumn} className="btn btn-secondary w-full mt-5">
              <Plus className="w-4 h-4" /> Add Column
            </button>
          </div>

          {/* Rows */}
          <div className="card p-5 sm:p-6 flex flex-col">
            <h3 className="card-title">Add or remove rows</h3>
            <p className="mt-1 text-sm text-label-2">
              Append an empty row, or delete one by its number in the preview.
            </p>

            <div className="mt-5 space-y-4 flex-1">
              <button type="button" onClick={handleAddNewRow} className="btn btn-secondary w-full">
                <Plus className="w-4 h-4" /> Add Empty Row
              </button>

              <form
                className="flex items-end gap-3 pt-4 border-t border-separator"
                onSubmit={(e) => {
                  e.preventDefault();
                  const idx = parseInt(deleteIndexInput);
                  if (!isNaN(idx)) {
                    handleDeleteRow(idx);
                    setDeleteIndexInput('');
                  }
                }}
              >
                <div className="flex-1">
                  <label className="field-label" htmlFor="delete-row">Row number</label>
                  <input
                    id="delete-row"
                    type="number"
                    min={0}
                    value={deleteIndexInput}
                    onChange={(e) => setDeleteIndexInput(e.target.value)}
                    placeholder="0"
                    className="input"
                  />
                </div>
                <button
                  type="submit"
                  disabled={deleteIndexInput === '' || isNaN(parseInt(deleteIndexInput))}
                  className="btn bg-red/10 text-red hover:bg-red/15 shrink-0"
                >
                  <Minus className="w-4 h-4" /> Delete Row
                </button>
              </form>
            </div>
          </div>

          {/* Group and summarize (Expert) */}
          {expertMode && (
            <div className="card p-5 sm:p-6 flex flex-col">
              <h3 className="card-title">Group and summarize</h3>
              <p className="mt-1 text-sm text-label-2">
                Group rows by one column and calculate a count, total or average of another.
              </p>

              <div className="mt-5 space-y-4 flex-1">
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                  <div>
                    <label className="field-label" htmlFor="group-col">Group by</label>
                    <select id="group-col" value={groupByCol} onChange={(e) => setGroupByCol(e.target.value)} className="input">
                      {columnOptions()}
                    </select>
                  </div>
                  <div>
                    <label className="field-label" htmlFor="agg-col">Summarize</label>
                    <select id="agg-col" value={aggCol} onChange={(e) => setAggCol(e.target.value)} className="input">
                      {columnOptions(true)}
                    </select>
                  </div>
                </div>

                <div>
                  <span className="field-label">Function</span>
                  <div className="segmented w-full" role="group" aria-label="Aggregation function">
                    {(['count', 'sum', 'mean', 'min', 'max'] as const).map((f) => (
                      <button
                        key={f}
                        type="button"
                        aria-pressed={aggFunc === f}
                        onClick={() => setAggFunc(f)}
                        className="flex-1 capitalize"
                      >
                        {f}
                      </button>
                    ))}
                  </div>
                </div>

                {groupByResult && (
                  <div className="rounded-xl bg-well max-h-[176px] overflow-y-auto">
                    <table className="w-full text-sm">
                      <thead>
                        <tr className="text-xs border-b border-separator">
                          <th className="px-3 py-2 text-left">{groupByCol}</th>
                          <th className="px-3 py-2 text-right">{aggFunc}({aggCol})</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-separator">
                        {groupByResult.slice(0, 50).map((r, idx) => (
                          <tr key={idx}>
                            <td className="px-3 py-1.5 text-label truncate max-w-[180px]">{r.key}</td>
                            <td className="px-3 py-1.5 text-right font-medium text-label">{r.val}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </div>

              <button type="button" onClick={calculateGroupBy} className="btn btn-secondary w-full mt-5">
                Calculate
              </button>
            </div>
          )}

          {/* Feature engineering (Expert) */}
          {expertMode && (
            <div className="card p-5 sm:p-6 flex flex-col">
              <h3 className="card-title">Engineer a feature</h3>
              <p className="mt-1 text-sm text-label-2">
                Scale, transform or combine columns to give a model stronger signals.
              </p>

              <div className="mt-5 space-y-4 flex-1">
                <div>
                  <label className="field-label" htmlFor="fe-transform">Transform</label>
                  <select
                    id="fe-transform"
                    value={feTransform}
                    onChange={(e) => setFeTransform(e.target.value as any)}
                    className="input"
                  >
                    <option value="log">Natural log — ln(x + 1)</option>
                    <option value="sqrt">Square root — √x</option>
                    <option value="square">Square — x²</option>
                    <option value="minmax">Min–max scale to 0–1</option>
                    <option value="standard">Standardize (z-score)</option>
                    <option value="interaction_mul">Multiply two columns (A × B)</option>
                    <option value="interaction_div">Divide two columns (A ÷ B)</option>
                    <option value="onehot">One-hot encode categories</option>
                  </select>
                </div>

                <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                  <div>
                    <label className="field-label" htmlFor="fe-col-a">Column A</label>
                    <select id="fe-col-a" value={feSourceColA} onChange={(e) => setFeSourceColA(e.target.value)} className="input">
                      {columnOptions(true)}
                    </select>
                  </div>

                  {(feTransform === 'interaction_mul' || feTransform === 'interaction_div') ? (
                    <div>
                      <label className="field-label" htmlFor="fe-col-b">Column B</label>
                      <select id="fe-col-b" value={feSourceColB} onChange={(e) => setFeSourceColB(e.target.value)} className="input">
                        {dataset.columns.filter(c => c.name !== feSourceColA).map(c => (
                          <option key={c.name} value={c.name}>{c.name} ({c.type})</option>
                        ))}
                      </select>
                    </div>
                  ) : (
                    <div>
                      <label className="field-label" htmlFor="fe-name">New column name <span className="font-normal text-label-3">Optional</span></label>
                      <input
                        id="fe-name"
                        type="text"
                        value={feNewColName}
                        onChange={(e) => setFeNewColName(e.target.value)}
                        placeholder="Generated automatically"
                        className="input"
                      />
                    </div>
                  )}
                </div>

                {feTransform === 'onehot' && (
                  <p className="text-xs text-label-2 leading-relaxed">
                    Each distinct value in “{feSourceColA}” becomes its own true/false column. Recommended for
                    tree-based and linear models.
                  </p>
                )}

                {feResultDetails && (
                  <div className="rounded-xl bg-green/10 px-3 py-2.5 animate-fade-in">
                    <p className="flex items-start gap-2 text-sm font-medium text-label">
                      <CheckCircle className="w-4 h-4 text-green mt-0.5 shrink-0" />
                      {feResultDetails.msg}
                    </p>
                    <p className="mt-1 pl-6 text-xs text-label-2 leading-relaxed">{feResultDetails.reason}</p>
                  </div>
                )}
              </div>

              <button type="button" onClick={handleApplyFeatureEngineering} className="btn btn-secondary w-full mt-5">
                Apply Transform
              </button>
            </div>
          )}
        </div>
      </section>

      {/* Preview */}
      <section aria-labelledby="preview-heading">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div>
            <h2 id="preview-heading" className="section-title">Preview</h2>
            <p className="mt-1 text-sm text-label-2">
              First 10 of {dataset.rows.length.toLocaleString()} rows · {dataset.columns.length} columns
            </p>
          </div>
        </div>

        <div className="card mt-5 overflow-x-auto">
          <table className="w-full text-left text-sm">
            <thead>
              <tr className="border-b border-separator text-xs">
                <th className="px-4 py-3 w-12 text-right">#</th>
                {dataset.columns.map(c => (
                  <th key={c.name} className="px-4 py-3 min-w-[120px] whitespace-nowrap">{c.name}</th>
                ))}
                <th className="px-4 py-3 w-12" aria-label="Actions" />
              </tr>
            </thead>
            <tbody className="divide-y divide-separator text-label">
              {dataset.rows.slice(0, 10).map((row, i) => (
                <tr key={i} className="group">
                  <td className="px-4 py-2.5 text-right text-label-3">{i}</td>
                  {dataset.columns.map(c => {
                    const cellVal = row[c.name];
                    const isNull = cellVal === null || cellVal === undefined || cellVal === '';
                    return (
                      <td key={c.name} className="px-4 py-2.5 max-w-[200px] truncate">
                        {isNull ? (
                          <span className="tag bg-red/12 text-red">Missing</span>
                        ) : typeof cellVal === 'boolean' ? (
                          <span className={cellVal ? 'text-green' : 'text-label-2'}>{cellVal ? 'True' : 'False'}</span>
                        ) : (
                          String(cellVal)
                        )}
                      </td>
                    );
                  })}
                  <td className="px-2 py-1 text-right">
                    <button
                      type="button"
                      onClick={() => handleDeleteRow(i)}
                      className="btn btn-icon w-8 h-8 text-label-3 hover:text-red hover:bg-red/10"
                      title={`Delete row ${i}`}
                      aria-label={`Delete row ${i}`}
                    >
                      <Trash2 className="w-4 h-4" />
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <DeepQualityAudit dataset={dataset} />
    </div>
  );
}
