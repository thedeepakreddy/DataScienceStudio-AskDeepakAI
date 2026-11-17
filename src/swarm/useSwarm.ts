/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import type { Dataset } from '../types';
import { listSwarmRuns, saveSwarmRun } from '../utils/workspaceStore';
import { planRequest, PlanOutcome } from './gateway';
import { RuntimePort, SwarmRun, SwarmRuntime, newRun } from './runtime';

/**
 * Connects the swarm runtime to the studio. Keeps one active run; restores an
 * unfinished run after a reload (recovering interrupted tasks honestly).
 */
export function useSwarm(port: RuntimePort, ids: { datasetId: string | null; activeVersionId: string | null }, dataset: Dataset | null) {
  const [run, setRun] = useState<SwarmRun | null>(null);
  const [planning, setPlanning] = useState(false);
  const [lastPlan, setLastPlan] = useState<PlanOutcome | null>(null);
  const [history, setHistory] = useState<SwarmRun[]>([]);
  const runtime = useRef<SwarmRuntime | null>(null);
  const portRef = useRef(port);
  useEffect(() => { portRef.current = port; });

  // A stable port whose methods always reach the latest studio state.
  const [stablePort] = useState<RuntimePort>(() => ({
    getDataset: () => portRef.current.getDataset(),
    commitDataset: (...a) => portRef.current.commitDataset(...a),
    openStep: s => portRef.current.openStep(s),
    train: (...a) => portRef.current.train(...a),
    getModel: () => portRef.current.getModel(),
    api: (...a) => portRef.current.api(...a),
    settle: () => portRef.current.settle(),
    findAppliedVersion: (...a) => portRef.current.findAppliedVersion(...a),
  }));

  const attach = useCallback((r: SwarmRun) => {
    runtime.current = new SwarmRuntime(r, stablePort, saveSwarmRun, next => setRun(next));
    setRun(r);
    return runtime.current;
  }, [stablePort]);

  // Bring back an unfinished run once a dataset is open.
  const restored = useRef(false);
  useEffect(() => {
    if (restored.current || !ids.datasetId) return;
    restored.current = true;
    listSwarmRuns(20).then(async runs => {
      setHistory(runs);
      const open = runs.find(r => r.datasetId === ids.datasetId && ['running', 'paused', 'cancelling', 'awaiting_approval'].includes(r.status));
      if (!open || runtime.current) return;
      const rt = attach(open);
      await rt.recover();
      if (rt.run.status === 'running') rt.start();
    }).catch(() => {});
  }, [ids.datasetId, attach]);

  const plan = useCallback(async (request: string) => {
    setPlanning(true);
    try {
      const outcome = await planRequest(request, dataset);
      setLastPlan(outcome);
      if (outcome.tasks.length && outcome.problems.length === 0) {
        const r = newRun({
          request, reply: outcome.reply, plannedBy: outcome.plannedBy, tasks: outcome.tasks,
          datasetId: ids.datasetId, startVersionId: ids.activeVersionId,
          aiCalls: outcome.aiCalls, inputTokens: outcome.inputTokens, outputTokens: outcome.outputTokens, cacheHit: outcome.cacheHit,
        });
        attach(r);
        await saveSwarmRun(r).catch(() => {});
      }
      return outcome;
    } finally {
      setPlanning(false);
    }
  }, [dataset, ids.datasetId, ids.activeVersionId, attach]);

  const controls = {
    approveAndRun: () => { runtime.current?.approveBatch(); runtime.current?.start(); },
    approveTask: (id: string) => runtime.current?.approveTask(id),
    pause: () => runtime.current?.pause(),
    resume: () => runtime.current?.resume(),
    cancel: () => runtime.current?.cancel(),
    cancelTask: (id: string) => runtime.current?.cancelTask(id),
    // A plan you discard is saved as cancelled, so it isn't offered again after a reload.
    discard: () => {
      if (runtime.current && runtime.current.run.status === 'awaiting_approval') runtime.current.cancel();
      runtime.current = null; setRun(null); setLastPlan(null);
    },
    refreshHistory: () => listSwarmRuns(20).then(setHistory).catch(() => {}),
  };

  return { run, planning, lastPlan, history, plan, ...controls };
}
