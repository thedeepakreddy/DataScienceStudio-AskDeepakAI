/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Dataset, MLResult } from '../types';
import { isEmpty } from './columnProfile';
import { isIdentifierColumn } from './csvParser';

// The model registry: trained models promoted for use, each with the exact
// recipe that produced it, a validation report, the shape of its training
// data (to check inputs and drift against), and a model card.

export interface FeatureSchema {
  name: string;
  type: 'numeric' | 'categorical' | 'boolean' | 'datetime';
  min?: number;
  max?: number;
  mean?: number;
  /** Known values for text columns (up to 200). */
  values?: string[];
  missingRate: number;
}

export type GateStatus = 'pass' | 'warn' | 'fail';
export interface GateCheck { id: string; status: GateStatus; title: string; detail: string }

export interface TrainingRecipe {
  target: string;
  features: string[];
  modelType: 'classification' | 'regression' | 'timeseries';
  hyperparameters: Record<string, any>;
}

export interface RegisteredModel {
  id: string;
  name: string;
  /** 1, 2, 3 ... per dataset. */
  version: number;
  datasetId: string;
  /** The data version it was trained on. */
  versionId: string;
  recipe: TrainingRecipe;
  modelKey: string;
  modelId: string | null;
  algorithm: string;
  task: string;
  metrics: MLResult['metrics'];
  cv?: { mean?: number; std?: number; folds?: number; metric?: string };
  split?: MLResult['split'];
  seed?: number;
  topFeatures: { feature: string; score: number }[];
  schema: FeatureSchema[];
  gate: GateCheck[];
  intendedUse: string;
  createdAt: number;
  active: boolean;
}

export function buildSchema(dataset: Dataset, features: string[]): FeatureSchema[] {
  return features.map(name => {
    const col = dataset.columns.find(c => c.name === name);
    const values = dataset.rows.map(r => r[name]);
    const filled = values.filter(v => !isEmpty(v));
    const base = { name, type: col?.type ?? 'categorical', missingRate: values.length ? 1 - filled.length / values.length : 0 } as FeatureSchema;
    if (base.type === 'numeric') {
      const nums = filled.map(Number).filter(Number.isFinite);
      return { ...base, min: Math.min(...nums), max: Math.max(...nums), mean: nums.reduce((a, b) => a + b, 0) / (nums.length || 1) };
    }
    return { ...base, values: [...new Set(filled.map(String))].sort().slice(0, 200) };
  });
}

/**
 * Checks a model must pass before it can be registered. A failure blocks
 * registration; a warning is recorded in the model card.
 */
export function validationGate(result: MLResult, dataset: Dataset): GateCheck[] {
  const checks: GateCheck[] = [];
  const m = result.metrics || {};
  const target = result.target;
  const isClf = result.modelType === 'classification';

  if (isClf && typeof m.accuracy === 'number' && target) {
    const vals = dataset.rows.map(r => r[target]).filter(v => !isEmpty(v)).map(String);
    const counts = new Map<string, number>();
    vals.forEach(v => counts.set(v, (counts.get(v) ?? 0) + 1));
    const majority = vals.length ? Math.max(...counts.values()) / vals.length : 0;
    const beats = m.accuracy > majority + 0.02;
    checks.push({
      id: 'baseline', status: beats ? 'pass' : 'fail', title: 'Beats always guessing the most common answer',
      detail: `Accuracy ${(m.accuracy * 100).toFixed(1)}% vs ${(majority * 100).toFixed(1)}% for always guessing the most common value of ${target}.`,
    });
  } else if (typeof m.r2Score === 'number') {
    checks.push({
      id: 'baseline', status: m.r2Score > 0 ? 'pass' : 'fail', title: 'Beats predicting the average',
      detail: `R² ${m.r2Score.toFixed(3)}; a value at or below 0 means it does no better than always predicting the average.`,
    });
  }

  const cv = result.cv as { mean?: number; std?: number } | undefined;
  const testScore = isClf ? m.accuracy : m.r2Score;
  if (cv && typeof cv.std === 'number' && typeof cv.mean === 'number') {
    checks.push({
      id: 'stability', status: cv.std <= 0.05 ? 'pass' : 'warn', title: 'Stable across data samples',
      detail: `Cross-validation ${cv.mean.toFixed(3)} ± ${cv.std.toFixed(3)}.`,
    });
    if (typeof testScore === 'number') {
      const gap = Math.abs(testScore - cv.mean);
      checks.push({
        id: 'agreement', status: gap <= 0.1 ? 'pass' : 'warn', title: 'Test score agrees with cross-validation',
        detail: gap <= 0.1 ? `Within ${gap.toFixed(3)}.` : `Differs by ${gap.toFixed(3)}; the test score may be lucky or unlucky.`,
      });
    }
  }

  const leaks = result.leakageWarnings ?? [];
  checks.push({
    id: 'leakage', status: leaks.length ? 'fail' : 'pass', title: 'No sign of data leakage',
    detail: leaks.length ? leaks.map(l => `${l.column}: ${l.reason}`).join(' ') : 'No feature contains or nearly predicts the target.',
  });

  const top = (result.featureImportance || [])[0];
  const topCol = top ? dataset.columns.find(c => c.name === top.feature) : undefined;
  if (topCol && isIdentifierColumn(topCol, dataset.rowCount)) {
    checks.push({ id: 'id-feature', status: 'fail', title: 'Doesn’t rely on an ID column', detail: `The most important feature, “${top.feature}”, identifies rows rather than describing them.` });
  }

  const testRows = result.split?.testRows ?? result.testRows;
  if (typeof testRows === 'number') {
    checks.push({
      id: 'test-size', status: testRows >= 30 ? 'pass' : 'warn', title: 'Tested on enough rows',
      detail: `${testRows} test rows${testRows < 30 ? '; scores from fewer than 30 rows are unreliable' : ''}.`,
    });
  }
  return checks;
}

