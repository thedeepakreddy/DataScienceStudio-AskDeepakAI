/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useMemo, useState } from 'react';
import { Dataset } from '../types';
import HypothesisLab from './HypothesisLab';
import ABTestInterpreter from './ABTestInterpreter';
import StatsCompare, { SessionTest } from './StatsCompare';
import StatsRegression from './StatsRegression';
import StatsPower from './StatsPower';
import MethodPanel, { type BuiltinMethod } from './stats/MethodPanel';
import type { GroupId } from './stats/methods';

// Tab ids "compare", "regression" and "power" are kept: the agent team drives them.
const GROUPS: { id: GroupId; label: string; hint: string }[] = [
  { id: 'compare', label: 'Compare', hint: 'Is a difference between two columns or groups real?' },
  { id: 'regression', label: 'Relationships', hint: 'Which factors move an outcome, and by how much?' },
  { id: 'causal', label: 'Causal effect', hint: 'What did a treatment, change or rule actually cause?' },
  { id: 'power', label: 'Experiments', hint: 'Plan, monitor and read A/B tests.' },
  { id: 'survival', label: 'Survival', hint: 'How long until something happens, and what changes it?' },
  { id: 'bayesian', label: 'Bayesian', hint: 'Answers as probabilities: how likely is each conclusion?' },
  { id: 'hypothesis', label: 'AI hypotheses', hint: 'Let AI suggest what to test in your data.' },
];

/** The Statistics step: is a difference, relationship or effect real, or chance? */
export default function StatisticsStage({ dataset }: { dataset: Dataset }) {
  const [view, setView] = useState<GroupId>('compare');
  // Tests run in this visit, for multiple-comparison correction.
  const [sessionTests, setSessionTests] = useState<SessionTest[]>([]);

  const builtins = useMemo<Record<GroupId, Record<string, BuiltinMethod>>>(() => ({
    compare: { quick: { title: 'Compare two columns', answers: '', render: () => <StatsCompare dataset={dataset} sessionTests={sessionTests} onTestRun={t => setSessionTests(prev => [...prev, t])} /> } },
    regression: { quick: { title: 'Linear / logistic regression', answers: '', render: () => <StatsRegression dataset={dataset} /> } },
    power: {
      quick: { title: 'Sample size & power', answers: '', render: () => <StatsPower /> },
      interpret: { title: 'Explain my test numbers (AI)', answers: '', render: () => <ABTestInterpreter /> },
    },
    causal: {}, survival: {}, bayesian: {},
    hypothesis: { quick: { title: 'AI hypotheses', answers: '', render: () => <HypothesisLab dataset={dataset} /> } },
  }), [dataset, sessionTests]);

  const current = GROUPS.find(g => g.id === view)!;
  return (
    <div className="space-y-6">
      <div className="space-y-2">
        <div className="overflow-x-auto scrollbar-none -mx-4 px-4 sm:mx-0 sm:px-0">
          <div className="segmented w-max" role="tablist" aria-label="Statistics tools">
            {GROUPS.map(tab => (
              <button key={tab.id} type="button" role="tab" data-agent={`stats-tab-${tab.id}`} aria-selected={view === tab.id} onClick={() => setView(tab.id)}>
                {tab.label}
              </button>
            ))}
          </div>
        </div>
        <p className="text-sm text-label-2">{current.hint}</p>
      </div>
      {GROUPS.map(g => (
        <div key={g.id} hidden={view !== g.id}>
          <MethodPanel group={g.id} dataset={dataset} builtins={builtins[g.id]} />
        </div>
      ))}
    </div>
  );
}
