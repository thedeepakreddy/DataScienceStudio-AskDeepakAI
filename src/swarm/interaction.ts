/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import type { AgentRole } from './agents';

// The interaction engine (blueprint 11.4–11.7). Agents operate the studio on
// the user's own page: they open steps, choose options, type and click the
// real controls, which are marked with data-agent="…". Every action emits an
// event the cursor layer draws, and each event belongs to an agent, a task
// and a run. Nothing is animated that didn't happen; the operation's result,
// not the animation, decides success.

export type InteractionAction = 'move' | 'navigate' | 'claim' | 'open' | 'hover' | 'select' | 'type' | 'click' | 'check' | 'skip' | 'point' | 'wait' | 'done' | 'error' | 'release';

export interface InteractionEvent {
  id: string;
  seq: number;
  at: number;
  runId: string;
  taskId: string;
  agent: AgentRole;
  /** One pointer per concurrent task, so an agent can show several. */
  pointerId: string;
  action: InteractionAction;
  /** The data-agent id of the control. */
  target?: string;
  label: string;
  value?: string;
  outcome?: 'ok' | 'missing' | 'failed';
  /** For 'open' and 'hover': the list's choices and which one the pointer is on. */
  options?: string[];
  index?: number;
  /** For 'point': where on the page the result appeared. */
  point?: { x: number; y: number };
}

type Listener = (e: InteractionEvent) => void;
/** Returns a promise when the page wants the agent to wait (for example while a box is dragged open). */
type Gate = (e: InteractionEvent) => Promise<void> | void;

class InteractionBus {
  private listeners = new Set<Listener>();
  private gates = new Set<Gate>();
  private seq = 0;
  subscribe(fn: Listener) { this.listeners.add(fn); return () => { this.listeners.delete(fn); }; }
  /**
   * Lets the cursor layer hold an agent until what it draws has caught up:
   * the partner cursor has dragged the box open and the working cursor is
   * inside it. The action itself still decides success.
   */
  addGate(fn: Gate) { this.gates.add(fn); return () => { this.gates.delete(fn); }; }
  /** Resolves once every gate is ready, or after `cap` ms so drawing can never stall an agent. */
  ready(e: InteractionEvent, cap: number): Promise<void> {
    const waits = [...this.gates].map(g => g(e)).filter((w): w is Promise<void> => !!w);
    if (!waits.length) return Promise.resolve();
    return new Promise(resolve => {
      const t = setTimeout(resolve, cap);
      const finish = () => { clearTimeout(t); resolve(); };
      Promise.all(waits).then(finish, finish);
    });
  }
  emit(e: Omit<InteractionEvent, 'id' | 'seq' | 'at'>) {
    const ev = { ...e, id: `${e.taskId}-${++this.seq}`, seq: this.seq, at: Date.now() };
    this.listeners.forEach(l => l(ev));
    return ev;
  }
}

export const interactions = new InteractionBus();

