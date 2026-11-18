/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React from 'react';
import { CartesianGrid, ComposedChart, Legend, Line, LineChart, ResponsiveContainer, Scatter, ScatterChart, Tooltip, XAxis, YAxis, ZAxis } from 'recharts';
import { CHART_COLORS } from '../../utils/chartTheme';
import { DataTable, Note, Section, StatGrid, num, pValue, pct, sig, type Method } from '../stats/methodKit';
import UseEngineDataset from './UseEngineDataset';
import {
  ModelSelectEditor, RecipeEditor, RulesEditor, checkNumbers, checkRecipe, checkRules, initialRecipe, initialRules, parseNumbers, recipeToSteps, rulesToParams,
} from './editors';

const axis = { tick: { fontSize: 11, fill: 'var(--label-2)' }, stroke: 'var(--separator)' };
const day = (d: unknown) => (typeof d === 'string' ? d.slice(0, 10) : String(d));
const show = (v: unknown) => (v === null || v === undefined ? '—' : typeof v === 'number' ? num(v, 4) : String(v));

// ================================================================== data quality (Clean)
const profile: Method = {
  id: 'profile', cap: 'data.profile', title: 'Profile every row',
  answers: 'Each column’s type, missing values, distinct values, statistics and top values — computed on all rows by the engine, not a sample.',
  fields: [{ key: 'columns', label: 'Only these columns (all when none)', kind: 'columns', filter: 'any' }],
  headline: r => `${r.rows?.toLocaleString()} rows × ${r.columnCount} columns; ${r.duplicateRows?.toLocaleString()} duplicate row${r.duplicateRows === 1 ? '' : 's'}; ${(r.columns ?? []).filter((c: any) => c.missing > 0).length} columns have missing values.`,
  tone: r => (r.duplicateRows || (r.columns ?? []).some((c: any) => c.missingShare > 0.2) ? 'warn' : 'good'),
  render: r => <>
    <DataTable limit={60} rows={r.columns ?? []} columns={[
      { key: 'name', label: 'Column' }, { key: 'type', label: 'Type' }, { key: 'missingShare', label: 'Missing', format: (v: number) => pct(v, 1) },
      { key: 'distinct', label: 'Distinct' },
      { key: 'mean', label: 'Mean / top value', format: (v: any, c: any) => (v != null ? num(v, 4) : c.topValues?.[0] ? `${c.topValues[0].value} (${pct(c.topValues[0].share)})` : '—') },
      { key: 'min', label: 'Range', format: (v: any, c: any) => (v != null ? `${num(v, 4)} – ${num(c.max, 4)}` : c.maxLength != null ? `≤ ${c.maxLength} chars` : '—') },
      { key: 'flags', label: 'Notes', format: (v: any) => (Array.isArray(v) && v.length ? v.join(', ') : '') },
    ]} />
    {r.correlations?.strongest?.length > 0 && (
      <Section title="Strongest relationships between numbers">
        <DataTable limit={8} rows={r.correlations.strongest} columns={[{ key: 'a', label: 'Column' }, { key: 'b', label: 'With' }, { key: 'pearson', label: 'Pearson r' }, { key: 'spearman', label: 'Spearman ρ' }]} />
      </Section>
    )}
  </>,
};

const validate: Method = {
  id: 'validate', cap: 'data.validate', title: 'Check data rules',
  answers: 'Rules your data must meet — never empty, unique, in a range, from a list, matching a pattern — checked on every row, with the rows that break them.',
  fields: [{ key: 'rules', label: 'Rules', kind: 'custom', initial: initialRules, editor: RulesEditor, check: checkRules }],
  params: v => ({ rules: rulesToParams(v.rules) }),
  headline: r => (r.failed ? `${r.failed} of ${r.passed + r.failed} rules fail.` : `All ${r.passed} rules pass on ${r.rows?.toLocaleString()} rows.`),
  tone: r => (r.failed ? 'warn' : 'good'),
  render: r => <>
    <DataTable rows={r.results ?? []} columns={[
      { key: 'rule', label: 'Rule', format: (x: any) => `${x.column ? `${x.column}: ` : ''}${String(x.kind).replace(/_/g, ' ')}` },
      { key: 'passed', label: '', format: (p: boolean) => <span className={p ? 'text-green' : 'text-orange font-medium'}>{p ? 'passes' : 'fails'}</span> },
      { key: 'failing', label: 'Rows failing' }, { key: 'failingShare', label: 'Share', format: (v: number) => pct(v, 1) }, { key: 'detail', label: 'Detail' },
    ]} />
    {(r.results ?? []).filter((x: any) => !x.passed && x.examples?.length).slice(0, 3).map((x: any, i: number) => (
      <Section key={i} title={`Examples failing “${x.column ? `${x.column}: ` : ''}${String(x.rule.kind).replace(/_/g, ' ')}”`}>
        <DataTable limit={5} rows={x.examples} columns={Object.keys(x.examples[0]).slice(0, 8).map(k => ({ key: k, label: k, format: show }))} />
      </Section>
    ))}
  </>,
};

const outliers: Method = {
  id: 'outliers', cap: 'data.outliers', title: 'Find unusual values',
  answers: 'Values far from the rest in each column (IQR, z-score, MAD), or rows that are unusual as a whole (Isolation Forest, LOF).',
  fields: [
    { key: 'columns', label: 'Columns (all numbers when none)', kind: 'columns', filter: 'numeric' },
    { key: 'method', label: 'Method', kind: 'select', default: 'iqr', options: [
      { value: 'iqr', label: 'Per column — IQR fences' }, { value: 'zscore', label: 'Per column — z-score' }, { value: 'mad', label: 'Per column — robust (MAD)' },
      { value: 'isolation_forest', label: 'Whole rows — Isolation Forest' }, { value: 'lof', label: 'Whole rows — Local Outlier Factor' }] },
    { key: 'threshold', label: 'Strictness (blank = standard)', kind: 'number', optional: true, step: 0.1 },
    { key: 'save_flagged', label: 'Save the unusual rows as a dataset', kind: 'toggle', default: false },
  ],
  headline: r => `${r.flaggedRows?.toLocaleString()} of ${r.rowsChecked?.toLocaleString()} rows (${pct(r.flaggedShare, 1)}) look unusual.`,
  tone: r => (r.flaggedShare > 0.1 ? 'warn' : 'plain'),
  render: r => <>
    {r.perColumn?.length > 0 && <DataTable rows={r.perColumn} columns={[{ key: 'column', label: 'Column' }, { key: 'lower', label: 'Usual from' }, { key: 'upper', label: 'to' }, { key: 'count', label: 'Unusual' }, { key: 'share', label: 'Share', format: (v: number) => pct(v, 1) }]} />}
    {r.examples?.length > 0 && <Section title="Most unusual rows">
      <DataTable limit={10} rows={r.examples} columns={Object.keys(r.examples[0]).slice(0, 8).map(k => ({ key: k, label: k === '_outlier_score' ? 'Score' : k, format: show }))} />
    </Section>}
    {r.dataset && <UseEngineDataset dataset={r.dataset} mode="open" label="Open the unusual rows in the studio" />}
  </>,
};

