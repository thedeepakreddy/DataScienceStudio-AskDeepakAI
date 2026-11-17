/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Dataset, MLResult } from '../types';
import { isIdentifierColumn } from '../utils/csvParser';
import { mentionedColumns } from './text';

// The Dashboard Designer's playbook (docs/AGENTS_PLAN.md §6): charts chosen
// from what the user asked for and what the data is, by the grammar of
// charts — trend → line, compare → bar, share → pie (≤ 6 slices),
// distribution → histogram/box, relationship → scatter, many numbers →
// heatmap. Deterministic, so the same request gives the same dashboard,
// and no AI call is needed.

export type ChartType =
  | 'KPI Cards' | 'Line Chart' | 'Bar Chart' | 'Pie Chart' | 'Scatter Plot' | 'Histogram'
  | 'Heatmap Correlation Matrix' | 'Box Plot' | 'Area Chart' | 'Data Table' | 'Filters Panel';

/** Chart types the studio actually draws (the list also names a few it doesn't yet). */
export const DRAWABLE: ChartType[] = ['KPI Cards', 'Line Chart', 'Bar Chart', 'Pie Chart', 'Scatter Plot', 'Histogram', 'Heatmap Correlation Matrix', 'Box Plot', 'Area Chart', 'Data Table', 'Filters Panel'];

export interface DesignParams {
  /** The user's own words about the dashboard. */
  focus?: string;
  metrics?: string[];
  dimensions?: string[];
  time?: string;
  /** Chart types the user named. */
  charts?: string[];
  /** The outcome column, when there is one. */
  target?: string;
}

export interface DesignedComponent { type: ChartType; columnsToUse: string[]; questionAnswered: string; whyRelevant: string }

export interface DashboardDesign {
  recommendedComponents: DesignedComponent[];
  topKPIs: string[];
  detectedDomain: string;
  detectedProblem: string;
  layout: '2-col' | '3-col';
  /** Columns offered as filters. */
  filterColumns: string[];
  designedBy: 'agents';
}

const MONEY = /(revenue|sales|amount|price|charge|cost|profit|income|spend|value|total|fee|salary|balance)/i;
const OUTCOME = /(target|label|churn|outcome|default|fraud|converted|survived|status|result)$/i;
const MAX_CHARTS = 8;

const has = (text: string, re: RegExp) => re.test(text);

/** What kind of chart the user's words ask for. */
function intents(text: string) {
  const t = text.toLowerCase();
  return {
    trend: has(t, /\b(trend|over time|time series|monthly|weekly|daily|yearly|by (month|week|day|year|date)|timeline|growth)\b/),
    compare: has(t, /\b(compare|comparison|by|across|per|each|versus groups?|breakdown by)\b/),
    share: has(t, /\b(share|proportion|percentage|mix|composition|split|breakdown|part of)\b/),
    distribution: has(t, /\b(distribution|spread|range|histogram|outliers?)\b/),
    relationship: has(t, /\b(relationship|relate|correlat|vs|versus|against|impact of|effect of)\b/),
    named: (['line', 'bar', 'pie', 'scatter', 'histogram', 'box', 'heatmap', 'area', 'table'] as const)
      .filter(k => new RegExp(`\\b${k}( chart| plot| map)?s?\\b`, 'i').test(t)),
  };
}

const NAMED_TO_TYPE: Record<string, ChartType> = {
  line: 'Line Chart', bar: 'Bar Chart', pie: 'Pie Chart', scatter: 'Scatter Plot', histogram: 'Histogram',
  box: 'Box Plot', heatmap: 'Heatmap Correlation Matrix', area: 'Area Chart', table: 'Data Table',
};

function domainOf(names: string[]): { domain: string; problem: string } {
  const all = names.join(' ').toLowerCase();
  if (/churn|cancel|retention|tenure/.test(all)) return { domain: 'Customers', problem: 'Customer Churn Analysis' };
  if (/revenue|sales|order|product|price/.test(all)) return { domain: 'Sales', problem: 'Sales Performance' };
  if (/deliver|shipment|route|logistic/.test(all)) return { domain: 'Operations', problem: 'Delivery and Logistics' };
  if (/loan|credit|default|risk|fraud/.test(all)) return { domain: 'Finance', problem: 'Financial Risk' };
  if (/campaign|click|impression|conversion|ad_|marketing/.test(all)) return { domain: 'Marketing', problem: 'Marketing Campaign Analysis' };
  if (/employee|salary|hire|attrition|department/.test(all)) return { domain: 'People', problem: 'HR and Workforce Analytics' };
  return { domain: 'General', problem: 'General analysis' };
}

