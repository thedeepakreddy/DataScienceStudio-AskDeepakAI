/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Dataset } from '../types';
import { AGENTS, AgentRole } from './agents';
import { CAPABILITIES, Capability, CapabilityResult, StudioPort } from './catalog';
import { LIMITS, TaskSpec, TaskStatus } from './plan';
import { Driver } from './interaction';
import { needsReview } from './review';
import { Incident, IncidentState, RECOVERY_LIMITS, diagnose, fingerprint } from './recovery';
import { MAX_FIXES, OrchestratorReview, auditRun } from './orchestratorReview';

// The swarm's durable runtime (blueprint 7). Every state change is saved, so
// a run survives a page reload; tasks start only when their dependencies are
// done, data changes run one at a time, backend jobs run in parallel up to a
// limit, temporary failures retry with backoff, and the user can pause,
// resume or cancel a task or the whole run.

export interface TaskState extends TaskSpec {
  status: TaskStatus;
  attempts: number;
  approved: boolean;
  startedAt?: number;
  endedAt?: number;
  result?: { summary: string; data?: unknown };
  /** The producing agent's own check (never shown as independent verification). */
  check?: { ok: boolean; detail: string; kind: 'self-check' | 'independent' };
  error?: string;
  /** Why it is blocked or waiting. */
  note?: string;
  /** Data version it started from, and the one it produced (idempotency, 7.3). */
  inputVersionId?: string | null;
  outputVersionId?: string | null;
  cancelRequested?: boolean;
  /** Recovery: run the operation directly instead of through the page, or with more time. */
  forceDirect?: boolean;
  timeBoost?: number;
  /** Whether it was carried out through the controls on the page. */
  usedPage?: boolean;
  /** The task that redid this one after the Orchestrator's review. */
  supersededBy?: string;
}

export type BusMessageType = 'assignment' | 'status' | 'finding' | 'handoff' | 'approval_request' | 'failure' | 'recovery' | 'challenge';

export interface BusMessage {
  id: string;
  at: number;
  from: AgentRole;
  to: AgentRole | 'user';
  type: BusMessageType;
  taskId?: string;
  text: string;
}

export interface Telemetry {
  aiCalls: number;
  inputTokens: number;
  outputTokens: number;
  cacheHits: number;
  /** Tasks completed by studio engines without any AI call. */
  deterministicOps: number;
  retries: number;
  failures: number;
}

export type RunStatus = 'awaiting_approval' | 'running' | 'paused' | 'cancelling' | 'completed' | 'partial' | 'failed' | 'cancelled';

export interface CompletionReport {
  status: RunStatus;
  headline: string;
  done: { label: string; role: AgentRole; summary: string; check?: string }[];
  problems: { label: string; role: AgentRole; status: TaskStatus; reason: string }[];
  /** Independent reviews and any contradictions they found. */
  reviews: { label: string; agrees: boolean; detail: string }[];
  incidents: { diagnosis: string; state: IncidentState; repair?: string }[];
  orchestrator?: OrchestratorReview;
  /** Completed work per step, in workflow order (long runs read by step). */
  bySteps?: { step: string; count: number }[];
  data: { startVersionId: string | null; endVersionId: string | null; rows?: number; columns?: number };
  limitations: string[];
  telemetry: Telemetry;
  durationMs: number;
}

export interface SwarmRun {
  id: string;
  datasetId: string | null;
  request: string;
  reply: string;
  plannedBy: 'rules' | 'ai' | 'cache';
  createdAt: number;
  updatedAt: number;
  status: RunStatus;
  /** How tasks were approved for this run (older runs: 'ask'). */
  approvalMode?: ApprovalMode;
  startVersionId: string | null;
  tasks: TaskState[];
  messages: BusMessage[];
  telemetry: Telemetry;
  dynamicAdded: number;
  /** Self-healing incidents opened during the run. */
  incidents?: Incident[];
  reviews?: number;
  /** The Orchestrator's final review: issues found and the fixes it ran. */
  orchestratorReview?: OrchestratorReview;
  report?: CompletionReport;
}

/** What the runtime needs beyond the capability port. */
export interface RuntimePort extends StudioPort {
  /** Waits until pending data saves finish; returns the active version id. */
  settle: () => Promise<string | null>;
  /** A saved version made from `parentId` by exactly this operation, if any (recovery). */
  findAppliedVersion: (parentId: string | null, capability: string, params: unknown) => Promise<string | null>;
}

const TERMINAL: TaskStatus[] = ['completed', 'failed', 'cancelled', 'blocked'];
const TRANSIENT = /timed out|timeout|503|502|504|unavailable|waking|network|fetch failed|ECONN|restarted|Load failed|HTTP 5/i;
const newId = () => (typeof crypto !== 'undefined' && 'randomUUID' in crypto ? crypto.randomUUID() : `${Date.now()}-${Math.random()}`);
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

