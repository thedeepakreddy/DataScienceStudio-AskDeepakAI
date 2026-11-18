import { describe, expect, it } from 'vitest';
import { buildQualityFixes } from './qualityAuditFixes';

describe('quality audit fixes (rules, no AI)', () => {
  it('turns each finding into an issue with a pandas fix', () => {
    const fixes = buildQualityFixes({ totalRows: 100, duplicateRows: 10, columnIssues: [
      { name: 'age', missingCount: 40, missingPercentage: '40.00%', isConstant: false, isHighCardinality: false, typeMismatchWarning: false },
      { name: 'plan', missingCount: 0, isConstant: true },
      { name: "owner's id", missingCount: 0, typeMismatchWarning: true },
    ] });
    expect(fixes.map(f => [f.issueName, f.severity])).toEqual([
      ['Duplicate rows', 'High'], ['Missing values in age', 'High'], ['Constant column plan', 'Low'], ["Mixed types in owner's id", 'Medium'],
    ]);
    expect(fixes[2].pythonFix).toBe("df.drop(columns=['plan'], inplace=True)");
    // Quotes in a column name are escaped, so the fix is valid Python.
    expect(fixes[3].pythonFix).toBe("df['owner\\'s id'] = pd.to_numeric(df['owner\\'s id'], errors='coerce')");
  });
  it('finds nothing in clean data', () => {
    expect(buildQualityFixes({ totalRows: 5, duplicateRows: 0, columnIssues: [] })).toEqual([]);
  });
});
