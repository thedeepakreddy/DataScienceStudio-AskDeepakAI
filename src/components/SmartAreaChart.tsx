import { CHART_COLORS } from '../utils/chartTheme';
import React from 'react';
import { useDashboardContext } from './DashboardContext';
import { AreaChart, Area, XAxis, YAxis, CartesianGrid, Tooltip, Legend, ResponsiveContainer } from 'recharts';

interface SmartAreaChartProps {
  xAxisColumn: string;
  yAxisColumns: string[];
}

const COLORS = CHART_COLORS;

export default function SmartAreaChart({ xAxisColumn, yAxisColumns }: SmartAreaChartProps) {
  const { filteredData } = useDashboardContext();

  if (!filteredData || filteredData.length === 0) {
    return (
      <div className="card p-4 sm:p-4 min-h-[300px] flex flex-col items-center justify-center">
        <h3 className="text-sm font-semibold tracking-tight text-label mb-4">{yAxisColumns.join(' & ')} Area</h3>
        <p className="text-label-3 text-xs text-center">No data available.</p>
      </div>
    );
  }

  const chartData = filteredData.map(row => {
    const dataPoint: any = { x: row[xAxisColumn] };
    yAxisColumns.forEach(col => {
      dataPoint[col] = Number(row[col]);
    });
    return dataPoint;
  });

  return (
    <div className="card p-4 sm:p-4 min-h-[300px] flex flex-col">
       <h3 className="text-sm font-semibold tracking-tight text-label mb-4">
        {yAxisColumns.join(' & ')} Area
      </h3>
      <div className="w-full h-[280px]">
        <ResponsiveContainer width="100%" height="100%">
          <AreaChart data={chartData} margin={{ top: 10, right: 10, left: 0, bottom: 0 }}>
            <defs>
              {yAxisColumns.map((col, idx) => (
                <linearGradient key={`color-${col}`} id={`color-${col}`} x1="0" y1="0" x2="0" y2="1">
                  <stop offset="5%" stopColor={COLORS[idx % COLORS.length]} stopOpacity={0.8}/>
                  <stop offset="95%" stopColor={COLORS[idx % COLORS.length]} stopOpacity={0}/>
                </linearGradient>
              ))}
            </defs>
            <CartesianGrid strokeDasharray="3 3" stroke="var(--chart-grid)" vertical={false} />
            <XAxis dataKey="x" stroke="var(--chart-axis)" fontSize={10} minTickGap={30} />
            <YAxis stroke="var(--chart-axis)" fontSize={10} width={40} />
            <Tooltip
            />
            <Legend wrapperStyle={{ fontSize: '11px', paddingTop: '10px' }} />
            {yAxisColumns.map((col, idx) => (
              <Area
                key={col}
                type="monotone"
                dataKey={col}
                stroke={COLORS[idx % COLORS.length]}
                fillOpacity={1}
                fill={`url(#color-${col})`}
              />
            ))}
          </AreaChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}
