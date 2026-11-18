import React, { useEffect, useState, useMemo } from 'react';
import { useDashboardContext } from './DashboardContext';
import { usePipelineContext } from '../contexts/PipelineContext';
import { Sparkles, LayoutGrid, Server, PanelRightClose, PanelRightOpen, RefreshCw, Copy, Check } from 'lucide-react';
import KPICard from './KPICard';
import SmartLineChart from './SmartLineChart';
import SmartBarChart from './SmartBarChart';
import SmartPieChart from './SmartPieChart';
import SmartScatterPlot from './SmartScatterPlot';
import SmartHistogram from './SmartHistogram';
import CorrelationHeatmap from './CorrelationHeatmap';
import SmartBoxPlot from './SmartBoxPlot';
import SmartAreaChart from './SmartAreaChart';
import SmartDataTable from './SmartDataTable';
import FiltersPanel from './FiltersPanel';
import SlicersPanel from './SlicersPanel';
import { isIdentifierColumn } from '../utils/csvParser';
import { apiFetch } from '../utils/api';
import Orb from './Orb';
import DashboardToolbar from './DashboardToolbar';
import DashGrid, { type GridItem } from './dashboard/DashGrid';
import { designDashboard } from '../swarm/dashboardDesign';

const fmt = (n: number) => n.toLocaleString(undefined, { maximumFractionDigits: 2 });

// A dashboard may hold several charts of one type ("Bar Chart", "Bar Chart#2"…).
const baseType = (id: string) => id.split('#')[0];
const slug = (id: string) => id.toLowerCase().replace(/[^a-z0-9]+/g, '-');

/** Ids for designed components: the first of a type keeps the type name, later ones get #2, #3… */
function withIds(components: any[]): any[] {
  const seen = new Map<string, number>();
  return components.map(c => {
    const n = (seen.get(c.type) ?? 0) + 1;
    seen.set(c.type, n);
    return { ...c, id: n === 1 ? c.type : `${c.type}#${n}` };
  });
}

export const DASHBOARD_APPLY_EVENT = 'studio:dashboard-apply';
export const DASHBOARD_APPLIED_EVENT = 'studio:dashboard-applied';

/** Plain-language observations computed from the rows currently on screen - used when no AI narrative is available. */
function buildLocalInsights(rows: any[], metrics: { name: string; average: number; count: number }[]): string[] {
  const insights = [`${rows.length.toLocaleString()} records are in the current view.`];
  for (const m of metrics.filter(m => m.count > 0).slice(0, 2)) {
    let min = Infinity, max = -Infinity;
    for (const r of rows) {
      const v = Number(r[m.name]);
      if (!isNaN(v)) { if (v < min) min = v; if (v > max) max = v; }
    }
    insights.push(`${m.name} averages ${fmt(m.average)}, ranging from ${fmt(min)} to ${fmt(max)}.`);
  }
  return insights;
}

const COMPONENT_LIST = [
  'KPI Cards', 'Line Chart', 'Bar Chart', 'Pie Chart', 'Scatter Plot', 
  'Histogram', 'Heatmap Correlation Matrix', 'Geographic Map', 'Treemap', 
  'Funnel Chart', 'Box Plot', 'Area Chart', 'Data Table', 'Filters Panel', 'Slicers Panel'
];

const PROBLEM_TYPES = [
  'Customer Churn Analysis', 'Sales Performance', 'Delivery and Logistics', 
  'Financial Risk', 'Marketing Campaign Analysis', 'HR and Workforce Analytics', 
  'Customer Segmentation', 'Demand Forecasting'
];

