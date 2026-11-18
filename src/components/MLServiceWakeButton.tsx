/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Power, CheckCircle2, AlertTriangle, ExternalLink, X } from 'lucide-react';
import Orb from './Orb';
import { apiFetch } from '../utils/api';

type WakeState = 'idle' | 'waking' | 'online' | 'error';

// Render's free tier puts an instance to sleep after ~15 minutes without
// traffic. Re-probing a little inside that window keeps it warm for as long as
// the toggle is on, so the first real training request never pays a cold start.
const KEEP_WARM_INTERVAL_MS = 10 * 60 * 1000;

// After a failed wake, keep checking quietly. If the person wakes the engine by
// hand (the "open in a new tab" fallback), the Studio connects on its own.
const RECHECK_INTERVAL_MS = 8000;

export default function MLServiceWakeButton() {
  const [state, setState] = useState<WakeState>('idle');
  const [elapsed, setElapsed] = useState(0);
  const [detail, setDetail] = useState<string>('');
  // A link the person can open themselves to wake the engine; null when the
  // engine is local and a browser tab could not help.
  const [openUrl, setOpenUrl] = useState<string | null>(null);
  const [helpOpen, setHelpOpen] = useState(false);

  // Held in refs so the timers survive re-renders and are always cleanable.
  const keepWarmRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const tickRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const recheckRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);

  const clearTimers = useCallback(() => {
    if (keepWarmRef.current) { clearInterval(keepWarmRef.current); keepWarmRef.current = null; }
    if (tickRef.current) { clearInterval(tickRef.current); tickRef.current = null; }
    if (recheckRef.current) { clearInterval(recheckRef.current); recheckRef.current = null; }
  }, []);

  // Never leave a timer or an in-flight request behind on unmount.
  useEffect(() => () => {
    clearTimers();
    abortRef.current?.abort();
  }, [clearTimers]);

  // Dismiss the help popover with Escape or a click outside it.
  useEffect(() => {
    if (!helpOpen) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setHelpOpen(false); };
    const onPointer = (e: PointerEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setHelpOpen(false);
    };
    window.addEventListener('keydown', onKey);
    window.addEventListener('pointerdown', onPointer);
    return () => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('pointerdown', onPointer);
    };
  }, [helpOpen]);

  const startKeepWarm = useCallback(() => {
    if (keepWarmRef.current) return;
    keepWarmRef.current = setInterval(() => {
      // Cheap no-retry probe purely to register activity against the host.
      fetch('/api/ml-service/status').catch(() => { /* transient - next tick retries */ });
    }, KEEP_WARM_INTERVAL_MS);
  }, []);

  const markOnline = useCallback((message: string) => {
    clearTimers();
    setState('online');
    setDetail(message);
    setHelpOpen(false);
    startKeepWarm();
  }, [clearTimers, startKeepWarm]);

  // While in the error state, poll the cheap status endpoint until the engine
  // answers - e.g. because the person opened it in another tab.
  const startRecheck = useCallback(() => {
    if (recheckRef.current) return;
    recheckRef.current = setInterval(async () => {
      try {
        const response = await fetch('/api/ml-service/status');
        const body = await response.json().catch(() => null);
        if (body?.openUrl !== undefined) setOpenUrl(body.openUrl);
        if (body?.status === 'awake') markOnline('Connected. Staying warm while this is on.');
      } catch { /* app server unreachable - next tick retries */ }
    }, RECHECK_INTERVAL_MS);
  }, [markOnline]);

  const powerOff = useCallback(() => {
    clearTimers();
    abortRef.current?.abort();
    abortRef.current = null;
    setState('idle');
    setElapsed(0);
    setDetail('');
    setHelpOpen(false);
  }, [clearTimers]);

  const powerOn = useCallback(async () => {
    clearTimers();
    const controller = new AbortController();
    abortRef.current = controller;

    setState('waking');
    setDetail('');
    setElapsed(0);
    setHelpOpen(false);
    tickRef.current = setInterval(() => setElapsed(e => e + 1), 1000);

    try {
      // Runs entirely in the background - no navigation, no popup, nothing
      // rendered from the service's own response.
      const response = await apiFetch('/api/ml-service/wake', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        signal: controller.signal,
      });
      const body = await response.json().catch(() => null);
      if (body?.openUrl !== undefined) setOpenUrl(body.openUrl);

      if (!response.ok) {
        throw new Error(body?.error || `Wake failed (HTTP ${response.status}).`);
      }

      markOnline(
        body?.coldStart
          ? `Cold start finished in ${Math.round((body.elapsedMs ?? 0) / 1000)}s. Staying warm while this is on.`
          : 'Service was already warm. Staying warm while this is on.'
      );
    } catch (err: any) {
      if (err?.name === 'AbortError') return; // user toggled off mid-flight
      if (tickRef.current) { clearInterval(tickRef.current); tickRef.current = null; }
      setState('error');
      setDetail(err?.message || 'Could not reach the engine.');
      // Say what went wrong and what to do about it, where it can be seen -
      // not only in a hover tooltip - and keep watching for the engine.
      setHelpOpen(true);
      startRecheck();
    }
  }, [clearTimers, markOnline, startRecheck]);

  const onClick = () => {
    if (state === 'error') setHelpOpen(open => !open);
    else if (state === 'waking' || state === 'online') powerOff();
    else powerOn();
  };

  const view = {
    idle:   { Icon: Power,         label: 'Wake Engine',      cls: 'bg-fill hover:bg-fill-strong text-label' },
    waking: { Icon: null,          label: `Waking… ${elapsed}s`, cls: 'bg-orange/12 text-orange' },
    online: { Icon: CheckCircle2,  label: 'Engine On',        cls: 'bg-green/12 text-green' },
    error:  { Icon: AlertTriangle, label: 'Wake Failed',         cls: 'bg-red/12 text-red' },
  }[state];

  const { Icon } = view;

  return (
    <div ref={rootRef} className="relative">
      <button
        type="button"
        onClick={onClick}
        aria-pressed={state === 'online'}
        aria-busy={state === 'waking'}
        aria-expanded={state === 'error' ? helpOpen : undefined}
        aria-label={view.label}
        title={
          state === 'error'
            ? 'Show how to fix this'
            : detail ||
              (state === 'idle'
                ? 'Start the engine in the background before you run analyses. It sleeps when idle to stay free.'
                : 'Click to stop keeping the engine warm.')
        }
        className={`btn btn-sm ${view.cls}`}
      >
        {Icon ? <Icon className="w-3.5 h-3.5 shrink-0" /> : <Orb state="connecting" label="Waking the engine" />}
        <span className="hidden md:inline">{view.label}</span>
        {state !== 'error' && <span className="sr-only" aria-live="polite">{detail}</span>}
      </button>

      {state === 'error' && helpOpen && (
        <div
          role="alertdialog"
          aria-labelledby="ml-wake-help-title"
          aria-describedby="ml-wake-help-body"
          className="z-50 bg-raised rounded-2xl shadow-xl p-4 text-left animate-toast-in max-sm:fixed max-sm:inset-x-4 max-sm:top-16 sm:absolute sm:right-0 sm:top-full sm:mt-2 sm:w-[340px]"
        >
          <div className="flex items-start gap-3">
            <span className="w-8 h-8 rounded-full bg-red/12 text-red flex items-center justify-center shrink-0">
              <AlertTriangle className="w-4 h-4" />
            </span>
            <div className="flex-1 min-w-0">
              <h3 id="ml-wake-help-title" className="text-sm font-semibold text-label">
                The engine didn’t wake up
              </h3>
              <p id="ml-wake-help-body" className="mt-1 text-xs text-label-2 leading-relaxed">
                {openUrl ? (
                  <>
                    Open the engine in a new tab and wait for its page to load — that wakes it up.
                    Keep that tab open until you finish using Data Science Studio. This page connects
                    automatically once the engine is running.
                  </>
                ) : (
                  <>
                    The engine isn’t running on this machine. Start it, and this page connects automatically.
                  </>
                )}
              </p>
            </div>
            <button
              type="button"
              onClick={() => setHelpOpen(false)}
              className="btn btn-icon w-7 h-7 -mt-1 -mr-1 shrink-0"
              aria-label="Close"
            >
              <X className="w-4 h-4" />
            </button>
          </div>

          <div className="mt-3 flex flex-wrap gap-2">
            {openUrl && (
              <a href={openUrl} target="_blank" rel="noopener noreferrer" className="btn btn-sm btn-primary flex-1">
                Open Engine <ExternalLink className="w-3.5 h-3.5" />
              </a>
            )}
            <button type="button" onClick={powerOn} className="btn btn-sm btn-secondary flex-1">
              Try Again
            </button>
          </div>

          <p className="mt-3 flex items-center gap-2 text-[11px] text-label-3">
            <Orb state="listening" label="Checking for the engine" />
            Checking for the engine every few seconds…
          </p>
          {detail && (
            <p className="mt-2 pt-2 border-t border-separator text-[11px] text-label-3 leading-relaxed break-words">
              {detail}
            </p>
          )}
        </div>
      )}
    </div>
  );
}
