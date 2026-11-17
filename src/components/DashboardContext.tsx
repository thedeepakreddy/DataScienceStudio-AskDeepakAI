import React, { createContext, useContext, useState, ReactNode } from 'react';
import type { KpiDefinition } from '../utils/kpiFormula';

interface DashboardContextType {
  filteredData: any[];
  setFilteredData: (data: any[]) => void;
  insightBannerData: string[] | null;
  setInsightBannerData: (data: string[] | null) => void;
  layout: '2-col' | '3-col' | 'full';
  setLayout: (layout: '2-col' | '3-col' | 'full') => void;
  // For Filters Panel
  dateRanges: Record<string, { start: string; end: string }>;
  setDateRanges: (ranges: Record<string, { start: string; end: string }>) => void;
  categoryFilters: Record<string, string[]>;
  setCategoryFilters: (filters: Record<string, string[]>) => void;
  // For Slicers Panel
  numericSlicers: Record<string, { min: number; max: number }>;
  setNumericSlicers: (slicers: Record<string, { min: number; max: number }>) => void;
  // Dashboard Config state
  config: any;
  setConfig: (config: any) => void;
  activeComponents: any[];
  setActiveComponents: (comps: any[]) => void;
  /** Custom KPIs defined with formulas. */
  kpis: KpiDefinition[];
  setKpis: (kpis: KpiDefinition[]) => void;
  /** Click-to-filter from a chart: adds or removes one value of a column. */
  toggleCategoryFilter: (column: string, value: string) => void;
}

const DashboardContext = createContext<DashboardContextType | undefined>(undefined);

export const DashboardProvider = ({ children, initialData }: { children: ReactNode; initialData: any[] }) => {
  const [filteredData, setFilteredData] = useState<any[]>(initialData);
  const [insightBannerData, setInsightBannerData] = useState<string[] | null>(null);
  const [layout, setLayout] = useState<'2-col' | '3-col' | 'full'>('2-col');
  const [dateRanges, setDateRanges] = useState<Record<string, { start: string; end: string }>>({});
  const [categoryFilters, setCategoryFilters] = useState<Record<string, string[]>>({});
  const [numericSlicers, setNumericSlicers] = useState<Record<string, { min: number; max: number }>>({});
  const [config, setConfig] = useState<any>(null);
  const [activeComponents, setActiveComponents] = useState<any[]>([]);
  const [kpis, setKpis] = useState<KpiDefinition[]>([]);
  const toggleCategoryFilter = (column: string, value: string) => {
    setCategoryFilters(prev => {
      const current = prev[column] ?? [];
      const next = current.includes(value) ? current.filter(v => v !== value) : [...current, value];
      const copy = { ...prev };
      if (next.length) copy[column] = next; else delete copy[column];
      return copy;
    });
  };

  // We compute filtered data based on states here, but let's just make it available
  // The actual filtering logic will be handled by a useMemo or effect when filters change.
  
  return (
    <DashboardContext.Provider
      value={{
        filteredData, setFilteredData,
        insightBannerData, setInsightBannerData,
        layout, setLayout,
        dateRanges, setDateRanges,
        categoryFilters, setCategoryFilters,
        numericSlicers, setNumericSlicers,
        config, setConfig,
        activeComponents, setActiveComponents,
        kpis, setKpis,
        toggleCategoryFilter,
      }}
    >
      {children}
    </DashboardContext.Provider>
  );
};

export const useDashboardContext = () => {
  const context = useContext(DashboardContext);
  if (context === undefined) {
    throw new Error('useDashboardContext must be used within a DashboardProvider');
  }
  return context;
};