export const gateBlocks = (checks: GateCheck[]) => checks.some(c => c.status === 'fail');

/** Warnings for one input row, compared with the training data. */
export function checkInput(schema: FeatureSchema[], row: Record<string, unknown>): string[] {
  const out: string[] = [];
  for (const f of schema) {
    const v = row[f.name];
    if (isEmpty(v)) {
      out.push(`${f.name} is empty; it will be filled the way missing values were during training.`);
    } else if (f.type === 'numeric') {
      const n = Number(v);
      if (!Number.isFinite(n)) out.push(`${f.name} should be a number.`);
      else if (f.min !== undefined && f.max !== undefined && (n < f.min || n > f.max)) {
        out.push(`${f.name} = ${n} is outside the training range (${f.min} to ${f.max}); the prediction is less reliable.`);
      }
    } else if (f.values && !f.values.includes(String(v))) {
      out.push(`${f.name} = “${String(v)}” never appeared in training; the model treats it as unknown.`);
    }
  }
  return out;
}

const pct = (v?: number) => (typeof v === 'number' ? `${(v * 100).toFixed(1)}%` : '—');

export function modelCardMarkdown(m: RegisteredModel, datasetName: string, dataLabel: string): string {
  const metrics = Object.entries(m.metrics || {})
    .filter(([, v]) => typeof v === 'number')
    .map(([k, v]) => `| ${k} | ${['accuracy', 'precision', 'recall', 'f1Score', 'rocAuc'].includes(k) ? pct(v as number) : (v as number).toFixed(4)} |`)
    .join('\n');
  const split = m.split;
  const evalText = split?.strategy === 'time'
    ? `Trained on rows up to ${split.trainUntil}; tested on ${split.testFrom} – ${split.testTo} (${split.testRows} rows).`
    : split?.strategy === 'group'
    ? `Tested on ${split.testGroups} “${split.groupColumn}” groups never seen in training (${split.testRows} rows).`
    : `Tested on ${split?.testRows ?? '?'} randomly held-out rows.`;
  const issues = m.gate.filter(g => g.status !== 'pass');
  return `# Model card: ${m.name} (v${m.version})

Created ${new Date(m.createdAt).toLocaleString()} with Data Science Studio.

## Intended use
${m.intendedUse.trim() || 'Not stated.'}

## Model
- Predicts: **${m.recipe.target}** (${m.task})
- Algorithm: ${m.algorithm}
- Features (${m.recipe.features.length}): ${m.recipe.features.join(', ')}
- Random seed: ${m.seed ?? m.recipe.hyperparameters.seed ?? 42}

## Training data
- Dataset: ${datasetName}
- Data version: ${dataLabel}
- ${evalText}

## Performance on held-out data
| Metric | Value |
|---|---|
${metrics}
${m.cv && typeof m.cv.mean === 'number' ? `\nCross-validation (${m.cv.folds ?? '?'} folds, ${m.cv.metric ?? ''}): ${m.cv.mean.toFixed(3)} ± ${(m.cv.std ?? 0).toFixed(3)}\n` : ''}
## Most important features
${m.topFeatures.slice(0, 5).map((f, i) => `${i + 1}. ${f.feature} (${(f.score * 100).toFixed(1)}%)`).join('\n') || 'Not available.'}

## Validation checks
${m.gate.map(g => `- ${g.status === 'pass' ? '✓' : g.status === 'warn' ? '⚠' : '✗'} ${g.title}: ${g.detail}`).join('\n')}

## Limitations
${issues.length ? issues.map(g => `- ${g.detail}`).join('\n') : '- None found by the automatic checks.'}
- Predictions are only as good as the training data; inputs outside the training ranges are less reliable.
- The model finds associations, not causes.
`;
}
