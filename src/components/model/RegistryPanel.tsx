/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useEffect, useState } from 'react';
import { Download, FileText, Lightbulb, Send, Trash2 } from 'lucide-react';
import { engine, type ModelMeta, type ModelStage } from '../../engine/client';
import Orb from '../Orb';
import { num, pct } from '../stats/methodKit';
import { STAGE_LABELS, StageBadge, metricLabel, metricValue, modelName, modelScore, useModels, useSelectedModel } from './models';

const STAGE_HELP: Record<ModelStage, string> = {
  none: 'A draft: not used anywhere yet.',
  staging: 'Being tried out before going live.',
  production: 'The approved version that predictions use (name@production).',
  archived: 'Retired, kept for the record.',
};

function ModelDetail({ model, onOpen }: { model: ModelMeta; onOpen: (tab: 'explain' | 'predict' | 'monitor', id: string) => void }) {
  const { refresh, select } = useModels();
  const [name, setName] = useState(model.name ?? '');
  const [description, setDescription] = useState(model.description ?? '');
  const [stage, setStage] = useState<ModelStage>(model.stage);
  const [approver, setApprover] = useState('');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [card, setCard] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);

  // A different model: start afresh. The same model saved/reloaded: just take its new values.
  useEffect(() => { setApprover(''); setNote(''); setError(null); setCard(null); setConfirmDelete(false); }, [model.id]);
  useEffect(() => { setName(model.name ?? ''); setDescription(model.description ?? ''); setStage(model.stage); }, [model.id, model.name, model.description, model.stage]);

  const dirty = name !== (model.name ?? '') || description !== (model.description ?? '') || stage !== model.stage;
  const needsName = (stage === 'staging' || stage === 'production') && !name.trim();
  const needsApprover = stage === 'production' && model.stage !== 'production' && !approver.trim();

  const act = async (label: string, fn: () => Promise<unknown>, reload = true) => {
    setBusy(label); setError(null);
    try { await fn(); if (reload) await refresh(); } catch (err) { setError((err as Error)?.message || 'That didn’t work.'); } finally { setBusy(null); }
  };

  const save = () => act('save', () => engine.models.update(model.id, {
    ...(name !== (model.name ?? '') ? { name: name.trim() } : {}),
    ...(description !== (model.description ?? '') ? { description } : {}),
    ...(stage !== model.stage ? { stage, ...(approver.trim() ? { approved_by: approver.trim() } : {}), ...(note.trim() ? { note: note.trim() } : {}) } : {}),
  }));

  const showCard = () => act('card', async () => setCard((await engine.models.card(model.id)).markdown), false);
  const downloadCard = () => {
    if (!card) return;
    const url = URL.createObjectURL(new Blob([card], { type: 'text/markdown' }));
    const a = Object.assign(document.createElement('a'), { href: url, download: `${(model.name ?? model.id).replace(/\W+/g, '-')}-model-card.md` });
    a.click();
    URL.revokeObjectURL(url);
  };
  const remove = () => act('delete', async () => { await engine.models.remove(model.id); select(null); });

  const metrics = Object.entries(model.testMetrics ?? {}).slice(0, 8);
  return (
    <div className="card p-4 sm:p-5 space-y-5 animate-fade-in" aria-label={`Model ${modelName(model)}`} role="region">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h3 className="card-title flex items-center gap-2 flex-wrap">{modelName(model)} <StageBadge stage={model.stage} /></h3>
          <p className="mt-1 text-sm text-label-2">{model.label} predicting <b className="text-label">{model.target}</b> from {model.features.length} columns · trained {new Date(model.createdAt).toLocaleString()}</p>
          {model.approvedBy && <p className="text-xs text-label-3 mt-0.5">Approved for production by {model.approvedBy}{model.approvedAt ? ` on ${new Date(model.approvedAt).toLocaleDateString()}` : ''}.</p>}
        </div>
        <div className="flex flex-wrap gap-2">
          <button type="button" className="btn btn-sm btn-secondary" onClick={() => onOpen('explain', model.id)}><Lightbulb className="w-3.5 h-3.5" /> Explain</button>
          <button type="button" className="btn btn-sm btn-secondary" onClick={() => onOpen('predict', model.id)}><Send className="w-3.5 h-3.5" /> Predict</button>
          <button type="button" className="btn btn-sm btn-secondary" onClick={() => onOpen('monitor', model.id)}>Monitor</button>
        </div>
      </div>

      <dl className="grid grid-cols-2 lg:grid-cols-4 gap-px bg-separator rounded-xl overflow-hidden">
        {[[`${metricLabel(model.scoring)} (cross-validated)`, num(metricValue(model.scoring, model.cvMean))] as const, ...metrics.map(([k, v]) => [`${metricLabel(k)} (test)`, num(v)] as const)].slice(0, 8).map(([k, v]) => (
          <div key={k} className="bg-surface px-4 py-3"><dt className="text-xs text-label-2">{k}</dt><dd className="mt-0.5 text-[17px] font-semibold tabular-nums text-label">{v}</dd></div>
        ))}
      </dl>
      {model.conformal && <p className="text-xs text-label-3">Prediction {model.task === 'classification' ? 'sets' : 'ranges'} cover the truth {pct(model.conformal.testCoverage)} of the time on test rows.{model.threshold != null ? ` Decision cut-off ${pct(model.threshold)}.` : ''}</p>}

      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        <div>
          <label className="field-label" htmlFor="reg-name">Name</label>
          <input id="reg-name" className="input" value={name} placeholder="Needed for staging and production" onChange={e => setName(e.target.value)} />
        </div>
        <div>
          <label className="field-label" htmlFor="reg-stage">Stage</label>
          <select id="reg-stage" className="input" value={stage} data-agent="registry-stage" onChange={e => setStage(e.target.value as ModelStage)}>
            {(['none', 'staging', 'production', 'archived'] as ModelStage[]).map(s => <option key={s} value={s}>{STAGE_LABELS[s]}</option>)}
          </select>
          <p className="mt-1 text-xs text-label-3">{STAGE_HELP[stage]}</p>
        </div>
        {stage === 'production' && model.stage !== 'production' && (
          <>
            <div>
              <label className="field-label" htmlFor="reg-approver">Approved by</label>
              <input id="reg-approver" className="input" value={approver} placeholder="Your name" onChange={e => setApprover(e.target.value)} />
            </div>
            <div>
              <label className="field-label" htmlFor="reg-note">Why it’s ready (optional)</label>
              <input id="reg-note" className="input" value={note} onChange={e => setNote(e.target.value)} />
            </div>
          </>
        )}
        <div className="sm:col-span-2 lg:col-span-4">
          <label className="field-label" htmlFor="reg-desc">Description</label>
          <textarea id="reg-desc" className="input min-h-[4.5rem]" value={description} placeholder="What it’s for, what data it was trained on, known limits" onChange={e => setDescription(e.target.value)} />
        </div>
      </div>
      {stage === 'production' && model.stage !== 'production' && <p className="text-xs text-label-3">Promoting moves any other production version of {name || 'this name'} to archived.</p>}

      <div className="flex flex-wrap items-center gap-2">
        <button type="button" className="btn btn-primary" disabled={!dirty || needsName || needsApprover || !!busy} onClick={save} data-agent="registry-save">
          {busy === 'save' ? <><Orb state="solving" onAccent label="Saving" /> Saving…</> : 'Save changes'}
        </button>
        <button type="button" className="btn btn-secondary" disabled={!!busy} onClick={showCard}><FileText className="w-4 h-4" /> Model card</button>
        <a className="btn btn-secondary" href={engine.models.downloadUrl(model.id)} download><Download className="w-4 h-4" /> Download model</a>
        {confirmDelete ? (
          <span className="flex items-center gap-2">
            <span className="text-sm text-label-2">Delete for good?</span>
            <button type="button" className="btn btn-sm bg-red text-white" disabled={!!busy} onClick={remove}>Delete</button>
            <button type="button" className="btn btn-sm btn-plain" onClick={() => setConfirmDelete(false)}>Keep</button>
          </span>
        ) : (
          <button type="button" className="btn btn-plain text-red" disabled={model.stage === 'production' || !!busy} title={model.stage === 'production' ? 'Archive it first' : undefined} onClick={() => setConfirmDelete(true)}><Trash2 className="w-4 h-4" /> Delete</button>
        )}
      </div>
      {(needsName || needsApprover) && dirty && <p className="text-xs text-label-3">{needsName ? 'Give the model a name before staging or production.' : 'Enter who approved this promotion.'}</p>}
      {error && <p className="text-sm text-red">{error}</p>}

      {card && (
        <div className="space-y-2">
          <div className="flex items-center justify-between gap-2">
            <h4 className="text-sm font-semibold text-label">Model card</h4>
            <button type="button" className="btn btn-sm btn-plain" onClick={downloadCard}><Download className="w-3.5 h-3.5" /> Save as Markdown</button>
          </div>
          <pre className="text-xs leading-relaxed bg-fill rounded-xl p-3 overflow-x-auto whitespace-pre-wrap text-label max-h-[28rem]">{card}</pre>
        </div>
      )}
    </div>
  );
}

