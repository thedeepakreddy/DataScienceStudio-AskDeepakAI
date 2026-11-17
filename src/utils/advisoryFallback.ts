/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

// The dataset advisory used when Gemini is unavailable. Everything in it is
// derived from the column statistics that were sent - names, types, missing
// counts, distinct counts, means and most common values - so it never states
// a finding the data doesn't support. Shared by the server and the browser.

export interface AdvisoryColumn {
  name: string;
  type: string;
  missingCount?: number;
  distinctCount?: number;
  statistics?: {
    mean?: number;
    median?: number;
    min?: number;
    max?: number;
    mostCommon?: { value: string; count: number }[];
  };
}

const TARGET_HINT = /(^|[_\s-])(target|label|outcome|churn|y|class|default|fraud|converted|survived)([_\s-]|$)/i;
const ID_HINT = /(^|[\s_-])(id|uuid|guid)$|^id[\s_-]|[a-z](ID|Id)$/;

const fmt = (n: number) =>
  Math.abs(n) >= 1000 ? Math.round(n).toLocaleString() : Number.isInteger(n) ? String(n) : n.toFixed(2);

export function buildAdvisoryFallback(filename: string, columns: AdvisoryColumn[], rowCount: number) {
  const cols = Array.isArray(columns) ? columns : [];
  const isId = (c: AdvisoryColumn) =>
    c.type !== 'boolean' && (ID_HINT.test(c.name) || (c.type === 'categorical' && rowCount >= 10 && c.distinctCount === rowCount - (c.missingCount ?? 0)));
  const usable = cols.filter(c => !isId(c) && (c.distinctCount ?? 2) > 1);

  // Target: a column named like an outcome, else the last true/false column,
  // else the last numeric column.
  const target =
    usable.find(c => TARGET_HINT.test(c.name)) ??
    [...usable].reverse().find(c => c.type === 'boolean') ??
    [...usable].reverse().find(c => c.type === 'numeric') ??
    usable[usable.length - 1];

  const classification =
    !!target && (target.type === 'boolean' || (target.type === 'categorical' && (target.distinctCount ?? 99) <= 10));

  const features = usable.filter(c => c !== target).slice(0, 6).map(c => c.name);

  // Segment by the categorical column with the fewest groups (2+), which gives
  // the clearest comparison.
  const slicer = usable
    .filter(c => (c.type === 'categorical' || c.type === 'boolean') && (c.distinctCount ?? 0) >= 2 && (c.distinctCount ?? 0) <= 12 && c !== target)
    .sort((a, b) => (a.distinctCount ?? 0) - (b.distinctCount ?? 0))[0];

  const missing = cols
    .filter(c => (c.missingCount ?? 0) > 0)
    .sort((a, b) => (b.missingCount ?? 0) - (a.missingCount ?? 0));
  const focus = missing[0] ?? target;

  const insights: string[] = [];
  if (missing.length > 0) {
    insights.push(
      `${missing.length} of ${cols.length} columns have missing values; the most is ${missing[0].name} with ${missing[0].missingCount} of ${rowCount} rows empty.`,
    );
  } else {
    insights.push(`No missing values in any of the ${cols.length} columns.`);
  }
  if (target) {
    const top = target.statistics?.mostCommon?.[0];
    if (classification && top && rowCount > 0) {
      insights.push(`${target.name}: the most common value is "${top.value}" in ${top.count} of ${rowCount} rows (${Math.round((top.count / rowCount) * 100)}%).`);
    } else if (target.type === 'numeric' && typeof target.statistics?.mean === 'number') {
      const s = target.statistics;
      insights.push(
        `${target.name} averages ${fmt(s.mean!)}` +
        (typeof s.min === 'number' && typeof s.max === 'number' ? `, ranging from ${fmt(s.min)} to ${fmt(s.max)}.` : '.'),
      );
    }
  }
  const ids = cols.filter(isId).map(c => c.name);
  if (ids.length > 0) {
    insights.push(`${ids.join(', ')} ${ids.length === 1 ? 'is an identifier' : 'are identifiers'} and should not be used as model features.`);
  }

  return {
    source: 'rules' as const,
    overviewSummary:
      `${filename} has ${rowCount.toLocaleString()} rows and ${cols.length} columns. ` +
      `This summary was built from the column statistics because AI analysis is unavailable.`,
    recommendedTarget: target?.name ?? 'unknown_target',
    modelType: classification ? 'classification' : 'regression',
    suggestedFeatures: features,
    scientistFocus: focus?.name ?? '',
    scientistRationale: missing[0]
      ? `${missing[0].name} has the most missing values (${missing[0].missingCount}); decide how to fill or drop them before modeling.`
      : `${target?.name ?? 'The target'} is the suggested column to predict; check its distribution before training.`,
    strategicSlicer: slicer?.name ?? 'None',
    insights,
  };
}
