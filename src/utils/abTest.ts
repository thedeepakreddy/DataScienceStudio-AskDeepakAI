/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { normalCdf, normalQuantile } from './normal';

export interface AbInput {
  controlSize: number;
  controlRate: number;
  treatmentSize: number;
  treatmentRate: number;
  confidence: number;
  testType: 'two-tailed' | 'one-tailed';
}

/** Two-proportion z-test with the exact normal p-value and the minimum detectable effect at 80% power. */
export function abTest({ controlSize: n1, controlRate: p1, treatmentSize: n2, treatmentRate: p2, confidence, testType }: AbInput) {
  const pPool = (p1 * n1 + p2 * n2) / (n1 + n2);
  const sePool = Math.sqrt(pPool * (1 - pPool) * (1 / n1 + 1 / n2));
  const zScore = sePool > 0 ? (p2 - p1) / sePool : 0;
  // One-tailed tests whether the treatment is better than the control.
  const pValue = testType === 'two-tailed' ? 2 * (1 - normalCdf(Math.abs(zScore))) : 1 - normalCdf(zScore);
  const relativeLift = p1 > 0 ? ((p2 - p1) / p1) * 100 : 0;
  const alpha = 1 - confidence;
  const zAlpha = normalQuantile(1 - (testType === 'two-tailed' ? alpha / 2 : alpha));
  const mdeAbs = (zAlpha + normalQuantile(0.8)) * Math.sqrt(p1 * (1 - p1) * (1 / n1 + 1 / n2));
  const mdeRel = p1 > 0 ? (mdeAbs / p1) * 100 : 0;
  return {
    zScore: zScore.toFixed(3),
    pValue: pValue < 0.0001 ? '< 0.0001' : pValue.toFixed(4),
    pValueNumber: pValue,
    relativeLift: relativeLift.toFixed(2),
    isSignificant: pValue < alpha,
    mde: `${mdeRel.toFixed(1)}% relative (${(mdeAbs * 100).toFixed(2)} pts) at 80% power`,
  };
}
