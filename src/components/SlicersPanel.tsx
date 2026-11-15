import React, { useMemo } from 'react';
import { useDashboardContext } from './DashboardContext';
import { Sliders } from 'lucide-react';

interface SlicersPanelProps {
  dataset: any;
}

export default function SlicersPanel({ dataset }: SlicersPanelProps) {
  const { numericSlicers, setNumericSlicers } = useDashboardContext();

  const numericColumns = useMemo(() => {
    return dataset.columns.filter((c: any) => c.type === 'numeric');
  }, [dataset]);

  const initSlicer = (col: any) => {
    if (!numericSlicers[col.name]) {
      const min = col.statistics?.min ?? 0;
      const max = col.statistics?.max ?? 100;
      setNumericSlicers((prev: any) => ({
        ...prev,
        [col.name]: { currentMin: min, currentMax: max, min, max }
      }));
    }
  };

  const handleSlider = (colName: string, val: number) => {
    setNumericSlicers((prev: any) => ({
      ...prev,
      [colName]: { ...prev[colName], currentMax: val }
    }));
  };

  return (
    <div className="bg-surface border border-separator rounded-xl p-4 shadow-sm mb-4">
      <div className="flex items-center gap-1.5 mb-4">
        <Sliders className="w-3.5 h-3.5 text-label" />
        <h3 className="text-xs font-medium text-label">Range filters</h3>
      </div>

      <div className="space-y-5">
        {numericColumns.slice(0, 5).map((col: any) => {
          const slicer = numericSlicers[col.name] || { currentMax: col.statistics?.max ?? 100, min: col.statistics?.min ?? 0, max: col.statistics?.max ?? 100 };
          return (
            <div key={col.name} onMouseEnter={() => initSlicer(col)}>
               <div className="flex justify-between items-center mb-2">
                 <span className="text-[11px] font-medium text-label-3">{col.name}</span>
                 <span className="text-[11px] tabular-nums text-blue">≤ {Number(slicer.currentMax).toFixed(1)}</span>
               </div>
               <input
                 type="range"
                 min={slicer.min}
                 max={slicer.max}
                 step={(slicer.max - slicer.min) / 100}
                 value={slicer.currentMax}
                 onChange={(e) => handleSlider(col.name, Number(e.target.value))}
                 className="w-full h-1.5 rounded-lg appearance-none cursor-pointer bg-fill accent-blue"
               />
               <div className="flex justify-between text-[11px] tabular-nums text-label-3 mt-1">
                 <span>{Number(slicer.min).toFixed(1)}</span>
                 <span>{Number(slicer.max).toFixed(1)}</span>
               </div>
            </div>
          );
        })}
        {numericColumns.length === 0 && <div className="text-xs text-label-3 italic">No numeric columns available.</div>}
      </div>
    </div>
  );
}
