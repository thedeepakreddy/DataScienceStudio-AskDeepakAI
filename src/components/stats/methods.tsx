/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React from 'react';
import { Bar, BarChart, CartesianGrid, Legend, Line, LineChart, ReferenceLine, ResponsiveContainer, Scatter, ScatterChart, Tooltip, XAxis, YAxis } from 'recharts';
import { CHART_COLORS, CHART_CURSOR } from '../../utils/chartTheme';
import { DataTable, EffectTable, Note, Section, StatGrid, ciText, num, pValue, pct, sig, signed, type GuideStep, type Method } from './methodKit';
import { MODEL_METHODS } from '../model/modelMethods';

const axis = { tick: { fontSize: 11, fill: 'var(--label-2)' } };
const nonIntercept = (rows: any[] = []) => rows.filter(r => !/intercept/i.test(r.term));
const strongest = (rows: any[]) => [...nonIntercept(rows)].filter(r => sig(r.p)).sort((a, b) => Math.abs(b.statistic ?? b.z ?? 0) - Math.abs(a.statistic ?? a.z ?? 0))[0];

// ================================================================== relationships
const glm: Method = {
  id: 'glm', cap: 'stats.glm', title: 'Regression for any outcome (GLM)',
  answers: 'Which factors move an outcome, and by how much — for amounts, yes/no outcomes, counts or skewed values.',
  fields: [
    { key: 'outcome', label: 'Outcome', kind: 'column', filter: 'any' },
    { key: 'predictors', label: 'Explained by', kind: 'columns', filter: 'any', min: 1 },
    { key: 'family', label: 'Kind of outcome', kind: 'select', default: 'gaussian', options: [
      { value: 'gaussian', label: 'An amount (normal)' }, { value: 'binomial', label: 'Yes / no (logistic)' }, { value: 'poisson', label: 'A count (Poisson)' },
      { value: 'negative_binomial', label: 'A count with extra spread' }, { value: 'gamma', label: 'Positive, skewed (gamma)' }] },
    { key: 'robust', label: 'Standard errors', kind: 'select', default: 'none', options: [{ value: 'none', label: 'Standard' }, { value: 'hc3', label: 'Robust (HC3)' }] },
  ],
  headline: (r, v) => {
    const top = strongest(r.coefficients);
    if (!top) return `None of the factors has a clear effect on ${v.outcome} (all p ≥ 0.05).`;
    if (r.expMeaning && top.expEstimate) return `${top.term} has the clearest effect: it multiplies the ${r.expMeaning === 'odds ratio' ? 'odds' : 'rate'} of ${v.outcome} by ${num(top.expEstimate)} (${ciText(top.expCi)}).`;
    return `${top.term} has the clearest effect on ${v.outcome}: ${signed(top.estimate)} per unit (${ciText(top.ci)}, p ${pValue(top.p)}).`;
  },
  tone: r => strongest(r.coefficients) ? 'good' : 'plain',
  render: r => {
    const exp = !!r.expMeaning;
    const highVif = (r.vif ?? []).filter((x: any) => x.vif > 5);
    return <>
      <StatGrid items={[['Rows', r.n?.toLocaleString()], [r.diagnostics?.r2 != null ? 'R²' : 'Pseudo R²', num(r.diagnostics?.r2 ?? r.fit?.pseudoR2McFadden)], ['AIC', num(r.fit?.aic, 4)], ['Model', `${r.family} · ${r.link}`]]} />
      <Section title={exp ? `Effects as ${r.expMeaning}s (1 = no effect)` : 'Effects'}>
        <EffectTable valueLabel={exp ? (r.expMeaning === 'odds ratio' ? 'Odds ratio' : 'Rate ratio') : 'Estimate'} zero={exp ? 1 : 0} log={exp}
          rows={nonIntercept(r.coefficients).map((c: any) => ({ term: c.term, value: exp ? c.expEstimate : c.estimate, ci: exp ? c.expCi : c.ci, p: c.p }))} />
      </Section>
      {highVif.length > 0 && <Note tone="warn">Strongly overlapping factors ({highVif.map((x: any) => x.term).join(', ')}, VIF &gt; 5): their separate effects are uncertain.</Note>}
      {r.diagnostics?.breuschPagan?.p < 0.05 && r.robust === 'none' && <Note tone="warn">The spread of errors isn’t constant (Breusch–Pagan p {pValue(r.diagnostics.breuschPagan.p)}). Robust standard errors are safer.</Note>}
    </>;
  },
};