/**
 * How agents' work is approved. 'auto' (the studio's default): every allowed task runs
 * at once and you watch — each change is still a saved version you can undo.
 * 'ask': changes wait for you, as each capability's own approval rule says.
 */
export type ApprovalMode = 'auto' | 'ask';
export const preApproved = (capability: string, mode: ApprovalMode = 'ask') => {
  const rule = CAPABILITIES[capability]?.approval;
  return mode === 'auto' ? !!rule && rule !== 'prohibited' : rule === 'autonomous';
};

export function newRun(opts: { approvalMode?: ApprovalMode; request: string; reply: string; plannedBy: SwarmRun['plannedBy']; tasks: TaskSpec[]; datasetId: string | null; startVersionId: string | null; aiCalls?: number; inputTokens?: number; outputTokens?: number; cacheHit?: boolean }): SwarmRun {
  const now = Date.now();
  return {
    id: newId(), datasetId: opts.datasetId, request: opts.request, reply: opts.reply, plannedBy: opts.plannedBy,
    createdAt: now, updatedAt: now, status: 'awaiting_approval', startVersionId: opts.startVersionId,
    approvalMode: opts.approvalMode ?? 'ask',
    tasks: opts.tasks.map(t => ({ ...t, status: 'pending', attempts: 0, approved: preApproved(t.capability, opts.approvalMode) })),
    messages: [],
    telemetry: { aiCalls: opts.aiCalls ?? 0, inputTokens: opts.inputTokens ?? 0, outputTokens: opts.outputTokens ?? 0, cacheHits: opts.cacheHit ? 1 : 0, deterministicOps: 0, retries: 0, failures: 0 },
    dynamicAdded: 0,
    incidents: [],
    reviews: 0,
  };
}

export interface RuntimeOptions {
  /** True when agents should work through the controls on the user's page. */
  onPage?: () => boolean;
  /** Pointer travel time in ms (0 in tests). */
  pace?: number;
  /** Wakes the ML service (a recovery repair). */
  wakeMl?: () => Promise<boolean>;
  /** The Orchestrator's final review runs before reporting (default true). */
  finalReview?: boolean;
  /** Optional AI check of the results against the request (one call). */
  aiReview?: (run: SwarmRun) => Promise<{ summary: string; issues: string[]; tasks: TaskSpec[]; inputTokens?: number; outputTokens?: number } | null>;
}

export class SwarmRuntime {
  run: SwarmRun;
  private port: RuntimePort;
  private persist: (run: SwarmRun) => Promise<void>;
  private onChange: (run: SwarmRun) => void;
  private controllers = new Map<string, AbortController>();
  private dataLock = false;
  private ticking = false;
  /** The task currently operating the user's page (one at a time). */
  private pageOwner: string | null = null;
  private opts: RuntimeOptions;

  constructor(run: SwarmRun, port: RuntimePort, persist: (run: SwarmRun) => Promise<void>, onChange: (run: SwarmRun) => void, opts: RuntimeOptions = {}) {
    this.opts = opts;
    this.run = { incidents: [], reviews: 0, ...run };
    this.port = port;
    this.persist = persist;
    this.onChange = onChange;
  }

  // --- State helpers ---------------------------------------------------------

  private save() {
    this.run = { ...this.run, updatedAt: Date.now(), tasks: [...this.run.tasks], messages: [...this.run.messages] };
    this.onChange(this.run);
    this.persist(this.run).catch(() => {});
  }

  private task(id: string) { return this.run.tasks.find(t => t.id === id)!; }

  private patch(id: string, p: Partial<TaskState>) {
    this.run.tasks = this.run.tasks.map(t => (t.id === id ? { ...t, ...p } : t));
  }

  private say(from: AgentRole, to: AgentRole | 'user', type: BusMessageType, text: string, taskId?: string) {
    this.run.messages = [...this.run.messages, { id: newId(), at: Date.now(), from, to, type, text, taskId }];
  }

  private cap(t: TaskState): Capability { return CAPABILITIES[t.capability]; }

  // --- User controls (7.4) ---------------------------------------------------

  /** Approves the waiting tasks that may be batch-approved. Separate-approval tasks need approveTask. */
  approveBatch() {
    for (const t of this.run.tasks) {
      if (!t.approved && this.cap(t)?.approval === 'batch' && !TERMINAL.includes(t.status)) this.patch(t.id, { approved: true, status: t.status === 'awaiting_approval' ? 'pending' : t.status });
    }
    this.say('orchestrator', 'user', 'status', 'You approved the plan.');
    if (this.run.status === 'awaiting_approval') this.run.status = 'running';
    this.save();
    void this.tick();
  }

  approveTask(id: string) {
    const t = this.task(id);
    if (!t || t.approved || this.cap(t)?.approval === 'prohibited') return;
    this.patch(id, { approved: true, status: 'pending', note: undefined });
    this.say('orchestrator', 'user', 'status', `You approved: ${this.cap(t).label(t.params)}.`, id);
    if (this.run.status === 'awaiting_approval') this.run.status = 'running';
    this.save();
    void this.tick();
  }

