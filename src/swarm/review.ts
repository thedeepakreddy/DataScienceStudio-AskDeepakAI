/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Dataset, MLResult } from '../types';
import { isEmpty } from '../utils/columnProfile';
import { detectDuplicateRecords } from '../utils/edaEngine';
import { gateBlocks, validationGate } from '../utils/modelRegistry';

// The Verification Agent's independent review (blueprint 9.3). It checks a
// result with a different method from the one that produced it, so a pass
// is evidence the producer couldn't give itself: a permutation test for a
// statistical test, the validation gate for a model, a recount for large
// data removals. Disagreement is reported as a contradiction, never hidden.

export interface ReviewOutcome { agrees: boolean; detail: string; method: string }

/** Small seeded generator so a review gives the same answer every time. */
function rng(seed: number) {
  let s = seed >>> 0;
  return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 2 ** 32; };
}

function shuffle<T>(arr: T[], rand: () => number) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

const isNum = (ds: Dataset, c: string) => ds.columns.find(x => x.name === c)?.type === 'numeric';

/** Statistic measuring how strongly x and y go together, for the permutation test. */
function statistic(xs: unknown[], ys: unknown[], xNum: boolean, yNum: boolean): number {
  if (xNum && yNum) {
    const a = xs.map(Number), b = ys.map(Number);
    const ma = a.reduce((s, v) => s + v, 0) / a.length, mb = b.reduce((s, v) => s + v, 0) / b.length;
    let num = 0, da = 0, db = 0;
    for (let i = 0; i < a.length; i++) { num += (a[i] - ma) * (b[i] - mb); da += (a[i] - ma) ** 2; db += (b[i] - mb) ** 2; }
    return da && db ? Math.abs(num / Math.sqrt(da * db)) : 0;
  }
  if (xNum !== yNum) {
    // Between-group sum of squares of the numeric column across the groups.
    const vals = (xNum ? xs : ys).map(Number);
    const groups = (xNum ? ys : xs).map(String);
    const mean = vals.reduce((s, v) => s + v, 0) / vals.length;
    const by = new Map<string, number[]>();
    groups.forEach((g, i) => by.set(g, [...(by.get(g) ?? []), vals[i]]));
    let ss = 0;
    by.forEach(v => { const m = v.reduce((s, x) => s + x, 0) / v.length; ss += v.length * (m - mean) ** 2; });
    return ss;
  }
  // Chi-squared statistic of the two category columns.
  const a = xs.map(String), b = ys.map(String);
  const n = a.length;
  const ca = new Map<string, number>(), cb = new Map<string, number>(), cab = new Map<string, number>();
  a.forEach((v, i) => { ca.set(v, (ca.get(v) ?? 0) + 1); cb.set(b[i], (cb.get(b[i]) ?? 0) + 1); const k = `${v}\u0000${b[i]}`; cab.set(k, (cab.get(k) ?? 0) + 1); });
  let chi = 0;
  ca.forEach((na, va) => cb.forEach((nb, vb) => { const e = (na * nb) / n; const o = cab.get(`${va}\u0000${vb}`) ?? 0; chi += (o - e) ** 2 / e; }));
  return chi;
}

/** Permutation test: how often does shuffling one column give as strong a link? */
export function permutationTest(ds: Dataset, a: string, b: string, permutations = 999, seed = 7): { pValue: number; n: number } {
  let rows = ds.rows.filter(r => !isEmpty(r[a]) && !isEmpty(r[b]));
  if (rows.length > 5000) rows = rows.filter((_, i) => i % Math.ceil(rows.length / 5000) === 0);
  const xs = rows.map(r => r[a]);
  const ys = rows.map(r => r[b]);
  const xNum = isNum(ds, a), yNum = isNum(ds, b);
  const observed = statistic(xs, ys, xNum, yNum);
  const rand = rng(seed);
  let atLeast = 0;
  for (let i = 0; i < permutations; i++) if (statistic(xs, shuffle(ys, rand), xNum, yNum) >= observed - 1e-12) atLeast++;
  return { pValue: (atLeast + 1) / (permutations + 1), n: rows.length };
}