const anova: Method = {
  id: 'anova', cap: 'stats.anova', title: 'ANOVA (differences between groups)',
  answers: 'Does an amount differ between groups — across one or two grouping columns, with post-hoc pairs.',
  fields: [
    { key: 'outcome', label: 'Amount', kind: 'column', filter: 'numeric' },
    { key: 'factors', label: 'Groups', kind: 'columns', filter: 'categorical', min: 1, max: 3 },
  ],
  headline: (r, v) => {
    const rows = (r.table ?? []).filter((t: any) => !/resid/i.test(t.term) && t.p != null);
    const s = rows.filter((t: any) => sig(t.p)).sort((a: any, b: any) => b.partialEtaSquared - a.partialEtaSquared)[0];
    if (!s) return `No clear difference in average ${v.outcome} between groups (p ${pValue(rows[0]?.p)}).`;
    return `${v.outcome} differs by ${s.term}: it explains ${pct(s.partialEtaSquared)} of the variation (F ${num(s.F)}, p ${pValue(s.p)}).`;
  },
  tone: r => (r.table ?? []).some((t: any) => sig(t.p)) ? 'good' : 'plain',
  render: r => <>
    <DataTable rows={r.table} columns={[{ key: 'term', label: 'Source' }, { key: 'df', label: 'df' }, { key: 'F', label: 'F' }, { key: 'p', label: 'p', format: pValue }, { key: 'partialEtaSquared', label: 'Partial η²' }]} />
    <Section title="Group averages"><DataTable rows={r.cellMeans} columns={[{ key: 'cell', label: 'Group' }, { key: 'mean', label: 'Mean' }, { key: 'sd', label: 'SD' }, { key: 'n', label: 'Rows' }]} /></Section>
    {Object.entries(r.posthoc ?? {}).map(([f, pairs]: [string, any]) => (
      <Section key={f} title={`Which ${f} groups differ (Tukey HSD)`}>
        <DataTable rows={pairs} columns={[{ key: 'a', label: 'Group' }, { key: 'b', label: 'vs' }, { key: 'meanDifference', label: 'Difference' }, { key: 'pAdjusted', label: 'Adjusted p', format: pValue }, { key: 'significant', label: '', format: s => s ? <span className="text-green">different</span> : '' }]} />
      </Section>
    ))}
    {r.assumptions?.levene?.p < 0.05 && <Note tone="warn">Groups have unequal spreads (Levene p {pValue(r.assumptions.levene.p)}); treat p-values near 0.05 with care.</Note>}
  </>,
};

const mixed: Method = {
  id: 'mixed', cap: 'stats.mixed', title: 'Repeated or grouped data (mixed model)',
  answers: 'Effects when rows come in groups (the same customer over time, pupils within schools), without overstating certainty.',
  fields: [
    { key: 'outcome', label: 'Outcome', kind: 'column', filter: 'numeric' },
    { key: 'predictors', label: 'Explained by', kind: 'columns', filter: 'any' },
    { key: 'group', label: 'Rows are grouped by', kind: 'column', filter: 'group' },
  ],
  headline: (r, v) => `${pct(r.icc)} of the variation in ${v.outcome} is between ${v.group} groups${strongest(r.fixedEffects) ? `; ${strongest(r.fixedEffects).term} has a clear effect (${signed(strongest(r.fixedEffects).estimate)})` : ''}.`,
  render: r => <>
    <StatGrid items={[['Rows', r.n?.toLocaleString()], ['Groups', r.groups], ['Between-group share (ICC)', pct(r.icc)], ['Converged', r.fit?.converged ? 'Yes' : 'No']]} />
    <Section title="Effects"><EffectTable rows={nonIntercept(r.fixedEffects).map((c: any) => ({ term: c.term, value: c.estimate, ci: c.ci, p: c.p }))} /></Section>
  </>,
};

const robust: Method = {
  id: 'robust', cap: 'stats.robust_regression', title: 'Regression that resists outliers',
  answers: 'Effects that a few extreme rows can’t distort, compared side by side with ordinary least squares.',
  fields: [
    { key: 'outcome', label: 'Outcome', kind: 'column', filter: 'numeric' },
    { key: 'predictors', label: 'Explained by', kind: 'columns', filter: 'any', min: 1 },
    { key: 'method', label: 'Method', kind: 'select', default: 'huber', options: [{ value: 'huber', label: 'Huber (mild down-weighting)' }, { value: 'tukey_biweight', label: 'Tukey biweight (strong)' }, { value: 'quantile', label: 'Median regression' }] },
  ],
  headline: r => {
    const t = nonIntercept(r.coefficients)[0], o = nonIntercept(r.ols ?? []).find((x: any) => x.term === t?.term);
    return t ? `${t.term}: ${signed(t.estimate)} resisting outliers vs ${signed(o?.estimate ?? NaN)} by ordinary least squares${r.downweightedRows ? `; ${r.downweightedRows} rows were down-weighted` : ''}.` : 'Fitted.';
  },
  render: r => <>
    <EffectTable rows={nonIntercept(r.coefficients).map((c: any) => ({ term: c.term, value: c.estimate, ci: c.ci, p: c.p }))} />
    {r.ols && <Section title="Compared with ordinary least squares">
      <DataTable rows={nonIntercept(r.coefficients).map((c: any) => ({ term: c.term, robust: c.estimate, ols: r.ols.find((o: any) => o.term === c.term)?.estimate }))}
        columns={[{ key: 'term', label: 'Term' }, { key: 'robust', label: 'Robust' }, { key: 'ols', label: 'OLS' }]} />
    </Section>}
  </>,
};

