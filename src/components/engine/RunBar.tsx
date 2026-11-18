/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React from 'react';
import { AlertTriangle, Square } from 'lucide-react';
import Orb from '../Orb';
import type { CapabilityRun } from '../../engine/useCapability';

/**
 * The Run button every engine panel shares: live progress while the engine
 * works, a Stop button, and the engine's own explanation when it can't run.
 */
export default function RunBar({ run, label, onRun, disabled, agent }: {
  run: CapabilityRun<any>;
  label: string;
  onRun: () => void;
  disabled?: boolean;
  /** data-agent id, so the agent team can press it too. */
  agent?: string;
}) {
  const busy = run.phase === 'syncing' || run.phase === 'running';
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-3">
        <button type="button" className="btn btn-primary" onClick={onRun} disabled={busy || disabled} aria-busy={busy} data-agent={agent}>
          {busy ? <><Orb state={run.phase === 'syncing' ? 'connecting' : 'solving'} onAccent label={run.message} /> Working…</> : label}
        </button>
        {busy && (
          <button type="button" className="btn btn-plain" onClick={run.cancel}>
            <Square className="w-3.5 h-3.5" /> Stop
          </button>
        )}
        {busy && (
          <span className="text-sm text-label-2 min-w-0 truncate" aria-live="polite">
            {run.message}{run.progress !== null ? ` · ${Math.round(run.progress * 100)}%` : ''}
          </span>
        )}
      </div>
      {busy && run.progress !== null && (
        <div className="h-1 rounded-full bg-fill overflow-hidden" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(run.progress * 100)}>
          <div className="h-full bg-blue transition-[width] duration-500" style={{ width: `${Math.max(4, run.progress * 100)}%` }} />
        </div>
      )}
      {run.error && (
        <p role="alert" className="flex items-start gap-2 rounded-xl bg-red/10 px-3 py-2.5 text-sm text-red">
          <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" /> {run.error}
        </p>
      )}
    </div>
  );
}
