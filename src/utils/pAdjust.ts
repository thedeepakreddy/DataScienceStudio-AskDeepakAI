/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

// Multiple-comparison corrections: running many tests makes some "significant"
// by chance, so p-values are adjusted for how many tests were run.

export type AdjustMethod = 'holm' | 'bonferroni' | 'fdr_bh';

export const ADJUST_LABELS: Record<AdjustMethod, string> = {
  holm: 'Holm (controls false positives, recommended)',
  bonferroni: 'Bonferroni (strictest)',
  fdr_bh: 'Benjamini–Hochberg (controls the false discovery rate)',
};

/** Adjusted p-values in the same order as the input. */
export function adjustPValues(pValues: number[], method: AdjustMethod): number[] {
  const m = pValues.length;
  if (m === 0) return [];
  const order = pValues.map((p, i) => ({ p, i })).sort((a, b) => a.p - b.p);
  const out = new Array<number>(m);
  if (method === 'bonferroni') {
    return pValues.map(p => Math.min(1, p * m));
  }
  if (method === 'holm') {
    let running = 0;
    order.forEach(({ p, i }, rank) => {
      running = Math.max(running, Math.min(1, (m - rank) * p));
      out[i] = running;
    });
    return out;
  }
  // Benjamini-Hochberg: step up from the largest p-value.
  let running = 1;
  for (let rank = m - 1; rank >= 0; rank--) {
    const { p, i } = order[rank];
    running = Math.min(running, (p * m) / (rank + 1));
    out[i] = Math.min(1, running);
  }
  return out;
}

/** "< 0.001" for tiny p-values, otherwise 3 significant decimals. */
export function formatP(p: number | null | undefined): string {
  if (p === null || p === undefined || !Number.isFinite(p)) return '—';
  if (p < 0.001) return '< 0.001';
  return p.toFixed(3);
}
