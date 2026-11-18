/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { RotateCw } from 'lucide-react';
import { engine, type ModelMeta } from '../../engine/client';
import { num } from '../stats/methodKit';

// ------------------------------------------------------------------ names for metrics
export const METRIC_LABELS: Record<string, string> = {
  roc_auc: 'ROC AUC', rocAuc: 'ROC AUC', f1_macro: 'F1 (macro)', f1Macro: 'F1 (macro)', accuracy: 'Accuracy', balanced_accuracy: 'Balanced accuracy',
  balancedAccuracy: 'Balanced accuracy', neg_log_loss: 'Log loss', logLoss: 'Log loss', average_precision: 'Average precision', prAuc: 'PR AUC',
  r2: 'R²', neg_root_mean_squared_error: 'RMSE', rmse: 'RMSE', neg_mean_absolute_error: 'MAE', mae: 'MAE', mape: 'MAPE', f1: 'F1', precision: 'Precision',
  recall: 'Recall', mcc: 'MCC', brier: 'Brier score', f1Weighted: 'F1 (weighted)',
};
export const metricLabel = (k: string) => METRIC_LABELS[k] ?? k;
/** sklearn reports error metrics as negatives so that higher is better; show them positive. */
export const metricValue = (scoring: string, v: number | null | undefined) => (v == null ? null : scoring.startsWith('neg_') ? -v : v);

export const modelName = (m: Pick<ModelMeta, 'id' | 'name' | 'version' | 'label'>) => (m.name ? `${m.name} v${m.version}` : `${m.label} · ${m.id.slice(-6)}`);

export const STAGE_LABELS: Record<string, string> = { none: 'Draft', staging: 'Staging', production: 'Production', archived: 'Archived' };
export const STAGE_CLASS: Record<string, string> = {
  none: 'bg-fill text-label-2', staging: 'bg-orange/12 text-orange', production: 'bg-green/12 text-green', archived: 'bg-fill text-label-3',
};
export const StageBadge = ({ stage }: { stage: string }) => (
  <span className={`inline-flex px-2 py-0.5 rounded-full text-xs font-medium ${STAGE_CLASS[stage] ?? STAGE_CLASS.none}`}>{STAGE_LABELS[stage] ?? stage}</span>
);

// ------------------------------------------------------------------ shared list of saved models
interface ModelsState {
  models: ModelMeta[];
  loading: boolean;
  error: string | null;
  refresh: () => Promise<void>;
  /** The model the stage is working with (just trained, or picked). */
  selected: string | null;
  select: (id: string | null) => void;
}

const Ctx = createContext<ModelsState | null>(null);

export function ModelsProvider({ children }: { children: React.ReactNode }) {
  const [models, setModels] = useState<ModelMeta[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const list = await engine.models.list();
      list.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
      setModels(list);
      setError(null);
      setSelected(s => (s && list.some(m => m.id === s) ? s : list[0]?.id ?? null));
    } catch (err) {
      setError((err as Error)?.message || 'Could not load saved models.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { refresh(); }, [refresh]);

  const value = useMemo(() => ({ models, loading, error, refresh, selected, select: setSelected }), [models, loading, error, refresh, selected]);
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useModels(): ModelsState {
  const v = useContext(Ctx);
  if (!v) throw new Error('useModels needs a ModelsProvider');
  return v;
}

/** Which saved model to use; shared across the Explain, Predict and Monitor tabs. */
export function ModelPicker({ id, label = 'Model', filter }: { id: string; label?: string; filter?: (m: ModelMeta) => boolean }) {
  const { models, selected, select, loading, refresh, error } = useModels();
  const list = filter ? models.filter(filter) : models;
  const current = list.find(m => m.id === selected);
  return (
    <div>
      <label className="field-label" htmlFor={id}>{label}</label>
      <div className="flex items-center gap-2">
        <select id={id} className="input" value={current?.id ?? ''} onChange={e => select(e.target.value || null)} disabled={!list.length}>
          {!list.length && <option value="">{loading ? 'Loading models…' : 'No saved models yet'}</option>}
          {list.length > 0 && !current && <option value="">Choose a model</option>}
          {list.map(m => (
            <option key={m.id} value={m.id}>
              {modelName(m)} — predicts {m.target}{m.stage !== 'none' ? ` · ${STAGE_LABELS[m.stage]}` : ''}
            </option>
          ))}
        </select>
        <button type="button" className="btn btn-icon w-9 h-9 shrink-0" aria-label="Reload saved models" onClick={refresh} title="Reload saved models">
          <RotateCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} />
        </button>
      </div>
      {error && <p className="mt-1 text-xs text-red">{error}</p>}
    </div>
  );
}

export function useSelectedModel(): ModelMeta | null {
  const { models, selected } = useModels();
  return models.find(m => m.id === selected) ?? null;
}

/** One-line summary of how good a saved model is. */
export function modelScore(m: ModelMeta): string {
  const t = m.testMetrics ?? {};
  if (m.task === 'classification') return [t.rocAuc != null && `ROC AUC ${num(t.rocAuc)}`, t.accuracy != null && `accuracy ${num(t.accuracy)}`].filter(Boolean).join(' · ');
  return [t.r2 != null && `R² ${num(t.r2)}`, t.rmse != null && `RMSE ${num(t.rmse)}`].filter(Boolean).join(' · ');
}
