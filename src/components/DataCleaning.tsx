/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState, useEffect } from 'react';
import { Trash2, RotateCcw, CheckCircle, Plus, Minus } from 'lucide-react';
import { Dataset, CleaningOperation, DatasetColumn } from '../types';
import DeepQualityAudit from './DeepQualityAudit';
import { usePipelineContext } from '../contexts/PipelineContext';
import { describeCleaningOperation } from '../utils/cleaningOperations';

interface DataCleaningProps {
  dataset: Dataset;
  onUpdateDataset: (updated: Dataset) => void;
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

  const triggerSuccess = (msg: string) => {
    setSuccessMsg(msg);
    setTimeout(() => setSuccessMsg(null), 3000);
  };

  // 1. DROP COLUMN
  const handleDropColumn = (colName: string) => {
    const updatedColumns = dataset.columns.filter(c => c.name !== colName);
    const updatedRows = dataset.rows.map(row => {
      const copy = { ...row };
      delete copy[colName];
      return copy;
    });

    const newOp: CleaningOperation = {
      id: crypto.randomUUID(),
      type: 'drop_column',
      column: colName,
      params: {}
    };

    setOperations([...operations, newOp]);
    onUpdateDataset({
      ...dataset,
      columns: updatedColumns,
      rows: updatedRows,
      rowCount: updatedRows.length
    });
    triggerSuccess(`Column "${colName}" dropped successfully from active structures.`);
  };

  // 2. FILL MISSING VALUE
  const handleImputation = () => {
    if (!selectedCol) return;
    const colMetadata = dataset.columns.find(c => c.name === selectedCol);
    if (!colMetadata) return;

    let fillValue: any = 0;
    
    if (colMetadata.type === 'numeric') {
      if (imputeStrategy === 'mean') {
        fillValue = colMetadata.statistics.mean || 0;
      } else if (imputeStrategy === 'median') {
        fillValue = colMetadata.statistics.median || 0;
      } else {
        fillValue = 0;
      }
    } else {
      fillValue = colMetadata.statistics.mostCommon?.[0]?.value || 'Unknown';
    }

    const updatedRows = dataset.rows.map(row => {
      const val = row[selectedCol];
      if (val === null || val === undefined || val === '') {
        return { ...row, [selectedCol]: fillValue };
      }
      return row;
    });

    // Update statistics
    const updatedColumns = dataset.columns.map(col => {
      if (col.name === selectedCol) {
        return {
          ...col,
          missingCount: 0
        };
      }
      return col;
    });

    const newOp: CleaningOperation = {
      id: crypto.randomUUID(),
      type: 'fill_missing',
      column: selectedCol,
      params: { strategy: imputeStrategy, valueUsed: fillValue }
    };

    setOperations([...operations, newOp]);
    onUpdateDataset({
      ...dataset,
      columns: updatedColumns,
      rows: updatedRows
    });
    triggerSuccess(`Filled missing values in "${selectedCol}" using strategy "${imputeStrategy}" (${fillValue}).`);
  };

  // 3. ADD COLUMN
  const handleAddColumn = () => {
    const cleanName = newColName.trim();
    if (!cleanName) {
      alert("Please enter a valid column name");
      return;
    }
    if (dataset.columns.some(c => c.name.toLowerCase() === cleanName.toLowerCase())) {
      alert("A column with this name already exists");
      return;
    }

    let parsedVal: any = newColDefault;
    if (newColType === 'numeric') {
      parsedVal = isNaN(Number(newColDefault)) ? 0 : Number(newColDefault);
    } else if (newColType === 'boolean') {
      parsedVal = newColDefault.toLowerCase() === 'true' || newColDefault === '1';
    }

    const newColMeta: typeof dataset.columns[0] = {
      name: cleanName,
      type: newColType,
      missingCount: 0,
      distinctCount: 1,
      statistics: {
        min: newColType === 'numeric' ? parsedVal : undefined,
        max: newColType === 'numeric' ? parsedVal : undefined,
        mean: newColType === 'numeric' ? parsedVal : undefined,
        median: newColType === 'numeric' ? parsedVal : undefined,
        mostCommon: [{ value: String(parsedVal), count: dataset.rows.length }]
      }
    };

    const updatedRows = dataset.rows.map(row => ({
      ...row,
      [cleanName]: parsedVal
    }));

    const newOp: CleaningOperation = {
      id: crypto.randomUUID(),
      type: 'type_convert', // Recycle operation types cleanly
      column: cleanName,
      params: { action: 'add_column', type: newColType, defaultValue: parsedVal }
    };

    setOperations([...operations, newOp]);
    onUpdateDataset({
      ...dataset,
      columns: [...dataset.columns, newColMeta],
      rows: updatedRows,
    });

    setNewColName('');
    setNewColDefault('');
    triggerSuccess(`Successfully added dynamic column "${cleanName}" (${newColType}) with initial values "${parsedVal}".`);
  };

