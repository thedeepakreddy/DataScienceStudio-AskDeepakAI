/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useEffect, useState } from 'react';
import { RefreshCw } from 'lucide-react';
import { aiKeyHeaders } from '../utils/aiKey';
import Orb from './Orb';

export interface AiModelInfo {
  source: 'built-in' | 'google'; tier?: 'free' | 'latest'; updatedAt: number | null; models: string[]; error: string | null;
  tested?: { model: string; outcome: 'free' | 'paid' | 'busy' | 'unavailable' | 'bad_key' }[];
}

/**
 * "Update to latest model": the server asks Google which Gemini models exist
 * now, switches to the newest suitable one and tries it at once. No code change
 * or redeploy is needed when Google retires a model.
 */
export default function AiModelUpdate({ models, onUpdated, compact = false }: { models?: AiModelInfo | null; onUpdated?: () => void; compact?: boolean }) {
  const [busy, setBusy] = useState<null | 'free' | 'latest'>(null);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const [info, setInfo] = useState<AiModelInfo | null>(models ?? null);
  useEffect(() => { if (models) setInfo(models); }, [models]);

  const update = async (tier: 'free' | 'latest') => {
    setBusy(tier); setMessage(null);
    try {
      const res = await fetch('/api/ai/refresh-models', { method: 'POST', headers: { ...aiKeyHeaders(), 'Content-Type': 'application/json' }, body: JSON.stringify({ tier }), cache: 'no-store' });
      const body = await res.json().catch(() => null);
      if (body?.models) setInfo(body.models);
      setMessage({ ok: !!body?.ok, text: body?.message || `The update failed (HTTP ${res.status}).` });
      onUpdated?.();
    } catch {
      setMessage({ ok: false, text: 'Could not reach the server.' });
    } finally { setBusy(null); }
  };

  const current = info?.models?.[0];
  const paid = (info?.tested ?? []).filter(t => t.outcome === 'paid').map(t => t.model);
  const button = (tier: 'free' | 'latest', label: string, agent: string, primary = false) => (
    <button type="button" onClick={() => update(tier)} disabled={!!busy} data-agent={agent} className={`btn btn-sm ${primary ? 'btn-primary' : 'btn-secondary'} shrink-0`}
      title={tier === 'free' ? 'Tests the newest models with one tiny request each and keeps the newest ones your key can use for free.' : 'The newest models Google offers; they may need billing.'}>
      {busy === tier ? <><Orb state="listening" label="Updating the model" /> {tier === 'free' ? 'Testing free models…' : 'Updating…'}</> : <><RefreshCw className="w-3.5 h-3.5" /> {label}</>}
    </button>
  );
  return (
    <div className={compact ? 'contents' : 'space-y-2'}>
      {!compact && current && (
        <p className="text-xs text-label-2">
          Model: <b className="text-label">{current}</b>{' · '}
          {info?.source !== 'google' ? 'built-in list' : info?.tier === 'free' ? 'free tier, tested on your key' : 'latest (may need billing)'}
          {info?.updatedAt ? ` · checked ${new Date(info.updatedAt).toLocaleString()}` : ''}
          {paid.length > 0 && <span className="block text-label-3">Needs billing on this key: {paid.join(', ')}.</span>}
        </p>
      )}
      <div className={compact ? 'contents' : 'flex flex-wrap gap-2'}>
        {button('free', 'Update to latest free model', 'ai-update-free-model', !compact)}
        {button('latest', 'Update to latest model', 'ai-update-model')}
      </div>
      {message && <p role="status" className={`text-xs ${message.ok ? 'text-green' : 'text-red'} ${compact ? 'basis-full' : ''}`}>{message.text}</p>}
    </div>
  );
}