  pause(message = 'Paused. Tasks already running will finish; no new ones start.') {
    if (this.run.status !== 'running') return;
    this.run.status = 'paused';
    this.say('orchestrator', 'user', 'status', message);
    this.save();
  }

  resume() {
    if (this.run.status !== 'paused') return;
    this.run.status = 'running';
    this.say('orchestrator', 'user', 'status', 'Resumed.');
    this.save();
    void this.tick();
  }

  /** Requests cancellation; running backend jobs are told to stop waiting. Confirmed when they finish. */
  cancel() {
    if (['completed', 'partial', 'failed', 'cancelled'].includes(this.run.status)) return;
    for (const t of this.run.tasks) {
      if (t.status === 'running' || t.status === 'verifying') {
        this.patch(t.id, { cancelRequested: true });
        this.controllers.get(t.id)?.abort();
      } else if (!TERMINAL.includes(t.status)) {
        this.patch(t.id, { status: 'cancelled', note: 'Cancelled before it started.' });
      }
    }
    this.run.status = this.run.tasks.some(t => t.status === 'running' || t.status === 'verifying') ? 'cancelling' : 'cancelled';
    this.say('orchestrator', 'user', 'status', this.run.status === 'cancelling' ? 'Cancelling: waiting for running tasks to stop.' : 'Cancelled.');
    if (this.run.status === 'cancelled') this.finish();
    this.save();
  }

  cancelTask(id: string) {
    const t = this.task(id);
    if (!t || TERMINAL.includes(t.status)) return;
    if (t.status === 'running' || t.status === 'verifying') {
      this.patch(id, { cancelRequested: true });
      this.controllers.get(id)?.abort();
    } else {
      this.patch(id, { status: 'cancelled', note: 'Cancelled by you.' });
    }
    this.save();
    void this.tick();
  }

  // --- Recovery after a reload (7.3) -------------------------------------------

  /** Brings a saved run back after a reload, without claiming work resumed that restarted. */
  async recover() {
    for (const t of this.run.tasks) {
      if (t.status !== 'running' && t.status !== 'verifying') continue;
      const cap = this.cap(t);
      if (cap?.sideEffect === 'new-version') {
        const applied = await this.port.findAppliedVersion(t.inputVersionId ?? null, t.capability, t.params);
        if (applied) {
          this.patch(t.id, { status: 'completed', outputVersionId: applied, endedAt: Date.now(), result: { summary: 'Completed before the page reloaded (found its saved version).' }, check: { ok: true, detail: 'Its data version exists.', kind: 'self-check' } });
          this.say('orchestrator', 'user', 'recovery', `Reload: “${cap.label(t.params)}” had already been applied; not repeated.`, t.id);
          continue;
        }
      }
      this.patch(t.id, { status: 'pending', note: 'Restarted after the page reloaded.' });
      this.say('orchestrator', 'user', 'recovery', `Reload: “${cap?.label(t.params) ?? t.capability}” was interrupted and will run again from the start.`, t.id);
    }
    if (this.run.status === 'cancelling') this.run.status = 'cancelled';
    this.save();
  }

  // --- Scheduling ----------------------------------------------------------------

  start() {
    if (this.run.status === 'awaiting_approval' && this.run.tasks.every(t => t.approved || TERMINAL.includes(t.status))) this.run.status = 'running';
    this.save();
    void this.tick();
  }

  private depsState(t: TaskState): 'ready' | 'waiting' | { blockedBy: TaskState } {
    for (const d of t.dependsOn) {
      const dep = this.task(d);
      if (!dep) continue;
      if (dep.status === 'failed' || dep.status === 'cancelled' || dep.status === 'blocked') return { blockedBy: dep };
      if (dep.status !== 'completed') return 'waiting';
    }
    return 'ready';
  }