  // 4. ADD NEW ROW
  const handleAddNewRow = () => {
    const newRow: Record<string, any> = {};
    dataset.columns.forEach(col => {
      if (col.type === 'numeric') {
        newRow[col.name] = 0;
      } else if (col.type === 'boolean') {
        newRow[col.name] = false;
      } else {
        newRow[col.name] = '';
      }
    });

    const updatedRows = [...dataset.rows, newRow];

    // Increment distinct / count stats gently
    const updatedCols = dataset.columns.map(col => ({
      ...col,
      missingCount: col.type !== 'numeric' && col.type !== 'boolean' ? col.missingCount + 1 : col.missingCount
    }));

    const newOp: CleaningOperation = {
      id: crypto.randomUUID(),
      type: 'add_row',
      column: '',
      params: { rowIndex: updatedRows.length - 1 }
    };

    setOperations([...operations, newOp]);
    onUpdateDataset({
      ...dataset,
      columns: updatedCols,
      rows: updatedRows,
      rowCount: updatedRows.length
    });
    triggerSuccess(`Appended a new blank row at the end of the dataset. Total counts: ${updatedRows.length}.`);
  };

  // 5. DELETE ROW BY INDEX
  const handleDeleteRow = (index: number) => {
    if (index < 0 || index >= dataset.rows.length) return;
    const updatedRows = dataset.rows.filter((_, idx) => idx !== index);

    const newOp: CleaningOperation = {
      id: crypto.randomUUID(),
      type: 'delete_row',
      column: '',
      params: { index }
    };

    setOperations([...operations, newOp]);
    onUpdateDataset({
      ...dataset,
      rows: updatedRows,
      rowCount: updatedRows.length
    });
    triggerSuccess(`Successfully deleted row index ${index}. Total counts: ${updatedRows.length}.`);
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

  // HELPER: Calculate complete statistical metadata for any column array
  const computeColumnMeta = (colName: string, type: 'numeric' | 'categorical' | 'boolean' | 'datetime', rows: any[]): DatasetColumn => {
    const vals = rows.map(r => r[colName]);
    const missingCount = vals.filter(v => v === null || v === undefined || v === '').length;
    const nonNulls = vals.filter(v => v !== null && v !== undefined && v !== '');
    const distinctVals = Array.from(new Set(vals));
    const distinctCount = distinctVals.length;
    
    const statistics: any = {};

    if (type === 'numeric') {
      const numerics = nonNulls.map(Number).filter(v => !isNaN(v));
      if (numerics.length > 0) {
        let min = numerics[0];
        let max = numerics[0];
        for (let idx = 1; idx < numerics.length; idx++) {
          if (numerics[idx] < min) min = numerics[idx];
          if (numerics[idx] > max) max = numerics[idx];
        }
        const sum = numerics.reduce((a, b) => a + b, 0);
        const mean = sum / numerics.length;
        
        const sorted = [...numerics].sort((a, b) => a - b);
        const median = sorted[Math.floor(sorted.length / 2)];
        
        const sqDiffSum = numerics.reduce((accum, val) => accum + Math.pow(val - mean, 2), 0);
        const variance = sqDiffSum / numerics.length;
        const stdDev = Math.sqrt(variance);

        statistics.min = parseFloat(min.toFixed(4));
        statistics.max = parseFloat(max.toFixed(4));
        statistics.mean = parseFloat(mean.toFixed(4));
        statistics.median = parseFloat(median.toFixed(4));
        statistics.stdDev = parseFloat(stdDev.toFixed(4));
      }
    }

    // Calculate most common
    const freq: Record<string, number> = {};
    vals.forEach(v => {
      const s = String(v);
      freq[s] = (freq[s] || 0) + 1;
    });
    const sortedFreq = Object.entries(freq)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 8)
      .map(([value, count]) => ({ value, count }));
    statistics.mostCommon = sortedFreq;

    return {
      name: colName,
      type,
      missingCount,
      distinctCount,
      statistics
    };
  };