const piiScan: Method = {
  id: 'pii', cap: 'data.pii_scan', title: 'Find personal data',
  answers: 'Emails, phone numbers, card numbers, IP addresses, national IDs, IBANs and postcodes hiding in your columns.',
  fields: [{ key: 'columns', label: 'Columns (all text when none)', kind: 'columns', filter: 'any' }],
  headline: r => (r.findings?.length ? `${r.findings.length} column${r.findings.length === 1 ? '' : 's'} may hold personal data: ${r.findings.map((f: any) => f.column).join(', ')}.` : 'No personal data found.'),
  tone: r => (r.findings?.length ? 'warn' : 'good'),
  render: r => <>
    <DataTable rows={r.findings ?? []} columns={[
      { key: 'column', label: 'Column' },
      { key: 'detected', label: 'Looks like', format: (d: any) => Object.entries(d ?? {}).map(([k, v]) => `${k.replace(/_/g, ' ')} (${pct(v as number)})`).join(', ') || '—' },
      { key: 'nameSuggestsPii', label: 'Name suggests it', format: (b: boolean) => (b ? 'yes' : '') }, { key: 'risk', label: 'Risk' },
    ]} />
    {r.findings?.length > 0 && <Note>Mask them with “Mask personal data” before sharing the data.</Note>}
  </>,
};

const piiMask: Method = {
  id: 'mask', cap: 'data.pii_mask', title: 'Mask personal data',
  answers: 'A copy of the data with the columns you choose hashed, redacted, partly masked, generalised or removed.',
  fields: [
    { key: 'columns', label: 'Columns to mask', kind: 'columns', filter: 'any', min: 1 },
    { key: 'method', label: 'How', kind: 'select', default: 'hash', options: [
      { value: 'hash', label: 'Hash (same value → same code; joins still work)' }, { value: 'redact', label: 'Redact (replace with ████)' },
      { value: 'partial', label: 'Partly mask (keep the last characters)' }, { value: 'generalize', label: 'Generalise (dates to month, numbers to bands)' }, { value: 'drop', label: 'Remove the columns' }] },
    { key: 'salt', label: 'Secret for hashing (optional)', kind: 'text', optional: true, secret: true },
  ],
  headline: r => `Masked ${r.columns?.join(', ')} (${r.method}) in a new copy of ${r.dataset?.rows?.toLocaleString()} rows.`,
  tone: () => 'good',
  render: r => r.dataset ? <UseEngineDataset dataset={r.dataset} mode="replace" summary={`Masked ${r.columns?.join(', ')} (${r.method})`} /> : null,
};

const recipe: Method = {
  id: 'recipe', cap: 'data.recipe', title: 'Prepare data with a recipe',
  answers: 'A list of preparation steps — filter, fill, de-duplicate, derive, bin, date parts, join, pivot, SQL and more — run on all rows, previewed first.',
  fields: [
    { key: 'recipe', label: 'Steps (run in order)', kind: 'custom', initial: initialRecipe, editor: RecipeEditor, check: checkRecipe },
    { key: 'preview', label: 'Preview only (don’t save a new dataset)', kind: 'toggle', default: true },
  ],
  params: v => ({ steps: recipeToSteps(v.recipe), preview: !!v.preview }),
  headline: r => `${r.preview ? 'Preview: ' : ''}${r.rows?.toLocaleString() ?? r.dataset?.rows?.toLocaleString()} rows × ${r.columns?.length ?? r.dataset?.columns?.length} columns after the steps.`,
  tone: () => 'good',
  render: r => <>
    {r.sample?.length > 0 && <DataTable limit={10} rows={r.sample} columns={(r.columns ?? Object.keys(r.sample[0])).slice(0, 10).map((k: string) => ({ key: k, label: k, format: show }))} />}
    {r.sql && <details><summary className="text-xs text-label-2 cursor-pointer">The SQL the engine ran</summary><pre className="mt-2 text-xs bg-fill rounded-xl p-3 overflow-x-auto whitespace-pre-wrap">{r.sql}</pre></details>}
    {r.dataset && <UseEngineDataset dataset={r.dataset} mode="replace" summary="Prepared with a recipe on the engine" />}
    {r.preview && <Note>Turn off “Preview only” and run again to save the result, then use it as the next version.</Note>}
  </>,
};

const estimate: Method = {
  id: 'estimate', cap: 'data.estimate', title: 'Estimate from a sample',
  answers: 'A fast estimate of an average, a share or a total from a random sample, with its margin of error — and the exact value to compare.',
  fields: [
    { key: 'column', label: 'Column', kind: 'column', filter: 'any' },
    { key: 'statistic', label: 'Estimate the', kind: 'select', default: 'mean', options: [{ value: 'mean', label: 'Average' }, { value: 'proportion', label: 'Share equal to a value' }, { value: 'total', label: 'Total' }] },
    { key: 'value', label: 'Value (for a share)', kind: 'text', optional: true },
    { key: 'sample_size', label: 'Sample size (blank = 10,000)', kind: 'number', optional: true, min: 30, step: 1 },
  ],
  params: v => ({ ...v, compare_exact: true }),
  headline: r => `${r.sampleRows >= r.populationRows ? 'The sample was the whole table, so this is exact: ' : ''}${r.statistic === 'proportion' ? pct(r.estimate, 1) : num(r.estimate, 5)} (${Math.round(r.confidence * 100)}% CI ${r.statistic === 'proportion' ? `${pct(r.ci[0], 1)} – ${pct(r.ci[1], 1)}` : `${num(r.ci[0], 5)} – ${num(r.ci[1], 5)}`}) from ${r.sampleRows?.toLocaleString()} of ${r.populationRows?.toLocaleString()} rows.`,
  render: r => <>
    <StatGrid items={[['Estimate', r.statistic === 'proportion' ? pct(r.estimate, 2) : num(r.estimate, 5)], ['Margin (±)', num(r.standardError * 1.96, 4)], ['Exact value', r.exact == null ? '—' : r.statistic === 'proportion' ? pct(r.exact, 2) : num(r.exact, 5)], ['Inside the interval', r.exactInsideCi == null ? '—' : r.exactInsideCi ? 'yes' : 'no']]} />
  </>,
};

