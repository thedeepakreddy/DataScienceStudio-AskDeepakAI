/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { AlertTriangle, CheckCircle2, RotateCw, X } from 'lucide-react';
import Orb from './Orb';

type State = 'starting' | 'ready' | 'error';

/** Coming back to the tab after this long re-checks the engine (it may have scaled to zero meanwhile). */
const RECHECK_AFTER_HIDDEN_MS = 5 * 60 * 1000;
/** Only show "starting" if waking takes longer than this, so a warm engine never flickers. */
const SHOW_STARTING_AFTER_MS = 800;

/**
 * Shows whether the engine is ready, and warms it up without being asked.
 *
 * The engine (Cloud Run) scales to zero when nobody uses it and starts again
 * on the next request, so nothing needs to keep it awake: every analysis wakes
 * it on its own. This just starts that wake-up as soon as the studio opens (and
 * when you come back to the tab), so the first analysis doesn't wait. It never
 * pings on a timer, which would keep an instance running for nothing.
 */
export default function EngineStatus() {
  const [state, setState] = useState<State>('starting');
  const [visibleStarting, setVisibleStarting] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const [detail, setDetail] = useState('');
  const [helpOpen, setHelpOpen] = useState(false);
  const abortRef = useRef<AbortController | null>(null);
  const hiddenAt = useRef<number | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);

  const wake = useCallback(async () => {
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    setState('starting');
    setElapsed(0);
    setDetail('');
    const started = Date.now();
    const showTimer = setTimeout(() => setVisibleStarting(true), SHOW_STARTING_AFTER_MS);
    const tick = setInterval(() => setElapsed(Math.round((Date.now() - started) / 1000)), 1000);
    try {
      // The server probes the engine with retries until it answers (or gives up after ~2 minutes).
      const res = await fetch('/api/ml-service/wake', { method: 'POST', signal: controller.signal });
      const body = await res.json().catch(() => null);
      if (!res.ok) throw new Error(body?.error || `The engine didn’t answer (HTTP ${res.status}).`);
      setState('ready');
      setHelpOpen(false);
      setDetail(body?.coldStart ? `Started in ${Math.round((body.elapsedMs ?? 0) / 1000)}s.` : 'Ready.');
    } catch (err: any) {
      if (err?.name === 'AbortError') return;
      setState('error');
      setDetail(err?.message || 'Could not reach the engine.');
    } finally {
      clearTimeout(showTimer);
      clearInterval(tick);
      setVisibleStarting(false);
    }
  }, []);

  // Warm the engine as soon as the studio opens.
  useEffect(() => {
    wake();
    return () => abortRef.current?.abort();
  }, [wake]);

  // After a long time away the engine has probably scaled to zero: warm it again on return.
  useEffect(() => {
    const onVisibility = () => {
      if (document.visibilityState === 'hidden') { hiddenAt.current = Date.now(); return; }
      if (hiddenAt.current && Date.now() - hiddenAt.current > RECHECK_AFTER_HIDDEN_MS) wake();
      hiddenAt.current = null;
    };
    document.addEventListener('visibilitychange', onVisibility);
    return () => document.removeEventListener('visibilitychange', onVisibility);
  }, [wake]);

  useEffect(() => {
    if (!helpOpen) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setHelpOpen(false); };
    const onPointer = (e: PointerEvent) => { if (rootRef.current && !rootRef.current.contains(e.target as Node)) setHelpOpen(false); };
    window.addEventListener('keydown', onKey);
    window.addEventListener('pointerdown', onPointer);
    return () => { window.removeEventListener('keydown', onKey); window.removeEventListener('pointerdown', onPointer); };
  }, [helpOpen]);

  const starting = state === 'starting' && visibleStarting;
  const view = state === 'error'
    ? { label: 'Engine unreachable', cls: 'bg-red/12 text-red' }
    : starting ? { label: `Engine starting… ${elapsed}s`, cls: 'bg-orange/12 text-orange' }
      : { label: 'Engine ready', cls: 'bg-green/12 text-green' };

  return (
    <div ref={rootRef} className="relative" data-agent="engine-status">
      {state === 'error' ? (
        <button type="button" className={`btn btn-sm ${view.cls}`} aria-expanded={helpOpen} onClick={() => setHelpOpen(o => !o)} title="Show details">
          <AlertTriangle className="w-3.5 h-3.5 shrink-0" />
          <span className="hidden md:inline">{view.label}</span>
        </button>
      ) : (
        <span role="status" aria-live="polite" title={state === 'ready' ? `${detail} The engine sleeps when unused and wakes automatically.` : 'Starting the engine in the background.'}
          className={`btn btn-sm pointer-events-none ${view.cls} ${state === 'starting' && !visibleStarting ? 'opacity-0' : ''}`}>
          {starting ? <Orb state="connecting" label="Starting the engine" /> : <CheckCircle2 className="w-3.5 h-3.5 shrink-0" />}
          <span className="hidden md:inline">{view.label}</span>
        </span>
      )}

      {state === 'error' && helpOpen && (
        <div role="alertdialog" aria-labelledby="engine-help-title" className="z-50 bg-raised rounded-2xl shadow-xl p-4 text-left animate-toast-in max-sm:fixed max-sm:inset-x-4 max-sm:top-16 sm:absolute sm:right-0 sm:top-full sm:mt-2 sm:w-[320px]">
          <div className="flex items-start gap-3">
            <span className="w-8 h-8 rounded-full bg-red/12 text-red flex items-center justify-center shrink-0"><AlertTriangle className="w-4 h-4" /></span>
            <div className="flex-1 min-w-0">
              <h3 id="engine-help-title" className="text-sm font-semibold text-label">The engine didn’t answer</h3>
              <p className="mt-1 text-xs text-label-2 leading-relaxed">
                Analyses will still try to reach it when you run them. If this keeps happening, the engine’s deployment may need attention.
              </p>
            </div>
            <button type="button" onClick={() => setHelpOpen(false)} className="btn btn-icon w-7 h-7 -mt-1 -mr-1 shrink-0" aria-label="Close"><X className="w-4 h-4" /></button>
          </div>
          <button type="button" onClick={wake} className="mt-3 btn btn-sm btn-secondary w-full"><RotateCw className="w-3.5 h-3.5" /> Try again</button>
          {detail && <p className="mt-2 pt-2 border-t border-separator text-[11px] text-label-3 leading-relaxed break-words">{detail}</p>}
        </div>
      )}
    </div>
  );
}