  private async tick() {
    if (this.ticking) return;
    this.ticking = true;
    try {
      let changed = true;
      while (changed) {
        changed = false;
        // Block tasks whose dependencies failed, so the run can end honestly.
        for (const t of this.run.tasks) {
          if (TERMINAL.includes(t.status) || t.status === 'running' || t.status === 'verifying') continue;
          const s = this.depsState(t);
          if (typeof s === 'object') {
            this.patch(t.id, { status: 'blocked', note: `Needs “${this.cap(s.blockedBy)?.label(s.blockedBy.params) ?? s.blockedBy.id}”, which ${s.blockedBy.status === 'completed' ? 'finished' : s.blockedBy.status}.` });
            changed = true;
          }
        }
        if (this.run.status !== 'running') break;
        const runningBackend = this.run.tasks.filter(t => t.status === 'running' && this.cap(t)?.backend).length;
        let backendSlots = LIMITS.maxConcurrentBackend - runningBackend;
        for (const t of this.run.tasks) {
          if (t.status !== 'pending' && t.status !== 'ready' && t.status !== 'awaiting_approval') continue;
          if (this.depsState(t) !== 'ready') continue;
          if (!t.approved) {
            if (t.status !== 'awaiting_approval') {
              this.patch(t.id, { status: 'awaiting_approval', note: this.cap(t).approval === 'separate' ? 'Needs its own approval.' : 'Waiting for your approval.' });
              this.say(t.role, 'user', 'approval_request', `Approval needed: ${this.cap(t).label(t.params)}.`, t.id);
              changed = true;
            }
            continue;
          }
          const cap = this.cap(t);
          if (cap.sideEffect === 'new-version' || cap.sideEffect === 'navigation') {
            if (this.dataLock) continue;
            this.dataLock = true;
          } else if (cap.backend) {
            if (backendSlots <= 0) continue;
            backendSlots--;
          }
          // Claimed now, before any await, so it can't be started twice.
          this.patch(t.id, { status: 'running' });
          void this.execute(t.id);
          changed = true;
        }
      }
      this.maybeFinish();
    } finally {
      this.ticking = false;
    }
  }