export default function IntelligentDashboardLayer({ dataset, mlResult, datasetId = null }: any) {
  const { expertMode } = usePipelineContext();
  const { 
    filteredData, setFilteredData, 
    insightBannerData, setInsightBannerData,
    layout, setLayout,
    categoryFilters, numericSlicers,
    config, setConfig,
    activeComponents, setActiveComponents 
  } = useDashboardContext();

  const [loadingConfig, setLoadingConfig] = useState(false);
  const [configError, setConfigError] = useState<string | null>(null);
  const [loadingInsights, setLoadingInsights] = useState(false);
  const [copiedInsights, setCopiedInsights] = useState(false);
  const [insightsAreAi, setInsightsAreAi] = useState(true);
  // How many rows the insights were written for, so stale AI text is flagged.
  const [insightsRowCount, setInsightsRowCount] = useState<number | null>(null);
  const [customProblem, setCustomProblem] = useState('');
  const [sidebarOpen, setSidebarOpen] = useState(true);

  // Derive dataset profile 
  const datasetProfile = useMemo(() => {
    return {
      rowCount: dataset.rows.length,
      columnCount: dataset.columns.length,
      columns: dataset.columns.map((c: any) => ({
        name: c.name,
        type: c.type,
        min: c.statistics?.min,
        max: c.statistics?.max,
        uniqueValues: c.statistics?.uniqueCount
      })),
      mlTarget: mlResult ? mlResult.target ?? null : null
    };
  }, [dataset, mlResult]);

  // The dashboard is designed by the studio's chart rules from your columns (the
  // same designer the agents use): instant, and the same every time. No AI call.
  const runAutoConfig = (problemOverride?: string) => {
    setConfigError(null);
    try {
      const design = designDashboard(dataset, { focus: problemOverride || customProblem || undefined }, mlResult ?? null);
      const comps = withIds(design.recommendedComponents);
      setConfig({ ...design, recommendedComponents: comps, designedBy: 'rules' });
      setActiveComponents(comps.map((c: any) => c.id));
      if (design.layout) setLayout(design.layout as any);
    } catch (e: any) {
      console.error('Failed to design the dashboard', e);
      setConfigError(e?.message || 'The dashboard couldn’t be designed from this data.');
    }
  };

  // Agents design dashboards too (docs/AGENTS_PLAN.md §6): a design arrives as an
  // event, is applied like any configuration, and the dashboard replies with
  // the charts that actually rendered — that reply is the agent's check.
  const { setCategoryFilters } = useDashboardContext();
  const initialLoadDone = React.useRef(false);
  // When the agents last applied a design; a slower AI suggestion must not overwrite it.
  const agentDesignedAt = React.useRef(0);
  const pendingAgentDesign = React.useRef<any>(null);

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const applyAgentDesign = React.useRef((_detail: any) => {});
  // Kept current after each render (it reads the latest filters).
  React.useLayoutEffect(() => { applyAgentDesign.current = (detail: any) => {
    const { design, filters } = detail ?? {};
    if (design?.recommendedComponents) {
      const comps = withIds(design.recommendedComponents);
      agentDesignedAt.current = Date.now();
      setConfig({ ...design, recommendedComponents: comps });
      setActiveComponents(comps.map((c: any) => c.id));
      if (design.layout) setLayout(design.layout);
    }
    if (filters) setCategoryFilters({ ...categoryFilters, ...filters });
    // Reply once the new charts are on screen.
    let tries = 0;
    const want = design?.recommendedComponents ? withIds(design.recommendedComponents).filter((c: any) => c.type !== 'Filters Panel').map((c: any) => slug(c.id)) : [];
    const reply = () => {
      const rendered = [...document.querySelectorAll<HTMLElement>('[data-agent^="dash-chart-"]')].map(el => el.dataset.agent!.slice('dash-chart-'.length));
      if (want.every((w: string) => rendered.includes(w)) || ++tries > 60) {
        window.dispatchEvent(new CustomEvent(DASHBOARD_APPLIED_EVENT, { detail: { rendered, expected: want } }));
      } else requestAnimationFrame(reply);
    };
    requestAnimationFrame(reply);
  }; });

  // Agents design dashboards too (docs/AGENTS_PLAN.md §6): a design arrives as an
  // event and is applied like any configuration (after the dashboard's own first
  // load, so a reopened saved dashboard doesn't replace it). The dashboard replies
  // with the charts that actually rendered — that reply is the agent's check.
  useEffect(() => {
    const onApply = (e: Event) => {
      const detail = (e as CustomEvent).detail;
      if (!initialLoadDone.current && detail?.design) { pendingAgentDesign.current = detail; return; }
      applyAgentDesign.current(detail);
    };
    window.addEventListener(DASHBOARD_APPLY_EVENT, onApply);
    return () => window.removeEventListener(DASHBOARD_APPLY_EVENT, onApply);
  }, []);

  // A saved dashboard for this dataset is reopened; otherwise AI suggests one.
  const handleInitialLoad = (openedSaved: boolean) => {
    if (initialLoadDone.current) return;
    initialLoadDone.current = true;
    if (pendingAgentDesign.current) {
      const d = pendingAgentDesign.current;
      pendingAgentDesign.current = null;
      applyAgentDesign.current(d);
      return;
    }
    if (!openedSaved && !config) runAutoConfig();
  };

  // Update filtered data based on filters & slicers
  useEffect(() => {
    let _data = [...dataset.rows];
    
    // Categorical 
    for (const [col, activeVals] of Object.entries(categoryFilters as Record<string, string[]>)) {
      if (activeVals.length > 0) {
        _data = _data.filter((r: any) => {
          const val = r[col] === undefined || r[col] === null ? 'Unknown' : String(r[col]);
          return activeVals.includes(val);
        });
      }
    }

    // Numeric slicers (simulating logic)
    for (const [col, slicer] of Object.entries(numericSlicers as Record<string, any>)) {
      _data = _data.filter((r: any) => {
        const val = Number(r[col]);
        if (isNaN(val)) return true; // skip non-numbers
        return val <= slicer.currentMax;
      });
    }

    setFilteredData(_data);
  }, [dataset, categoryFilters, numericSlicers]);

  const getColsForComp = (id: string) => {
    const type = baseType(id);
    const aiRec = config?.recommendedComponents?.find((c: any) => (c.id ?? c.type) === id) ?? config?.recommendedComponents?.find((c: any) => c.type === type && !c.id);
    if (aiRec && aiRec.columnsToUse && aiRec.columnsToUse.length > 0) return aiRec.columnsToUse;

    // Identifier columns (CustomerID, ...) make meaningless axes, so defaults skip them.
    const usable = dataset.columns.filter((c:any) => !isIdentifierColumn(c, dataset.rowCount));
    const pool = usable.length > 0 ? usable : dataset.columns;
    const nums = pool.filter((c:any) => c.type === 'numeric').map((c:any) => c.name);
    // Readable breakdowns first: categories with a handful of distinct values beat 40-bar charts.
    const catCols = pool.filter((c:any) => c.type === 'categorical' || c.type === 'boolean');
    const cats = [...catCols.filter((c:any) => c.distinctCount >= 2 && c.distinctCount <= 12), ...catCols.filter((c:any) => c.distinctCount < 2 || c.distinctCount > 12)].map((c:any) => c.name);
    const all = pool.map((c:any) => c.name);
    const timeAxis = pool.find((c:any) => c.type === 'datetime')?.name || all[0] || 'Unknown';

    const safeN = (i: number) => nums[i] || all[i] || 'Unknown';
    const safeC = (i: number) => cats[i] || all[i] || 'Unknown';
    
    switch(type) {
      case 'Line Chart': return [timeAxis, safeN(0)];
      case 'Bar Chart': return [safeC(0), safeN(0)];
      case 'Pie Chart': return [safeC(0)];
      case 'Scatter Plot': return [safeN(0), safeN(1) || safeN(0), safeC(0)];
      case 'Histogram': return [safeN(0)];
      case 'Box Plot': return [safeN(0), safeC(0)];
      case 'Area Chart': return [timeAxis, safeN(0)];
      default: return [];
    }
  };

  const renderComponentWrapper = (id: string, key: any) => {
    const cols = getColsForComp(id);
    const type = baseType(id);

    switch (type) {
      case 'KPI Cards': {
        const kpiCols = config?.topKPIs && config.topKPIs.length > 0 ? config.topKPIs : dataset.columns.filter((c:any)=>c.type==='numeric').map((c:any)=>c.name);
        return (
          <div key={key} className="grid grid-cols-2 lg:grid-cols-4 gap-5 sm:gap-7 w-full mb-7">
            {kpiCols.slice(0, 4).map((col: string) => (
              // @ts-ignore
              <KPICard key={col} column={col} />
            ))}
          </div>
        );
      }
      // @ts-ignore
      case 'Line Chart': return <SmartLineChart key={key} xAxisColumn={cols[0]} yAxisColumns={cols.slice(1)} />;
      // @ts-ignore
      case 'Bar Chart': return <SmartBarChart key={key} categoryColumn={cols[0]} valueColumn={cols[1]} />;
      // @ts-ignore
      case 'Pie Chart': return <SmartPieChart key={key} categoryColumn={cols[0]} />;
      // @ts-ignore
      case 'Scatter Plot': return <SmartScatterPlot key={key} xColumn={cols[0]} yColumn={cols[1]} colorColumn={cols[2]} />;
      // @ts-ignore
      case 'Histogram': return <SmartHistogram key={key} column={cols[0]} />;
      // @ts-ignore
      case 'Heatmap Correlation Matrix': return <CorrelationHeatmap key={key} columns={cols.length > 2 ? cols : dataset.columns.filter((c:any)=>c.type==='numeric').map((c:any)=>c.name)} />;
      // @ts-ignore
      case 'Box Plot': return <SmartBoxPlot key={key} column={cols[0]} groupColumn={cols[1]} />;
      // @ts-ignore
      case 'Area Chart': return <SmartAreaChart key={key} xAxisColumn={cols[0]} yAxisColumns={cols.slice(1)} />;
      // @ts-ignore
      case 'Data Table': return <SmartDataTable key={key} columns={cols.length > 0 ? cols : dataset.columns.map((c:any)=>c.name).slice(0, 8)} />;
      default: return null;
    }
  };

  const getInsights = async () => {
    setLoadingInsights(true);
    try {
      const summary = {
         rowCount: filteredData.length,
         metrics: config?.topKPIs?.map((kpi: string) => {
           const vals = filteredData.map(d => Number(d[kpi])).filter(n => !isNaN(n));
           const sum = vals.reduce((a, b) => a + b, 0);
           return { name: kpi, average: vals.length ? (sum / vals.length) : 0, sum, count: vals.length };
         })
      };
      const response = await apiFetch('/api/dashboard/insight-banner', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ dataStateSummary: summary })
      });
      const data = await response.json();
      if (data && Array.isArray(data.insights) && data.insights.length > 0) {
        setInsightBannerData(data.insights);
        setInsightsAreAi(true);
        setInsightsRowCount(filteredData.length);
      } else {
        // No AI narrative available (no API key, or the call returned nothing): describe the real numbers instead.
        setInsightBannerData(buildLocalInsights(filteredData, summary.metrics || []));
        setInsightsAreAi(false);
      }
    } catch (e) {
      console.error(e);
      setInsightBannerData(buildLocalInsights(filteredData, []));
      setInsightsAreAi(false);
    } finally {
      setLoadingInsights(false);
    }
  };

  useEffect(() => {
    if (config && filteredData.length > 0 && !insightBannerData) {
      getInsights();
    }
  }, [config]);

  // Built-in insights are recomputed from the rows on screen, so they follow the filters.
  const localMetrics = (config?.topKPIs ?? []).map((kpi: string) => {
    const vals = filteredData.map((d: any) => Number(d[kpi])).filter((n: number) => !isNaN(n));
    return { name: kpi, average: vals.length ? vals.reduce((a: number, b: number) => a + b, 0) / vals.length : 0, count: vals.length };
  });
  const shownInsights: string[] | null = insightBannerData && !insightsAreAi
    ? buildLocalInsights(filteredData, localMetrics)
    : insightBannerData;

  const toolbar = <DashboardToolbar dataset={dataset} datasetId={datasetId} onInitialLoad={handleInitialLoad} />;

  if (loadingConfig) {
    return (
      <div className="flex flex-col mb-4">{toolbar}
      <div className="flex flex-col items-center justify-center p-12 bg-surface border border-separator rounded-xl">
        <Orb state="solving" size={64} label="Building your dashboard" className="mb-4" />
        <h3 className="text-sm font-semibold text-label">Building your dashboard</h3>
        <p className="text-xs text-label-3 mt-2">Choosing charts for your {dataset.columns.length} columns…</p>
      </div>
      </div>
    );
  }

  if (configError && !config) {
    return (
      <div className="flex flex-col mb-4">{toolbar}
      <div className="flex flex-col items-center justify-center p-12 bg-surface border border-red/20 rounded-xl text-center">
        <h3 className="text-sm font-semibold text-red">The dashboard couldn’t be configured</h3>
        <p className="text-xs text-label-2 mt-2 max-w-md">{configError}</p>
        <button
          onClick={() => runAutoConfig()}
          className="mt-5 bg-blue hover:bg-blue text-white font-semibold text-xs py-2.5 px-5 rounded-lg transition-all"
        >
          Retry
        </button>
      </div>
      </div>
    );
  }

  // Every panel on the dashboard, in the order the design gave them.
  const HIDDEN = ['Filters Panel', 'Slicers Panel'];
  const gridItems: GridItem[] = activeComponents.filter(c => !HIDDEN.includes(baseType(c))).map(comp => {
    const type = baseType(comp);
    const rec = config?.designedBy ? config.recommendedComponents?.find((c: any) => c.id === comp) : null;
    const kind = type === 'KPI Cards' ? 'kpi' : type === 'Data Table' ? 'table' : type === 'Heatmap Correlation Matrix' ? 'wide' : 'chart';
    const agent = type === 'KPI Cards' ? 'dash-chart-kpi-cards' : type === 'Data Table' ? 'dash-chart-data-table' : type === 'Heatmap Correlation Matrix' ? 'dash-chart-heatmap-correlation-matrix' : `dash-chart-${slug(comp)}`;
    return {
      id: comp, kind, agent, title: rec?.title || type,
      node: <>
        {rec?.questionAnswered && kind === 'chart' && <p className="text-xs text-label-2 mb-1.5 px-1 truncate" title={rec.questionAnswered}>{rec.questionAnswered}</p>}
        {renderComponentWrapper(comp, comp)}
      </>,
    };
  });

  const gridClass = layout === '2-col' ? 'grid-cols-1 lg:grid-cols-2' : layout === '3-col' ? 'grid-cols-1 lg:grid-cols-3' : 'grid-cols-1';

  return (
 <div className="flex flex-col mb-4 animate-fade-in relative">{toolbar}
      
      {/* Insight Banner */}
      {shownInsights && (
        <div className="card p-4 sm:p-5 mb-6 relative group">
          <div className="absolute top-3 right-3 flex gap-1">
            <button onClick={getInsights} className="btn btn-icon w-8 h-8" title="Refresh insights" aria-label="Refresh insights">
              {loadingInsights ? <Orb state="composing" label="Writing insights" /> : <RefreshCw className="w-4 h-4" />}
            </button>
            <button onClick={() => { navigator.clipboard.writeText(shownInsights.join('\n')); setCopiedInsights(true); setTimeout(()=>setCopiedInsights(false), 2000); }} className="bg-fill hover:bg-fill-strong p-1.5 rounded text-blue" title="Copy">
              {copiedInsights ? <Check className="w-4 h-4" /> : <Copy className="w-4 h-4" />}
            </button>
          </div>
          <div className="flex items-start gap-4">
            <div className="w-10 h-10 rounded-xl bg-blue/12 text-blue flex items-center justify-center shrink-0">
              <Sparkles className="w-5 h-5" />
            </div>
            <div>
              <h3 className="card-title mb-2">{insightsAreAi ? 'AI insights' : 'Key insights'}</h3>
              {insightsAreAi && insightsRowCount !== null && insightsRowCount !== filteredData.length && (
                <p className="-mt-1 mb-2 text-xs text-orange">
                  Written for {insightsRowCount.toLocaleString()} rows; the filters now show {filteredData.length.toLocaleString()}. Refresh to update.
                </p>
              )}
              <ul className="space-y-2">
                {shownInsights.map((item, i) => (
                  <li key={i} className="text-sm text-label flex items-start gap-2">
                    <span className="text-label-3">•</span> {item}
                  </li>
                ))}
              </ul>
            </div>
          </div>
        </div>
      )}

      {/* Main Layout Area */}
      <div className="flex gap-7 items-start w-full transition-all">
        {/* Dynamic Charts Area */}
        <div className={`flex-1 transition-all ${(expertMode && sidebarOpen) ? 'w-[70%]' : 'w-full'}`}>
          <DashGrid storageKey={`dash-grid:${datasetId ?? dataset.filename}`} perRow={layout === '1-col' ? 1 : layout === '3-col' ? 3 : 2}
            items={gridItems} />
        </div>

        {/* Sidebar Trigger */}
        {expertMode && !sidebarOpen && (
           <div className="absolute right-0 top-0 mt-2 mr-2 z-50">
             <button onClick={() => setSidebarOpen(true)} className="bg-fill hover:bg-fill-strong p-2 rounded-l py-4 border border-r-0 border-separator-strong shadow-sm transition-all">
               <PanelRightOpen className="w-4 h-4 text-label" />
             </button>
           </div>
        )}

        {/* User Customisation Panel */}
        {expertMode && sidebarOpen && (
          <div className="w-80 shrink-0 bg-surface border border-separator rounded-xl shadow-xl flex flex-col sticky top-4 max-h-[90vh]">
            <div className="p-4 border-b border-separator flex justify-between items-center bg-fill rounded-t-xl z-20">
              <h3 className="text-xs font-medium text-label flex items-center gap-2">
                <Server className="w-4 h-4" /> Customize
              </h3>
              <button onClick={() => setSidebarOpen(false)} className="text-label-3 hover:text-label">
                <PanelRightClose className="w-4 h-4" />
              </button>
            </div>

            <div className="flex-1 overflow-y-auto custom-scrollbar p-4 space-y-6">
              
              {/* Business Problem Selector */}
              <div>
                <label className="text-[11px] font-medium text-label-3 block mb-2">Business Problem Selection</label>
                <select 
                  value={customProblem || config?.detectedProblem || PROBLEM_TYPES[0]}
                  onChange={(e) => runAutoConfig(e.target.value)}
                  className="w-full bg-well border border-separator rounded p-2 text-xs text-label mb-2 focus:ring-1 focus:ring-blue focus:outline-none"
                >
                  <option value="" disabled>Detected: {config?.detectedProblem}</option>
                  {PROBLEM_TYPES.map(p => <option key={p} value={p}>{p}</option>)}
                </select>
                <div className="flex gap-2">
                  <input type="text" placeholder="Or type custom problem..." value={customProblem} onChange={(e)=>setCustomProblem(e.target.value)} className="w-full bg-well border border-separator rounded p-2 text-xs text-label focus:ring-1 focus:ring-blue focus:outline-none" />
                  <button onClick={() => runAutoConfig()} className="bg-blue hover:bg-blue text-white px-3 rounded text-xs transition-colors">Apply</button>
                </div>
              </div>

              {/* Layout Control */}
              <div className="border-t border-separator pt-4">
                <label className="text-[11px] font-medium text-label-3 block mb-2">Dashboard Layout</label>
                <div className="flex bg-well rounded-lg p-1 border border-separator">
                  <button onClick={() => setLayout('2-col')} className={`flex-1 flex items-center justify-center py-1.5 rounded text-xs transition-colors ${layout === '2-col' ? 'bg-fill text-label shadow-sm' : 'text-label-3 hover:text-label'}`}>
                    <LayoutGrid className="w-3.5 h-3.5 mr-1" /> 2 Columns
                  </button>
                  <button onClick={() => setLayout('3-col')} className={`flex-1 flex items-center justify-center py-1.5 rounded text-xs transition-colors ${layout === '3-col' ? 'bg-fill text-label shadow-sm' : 'text-label-3 hover:text-label'}`}>
                    <LayoutGrid className="w-3.5 h-3.5 mr-1" /> 3 Columns
                  </button>
                </div>
              </div>

              {/* Add Components Checklist */}
              <div className="border-t border-separator pt-4">
                <label className="text-[11px] font-medium text-label-3 block mb-3">Visible Components</label>
                <div className="space-y-2">
                  {COMPONENT_LIST.map(comp => {
                    const isRecommended = !!config?.recommendedComponents?.find((c: any) => c.type === comp);
                    const isActive = activeComponents.includes(comp);
                    return (
                      <div key={comp} className="flex items-center justify-between group">
                        <label className="flex items-center gap-2 cursor-pointer flex-1">
                          <input 
                            type="checkbox" 
                            checked={isActive}
                            onChange={(e) => {
                              if (e.target.checked) setActiveComponents([...activeComponents, comp]);
                              else setActiveComponents(activeComponents.filter(c => c !== comp));
                            }}
                            className="bg-surface border-separator-strong text-blue rounded focus:ring-0 w-3.5 h-3.5"
                          />
                          <span className={`text-[11px] ${isActive ? 'text-label' : 'text-label-3'}`}>{comp}</span>
                          {isRecommended && <span className="text-[11px] bg-blue/20 text-blue px-1 rounded block ml-auto mr-1">AI Pick</span>}
                        </label>
                      </div>
                    );
                  })}
                </div>
              </div>

               {/* Dedicated Panels rendered inline inside sidebar */}
               {activeComponents.includes('Filters Panel') && (
                 <div className="border-t border-separator pt-4">
                   <FiltersPanel dataset={dataset} />
                 </div>
               )}
               {activeComponents.includes('Slicers Panel') && (
                 <div className="border-t border-separator pt-4">
                   <SlicersPanel dataset={dataset} />
                 </div>
               )}

            </div>
          </div>
        )}
      </div>

    </div>
  );
}
