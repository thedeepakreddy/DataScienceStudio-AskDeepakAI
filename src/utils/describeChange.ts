/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Dataset } from '../types';

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;
const list = (names: string[]) =>
  names.length <= 2 ? names.map(n => `“${n}”`).join(' and ') : `${names.length} columns`;

/**
 * Describes, in plain words, how one version of a dataset differs from the
 * previous one - used to label versions in the history. Works purely from the
 * two datasets, so the label is always true to what changed.
 */
export function describeChange(prev: Dataset | null, next: Dataset): string {
  if (!prev) return 'Imported';
  const prevCols = prev.columns.map(c => c.name);
  const nextCols = next.columns.map(c => c.name);
  const removed = prevCols.filter(c => !nextCols.includes(c));
  const added = nextCols.filter(c => !prevCols.includes(c));
  const parts: string[] = [];

  if (removed.length === 1 && added.length === 1 && prevCols.length === nextCols.length) {
    parts.push(`Renamed “${removed[0]}” to “${added[0]}”`);
  } else {
    if (removed.length) parts.push(`Removed ${list(removed)}`);
    if (added.length) parts.push(`Added ${list(added)}`);
  }

  const dRows = next.rows.length - prev.rows.length;
  if (dRows < 0) parts.push(`Removed ${plural(-dRows, 'row')}`);
  if (dRows > 0) parts.push(`Added ${plural(dRows, 'row')}`);

  // Same shape: count the cells whose value changed in the shared columns.
  if (parts.length === 0 || (dRows === 0 && (removed.length || added.length))) {
    const shared = nextCols.filter(c => prevCols.includes(c));
    const n = Math.min(prev.rows.length, next.rows.length);
    let changed = 0;
    const changedCols = new Set<string>();
    for (let i = 0; i < n; i++) {
      for (const c of shared) {
        if (!sameValue(prev.rows[i]?.[c], next.rows[i]?.[c])) {
          changed++;
          changedCols.add(c);
        }
      }
    }
    if (changed > 0) {
      parts.push(`Changed ${plural(changed, 'value')}${changedCols.size <= 2 ? ` in ${list([...changedCols])}` : ` in ${changedCols.size} columns`}`);
    }
  }

  return parts.length ? parts.join(', ') : 'No changes';
}

function sameValue(a: unknown, b: unknown) {
  const empty = (v: unknown) => v === null || v === undefined || v === '';
  if (empty(a) && empty(b)) return true;
  return a === b;
}