/** The DOM element for a data-agent id, if it is on the page. */
export function findTarget(target: string): HTMLElement | null {
  if (typeof document === 'undefined') return null;
  const safe = target.replace(/["\\]/g, '\\$&');
  // Steps you've left stay on the page (hidden): prefer the control you can see.
  const all = [...document.querySelectorAll<HTMLElement>(`[data-agent="${safe}"]`)];
  return all.find(el => !el.closest('[hidden]')) ?? all[0] ?? null;
}

const sleep = (ms: number, signal?: AbortSignal) => new Promise<void>((resolve, reject) => {
  const t = setTimeout(resolve, ms);
  signal?.addEventListener('abort', () => { clearTimeout(t); reject(Object.assign(new Error('Cancelled.'), { cancelled: true })); }, { once: true });
});

/** Sets a React-controlled field's value the way a person typing would. */
function setNativeValue(el: HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement, value: string) {
  const proto = el instanceof HTMLSelectElement ? HTMLSelectElement.prototype : el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(proto, 'value')?.set?.call(el, value);
  el.dispatchEvent(new Event(el instanceof HTMLSelectElement ? 'change' : 'input', { bubbles: true }));
  if (!(el instanceof HTMLSelectElement)) el.dispatchEvent(new Event('change', { bubbles: true }));
}

export class UiError extends Error {}

/** How fast agents move on the page: Natural (default), Fast, or Instant (also with reduced motion). */
export type AgentSpeed = 'natural' | 'fast' | 'instant';
export const AGENT_SPEED_KEY = 'agent-speed';
export function agentSpeed(): AgentSpeed {
  try {
    if (typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) return 'instant';
    const v = localStorage.getItem(AGENT_SPEED_KEY);
    return v === 'fast' || v === 'instant' ? v : 'natural';
  } catch { return 'natural'; }
}
const SPEED_FACTOR: Record<AgentSpeed, number> = { natural: 1, fast: 0.45, instant: 0 };

/** Which task is using which control right now: two agents never use one control at once. */
const inUse = new Map<string, { taskId: string; agent: AgentRole; at: number }>();
/** A control held longer than this (a task that died mid-action) is free again. */
const LOCK_MS = 20_000;

/** A small, human pause around `ms` (never negative). */
const jitter = (ms: number) => Math.max(0, ms * (0.75 + Math.random() * 0.5));

export interface DriverContext {
  runId: string;
  taskId: string;
  agent: AgentRole;
  signal: AbortSignal;
  /** Called when the agent no longer needs the page (it is waiting on a result). */
  releasePage: () => void;
  /** Milliseconds for a pointer to travel; 0 in tests. */
  pace?: number;
  /** Holds the agent while the run is paused (for example when the user takes over). */
  waitIfPaused?: () => Promise<void>;
  /** Longest the page may hold an agent while it draws (default 3.2 s: a panel lighting up and the worker moving in). */
  visualCap?: number;
}

/** What an agent uses to operate the page. Every call emits a grounded event. */
export class Driver {
  constructor(private ctx: DriverContext) {}

  private emit(action: InteractionAction, label: string, extra: Partial<InteractionEvent> = {}) {
    return interactions.emit({ runId: this.ctx.runId, taskId: this.ctx.taskId, agent: this.ctx.agent, pointerId: this.ctx.taskId, action, label, ...extra });
  }

  // Long enough for the pointer to finish its curved, human-paced move, and
  // unhurried enough for a person to follow each step.
  private get pace() { return this.ctx.pace ?? 760 * SPEED_FACTOR[agentSpeed()]; }

  /** Waits for the pointer's travel and for the page to finish drawing the step. */
  private async hold(ev: InteractionEvent) {
    await Promise.all([sleep(this.pace, this.ctx.signal), interactions.ready(ev, this.ctx.visualCap ?? 3200)]);
  }

  /** Waits for a control to appear (after a step change), up to `timeout`. */
  async waitFor(target: string, timeout = 5000): Promise<HTMLElement> {
    const end = Date.now() + timeout;
    for (;;) {
      const el = findTarget(target);
      if (el && !(el as HTMLButtonElement).disabled) return el;
      if (Date.now() > end) {
        this.emit('error', `Couldn’t find “${target}” on the page`, { target, outcome: 'missing' });
        throw new UiError(`The control “${target}” isn’t on the page.`);
      }
      await sleep(80, this.ctx.signal);
    }
  }

  private async approach(target: string, label: string) {
    await this.ctx.waitIfPaused?.();
    const el = await this.waitFor(target);
    await this.takeTurn(target);
    el.scrollIntoView?.({ block: 'center', behavior: this.pace ? 'smooth' : 'auto' });
    // The partner cursor drags a box open round the control, then the working cursor moves in.
    await this.hold(this.emit('move', label, { target }));
    return el;
  }

  /** Waits nearby while another agent uses the same control, then takes it. */
  private async takeTurn(target: string) {
    let said = false;
    for (;;) {
      const other = inUse.get(target);
      if (!other || other.taskId === this.ctx.taskId || Date.now() - other.at > LOCK_MS) break;
      if (!said) { this.emit('wait', `Waiting for ${other.agent.replace(/_/g, ' ')}`, { target }); said = true; }
      await sleep(120, this.ctx.signal);
    }
    for (const [k, v] of inUse) if (v.taskId === this.ctx.taskId) inUse.delete(k);
    inUse.set(target, { taskId: this.ctx.taskId, agent: this.ctx.agent, at: Date.now() });
  }

  /** Gives the control back once this action is over. */
  private leave(target: string) {
    if (inUse.get(target)?.taskId === this.ctx.taskId) inUse.delete(target);
  }

  /** The value is already what the agent wants: it glides past instead of pretending to act. */
  private async skip(target: string, label: string, value?: string) {
    const el = await this.waitFor(target);
    this.emit('skip', `Already set: ${value ?? label}`, { target, value, outcome: 'ok' });
    el.scrollIntoView?.({ block: 'nearest', behavior: this.pace ? 'smooth' : 'auto' });
    await sleep(this.pace / 2, this.ctx.signal);
  }

  /** Presses the control visibly (a short squeeze), as a finger or mouse would. */
  private async press(el: HTMLElement) {
    if (!this.pace) return;
    el.classList.add('agent-pressing');
    await sleep(Math.min(140, this.pace / 5), this.ctx.signal);
    el.classList.remove('agent-pressing');
  }

  /**
   * After a click, waits for the page's real answer (something added or changed
   * nearby, up to a second) and points at it, so every click shows its effect.
   */
  private async awaitResult(el: HTMLElement, label: string, target: string) {
    if (!this.pace || typeof MutationObserver === 'undefined') return;
    const scope = el.closest('[data-agent^="area-"], .card, section, main') ?? document.body;
    const changed = await new Promise<HTMLElement | null>(resolve => {
      const done = (x: HTMLElement | null) => { obs.disconnect(); clearTimeout(t); resolve(x); };
      const obs = new MutationObserver(records => {
        for (const r of records) {
          const n = [...r.addedNodes].find((x): x is HTMLElement => x instanceof HTMLElement && x.getBoundingClientRect().height > 8);
          if (n) return done(n);
        }
      });
      obs.observe(scope, { childList: true, subtree: true });
      const t = setTimeout(() => done(null), 1000);
    });
    if (changed && !changed.closest('[data-swarm-ui]')) {
      const r = changed.getBoundingClientRect();
      if (r.width && r.top < (window.innerHeight || 1e4) && r.bottom > 0) {
        this.emit('point', label, { target, point: { x: r.left + Math.min(r.width / 2, 60), y: r.top + Math.min(r.height / 2, 24) }, outcome: 'ok' });
        await sleep(this.pace / 2, this.ctx.signal);
      }
    }
  }

  /** Opens a step by clicking its tab in the step bar. */
  async navigate(step: string, label: string) {
    const el = await this.approach(`nav-${step}`, label);
    await this.press(el);
    el.click();
    this.emit('navigate', label, { target: `nav-${step}`, outcome: 'ok' });
    await sleep(this.pace / 2, this.ctx.signal);
    this.leave(`nav-${step}`);
  }

  /** Drags a selection box over the area the agent is about to work in. */
  async claim(target: string, label: string) {
    await this.approach(target, label);
    await this.hold(this.emit('claim', label, { target, outcome: 'ok' }));
  }

  async select(target: string, value: string, label: string) {
    const peek = findTarget(target);
    if (peek instanceof HTMLSelectElement && peek.value === value) return this.skip(target, label, optionText(peek, value));
    const el = await this.approach(target, label);
    if (!(el instanceof HTMLSelectElement)) throw new UiError(`“${target}” isn’t a list.`);
    const options = [...el.options];
    const index = options.findIndex(o => o.value === value);
    if (index < 0) {
      this.emit('error', `“${value}” isn’t one of the choices`, { target, value, outcome: 'failed' });
      this.leave(target);
      throw new UiError(`“${value}” isn’t a choice in “${target}”.`);
    }
    // Open the list, run down it to the choice, then pick it.
    await this.press(el);
    const texts = options.map(o => o.text);
    this.emit('open', label, { target, options: texts, index: el.selectedIndex });
    await sleep(jitter(this.pace / 3), this.ctx.signal);
    const from = Math.max(0, el.selectedIndex);
    const steps = Math.min(4, Math.abs(index - from));
    for (let k = 1; k <= steps; k++) {
      this.emit('hover', label, { target, options: texts, index: Math.round(from + ((index - from) * k) / steps) });
      await sleep(jitter(this.pace / 7), this.ctx.signal);
    }
    this.emit('hover', label, { target, options: texts, index });
    await sleep(jitter(this.pace / 4), this.ctx.signal);
    setNativeValue(el, value);
    this.emit('select', label, { target, value: texts[index], outcome: el.value === value ? 'ok' : 'failed' });
    await sleep(this.pace / 2, this.ctx.signal);
    this.leave(target);
  }

  async type(target: string, value: string, label: string) {
    const peek = findTarget(target);
    if ((peek instanceof HTMLInputElement || peek instanceof HTMLTextAreaElement) && peek.value === value) return this.skip(target, label, value.length > 40 ? `${value.slice(0, 40)}…` : value);
    const el = await this.approach(target, label);
    if (!(el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement)) throw new UiError(`“${target}” isn’t a text field.`);
    await this.press(el);
    el.focus();
    // Old text is selected and replaced, as when you click in and start typing.
    if (el.value) { el.select?.(); await sleep(jitter(this.pace / 5), this.ctx.signal); }
    if (!this.pace) {
      setNativeValue(el, value);
      this.emit('type', label, { target, value, outcome: 'ok' });
    } else {
      // Key by key at a typing rhythm (quicker for long text, so it never drags on), with small pauses between words.
      const per = Math.max(8, Math.min(70, 2600 / Math.max(1, value.length))) * (this.pace / 760);
      const batch = Math.max(1, Math.ceil(value.length / 160));
      for (let i = batch; i < value.length + batch; i += batch) {
        const text = value.slice(0, Math.min(i, value.length));
        setNativeValue(el, text);
        this.emit('type', label, { target, value: text, outcome: 'ok' });
        const ch = value[Math.min(i, value.length) - 1];
        await sleep(jitter(per * batch) + (ch === ' ' || ch === ',' ? jitter(per * 2) : 0), this.ctx.signal);
      }
    }
    await sleep(this.pace / 4, this.ctx.signal);
    this.leave(target);
  }

  async check(target: string, checked: boolean, label: string) {
    const peek = findTarget(target);
    if (peek instanceof HTMLInputElement && peek.checked === checked) return this.skip(target, label, checked ? 'on' : 'off');
    const el = await this.approach(target, label);
    if (!(el instanceof HTMLInputElement)) throw new UiError(`“${target}” isn’t a checkbox.`);
    await this.press(el);
    if (el.checked !== checked) el.click();
    this.emit('check', label, { target, value: String(checked), outcome: el.checked === checked ? 'ok' : 'failed' });
    await sleep(this.pace / 3, this.ctx.signal);
    this.leave(target);
  }

  async click(target: string, label: string) {
    const el = await this.approach(target, label);
    await this.press(el);
    el.click();
    this.emit('click', label, { target, outcome: 'ok' });
    await this.awaitResult(el, label, target);
    await sleep(this.pace / 4, this.ctx.signal);
    this.leave(target);
  }

  /** Lets other agents use the page while this one waits for a result. */
  release(label: string) {
    this.leaveAll();
    this.emit('release', label);
    this.ctx.releasePage();
  }

  wait(label: string) { this.emit('wait', label); }
  done(label: string) { this.leaveAll(); this.emit('done', label, { outcome: 'ok' }); }
  fail(label: string) { this.leaveAll(); this.emit('error', label, { outcome: 'failed' }); }

  private leaveAll() { for (const [k, v] of inUse) if (v.taskId === this.ctx.taskId) inUse.delete(k); }
}

/** Resolves with the next run of `kind` the studio logs (results of UI actions). */
const optionText = (el: HTMLSelectElement, value: string) => [...el.options].find(o => o.value === value)?.text ?? value;

export function waitForLoggedRun<T = any>(kind: string, signal: AbortSignal, timeout = 120_000): Promise<T> {
  return new Promise((resolve, reject) => {
    const onRun = (e: Event) => {
      const run = (e as CustomEvent).detail;
      if (run?.kind !== kind) return;
      cleanup();
      if (run.status === 'failed') reject(new Error(run.error || 'The action failed.'));
      else resolve(run as T);
    };
    const timer = setTimeout(() => { cleanup(); reject(new Error(`Timed out waiting for the ${kind} result.`)); }, timeout);
    const onAbort = () => { cleanup(); reject(Object.assign(new Error('Cancelled.'), { cancelled: true })); };
    const cleanup = () => { clearTimeout(timer); window.removeEventListener(RUN_LOGGED_EVENT, onRun); signal.removeEventListener('abort', onAbort); };
    window.addEventListener(RUN_LOGGED_EVENT, onRun);
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

export const RUN_LOGGED_EVENT = 'studio:run-logged';

/** Sent when the current run is cleared (Clear in the chat or the Agents panel): the panel glows go out. */
export const SWARM_CLEARED_EVENT = 'studio:swarm-cleared';
