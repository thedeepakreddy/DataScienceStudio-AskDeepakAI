import React from 'react';
import { useDashboardContext } from './DashboardContext';
import { LineChart, Line, ResponsiveContainer, YAxis } from 'recharts';

interface KPICardProps {
  column: string;
}

export default function KPICard({ column }: KPICardProps) {
  const { filteredData } = useDashboardContext();

  if (!filteredData || filteredData.length === 0) return null;

  const values = filteredData.map(d => Number(d[column])).filter(v => !isNaN(v));
  if (values.length === 0) {
    return (
      <div className="card p-4 flex flex-col justify-center min-h-32">
        <span className="text-xs text-label-2 truncate" title={column}>{column}</span>
        <span className="mt-1 text-sm text-label-3">No numeric values</span>
      </div>
    );
  }

  const sum = values.reduce((a, b) => a + b, 0);
  const avg = sum / values.length;
  const max = Math.max(...values);
  const min = Math.min(...values);
  const format = (n: number) => n.toLocaleString(undefined, { maximumFractionDigits: 2 });

  // Sparkline of the most recent rows, for a sense of spread.
  const sparkData = values.slice(-20).map((v, i) => ({ value: v, index: i }));

  return (
    <div className="card p-4 flex flex-col min-h-32">
      <span className="text-xs text-label-2 truncate" title={column}>{column}</span>

      <div className="mt-1 flex flex-wrap items-baseline gap-x-1.5">
        <span className="text-[28px] leading-none font-semibold tracking-tight tabular-nums text-label">{format(avg)}</span>
        <span className="text-xs text-label-3">average</span>
      </div>

      <div className="mt-3 h-9 -mx-1" aria-hidden="true">
        <ResponsiveContainer width="100%" height="100%">
          <LineChart data={sparkData}>
            <YAxis domain={['dataMin', 'dataMax']} hide />
            <Line type="monotone" dataKey="value" stroke="var(--chart-1)" strokeWidth={1.5} dot={false} isAnimationActive={false} />
          </LineChart>
        </ResponsiveContainer>
      </div>

      <p className="mt-2 text-xs text-label-2 tabular-nums">
        Range {format(min)} – {format(max)}
      </p>
    </div>
  );
}
