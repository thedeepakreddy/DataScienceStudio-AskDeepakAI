import { describe, expect, it } from 'vitest';
import { SqlError, runReadOnlySql, validateReadOnlySql } from './safeSql';

const rows = [
  { region: 'North', units: 10 }, { region: 'North', units: 5 }, { region: 'South', units: 8 },
];

describe('read-only SQL', () => {
  it('runs SELECT queries on the dataset', () => {
    const r = runReadOnlySql('SELECT region, SUM(units) AS [total] FROM dataset GROUP BY region ORDER BY [total] DESC;', rows);
    expect(r.rows).toEqual([{ region: 'North', total: 15 }, { region: 'South', total: 8 }]);
    expect(r.columns).toEqual(['region', 'total']);
  });

  it('allows CTEs, quoted names and keywords inside strings', () => {
    expect(() => validateReadOnlySql("WITH n AS (SELECT * FROM dataset WHERE region = 'DROP INTO') SELECT * FROM n")).not.toThrow();
    expect(runReadOnlySql('SELECT [units] FROM dataset WHERE units > 6', rows).rows).toHaveLength(2);
  });

  it('limits displayed rows and reports the total', () => {
    const r = runReadOnlySql('SELECT * FROM dataset', rows, 2);
    expect(r).toMatchObject({ total: 3, truncated: true });
    expect(r.rows).toHaveLength(2);
  });

  it.each([
    ['DROP TABLE dataset', 'Only SELECT'],
    ['SELECT * INTO CSV("x.csv") FROM dataset', 'INTO'],
    ['SELECT * FROM JSON("https://evil.example/x")', 'JSON'],
    ['SELECT * FROM dataset; DELETE FROM dataset', 'one query'],
    ['SELECT * FROM other', 'only table'],
    ['SELECT a->constructor FROM dataset', '->'],
    ['SELECT `x` FROM dataset', 'backticks'],
    ['SELECT * FROM ?', '?'],
    ["SELECT 'unclosed FROM dataset", 'never closed'],
  ])('rejects %s', (sql, reason) => {
    expect(() => validateReadOnlySql(sql)).toThrow(SqlError);
    expect(() => validateReadOnlySql(sql)).toThrow(reason);
  });

  it('never changes the input rows', () => {
    const input = [{ a: 1 }];
    runReadOnlySql('SELECT a, a + 1 AS b FROM dataset', input);
    expect(input).toEqual([{ a: 1 }]);
  });
});
