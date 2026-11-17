/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState } from 'react';
import { Dataset } from '../types';
import HypothesisLab from './HypothesisLab';
import ABTestInterpreter from './ABTestInterpreter';

type View = 'hypothesis' | 'abtest';

/** The Statistics step: is a difference or relationship real, or chance? */
export default function StatisticsStage({ dataset }: { dataset: Dataset }) {
  const [view, setView] = useState<View>('hypothesis');

  return (
    <div className="space-y-6">
      <div className="overflow-x-auto scrollbar-none -mx-4 px-4 sm:mx-0 sm:px-0">
        <div className="segmented w-max" role="tablist" aria-label="Statistics tools">
          {([
            { id: 'hypothesis', label: 'Test a hypothesis' },
            { id: 'abtest', label: 'A/B test' },
          ] as { id: View; label: string }[]).map(tab => (
            <button
              key={tab.id}
              type="button"
              role="tab"
              aria-selected={view === tab.id}
              onClick={() => setView(tab.id)}
            >
              {tab.label}
            </button>
          ))}
        </div>
      </div>

      {view === 'hypothesis' && <HypothesisLab dataset={dataset} />}
      {view === 'abtest' && <ABTestInterpreter />}
    </div>
  );
}
