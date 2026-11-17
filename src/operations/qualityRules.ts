/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Dataset } from '../types';
import { isEmpty } from '../utils/columnProfile';

// Data quality rules: checks a user defines once ("age is between 0 and 120",
// "email matches a pattern") and that are re-checked on every version.

export type RuleKind = 'not_empty' | 'unique' | 'range' | 'allowed_values' | 'pattern';

export interface QualityRule {
  id: string;
  column: string;
  kind: RuleKind;
  min?: number;
  max?: number;
  allowed?: string[];
  pattern?: string;
}

export interface RuleResult {
  rule: QualityRule;
  /** Plain description of the rule. */
  label: string;
  /** Indices of rows that break it. */
  failing: number[];
  /** Set when the rule can't be checked (e.g. its column was removed). */
  problem?: string;
}

export function describeRule(r: QualityRule): string {
  switch (r.kind) {
    case 'not_empty': return `“${r.column}” is never empty`;
    case 'unique': return `“${r.column}” has no repeated values`;
    case 'range':
      if (r.min !== undefined && r.max !== undefined) return `“${r.column}” is between ${r.min} and ${r.max}`;
      if (r.min !== undefined) return `“${r.column}” is at least ${r.min}`;
      return `“${r.column}” is at most ${r.max}`;
    case 'allowed_values': return `“${r.column}” is one of: ${(r.allowed ?? []).join(', ')}`;
    case 'pattern': return `“${r.column}” matches ${r.pattern}`;
  }
}

/** Throws with a plain message if the rule is incomplete. */
export function validateRule(r: QualityRule) {
  if (r.kind === 'range' && r.min === undefined && r.max === undefined) throw new Error('Enter a minimum, a maximum or both.');
  if (r.kind === 'range' && r.min !== undefined && r.max !== undefined && r.min > r.max) throw new Error('The minimum is larger than the maximum.');
  if (r.kind === 'allowed_values' && !(r.allowed ?? []).length) throw new Error('List at least one allowed value.');
  if (r.kind === 'pattern') {
    if (!r.pattern) throw new Error('Enter a pattern.');
    try { new RegExp(r.pattern); } catch { throw new Error('That pattern isn’t a valid regular expression.'); }
  }
}

export function evaluateRules(ds: Dataset, rules: QualityRule[]): RuleResult[] {
  return rules.map(rule => {
    const label = describeRule(rule);
    if (!ds.columns.some(c => c.name === rule.column)) {
      return { rule, label, failing: [], problem: `Column “${rule.column}” no longer exists.` };
    }
    const values = ds.rows.map(r => r[rule.column]);
    const failing: number[] = [];
    switch (rule.kind) {
      case 'not_empty':
        values.forEach((v, i) => { if (isEmpty(v)) failing.push(i); });
        break;
      case 'unique': {
        const firstSeen = new Map<string, number>();
        values.forEach((v, i) => {
          if (isEmpty(v)) return;
          const k = String(v);
          if (firstSeen.has(k)) failing.push(i);
          else firstSeen.set(k, i);
        });
        break;
      }
      case 'range':
        values.forEach((v, i) => {
          if (isEmpty(v)) return;
          const n = Number(v);
          if (!Number.isFinite(n) || (rule.min !== undefined && n < rule.min) || (rule.max !== undefined && n > rule.max)) failing.push(i);
        });
        break;
      case 'allowed_values': {
        const allowed = new Set((rule.allowed ?? []).map(a => a.trim().toLowerCase()));
        values.forEach((v, i) => { if (!isEmpty(v) && !allowed.has(String(v).trim().toLowerCase())) failing.push(i); });
        break;
      }
      case 'pattern': {
        let re: RegExp;
        try { re = new RegExp(rule.pattern ?? ''); } catch {
          return { rule, label, failing: [], problem: 'The pattern isn’t a valid regular expression.' };
        }
        values.forEach((v, i) => { if (!isEmpty(v) && !re.test(String(v))) failing.push(i); });
        break;
      }
    }
    return { rule, label, failing };
  });
}
