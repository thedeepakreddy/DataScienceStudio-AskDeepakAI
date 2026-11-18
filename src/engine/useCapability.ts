/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import type { Dataset } from '../types';
import { CAPABILITIES, EngineApiError, engine, type CapabilityName, type CapabilityParams, type CapabilityResult } from './client';
import { syncDataset } from './datasetSync';

export type RunPhase = 'idle' | 'syncing' | 'running' | 'done' | 'error';

export interface CapabilityRun<T> {
  phase: RunPhase;
  result: (CapabilityResult<T> & { runId: string }) | null;
  error: string | null;
  /** 0–1 while the engine reports progress, otherwise null. */
  progress: number | null;
  message: string;
  run: (params: CapabilityParams[CapabilityName] | Record<string, unknown>, options?: { experiment?: string }) => Promise<void>;
  cancel: () => void;
  reset: () => void;
}

const friendly = (err: unknown): string => {
  if (err instanceof EngineApiError) {
    if (err.status === 401) return 'The studio isn’t authorised to use the engine. Check ENGINE_TOKEN on the server.';
    if (err.status >= 500 && /<html/i.test(err.message)) return 'The engine is waking up or briefly unavailable. Please try again in a moment.';
    return err.message;
  }
  if ((err as Error)?.name === 'AbortError') return 'Stopped.';
  return (err as Error)?.message || 'Something went wrong.';
};

/**
 * Runs one engine capability for a panel: syncs the dataset if the capability
 * needs it, runs it (following the job when it's long), and exposes progress,
 * cancel, a readable error and the result with its run id for provenance.
 */
export function useCapability<T = Record<string, any>>(name: CapabilityName, dataset?: Dataset | null): CapabilityRun<T> {
  const [phase, setPhase] = useState<RunPhase>('idle');
  const [result, setResult] = useState<CapabilityRun<T>['result']>(null);
  const [error, setError] = useState<string | null>(null);
  const [progress, setProgress] = useState<number | null>(null);
  const [message, setMessage] = useState('');
  const controller = useRef<AbortController | null>(null);

  useEffect(() => () => controller.current?.abort(), []);

  const run = useCallback<CapabilityRun<T>['run']>(async (params, options: { experiment?: string } = {}) => {
    controller.current?.abort();
    const ctl = new AbortController();
    controller.current = ctl;
    setError(null);
    setProgress(null);
    try {
      let datasetId: string | null = null;
      if (CAPABILITIES[name].needsDataset) {
        if (!dataset) throw new Error('Load a dataset first.');
        setPhase('syncing');
        setMessage('Sending your data to the engine');
        datasetId = (await syncDataset(dataset)).id;
      }
      setPhase('running');
      setMessage(CAPABILITIES[name].title);
      const res = await engine.runAndWait(name, params as never, {
        datasetId, signal: ctl.signal, experiment: options.experiment,
        onProgress: (p, m) => { setProgress(p); setMessage(m); },
      });
      if (ctl.signal.aborted) return;
      setResult(res as CapabilityRun<T>['result']);
      setPhase('done');
    } catch (err) {
      if (ctl.signal.aborted && (err as Error)?.name === 'AbortError') {
        setPhase(result ? 'done' : 'idle');
        return;
      }
      setError(friendly(err));
      setPhase('error');
    }
  }, [name, dataset, result]);

  const cancel = useCallback(() => controller.current?.abort(), []);
  const reset = useCallback(() => { controller.current?.abort(); setResult(null); setError(null); setPhase('idle'); }, []);

  return { phase, result, error, progress, message, run, cancel, reset };
}
