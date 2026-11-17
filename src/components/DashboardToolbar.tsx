/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useEffect, useMemo, useState } from 'react';
import { Plus, Save, Trash2, X } from 'lucide-react';
import { useDashboardContext } from './DashboardContext';
import { Dataset } from '../types';
import {
  FormulaError, KPI_FUNCTIONS, KpiDefinition, KpiFormat, checkFormula, evaluateFormula, formatKpi,
} from '../utils/kpiFormula';
import { SavedDashboard, deleteDashboard, listDashboards, saveDashboard } from '../utils/workspaceStore';

interface DashboardToolbarProps {
  dataset: Dataset;
  datasetId: string | null;
  /** Called once: true when a saved dashboard was opened, false when there is none. */
  onInitialLoad: (openedSaved: boolean) => void;
}

/**
 * Filters in effect, custom KPIs written as formulas, and saving / reopening
 * dashboards. Everything is computed on the rows currently on screen.
 */
export default function DashboardToolbar({ dataset, datasetId, onInitialLoad }: DashboardToolbarProps) {
  const ctx = useDashboardContext();
  const { categoryFilters, setCategoryFilters, numericSlicers, setNumericSlicers, kpis, setKpis, filteredData } = ctx;
  const [saved, setSaved] = useState<SavedDashboard[]>([]);
  const [openId, setOpenId] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [naming, setNaming] = useState(false);
  const [name, setName] = useState('');
  const [kpiOpen, setKpiOpen] = useState(false);

  function apply(d: SavedDashboard) {
    setOpenId(d.id);
    ctx.setActiveComponents(d.activeComponents);
    ctx.setLayout(d.layout as '2-col' | '3-col' | 'full');
    ctx.setConfig(d.config);
    setCategoryFilters(d.categoryFilters ?? {});
    setNumericSlicers((d.numericSlicers ?? {}) as Record<string, { min: number; max: number }>);
    setKpis(d.kpis ?? []);
  }

  // Load saved dashboards for this dataset, once.
  useEffect(() => {
    let cancelled = false;
    if (!datasetId) { onInitialLoad(false); return; }
    listDashboards(datasetId)
      .then(list => {
        if (cancelled) return;
        setSaved(list);
        // Reopen the most recently saved dashboard for this dataset.
        if (list[0]) apply(list[0]);
        onInitialLoad(!!list[0]);
      })
      .catch(() => { if (!cancelled) onInitialLoad(false); });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [datasetId]);

  const flash = (m: string) => { setMessage(m); setTimeout(() => setMessage(null), 2500); };

  const snapshot = (id: string, dashboardName: string): Omit<SavedDashboard, 'savedAt'> => ({
    id,
    datasetId: datasetId!,
    name: dashboardName,
    activeComponents: ctx.activeComponents,
    layout: ctx.layout,
    config: ctx.config,
    categoryFilters,
    numericSlicers,
    kpis,
  });

  const save = async (asNew: boolean) => {
    if (!datasetId) return;
    const current = saved.find(d => d.id === openId);
    if (!asNew && current) {
      const rec = await saveDashboard(snapshot(current.id, current.name));
      setSaved(s => [rec, ...s.filter(d => d.id !== rec.id)]);
      flash(`Saved “${rec.name}”.`);
      return;
    }
    const finalName = name.trim() || `Dashboard ${saved.length + 1}`;
    const rec = await saveDashboard(snapshot(crypto.randomUUID(), finalName));
    setSaved(s => [rec, ...s]);
    setOpenId(rec.id);
    setNaming(false);
    setName('');
    flash(`Saved “${rec.name}”.`);
  };

  const open = (id: string) => {
    const d = saved.find(x => x.id === id);
    if (d) apply(d);
  };


  const remove = async () => {
    const d = saved.find(x => x.id === openId);
    if (!d || !window.confirm(`Delete the saved dashboard “${d.name}”?`)) return;
    await deleteDashboard(d.id);
    setSaved(s => s.filter(x => x.id !== d.id));
    setOpenId(null);
  };

  const filterChips = [
    ...Object.entries(categoryFilters as Record<string, string[]>).flatMap(([col, values]) => values.map(v => ({
      key: `c:${col}:${v}`, label: `${col}: ${v}`,
      clear: () => ctx.toggleCategoryFilter(col, v),
    }))),
    ...Object.entries(numericSlicers as Record<string, { currentMax?: number; max?: number }>)
      .filter(([, s]) => s.currentMax !== undefined && s.max !== undefined && s.currentMax < s.max)
      .map(([col, s]) => ({
        key: `n:${col}`, label: `${col} ≤ ${Number(s.currentMax).toLocaleString(undefined, { maximumFractionDigits: 2 })}`,
        clear: () => { const copy = { ...numericSlicers } as Record<string, any>; delete copy[col]; setNumericSlicers(copy); },
      })),
  ];

  return (
    <div className="mb-6 space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        {datasetId && (
          <>
            <label htmlFor="saved-dashboards" className="sr-only">Saved dashboards</label>
            <select
              id="saved-dashboards"
              className="input w-auto max-w-[220px]"
              value={openId ?? ''}
              onChange={e => open(e.target.value)}
              disabled={saved.length === 0}
            >
              {saved.length === 0 && <option value="">No saved dashboards</option>}
              {openId === null && saved.length > 0 && <option value="" disabled>Choose a dashboard</option>}
              {saved.map(d => <option key={d.id} value={d.id}>{d.name}</option>)}
            </select>
            {openId && (
              <button type="button" onClick={() => save(false)} className="btn btn-sm btn-secondary">
                <Save className="w-4 h-4" /> Save
              </button>
            )}
            {naming ? (
              <form onSubmit={e => { e.preventDefault(); save(true); }} className="flex items-center gap-2">
                <input autoFocus data-agent="dash-name" className="input w-44" placeholder="Dashboard name" value={name} onChange={e => setName(e.target.value)} aria-label="Dashboard name" />
                <button type="submit" data-agent="dash-save-confirm" className="btn btn-sm btn-primary">Save</button>
                <button type="button" onClick={() => setNaming(false)} className="btn btn-sm btn-plain">Cancel</button>
              </form>
            ) : (
              <button type="button" data-agent="dash-save-new" onClick={() => setNaming(true)} className="btn btn-sm btn-secondary">
                {openId ? 'Save as New' : <><Save className="w-4 h-4" /> Save Dashboard</>}
              </button>
            )}
            {openId && (
              <button type="button" onClick={remove} className="btn btn-icon w-8 h-8 text-red hover:bg-red/10" aria-label="Delete this saved dashboard">
                <Trash2 className="w-4 h-4" />
              </button>
            )}
          </>
        )}
        <button type="button" data-agent="dash-add-kpi" onClick={() => setKpiOpen(o => !o)} className="btn btn-sm btn-secondary" aria-expanded={kpiOpen}>
          <Plus className="w-4 h-4" /> Add KPI
        </button>
        {message && <span role="status" data-agent="dash-message" className="text-sm text-green">{message}</span>}
      </div>

      {filterChips.length > 0 && (
        <div className="flex flex-wrap items-center gap-2" aria-label="Filters in effect">
          <span className="text-xs text-label-2">
            Showing {filteredData.length.toLocaleString()} of {dataset.rows.length.toLocaleString()} rows ·
          </span>
          {filterChips.map(c => (
            <span key={c.key} className="tag bg-blue/12 text-blue">
              {c.label}
              <button type="button" onClick={c.clear} className="-mr-1 rounded-full hover:bg-blue/20 p-0.5" aria-label={`Remove filter ${c.label}`}>
                <X className="w-3 h-3" />
              </button>
            </span>
          ))}
          <button type="button" onClick={() => { setCategoryFilters({}); setNumericSlicers({}); }} className="btn btn-plain btn-sm">Clear Filters</button>
        </div>
      )}
      {filterChips.length === 0 && (
        <p className="text-xs text-label-3">Tip: click a bar or a pie slice to filter every chart by it.</p>
      )}

      {kpiOpen && <KpiBuilder dataset={dataset} onAdd={k => { setKpis([...kpis, k]); setKpiOpen(false); }} onCancel={() => setKpiOpen(false)} />}

      {kpis.length > 0 && (
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
          {kpis.map(k => (
            <React.Fragment key={k.id}>
              <CustomKpiCard kpi={k} columns={dataset.columns.map(c => c.name)} onRemove={() => setKpis(kpis.filter(x => x.id !== k.id))} />
            </React.Fragment>
          ))}
        </div>
      )}
    </div>
  );
}

