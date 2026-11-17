import { describe, expect, it } from 'vitest';
import { evaluateRules, validateRule } from './qualityRules';
import { parseCSV } from '../utils/csvParser';

const ds = parseCSV(`id,age,email,plan
1,34,a@x.com,pro
2,150,bad,basic
2,,c@x.com,PRO
3,-1,d@x.com,gold`, 'u.csv');

describe('quality rules', () => {
  it('finds the rows that break each rule', () => {
    const res = evaluateRules(ds, [
      { id: 'a', column: 'age', kind: 'range', min: 0, max: 120 },
      { id: 'b', column: 'age', kind: 'not_empty' },
      { id: 'c', column: 'id', kind: 'unique' },
      { id: 'd', column: 'email', kind: 'pattern', pattern: '^[^@]+@[^@]+$' },
      { id: 'e', column: 'plan', kind: 'allowed_values', allowed: ['pro', 'basic'] },
      { id: 'f', column: 'gone', kind: 'not_empty' },
    ]);
    expect(res.map(r => r.failing)).toEqual([[1, 3], [2], [2], [1], [3], []]);
    expect(res[5].problem).toContain('no longer exists');
    expect(res[0].label).toBe('“age” is between 0 and 120');
  });

  it('validates incomplete rules', () => {
    expect(() => validateRule({ id: 'x', column: 'a', kind: 'range' })).toThrow('minimum');
    expect(() => validateRule({ id: 'x', column: 'a', kind: 'pattern', pattern: '(' })).toThrow('valid regular');
  });
});