// ================================================================== explore (segments, map, basket, time, relationships)
const cluster: Method = {
  id: 'cluster', cap: 'unsup.cluster', title: 'Find segments',
  answers: 'Natural groups in your rows (k-means, Gaussian mixtures, HDBSCAN, Ward or DBSCAN), how distinct they are, and what sets each apart.',
  fields: [
    { key: 'columns', label: 'Using (all numbers when none)', kind: 'columns', filter: 'numeric' },
    { key: 'method', label: 'Method', kind: 'select', default: 'kmeans', options: [
      { value: 'kmeans', label: 'k-means (number chosen by silhouette)' }, { value: 'gmm', label: 'Gaussian mixture (by BIC)' }, { value: 'hdbscan', label: 'HDBSCAN (finds noise too)' },
      { value: 'agglomerative', label: 'Hierarchical (Ward)' }, { value: 'dbscan', label: 'DBSCAN' }] },
    { key: 'k', label: 'Number of segments (blank = choose)', kind: 'number', optional: true, min: 2, max: 30, step: 1 },
    { key: 'save_labels', label: 'Save the data with a segment column', kind: 'toggle', default: false },
  ],
  headline: r => `${r.k} segments${r.noisePoints ? ` (+${r.noisePoints} rows that fit none)` : ''}; separation ${r.quality?.silhouette != null ? `${num(r.quality.silhouette, 2)} silhouette (${r.quality.silhouette > 0.5 ? 'clear' : r.quality.silhouette > 0.25 ? 'moderate' : 'weak'})` : '—'}.`,
  tone: r => (r.quality?.silhouette > 0.25 ? 'good' : 'warn'),
  render: r => <>
    <div className="h-64"><ResponsiveContainer>
      <ScatterChart margin={{ left: -20, right: 8, top: 4 }}>
        <CartesianGrid stroke="var(--separator)" /><XAxis dataKey="x" type="number" {...axis} tickFormatter={v => num(v, 2)} /><YAxis dataKey="y" type="number" {...axis} tickFormatter={v => num(v, 2)} /><ZAxis range={[14, 14]} />
        <Tooltip cursor={false} />
        {[...new Set<number>((r.map ?? []).map((p: any) => p.cluster))].sort((a, b) => a - b).map((c, i) => (
          <Scatter key={c} name={c < 0 ? 'No segment' : `Segment ${c + 1}`} data={r.map.filter((p: any) => p.cluster === c)} fill={c < 0 ? 'var(--label-3)' : CHART_COLORS[i % CHART_COLORS.length]} isAnimationActive={false} />
        ))}
        <Legend />
      </ScatterChart>
    </ResponsiveContainer></div>
    <DataTable rows={r.profiles ?? []} columns={[
      { key: 'label', label: 'Segment' }, { key: 'size', label: 'Rows' }, { key: 'share', label: 'Share', format: (v: number) => pct(v) },
      { key: 'distinctive', label: 'Stands out by', format: (d: any[]) => (d ?? []).slice(0, 3).map(x => `${x.direction} ${x.feature}`).join(', ') },
    ]} />
    {r.dataset && <UseEngineDataset dataset={r.dataset} mode="replace" summary="Added a segment column from the engine" />}
  </>,
};

const embed: Method = {
  id: 'map', cap: 'unsup.embed', title: 'Map the data',
  answers: 'Many columns squeezed onto a 2-D map (PCA, UMAP or t-SNE), so similar rows sit together — coloured by a column you choose.',
  fields: [
    { key: 'columns', label: 'Using (all numbers when none)', kind: 'columns', filter: 'numeric' },
    { key: 'method', label: 'Method', kind: 'select', default: 'pca', options: [{ value: 'pca', label: 'PCA (fast, explains variance)' }, { value: 'umap', label: 'UMAP (local structure)' }, { value: 'tsne', label: 't-SNE (clusters)' }] },
    { key: 'color_by', label: 'Colour by', kind: 'column', filter: 'categorical', optional: true },
  ],
  headline: r => (r.method === 'pca' && r.cumulative ? `The first two directions explain ${pct(r.cumulative[1] ?? r.cumulative[0])} of the variation.` : `Map of ${r.points?.length?.toLocaleString()} rows (${String(r.method).toUpperCase()}).`),
  render: r => {
    const groups = [...new Set<string>((r.points ?? []).map((p: any) => String(p.color ?? '')))];
    return <>
      <div className="h-72"><ResponsiveContainer>
        <ScatterChart margin={{ left: -20, right: 8, top: 4 }}>
          <CartesianGrid stroke="var(--separator)" /><XAxis dataKey="x" type="number" {...axis} tickFormatter={v => num(v, 2)} /><YAxis dataKey="y" type="number" {...axis} tickFormatter={v => num(v, 2)} /><ZAxis range={[12, 12]} />
          <Tooltip cursor={false} />
          {groups.slice(0, 10).map((g, i) => <Scatter key={g} name={g || 'rows'} data={r.points.filter((p: any) => String(p.color ?? '') === g)} fill={CHART_COLORS[i % CHART_COLORS.length]} fillOpacity={0.7} isAnimationActive={false} />)}
          {groups.length > 1 && <Legend />}
        </ScatterChart>
      </ResponsiveContainer></div>
      {r.loadings?.length > 0 && <Section title="What each direction is made of">
        <DataTable rows={r.loadings.slice(0, 3)} columns={[{ key: 'component', label: 'Direction' }, { key: 'top', label: 'Mostly', format: (t: any[]) => t.slice(0, 3).map(x => `${x.feature} (${num(x.loading, 2)})`).join(', ') }]} />
      </Section>}
    </>;
  },
};

