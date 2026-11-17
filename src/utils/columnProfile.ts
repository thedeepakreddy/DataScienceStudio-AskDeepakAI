/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Dataset, DatasetColumn } from '../types';

export const isEmpty = (v: unknown) => v === null || v === undefined || v === '' || (typeof v === 'number' && Number.isNaN(v));

/**
 * Column metadata (missing and distinct counts, numeric summary, most common
 * values) computed from the rows. The one implementation used by the importer
 * and by every data operation, so the numbers always agree.
 */
export function profileColumn(name: string, type: DatasetColumn['type'], rows: Record<string, any>[]): DatasetColumn {
  const filled = rows.map(r => r[name]).filter(v => !isEmpty(v));
  const statistics: DatasetColumn['statistics'] = {};

  if (type === 'numeric') {
    const nums = filled.map(Number).filter(Number.isFinite);
    if (nums.length > 0) {
      let min = nums[0];
      let max = nums[0];
      let sum = 0;
      for (const v of nums) {
        if (v < min) min = v;
        if (v > max) max = v;
        sum += v;
      }
      const mean = sum / nums.length;
      const sorted = [...nums].sort((a, b) => a - b);
      const mid = Math.floor(sorted.length / 2);
      const median = sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
      const stdDev = Math.sqrt(nums.reduce((a, v) => a + (v - mean) ** 2, 0) / nums.length);
      statistics.min = round4(min);
      statistics.max = round4(max);
      statistics.mean = round4(mean);
      statistics.median = round4(median);
      statistics.stdDev = round4(stdDev);
    }
  }

  const counts = new Map<string, number>();
  for (const v of filled) counts.set(String(v), (counts.get(String(v)) ?? 0) + 1);
  statistics.mostCommon = [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([value, count]) => ({ value, count }));

  return {
    name,
    type,
    missingCount: rows.length - filled.length,
    distinctCount: counts.size,
    statistics,
  };
}

const round4 = (n: number) => parseFloat(n.toFixed(4));

/**
 * A dataset with fresh metadata for the given rows. Column types are kept
 * from `typeOf` (existing columns) so an operation never silently retypes data.
 */
export function rebuildDataset(
  base: Dataset,
  rows: Record<string, any>[],
  columns: { name: string; type: DatasetColumn['type'] }[],
): Dataset {
  return {
    ...base,
    rows,
    rowCount: rows.length,
    columns: columns.map(c => profileColumn(c.name, c.type, rows)),
  };
}
