/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { Dataset, MLResult } from '../types';
import { isIdentifierColumn } from './csvParser';
import { computeCorrelationMatrix, detectDuplicateRecords, findExtremeOutliers } from './edaEngine';

// Findings for the report, computed from the dataset and the trained model's
// real results - never invented. Every number here can be traced back to the
// data or to the model's evaluation, and the same findings feed both the
// on-screen report and the PDF.

export type Level = 'High' | 'Medium' | 'Low';
export interface Finding { level: Level; title: string; detail: string }
export interface Recommendation { title: string; detail: string }

export interface ReportFindings {
  /** A factual description of the dataset. */
  summary: string;
  /** Notable facts about the data, each with its number. */
  observations: string[];
  /** Data and model risks, most serious first. */
  risks: Finding[];
  /** One action per risk, plus a next step. */
  recommendations: Recommendation[];
}

const pct = (part: number, whole: number) => (whole > 0 ? (part / whole) * 100 : 0);
const fmtPct = (v: number) => `${v < 10 ? v.toFixed(1) : Math.round(v)}%`;
const LEVEL_ORDER: Record<Level, number> = { High: 0, Medium: 1, Low: 2 };

export function computeReportFindings(dataset: Dataset, mlResult: MLResult | null): ReportFindings {
  const rows = dataset.rows;
  const cols = dataset.columns;
  const rowCount = rows.length;
  const numeric = cols.filter(c => c.type === 'numeric');
  const categorical = cols.filter(c => c.type === 'categorical' || c.type === 'boolean');
  const totalCells = rowCount * cols.length;
  const missingCells = cols.reduce((a, c) => a + (c.missingCount || 0), 0);
  const duplicateExtras = detectDuplicateRecords(rows).reduce((a, g) => a + (g.indices.length - 1), 0);

  const risks: Finding[] = [];
  const recommendations: Recommendation[] = [];
  const observations: string[] = [];

  // --- Data -----------------------------------------------------------------
  const summary =
    `${dataset.filename} has ${rowCount.toLocaleString()} rows and ${cols.length} columns ` +
    `(${numeric.length} numeric, ${categorical.length} categorical or true/false). ` +
    `${fmtPct(100 - pct(missingCells, totalCells))} of cells are filled` +
    (duplicateExtras > 0 ? ` and ${duplicateExtras} rows are exact duplicates.` : ' and every row is unique.');

  const missingCols = cols
    .filter(c => c.missingCount > 0)
    .map(c => ({ name: c.name, share: pct(c.missingCount, rowCount), count: c.missingCount }))
    .sort((a, b) => b.share - a.share);
  if (missingCols.length > 0) {
    observations.push(
      `Missing values in ${missingCols.length} column${missingCols.length === 1 ? '' : 's'}: ` +
      missingCols.slice(0, 3).map(m => `${m.name} (${m.count}, ${fmtPct(m.share)})`).join(', ') +
      (missingCols.length > 3 ? ', …' : '.'),
    );
    const worst = missingCols[0];
    if (worst.share >= 20) {
      risks.push({
        level: worst.share >= 40 ? 'High' : 'Medium',
        title: `“${worst.name}” is ${fmtPct(worst.share)} empty`,
        detail: `Analysis and models that use this column rely on a large share of filled-in or dropped values.`,
      });
      recommendations.push({
        title: `Decide how to handle “${worst.name}”`,
        detail: `Fill its ${worst.count} empty values in the Clean step, or remove the column if it isn’t needed.`,
      });
    } else {
      recommendations.push({
        title: 'Fill the remaining gaps',
        detail: `${missingCells} empty cell${missingCells === 1 ? '' : 's'} remain. Fill them in the Clean step before modeling.`,
      });
    }
  }

  if (duplicateExtras > 0) {
    risks.push({
      level: pct(duplicateExtras, rowCount) >= 5 ? 'Medium' : 'Low',
      title: `${duplicateExtras} duplicate row${duplicateExtras === 1 ? '' : 's'}`,
      detail: `Duplicates count some records twice, which skews totals and averages and can leak between model training and test data.`,
    });
    recommendations.push({ title: 'Remove duplicate rows', detail: `Check the ${duplicateExtras} repeated rows and remove them if they aren’t genuine repeats.` });
  }

  if (rowCount < 200) {
    risks.push({
      level: rowCount < 50 ? 'High' : 'Medium',
      title: `Small sample (${rowCount} rows)`,
      detail: `Statistics and model scores from this few rows can change a lot with new data. Treat them as early signals.`,
    });
    recommendations.push({ title: 'Collect more data', detail: `More rows would make the results more reliable; a few hundred is a sensible minimum for modeling.` });
  }

  const idCols = cols.filter(c => isIdentifierColumn(c, rowCount)).map(c => c.name);
  if (idCols.length > 0) {
    observations.push(`${idCols.join(', ')} ${idCols.length === 1 ? 'looks' : 'look'} like an ID — unique per row, not a measurement.`);
  }

  const constantCols = cols.filter(c => c.distinctCount <= 1).map(c => c.name);
  if (constantCols.length > 0) {
    risks.push({
      level: 'Low',
      title: `${constantCols.length} column${constantCols.length === 1 ? ' has' : 's have'} a single value`,
      detail: `${constantCols.join(', ')} never change${constantCols.length === 1 ? 's' : ''}, so ${constantCols.length === 1 ? 'it carries' : 'they carry'} no information.`,
    });
    recommendations.push({ title: 'Remove constant columns', detail: `Drop ${constantCols.join(', ')} in the Clean step.` });
  }

  const outliers = findExtremeOutliers(rows, cols)
    .filter(o => o.outliers.length > 0)
    .map(o => ({ name: o.columnName, n: o.outliers.length }))
    .sort((a, b) => b.n - a.n);
  if (outliers.length > 0) {
    observations.push(
      `Values far outside the typical range (1.5 × IQR): ` +
      outliers.slice(0, 3).map(o => `${o.name} (${o.n})`).join(', ') + (outliers.length > 3 ? ', …' : '.'),
    );
  }

  if (numeric.length >= 2) {
    const corr = computeCorrelationMatrix(rows, cols);
    let best: { a: string; b: string; r: number } | null = null;
    corr.features.forEach((a, i) => corr.features.forEach((b, j) => {
      const r = corr.matrix[a]?.[b];
      if (j > i && Number.isFinite(r) && (!best || Math.abs(r) > Math.abs(best.r))) {
        best = { a, b, r };
      }
    }));
    if (best) {
      const b = best as { a: string; b: string; r: number };
      observations.push(`Strongest relationship between numeric columns: ${b.a} and ${b.b} (correlation ${b.r.toFixed(2)}).`);
    }
  }

  // --- Model ----------------------------------------------------------------
  if (mlResult) {
    const m = mlResult.metrics || {};
    const isClassification = mlResult.modelType === 'classification';
    const score = isClassification ? m.accuracy : m.r2Score;
    const scoreLabel = isClassification ? 'accuracy' : 'R²';
    const target = (mlResult as any).target as string | undefined;
    const cv = (mlResult as any).cv as { mean?: number; std?: number; folds?: number; metric?: string } | undefined;

    if (typeof score === 'number') {
      observations.push(
        `${mlResult.modelAlgorithm}${target ? ` predicting ${target}` : ''}: ` +
        `${isClassification ? `${(score * 100).toFixed(1)}%` : score.toFixed(3)} ${scoreLabel} on held-out test data.`,
      );
    }

    // Does the classifier beat always guessing the most common class?
    if (isClassification && typeof m.accuracy === 'number' && target) {
      const values = rows.map(r => r[target]).filter(v => v !== null && v !== undefined && v !== '');
      if (values.length > 0) {
        const counts = new Map<string, number>();
        values.forEach(v => counts.set(String(v), (counts.get(String(v)) ?? 0) + 1));
        const majority = Math.max(...counts.values()) / values.length;
        if (m.accuracy <= majority + 0.02) {
          risks.push({
            level: 'High',
            title: 'The model barely beats guessing',
            detail: `Always predicting the most common value of ${target} would already be right ${fmtPct(majority * 100)} of the time; the model scores ${fmtPct(m.accuracy * 100)}.`,
          });
          recommendations.push({ title: 'Improve the model before using it', detail: `Try other features or algorithms, and judge it by F1 or recall rather than accuracy alone.` });
        }
        if (majority >= 0.8) {
          risks.push({
            level: 'Medium',
            title: `${target} is imbalanced`,
            detail: `${fmtPct(majority * 100)} of rows share one value, so accuracy can look high while the rarer outcome is missed.`,
          });
        }
      }
    }

    if (isClassification ? typeof m.accuracy === 'number' && m.accuracy < 0.6 : typeof m.r2Score === 'number' && m.r2Score < 0.3) {
      risks.push({
        level: 'Medium',
        title: 'Weak predictive power',
        detail: `A ${scoreLabel} of ${isClassification ? fmtPct((m.accuracy ?? 0) * 100) : (m.r2Score ?? 0).toFixed(3)} means the model explains little of what drives ${target ?? 'the target'}.`,
      });
    }

    if (cv && typeof cv.std === 'number' && typeof cv.mean === 'number' && cv.std > 0.05) {
      risks.push({
        level: 'Medium',
        title: 'Score varies between data samples',
        detail: `Across ${cv.folds ?? 'several'} cross-validation folds the score was ${cv.mean.toFixed(3)} ± ${cv.std.toFixed(3)}, so the test score depends on which rows were held out.`,
      });
    }

    const top = (mlResult.featureImportance || [])[0];
    if (top && top.score >= 0.5) {
      risks.push({
        level: 'Medium',
        title: `The model relies mostly on “${top.feature}”`,
        detail: `${fmtPct(top.score * 100)} of the model’s importance comes from one column. Check it isn’t a stand-in for the answer (data leakage).`,
      });
    }
    if (top && idCols.includes(top.feature)) {
      risks.push({
        level: 'High',
        title: `The model uses an ID column`,
        detail: `“${top.feature}” identifies rows rather than describing them; a model that depends on it won’t work on new records.`,
      });
      recommendations.push({ title: `Retrain without “${top.feature}”`, detail: `Untick it under "Using these columns" in the Model step.` });
    }
  } else {
    recommendations.push({ title: 'Train a model', detail: 'Go to the Model step to see how well this data predicts an outcome.' });
  }

  risks.sort((a, b) => LEVEL_ORDER[a.level] - LEVEL_ORDER[b.level]);
  if (risks.length === 0) {
    observations.push('No data-quality or model risks were detected by the automatic checks.');
  }

  return { summary, observations, risks, recommendations };
}