// ================================================================== compare
const bootstrap: Method = {
  id: 'bootstrap', cap: 'stats.bootstrap', title: 'Confidence interval for any statistic (bootstrap)',
  answers: 'How precise is a median, a percentile or a ratio — without assuming a bell curve.',
  fields: [
    { key: 'column', label: 'Column', kind: 'column', filter: 'numeric' },
    { key: 'statistic', label: 'Statistic', kind: 'select', default: 'median', options: [
      { value: 'mean', label: 'Mean' }, { value: 'median', label: 'Median' }, { value: 'std', label: 'Standard deviation' }, { value: 'quantile', label: '90th percentile' }, { value: 'trimmed_mean', label: 'Trimmed mean' }] },
  ],
  params: v => ({ ...v, quantile: v.statistic === 'quantile' ? 0.9 : 0.5 }),
  headline: (r, v) => `The ${v.statistic === 'quantile' ? '90th percentile' : v.statistic.replace('_', ' ')} of ${v.column} is ${num(r.estimate, 4)} (${Math.round(r.confidence * 100)}% CI ${num(r.ci[0], 4)} to ${num(r.ci[1], 4)}).`,
  render: r => {
    const [lo, hi] = r.distributionRange ?? [0, 1];
    const w = (hi - lo) / (r.distribution?.length || 1);
    const data = (r.distribution ?? []).map((c: number, i: number) => ({ x: num(lo + (i + 0.5) * w, 3), c }));
    return <>
      <StatGrid items={[['Estimate', num(r.estimate, 4)], ['Standard error', num(r.standardError)], ['Method', r.method], ['Resamples', r.resamples?.toLocaleString()]]} />
      <div className="h-40"><ResponsiveContainer><BarChart data={data} margin={{ left: -20, right: 4 }}><XAxis dataKey="x" {...axis} interval="preserveStartEnd" /><YAxis {...axis} /><Tooltip cursor={CHART_CURSOR} /><Bar dataKey="c" name="resamples" fill="var(--blue)" /></BarChart></ResponsiveContainer></div>
      <p className="text-xs text-label-3 -mt-3">How the statistic varied across {r.resamples?.toLocaleString()} resamples of the data.</p>
    </>;
  },
};

// ================================================================== causal
const causalNote = (r: any) => r.assumption ? <Note>Holds if: {r.assumption}</Note> : null;

const propensity: Method = {
  id: 'propensity', cap: 'causal.propensity', title: 'Effect of a treatment (observational data)',
  answers: 'What did a treatment, campaign or feature cause, when it wasn’t randomly assigned — adjusting for differences between the groups.',
  fields: [
    { key: 'treatment', label: 'Treatment (yes/no)', kind: 'column', filter: 'binary' },
    { key: 'outcome', label: 'Outcome', kind: 'column', filter: 'numeric' },
    { key: 'covariates', label: 'Adjust for (things that differ between groups)', kind: 'columns', filter: 'any', min: 1 },
    { key: 'method', label: 'Method', kind: 'select', default: 'aipw', options: [{ value: 'aipw', label: 'Doubly robust (AIPW) — recommended' }, { value: 'ipw', label: 'Inverse probability weighting' }, { value: 'matching', label: 'Matching' }] },
  ],
  headline: (r, v) => `${v.treatment} ${r.ci[0] > 0 ? 'raises' : r.ci[1] < 0 ? 'lowers' : 'has no clear effect on'} ${v.outcome}: ${signed(r.effect)} on average (${ciText(r.ci)}).`,
  tone: r => (r.ci[0] > 0 || r.ci[1] < 0) ? 'good' : 'plain',
  render: r => {
    const bad = (r.balance ?? []).filter((b: any) => Math.abs(b.after) > 0.1);
    return <>
      <StatGrid items={[['Effect', signed(r.effect)], ['Treated / control', `${r.treated} / ${r.control}`], ['Method', `${r.method?.toUpperCase()} · ${r.estimand}`], ['Effect in SDs', num(r.standardisedEffect)]]} />
      <Section title="Were the groups made comparable? (standardised differences; under 0.1 is good)">
        <DataTable rows={r.balance} columns={[{ key: 'covariate', label: 'Factor' }, { key: 'before', label: 'Before' }, { key: 'after', label: 'After', format: v => <span className={Math.abs(v) > 0.1 ? 'text-orange' : 'text-green'}>{num(v)}</span> }]} />
      </Section>
      {bad.length > 0 && <Note tone="warn">Still unbalanced after adjustment: {bad.map((b: any) => b.covariate).join(', ')}. Treat the estimate with care.</Note>}
      <Note>Assumes every factor that drove both treatment and outcome is in the adjustment list. Factors you couldn’t measure can still bias it.</Note>
    </>;
  },
};

const did: Method = {
  id: 'did', cap: 'causal.did', title: 'Before/after with a comparison group (difference-in-differences)',
  answers: 'The effect of a change that hit some units at a point in time, compared with units it didn’t hit.',
  fields: [
    { key: 'outcome', label: 'Outcome', kind: 'column', filter: 'numeric' },
    { key: 'treated', label: 'Affected group (yes/no)', kind: 'column', filter: 'binary' },
    { key: 'post', label: 'After the change (yes/no)', kind: 'column', filter: 'binary' },
    { key: 'unit', label: 'Unit id (optional, for clustered errors)', kind: 'column', filter: 'group', optional: true },
  ],
  headline: (r, v) => `The change ${sig(r.p) ? (r.effect > 0 ? 'raised' : 'lowered') : 'had no clear effect on'} ${v.outcome}${sig(r.p) ? ` by ${num(Math.abs(r.effect))}` : ''} (${ciText(r.ci)}, p ${pValue(r.p)}).`,
  tone: r => sig(r.p) ? 'good' : 'plain',
  render: r => <>
    <StatGrid items={[['Effect', signed(r.effect)], ['p', pValue(r.p)], ['Rows', r.n?.toLocaleString()], ['Errors', r.standardErrors]]} />
    <Section title="Group averages">
      <DataTable rows={r.groupMeans} columns={[{ key: 'treated', label: 'Group', format: v => v ? 'Affected' : 'Comparison' }, { key: 'post', label: 'Period', format: v => v ? 'After' : 'Before' }, { key: 'mean', label: 'Average' }]} />
    </Section>
    {causalNote(r)}
  </>,
};

