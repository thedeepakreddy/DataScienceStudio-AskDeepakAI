/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { createContext, useContext, useEffect, useState } from 'react';
import { Check, Pin } from 'lucide-react';
import { addPin, type PinView } from '../../utils/workspaceStore';

/** Which dataset (lineage) and version results are pinned to. Provided by the App. */
export const PinTargetContext = createContext<{ datasetId: string | null; versionId: string | null }>({ datasetId: null, versionId: null });

export interface PinInput {
  title: string;
  headline: string;
  view: PinView;
  capability: string;
  params: Record<string, unknown>;
  result: unknown;
}

/** “Pin to dashboard” for an engine result. Pinning the same result twice is a no-op. */
export default function PinButton({ pin, agent }: { pin: PinInput; agent?: string }) {
  const { datasetId, versionId } = useContext(PinTargetContext);
  const [state, setState] = useState<'idle' | 'saving' | 'pinned' | 'error'>('idle');
  const runId = (pin.result as { runId?: string } | null)?.runId;
  useEffect(() => setState('idle'), [runId]);
  if (!datasetId) return null;
  const save = async () => {
    setState('saving');
    try {
      await addPin({ ...pin, datasetId, versionId });
      setState('pinned');
    } catch {
      setState('error');
    }
  };
  return (
    <button type="button" className="btn btn-sm btn-secondary" onClick={save} disabled={state === 'saving' || state === 'pinned'} data-agent={agent}
      title="Show this result on the Dashboard; you can refresh it there when the data changes.">
      {state === 'pinned' ? <><Check className="w-3.5 h-3.5 text-green" /> Pinned to Dashboard</>
        : state === 'error' ? <><Pin className="w-3.5 h-3.5" /> Couldn’t pin — try again</>
          : <><Pin className="w-3.5 h-3.5" /> Pin to Dashboard</>}
    </button>
  );
}

/** The bottom of an engine result card: how it was computed, and pinning it. */
export function ResultFooter({ provenance, pin, agent }: { provenance: React.ReactNode; pin: PinInput; agent?: string }) {
  return (
    <div className="border-t border-separator pt-3 flex flex-wrap items-start justify-between gap-3">
      <div className="flex-1 min-w-[12rem]">{provenance}</div>
      <PinButton pin={pin} agent={agent} />
    </div>
  );
}