const basket: Method = {
  id: 'basket', cap: 'unsup.association_rules', title: 'Items bought together',
  answers: 'Which items go together (market basket): “people who buy A also buy B”, with how often and how much more than chance.',
  fields: [
    { key: 'transaction', label: 'Basket / order id', kind: 'column', filter: 'any', optional: true },
    { key: 'item', label: 'Item', kind: 'column', filter: 'categorical', optional: true },
    { key: 'item_columns', label: 'Or yes/no item columns (one per item)', kind: 'columns', filter: 'binary' },
    { key: 'min_support', label: 'Rarest combination to keep (share of baskets)', kind: 'number', default: 0.02, min: 0.001, max: 1, step: 0.01 },
    { key: 'min_confidence', label: 'Least confidence', kind: 'number', default: 0.3, min: 0, max: 1, step: 0.05 },
  ],
  headline: r => (r.rules?.[0] ? `Strongest: people who buy ${r.rules[0].if.join(' + ')} also buy ${r.rules[0].then.join(' + ')} ${pct(r.rules[0].confidence)} of the time — ${num(r.rules[0].lift, 2)}× more than usual. ${r.ruleCount} rules from ${r.baskets?.toLocaleString()} baskets.` : `No rules met the thresholds in ${r.baskets?.toLocaleString()} baskets.`),
  render: r => <>
    <DataTable limit={25} rows={r.rules ?? []} columns={[
      { key: 'if', label: 'If they buy', format: (x: string[]) => x.join(' + ') }, { key: 'then', label: 'They also buy', format: (x: string[]) => x.join(' + ') },
      { key: 'confidence', label: 'How often', format: (v: number) => pct(v) }, { key: 'lift', label: 'Lift', format: (v: number) => `${num(v, 3)}×` }, { key: 'support', label: 'Of all baskets', format: (v: number) => pct(v, 1) },
    ]} />
    <Section title="Most frequent items and combinations">
      <DataTable limit={10} rows={r.frequentItemsets ?? []} columns={[{ key: 'items', label: 'Items', format: (x: string[]) => x.join(' + ') }, { key: 'support', label: 'Share of baskets', format: (v: number) => pct(v, 1) }]} />
    </Section>
  </>,
};

const tsFields = [
  { key: 'date', label: 'Date column', kind: 'column' as const, filter: 'date' as const },
  { key: 'value', label: 'Value', kind: 'column' as const, filter: 'numeric' as const },
  { key: 'agg', label: 'Combine rows in a period by', kind: 'select' as const, default: 'sum', options: [{ value: 'sum', label: 'Sum' }, { value: 'mean', label: 'Average' }, { value: 'last', label: 'Last value' }, { value: 'max', label: 'Maximum' }, { value: 'min', label: 'Minimum' }] },
];

const decompose: Method = {
  id: 'decompose', cap: 'ts.decompose', title: 'Trend and seasonality',
  answers: 'Splits a series into trend, seasonal pattern and the rest, says how strong each is, and whether the series is stable over time (ADF/KPSS).',
  fields: tsFields,
  headline: r => `Trend strength ${num(r.strength?.trend, 2)}, seasonality ${num(r.strength?.seasonal, 2)} (period ${r.seasonLength}); the series ${r.stationarity?.stationary ? 'is' : 'is not'} stationary.`,
  render: r => <>
    <div className="h-64"><ResponsiveContainer>
      <LineChart data={(r.components ?? []).map((c: any) => ({ ...c, date: day(c.date) }))} margin={{ left: -5, right: 8, top: 4 }}>
        <CartesianGrid stroke="var(--separator)" vertical={false} /><XAxis dataKey="date" {...axis} minTickGap={24} /><YAxis {...axis} domain={['auto', 'auto']} /><Tooltip formatter={(v: any) => num(v, 4)} /><Legend />
        <Line dataKey="value" name="Actual" stroke="var(--label-3)" dot={false} isAnimationActive={false} />
        <Line dataKey="trend" name="Trend" stroke="var(--blue)" strokeWidth={2} dot={false} isAnimationActive={false} />
      </LineChart>
    </ResponsiveContainer></div>
    <div className="h-40"><ResponsiveContainer>
      <LineChart data={(r.components ?? []).map((c: any) => ({ ...c, date: day(c.date) }))} margin={{ left: -5, right: 8 }}>
        <CartesianGrid stroke="var(--separator)" vertical={false} /><XAxis dataKey="date" {...axis} minTickGap={24} /><YAxis {...axis} /><Tooltip formatter={(v: any) => num(v, 4)} />
        <Line dataKey="seasonal" name="Seasonal" stroke={CHART_COLORS[1]} dot={false} isAnimationActive={false} />
      </LineChart>
    </ResponsiveContainer></div>
    <StatGrid items={[['ADF p (unit root)', pValue(r.stationarity?.adf?.p)], ['KPSS p (stationary)', pValue(r.stationarity?.kpss?.p)], ['Points', r.points], ['Frequency', r.frequency]]} />
  </>,
};

const anomalies: Method = {
  id: 'anomalies', cap: 'ts.anomalies', title: 'Unusual points in time',
  answers: 'Days, weeks or months that break the usual pattern, after allowing for trend and seasonality.',
  fields: [...tsFields, { key: 'threshold', label: 'Strictness (robust z)', kind: 'number', default: 4, min: 1.5, max: 20, step: 0.5 }],
  headline: r => (r.anomalies ? `${r.anomalies} unusual point${r.anomalies === 1 ? '' : 's'} in ${r.points}: ${(r.series ?? []).filter((s: any) => s.anomaly).slice(0, 4).map((s: any) => day(s.date)).join(', ')}.` : `No unusual points in ${r.points}.`),
  tone: r => (r.anomalies ? 'warn' : 'good'),
  render: r => {
    const data = (r.series ?? []).map((s: any) => ({ ...s, date: day(s.date), band: [s.lower, s.upper], flag: s.anomaly ? s.value : null }));
    return <>
      <div className="h-64"><ResponsiveContainer>
        <ComposedChart data={data} margin={{ left: -5, right: 8, top: 4 }}>
          <CartesianGrid stroke="var(--separator)" vertical={false} /><XAxis dataKey="date" {...axis} minTickGap={24} /><YAxis {...axis} domain={['auto', 'auto']} /><Tooltip formatter={(v: any) => (Array.isArray(v) ? `${num(v[0], 4)} – ${num(v[1], 4)}` : num(v, 4))} />
          <Line dataKey="expected" name="Expected" stroke="var(--label-3)" strokeDasharray="4 4" dot={false} isAnimationActive={false} />
          <Line dataKey="value" name="Actual" stroke="var(--blue)" dot={false} isAnimationActive={false} />
          <Scatter dataKey="flag" name="Unusual" fill="var(--red)" isAnimationActive={false} />
        </ComposedChart>
      </ResponsiveContainer></div>
      <DataTable rows={(r.series ?? []).filter((s: any) => s.anomaly)} columns={[{ key: 'date', label: 'When', format: day }, { key: 'value', label: 'Actual' }, { key: 'expected', label: 'Expected' }, { key: 'score', label: 'Score' }]} />
    </>;
  },
};