const synth: Method = {
  id: 'synth', cap: 'causal.synthetic_control', title: 'One treated unit (synthetic control)',
  answers: 'The effect on a single region, store or country, using a weighted blend of similar units as its “what if”.',
  fields: [
    { key: 'unit', label: 'Unit column', kind: 'column', filter: 'group' },
    { key: 'time', label: 'Time column', kind: 'column', filter: 'date' },
    { key: 'outcome', label: 'Outcome', kind: 'column', filter: 'numeric' },
    { key: 'treated_unit', label: 'The treated unit (exact value)', kind: 'text', placeholder: 'e.g. London' },
    { key: 'start', label: 'First treated period (exact value)', kind: 'text', placeholder: 'e.g. 2024-03 or 12' },
  ],
  params: v => ({ ...v, start: v.start !== '' && !Number.isNaN(Number(v.start)) ? Number(v.start) : v.start }),
  headline: (r, v) => `After the change, ${v.treated_unit} was ${num(Math.abs(r.effect ?? r.averageEffect ?? 0))} ${(r.effect ?? r.averageEffect ?? 0) >= 0 ? 'above' : 'below'} its synthetic twin on average${r.placeboP != null ? ` (placebo p ${pValue(r.placeboP)})` : ''}.`,
  render: r => <>
    {r.weights && <Section title="Synthetic twin made of"><DataTable rows={r.weights} columns={[{ key: 'unit', label: 'Unit' }, { key: 'weight', label: 'Weight', format: pct }]} limit={8} /></Section>}
    {causalNote(r)}
    {r.series && <div className="h-56"><ResponsiveContainer><LineChart data={r.series} margin={{ left: -10, right: 8 }}><CartesianGrid stroke="var(--separator)" vertical={false} /><XAxis dataKey="time" {...axis} /><YAxis {...axis} /><Tooltip /><Line dataKey="actual" stroke="var(--blue)" dot={false} name="Actual" /><Line dataKey="synthetic" stroke="var(--label-3)" strokeDasharray="4 3" dot={false} name="Synthetic" /></LineChart></ResponsiveContainer></div>}
  </>,
};

const iv: Method = {
  id: 'iv', cap: 'causal.iv', title: 'Instrumental variables (2SLS)',
  answers: 'An effect estimate when there is a variable that shifts the treatment but affects the outcome only through it.',
  fields: [
    { key: 'outcome', label: 'Outcome', kind: 'column', filter: 'numeric' },
    { key: 'treatment', label: 'Treatment', kind: 'column', filter: 'numeric' },
    { key: 'instruments', label: 'Instrument(s)', kind: 'columns', filter: 'any', min: 1 },
  ],
  headline: (r, v) => r.weakInstruments ? `The instrument is too weak to estimate the effect reliably (first-stage F ${num(r.firstStageF)} < 10).` : `${v.treatment} changes ${v.outcome} by ${signed(r.effect)} per unit (${ciText(r.ci)}, p ${pValue(r.p)}).`,
  tone: r => r.weakInstruments ? 'warn' : sig(r.p) ? 'good' : 'plain',
  render: r => <>
    <StatGrid items={[['IV effect', signed(r.effect)], ['Plain regression', signed(r.olsEffect)], ['First-stage F', num(r.firstStageF)], ['Endogeneity test p', pValue(r.wuHausman?.p)]]} />
    {causalNote(r)}
  </>,
};

const rdd: Method = {
  id: 'rdd', cap: 'causal.rdd', title: 'Cut-off rule (regression discontinuity)',
  answers: 'The effect of a rule that applies above a threshold — a score, an age, a spend level — by comparing those just either side.',
  fields: [
    { key: 'outcome', label: 'Outcome', kind: 'column', filter: 'numeric' },
    { key: 'running', label: 'Score the rule uses', kind: 'column', filter: 'numeric' },
    { key: 'cutoff', label: 'Cut-off value', kind: 'number', default: 0, step: 0.1 },
  ],
  headline: (r, v) => `At the cut-off, ${v.outcome} jumps by ${signed(r.jump.estimate)} (${ciText(r.jump.ci)}, p ${pValue(r.jump.p)}).`,
  tone: r => sig(r.jump?.p) ? 'good' : 'plain',
  render: (r, v) => <>
    <div className="h-56"><ResponsiveContainer><ScatterChart margin={{ left: -10, right: 8 }}><CartesianGrid stroke="var(--separator)" /><XAxis dataKey="x" type="number" domain={['dataMin', 'dataMax']} {...axis} /><YAxis dataKey="y" type="number" domain={['auto', 'auto']} {...axis} /><Tooltip cursor={false} /><ReferenceLine x={v.cutoff} stroke="var(--orange)" strokeDasharray="4 3" /><Scatter data={r.binnedMeans} fill="var(--blue)" /></ScatterChart></ResponsiveContainer></div>
    <Section title="Does the answer depend on the window?"><DataTable rows={r.robustness} columns={[{ key: 'bandwidth', label: 'Window' }, { key: 'estimate', label: 'Jump' }, { key: 'p', label: 'p', format: pValue }, { key: 'n', label: 'Rows' }]} /></Section>
    {r.density?.p < 0.05 && <Note tone="warn">More rows sit on one side of the cut-off than expected (p {pValue(r.density.p)}): people may be gaming the score.</Note>}
    {causalNote(r)}
  </>,
};

