/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useMemo, useState } from 'react';
import type { Dataset } from '../../types';
import MethodPanel, { type BuiltinMethod } from '../stats/MethodPanel';
import ForecastPanel from '../ForecastPanel';
import AutoMLPanel from './AutoMLPanel';
import ExplainPanel from './ExplainPanel';
import MonitorPanel from './MonitorPanel';
import PredictPanel from './PredictPanel';
import RegistryPanel from './RegistryPanel';
import ScenariosPanel from './ScenariosPanel';
import { ModelsProvider, useModels } from './models';

export type ModelTab = 'train' | 'automl' | 'registry' | 'explain' | 'predict' | 'monitor' | 'forecast' | 'decide';

// "train" keeps the existing quick-model workflow (the agent team drives it via model-tab-train).
const TABS: { id: ModelTab; label: string; hint: string }[] = [
  { id: 'train', label: 'Quick model', hint: 'Train one model you choose, in seconds, and keep its versions.' },
  { id: 'automl', label: 'AutoML', hint: 'Let the engine try every model family and pick the best, with honest error bars.' },
  { id: 'registry', label: 'Models', hint: 'Your saved models: versions, stages, approvals and model cards.' },
  { id: 'explain', label: 'Explain', hint: 'Why a model predicts what it does.' },
  { id: 'predict', label: 'Predict', hint: 'Score one case or the whole dataset with a saved model.' },
  { id: 'monitor', label: 'Monitor', hint: 'Is a model still valid on new data?' },
  { id: 'forecast', label: 'Forecast', hint: 'Predict how a number will move over time.' },
  { id: 'decide', label: 'Decide', hint: 'Turn uncertainty and limits into a decision: simulate, optimise, ask what-if.' },
];

function Stage({ dataset, train, onUseDataset }: { dataset: Dataset; train: React.ReactNode; onUseDataset?: (d: Dataset, summary: string) => void }) {
  const [tab, setTab] = useState<ModelTab>('train');
  const [visited, setVisited] = useState<Set<ModelTab>>(() => new Set(['train']));
  const { select } = useModels();
  const open = (t: ModelTab, modelId?: string) => {
    if (modelId) select(modelId);
    setTab(t);
    setVisited(v => (v.has(t) ? v : new Set([...v, t])));
  };

  const builtins = useMemo<Record<string, BuiltinMethod>>(() => ({
    quick: { title: 'Quick forecast (in the browser)', answers: '', render: () => <ForecastPanel dataset={dataset} /> },
    scenarios: { title: 'What-if with a model', answers: '', render: () => <ScenariosPanel dataset={dataset} /> },
  }), [dataset]);

  const current = TABS.find(t => t.id === tab)!;
  const render = (t: ModelTab) => {
    switch (t) {
      case 'train': return train;
      case 'automl': return <AutoMLPanel dataset={dataset} onOpen={open} />;
      case 'registry': return <RegistryPanel onOpen={open} />;
      case 'explain': return <ExplainPanel dataset={dataset} />;
      case 'predict': return <PredictPanel dataset={dataset} onUseDataset={onUseDataset} />;
      case 'monitor': return <MonitorPanel dataset={dataset} />;
      case 'forecast': return <MethodPanel group="forecast" dataset={dataset} builtins={builtins} />;
      case 'decide': return <MethodPanel group="decide" dataset={dataset} builtins={builtins} />;
    }
  };

  return (
    <div className="space-y-6">
      <div className="space-y-2">
        <div className="overflow-x-auto scrollbar-none -mx-4 px-4 sm:mx-0 sm:px-0">
          <div className="segmented w-max" role="tablist" aria-label="Model tools">
            {TABS.map(t => (
              <button key={t.id} type="button" role="tab" data-agent={`model-tab-${t.id}`} aria-selected={tab === t.id} onClick={() => open(t.id)}>
                {t.label}
              </button>
            ))}
          </div>
        </div>
        <p className="text-sm text-label-2">{current.hint}</p>
      </div>
      {TABS.filter(t => visited.has(t.id)).map(t => (
        <div key={t.id} hidden={tab !== t.id}>{render(t.id)}</div>
      ))}
    </div>
  );
}

/** The Model step: train, compare, explain, deploy, predict, monitor — plus forecasting and decisions. */
export default function ModelStage(props: { dataset: Dataset; train: React.ReactNode; onUseDataset?: (d: Dataset, summary: string) => void }) {
  return <ModelsProvider><Stage {...props} /></ModelsProvider>;
}