const changepoints: Method = {
  id: 'changes', cap: 'ts.changepoints', title: 'When the level changed',
  answers: 'The moments a series shifted to a new level, with the average of each period and whether each shift is real.',
  fields: [...tsFields, { key: 'min_segment', label: 'Shortest period between changes', kind: 'number', default: 3, min: 2, step: 1 }],
  headline: r => (r.changePoints?.length ? `${r.changePoints.length} change${r.changePoints.length === 1 ? '' : 's'}: ${r.changePoints.slice(0, 3).map((c: any) => `${day(c.date)} (${num(c.from, 4)} → ${num(c.to, 4)})`).join(', ')}.` : 'The level didn’t change.'),
  render: r => <>
    <DataTable rows={r.changePoints ?? []} columns={[{ key: 'date', label: 'From', format: day }, { key: 'from', label: 'Before' }, { key: 'to', label: 'After' }, { key: 'p', label: 'p', format: (v: number) => <span className={sig(v) ? 'text-green' : 'text-label-2'}>{pValue(v)}</span> }]} />
    <DataTable rows={r.segments ?? []} columns={[{ key: 'start', label: 'Period from', format: day }, { key: 'end', label: 'to', format: day }, { key: 'mean', label: 'Average' }, { key: 'n', label: 'Points' }]} />
  </>,
};

const correlation: Method = {
  id: 'correlation', cap: 'stats.correlation_matrix', title: 'Correlation matrix with p-values',
  answers: 'How every pair of numbers moves together, with confidence intervals and p-values corrected for testing many pairs.',
  fields: [
    { key: 'columns', label: 'Columns (all numbers when none)', kind: 'columns', filter: 'numeric' },
    { key: 'method', label: 'Kind', kind: 'select', default: 'pearson', options: [{ value: 'pearson', label: 'Pearson (straight-line)' }, { value: 'spearman', label: 'Spearman (rank)' }, { value: 'kendall', label: 'Kendall (rank, small data)' }] },
    { key: 'partial_on', label: 'Hold constant (partial correlation)', kind: 'columns', filter: 'numeric' },
    { key: 'adjust', label: 'Correct p-values', kind: 'select', default: 'holm', options: [{ value: 'holm', label: 'Holm' }, { value: 'fdr_bh', label: 'False discovery rate (BH)' }, { value: 'bonferroni', label: 'Bonferroni' }, { value: 'none', label: 'No correction' }] },
  ],
  headline: r => {
    const s = (r.pairs ?? []).filter((p: any) => sig(p.pAdjusted ?? p.p));
    return s.length ? `${s.length} of ${r.pairs.length} pairs are related after correction; strongest ${s[0].a} & ${s[0].b} (r ${num(s[0].r, 2)}).` : `No pair is clearly related after correction (${r.pairs?.length} pairs).`;
  },
  render: r => <>
    <div className="overflow-x-auto"><table className="text-xs tabular-nums border-separate border-spacing-0.5">
      <thead><tr><th />{r.columns.map((c: string) => <th key={c} className="px-1 font-medium text-label-2 max-w-[6rem] truncate">{c}</th>)}</tr></thead>
      <tbody>{r.matrix.map((row: number[], i: number) => (
        <tr key={i}><th className="pr-2 text-left font-medium text-label-2 max-w-[8rem] truncate">{r.columns[i]}</th>
          {row.map((v, j) => <td key={j} className="w-14 h-9 text-center rounded" style={{ background: `color-mix(in srgb, var(${v >= 0 ? '--blue' : '--orange'}) ${Math.round(Math.abs(v) * 60)}%, transparent)` }}>{num(v, 2)}</td>)}
        </tr>))}</tbody>
    </table></div>
    <DataTable limit={15} rows={r.pairs ?? []} columns={[{ key: 'a', label: 'Column' }, { key: 'b', label: 'With' }, { key: 'r', label: 'r' }, { key: 'ci', label: '95% CI', format: (c: number[]) => (c ? `${num(c[0], 2)} – ${num(c[1], 2)}` : '—') }, { key: 'pAdjusted', label: 'p (corrected)', format: (v: number) => pValue(v) }]} />
  </>,
};

const normality: Method = {
  id: 'normality', cap: 'stats.normality', title: 'Is it normally distributed?',
  answers: 'Shapiro–Wilk, D’Agostino, Anderson–Darling and Jarque–Bera tests, skew and tail weight, and a Q–Q plot.',
  fields: [{ key: 'column', label: 'Column', kind: 'column', filter: 'numeric' }],
  headline: r => {
    const sw = r.tests?.find((t: any) => t.p != null);
    return `${sw && sw.p < 0.05 ? 'Not normal' : 'Consistent with normal'} (${sw?.test} p ${pValue(sw?.p)}); skew ${num(r.skewness, 2)}, excess kurtosis ${num(r.excessKurtosis, 2)}.`;
  },
  render: r => <>
    <div className="h-56"><ResponsiveContainer>
      <ScatterChart margin={{ left: -10, right: 8, top: 4 }}>
        <CartesianGrid stroke="var(--separator)" /><XAxis dataKey="theoretical" type="number" name="Expected if normal" {...axis} tickFormatter={v => num(v, 3)} /><YAxis dataKey="sample" type="number" name="Actual" {...axis} tickFormatter={v => num(v, 3)} /><ZAxis range={[14, 14]} />
        <Tooltip cursor={false} formatter={(v: any) => num(v, 4)} /><Scatter data={r.qq ?? []} fill="var(--blue)" isAnimationActive={false} />
      </ScatterChart>
    </ResponsiveContainer></div>
    <DataTable rows={r.tests ?? []} columns={[{ key: 'test', label: 'Test' }, { key: 'statistic', label: 'Statistic' }, { key: 'p', label: 'p', format: (v: number) => (v == null ? 'see critical values' : pValue(v)) }]} />
    {r.note && <Note>{r.note}</Note>}
  </>,
};