const uplift: Method = {
  id: 'uplift', cap: 'causal.uplift', title: 'Who responds best (uplift)',
  answers: 'Which customers a treatment helps most, so you target the ones it changes rather than everyone.',
  fields: [
    { key: 'treatment', label: 'Treatment (yes/no)', kind: 'column', filter: 'binary' },
    { key: 'outcome', label: 'Outcome', kind: 'column', filter: 'numeric' },
    { key: 'features', label: 'Customer features', kind: 'columns', filter: 'any', min: 1 },
  ],
  headline: r => {
    const d = r.deciles ?? [];
    return `Targeting the top 10% by predicted uplift gives ${signed(d[0]?.observedUplift ?? NaN)} vs ${signed(d[d.length - 1]?.observedUplift ?? NaN)} for the bottom 10% (average ${signed(r.averageUplift)}).`;
  },
  render: r => <>
    <div className="h-52"><ResponsiveContainer><BarChart data={r.deciles} margin={{ left: -15, right: 4 }}><CartesianGrid stroke="var(--separator)" vertical={false} /><XAxis dataKey="decile" {...axis} /><YAxis {...axis} /><Tooltip cursor={CHART_CURSOR} formatter={(x: number) => num(x)} /><ReferenceLine y={0} stroke="var(--label-3)" /><Bar dataKey="observedUplift" name="Observed uplift" fill="var(--blue)" radius={[3, 3, 0, 0]} /></BarChart></ResponsiveContainer></div>
    <p className="text-xs text-label-3 -mt-3">Held-out customers in ten groups, from most to least predicted to respond (decile 1 = most).</p>
    <StatGrid items={[['Average uplift', signed(r.averageUplift)], ['Qini coefficient', num(r.qiniCoefficient)], ['Test rows', r.testRows], ['Learner', 'T-learner']]} />
    {causalNote(r)}
  </>,
};

// ================================================================== experiments
const abTest: Method = {
  id: 'ab', cap: 'exp.ab_test', title: 'Analyse an A/B test',
  answers: 'Did a variant beat control — with a sample-ratio check, multiple-variant correction, and CUPED variance reduction if you have a pre-period metric.',
  fields: [
    { key: 'variant', label: 'Variant column', kind: 'column', filter: 'categorical' },
    { key: 'metric', label: 'Metric (conversion 0/1 or an amount)', kind: 'column', filter: 'numeric' },
    { key: 'control', label: 'Control group name (optional)', kind: 'text', optional: true, placeholder: 'e.g. A' },
    { key: 'covariate', label: 'Pre-period metric for CUPED (optional)', kind: 'column', filter: 'numeric', optional: true },
  ],
  headline: r => {
    const v = (r.variants ?? []).filter((x: any) => x.p != null).sort((a: any, b: any) => (b.relativeLift ?? 0) - (a.relativeLift ?? 0))[0];
    if (r.sampleRatio?.mismatch) return `Don’t trust this test yet: the traffic split is off (sample-ratio mismatch, p ${pValue(r.sampleRatio.p)}).`;
    if (!v) return 'Analysed.';
    return v.significant ? `${v.variant} beats ${r.control}: ${signed(v.relativeLift * 100, 3)}% (${pct(v.relativeCi?.[0], 1)} to ${pct(v.relativeCi?.[1], 1)}), p ${pValue(v.p)}.`
      : `No variant clearly beats ${r.control}: best is ${v.variant} at ${signed(v.relativeLift * 100, 3)}% (p ${pValue(v.p)}).`;
  },
  tone: r => r.sampleRatio?.mismatch ? 'warn' : (r.variants ?? []).some((x: any) => x.significant) ? 'good' : 'plain',
  render: r => <>
    <DataTable rows={r.variants} columns={[{ key: 'variant', label: 'Variant' }, { key: 'n', label: 'Users' }, { key: 'mean', label: r.kind === 'conversion' ? 'Rate' : 'Mean', format: x => r.kind === 'conversion' ? pct(x, 2) : num(x) },
      { key: 'relativeLift', label: 'Lift', format: x => x == null ? 'control' : `${signed(x * 100, 3)}%` }, { key: 'p', label: 'p', format: x => x == null ? '' : pValue(x) }, { key: 'test', label: 'Test', format: x => x ?? '' }]} />
    {r.cuped && <Note>CUPED used the pre-period metric to cut variance by {pct(r.cuped.varianceReduction)}.</Note>}
    <Note tone={r.sampleRatio?.mismatch ? 'warn' : 'plain'}>Traffic split: {r.sampleRatio?.observed?.join(' / ')} observed vs {r.sampleRatio?.expected?.map((x: number) => Math.round(x)).join(' / ')} expected (p {pValue(r.sampleRatio?.p)}).</Note>
  </>,
};