export default function RegistryPanel({ onOpen }: { onOpen: (tab: 'explain' | 'predict' | 'monitor', id: string) => void }) {
  const { models, loading, error, selected, select } = useModels();
  const current = useSelectedModel();
  return (
    <div className="space-y-6" data-agent="area-registry">
      <div className="card p-4 sm:p-5 space-y-3">
        <div>
          <h3 className="card-title">Saved models</h3>
          <p className="mt-1 text-sm text-label-2">Every model trained with AutoML, with its version, stage and scores. Promote one to production when it’s approved.</p>
        </div>
        {loading && !models.length && <p className="text-sm text-label-2">Loading…</p>}
        {error && <p className="text-sm text-red">{error}</p>}
        {!loading && !models.length && !error && <p className="text-sm text-label-2">No saved models yet. Train one in the AutoML tab.</p>}
        {models.length > 0 && (
          <div className="overflow-x-auto -mx-1">
            <table className="w-full text-sm">
              <thead><tr className="text-left text-xs text-label-2"><th className="py-1.5 px-1 font-medium">Model</th><th className="py-1.5 px-1 font-medium">Predicts</th><th className="py-1.5 px-1 font-medium">Stage</th><th className="py-1.5 px-1 font-medium">Test scores</th><th className="py-1.5 px-1 font-medium">Trained</th></tr></thead>
              <tbody className="divide-y divide-separator">
                {models.map(m => (
                  <tr key={m.id} className={`cursor-pointer ${selected === m.id ? 'bg-blue/8' : 'hover:bg-fill/60'}`} onClick={() => select(m.id)} aria-selected={selected === m.id}>
                    <td className="py-2 px-1"><button type="button" className="text-left font-medium text-label" onClick={() => select(m.id)}>{modelName(m)}</button><div className="text-xs text-label-3">{m.label}</div></td>
                    <td className="py-2 px-1 text-label-2">{m.target}</td>
                    <td className="py-2 px-1"><StageBadge stage={m.stage} /></td>
                    <td className="py-2 px-1 text-label-2 tabular-nums whitespace-nowrap">{modelScore(m) || '—'}</td>
                    <td className="py-2 px-1 text-label-3 whitespace-nowrap">{new Date(m.createdAt).toLocaleDateString()}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
      {current && <ModelDetail model={current} onOpen={onOpen} />}
    </div>
  );
}
