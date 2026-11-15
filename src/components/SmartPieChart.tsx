import { CHART_COLORS } from '../utils/chartTheme';
import React, { useState } from 'react';
import { useDashboardContext } from './DashboardContext';
import { PieChart, Pie, Cell, Tooltip, Legend, ResponsiveContainer } from 'recharts';
import { Target } from 'lucide-react';

interface SmartPieChartProps {
  categoryColumn: string;
}

const COLORS = CHART_COLORS;

export default function SmartPieChart({ categoryColumn }: SmartPieChartProps) {
  const { filteredData } = useDashboardContext();
  const [isDonut, setIsDonut] = useState(true);

  if (!filteredData || filteredData.length === 0) {
    return (
      <div className="card p-4 sm:p-5 min-h-[300px] flex flex-col items-center justify-center">
        <h3 className="text-sm font-semibold tracking-tight text-label mb-4">{categoryColumn}</h3>
        <p className="text-label-3 text-xs text-center">No data available.</p>
      </div>
    );
  }

  const aggregated: Record<string, number> = {};
  filteredData.forEach(row => {
    let cat = row[categoryColumn];
    if (cat === undefined || cat === null || cat === '') cat = 'Unknown';
    aggregated[cat] = (aggregated[cat] || 0) + 1;
  });

  const chartData = Object.entries(aggregated)
    .map(([name, value]) => ({ name, value }))
    .sort((a, b) => b.value - a.value)
    .slice(0, 8); // Max 8 slices for readability

  const toggleDonut = () => setIsDonut(!isDonut);

  return (
    <div className="card p-4 sm:p-5 min-h-[300px] flex flex-col relative">
       <div className="flex justify-between items-start mb-2">
        <h3 className="text-sm font-semibold tracking-tight text-label overflow-hidden text-ellipsis whitespace-nowrap pr-2">
          Share by {categoryColumn}
        </h3>
        <button onClick={toggleDonut} className="p-1.5 bg-fill hover:bg-fill-strong rounded text-label-2 transition-colors" title="Toggle Donut">
          <Target className="w-3.5 h-3.5" />
        </button>
      </div>

      <div className="w-full h-[280px]">
        <ResponsiveContainer width="100%" height="100%">
          <PieChart>
            <Pie
              data={chartData}
              cx="50%"
              cy="45%"
              innerRadius={isDonut ? "50%" : 0}
              outerRadius="80%"
              paddingAngle={isDonut ? 3 : 0}
              dataKey="value"
              stroke="none"
              label={({ name, percent }) => `${(percent * 100).toFixed(0)}%`}
              labelLine={false}
            >
              {chartData.map((entry, index) => (
                <Cell key={`cell-${index}`} fill={COLORS[index % COLORS.length]} />
              ))}
            </Pie>
            <Tooltip
            />
            <Legend wrapperStyle={{ fontSize: '11px', paddingTop: '10px' }} />
          </PieChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}