const sampleSize: Method = {
  id: 'sample', cap: 'exp.sample_size', title: 'How long to run a test',
  answers: 'How many users per variant, and how many days at your traffic, to detect the lift you care about.',
  fields: [
    { key: 'metric', label: 'Metric', kind: 'select', default: 'conversion', options: [{ value: 'conversion', label: 'Conversion rate' }, { value: 'continuous', label: 'An amount' }] },
    { key: 'baseline', label: 'Current rate (%) or average', kind: 'number', default: 5, step: 0.1 },
    { key: 'mde', label: 'Smallest lift worth detecting (%)', kind: 'number', default: 10, step: 1 },
    { key: 'sd', label: 'Standard deviation (amounts only)', kind: 'number', optional: true },
    { key: 'variants', label: 'Variants including control', kind: 'number', default: 2, min: 2, max: 10, step: 1 },
    { key: 'daily_traffic', label: 'Users per day (optional)', kind: 'number', optional: true, step: 100 },
  ],
  params: v => ({ ...v, baseline: v.metric === 'conversion' ? v.baseline / 100 : v.baseline, mde: v.mde / 100 }),
  headline: (r, v) => `${r.perVariant.toLocaleString()} users per variant (${r.total.toLocaleString()} total) to detect a ${v.mde}% lift${r.days ? ` — about ${r.days.toLocaleString()} days at your traffic` : ''}.`,
  render: r => <StatGrid items={[['Per variant', r.perVariant.toLocaleString()], ['Total', r.total.toLocaleString()], ['Days', r.days ? r.days.toLocaleString() : '—'], ['Significance per comparison', num(r.alphaPerComparison)]]} />,
};

const sequential: Method = {
  id: 'sequential', cap: 'exp.sequential', title: 'Peek safely (sequential test plan)',
  answers: 'Boundaries that let you check a running test several times and stop early, without inflating false positives.',
  fields: [
    { key: 'looks', label: 'How many times you’ll check', kind: 'number', default: 5, min: 2, max: 20, step: 1 },
    { key: 'spending', label: 'Plan', kind: 'select', default: 'obrien_fleming', options: [{ value: 'obrien_fleming', label: 'O’Brien–Fleming (strict early)' }, { value: 'pocock', label: 'Pocock (equal at each look)' }] },
  ],
  headline: r => `Stop at look ${1} only if |z| > ${num(r.plan[0].boundaryZ)}; by the final look the bar falls to |z| > ${num(r.plan[r.plan.length - 1].boundaryZ)}.`,
  render: r => <DataTable rows={r.plan} columns={[{ key: 'look', label: 'Look' }, { key: 'information', label: 'Data collected', format: pct }, { key: 'boundaryZ', label: 'Stop if |z| above' }, { key: 'nominalP', label: 'i.e. p below', format: x => num(x) }]} />,
};

const bandit: Method = {
  id: 'bandit', cap: 'exp.bandit', title: 'Shift traffic to the winner (bandit)',
  answers: 'How to split traffic now, from results so far, to earn more while still learning (Thompson sampling).',
  fields: [{ key: 'arms', label: 'Results so far', kind: 'arms' }],
  headline: r => {
    const best = [...r.arms].sort((a: any, b: any) => b.probabilityBest - a.probabilityBest)[0];
    return `${best.name} is most likely best (${pct(best.probabilityBest)}); send it ${pct(best.suggestedShare)} of traffic.`;
  },
  render: r => <DataTable rows={r.arms} columns={[{ key: 'name', label: 'Option' }, { key: 'rate', label: 'Rate', format: x => pct(x, 2) }, { key: 'probabilityBest', label: 'Chance best', format: pct }, { key: 'suggestedShare', label: 'Suggested traffic', format: pct }]} />,
};

