/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useEffect, useMemo, useState } from 'react';
import { AlertTriangle, ChevronDown, Lightbulb, Send, Trophy } from 'lucide-react';
import type { Dataset } from '../../types';
import { useCapability } from '../../engine/useCapability';
import { useLogRun } from '../../contexts/WorkspaceContext';
import RunBar from '../engine/RunBar';
import Provenance from '../engine/Provenance';
import { ResultFooter } from '../pins/PinButton';
import { DataTable, Note, Section, StatGrid, num, pValue, pct } from '../stats/methodKit';
import { textColumns } from '../explore/TextAnalysis';
import { Bars, CalibrationChart, ConfusionMatrix, LiftChart, PrChart, ResidualChart, RocChart } from './charts';
import { metricLabel, metricValue, useModels } from './models';

const BUDGETS = [{ s: 30, label: 'Quick (about 30 s)' }, { s: 120, label: 'Balanced (about 2 min)' }, { s: 600, label: 'Thorough (about 10 min)' }];
const METRICS: Record<'classification' | 'regression', { value: string; label: string }[]> = {
  classification: [{ value: 'auto', label: 'Automatic' }, { value: 'roc_auc', label: 'ROC AUC' }, { value: 'f1_macro', label: 'F1 (macro)' }, { value: 'balanced_accuracy', label: 'Balanced accuracy' }, { value: 'accuracy', label: 'Accuracy' }, { value: 'average_precision', label: 'Average precision' }, { value: 'neg_log_loss', label: 'Log loss' }],
  regression: [{ value: 'auto', label: 'Automatic (R²)' }, { value: 'r2', label: 'R²' }, { value: 'neg_root_mean_squared_error', label: 'RMSE' }, { value: 'neg_mean_absolute_error', label: 'MAE' }],
};
const TEST_KEYS = { classification: ['rocAuc', 'accuracy', 'balancedAccuracy', 'f1', 'f1Macro', 'precision', 'recall', 'prAuc', 'logLoss', 'brier'], regression: ['r2', 'rmse', 'mae', 'mape'] };

const Chips: React.FC<{ id: string; label: string; options: string[]; value: string[]; onChange: (v: string[]) => void; empty?: string }> = ({ id, label, options, value, onChange, empty }) => (
  <div className="space-y-1.5">
    <span className="field-label" id={id}>{label}</span>
    <div className="flex flex-wrap gap-1.5" role="group" aria-labelledby={id}>
      {options.map(c => (
        <button key={c} type="button" aria-pressed={value.includes(c)} onClick={() => onChange(value.includes(c) ? value.filter(x => x !== c) : [...value, c])}
          className={`px-2.5 py-1 rounded-full text-sm border transition-colors ${value.includes(c) ? 'bg-blue text-white border-blue' : 'border-separator text-label hover:bg-fill'}`}>
          {c}
        </button>
      ))}
      {!options.length && <span className="text-sm text-label-3">{empty ?? 'None available.'}</span>}
    </div>
  </div>
);

const SPLITS = [
  { value: '80-0-20', label: 'Train 80% · test 20% (most accurate)' },
  { value: '70-15-15', label: 'Train 70% · validation 15% · test 15%' },
  { value: '60-20-20', label: 'Train 60% · validation 20% · test 20%' },
  { value: '90-0-10', label: 'Train 90% · test 10% (small data)' },
];

