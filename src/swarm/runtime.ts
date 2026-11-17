/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Dataset } from '../types';
import { AGENTS, AgentRole } from './agents';
import { CAPABILITIES, Capability, CapabilityResult, StudioPort } from './catalog';
import { LIMITS, TaskSpec, TaskStatus } from './plan';

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
  check?: { ok: boolean; detail: string; kind: 'self-check' };
  error?: string;
  /** Why it is blocked or waiting. */
  note?: string;
  /** Data version it started from, and the one it produced (idempotency, 7.3). */
  inputVersionId?: string | null;
  outputVersionId?: string | null;
  cancelRequested?: boolean;
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
  startVersionId: string | null;
  tasks: TaskState[];
  messages: BusMessage[];
  telemetry: Telemetry;
  dynamicAdded: number;
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

export function newRun(opts: { request: string; reply: string; plannedBy: SwarmRun['plannedBy']; tasks: TaskSpec[]; datasetId: string | null; startVersionId: string | null; aiCalls?: number; inputTokens?: number; outputTokens?: number; cacheHit?: boolean }): SwarmRun {
  const now = Date.now();
  return {
    id: newId(), datasetId: opts.datasetId, request: opts.request, reply: opts.reply, plannedBy: opts.plannedBy,
    createdAt: now, updatedAt: now, status: 'awaiting_approval', startVersionId: opts.startVersionId,
    tasks: opts.tasks.map(t => ({ ...t, status: 'pending', attempts: 0, approved: CAPABILITIES[t.capability]?.approval === 'autonomous' })),
    messages: [],
    telemetry: { aiCalls: opts.aiCalls ?? 0, inputTokens: opts.inputTokens ?? 0, outputTokens: opts.outputTokens ?? 0, cacheHits: opts.cacheHit ? 1 : 0, deterministicOps: 0, retries: 0, failures: 0 },
    dynamicAdded: 0,
  };
}

export class SwarmRuntime {
  run: SwarmRun;
  private port: RuntimePort;
  private persist: (run: SwarmRun) => Promise<void>;
  private onChange: (run: SwarmRun) => void;
  private controllers = new Map<string, AbortController>();
  private dataLock = false;
  private ticking = false;

  constructor(run: SwarmRun, port: RuntimePort, persist: (run: SwarmRun) => Promise<void>, onChange: (run: SwarmRun) => void) {
    this.run = run;
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

  pause() {
    if (this.run.status !== 'running') return;
    this.run.status = 'paused';
    this.say('orchestrator', 'user', 'status', 'Paused. Tasks already running will finish; no new ones start.');
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
      const result: CapabilityResult = await Promise.race([
        cap.run(t.params, this.port, controller.signal),
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error(`Timed out after ${Math.round(cap.timeoutMs / 1000)}s.`)), cap.timeoutMs)),
      ]);
      if (this.task(id).cancelRequested) throw Object.assign(new Error('Cancelled.'), { cancelled: true });
      this.patch(id, { status: 'verifying' });
      const outputVersionId = cap.sideEffect === 'new-version' ? await this.port.settle() : null;
      const after = this.port.getDataset();
      const check = cap.selfCheck(t.params, before, after, result);
      this.run.telemetry = { ...this.run.telemetry, deterministicOps: this.run.telemetry.deterministicOps + 1 };
      this.patch(id, {
        status: check.ok ? 'completed' : 'failed', endedAt: Date.now(), result: { summary: result.summary, data: result.data },
        check: { ...check, kind: 'self-check' }, outputVersionId, error: check.ok ? undefined : check.detail,
      });
      this.say(t.role, 'orchestrator', check.ok ? 'finding' : 'failure', `${result.summary}${check.ok ? '' : ` Check failed: ${check.detail}`}`, id);
      if (check.ok) {
        this.handOff(t);
        this.addFollowUps(t, result);
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
      added.push({ id, capability: f.capability, params: f.params, role: cap.defaultRole, dependsOn: [prev], why: f.reason, dynamic: true, status: 'pending', attempts: 0, approved: cap.approval === 'autonomous' });
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
      const anyDone = this.run.tasks.some(t => t.status === 'completed');
      const allDone = this.run.tasks.every(t => t.status === 'completed');
      this.run.status = allDone ? 'completed' : anyDone ? 'partial' : 'failed';
      this.finish();
      this.save();
    } else if (open.every(t => t.status === 'awaiting_approval') && this.run.status !== 'awaiting_approval') {
      this.run.status = 'awaiting_approval';
      this.save();
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
  const done = run.tasks.filter(t => t.status === 'completed').map(t => ({ label: label(t), role: t.role, summary: t.result?.summary ?? '', check: t.check?.detail }));
  const problems = run.tasks.filter(t => t.status !== 'completed').map(t => ({ label: label(t), role: t.role, status: t.status, reason: t.error ?? t.note ?? t.status }));
  const versions = run.tasks.map(t => t.outputVersionId).filter(Boolean) as string[];
  const status = run.status;
  const headline = status === 'completed'
    ? `Done: all ${done.length} task${done.length === 1 ? '' : 's'} completed and self-checked.`
    : status === 'cancelled'
    ? `Cancelled after ${done.length} of ${run.tasks.length} tasks.`
    : `${done.length} of ${run.tasks.length} tasks completed; ${problems.length} did not.`;
  const limitations = [
    'Checks are self-checks by the agent that did the work; no independent review has run.',
    ...(problems.length ? [`Not delivered: ${problems.map(p => p.label).join('; ')}.`] : []),
  ];
  const times = run.tasks.map(t => t.endedAt ?? 0).filter(Boolean);
  return {
    status, headline, done, problems,
    data: { startVersionId: run.startVersionId, endVersionId: versions[versions.length - 1] ?? run.startVersionId, rows: ds?.rows.length, columns: ds?.columns.length },
    limitations, telemetry: run.telemetry,
    durationMs: (times.length ? Math.max(...times) : Date.now()) - run.createdAt,
  };
}