// ================================================================== survival
const km: Method = {
  id: 'km', cap: 'survival.kaplan_meier', title: 'How long until… (survival curves)',
  answers: 'How long until customers churn, machines fail or patients relapse — counting those who haven’t yet.',
  fields: [
    { key: 'duration', label: 'Time observed', kind: 'column', filter: 'numeric' },
    { key: 'event', label: 'Did it happen? (1 = yes, 0 = not yet)', kind: 'column', filter: 'binary' },
    { key: 'group', label: 'Compare groups (optional)', kind: 'column', filter: 'categorical', optional: true },
  ],
  headline: r => {
    const med = r.curves.map((c: any) => `${c.group === 'all' || !c.group ? 'Median' : c.group}: ${c.median != null ? num(c.median) : 'not reached'}`).join(' · ');
    return r.logRank ? `${sig(r.logRank.p) ? 'Groups differ' : 'No clear difference between groups'} (log-rank p ${pValue(r.logRank.p)}). Median time — ${med}.` : `Median time: ${med}.`;
  },
  tone: r => r.logRank && sig(r.logRank.p) ? 'good' : 'plain',
  render: r => <>
    <div className="h-60"><ResponsiveContainer><LineChart margin={{ left: -10, right: 8 }}><CartesianGrid stroke="var(--separator)" vertical={false} /><XAxis dataKey="t" type="number" domain={[0, 'dataMax']} {...axis} /><YAxis domain={[0, 1]} tickFormatter={x => pct(x)} {...axis} /><Tooltip formatter={(x: number) => pct(x, 1)} labelFormatter={l => `time ${num(l)}`} />
      {r.curves.length > 1 && <Legend iconType="plainline" wrapperStyle={{ fontSize: 12 }} />}
      {r.curves.map((c: any, i: number) => <Line key={c.group ?? i} data={c.curve} dataKey="s" name={String(c.group ?? 'All')} type="stepAfter" dot={false} isAnimationActive={false} stroke={CHART_COLORS[i % CHART_COLORS.length]} strokeWidth={2} />)}
    </LineChart></ResponsiveContainer></div>
    <DataTable rows={r.curves} columns={[{ key: 'group', label: 'Group', format: g => g ?? 'All' }, { key: 'n', label: 'Rows' }, { key: 'events', label: 'Events' }, { key: 'median', label: 'Median time', format: m => m == null ? 'not reached' : num(m) }]} />
  </>,
};

const cox: Method = {
  id: 'cox', cap: 'survival.regression', title: 'What changes the risk (Cox model)',
  answers: 'Which factors make the event come sooner or later, as hazard ratios (2 = twice the risk at any moment).',
  fields: [
    { key: 'duration', label: 'Time observed', kind: 'column', filter: 'numeric' },
    { key: 'event', label: 'Did it happen? (1 = yes)', kind: 'column', filter: 'binary' },
    { key: 'covariates', label: 'Factors', kind: 'columns', filter: 'any', min: 1 },
  ],
  headline: r => {
    const s = (r.coefficients ?? []).filter((c: any) => sig(c.p)).sort((a: any, b: any) => Math.abs(Math.log(b.hazardRatio)) - Math.abs(Math.log(a.hazardRatio)))[0];
    return s ? `${s.term} ${s.hazardRatio > 1 ? 'raises' : 'lowers'} the risk: hazard ratio ${num(s.hazardRatio)} (${ciText(s.ci)}).` : 'None of the factors clearly changes the risk.';
  },
  tone: r => (r.coefficients ?? []).some((c: any) => sig(c.p)) ? 'good' : 'plain',
  render: r => {
    const broken = (r.proportionalHazards ?? []).filter((x: any) => sig(x.p));
    return <>
      <EffectTable valueLabel="Hazard ratio" zero={1} log rows={(r.coefficients ?? []).map((c: any) => ({ term: c.term, value: c.hazardRatio, ci: c.ci, p: c.p }))} />
      <StatGrid items={[['Rows', r.n?.toLocaleString()], ['Events', r.events?.toLocaleString()], ['Concordance', num(r.concordance)], ['Model', r.model]]} />
      {broken.length > 0 && <Note tone="warn">The effect of {broken.map((x: any) => x.term).join(', ')} changes over time (proportional-hazards test), so one ratio is a simplification.</Note>}
    </>;
  },
};

// ================================================================== bayesian
const bayesAb: Method = {
  id: 'bayes-ab', cap: 'bayes.ab_test', title: 'Chance each variant is best (Bayesian A/B)',
  answers: 'The probability each variant is best and the expected cost of choosing it — answers people actually ask.',
  fields: [
    { key: 'variant', label: 'Variant column', kind: 'column', filter: 'categorical' },
    { key: 'metric', label: 'Metric (0/1 or an amount)', kind: 'column', filter: 'numeric' },
  ],
  headline: r => {
    const best = (r.variants ?? []).find((x: any) => x.name === r.leader);
    const chance = r.leaderProbability > 0.999 ? 'over 99.9%' : pct(r.leaderProbability, 1);
    return `${r.leader} is most likely best (${chance} chance)${best ? `; choosing it risks an expected loss of ${num(best.expectedLoss)}` : ''}.`;
  },
  tone: r => r.leaderProbability >= 0.95 ? 'good' : 'plain',
  render: r => <>
    <DataTable rows={r.variants} columns={[{ key: 'name', label: 'Variant' }, { key: 'observed', label: 'Observed', format: x => r.kind === 'conversion' ? pct(x, 2) : num(x) }, { key: 'credible', label: '95% credible interval', format: c => c ? `${r.kind === 'conversion' ? pct(c[0], 2) : num(c[0])} – ${r.kind === 'conversion' ? pct(c[1], 2) : num(c[1])}` : '' }, { key: 'probabilityBest', label: 'Chance best', format: pct }, { key: 'expectedLoss', label: 'Expected loss', format: x => num(x) }]} />
    <Note>Choose a variant when its chance of being best is high and its expected loss is below what you’d accept losing.</Note>
  </>,
};