/** Designs a dashboard for this data and request. */
export function designDashboard(ds: Dataset, p: DesignParams = {}, model: MLResult | null = null): DashboardDesign {
  const text = p.focus ?? '';
  const want = intents(text);
  const cols = ds.columns.filter(c => !isIdentifierColumn(c, ds.rowCount));
  const byName = new Map(ds.columns.map(c => [c.name.toLowerCase(), c]));
  const find = (n?: string) => (n ? byName.get(n.toLowerCase()) : undefined);
  const mentioned = mentionedColumns(text, ds).map(n => find(n)!).filter(c => c && !isIdentifierColumn(c, ds.rowCount));

  const isMetric = (c: Dataset['columns'][number]) => c.type === 'numeric' && c.distinctCount > 2;
  const isDim = (c: Dataset['columns'][number]) => (c.type === 'categorical' || c.type === 'boolean' || (c.type === 'numeric' && c.distinctCount <= 6)) && c.distinctCount >= 2 && c.distinctCount <= 12;

  const time = find(p.time) ?? mentioned.find(c => c.type === 'datetime') ?? cols.find(c => c.type === 'datetime');
  const target = find(p.target) ?? (model?.target ? find(model.target) : undefined) ?? cols.find(c => OUTCOME.test(c.name) && (isDim(c) || isMetric(c)));

  // Metrics: named > numeric outcome > money-like > most variable.
  const metricPool = cols.filter(isMetric);
  const cv = (c: Dataset['columns'][number]) => Math.abs((c.statistics?.stdDev ?? 0) / ((c.statistics?.mean ?? 0) || 1));
  const metrics = [
    ...(p.metrics ?? []).map(find).filter((c): c is NonNullable<typeof c> => !!c && isMetric(c)),
    ...mentioned.filter(isMetric),
    ...(target && isMetric(target) ? [target] : []),
    ...metricPool.filter(c => MONEY.test(c.name)),
    ...[...metricPool].sort((a, b) => cv(b) - cv(a)),
  ].filter((c, i, a) => a.findIndex(x => x.name === c.name) === i);

  // Dimensions: named > categorical outcome > the model's top categorical drivers > fewest values.
  const drivers = (model?.featureImportance ?? []).map(f => find(f.feature)).filter((c): c is NonNullable<typeof c> => !!c && isDim(c));
  const dims = [
    ...(p.dimensions ?? []).map(find).filter((c): c is NonNullable<typeof c> => !!c && isDim(c)),
    ...mentioned.filter(isDim),
    ...(target && isDim(target) ? [target] : []),
    ...drivers,
    ...[...cols.filter(isDim)].sort((a, b) => a.distinctCount - b.distinctCount),
  ].filter((c, i, a) => a.findIndex(x => x.name === c.name) === i);

  const m0 = metrics[0]?.name, m1 = metrics[1]?.name;
  const d0 = dims[0]?.name, d1 = dims[1]?.name;
  const comps: DesignedComponent[] = [];
  const add = (type: ChartType, columnsToUse: string[], questionAnswered: string, whyRelevant: string) => {
    if (comps.some(c => c.type === type && c.columnsToUse.join() === columnsToUse.join())) return;
    comps.push({ type, columnsToUse, questionAnswered, whyRelevant });
  };
  const visual = () => comps.filter(c => !['KPI Cards', 'Filters Panel', 'Data Table'].includes(c.type)).length;
  const room = () => visual() < MAX_CHARTS;

  // 1. Charts the user named, filled with the best columns for each.
  for (const k of want.named) {
    const type = NAMED_TO_TYPE[k];
    if (!room() && type !== 'Data Table') break;
    if ((type === 'Line Chart' || type === 'Area Chart') && time && m0) add(type, [time.name, m0], `How does ${m0} change over time?`, 'You asked for a trend.');
    else if (type === 'Bar Chart' && d0 && m0) add(type, [d0, m0], `How does ${m0} differ by ${d0}?`, 'You asked to compare groups.');
    else if (type === 'Pie Chart' && d0 && dims[0].distinctCount <= 6) add(type, [d0], `What share of rows falls in each ${d0}?`, 'You asked for a breakdown.');
    else if (type === 'Scatter Plot' && m0 && m1) add(type, [m0, m1, ...(d0 ? [d0] : [])], `How do ${m0} and ${m1} move together?`, 'You asked for a relationship.');
    else if (type === 'Histogram' && m0) add(type, [m0], `How is ${m0} distributed?`, 'You asked for a distribution.');
    else if (type === 'Box Plot' && m0) add(type, [m0, ...(d0 ? [d0] : [])], `How spread out is ${m0}${d0 ? ` in each ${d0}` : ''}?`, 'You asked for a distribution.');
    else if (type === 'Heatmap Correlation Matrix' && metrics.length >= 3) add(type, metrics.slice(0, 8).map(c => c.name), 'Which numbers move together?', 'You asked for a heatmap.');
    else if (type === 'Data Table') add(type, [...new Set([...mentioned.map(c => c.name), ...[d0, m0, m1].filter(Boolean) as string[]])].slice(0, 8), 'What are the rows behind the charts?', 'You asked for a table.');
  }

  // 2. The grammar, guided by the words used (or sensible defaults).
  const noIntent = !want.trend && !want.compare && !want.share && !want.distribution && !want.relationship && want.named.length === 0;
  if (time && m0 && (want.trend || noIntent) && room()) add('Line Chart', [time.name, m0], `How does ${m0} change over time?`, `${time.name} is a date, so the trend shows direction and seasonality.`);
  if ((want.compare || noIntent) && m0) {
    for (const d of dims.slice(0, 2)) if (room()) add('Bar Chart', [d.name, m0], `How does ${m0} differ by ${d.name}?`, `${d.name} has ${d.distinctCount} groups — easy to compare side by side.`);
  }
  if ((want.share || noIntent) && room()) {
    const pieDim = (target && isDim(target) && target.distinctCount <= 6 ? target : dims.find(d => d.distinctCount <= 6));
    if (pieDim) add('Pie Chart', [pieDim.name], `What share of rows falls in each ${pieDim.name}?`, `${pieDim.name} has only ${pieDim.distinctCount} values, so the slices stay readable.`);
  }
  if ((want.distribution || noIntent) && m0 && room()) add('Histogram', [m0], `How is ${m0} distributed?`, 'Shows skew, gaps and outliers at a glance.');
  if ((want.distribution || (noIntent && d0)) && m0 && room()) add('Box Plot', [m0, ...(d0 ? [d0] : [])], `How spread out is ${m0}${d0 ? ` in each ${d0}` : ''}?`, 'Compares medians and ranges, and shows outliers.');
  if ((want.relationship || noIntent) && m0 && m1 && room()) add('Scatter Plot', [m0, m1, ...(d0 ? [d0] : [])], `How do ${m0} and ${m1} move together?`, d0 ? `Coloured by ${d0} to see whether groups differ.` : 'Shows the relationship between two numbers.');
  if ((want.relationship || noIntent) && metrics.length >= 3 && room()) add('Heatmap Correlation Matrix', metrics.slice(0, 8).map(c => c.name), 'Which numbers move together?', `${metrics.length} numeric columns — the heatmap shows every pair at once.`);
  // Something to look at even when the words matched nothing drawable.
  if (visual() === 0 && m0) add('Histogram', [m0], `How is ${m0} distributed?`, 'The main number in this data.');

  // 3. Always: KPIs on top, filters for the main dimensions, the rows behind it.
  const kpis = metrics.slice(0, 4).map(c => c.name);
  if (kpis.length) comps.unshift({ type: 'KPI Cards', columnsToUse: kpis, questionAnswered: 'What are the headline numbers?', whyRelevant: 'The metrics that matter most here, updated by the filters.' });
  const filterColumns = dims.slice(0, 3).map(d => d.name);
  if (filterColumns.length) add('Filters Panel', filterColumns, 'Which slice of the data am I looking at?', `Filter by ${filterColumns.join(', ')}.`);
  if (!comps.some(c => c.type === 'Data Table')) {
    const tableCols = [...new Set([...mentioned.map(c => c.name), ...(time ? [time.name] : []), ...dims.slice(0, 2).map(d => d.name), ...metrics.slice(0, 3).map(c => c.name)])].slice(0, 8);
    if (tableCols.length) add('Data Table', tableCols, 'What are the rows behind the charts?', 'The columns this dashboard is about.');
  }

  const { domain, problem } = domainOf(ds.columns.map(c => c.name));
  return {
    recommendedComponents: comps,
    topKPIs: kpis,
    detectedDomain: domain,
    detectedProblem: problem,
    layout: visual() <= 4 ? '2-col' : '3-col',
    filterColumns,
    designedBy: 'agents',
  };
}