  private async execute(id: string) {
    const t = this.task(id);
    const cap = this.cap(t);
    const holdsLock = cap.sideEffect === 'new-version' || cap.sideEffect === 'navigation';
    const controller = new AbortController();
    this.controllers.set(id, controller);
    const inputVersionId = cap.sideEffect === 'new-version' ? await this.port.settle() : null;
    this.patch(id, { status: 'running', startedAt: Date.now(), attempts: t.attempts + 1, inputVersionId, note: undefined, error: undefined });
    this.say('orchestrator', t.role, 'assignment', `${AGENTS[t.role].name}: ${cap.label(t.params)}.`, id);
    this.save();

    const before: Dataset | null = this.port.getDataset();
    try {
      // Inputs are checked again against the data as it is now (5.3).
      const invalid = cap.validate(t.params, before);
      if (invalid) throw Object.assign(new Error(invalid), { permanent: true });
      const limit = cap.timeoutMs * (this.task(id).timeBoost ?? 1);
      const result: CapabilityResult = await Promise.race([
        this.perform(this.task(id), cap, controller.signal),
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error(`Timed out after ${Math.round(limit / 1000)}s.`)), limit)),
      ]);
      if (this.task(id).cancelRequested) throw Object.assign(new Error('Cancelled.'), { cancelled: true });
      this.patch(id, { status: 'verifying' });
      const outputVersionId = cap.sideEffect === 'new-version' ? await this.port.settle() : null;
      const after = this.port.getDataset();
      const check = cap.selfCheck(t.params, before, after, result);
      this.run.telemetry = { ...this.run.telemetry, deterministicOps: this.run.telemetry.deterministicOps + 1 };
      this.patch(id, {
        status: check.ok ? 'completed' : 'failed', endedAt: Date.now(), result: { summary: result.summary, data: result.data },
        check: { ...check, kind: cap.id === 'verify.review' ? 'independent' : 'self-check' }, outputVersionId, error: check.ok ? undefined : check.detail,
      });
      this.say(t.role, 'orchestrator', check.ok ? 'finding' : 'failure', `${result.summary}${check.ok ? '' : ` Check failed: ${check.detail}`}`, id);
      if (check.ok) {
        this.handOff(t);
        this.addFollowUps(t, result);
        this.addReview(this.task(id), before, after);
        this.closeIncidents(id);
      } else {
        this.run.telemetry = { ...this.run.telemetry, failures: this.run.telemetry.failures + 1 };
      }
    } catch (err: any) {
      const message = String(err?.message || err);
      const cancelled = err?.cancelled || err?.name === 'AbortError' || this.task(id).cancelRequested;
      const transient = !err?.permanent && !cancelled && cap.idempotent && TRANSIENT.test(message);
      if (cancelled) {
        this.patch(id, { status: 'cancelled', endedAt: Date.now(), note: 'Cancelled while running.' });
        this.say(t.role, 'orchestrator', 'status', 'Stopped: cancelled.', id);
      } else if (transient && this.task(id).attempts <= LIMITS.maxRetries) {
        const wait = 1000 * 3 ** (this.task(id).attempts - 1);
        this.run.telemetry = { ...this.run.telemetry, retries: this.run.telemetry.retries + 1 };
        this.patch(id, { status: 'pending', note: `Temporary problem (${message}); retrying in ${Math.round(wait / 1000)}s.` });
        this.say(t.role, 'orchestrator', 'recovery', `Temporary problem, retrying: ${message}`, id);
        this.save();
        if (holdsLock) this.dataLock = false;
        this.controllers.delete(id);
        await sleep(wait);
        void this.tick();
        return;
      } else if (await this.selfHeal(id, cap, message, holdsLock)) {
        return;
      } else {
        this.run.telemetry = { ...this.run.telemetry, failures: this.run.telemetry.failures + 1 };
        this.patch(id, { status: 'failed', endedAt: Date.now(), error: message });
        this.say(t.role, 'orchestrator', 'failure', `Failed: ${message}`, id);
      }
    } finally {
      this.controllers.delete(id);
    }
    if (holdsLock) this.dataLock = false;
    if (this.run.status === 'cancelling' && !this.run.tasks.some(x => x.status === 'running' || x.status === 'verifying')) {
      this.run.status = 'cancelled';
      this.finish();
    }
    this.save();
    void this.tick();
  }

  // --- Working on the user's page -------------------------------------------------

  private async perform(t: TaskState, cap: Capability, signal: AbortSignal): Promise<CapabilityResult> {
    const onPage = !!cap.ui && !t.forceDirect && (this.opts.onPage?.() ?? false);
    if (!onPage) {
      if (cap.uiOnly) throw Object.assign(new Error('This is done on the studio page, which isn’t available.'), { permanent: true });
      return cap.run(t.params, this.port, signal);
    }
    await this.acquirePage(t.id, signal);
    this.patch(t.id, { usedPage: true });
    const driver = new Driver({
      runId: this.run.id, taskId: t.id, agent: t.role, signal, pace: this.opts.pace,
      releasePage: () => this.releasePage(t.id),
      waitIfPaused: async () => { while (this.run.status === 'paused') await sleep(150); },
    });
    try {
      return await cap.ui!(t.params, driver, this.port, signal);
    } finally {
      this.releasePage(t.id);
    }
  }

  private async acquirePage(id: string, signal: AbortSignal) {
    while (this.pageOwner && this.pageOwner !== id) {
      if (signal.aborted) throw Object.assign(new Error('Cancelled.'), { cancelled: true });
      this.patch(id, { note: 'Waiting for the page (another agent is using it).' });
      await sleep(120);
    }
    this.pageOwner = id;
    this.patch(id, { note: undefined });
  }

  private releasePage(id: string) {
    if (this.pageOwner === id) this.pageOwner = null;
  }

  // --- Independent review (9.3) -------------------------------------------------

  private addReview(t: TaskState, before: Dataset | null, after: Dataset | null) {
    if (t.capability === 'verify.review' || (this.run.reviews ?? 0) >= 8 || !needsReview(t.capability, before, after)) return;
    const id = `${t.id}.review`;
    if (this.run.tasks.some(x => x.id === id)) return;
    const review: TaskState = {
      id, capability: 'verify.review', role: 'verifier', dependsOn: [t.id], why: 'Risk-based independent review.',
      params: { target: { capability: t.capability, params: t.params, result: t.result?.data, label: this.cap(t).label(t.params) } },
      dynamic: true, status: 'pending', attempts: 0, approved: true,
    };
    const at = this.run.tasks.findIndex(x => x.id === t.id) + 1;
    this.run.tasks = [...this.run.tasks.slice(0, at), review, ...this.run.tasks.slice(at)];
    this.run.reviews = (this.run.reviews ?? 0) + 1;
  }

  // --- Self-healing recovery (addendum 18) --------------------------------------------

  /** Opens an incident and tries one safe repair. Returns true when the task was re-queued. */
  private async selfHeal(id: string, cap: Capability, message: string, holdsLock: boolean): Promise<boolean> {
    const t = this.task(id);
    const fp = fingerprint(t.capability, message);
    const incidents = this.run.incidents ?? [];
    const existing = incidents.find(i => i.fingerprint === fp && i.taskId === id);
    const { diagnosis, repair, label } = diagnose(message, { usedPage: !!t.usedPage, uiOnly: !!cap.uiOnly });
    const repairsSoFar = incidents.filter(i => i.repair).length;
    const canRepair = !!repair && !existing && repairsSoFar < RECOVERY_LIMITS.repairsPerRun;
    const incident: Incident = existing ?? {
      id: `inc-${incidents.length + 1}`, taskId: id, fingerprint: fp, state: 'detected', diagnosis, detectedAt: Date.now(),
      log: [`Detected: ${message}`, `Diagnosis: ${diagnosis}`],
    };
    if (!canRepair) {
      incident.state = 'escalated';
      incident.log = [...incident.log, existing ? 'The repair didn’t fix it; escalated to you.' : 'No safe automatic repair; escalated to you.'];
      this.run.incidents = existing ? incidents.map(i => (i.id === incident.id ? incident : i)) : [...incidents, incident];
      this.say('orchestrator', 'user', 'failure', `Needs you: ${cap.label(t.params)} — ${diagnosis}`, id);
      return false;
    }
    incident.state = 'repairing';
    incident.repair = repair!;
    incident.repairLabel = label;
    incident.log = [...incident.log, `Repair: ${label}.`];
    this.run.incidents = [...incidents, incident];
    this.say('orchestrator', t.role, 'recovery', `Self-healing: ${diagnosis} ${label}.`, id);
    if (repair === 'wake_ml') {
      const ok = await (this.opts.wakeMl?.() ?? Promise.resolve(false)).catch(() => false);
      incident.log = [...incident.log, ok ? 'The ML service answered.' : 'The ML service didn’t confirm it is awake; trying anyway.'];
    }
    incident.state = 'validating';
    this.patch(id, {
      status: 'pending', note: `Recovering: ${label}.`,
      ...(repair === 'direct' ? { forceDirect: true } : {}),
      ...(repair === 'more_time' ? { timeBoost: 2 } : {}),
    });
    this.run.telemetry = { ...this.run.telemetry, retries: this.run.telemetry.retries + 1 };
    if (holdsLock) this.dataLock = false;
    this.controllers.delete(id);
    this.save();
    void this.tick();
    return true;
  }

  private closeIncidents(taskId: string) {
    const incidents = this.run.incidents ?? [];
    if (!incidents.some(i => i.taskId === taskId && i.state === 'validating')) return;
    this.run.incidents = incidents.map(i => (i.taskId === taskId && i.state === 'validating'
      ? { ...i, state: 'closed' as const, closedAt: Date.now(), log: [...i.log, 'Validated: the task completed and passed its check.'] }
      : i));
    this.say('orchestrator', 'user', 'recovery', 'Self-healing worked: the task completed after the repair.', taskId);
  }

  /** Tells the agents waiting on this task that its output is ready. */
  private handOff(t: TaskState) {
    const next = this.run.tasks.filter(x => x.dependsOn.includes(t.id) && x.role !== t.role);
    for (const role of new Set(next.map(x => x.role))) {
      this.say(t.role, role, 'handoff', `${AGENTS[t.role].name} → ${AGENTS[role].name}: ${this.cap(t).label(t.params)} is done${t.outputVersionId ? '; the new data version is ready' : ''}.`, t.id);
    }
  }

  /** Bounded dynamic planning: an agent's findings can add tasks, which then need approval (4.2, 5.2). */
  private addFollowUps(t: TaskState, result: CapabilityResult) {
    const proposals = (result.followUps ?? []).filter(f => CAPABILITIES[f.capability]);
    if (!proposals.length) return;
    const room = Math.min(LIMITS.maxDynamicTasks - this.run.dynamicAdded, LIMITS.maxTasks - this.run.tasks.length);
    const taken = proposals.slice(0, Math.max(0, room));
    if (!taken.length) {
      this.say('orchestrator', 'user', 'status', `${proposals.length} suggested fix(es) were not added: the plan is at its size limit.`);
      return;
    }
    const added: TaskState[] = [];
    let prev = t.id;
    for (const f of taken) {
      const cap = CAPABILITIES[f.capability];
      const id = `${t.id}.${added.length + 1}`;
      // Fixes run one after another (each changes the data).
      added.push({ id, capability: f.capability, params: f.params, role: cap.defaultRole, dependsOn: [prev], why: f.reason, dynamic: true, status: 'pending', attempts: 0, approved: preApproved(f.capability, this.run.approvalMode) });
      prev = id;
    }
    // Work that waited for the check now also waits for the fixes.
    this.run.tasks = this.run.tasks.map(x => (x.dependsOn.includes(t.id) ? { ...x, dependsOn: [...x.dependsOn, prev] } : x));
    // Listed right after the task that proposed them, in the order they run.
    const at = this.run.tasks.findIndex(x => x.id === t.id) + 1;
    this.run.tasks = [...this.run.tasks.slice(0, at), ...added, ...this.run.tasks.slice(at)];
    this.run.dynamicAdded += added.length;
    this.say(t.role, 'orchestrator', 'finding', `${AGENTS[t.role].name} proposes ${added.length} fix${added.length === 1 ? '' : 'es'}: ${added.map(a => this.cap(a).label(a.params)).join('; ')}.`, t.id);
    if (proposals.length > taken.length) this.say('orchestrator', 'user', 'status', `${proposals.length - taken.length} more suggested fix(es) left out (limit ${LIMITS.maxDynamicTasks}).`);
  }

  private maybeFinish() {
    if (!['running', 'awaiting_approval'].includes(this.run.status)) return;
    const open = this.run.tasks.filter(t => !TERMINAL.includes(t.status));
    if (open.length === 0) {
      // Before reporting, the Orchestrator reviews the run and fixes what it can.
      if (this.opts.finalReview !== false && !this.run.orchestratorReview) { void this.finalReview(); return; }
      const review = this.run.orchestratorReview;
      if (review?.verdict === 'fixing') {
        const failed = review.fixIds.filter(id => this.task(id)?.status !== 'completed');
        // A fix only counts if its own independent review (if any) agrees.
        const stillContradicted = review.fixIds.filter(id => this.run.tasks.some(t => t.capability === 'verify.review' && t.dependsOn.includes(id) && t.status === 'completed' && !(t.result?.data as any)?.agrees));
        const ok = !failed.length && !stillContradicted.length;
        this.run.orchestratorReview = {
          ...review,
          verdict: ok ? 'fixed' : 'needs_you',
          summary: ok
            ? `Fixed: ${review.fixes.join('; ')}.`
            : failed.length
              ? `${failed.length} fix(es) didn’t succeed; they need you.`
              : `Tried ${review.fixes.join('; ')}, but the independent review still disagrees — the data may not hold enough signal for this. Treat that result with caution.`,
        };
      }
      // A task that was redone successfully counts as done.
      const resolved = (t: TaskState) => t.status === 'completed' || (!!t.supersededBy && this.task(t.supersededBy)?.status === 'completed');
      const anyDone = this.run.tasks.some(t => t.status === 'completed');
      const allDone = this.run.tasks.every(resolved);
      this.run.status = allDone ? 'completed' : anyDone ? 'partial' : 'failed';
      this.finish();
      this.save();
    } else if (open.every(t => t.status === 'awaiting_approval') && this.run.status !== 'awaiting_approval') {
      this.run.status = 'awaiting_approval';
      this.save();
    }
  }

  private reviewing = false;

  /** The Orchestrator's final review (orchestratorReview.ts): audit, optional AI check, one round of fixes. */
  private async finalReview() {
    if (this.reviewing) return;
    this.reviewing = true;
    try {
      const ds = this.port.getDataset();
      const audit = auditRun(this.run, ds);
      this.say('orchestrator', 'user', 'status', audit.issues.length ? `Reviewing the results: ${audit.issues.length} issue(s) found.` : 'Reviewing the results before reporting.');
      this.save();
      let ai: Awaited<ReturnType<NonNullable<RuntimeOptions['aiReview']>>> = null;
      if (this.opts.aiReview && (this.run.tasks.length >= 3 || audit.issues.length)) {
        ai = await this.opts.aiReview(this.run).catch(() => null);
        if (ai) this.run.telemetry = { ...this.run.telemetry, aiCalls: this.run.telemetry.aiCalls + 1, inputTokens: this.run.telemetry.inputTokens + (ai.inputTokens ?? 0), outputTokens: this.run.telemetry.outputTokens + (ai.outputTokens ?? 0) };
      }
      const issues = [...audit.issues, ...(ai?.issues ?? [])];
      const fixes = [
        ...audit.fixes,
        ...(ai?.tasks ?? []).map(t => ({ capability: t.capability, params: t.params, reason: t.why || 'Suggested by the Orchestrator’s review.', dependsOn: [] as string[] })),
      ].filter((f, i, a) => a.findIndex(x => x.capability === f.capability && JSON.stringify(x.params) === JSON.stringify(f.params)) === i).slice(0, MAX_FIXES);

      // Turn the fixes into tasks (each checked against the data as it is now).
      const ids: string[] = [];
      const added: TaskState[] = [];
      fixes.forEach((f, i) => {
        const cap = CAPABILITIES[f.capability];
        const redoOf = (f as { redoOf?: string }).redoOf;
        const id = redoOf ? `${redoOf}.redo` : `review.${i + 1}`;
        ids.push(id);
        const invalid = !cap ? `Unknown capability “${f.capability}”.` : cap.approval === 'prohibited' ? 'Not allowed.' : cap.validate(f.params, ds);
        if (invalid) { issues.push(`Couldn’t fix with “${cap?.label(f.params) ?? f.capability}”: ${invalid}`); return; }
        const deps = (f.dependsOn ?? []).map(d => (d.startsWith('fix:') ? ids[Number(d.slice(4))] ?? '' : d)).filter(d => d && (this.run.tasks.some(t => t.id === d) || added.some(t => t.id === d)));
        added.push({ id, capability: f.capability, params: f.params, role: cap.defaultRole, dependsOn: deps, why: f.reason, dynamic: true, status: 'pending', attempts: 0, approved: preApproved(f.capability, this.run.approvalMode) });
        if (redoOf) this.patch(redoOf, { supersededBy: id });
      });

      if (added.length) {
        this.run.orchestratorReview = { verdict: 'fixing', summary: ai?.summary ?? `Fixing ${added.length} issue(s).`, issues, fixes: added.map(t => this.cap(t).label(t.params)), fixIds: added.map(t => t.id), usedAi: !!ai };
        this.run.tasks = [...this.run.tasks, ...added];
        this.run.dynamicAdded += added.length;
        this.say('orchestrator', 'user', 'recovery', `Redoing what went wrong: ${added.map(t => `${this.cap(t).label(t.params)} (${t.why})`).join('; ')}.`);
        this.save();
        // The review can run inside the scheduler's own loop; start the fixes after it.
        setTimeout(() => void this.tick(), 0);
        return;
      }
      this.run.orchestratorReview = {
        verdict: issues.length ? 'needs_you' : 'complete',
        summary: ai?.summary ?? (issues.length ? `${issues.length} issue(s) couldn’t be fixed automatically.` : 'Everything that was planned was delivered and checked.'),
        issues, fixes: [], fixIds: [], usedAi: !!ai,
      };
      this.maybeFinish();
    } finally {
      this.reviewing = false;
    }
  }

  private finish() {
    this.run.report = buildReport(this.run, this.port.getDataset());
    this.say('orchestrator', 'user', 'status', this.run.report.headline);
  }
}

