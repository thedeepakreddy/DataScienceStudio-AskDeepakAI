/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

// The small sample the agent welcome works on, and the real calculations its
// agents run: every number the welcome shows is computed here, from these rows.

import { seeded } from './welcomeLayout';

export interface DemoRow { id: number; plan: 'Monthly' | 'Yearly'; tenure: number | null; charges: number | null; churned: 'Yes' | 'No' }

/** 20 customers: short-tenure monthly customers leave more often. Two cells are blank. */
export function demoRows(seed = 42): DemoRow[] {
  const r = seeded(seed);
  const rows: DemoRow[] = [];
  for (let i = 0; i < 20; i++) {
    const plan = r() < 0.55 ? 'Monthly' : 'Yearly';
    const tenure = Math.round(1 + r() * (plan === 'Monthly' ? 30 : 58));
    const charges = Math.round((plan === 'Monthly' ? 75 : 45) + (r() - 0.5) * 40 - tenure * 0.25);
    const risk = (plan === 'Monthly' ? 0.55 : 0.1) + (tenure < 12 ? 0.3 : 0) - tenure / 150;
    rows.push({ id: 1001 + i, plan, tenure, charges, churned: r() < risk ? 'Yes' : 'No' });
  }
  rows[1].charges = null;
  rows[4].tenure = null;
  return rows;
}

export function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

/** Fills each blank with its column's median; returns the rows and what was filled. */
export function fillBlanks(rows: DemoRow[]) {
  const t = median(rows.map(x => x.tenure).filter((x): x is number => x != null));
  const c = median(rows.map(x => x.charges).filter((x): x is number => x != null));
  const fills: { row: number; col: 'tenure' | 'charges'; value: number }[] = [];
  const out = rows.map((x, i) => {
    const y = { ...x };
    if (y.tenure == null) { y.tenure = t; fills.push({ row: i, col: 'tenure', value: t }); }
    if (y.charges == null) { y.charges = c; fills.push({ row: i, col: 'charges', value: c }); }
    return y;
  });
  return { rows: out, fills };
}

export function pearson(a: number[], b: number[]): number {
  const n = a.length, ma = a.reduce((s, x) => s + x, 0) / n, mb = b.reduce((s, x) => s + x, 0) / n;
  let num = 0, da = 0, db = 0;
  for (let i = 0; i < n; i++) { num += (a[i] - ma) * (b[i] - mb); da += (a[i] - ma) ** 2; db += (b[i] - mb) ** 2; }
  return da && db ? num / Math.sqrt(da * db) : 0;
}

/**
 * A tiny model: the best single rule "churns if tenure < t (and plan is Monthly)",
 * chosen on the first 14 rows and scored on the 6 it never saw.
 */
export function trainStump(rows: DemoRow[]) {
  const train = rows.slice(0, 14), test = rows.slice(14);
  const predict = (x: DemoRow, t: number, monthlyOnly: boolean) => ((x.tenure ?? 0) < t && (!monthlyOnly || x.plan === 'Monthly') ? 'Yes' : 'No');
  let best = { t: 0, monthlyOnly: false, acc: -1 };
  for (const monthlyOnly of [false, true]) for (let t = 2; t <= 60; t++) {
    const acc = train.filter(x => predict(x, t, monthlyOnly) === x.churned).length / train.length;
    if (acc > best.acc) best = { t, monthlyOnly, acc };
  }
  const accuracy = test.filter(x => predict(x, best.t, best.monthlyOnly) === x.churned).length / test.length;
  return { rule: `${best.monthlyOnly ? 'Monthly plan and ' : ''}tenure under ${best.t} months`, trainAccuracy: best.acc, accuracy, testRows: test.length };
}

export function churnByPlan(rows: DemoRow[]) {
  return (['Monthly', 'Yearly'] as const).map(plan => {
    const g = rows.filter(x => x.plan === plan);
    return { plan, rate: g.length ? g.filter(x => x.churned === 'Yes').length / g.length : 0, n: g.length };
  });
}

/** Everything the welcome shows, computed once. */
export function demoResults(seed = 42) {
  const raw = demoRows(seed);
  const { rows, fills } = fillBlanks(raw);
  const r = pearson(rows.map(x => x.tenure!), rows.map(x => x.charges!));
  return { raw, rows, fills, r, model: trainStump(rows), byPlan: churnByPlan(rows) };
}
