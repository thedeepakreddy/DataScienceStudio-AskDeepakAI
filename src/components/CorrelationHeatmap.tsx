import React, { useMemo, useState } from 'react';
import { useDashboardContext } from './DashboardContext';

interface CorrelationHeatmapProps {
  columns: string[];
}

export default function CorrelationHeatmap({ columns }: CorrelationHeatmapProps) {
  const { filteredData } = useDashboardContext();
  const [hoveredCell, setHoveredCell] = useState<{ x: string; y: string; val: number } | null>(null);

  const matrix = useMemo(() => {
    if (!filteredData || filteredData.length === 0 || columns.length < 2) return [];

    const calculatePearson = (xVals: number[], yVals: number[]) => {
      const n = xVals.length;
      if (n === 0) return 0;
      const sumX = xVals.reduce((a, b) => a + b, 0);
      const sumY = yVals.reduce((a, b) => a + b, 0);
      const sumXY = xVals.reduce((a, b, i) => a + (b * yVals[i]), 0);
      const sumX2 = xVals.reduce((a, b) => a + b * b, 0);
      const sumY2 = yVals.reduce((a, b) => a + b * b, 0);
      
      const num = (n * sumXY) - (sumX * sumY);
      const den = Math.sqrt(((n * sumX2) - (sumX * sumX)) * ((n * sumY2) - (sumY * sumY)));
      if (den === 0) return 0;
      return num / den;
    };

    const extractedNumData = columns.map(col => filteredData.map(d => Number(d[col])).filter(n => !isNaN(n)));

    const result = [];
    for (let i = 0; i < columns.length; i++) {
      const row = [];
      for (let j = 0; j < columns.length; j++) {
        if (i === j) {
          row.push({ x: columns[j], y: columns[i], val: 1 });
        } else {
          // Assume aligned vectors (if NA omitted properly, careful! We assume rect data)
          const xVec = [];
          const yVec = [];
          for (let k = 0; k < filteredData.length; k++) {
            const vx = Number(filteredData[k][columns[j]]);
            const vy = Number(filteredData[k][columns[i]]);
            if (!isNaN(vx) && !isNaN(vy)) {
              xVec.push(vx);
              yVec.push(vy);
            }
          }
          row.push({ x: columns[j], y: columns[i], val: calculatePearson(xVec, yVec) });
        }
      }
      result.push({ rowCol: columns[i], cells: row });
    }
    return result;
  }, [filteredData, columns]);

  if (matrix.length === 0) {
    return (
      <div className="card p-4 sm:p-5 min-h-[300px] flex flex-col items-center justify-center">
        <h3 className="text-sm font-semibold tracking-tight text-label mb-4">Correlation</h3>
        <p className="text-label-3 text-xs text-center">Not enough numeric data to show correlations.</p>
      </div>
    );
  }

  // Diverging scale: blue for positive, red for negative, strength as opacity.
  const getColor = (val: number) => {
    const strength = Math.round(Math.min(1, Math.abs(val)) * 85);
    if (val === 0) return 'transparent';
    return `color-mix(in srgb, var(${val > 0 ? '--chart-1' : '--chart-5'}) ${strength}%, transparent)`;
  };

  return (
    <div className="card p-4 sm:p-5 flex flex-col relative overflow-hidden min-h-[300px]">
       <h3 className="text-sm font-semibold tracking-tight text-label mb-4">Correlation</h3>
       
       <div className="flex-1 overflow-auto custom-scrollbar relative">
         <div className="inline-block min-w-full">
            <div className="flex">
               <div className="w-24 shrink-0"></div>
               {columns.map(c => (
                 <div key={`header-${c}`} className="w-20 text-center shrink-0 border-b border-separator pb-2">
                   <span className="text-[11px] font-semibold text-label-2 rotate-[-45deg] inline-block w-full">{c.substring(0, 8)}</span>
                 </div>
               ))}
            </div>

            {matrix.map((rowItem, rIdx) => (
              <div key={`row-${rIdx}`} className="flex items-center">
                <div className="w-24 shrink-0 pr-2 text-right border-r border-separator">
                  <span className="text-[11px] font-semibold text-label-2 truncate block">{rowItem.rowCol.substring(0, 10)}</span>
                </div>
                {rowItem.cells.map((cell, cIdx) => (
                  <div
                    key={`cell-${rIdx}-${cIdx}`}
                    className="w-20 h-10 shrink-0 border border-surface rounded-md flex items-center justify-center"
                    style={{ backgroundColor: getColor(cell.val) }}
                    onMouseEnter={() => setHoveredCell(cell)}
                    onMouseLeave={() => setHoveredCell(null)}
                  >
                    <span className={`text-[11px] tabular-nums font-medium ${Math.abs(cell.val) > 0.55 ? 'text-white' : 'text-label'}`}>
                      {cell.val.toFixed(2)}
                    </span>
                  </div>
                ))}
              </div>
            ))}
         </div>
       </div>

       {hoveredCell && (
         <div className="absolute top-4 right-4 bg-raised p-2.5 rounded-lg text-xs shadow-md min-w-[120px] pointer-events-none">
           <div className="text-label-2">{hoveredCell.x} × {hoveredCell.y}</div>
           <div className="tabular-nums text-label mt-1 pt-1 border-t border-separator font-semibold">{hoveredCell.val.toFixed(3)}</div>
         </div>
       )}
    </div>
  );
}