// ================================================================== text extras
const textAnalyze: Method = {
  id: 'text-overview', cap: 'text.analyze', title: 'Text overview (fast)',
  answers: 'Sentiment, keywords, topics, lengths and duplicates for a text column — fast, word-based (no transformer needed).',
  fields: [
    { key: 'column', label: 'Text column', kind: 'column', filter: 'any' },
    { key: 'group', label: 'Compare by group (optional)', kind: 'column', filter: 'categorical', optional: true },
    { key: 'topics', label: 'Topics', kind: 'number', default: 6, min: 2, max: 20, step: 1 },
    { key: 'save', label: 'Save the data with sentiment and topic columns', kind: 'toggle', default: false },
  ],
  headline: r => `${pct(r.sentiment?.positive)} positive, ${pct(r.sentiment?.negative)} negative; top words: ${(r.keywords ?? []).slice(0, 5).map((k: any) => k.term).join(', ')}.`,
  render: r => <>
    <StatGrid items={[['Rows', r.rows?.toLocaleString()], ['Average words', num(r.length?.meanWords, 3)], ['Duplicates', r.duplicates?.toLocaleString()], ['Mean sentiment', num(r.sentiment?.mean, 2)]]} />
    <DataTable rows={r.topics ?? []} columns={[{ key: 'topic', label: 'Topic' }, { key: 'words', label: 'Words', format: (w: string[]) => w.slice(0, 6).join(', ') }, { key: 'share', label: 'Share', format: (v: number) => pct(v) }, { key: 'sentiment', label: 'Sentiment' }]} />
    <div className="grid sm:grid-cols-2 gap-4">
      <Section title="Most positive">{(r.examples?.mostPositive ?? []).map((t: string, i: number) => <p key={i} className="text-sm text-label-2">“{t}”</p>)}</Section>
      <Section title="Most negative">{(r.examples?.mostNegative ?? []).map((t: string, i: number) => <p key={i} className="text-sm text-label-2">“{t}”</p>)}</Section>
    </div>
    {r.byGroup?.length > 0 && <DataTable rows={r.byGroup} columns={Object.keys(r.byGroup[0]).map(k => ({ key: k, label: k, format: show }))} />}
    {r.dataset && <UseEngineDataset dataset={r.dataset} mode="replace" summary="Added sentiment and topic columns from the engine" />}
  </>,
};

const textSimilarity: Method = {
  id: 'text-duplicates', cap: 'text.similarity', title: 'Near-duplicate texts (word overlap)',
  answers: 'Pairs of texts that say almost the same thing in almost the same words (TF-IDF cosine).',
  fields: [
    { key: 'column', label: 'Text column', kind: 'column', filter: 'any' },
    { key: 'duplicate_threshold', label: 'How similar counts as a duplicate (0–1)', kind: 'number', default: 0.8, min: 0.3, max: 1, step: 0.05 },
    { key: 'query', label: 'Or find texts like this (optional)', kind: 'text', optional: true },
  ],
  headline: r => (r.matches ? `${r.matches.length} texts closest to your query.` : `${r.count?.toLocaleString()} near-duplicate pair${r.count === 1 ? '' : 's'}.`),
  render: r => r.matches ? <DataTable limit={15} rows={r.matches} columns={Object.keys(r.matches[0] ?? {}).map(k => ({ key: k, label: k, format: (v: any) => (k.toLowerCase().includes('similar') || k === 'score' ? pct(v) : show(v)) }))} /> : <DataTable limit={15} rows={r.duplicatePairs ?? []} columns={[{ key: 'textA', label: 'Text' }, { key: 'textB', label: 'Near-duplicate' }, { key: 'similarity', label: 'Similarity', format: (v: number) => pct(v) }]} />,
};

const textEmbed: Method = {
  id: 'text-map', cap: 'text.embed', title: 'Map texts by meaning',
  answers: 'Turns each text into a meaning vector with a transformer and maps them, so texts that mean the same thing sit together.',
  fields: [
    { key: 'column', label: 'Text column', kind: 'column', filter: 'any' },
    { key: 'model', label: 'Language', kind: 'select', default: 'minilm-en', options: [{ value: 'minilm-en', label: 'English' }, { value: 'minilm-multilingual', label: '50+ languages' }] },
    { key: 'color_by', label: 'Colour by', kind: 'column', filter: 'categorical', optional: true },
    { key: 'save', label: 'Save the vectors as a dataset', kind: 'toggle', default: false },
  ],
  headline: r => `${r.rows?.toLocaleString()} texts as ${r.dimensions}-dimension meaning vectors (${r.model?.title}).`,
  render: r => <>
    <div className="h-72"><ResponsiveContainer>
      <ScatterChart margin={{ left: -20, right: 8, top: 4 }}>
        <CartesianGrid stroke="var(--separator)" /><XAxis dataKey="x" type="number" {...axis} /><YAxis dataKey="y" type="number" {...axis} /><ZAxis range={[14, 14]} />
        <Tooltip cursor={false} content={({ payload }: any) => payload?.[0] ? <div className="bg-raised rounded-lg shadow px-2 py-1 text-xs max-w-[16rem]">{payload[0].payload.text}</div> : null} />
        <Scatter data={r.map ?? []} fill="var(--blue)" fillOpacity={0.7} isAnimationActive={false} />
      </ScatterChart>
    </ResponsiveContainer></div>
    {r.dataset && <UseEngineDataset dataset={r.dataset} mode="open" label="Open the vectors in the studio" />}
    <p className="text-xs text-label-3">Model: {r.model?.title} ({r.model?.license}).</p>
  </>,
};