/** The completion report, built only from task results and checks (9.5, A25). */
export function buildReport(run: SwarmRun, ds: Dataset | null): CompletionReport {
  const label = (t: TaskState) => CAPABILITIES[t.capability]?.label(t.params) ?? t.capability;
  const isReview = (t: TaskState) => t.capability === 'verify.review';
  const done = run.tasks.filter(t => t.status === 'completed' && !isReview(t)).map(t => ({ label: label(t), role: t.role, summary: t.result?.summary ?? '', check: t.check?.detail }));
  const reviews = run.tasks.filter(t => isReview(t) && t.status === 'completed').map(t => ({
    label: String((t.params as any)?.target?.label ?? ''), agrees: !!(t.result?.data as any)?.agrees, detail: t.result?.summary ?? '',
  }));
  // Work the Orchestrator redid successfully isn't a problem any more.
  const redoneOk = (t: TaskState) => !!t.supersededBy && run.tasks.find(x => x.id === t.supersededBy)?.status === 'completed';
  const problems = run.tasks.filter(t => t.status !== 'completed' && !redoneOk(t)).map(t => ({ label: label(t), role: t.role, status: t.status, reason: t.error ?? t.note ?? t.status }));
  const versions = run.tasks.map(t => t.outputVersionId).filter(Boolean) as string[];
  const status = run.status;
  const contradictions = reviews.filter(r => !r.agrees).length;
  const fixedNote = run.orchestratorReview?.verdict === 'fixed'
    ? ` The Orchestrator found and fixed ${run.orchestratorReview.fixIds.length} issue${run.orchestratorReview.fixIds.length === 1 ? '' : 's'}.`
    : run.orchestratorReview?.verdict === 'needs_you' && run.orchestratorReview.fixIds.length ? ' The Orchestrator tried a fix; see its review.' : '';
  const headline = status === 'completed'
    ? `Done: all ${done.length} task${done.length === 1 ? '' : 's'} completed and self-checked${reviews.length ? `; ${reviews.length} independently reviewed${contradictions ? `, ${contradictions} with a contradiction` : ''}` : ''}.${fixedNote}`
    : status === 'cancelled'
    ? `Cancelled after ${done.length} of ${run.tasks.length} tasks.`
    : `${done.length} of ${run.tasks.length} tasks completed; ${problems.length} did not.`;
  const unreviewed = done.length - reviews.length;
  const limitations = [
    ...(unreviewed > 0 ? [`${unreviewed} result${unreviewed === 1 ? ' was' : 's were'} checked only by the agent that produced ${unreviewed === 1 ? 'it' : 'them'} (self-check); independent review runs for risky results.`] : []),
    ...(contradictions ? [`The independent review disagreed with ${contradictions} result${contradictions === 1 ? '' : 's'}; treat ${contradictions === 1 ? 'it' : 'them'} with caution.`] : []),
    ...(problems.length ? [`Not delivered: ${problems.map(p => p.label).join('; ')}.`] : []),
  ];
  const times = run.tasks.map(t => t.endedAt ?? 0).filter(Boolean);
  const STEPS: [string, string][] = [['ingest', 'Import'], ['clean', 'Clean'], ['eda', 'Explore'], ['stats', 'Statistics'], ['ml', 'Model'], ['dashboard', 'Dashboard'], ['reports', 'Report']];
  const doneTasks = run.tasks.filter(t => t.status === 'completed' && !isReview(t) && t.capability !== 'nav.open_step');
  const bySteps = STEPS.map(([id, name]) => ({ step: name, count: doneTasks.filter(t => CAPABILITIES[t.capability]?.step === id).length })).filter(x => x.count > 0);
  return {
    status, headline, done, problems, reviews, bySteps, orchestrator: run.orchestratorReview,
    incidents: (run.incidents ?? []).map(i => ({ diagnosis: i.diagnosis, state: i.state, repair: i.repairLabel })),
    data: { startVersionId: run.startVersionId, endVersionId: versions[versions.length - 1] ?? run.startVersionId, rows: ds?.rows.length, columns: ds?.columns.length },
    limitations, telemetry: run.telemetry,
    durationMs: (times.length ? Math.max(...times) : Date.now()) - run.createdAt,
  };
}