  const handleApplyFeatureEngineering = () => {
    if (!feSourceColA) return;
    const colA_Meta = dataset.columns.find(c => c.name === feSourceColA);
    if (!colA_Meta) return;

    let targetColName = feNewColName.trim();
    
    // Check if we need numeric source column
    const isSourceANumeric = colA_Meta.type === 'numeric';
    if (!isSourceANumeric && ['log', 'sqrt', 'square', 'minmax', 'standard', 'interaction_mul', 'interaction_div'].includes(feTransform)) {
      alert(`Scaling/Mathematical transforms require a numeric input. Column "${feSourceColA}" is not numeric.`);
      return;
    }

    let updatedRows = [...dataset.rows];
    const createdColsMeta: DatasetColumn[] = [];

    if (feTransform === 'onehot') {
      // One-Hot Encoding
      const uniqueVals = Array.from(new Set(dataset.rows.map(r => String(r[feSourceColA] !== null && r[feSourceColA] !== undefined ? r[feSourceColA] : 'Missing'))))
        .filter(v => v !== '');
      
      if (uniqueVals.length > 25) {
        if (!confirm(`This column has ${uniqueVals.length} distinct values. One-hot encoding will create ${uniqueVals.length} new binary columns, which might clutter your dataset. Continue?`)) {
          return;
        }
      }

      const generatedColNames: string[] = [];
      uniqueVals.forEach(val => {
        const cleanValName = val.replace(/[^a-zA-Z0-9]/g, '_');
        const finalColName = targetColName ? `${targetColName}_${cleanValName}` : `${feSourceColA}_is_${cleanValName}`;
        
        // Prevent duplicate names
        if (dataset.columns.some(c => c.name === finalColName)) {
          return;
        }

        generatedColNames.push(finalColName);
        updatedRows = updatedRows.map(row => {
          const isMatch = String(row[feSourceColA]) === val;
          return {
            ...row,
            [finalColName]: isMatch ? 1 : 0
          };
        });
      });

      if (generatedColNames.length === 0) {
        alert("No new categorical columns generated (or they already existed).");
        return;
      }

      generatedColNames.forEach(colName => {
        const meta = computeColumnMeta(colName, 'numeric', updatedRows);
        createdColsMeta.push(meta);
      });

      const newOp: CleaningOperation = {
        id: crypto.randomUUID(),
        type: 'type_convert',
        column: feSourceColA,
        params: { action: 'onehot', newColumns: generatedColNames }
      };

      setOperations([...operations, newOp]);
      onUpdateDataset({
        ...dataset,
        columns: [...dataset.columns, ...createdColsMeta],
        rows: updatedRows
      });

      setFeNewColName('');
      const msg = `Successfully One-Hot Encoded "${feSourceColA}" into ${generatedColNames.length} binary columns.`;
      const reason = `Extracted distinct categories into standalone boolean flags. Useful for algorithms that require numeric input and fail on nominal strings (e.g. tree-based models, linear regressions).`;
      setFeResultDetails({ msg, reason });
      triggerSuccess(msg);
      return;
    }

    // Mathematical Transforms
    if (!targetColName) {
      if (feTransform === 'log') targetColName = `log_${feSourceColA}`;
      else if (feTransform === 'sqrt') targetColName = `sqrt_${feSourceColA}`;
      else if (feTransform === 'square') targetColName = `sq_${feSourceColA}`;
      else if (feTransform === 'minmax') targetColName = `minmax_${feSourceColA}`;
      else if (feTransform === 'standard') targetColName = `std_${feSourceColA}`;
      else if (feTransform === 'interaction_mul') targetColName = `${feSourceColA}_x_${feSourceColB}`;
      else if (feTransform === 'interaction_div') targetColName = `${feSourceColA}_div_${feSourceColB}`;
    }

    // Check duplicate
    if (dataset.columns.some(c => c.name === targetColName)) {
      alert(`A column named "${targetColName}" already exists. Please provide a unique column name.`);
      return;
    }

    if (feTransform === 'interaction_mul' || feTransform === 'interaction_div') {
      const colB_Meta = dataset.columns.find(c => c.name === feSourceColB);
      if (!colB_Meta || colB_Meta.type !== 'numeric') {
        alert(`Interaction transforms require a numeric column for the second attribute. Column "${feSourceColB}" is not numeric.`);
        return;
      }
    }

    // Process rows
    updatedRows = updatedRows.map(row => {
      const valA = Number(row[feSourceColA]);
      const validA = !isNaN(valA) && row[feSourceColA] !== null && row[feSourceColA] !== '';
      const finalA = validA ? valA : 0;

      let result = 0;
      if (feTransform === 'log') {
        result = Math.log(Math.max(0, finalA) + 1);
      } else if (feTransform === 'sqrt') {
        result = Math.sqrt(Math.max(0, finalA));
      } else if (feTransform === 'square') {
        result = Math.pow(finalA, 2);
      } else if (feTransform === 'minmax') {
        const min = colA_Meta.statistics.min || 0;
        const max = colA_Meta.statistics.max || 100;
        result = max - min !== 0 ? (finalA - min) / (max - min) : 0;
      } else if (feTransform === 'standard') {
        const mean = colA_Meta.statistics.mean || 0;
        const std = colA_Meta.statistics.stdDev || 1;
        result = std !== 0 ? (finalA - mean) / std : 0;
      } else if (feTransform === 'interaction_mul') {
        const valB = Number(row[feSourceColB]);
        const validB = !isNaN(valB) && row[feSourceColB] !== null && row[feSourceColB] !== '';
        result = finalA * (validB ? valB : 0);
      } else if (feTransform === 'interaction_div') {
        const valB = Number(row[feSourceColB]);
        const validB = !isNaN(valB) && row[feSourceColB] !== null && row[feSourceColB] !== '';
        const finalB = validB ? valB : 0;
        result = finalB !== 0 ? finalA / finalB : 0; // Avoid divide-by-zero
      }

      return {
        ...row,
        [targetColName]: parseFloat(result.toFixed(6))
      };
    });

    const meta = computeColumnMeta(targetColName, 'numeric', updatedRows);
    
    const newOp: CleaningOperation = {
      id: crypto.randomUUID(),
      type: 'type_convert',
      column: feSourceColA,
      params: { action: feTransform, newColumn: targetColName }
    };

    setOperations([...operations, newOp]);
    onUpdateDataset({
      ...dataset,
      columns: [...dataset.columns, meta],
      rows: updatedRows
    });

    setFeNewColName('');
    const msg = `Successfully generated feature column "${targetColName}".`;
    let reason = "Transformed numeric distribution.";
    if (feTransform === 'log') reason = "Log transform applies a compressive effect to right-skewed data, bringing outliers closer and normalizing the distribution to improve model stability.";
    else if (feTransform === 'sqrt') reason = "Square root transform similarly handles right-skewed data but is less aggressive than log, useful for count data.";
    else if (feTransform === 'square') reason = "Square transform expands left-skewed distributions and amplifies feature variance.";
    else if (feTransform === 'minmax') reason = "Min-Max normalization scaled the values strictly into a [0, 1] bounds without changing the shape of the distribution, critical for distance-based ML algorithms.";
    else if (feTransform === 'standard') reason = "Standard Scaler (Z-Score) transformed values to have mean=0 and std_dev=1, bringing features to a comparable numeric scale.";
    else if (feTransform === 'interaction_mul') reason = `Multiplicative interaction between ${feSourceColA} and ${feSourceColB} created to capture combined non-linear effects between both features.`;
    else if (feTransform === 'interaction_div') reason = `Division interaction created a proportional ratio feature from ${feSourceColA} and ${feSourceColB}.`;
    
    setFeResultDetails({ msg, reason });
    triggerSuccess(`Successfully generated feature column "${targetColName}"! Recalculated statistical bounds.`);
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
