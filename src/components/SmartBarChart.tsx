import React, { useState } from 'react';
import { useDashboardContext } from './DashboardContext';
import { BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Cell } from 'recharts';
import { SlidersHorizontal } from 'lucide-react';

interface SmartBarChartProps {
  categoryColumn: string;
  valueColumn: string;
}

const COLORS = ['#3B82F6', '#10B981', '#6366F1', '#8B5CF6', '#EC4899', '#F43F5E', '#F59E0B'];

export default function SmartBarChart({ categoryColumn, valueColumn }: SmartBarChartProps) {
  const { filteredData } = useDashboardContext();
  const [layout, setLayout] = useState<'horizontal' | 'vertical'>('horizontal');
  // Average is the safer default: summing age, tenure, price or a rating is rarely meaningful.
  const [aggregation, setAggregation] = useState<'avg' | 'sum'>('avg');

  if (!filteredData || filteredData.length === 0) {
    return (
      <div className="bg-slate-900 border border-slate-800 rounded-xl p-4 shadow-lg min-h-[300px] flex flex-col items-center justify-center">
        <h3 className="text-xs font-bold text-slate-300 uppercase tracking-widest mb-4">{valueColumn} by {categoryColumn}</h3>
        <p className="text-slate-500 text-xs text-center">No data available.</p>
      </div>
    );
  }

  // Aggregate data by category
  const totals: Record<string, { sum: number; count: number }> = {};
  filteredData.forEach(row => {
    let cat = row[categoryColumn];
    if (cat === undefined || cat === null || cat === '') cat = 'Unknown';
    const val = Number(row[valueColumn]);
    if (isNaN(val)) return; // a missing value should not drag an average toward zero
    const entry = totals[cat] || (totals[cat] = { sum: 0, count: 0 });
    entry.sum += val;
    entry.count += 1;
  });

  const chartData = Object.entries(totals)
    .map(([name, { sum, count }]) => ({
      name,
      value: aggregation === 'avg' ? Math.round((sum / count) * 100) / 100 : Math.round(sum * 100) / 100,
    }))
    .sort((a, b) => b.value - a.value)
    .slice(0, 15); // limit to top 15

  const toggleLayout = () => {
    setLayout(prev => prev === 'horizontal' ? 'vertical' : 'horizontal');
  };

  return (
    <div className="bg-slate-900 border border-slate-800 rounded-xl p-4 shadow-lg min-h-[300px] flex flex-col relative">
      <div className="flex justify-between items-start mb-4">
        <h3 className="text-xs font-bold text-slate-300 uppercase tracking-widest overflow-hidden text-ellipsis whitespace-nowrap pr-2">
          {aggregation === 'avg' ? 'Average ' : 'Total '}{valueColumn} by {categoryColumn}
        </h3>
        <div className="flex items-center gap-1.5 shrink-0">
          <button
            onClick={() => setAggregation(prev => prev === 'avg' ? 'sum' : 'avg')}
            className="px-2 py-1 bg-slate-800 hover:bg-slate-700 rounded text-[10px] font-bold uppercase tracking-wider text-slate-400 transition-colors"
            title="Switch between average and total"
          >
            {aggregation === 'avg' ? 'Avg' : 'Sum'}
          </button>
          <button onClick={toggleLayout} className="p-1.5 bg-slate-800 hover:bg-slate-700 rounded text-slate-400 transition-colors" title="Toggle Layout">
            <SlidersHorizontal className="w-3.5 h-3.5" />
          </button>
        </div>
      </div>

      <div className="w-full h-[280px]">
        <ResponsiveContainer width="100%" height="100%">
          <BarChart data={chartData} layout={layout} margin={{ top: 10, right: 20, left: 0, bottom: 20 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="#1E293B" horizontal={layout === 'horizontal'} vertical={layout === 'vertical'} />
            
            {layout === 'horizontal' ? (
              <>
                <XAxis dataKey="name" type="category" stroke="#64748B" fontSize={10} angle={-45} textAnchor="end" height={60} />
                <YAxis type="number" stroke="#64748B" fontSize={10} width={40} />
              </>
            ) : (
              <>
                <XAxis type="number" stroke="#64748B" fontSize={10} />
                <YAxis dataKey="name" type="category" stroke="#64748B" fontSize={10} width={80} />
              </>
            )}

            <Tooltip
              cursor={{ fill: '#1E293B', opacity: 0.4 }}
              contentStyle={{ backgroundColor: '#0B0E17', borderColor: '#1E293B', color: '#fff', fontSize: '12px' }}
            />
            <Bar dataKey="value" radius={[4, 4, 4, 4]} label={{ position: layout === 'horizontal' ? 'top' : 'right', fill: '#94A3B8', fontSize: 10 }}>
              {chartData.map((entry, index) => (
                <Cell key={`cell-${index}`} fill={COLORS[index % COLORS.length]} />
              ))}
            </Bar>
          </BarChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}