const bayesT: Method = {
  id: 'bayes-t', cap: 'bayes.ttest', title: 'Evidence for or against a difference (Bayes factor)',
  answers: 'How strongly the data favour a difference between two groups versus none — it can also support “no difference”.',
  fields: [
    { key: 'value', label: 'Amount', kind: 'column', filter: 'numeric' },
    { key: 'group', label: 'Two groups', kind: 'column', filter: 'binary' },
  ],
  headline: r => {
    const times = (x: number) => x > 10000 ? 'more than 10,000×' : `${num(x)}×`;
    return r.bf10 >= 1 ? `The data are ${times(r.bf10)} more likely if the groups differ (${r.evidence} evidence for a difference).` : `The data are ${times(r.bf01)} more likely if there is no difference (${r.evidence} evidence for no difference).`;
  },
  render: r => <StatGrid items={[['Bayes factor (difference)', num(r.bf10)], ['Evidence', r.evidence], ['Effect size (d)', num(r.cohenD)], ['Rows', (r.n ?? []).join(' + ')]]} />,
};

const bayesReg: Method = {
  id: 'bayes-reg', cap: 'bayes.regression', title: 'Bayesian regression',
  answers: 'Effects as probabilities — “there’s a 97% chance this factor raises the outcome”.',
  fields: [
    { key: 'outcome', label: 'Outcome', kind: 'column', filter: 'numeric' },
    { key: 'predictors', label: 'Explained by', kind: 'columns', filter: 'any', min: 1 },
  ],
  headline: r => {
    const c = nonIntercept(r.coefficients).sort((a: any, b: any) => Math.abs(b.probabilityPositive - 0.5) - Math.abs(a.probabilityPositive - 0.5))[0];
    return c ? `${pct(Math.max(c.probabilityPositive, 1 - c.probabilityPositive))} chance that ${c.term} ${c.probabilityPositive >= 0.5 ? 'raises' : 'lowers'} the outcome (${signed(c.posteriorMean)} per unit).` : 'Fitted.';
  },
  render: r => <>
    <EffectTable valueLabel="Posterior mean" rows={nonIntercept(r.coefficients).map((c: any) => ({ term: c.term, value: c.posteriorMean, ci: c.credible }))} />
    <DataTable rows={nonIntercept(r.coefficients)} columns={[{ key: 'term', label: 'Term' }, { key: 'probabilityPositive', label: 'Chance it’s positive', format: pct }]} />
    <p className="text-xs text-label-3">{r.prior}. Intervals are 95% credible intervals.</p>
  </>,
};

// ================================================================== groups
export type GroupId = 'compare' | 'regression' | 'causal' | 'power' | 'survival' | 'bayesian' | 'hypothesis' | 'forecast' | 'decide';

export const ENGINE_METHODS: Record<string, Method> = Object.fromEntries(
  [glm, anova, mixed, robust, bootstrap, propensity, did, synth, iv, rdd, uplift, abTest, sampleSize, sequential, bandit, km, cox, bayesAb, bayesT, bayesReg, ...MODEL_METHODS].map(m => [m.id, m]),
);

export const GUIDES: Partial<Record<GroupId, GuideStep>> = {
  regression: { question: 'What kind of outcome do you want to explain?', options: [
    { label: 'An amount', next: { question: 'Anything special about the rows?', options: [
      { label: 'No, ordinary rows', method: 'quick' }, { label: 'Rows come in groups (same customer over time…)', method: 'mixed' },
      { label: 'There are extreme values', method: 'robust' }, { label: 'I’m comparing group averages', method: 'anova' }] } },
    { label: 'Yes / no', method: 'glm' }, { label: 'A count', method: 'glm' }] },
  causal: { question: 'How did some units come to be treated?', options: [
    { label: 'They chose it, or we picked them', method: 'propensity' },
    { label: 'A change hit some units from a date', next: { question: 'How many units were hit?', options: [{ label: 'Many', method: 'did' }, { label: 'Just one', method: 'synth' }] } },
    { label: 'A score above a threshold', method: 'rdd' },
    { label: 'Something random nudged who got it', method: 'iv' },
    { label: 'It was randomised; I want to target better', method: 'uplift' }] },
  power: { question: 'Where is your test?', options: [
    { label: 'Planning it', method: 'sample' }, { label: 'Running — can I peek?', method: 'sequential' },
    { label: 'Finished — did it win?', method: 'ab' }, { label: 'Many options, want to earn while learning', method: 'bandit' }] },
  survival: { question: 'What do you want to know?', options: [{ label: 'How long until it happens', method: 'km' }, { label: 'What makes it happen sooner', method: 'cox' }] },
  bayesian: { question: 'What do you want to know?', options: [
    { label: 'Which variant is best', method: 'bayes-ab' }, { label: 'Is there really a difference (or really none)?', method: 'bayes-t' }, { label: 'How likely each factor matters', method: 'bayes-reg' }] },
};

export const GROUP_METHODS: Record<GroupId, string[]> = {
  compare: ['quick', 'bootstrap'],
  regression: ['quick', 'glm', 'anova', 'mixed', 'robust'],
  causal: ['propensity', 'did', 'synth', 'iv', 'rdd', 'uplift'],
  power: ['quick', 'sample', 'ab', 'sequential', 'bandit', 'interpret'],
  survival: ['km', 'cox'],
  bayesian: ['bayes-ab', 'bayes-t', 'bayes-reg'],
  hypothesis: ['quick'],
  forecast: ['forecast', 'hierarchical', 'quick'],
  decide: ['montecarlo', 'optimize', 'scenarios'],
};