export function reviewTest(ds: Dataset, params: { columnA: string; columnB: string; alpha?: number }, result: { pValue?: number; test?: string }): ReviewOutcome {
  const alpha = params.alpha ?? 0.05;
  const perm = permutationTest(ds, params.columnA, params.columnB);
  const producer = Number(result.pValue);
  const sigPerm = perm.pValue < alpha;
  const sigProd = producer < alpha;
  const borderline = Math.abs(perm.pValue - alpha) < 0.01 || Math.abs(producer - alpha) < 0.01;
  return {
    method: 'Permutation test (999 shuffles, a different method from the producer’s)',
    agrees: sigPerm === sigProd || borderline,
    detail: `Permutation p ≈ ${perm.pValue.toFixed(3)} on ${perm.n} rows vs ${result.test} p = ${producer.toFixed(3)}: ${sigPerm === sigProd ? 'same conclusion' : borderline ? 'different, but both are near the threshold' : 'different conclusions'}.`,
  };
}

export function reviewModel(model: MLResult | null, ds: Dataset): ReviewOutcome {
  if (!model) return { method: 'Validation gate', agrees: false, detail: 'No trained model was found to review.' };
  const gate = validationGate(model, ds);
  const fails = gate.filter(g => g.status === 'fail');
  const warns = gate.filter(g => g.status === 'warn');
  return {
    method: 'Validation gate (baseline, leakage, ID columns, stability)',
    agrees: !gateBlocks(gate),
    detail: fails.length
      ? `Fails: ${fails.map(f => `${f.title} — ${f.detail}`).join(' ')}`
      : `Passes: beats the baseline and shows no leakage${warns.length ? `; warnings: ${warns.map(w => w.title).join(', ')}` : ''}.`,
  };
}

export function reviewDataChange(capability: string, params: any, ds: Dataset): ReviewOutcome {
  if (capability === 'data.remove_duplicates') {
    const left = detectDuplicateRecords(ds.rows).length;
    return { method: 'Independent recount of duplicates', agrees: left === 0, detail: left === 0 ? 'No duplicate rows remain.' : `${left} duplicate groups remain.` };
  }
  if (capability === 'data.filter_rows') {
    const v = params.value;
    const ok = (x: unknown) => {
      switch (params.operator) {
        case 'is_empty': return isEmpty(x);
        case 'is_not_empty': return !isEmpty(x);
        case 'greater_than': return Number(x) > Number(v);
        case 'less_than': return Number(x) < Number(v);
        case 'contains': return !isEmpty(x) && String(x).toLowerCase().includes(String(v).toLowerCase());
        case 'not_equals': return isEmpty(x) || String(x).toLowerCase() !== String(v).toLowerCase();
        default: return !isEmpty(x) && String(x).toLowerCase() === String(v).toLowerCase();
      }
    };
    const bad = ds.rows.filter(r => !ok(r[params.column])).length;
    return { method: 'Independent check of every kept row', agrees: bad === 0, detail: bad === 0 ? `All ${ds.rows.length} kept rows match.` : `${bad} kept rows don’t match the condition.` };
  }
  return { method: 'Recount', agrees: true, detail: `${ds.rows.length} rows × ${ds.columns.length} columns.` };
}

/** Whether a finished task should get an independent review (risk-based, 9.3). */
export function needsReview(capability: string, before: Dataset | null, after: Dataset | null): boolean {
  if (capability === 'stats.compare' || capability === 'models.train') return true;
  if ((capability === 'data.filter_rows' || capability === 'data.remove_duplicates') && before && after) {
    return after.rows.length < before.rows.length * 0.8; // removed 20% or more
  }
  return false;
}
