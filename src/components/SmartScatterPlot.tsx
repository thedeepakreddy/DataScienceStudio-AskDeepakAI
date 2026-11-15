import { CHART_COLORS } from '../utils/chartTheme';
import React from 'react';
import { useDashboardContext } from './DashboardContext';
import { ScatterChart, Scatter, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Cell } from 'recharts';

interface SmartScatterPlotProps {
  xColumn: string;
  yColumn: string;
  colorColumn?: string;
}

const COLORS = CHART_COLORS;

export default function SmartScatterPlot({ xColumn, yColumn, colorColumn }: SmartScatterPlotProps) {
  const { filteredData } = useDashboardContext();

  if (!filteredData || filteredData.length === 0) {
    return (
      <div className="card p-4 sm:p-5 min-h-[300px] flex flex-col items-center justify-center">
        <h3 className="text-sm font-semibold tracking-tight text-label mb-4">{yColumn} vs {xColumn}</h3>
        <p className="text-label-3 text-xs text-center">No data available.</p>
      </div>
    );
  }

  let categories: string[] = [];
  if (colorColumn) {
    const rawCats = filteredData.map(r => r[colorColumn]).filter(Boolean);
    categories = Array.from(new Set(rawCats));
  }

  const chartData = filteredData
    .map(row => ({
      x: Number(row[xColumn]),
      y: Number(row[yColumn]),
      colorVal: colorColumn ? row[colorColumn] : null,
      __raw: row
    }))
    .filter(d => !isNaN(d.x) && !isNaN(d.y))
    .slice(0, 500); // Max 500 points to prevent lag

  const CustomTooltip = ({ active, payload }: any) => {
    if (active && payload && payload.length) {
      const data = payload[0].payload;
      return (
        <div className="bg-well border border-separator p-3 rounded-lg shadow-sm text-xs max-w-xs">
          <p className="font-semibold text-label mb-1 border-b border-separator pb-1">Point Details</p>
          <div className="space-y-1 mt-2">
            <p><span className="text-label-3 tabular-nums">{xColumn}:</span> <span className="text-blue">{data.x}</span></p>
            <p><span className="text-label-3 tabular-nums">{yColumn}:</span> <span className="text-green">{data.y}</span></p>
            {colorColumn && <p><span className="text-label-3 tabular-nums">{colorColumn}:</span> <span className="text-blue">{data.colorVal}</span></p>}
          </div>
        </div>
      );
    }
    return null;
  };

  return (
    <div className="card p-4 sm:p-5 min-h-[300px] flex flex-col">
       <h3 className="text-sm font-semibold tracking-tight text-label mb-4">
        {yColumn} vs {xColumn}
      </h3>
      <div className="w-full h-[280px]">
        <ResponsiveContainer width="100%" height="100%">
          <ScatterChart margin={{ top: 10, right: 10, left: 10, bottom: 10 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="var(--chart-grid)" />
            <XAxis type="number" dataKey="x" name={xColumn} stroke="var(--chart-axis)" fontSize={10} tickFormatter={(v) => v.toLocaleString()} />
            <YAxis type="number" dataKey="y" name={yColumn} stroke="var(--chart-axis)" fontSize={10} width={50} tickFormatter={(v) => v.toLocaleString()} />
            <Tooltip content={<CustomTooltip />} cursor={{ strokeDasharray: '3 3' }} />
            
            <Scatter data={chartData} fill="var(--chart-1)" shape="circle" style={{opacity: 0.7}}>
              {chartData.map((entry, index) => {
                let fill = 'var(--chart-1)';
                if (colorColumn && categories.length > 0) {
                  const colorIdx = categories.indexOf(entry.colorVal);
                  if (colorIdx !== -1) {
                    fill = COLORS[colorIdx % COLORS.length];
                  }
                }
                return <Cell key={`cell-${index}`} fill={fill} />;
              })}
            </Scatter>
          </ScatterChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}
