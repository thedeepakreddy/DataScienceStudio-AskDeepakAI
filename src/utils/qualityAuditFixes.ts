/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

// The quality audit's fixes, from fixed rules over the audit's real counts: one
// issue per finding with a pandas line that fixes it. No AI is involved, so it
// runs instantly and gives the same answer every time.

export interface QualityIssue { issueName: string; severity: string; description: string; pythonFix: string }

/** A column name as a Python string literal. */
const py = (name: string) => `'${String(name).replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;

export function buildQualityFixes(auditSummary: any): QualityIssue[] {
  const fixes: QualityIssue[] = [];
  const columnIssues = Array.isArray(auditSummary?.columnIssues) ? auditSummary.columnIssues : [];
  const duplicateRows = auditSummary?.duplicateRows || 0;

  if (duplicateRows > 0) {
    fixes.push({
      issueName: 'Duplicate rows',
      severity: duplicateRows > (auditSummary?.totalRows || 0) * 0.05 ? 'High' : 'Medium',
      description: `Found ${duplicateRows} fully duplicate row(s) across the dataset.`,
      pythonFix: `df.drop_duplicates(inplace=True)`
    });
  }

  for (const col of columnIssues) {
    if (col.missingCount > 0) {
      fixes.push({
        issueName: `Missing values in ${col.name}`,
        severity: parseFloat(col.missingPercentage) > 30 ? 'High' : parseFloat(col.missingPercentage) > 10 ? 'Medium' : 'Low',
        description: `${col.missingCount} missing value(s) (${col.missingPercentage}) found in "${col.name}".`,
        pythonFix: `df[${py(col.name)}] = df[${py(col.name)}].fillna(df[${py(col.name)}].median() if pd.api.types.is_numeric_dtype(df[${py(col.name)}]) else df[${py(col.name)}].mode()[0])`
      });
    }
    if (col.isConstant) {
      fixes.push({
        issueName: `Constant column ${col.name}`,
        severity: 'Low',
        description: `"${col.name}" has only 1 unique value across all rows and carries no predictive signal.`,
        pythonFix: `df.drop(columns=[${py(col.name)}], inplace=True)`
      });
    }
    if (col.isHighCardinality) {
      fixes.push({
        issueName: `High cardinality in ${col.name}`,
        severity: 'Medium',
        description: `"${col.name}" has ${col.uniqueValues} distinct values relative to the row count, which can overwhelm one-hot encoding.`,
        pythonFix: `# Consider target/frequency encoding instead of one-hot for high-cardinality columns\nfreq = df[${py(col.name)}].value_counts(normalize=True)\ndf[${py(`${col.name}_freq_encoded`)}] = df[${py(col.name)}].map(freq)`
      });
    }
    if (col.typeMismatchWarning) {
      fixes.push({
        issueName: `Mixed types in ${col.name}`,
        severity: 'Medium',
        description: `"${col.name}" contains a mix of string and numeric values.`,
        pythonFix: `df[${py(col.name)}] = pd.to_numeric(df[${py(col.name)}], errors='coerce')`
      });
    }
  }

  return fixes;
}
