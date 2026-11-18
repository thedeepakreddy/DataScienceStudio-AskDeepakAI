import { describe, expect, it } from 'vitest';
import { pandasScript, stepCode } from './pandasCode';
import { buildReport, homeOf } from './buildReport';
import { defaultLayout, shapeReport, toMarkdown } from './layout';
import { computeReportFindings } from '../utils/reportFindings';
import type { Dataset } from '../types';

const ds: Dataset = {
  filename: 'sales.csv', rowCount: 4, originalRowCount: 5,
  rows: [{ amount: 10, region: 'N', n: 1 }, { amount: 20, region: 'S', n: 2 }, { amount: 30, region: 'N', n: 3 }, { amount: 50, region: 'S', n: 5 }],
  columns: [
    { name: 'amount', type: 'numeric', missingCount: 0, distinctCount: 4, statistics: { mean: 27.5, median: 25, min: 10, max: 50 } },
    { name: 'region', type: 'categorical', missingCount: 0, distinctCount: 2, statistics: {} },
    { name: 'n', type: 'numeric', missingCount: 0, distinctCount: 4, statistics: { mean: 2.75, median: 2.5, min: 1, max: 5 } },
  ],
} as any;

describe('cleaning steps as pandas', () => {
  it('writes each step as runnable pandas, quoting names safely', () => {
    expect(stepCode({ op: 'drop_columns', params: { columns: ['a', "o'k"] } } as any)).toBe("df = df.drop(columns=['a', 'o\\'k'])");
    expect(stepCode({ op: 'fill_missing', params: { column: 'age', strategy: 'median' } } as any)).toBe("df['age'] = df['age'].fillna(df['age'].median())");
    expect(stepCode({ op: 'filter_rows', params: { column: 'x', operator: 'greater_than', value: 3 } } as any)).toBe('df = df[pd.to_numeric(df[\'x\'], errors="coerce") > 3].reset_index(drop=True)');
    expect(stepCode({ op: 'group_aggregate', params: { by: ['r'], aggregations: [{ column: 'amount', fn: 'sum' }] } } as any)).toBe("df = df.groupby(['r'], dropna=False).agg(**{'amount_sum': ('amount', 'sum')}).reset_index()");
    const script = pandasScript({ sourceFile: 'sales.csv', steps: [{ label: 'Removed duplicates', op: { op: 'remove_duplicates', params: {} } as any }] });
    expect(script).toContain("df = pd.read_csv('sales.csv')");
    expect(script).toContain('# 1. Removed duplicates\ndf = df.drop_duplicates().reset_index(drop=True)');
  });
});

describe('the report', () => {
  const run = (over: any) => ({ id: over.id, versionId: 'v1', status: 'succeeded', createdAt: over.createdAt ?? 1, title: over.title, summary: over.summary, kind: over.kind, params: over.params, result: over.result });
  const doc = buildReport({
    dataset: ds, findings: computeReportFindings(ds, null), mlResult: null, aiAnalysis: { overviewSummary: 'Sales look healthy.' },
    chain: [{ id: 'v1', label: 'Imported', rowCount: 5, columnCount: 3, createdAt: 1, filename: 'sales.csv' } as any, { id: 'v2', label: 'Removed duplicates', rowCount: 4, columnCount: 3, createdAt: 2, operation: { op: 'remove_duplicates', params: {} } } as any],
    runs: [
      run({ id: 'r1', kind: 'sql-query', title: 'SELECT', summary: '2 rows', params: { sql: 'SELECT region, SUM(amount) FROM dataset GROUP BY region' } }),
      run({ id: 'r2', kind: 'engine', title: 'Regression for any outcome (GLM)', summary: 'n has the clearest effect on amount', params: { capability: 'stats.glm', params: { outcome: 'amount' }, runId: 'run_1' } }),
      run({ id: 'r3', kind: 'engine', title: 'Regression for any outcome (GLM)', summary: 'older', createdAt: 0, params: { capability: 'stats.glm', params: { outcome: 'amount' }, runId: 'run_0' } }),
      run({ id: 'r4', kind: 'engine', title: 'Find segments', summary: '3 segments', params: { capability: 'unsup.cluster', params: {}, runId: 'run_2' } }),
    ] as any,
    activeModel: null, pins: [], dashboards: [{ id: 'd', datasetId: 'x', name: 'Main', savedAt: 1, activeComponents: ['Bar Chart'], layout: '2-col', config: null, categoryFilters: {}, numericSlicers: {}, kpis: [{ id: 'k', name: 'Total sales', formula: 'SUM(amount)', format: 'number' }] }] as any,
  });
  const sec = (id: string) => doc.sections.find(s => s.id === id)!;

  it('puts each piece of work in its section', () => {
    expect(doc.sections.map(s => s.id)).toEqual(['summary', 'data', 'quality', 'preparation', 'exploration', 'statistics', 'models', 'forecasts', 'dashboard', 'reproducibility', 'appendix']);
    expect(sec('preparation').blocks.map(b => b.kind)).toEqual(['table', 'code', 'code']);
    expect((sec('preparation').blocks[2] as any).language).toBe('sql');
    // The newest run of a repeated analysis only.
    expect(sec('statistics').blocks.map(b => (b as any).headline)).toEqual(['n has the clearest effect on amount']);
    expect(sec('exploration').blocks.some(b => b.kind === 'analysis' && b.title === 'Find segments')).toBe(true);
    expect(sec('exploration').blocks.some(b => b.kind === 'histogram')).toBe(true);
    expect((sec('dashboard').blocks[0] as any).rows[0]).toMatchObject({ name: 'Total sales', value: '110' });
    expect(sec('summary').blocks.find(b => b.kind === 'callout')).toMatchObject({ tone: 'ai' });
    expect(homeOf('ts.forecast')).toBe('forecasts');
    expect(homeOf('data.recipe')).toBe('preparation');
  });

  it('applies the user’s edits and leaves out empty sections', () => {
    const layout = { ...defaultLayout('sales.csv'), hidden: ['quality', 'eda-corr'], titles: { data: 'About the data' }, notes: { statistics: 'Checked with the team.' }, order: ['statistics'], summary: 'Our own summary.' };
    const { sections, removed } = shapeReport(doc, layout);
    expect(sections[0].id).toBe('statistics');
    expect(sections.find(s => s.id === 'quality')).toBeUndefined();
    expect(sections.find(s => s.id === 'forecasts')).toBeUndefined(); // nothing was forecast
    expect(sections.find(s => s.id === 'data')!.title).toBe('About the data');
    expect((sections.find(s => s.id === 'summary')!.blocks[0] as any).text).toBe('Our own summary.');
    expect(removed.map(r => r.label)).toEqual(expect.arrayContaining(['Section: Data quality']));
    const md = toMarkdown(sections, layout, 0);
    expect(md).toContain('# Data Analysis Report');
    expect(md).toContain('## 1. Statistical analysis');
    expect(md).toContain('Checked with the team.');
    expect(md).toContain('```sql\nSELECT region, SUM(amount) FROM dataset GROUP BY region\n```');
  });
});
