/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useEffect, useState } from 'react';
import { RefreshCw } from 'lucide-react';
import { aiKeyHeaders } from '../utils/aiKey';
import Orb from './Orb';

export interface AiModelInfo { source: 'built-in' | 'google'; updatedAt: number | null; models: string[]; error: string | null }

/**
 * "Update to latest model": the server asks Google which Gemini models exist
 * now, switches to the newest suitable one and tries it at once. No code change
 * or redeploy is needed when Google retires a model.
 */
export default function AiModelUpdate({ models, onUpdated, compact = false }: { models?: AiModelInfo | null; onUpdated?: () => void; compact?: boolean }) {
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const [info, setInfo] = useState<AiModelInfo | null>(models ?? null);
  useEffect(() => { if (models) setInfo(models); }, [models]);

  const update = async () => {
    setBusy(true); setMessage(null);
    try {
      const res = await fetch('/api/ai/refresh-models', { method: 'POST', headers: aiKeyHeaders(), cache: 'no-store' });
      const body = await res.json().catch(() => null);
      if (body?.models) setInfo(body.models);
      setMessage({ ok: !!body?.ok, text: body?.message || `The update failed (HTTP ${res.status}).` });
      onUpdated?.();
    } catch {
      setMessage({ ok: false, text: 'Could not reach the server.' });
    } finally { setBusy(false); }
  };

  const current = info?.models?.[0];
  return (
    <div className={compact ? 'contents' : 'space-y-1.5'}>
      {!compact && current && (
        <p className="text-xs text-label-2">
          Model: <b className="text-label">{current}</b>{info?.source === 'google' ? ' (newest from Google' : ' (built-in list'}
          {info?.updatedAt ? `, checked ${new Date(info.updatedAt).toLocaleString()})` : ')'}
        </p>
      )}
      <button type="button" onClick={update} disabled={busy} data-agent="ai-update-model" className="btn btn-sm btn-secondary shrink-0">
        {busy ? <><Orb state="listening" label="Updating the model" /> Updating…</> : <><RefreshCw className="w-3.5 h-3.5" /> Update to latest model</>}
      </button>
      {message && <p role="status" className={`text-xs ${message.ok ? 'text-green' : 'text-red'} ${compact ? 'basis-full' : ''}`}>{message.text}</p>}
    </div>
  );
}