export default function AutoMLPanel({ dataset, onOpen }: { dataset: Dataset; onOpen: (tab: 'explain' | 'predict' | 'registry', modelId: string) => void }) {
  const run = useCapability('ml.automl', dataset);
  const logRun = useLogRun();
  const { refresh, select } = useModels();
  const cols = dataset.columns.map(c => c.name);
  const texts = useMemo(() => textColumns(dataset), [dataset]);

  const [target, setTarget] = useState(() => cols[cols.length - 1] ?? '');
  const [features, setFeatures] = useState<string[]>([]);
  const [budget, setBudget] = useState(120);
  const [metric, setMetric] = useState('auto');
  const [name, setName] = useState('');
  const [advanced, setAdvanced] = useState(false);
  const [split, setSplit] = useState<'auto' | 'random' | 'time' | 'group'>('auto');
  const [splitCol, setSplitCol] = useState('');
  const [sensitive, setSensitive] = useState<string[]>([]);
  const [costFp, setCostFp] = useState('');
  const [costFn, setCostFn] = useState('');
  const [encoder, setEncoder] = useState<'tfidf' | 'minilm-en' | 'minilm-multilingual'>('tfidf');
  const [nested, setNested] = useState(false);
  const [interactions, setInteractions] = useState(false);
  const [calibrate, setCalibrate] = useState<'none' | 'sigmoid' | 'isotonic'>('none');
  const [holdout, setHoldout] = useState('80-0-20');

  const tcol = dataset.columns.find(c => c.name === target);
  const task: 'classification' | 'regression' = tcol && tcol.type === 'numeric' && tcol.distinctCount > 12 ? 'regression' : 'classification';
  const binary = task === 'classification' && tcol?.distinctCount === 2;
  useEffect(() => { setMetric('auto'); }, [task]);

  const others = cols.filter(c => c !== target);
  const r = run.result as any;
  const [ranParams, setRanParams] = useState<Record<string, unknown>>({});

  const params = () => {
    const p: Record<string, unknown> = { target, time_budget_s: budget, metric, split, text_encoder: encoder, nested_cv: nested, interactions, calibrate };
    const [, va, te] = holdout.split('-').map(Number);
    p.test_size = te / 100;
    if (va) p.validation_size = va / 100;
    if (features.length) p.features = features;
    if (name.trim()) p.name = name.trim();
    if (split === 'time' && splitCol) p.time_column = splitCol;
    if (split === 'group' && splitCol) p.group_column = splitCol;
    if (sensitive.length) p.sensitive_features = sensitive;
    if (binary && Number(costFp) > 0 && Number(costFn) > 0) { p.cost_false_positive = Number(costFp); p.cost_false_negative = Number(costFn); }
    return p;
  };
  const issue = !target ? 'Choose what to predict.'
    : (split === 'time' || split === 'group') && !splitCol ? `Choose the ${split === 'time' ? 'date' : 'group'} column for the split.`
      : binary && (costFp !== '') !== (costFn !== '') ? 'Enter both costs, or neither.' : null;

  // Log the run once it finishes, refresh the registry, and work with the new model from here on.
  useEffect(() => {
    if (!r) return;
    const champ = r.champion?.label ?? 'a model';
    const primary = r.task === 'classification' ? (r.test?.rocAuc != null ? `ROC AUC ${num(r.test.rocAuc)}` : `accuracy ${num(r.test?.accuracy)}`) : `R² ${num(r.test?.r2)}`;
    logRun({ kind: 'engine', title: `AutoML: predict ${r.target}`, summary: `${champ} won (${primary} on held-out test data)${r.model?.name ? `, saved as ${r.model.name} v${r.model.version}` : ''}.`, status: 'succeeded', params: { capability: 'ml.automl', params: ranParams, runId: r.runId, view: { kind: 'automl' } }, result: r });
    if (r.model?.id) { select(r.model.id); refresh(); }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [r]);

  return (
    <div className="space-y-6">
      <div className="card p-4 sm:p-5 space-y-4" data-agent="area-automl">
        <div>
          <h3 className="card-title">AutoML</h3>
          <p className="mt-1 text-sm text-label-2">Tries every suitable model family, tunes each with cross-validation, and picks the best — with confidence intervals, a fair baseline, a held-out test, and checks for leakage and fairness. The winner is saved so you can explain it, score new data and monitor it.</p>
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
          <div>
            <label className="field-label" htmlFor="automl-target">Predict</label>
            <select id="automl-target" className="input" value={target} data-agent="automl-target" onChange={e => { setTarget(e.target.value); setFeatures(f => f.filter(x => x !== e.target.value)); }}>
              {cols.map(c => <option key={c} value={c}>{c}</option>)}
            </select>
            <p className="mt-1 text-xs text-label-3">{task === 'regression' ? 'An amount (regression)' : binary ? 'Yes / no (binary classification)' : 'A category (classification)'}</p>
          </div>
          <div>
            <label className="field-label" htmlFor="automl-budget">Search time</label>
            <select id="automl-budget" data-agent="automl-budget" className="input" value={budget} onChange={e => setBudget(Number(e.target.value))}>
              {BUDGETS.map(b => <option key={b.s} value={b.s}>{b.label}</option>)}
            </select>
          </div>
          <div>
            <label className="field-label" htmlFor="automl-metric">Judge models by</label>
            <select id="automl-metric" className="input" value={metric} onChange={e => setMetric(e.target.value)}>
              {METRICS[task].map(m => <option key={m.value} value={m.value}>{m.label}</option>)}
            </select>
          </div>
          <div>
            <label className="field-label" htmlFor="automl-holdout">Split the rows</label>
            <select id="automl-holdout" data-agent="automl-holdout" className="input" value={holdout} onChange={e => setHoldout(e.target.value)}>
              {SPLITS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
            </select>
            <p className="mt-1 text-xs text-label-3">{holdout === '80-0-20' ? 'Cross-validation on the training rows picks the model; the test rows judge it.' : 'Validation rows give a second, independent check before the final test.'}</p>
          </div>
          <div>
            <label className="field-label" htmlFor="automl-name">Save as (name)</label>
            <input id="automl-name" data-agent="automl-name" className="input" value={name} placeholder={`e.g. ${target.toLowerCase().replace(/\W+/g, '-')}-model`} onChange={e => setName(e.target.value)} />
          </div>
          <div className="sm:col-span-2 lg:col-span-4">
            <Chips id="automl-features" label={`Use these columns (all others when none are chosen)`} options={others} value={features} onChange={setFeatures} />
          </div>
        </div>

        <button type="button" className="btn btn-plain -ml-2 text-sm" aria-expanded={advanced} onClick={() => setAdvanced(a => !a)}>
          <ChevronDown className={`w-4 h-4 transition-transform ${advanced ? 'rotate-180' : ''}`} /> More options
        </button>
        {advanced && (
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4 animate-fade-in">
            <div>
              <label className="field-label" htmlFor="automl-split">How to hold out test rows</label>
              <select id="automl-split" className="input" value={split} onChange={e => { setSplit(e.target.value as any); setSplitCol(''); }}>
                <option value="auto">Automatic</option><option value="random">Random rows</option><option value="time">Latest rows (by date)</option><option value="group">Whole groups (e.g. customers)</option>
              </select>
            </div>
            {(split === 'time' || split === 'group') && (
              <div>
                <label className="field-label" htmlFor="automl-splitcol">{split === 'time' ? 'Date column' : 'Group column'}</label>
                <select id="automl-splitcol" className="input" value={splitCol} onChange={e => setSplitCol(e.target.value)}>
                  <option value="">Choose…</option>
                  {others.map(c => <option key={c} value={c}>{c}</option>)}
                </select>
              </div>
            )}
            {task === 'classification' && (
              <div>
                <label className="field-label" htmlFor="automl-calibrate">Calibrate probabilities</label>
                <select id="automl-calibrate" className="input" value={calibrate} onChange={e => setCalibrate(e.target.value as any)}>
                  <option value="none">No</option><option value="sigmoid">Yes — Platt (small data)</option><option value="isotonic">Yes — isotonic (large data)</option>
                </select>
              </div>
            )}
            {texts.length > 0 && (
              <div>
                <label className="field-label" htmlFor="automl-encoder">Free-text columns ({texts.join(', ')})</label>
                <select id="automl-encoder" className="input" value={encoder} onChange={e => setEncoder(e.target.value as any)}>
                  <option value="tfidf">Word statistics (TF-IDF, fast)</option><option value="minilm-en">Meaning — English embeddings</option><option value="minilm-multilingual">Meaning — 50+ languages</option>
                </select>
              </div>
            )}
            {binary && (
              <>
                <div>
                  <label className="field-label" htmlFor="automl-fp">Cost of a false alarm</label>
                  <input id="automl-fp" className="input" type="number" inputMode="decimal" min={0} step="any" placeholder="Optional" value={costFp} onChange={e => setCostFp(e.target.value)} />
                </div>
                <div>
                  <label className="field-label" htmlFor="automl-fn">Cost of a miss</label>
                  <input id="automl-fn" className="input" type="number" inputMode="decimal" min={0} step="any" placeholder="Optional" value={costFn} onChange={e => setCostFn(e.target.value)} />
                </div>
              </>
            )}
            <label className="flex items-center gap-2 text-sm text-label self-end pb-2"><input type="checkbox" checked={nested} onChange={e => setNested(e.target.checked)} /> Nested cross-validation (unbiased, slower)</label>
            <label className="flex items-center gap-2 text-sm text-label self-end pb-2"><input type="checkbox" checked={interactions} onChange={e => setInteractions(e.target.checked)} /> Add interaction features</label>
            <div className="sm:col-span-2 lg:col-span-4">
              <Chips id="automl-sensitive" label="Check fairness across (e.g. gender, age band)" options={others.filter(c => (dataset.columns.find(x => x.name === c)?.distinctCount ?? 99) <= 20)} value={sensitive} onChange={setSensitive} empty="No columns with few enough groups." />
            </div>
          </div>
        )}

        <RunBar run={run} label="Find the best model" agent="automl-run" disabled={!!issue} onRun={() => { const p = params(); setRanParams(p); run.run(p); }} />
        {issue && run.phase === 'idle' && <p className="text-xs text-label-3">{issue}</p>}
      </div>

      {r && <AutoMLResult r={r} params={ranParams} onOpen={onOpen} />}
    </div>
  );
}

/** The one-sentence summary of an AutoML result (also used by pinned results). */
export function automlHeadline(r: any): string {
  const test = r.test ?? {};
  const key = r.task === 'classification' ? (test.rocAuc != null ? 'rocAuc' : 'accuracy') : 'r2';
  const base = r.baseline?.test?.[key];
  return `${r.champion?.label} predicts ${r.target} best: ${metricLabel(key)} ${num(test[key])} on rows it never saw${base != null ? ` (a no-skill baseline scores ${num(base)})` : ''}.`;
}

function AutoMLResult({ r, params, onOpen }: { r: any; params: Record<string, unknown>; onOpen: (tab: 'explain' | 'predict' | 'registry', id: string) => void }) {
  const cls = r.task === 'classification';
  const test = r.test ?? {};
  const scoring: string = r.scoring;
  const primaryKey = cls ? (test.rocAuc != null ? 'rocAuc' : 'accuracy') : 'r2';
  const beatBaseline = r.baseline?.test?.[primaryKey] != null ? (test[primaryKey] ?? 0) - r.baseline.test[primaryKey] : null;
  const cutoff: number | null = r.costThreshold?.threshold ?? (r.bestF1Threshold != null && r.classes?.length === 2 ? r.bestF1Threshold : null);
  const baselineScore = metricValue(scoring, r.baseline?.cvMean);
  const lb = (r.leaderboard ?? []).map((m: any) => ({ ...m, score: metricValue(scoring, m.cvMean), ci: m.cvCi ? m.cvCi.map((x: number) => metricValue(scoring, x)).sort((a: number, b: number) => a - b) : null }));
  const positiveRate = cls && r.confusionMatrix ? (() => { const m = r.confusionMatrix.matrix; const pos = r.confusionMatrix.labels.indexOf(r.positiveClass); return pos < 0 ? undefined : m[pos].reduce((a: number, b: number) => a + b, 0) / m.flat().reduce((a: number, b: number) => a + b, 0); })() : undefined;

  return (
    <div className="card p-4 sm:p-5 space-y-6 animate-fade-in" role="region" aria-label="AutoML result">
      <div className="space-y-2">
        <p className="text-[17px] font-semibold text-label flex items-start gap-2">
          <Trophy className="w-5 h-5 text-orange shrink-0 mt-0.5" />
          <span>
            {r.champion?.label} predicts {r.target} best: {metricLabel(primaryKey)} {num(test[primaryKey])} on rows it never saw
            {beatBaseline != null && ` (a no-skill baseline scores ${num(r.baseline.test[primaryKey])})`}.
          </span>
        </p>
        {r.comparison && (
          <p className="text-sm text-label-2">
            {r.comparison.significant
              ? `It is reliably better than the runner-up, ${r.comparison.runnerUp} (corrected t-test p ${pValue(r.comparison.p)}).`
              : `It isn’t reliably better than ${r.comparison.runnerUp} (p ${pValue(r.comparison.p)}) — either is a sound choice.`}
          </p>
        )}
        {r.model?.id && (
          <div className="flex flex-wrap items-center gap-2 pt-1">
            <span className="text-sm text-label-2">Saved{r.model.name ? ` as ${r.model.name} v${r.model.version}` : ''}.</span>
            <button type="button" className="btn btn-sm btn-secondary" data-agent="automl-explain" onClick={() => onOpen('explain', r.model.id)}><Lightbulb className="w-3.5 h-3.5" /> Explain it</button>
            <button type="button" className="btn btn-sm btn-secondary" onClick={() => onOpen('predict', r.model.id)}><Send className="w-3.5 h-3.5" /> Make predictions</button>
            <button type="button" className="btn btn-sm btn-plain" onClick={() => onOpen('registry', r.model.id)}>Manage in Models</button>
          </div>
        )}
      </div>

      {(r.leakage ?? []).length > 0 && (
        <div className="rounded-xl bg-orange/10 px-3 py-2 text-sm text-orange space-y-1">
          <p className="font-semibold flex items-center gap-1.5"><AlertTriangle className="w-4 h-4" /> Possible leakage — check these columns before trusting the score</p>
          <ul className="list-disc pl-5">{r.leakage.map((l: any) => <li key={l.column}><b>{l.column}</b>: {l.reason}</li>)}</ul>
        </div>
      )}

      <div className="space-y-1.5">
        <StatGrid items={TEST_KEYS[cls ? 'classification' : 'regression'].filter(k => test[k] != null).slice(0, 8).map(k => [metricLabel(k), num(test[k])] as [string, React.ReactNode])} />
        <p className="text-xs text-label-3">Held-out test rows ({r.rows?.test?.toLocaleString()}){cls && cutoff != null ? `. Yes/no scores here use a 50% cut-off; the saved model flags at ${pct(cutoff)} — see “Choosing the cut-off”.` : '.'}</p>
        {r.validation && (
          <div className="space-y-1.5 pt-2" data-agent="automl-validation">
            <StatGrid items={TEST_KEYS[cls ? 'classification' : 'regression'].filter(k => r.validation[k] != null).slice(0, 8).map(k => [metricLabel(k), num(r.validation[k])] as [string, React.ReactNode])} />
            <p className="text-xs text-label-3">Validation rows ({r.rows?.validation?.toLocaleString()}), kept apart from training and the test{r.validation[primaryKey] != null && test[primaryKey] != null ? `: ${metricLabel(primaryKey)} ${num(r.validation[primaryKey])} here vs ${num(test[primaryKey])} on test${Math.abs(r.validation[primaryKey] - test[primaryKey]) > 0.05 ? ' — a noticeable gap, so judge the model on both' : ' — consistent'}` : ''}.</p>
          </div>
        )}
      </div>

      <Section title={`Every model tried (${metricLabel(scoring)}, cross-validated on ${r.rows?.train?.toLocaleString()} training rows; bars show 95% intervals)`}>
        <Bars from={baselineScore ?? undefined} lowerIsBetter={scoring.startsWith('neg_')} rows={lb.map((m: any) => ({ label: m.label, value: m.score, ci: m.ci, hint: `${m.trials} settings tried in ${m.seconds}s` }))} />
        <p className="text-xs text-label-3">Bars start at the no-skill baseline ({num(baselineScore)}: always guessing the most common answer or the average). Overlapping intervals mean the difference may be luck.</p>
      </Section>

      {r.nestedCv && (
        <Note>Nested cross-validation estimates the whole search at {num(metricValue(scoring, r.nestedCv.mean))} ({metricLabel(scoring)}), {r.nestedCv.optimism > 0 ? `${num(Math.abs(r.nestedCv.optimism))} below` : 'in line with'} the leaderboard’s best — the realistic figure to quote.</Note>
      )}

      {cls ? (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
          {r.roc?.length > 0 && <RocChart points={r.roc} auc={test.rocAuc} />}
          {r.pr?.length > 0 && <PrChart points={r.pr} base={positiveRate} />}
          {r.calibration?.bins?.length > 0 && <CalibrationChart bins={r.calibration.bins} ece={r.calibration.ece} />}
          {r.lift?.length > 0 && <LiftChart deciles={r.lift} />}
        </div>
      ) : r.residuals?.points?.length > 0 && <ResidualChart points={r.residuals.points} />}

      {cls && r.confusionMatrix && (
        <Section title="Where it’s right and wrong (test rows, 50% cut-off)">
          <ConfusionMatrix labels={r.confusionMatrix.labels} matrix={r.confusionMatrix.matrix} />
        </Section>
      )}

      {cls && (r.costThreshold || r.bestF1Threshold != null) && (
        <Section title="Choosing the cut-off">
          {r.costThreshold && (
            <Note>With a false alarm costing {num(r.costThreshold.costFalsePositive)} and a miss {num(r.costThreshold.costFalseNegative)}, flag a row when the probability is above <b>{pct(r.costThreshold.threshold)}</b>: cost per row on test data {num(r.costThreshold.costPerRowTest)} vs {num(r.costThreshold.costPerRowTestAtHalf)} at 50%. The saved model uses this cut-off.</Note>
          )}
          {r.bestF1Threshold != null && !r.costThreshold && (
            <p className="text-sm text-label-2">The best balance of precision and recall (F1) comes at a cut-off of {pct(r.bestF1Threshold)}: F1 {num(r.bestF1ThresholdTest?.f1)} on test data vs {num(r.bestF1ThresholdTest?.f1AtHalf)} at 50%.</p>
          )}
          <DataTable rows={(r.thresholds ?? []).filter((t: any) => t.flagged > 0)} limit={19} columns={[{ key: 'threshold', label: 'Cut-off', format: (v: number) => pct(v) }, { key: 'flagged', label: 'Rows flagged' }, { key: 'precision', label: 'Precision', format: (v: number) => pct(v) }, { key: 'recall', label: 'Recall', format: (v: number) => pct(v) }, { key: 'f1', label: 'F1' }]} />
        </Section>
      )}

      {r.importance?.length > 0 && (
        <Section title="What the model relies on (drop in score when a column is shuffled)">
          <Bars signed={r.importance.some((i: any) => i.importance < 0)} rows={r.importance.slice(0, 15).map((i: any) => ({ label: i.feature, value: i.importance, ci: i.ci }))} />
          {r.importance.some((i: any) => i.importance <= 0) && <p className="text-xs text-label-3">Zero or below: the model does as well without that column — it adds nothing on rows it hasn’t seen.</p>}
        </Section>
      )}

      {r.conformal && (
        <Note>
          {cls
            ? `Prediction sets: listing every answer the model can’t rule out covers the truth ${pct(r.conformal.testCoverage)} of the time on test rows (target ${pct(1 - r.conformal.alpha)}), with ${num(r.conformal.averageSetSize, 2)} answers per row on average.`
            : `Prediction ranges: ± ${num(r.conformal.halfWidth)} around each prediction contains the true value ${pct(r.conformal.testCoverage)} of the time on test rows (target ${pct(1 - r.conformal.alpha)}).`}
        </Note>
      )}

      {(r.fairness ?? []).map((f: any) => (
        <Section key={f.feature} title={`Fairness across ${f.feature}`}>
          <DataTable rows={f.groups} columns={[{ key: 'group', label: f.feature }, { key: 'n', label: 'Rows' }, { key: 'accuracy', label: 'Accuracy', format: (v: number) => pct(v, 1) },
            ...(f.groups[0]?.selectionRate != null ? [{ key: 'selectionRate', label: 'Flagged', format: (v: number) => pct(v, 1) }, { key: 'tpr', label: 'Caught (TPR)', format: (v: number) => (v == null ? '—' : pct(v, 1)) }, { key: 'fpr', label: 'False alarms', format: (v: number) => (v == null ? '—' : pct(v, 1)) }] : []),
            ...(f.groups[0]?.mae != null ? [{ key: 'mae', label: 'MAE' }] : [])]} />
          {f.summary?.disparateImpactRatio != null && (
            <Note tone={f.summary.passesFourFifthsRule ? 'plain' : 'warn'}>
              The least-flagged group is flagged at {pct(f.summary.disparateImpactRatio)} the rate of the most-flagged one
              {f.summary.passesFourFifthsRule ? ' — within the four-fifths rule.' : ' — below the four-fifths (80%) rule of thumb; review before using this model for decisions about people.'}
              {f.summary.equalizedOddsDifference != null && ` Catch rates differ by up to ${pct(f.summary.equalizedOddsDifference)}.`}
            </Note>
          )}
        </Section>
      ))}

      <ResultFooter agent="pin-automl" provenance={<Provenance manifest={r.manifest} runId={r.runId} notes={r.notes} />}
        pin={{ title: `AutoML: predict ${r.target}`, headline: automlHeadline(r), view: { kind: 'automl' }, capability: 'ml.automl', params, result: r }} />
    </div>
  );
}