function CustomKpiCard({ kpi, columns, onRemove }: { kpi: KpiDefinition; columns: string[]; onRemove: () => void }) {
  const { filteredData } = useDashboardContext();
  const result = useMemo(() => {
    try {
      return { value: evaluateFormula(checkFormula(kpi.formula, columns), filteredData) };
    } catch (err) {
      return { error: (err as Error).message };
    }
  }, [kpi.formula, columns, filteredData]);
  return (
    <div className="card p-4 flex flex-col min-h-32 relative group">
      <button type="button" onClick={onRemove} className="absolute top-2 right-2 btn btn-icon w-7 h-7 opacity-60 hover:opacity-100" aria-label={`Remove KPI ${kpi.name}`}>
        <X className="w-3.5 h-3.5" />
      </button>
      <span className="text-xs text-label-2 truncate pr-6" title={kpi.name}>{kpi.name}</span>
      {'error' in result ? (
        <span className="mt-1 text-sm text-red">{result.error}</span>
      ) : (
        <span className="mt-1 text-[28px] leading-none font-semibold tracking-tight tabular-nums text-label">{formatKpi(result.value ?? null, kpi.format)}</span>
      )}
      <span className="mt-auto pt-3 text-[11px] text-label-3 font-code truncate" title={kpi.formula}>{kpi.formula}</span>
    </div>
  );
}

