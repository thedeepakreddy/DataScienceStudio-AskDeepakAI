/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useEffect, useState } from 'react';
import { Play, Square } from 'lucide-react';
import type { RunStatus } from '../swarm/runtime';

interface SwarmTakeoverProps {
  status: RunStatus | null;
  onPause: () => void;
  onResume: () => void;
  onCancel: () => void;
}

/**
 * The user always wins the page (blueprint 11.8): a real click or key press
 * outside the agents' own controls pauses the team at its next step, so
 * nobody fights over the same control. The agents resume only when asked.
 */
export default function SwarmTakeover({ status, onPause, onResume, onCancel }: SwarmTakeoverProps) {
  const [takenOver, setTakenOver] = useState(false);

  useEffect(() => {
    if (status !== 'running') return;
    const onInput = (e: Event) => {
      // Agents' clicks are synthetic (isTrusted is false); only a person's count.
      if (!e.isTrusted) return;
      const target = e.target as Element | null;
      if (!target || target === document.documentElement || target.closest?.('[data-swarm-ui]')) return;
      if (e instanceof KeyboardEvent && ['Shift', 'Control', 'Alt', 'Meta', 'Tab'].includes(e.key)) return;
      setTakenOver(true);
      onPause();
    };
    window.addEventListener('pointerdown', onInput, true);
    window.addEventListener('keydown', onInput, true);
    return () => {
      window.removeEventListener('pointerdown', onInput, true);
      window.removeEventListener('keydown', onInput, true);
    };
  }, [status, onPause]);

  // Once the team is running again (or stopped), the takeover is over.
  const [seen, setSeen] = useState(status);
  if (seen !== status) {
    setSeen(status);
    if (status !== 'paused') setTakenOver(false);
  }

  if (!takenOver || status !== 'paused') return null;
  return (
    <div className="fixed top-4 left-1/2 -translate-x-1/2 z-[10000] material rounded-full shadow-xl pl-4 pr-1.5 py-1.5 flex items-center gap-2 text-sm text-label" role="status" data-swarm-ui>
      <span>Agents paused — you’re in control</span>
      <button type="button" className="btn btn-sm btn-primary" onClick={onResume}><Play className="w-3.5 h-3.5" /> Resume</button>
      <button type="button" className="btn btn-sm btn-plain" onClick={onCancel}><Square className="w-3.5 h-3.5" /> Stop</button>
    </div>
  );
}
