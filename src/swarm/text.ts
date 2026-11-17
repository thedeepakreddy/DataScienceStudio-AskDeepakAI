/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Dataset } from '../types';

// Reading column names out of a request (shared by the planner and the dashboard designer).

// Lower case, camelCase split, punctuation to spaces: "MonthlyCharges" -> "monthly charges".
export const norm = (s: string) => s.replace(/([a-z0-9])([A-Z])/g, '$1 $2').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

/** Columns named in the request, longest names first so "monthly charges" beats "charges". */
export function mentionedColumns(request: string, ds: Dataset): string[] {
  const text = ` ${norm(request)} `;
  const found: { name: string; at: number }[] = [];
  const names = [...ds.columns.map(c => c.name)].sort((a, b) => b.length - a.length);
  let masked = text;
  for (const name of names) {
    const variants = [` ${norm(name)} `, ` ${name.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()} `];
    const n = variants.find(v => v.trim() && masked.includes(v)) ?? variants[0];
    const at = n.trim() ? masked.indexOf(n) : -1;
    if (at >= 0) {
      found.push({ name, at });
      masked = masked.slice(0, at) + ' '.repeat(n.length) + masked.slice(at + n.length);
    }
  }
  return found.sort((a, b) => a.at - b.at).map(f => f.name);
}

