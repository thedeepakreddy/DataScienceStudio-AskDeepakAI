import React, { useMemo } from 'react';
import { useDashboardContext } from './DashboardContext';
import { Filter, X } from 'lucide-react';
import { isIdentifierColumn } from '../utils/csvParser';

interface FiltersPanelProps {
  dataset: any;
}

export default function FiltersPanel({ dataset }: FiltersPanelProps) {
  const { categoryFilters, setCategoryFilters, setDateRanges, dateRanges } = useDashboardContext();

  const categoricalColumns = useMemo(() => {
    return dataset.columns
      .filter((c: any) => (c.type === 'categorical' || c.type === 'boolean') && !isIdentifierColumn(c, dataset.rowCount))
      .map((c: any) => c.name);
  }, [dataset]);

  const dateColumns = useMemo(() => {
    return dataset.columns.filter((c: any) => c.type === 'datetime').map((c: any) => c.name);
  }, [dataset]);

  const uniqueValues = useMemo(() => {
    const vals: Record<string, string[]> = {};
    categoricalColumns.forEach((col: string) => {
      const unique = Array.from(new Set(dataset.rows.map((r: any) => (r[col] === undefined || r[col] === null ? 'Unknown' : String(r[col])))));
      vals[col] = unique as string[];
    });
    return vals;
  }, [dataset, categoricalColumns]);

  const toggleCategory = (col: string, val: string) => {
    setCategoryFilters((prev: any) => {
      const active = prev[col] || [];
      const updated = active.includes(val) ? active.filter((v: string) => v !== val) : [...active, val];
      return { ...prev, [col]: updated };
    });
  };

  const resetAll = () => {
    setCategoryFilters({});
    setDateRanges({});
  };

  const hasFilters = Object.values(categoryFilters).some((f: any) => f.length > 0) || Object.keys(dateRanges).length > 0;

  return (
    <div className="bg-surface border border-separator rounded-xl p-4 shadow-sm mb-4">
      <div className="flex justify-between items-center mb-4">
        <h3 className="text-xs font-medium text-label flex items-center gap-1.5">
          <Filter className="w-3.5 h-3.5" /> Filters
        </h3>
        {hasFilters && (
          <button onClick={resetAll} className="text-[11px] bg-fill hover:bg-fill-strong text-label px-2 py-1 rounded flex items-center gap-1">
            <X className="w-3 h-3" /> Reset All
          </button>
        )}
      </div>

      <div className="space-y-4 max-h-[300px] overflow-y-auto custom-scrollbar pr-2">
        {categoricalColumns.slice(0, 5).map((col: string) => (
          <div key={col}>
            <div className="text-[11px] font-medium text-label-3 mb-1.5">{col}</div>
            <div className="flex flex-wrap gap-1">
              {uniqueValues[col]?.slice(0, 15).map(val => {
                const isActive = (categoryFilters[col] || []).includes(val);
                return (
                  <button
                    key={val}
                    onClick={() => toggleCategory(col, val)}
                    className={`text-[11px] px-2 py-1 rounded-full border transition-colors ${isActive ? 'bg-blue/20 border-blue/40 text-blue' : 'bg-well border-separator text-label-2 hover:border-separator-strong'}`}
                  >
                    {val.substring(0, 20)}
                  </button>
                );
              })}
            </div>
          </div>
        ))}
        {categoricalColumns.length === 0 && <div className="text-xs text-label-3 italic">No categorical columns available for filtering.</div>}
      </div>
    </div>
  );
}