// ================================================================== statistics extras
const nonparametric: Method = {
  id: 'nonparametric', cap: 'stats.nonparametric', title: 'Tests without assuming normality',
  answers: 'Mann–Whitney, Wilcoxon, Kruskal–Wallis, Friedman, sign, Kolmogorov–Smirnov, Anderson–Darling, Mood’s median or a permutation test.',
  fields: [
    { key: 'test', label: 'Test', kind: 'select', default: 'mann_whitney', options: [
      { value: 'mann_whitney', label: 'Mann–Whitney (two groups)' }, { value: 'kruskal', label: 'Kruskal–Wallis (several groups)' }, { value: 'mood_median', label: 'Mood’s median (groups)' },
      { value: 'ks_2samp', label: 'Kolmogorov–Smirnov (two groups)' }, { value: 'anderson_ksamp', label: 'Anderson–Darling k-sample' }, { value: 'permutation', label: 'Permutation test (two groups)' },
      { value: 'wilcoxon', label: 'Wilcoxon signed-rank (paired columns)' }, { value: 'sign', label: 'Sign test (paired columns)' }, { value: 'friedman', label: 'Friedman (3+ paired columns)' }] },
    { key: 'columns', label: 'Value column(s) — two or more for paired tests', kind: 'columns', filter: 'numeric', min: 1 },
    { key: 'group', label: 'Group column (for group tests)', kind: 'column', filter: 'group', optional: true },
    { key: 'alternative', label: 'Direction', kind: 'select', default: 'two-sided', options: [{ value: 'two-sided', label: 'Any difference' }, { value: 'greater', label: 'First is greater' }, { value: 'less', label: 'First is smaller' }] },
  ],
  headline: r => `${r.test}: ${sig(r.p) ? 'a real difference' : 'no clear difference'} (p ${pValue(r.p)}).`,
  tone: r => (sig(r.p) ? 'good' : 'plain'),
  render: r => <StatGrid items={[['Test', r.test], ['Statistic', num(r.statistic, 4)], ['p', pValue(r.p)], ['Compared', (r.groups ?? r.columns ?? []).join(' vs ')]]} />,
};

const multipleTesting: Method = {
  id: 'multiple', cap: 'stats.multiple_testing', title: 'Correct p-values for many tests',
  answers: 'When you ran many tests, which results survive: Bonferroni, Holm, Hochberg, Šidák, Hommel or false-discovery-rate corrections.',
  fields: [
    { key: 'p_values', label: 'p-values (comma-separated)', kind: 'text', placeholder: 'e.g. 0.01, 0.04, 0.2' },
    { key: 'labels', label: 'Names (optional, same order)', kind: 'text', optional: true, placeholder: 'e.g. price, age, region' },
    { key: 'method', label: 'Correction', kind: 'select', default: 'holm', options: [{ value: 'holm', label: 'Holm' }, { value: 'fdr_bh', label: 'False discovery rate (BH)' }, { value: 'fdr_by', label: 'FDR (BY, any dependence)' }, { value: 'bonferroni', label: 'Bonferroni' }, { value: 'hochberg', label: 'Hochberg' }, { value: 'sidak', label: 'Šidák' }, { value: 'hommel', label: 'Hommel' }] },
    { key: 'alpha', label: 'Significance level', kind: 'number', default: 0.05, min: 0.001, max: 0.5, step: 0.01 },
  ],
  check: v => checkNumbers(2, 'p-values', [0, 1])(String(v.p_values ?? '')),
  params: v => ({ ...v, p_values: parseNumbers(v.p_values), labels: v.labels ? String(v.labels).split(',').map((s: string) => s.trim()) : undefined }),
  headline: r => `${r.rejected} of ${r.results?.length} results stay significant after ${r.method} correction.`,
  render: r => <DataTable rows={r.results ?? []} columns={[{ key: 'label', label: 'Test' }, { key: 'p', label: 'p', format: (v: number) => pValue(v) }, { key: 'pAdjusted', label: 'Corrected p', format: (v: number) => pValue(v) }, { key: 'significant', label: '', format: (b: boolean) => <span className={b ? 'text-green' : 'text-label-3'}>{b ? 'significant' : 'not'}</span> }]} />,
};

const srm: Method = {
  id: 'srm', cap: 'exp.srm', title: 'Was traffic split as planned? (SRM)',
  answers: 'Checks whether users were split between variants as intended; a mismatch usually means broken assignment or logging, and the test result can’t be trusted.',
  fields: [
    { key: 'observed', label: 'Users per variant (comma-separated)', kind: 'text', placeholder: 'e.g. 5000, 4800' },
    { key: 'expected_share', label: 'Planned shares (optional, e.g. 0.5, 0.5)', kind: 'text', optional: true },
  ],
  check: v => checkNumbers(2, 'counts')(String(v.observed ?? '')),
  params: v => ({ observed: parseNumbers(v.observed), ...(v.expected_share ? { expected_share: parseNumbers(v.expected_share) } : {}) }),
  // SRM checks use a strict threshold (p < 0.001): with big samples small, harmless imbalances would otherwise alarm.
  headline: r => (r.mismatch ? `Mismatch: the split isn’t what was planned (p ${pValue(r.p)}) — check assignment before trusting the test.` : `No sample-ratio mismatch (p ${pValue(r.p)}; SRM is flagged only below p 0.001).`),
  tone: r => (r.mismatch ? 'warn' : 'good'),
  render: r => <DataTable rows={(r.observed ?? []).map((o: number, i: number) => ({ v: String.fromCharCode(65 + i), o, e: r.expected?.[i] }))} columns={[{ key: 'v', label: 'Variant' }, { key: 'o', label: 'Users' }, { key: 'e', label: 'Expected' }]} />,
};

// ================================================================== model checks
const featureSelection: Method = {
  id: 'features', cap: 'ml.feature_selection', title: 'Which columns help predict?',
  answers: 'Ranks columns by mutual information, univariate tests and forest importance, tests each against shuffled copies of itself (Boruta), and flags redundant pairs.',
  fields: [
    { key: 'target', label: 'Predict', kind: 'column', filter: 'any' },
    { key: 'features', label: 'Candidate columns (all others when none)', kind: 'columns', filter: 'any' },
    { key: 'shadow_rounds', label: 'Shuffled-copy rounds (more = surer)', kind: 'number', default: 10, min: 1, max: 50, step: 1 },
  ],
  headline: r => (r.recommended?.length ? `Keep ${r.recommended.length}: ${r.recommended.join(', ')}.` : 'No column clearly beats its shuffled copy — there may be little signal, or too few rows.'),
  tone: r => (r.recommended?.length ? 'good' : 'warn'),
  render: r => <>
    <DataTable rows={r.features ?? []} columns={[
      { key: 'feature', label: 'Column' }, { key: 'confirmed', label: '', format: (b: boolean) => <span className={b ? 'text-green' : 'text-label-3'}>{b ? 'helps' : 'unclear'}</span> },
      { key: 'beatsShadowShare', label: 'Beats shuffled copy', format: (v: number) => pct(v) }, { key: 'forestImportance', label: 'Forest importance' }, { key: 'mutualInformation', label: 'Mutual information' }, { key: 'fP', label: 'Test p', format: (v: number) => pValue(v) },
    ]} />
    {r.redundantPairs?.length > 0 && <Note tone="warn">Redundant pairs (nearly the same information): {r.redundantPairs.map((p: any) => `${p.a} & ${p.b}`).join('; ')}.</Note>}
  </>,
};