function KpiBuilder({ dataset, onAdd, onCancel }: { dataset: Dataset; onAdd: (k: KpiDefinition) => void; onCancel: () => void }) {
  const { filteredData } = useDashboardContext();
  const [name, setName] = useState('');
  const [formula, setFormula] = useState('');
  const [format, setFormat] = useState<KpiFormat>('number');
  const columns = dataset.columns.map(c => c.name);
  const preview = useMemo(() => {
    if (!formula.trim()) return null;
    try {
      return { value: evaluateFormula(checkFormula(formula, columns), filteredData) };
    } catch (err) {
      return { error: err instanceof FormulaError ? err.message : String(err) };
    }
  }, [formula, columns, filteredData]);
  const quote = (c: string) => (/^[A-Za-z_][A-Za-z0-9_.]*$/.test(c) ? c : `[${c}]`);
  const numericCols = dataset.columns.filter(c => c.type === 'numeric').slice(0, 4);

  return (
    <form
      className="card p-5 space-y-4"
      onSubmit={e => {
        e.preventDefault();
        if (!name.trim() || !preview || 'error' in preview) return;
        onAdd({ id: crypto.randomUUID(), name: name.trim(), formula: formula.trim(), format });
      }}
    >
      <div className="grid grid-cols-1 sm:grid-cols-[1fr_2fr_auto] gap-4">
        <div>
          <label className="field-label" htmlFor="kpi-name">Name</label>
          <input id="kpi-name" data-agent="kpi-name" className="input" value={name} onChange={e => setName(e.target.value)} placeholder="e.g. Revenue per customer" />
        </div>
        <div>
          <label className="field-label" htmlFor="kpi-formula">Formula</label>
          <input id="kpi-formula" data-agent="kpi-formula" className="input font-code" value={formula} onChange={e => setFormula(e.target.value)} placeholder="SUM(revenue) / COUNT()" spellCheck={false} />
        </div>
        <div>
          <label className="field-label" htmlFor="kpi-format">Show as</label>
          <select id="kpi-format" data-agent="kpi-format" className="input" value={format} onChange={e => setFormat(e.target.value as KpiFormat)}>
            <option value="number">Number</option>
            <option value="percent">Percent (0.25 → 25%)</option>
            <option value="currency">Money (2 decimals)</option>
          </select>
        </div>
      </div>
      <p className="text-xs text-label-2 leading-relaxed">
        Functions: {KPI_FUNCTIONS.join(', ')}. COUNT() counts rows. Combine them with + − × ÷ and brackets. Put column names with spaces in [square brackets].
        {numericCols.length > 0 && <> Try: {numericCols.slice(0, 2).map((c, i) => (
          <button key={c.name} type="button" className="font-code text-blue hover:underline mx-1" onClick={() => setFormula(i === 0 ? `AVG(${quote(c.name)})` : `SUM(${quote(c.name)}) / COUNT()`)}>
            {i === 0 ? `AVG(${quote(c.name)})` : `SUM(${quote(c.name)}) / COUNT()`}
          </button>
        ))}</>}
      </p>
      {preview && (
        'error' in preview
          ? <p role="alert" className="text-sm text-red">{preview.error}</p>
          : <p className="text-sm text-label">On the current view: <span className="font-semibold tabular-nums">{formatKpi(preview.value ?? null, format)}</span></p>
      )}
      <div className="flex gap-2">
        <button type="submit" data-agent="kpi-add" className="btn btn-primary" disabled={!name.trim() || !preview || 'error' in preview}>Add KPI</button>
        <button type="button" onClick={onCancel} className="btn btn-secondary">Cancel</button>
      </div>
    </form>
  );
}
