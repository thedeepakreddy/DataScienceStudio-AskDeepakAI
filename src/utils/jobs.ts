/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

// A live list of the requests the studio is waiting on (training, AI calls,
// deep analysis), for the jobs panel. Stopping a job stops waiting for it in
// this browser; work already running on the server finishes on its own.

export type JobStatus = 'running' | 'succeeded' | 'failed' | 'stopped';

export interface Job {
  id: string;
  label: string;
  status: JobStatus;
  startedAt: number;
  endedAt?: number;
  error?: string;
}

const JOB_LABELS: [RegExp, string][] = [
  [/^\/api\/(run-ml-prediction|train)\b/, 'Training a model'],
  [/^\/api\/analyze-dataset\b/, 'AI dataset advisory'],
  [/^\/api\/eda\b/, 'Deep analysis'],
  [/^\/api\/deep-quality-audit\b/, 'Data quality audit'],
  [/^\/api\/hypothesis-lab\/run-test\b/, 'Statistical test'],
  [/^\/api\/stats\/compare\b/, 'Statistical test'],
  [/^\/api\/stats\/regression\b/, 'Regression'],
  [/^\/api\/stats\/power\b/, 'Power analysis'],
  [/^\/api\/forecast\b/, 'Forecasting'],
  [/^\/api\/swarm\/plan\b/, 'Agents planning'],
  [/^\/api\/monitor\/drift\b/, 'Drift check'],
  [/^\/api\/predict\b/, 'Predicting'],
  [/^\/api\/hypothesis-lab\/generate\b/, 'Suggesting hypotheses'],
  [/^\/api\/hypothesis-lab\/interpret\b/, 'Explaining a test result'],
  [/^\/api\/ab-test-interpreter\b/, 'Writing an A/B test memo'],
  [/^\/api\/drift-metrics\b/, 'Drift check'],
  [/^\/api\/ml-service\/wake\b/, 'Waking the ML engine'],
  [/^\/api\/(chat-bot|agent\/run)\b/, 'Assistant'],
  [/^\/api\/model-explainer\b/, 'Explaining the model'],
  [/^\/api\/sql-assistant\b/, 'Writing SQL'],
  [/^\/api\/dashboard\//, 'Building the dashboard'],
  [/^\/api\/(executive-pdf-report|etl-script-generator)\b/, 'Writing a report'],
  [/^\/api\/pipeline-intelligence\b/, 'Planning the workflow'],
  [/^\/api\/db-connections\b/, 'Connecting to the database'],
];

export const labelForUrl = (url: string) => JOB_LABELS.find(([re]) => re.test(url))?.[1] ?? 'Working';

/** Finished jobs kept in the list. */
const KEEP_FINISHED = 8;

let jobs: Job[] = [];
const controllers = new Map<string, AbortController>();
const listeners = new Set<() => void>();
const emit = () => listeners.forEach(l => l());
let seq = 0;

export function subscribeJobs(listener: () => void) {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

export const getJobs = () => jobs;

export function startJob(label: string, controller: AbortController): string {
  const id = `job-${++seq}`;
  controllers.set(id, controller);
  jobs = [{ id, label, status: 'running', startedAt: Date.now() }, ...jobs];
  emit();
  return id;
}

export function finishJob(id: string, status: Exclude<JobStatus, 'running'>, error?: string) {
  controllers.delete(id);
  let finished = 0;
  jobs = jobs
    .map(j => (j.id === id && j.status === 'running' ? { ...j, status, endedAt: Date.now(), error } : j))
    .filter(j => j.status === 'running' || ++finished <= KEEP_FINISHED);
  emit();
}

/** Stops waiting for a running job. */
export function stopJob(id: string) {
  const c = controllers.get(id);
  if (!c) return;
  finishJob(id, 'stopped');
  c.abort();
}

export function clearFinishedJobs() {
  jobs = jobs.filter(j => j.status === 'running');
  emit();
}
