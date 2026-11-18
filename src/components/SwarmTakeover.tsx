/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useEffect } from 'react';
import { Play, Square } from 'lucide-react';
import type { RunStatus } from '../swarm/runtime';
import { SWARM_CONTROL_EVENT, type SwarmControl } from '../swarm/interaction';

interface SwarmTakeoverProps {
  status: RunStatus | null;
  onPause: () => void;
  onResume: () => void;
  onCancel: () => void;
}

/**
 * Touching the page no longer pauses the agents: you stop them by clicking the
 * Orchestrator node on the tree (or pause them with the button beside it). This
 * listens for those controls and, while the team is paused, shows Resume / Stop.
 */
export default function SwarmTakeover({ status, onPause, onResume, onCancel }: SwarmTakeoverProps) {
  useEffect(() => {
    const onControl = (e: Event) => {
      const action = (e as CustomEvent<SwarmControl>).detail;
      if (action === 'stop') onCancel();
      else if (action === 'pause') onPause();
      else if (action === 'resume') onResume();
    };
    window.addEventListener(SWARM_CONTROL_EVENT, onControl);
    return () => window.removeEventListener(SWARM_CONTROL_EVENT, onControl);
  }, [onPause, onResume, onCancel]);

  if (status !== 'paused') return null;
  return (
    <div className="fixed top-4 left-1/2 -translate-x-1/2 z-[10000] material rounded-full shadow-xl pl-4 pr-1.5 py-1.5 flex items-center gap-2 text-sm text-label" role="status" data-swarm-ui>
      <span>Agents paused</span>
      <button type="button" className="btn btn-sm btn-primary" onClick={onResume}><Play className="w-3.5 h-3.5" /> Resume</button>
      <button type="button" className="btn btn-sm btn-plain" onClick={onCancel}><Square className="w-3.5 h-3.5" /> Stop</button>
    </div>
  );
}
