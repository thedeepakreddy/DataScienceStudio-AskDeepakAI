/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState } from 'react';
import { Dataset } from '../types';
import HypothesisLab from './HypothesisLab';
import ABTestInterpreter from './ABTestInterpreter';
import StatsCompare, { SessionTest } from './StatsCompare';
import StatsRegression from './StatsRegression';
import StatsPower from './StatsPower';

type View = 'compare' | 'regression' | 'power' | 'hypothesis' | 'abtest';

/** The Statistics step: is a difference or relationship real, or chance? */
export default function StatisticsStage({ dataset }: { dataset: Dataset }) {
  const [view, setView] = useState<View>('compare');
  // Tests run in this visit, for multiple-comparison correction.
  const [sessionTests, setSessionTests] = useState<SessionTest[]>([]);

  return (
    <div className="space-y-6">
      <div className="overflow-x-auto scrollbar-none -mx-4 px-4 sm:mx-0 sm:px-0">
        <div className="segmented w-max" role="tablist" aria-label="Statistics tools">
          {([
            { id: 'compare', label: 'Compare & relate' },
            { id: 'regression', label: 'Regression' },
            { id: 'power', label: 'Sample size' },
            { id: 'hypothesis', label: 'AI hypotheses' },
            { id: 'abtest', label: 'A/B test' },
          ] as { id: View; label: string }[]).map(tab => (
            <button
              key={tab.id}
              type="button"
              role="tab"
              data-agent={`stats-tab-${tab.id}`}
              aria-selected={view === tab.id}
              onClick={() => setView(tab.id)}
            >
              {tab.label}
            </button>
          ))}
        </div>
      </div>

      {view === 'compare' && (
        <StatsCompare dataset={dataset} sessionTests={sessionTests} onTestRun={t => setSessionTests(prev => [...prev, t])} />
      )}
      {view === 'regression' && <StatsRegression dataset={dataset} />}
      {view === 'power' && <StatsPower />}
      {view === 'hypothesis' && <HypothesisLab dataset={dataset} />}
      {view === 'abtest' && <ABTestInterpreter />}
    </div>
  );
}
