import { CHART_COLORS } from '../utils/chartTheme';
import React from 'react';
import { useDashboardContext } from './DashboardContext';
import { LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, Legend, ResponsiveContainer } from 'recharts';

interface SmartLineChartProps {
  xAxisColumn: string;
  yAxisColumns: string[];
}

const COLORS = CHART_COLORS;

export default function SmartLineChart({ xAxisColumn, yAxisColumns }: SmartLineChartProps) {
  const { filteredData } = useDashboardContext();

  if (!filteredData || filteredData.length === 0) {
    return (
      <div className="card p-4 sm:p-4 min-h-[300px] flex flex-col items-center justify-center">
        <h3 className="text-sm font-semibold tracking-tight text-label mb-4">{yAxisColumns.join(' & ')} over {xAxisColumn}</h3>
        <p className="text-label-3 text-xs text-center">No data available.</p>
      </div>
    );
  }

  // Process data for recharts
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
        {yAxisColumns.join(' & ')} over {xAxisColumn}
      </h3>
      <div className="w-full h-[280px]">
        <ResponsiveContainer width="100%" height="100%">
          <LineChart data={chartData} margin={{ top: 10, right: 10, left: 0, bottom: 0 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="var(--chart-grid)" vertical={false} />
            <XAxis dataKey="x" stroke="var(--chart-axis)" fontSize={10} minTickGap={30} />
            <YAxis stroke="var(--chart-axis)" fontSize={10} width={40} />
            <Tooltip
            />
            <Legend wrapperStyle={{ fontSize: '11px', paddingTop: '10px' }} />
            {yAxisColumns.map((col, idx) => (
              <Line
                key={col}
                type="monotone"
                dataKey={col}
                stroke={COLORS[idx % COLORS.length]}
                strokeWidth={2}
                dot={false}
                activeDot={{ r: 4 }}
              />
            ))}
          </LineChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}
