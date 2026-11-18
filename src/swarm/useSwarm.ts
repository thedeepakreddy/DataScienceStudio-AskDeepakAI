/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import type { Dataset } from '../types';
import { listSwarmRuns, saveSwarmRun } from '../utils/workspaceStore';
import { apiFetch } from '../utils/api';
import { ChatTurn, aiReviewRun, planRequest, PlanOutcome } from './gateway';
import { TaskSpec, validatePlan } from './plan';
import { ApprovalMode, RuntimeOptions, RuntimePort, SwarmRun, SwarmRuntime, newRun } from './runtime';
import { SWARM_CLEARED_EVENT, SWARM_STATUS_EVENT } from './interaction';

const APPROVAL_KEY = 'swarm-approval-mode';
const ACTIVE: SwarmRun['status'][] = ['running', 'paused', 'cancelling', 'awaiting_approval'];

// Agents work through the controls on the user's page, so the user can see
// each step; the ML service is woken when a task finds it asleep.
const RUNTIME_OPTIONS: RuntimeOptions = {
  onPage: () => typeof document !== 'undefined',
  wakeMl: async () => {
    try {
      const res = await apiFetch('/api/ml-service/wake', { method: 'POST' });
      const body = await res.json().catch(() => null);
      return res.ok && body?.ok !== false;
    } catch {
      return false;
    }
  },
};

/**
 * Connects the swarm runtime to the studio. Keeps one active run; restores an
 * unfinished run after a reload (recovering interrupted tasks honestly).
 */
export function useSwarm(port: RuntimePort, ids: { datasetId: string | null; activeVersionId: string | null }, dataset: Dataset | null) {
  const [run, setRun] = useState<SwarmRun | null>(null);
  const [planning, setPlanning] = useState(false);
  // Agents run on their own by default and you watch; "ask" makes changes wait for you.
  const [approvalMode, setMode] = useState<ApprovalMode>(() => {
    try { return localStorage.getItem(APPROVAL_KEY) === 'ask' ? 'ask' : 'auto'; } catch { return 'auto'; }
  });
  const setApprovalMode = useCallback((m: ApprovalMode) => {
    setMode(m);
    try { localStorage.setItem(APPROVAL_KEY, m); } catch { /* private window */ }
  }, []);
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
    resetOriginal: () => portRef.current.resetOriginal(),
    runCode: (...a) => portRef.current.runCode(...a),
    runAdvisory: () => portRef.current.runAdvisory(),
    logRun: run => portRef.current.logRun?.(run),
    getPinTarget: () => portRef.current.getPinTarget?.() ?? { datasetId: null, versionId: null },
    settle: () => portRef.current.settle(),
    findAppliedVersion: (...a) => portRef.current.findAppliedVersion(...a),
  }));

  const attach = useCallback((r: SwarmRun) => {
    runtime.current = new SwarmRuntime(r, stablePort, saveSwarmRun, next => setRun(next), { ...RUNTIME_OPTIONS, aiReview: run => aiReviewRun(run, stablePort.getDataset()) });
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
      const open = runs.find(r => r.datasetId === ids.datasetId && ACTIVE.includes(r.status));
      if (!open || runtime.current) return;
      const rt = attach(open);
      await rt.recover();
      // Agents never start on their own: a run interrupted by a reload waits for you to resume it.
      if (rt.run.status === 'running') rt.pause('The page reloaded while the team was working, so the run is paused. Resume it when you’re ready, or cancel it.');
    }).catch(() => {});
  }, [ids.datasetId, attach]);

  // The agents are only drawn while they work: a few seconds after a run ends
  // (or is paused), the panels it lit and the Orchestrator's tree fade away.
  const status = run?.status;
  useEffect(() => { window.dispatchEvent(new CustomEvent(SWARM_STATUS_EVENT, { detail: status ?? null })); }, [status]);
  useEffect(() => {
    // A paused run keeps its tree, so the Orchestrator's resume button stays in reach.
    if (!status || status === 'running' || status === 'cancelling' || status === 'paused') return;
    const t = setTimeout(() => window.dispatchEvent(new Event(SWARM_CLEARED_EVENT)), status === 'awaiting_approval' ? 0 : 4000);
    return () => clearTimeout(t);
  }, [status, run?.id]);

  // Keep the recent-runs list current as runs finish.
  useEffect(() => {
    if (status && !ACTIVE.includes(status)) listSwarmRuns(20).then(setHistory).catch(() => {});
  }, [status, run?.id]);

  const busy = () => !!runtime.current && ['running', 'paused', 'cancelling'].includes(runtime.current.run.status);

  const plan = useCallback(async (request: string, history: ChatTurn[] = []) => {
    setPlanning(true);
    try {
      // An unapproved plan is replaced by the new request.
      if (runtime.current?.run.status === 'awaiting_approval') runtime.current.cancel();
      const outcome = await planRequest(request, dataset, { history, hasModel: !!portRef.current.getModel() });
      setLastPlan(outcome);
      if (outcome.tasks.length && outcome.problems.length === 0) {
        const r = newRun({
          approvalMode: approvalMode, request, reply: outcome.reply, plannedBy: outcome.plannedBy, tasks: outcome.tasks,
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
  }, [dataset, ids.datasetId, ids.activeVersionId, attach, approvalMode]);

  /** A plan the chat already knows (SQL and Code modes), checked like any other. */
  const planFromTasks = useCallback(async (request: string, tasks: TaskSpec[], reply: string): Promise<PlanOutcome> => {
    if (runtime.current?.run.status === 'awaiting_approval') runtime.current.cancel();
    const problems = validatePlan(tasks, dataset);
    const outcome: PlanOutcome = { tasks, reply, plannedBy: 'rules', problems, aiCalls: 0, inputTokens: 0, outputTokens: 0, cacheHit: false };
    setLastPlan(outcome);
    if (!problems.length) {
      const r = newRun({ approvalMode, request, reply, plannedBy: 'rules', tasks, datasetId: ids.datasetId, startVersionId: ids.activeVersionId });
      attach(r);
      await saveSwarmRun(r).catch(() => {});
    }
    return outcome;
  }, [dataset, ids.datasetId, ids.activeVersionId, attach, approvalMode]);

  const controls = {
    /** The run the last plan created (read right after planning, before React re-renders). */
    latestRun: () => runtime.current?.run ?? null,
    approveAndRun: () => { runtime.current?.approveBatch(); runtime.current?.start(); },
    approveTask: (id: string) => { runtime.current?.approveTask(id); runtime.current?.start(); },
    pause: () => runtime.current?.pause(),
    resume: () => runtime.current?.resume(),
    cancel: () => runtime.current?.cancel(),
    cancelTask: (id: string) => runtime.current?.cancelTask(id),
    // A plan you discard is saved as cancelled, so it isn't offered again after a reload.
    discard: () => {
      if (runtime.current && runtime.current.run.status === 'awaiting_approval') runtime.current.cancel();
      runtime.current = null; setRun(null); setLastPlan(null);
      window.dispatchEvent(new Event(SWARM_CLEARED_EVENT));
    },
    refreshHistory: () => listSwarmRuns(20).then(setHistory).catch(() => {}),
  };

  return { run, planning, lastPlan, history, plan, planFromTasks, busy, approvalMode, setApprovalMode, ...controls };
}