const fairness: Method = {
  id: 'fairness', cap: 'ml.fairness', title: 'Fairness audit of a model',
  answers: 'Whether a saved model treats groups (gender, age band, region…) alike: accuracy, how often each is flagged, catch and false-alarm rates, and the four-fifths rule.',
  fields: [
    { key: 'model_id', label: 'Model', kind: 'custom', initial: () => '', editor: ModelSelectEditor, check: (v: string) => (v ? null : 'Train or choose a saved model first.') },
    { key: 'target', label: 'True outcome column', kind: 'column', filter: 'any' },
    { key: 'sensitive_features', label: 'Groups to compare', kind: 'columns', filter: 'categorical', min: 1 },
  ],
  headline: r => {
    const s = r.fairness?.[0]?.summary;
    return s?.disparateImpactRatio != null ? `Across ${r.fairness[0].feature}: flag-rate ratio ${num(s.disparateImpactRatio, 2)} — ${s.passesFourFifthsRule ? 'within' : 'below'} the four-fifths rule.` : `Fairness checked across ${(r.fairness ?? []).map((f: any) => f.feature).join(', ')}.`;
  },
  tone: r => (r.fairness?.some((f: any) => f.summary?.passesFourFifthsRule === false) ? 'warn' : 'good'),
  render: r => <>{(r.fairness ?? []).map((f: any) => (
    <Section key={f.feature} title={`Across ${f.feature}`}>
      <DataTable rows={f.groups} columns={Object.keys(f.groups[0] ?? {}).map(k => ({ key: k, label: k === 'selectionRate' ? 'Flagged' : k === 'tpr' ? 'Caught' : k === 'fpr' ? 'False alarms' : k, format: (v: any) => (typeof v === 'number' && k !== 'n' && v <= 1 ? pct(v, 1) : show(v)) }))} />
    </Section>
  ))}</>,
};

// ================================================================== import (connectors)
const imported = (r: any) => <>
  {r.dataset && <>
    <StatGrid items={[['Rows', r.dataset.rows?.toLocaleString()], ['Columns', r.dataset.columns?.length], ['Size', `${num((r.dataset.bytes ?? 0) / 1e6, 3)} MB`], ['Saved as', r.dataset.name]]} />
    <UseEngineDataset dataset={r.dataset} mode="open" agent="import-open" />
  </>}
</>;
const importedHeadline = (r: any) => `Imported ${r.dataset?.rows?.toLocaleString()} rows × ${r.dataset?.columns?.length} columns into the engine as “${r.dataset?.name}”.`;

const fromUrl: Method = {
  id: 'from-url', cap: 'connect.url', title: 'From a web address',
  answers: 'A CSV, TSV, JSON, Parquet or Excel file at a public https address.',
  fields: [
    { key: 'url', label: 'Address (https://…)', kind: 'text', placeholder: 'https://example.com/data.csv' },
    { key: 'format', label: 'Format', kind: 'select', default: 'auto', options: ['auto', 'csv', 'tsv', 'json', 'parquet', 'xlsx'].map(v => ({ value: v, label: v === 'auto' ? 'Detect' : v.toUpperCase() })) },
    { key: 'name', label: 'Name it (optional)', kind: 'text', optional: true },
  ],
  headline: importedHeadline, tone: () => 'good', render: imported,
};

const fromSql: Method = {
  id: 'from-sql', cap: 'connect.sql', title: 'From a database',
  answers: 'A read-only SELECT on PostgreSQL or MySQL, streamed into the engine. The password is used once and never saved.',
  fields: [
    { key: 'engine', label: 'Database', kind: 'select', default: 'postgresql', options: [{ value: 'postgresql', label: 'PostgreSQL' }, { value: 'mysql', label: 'MySQL' }] },
    { key: 'host', label: 'Host', kind: 'text', placeholder: 'db.example.com' },
    { key: 'port', label: 'Port (optional)', kind: 'number', optional: true, step: 1 },
    { key: 'database', label: 'Database name', kind: 'text' },
    { key: 'user', label: 'User', kind: 'text' },
    { key: 'password', label: 'Password', kind: 'text', optional: true, secret: true },
    { key: 'query', label: 'Query (SELECT only)', kind: 'text', multiline: true, placeholder: 'SELECT * FROM orders WHERE created_at > now() - interval \'90 days\'' },
    { key: 'ssl', label: 'Use SSL', kind: 'toggle', default: true },
    { key: 'max_rows', label: 'Most rows', kind: 'number', default: 1000000, min: 1, step: 1 },
  ],
  headline: importedHeadline, tone: () => 'good', render: imported,
};

const fromBigQuery: Method = {
  id: 'from-bigquery', cap: 'connect.bigquery', title: 'From BigQuery',
  answers: 'A SELECT in BigQuery — billions of rows can be summarised there first — streamed into the engine.',
  fields: [
    { key: 'query', label: 'Query', kind: 'text', multiline: true, placeholder: 'SELECT country, COUNT(*) AS orders FROM `project.dataset.orders` GROUP BY country' },
    { key: 'project', label: 'Billing project (optional)', kind: 'text', optional: true },
    { key: 'max_rows', label: 'Most rows', kind: 'number', default: 1000000, min: 1, step: 1 },
  ],
  headline: importedHeadline, tone: () => 'good', render: imported,
};

const fromGcs: Method = {
  id: 'from-gcs', cap: 'connect.gcs', title: 'From Cloud Storage',
  answers: 'A CSV, JSON, Parquet or Excel file in a Google Cloud Storage bucket the engine can read.',
  fields: [{ key: 'uri', label: 'Location (gs://bucket/path)', kind: 'text', placeholder: 'gs://my-bucket/exports/orders.parquet' }, { key: 'name', label: 'Name it (optional)', kind: 'text', optional: true }],
  headline: importedHeadline, tone: () => 'good', render: imported,
};

export const DATA_METHODS: Method[] = [
  profile, validate, outliers, piiScan, piiMask, recipe, estimate,
  cluster, embed, basket, decompose, anomalies, changepoints, correlation, normality,
  textAnalyze, textSimilarity, textEmbed,
  nonparametric, multipleTesting, srm,
  featureSelection, fairness,
  fromUrl, fromSql, fromBigQuery, fromGcs,
];
