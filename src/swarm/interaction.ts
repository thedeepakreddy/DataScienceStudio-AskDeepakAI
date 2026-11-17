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

export type InteractionAction = 'move' | 'navigate' | 'claim' | 'select' | 'type' | 'click' | 'check' | 'wait' | 'done' | 'error' | 'release';

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
}

type Listener = (e: InteractionEvent) => void;

class InteractionBus {
  private listeners = new Set<Listener>();
  private seq = 0;
  subscribe(fn: Listener) { this.listeners.add(fn); return () => { this.listeners.delete(fn); }; }
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
  return document.querySelector<HTMLElement>(`[data-agent="${safe}"]`);
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
}

/** What an agent uses to operate the page. Every call emits a grounded event. */
export class Driver {
  constructor(private ctx: DriverContext) {}

  private emit(action: InteractionAction, label: string, extra: Partial<InteractionEvent> = {}) {
    return interactions.emit({ runId: this.ctx.runId, taskId: this.ctx.taskId, agent: this.ctx.agent, pointerId: this.ctx.taskId, action, label, ...extra });
  }

  private get pace() { return this.ctx.pace ?? 450; }

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
    el.scrollIntoView?.({ block: 'center', behavior: 'smooth' });
    this.emit('move', label, { target });
    await sleep(this.pace, this.ctx.signal);
    return el;
  }

  /** Opens a step by clicking its tab in the step bar. */
  async navigate(step: string, label: string) {
    const el = await this.approach(`nav-${step}`, label);
    el.click();
    this.emit('navigate', label, { target: `nav-${step}`, outcome: 'ok' });
    await sleep(this.pace / 2, this.ctx.signal);
  }

  /** Drags a selection box over the area the agent is about to work in. */
  async claim(target: string, label: string) {
    await this.approach(target, label);
    this.emit('claim', label, { target, outcome: 'ok' });
    await sleep(this.pace, this.ctx.signal);
  }

  async select(target: string, value: string, label: string) {
    const el = await this.approach(target, label);
    if (!(el instanceof HTMLSelectElement)) throw new UiError(`“${target}” isn’t a list.`);
    if (![...el.options].some(o => o.value === value)) {
      this.emit('error', `“${value}” isn’t one of the choices`, { target, value, outcome: 'failed' });
      throw new UiError(`“${value}” isn’t a choice in “${target}”.`);
    }
    setNativeValue(el, value);
    this.emit('select', label, { target, value, outcome: el.value === value ? 'ok' : 'failed' });
    await sleep(this.pace / 2, this.ctx.signal);
  }

  async type(target: string, value: string, label: string) {
    const el = await this.approach(target, label);
    if (!(el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement)) throw new UiError(`“${target}” isn’t a text field.`);
    el.focus();
    // Typed in a few chunks so the text visibly appears.
    const chunks = Math.min(6, Math.max(1, Math.ceil(value.length / 6)));
    for (let i = 1; i <= chunks; i++) {
      setNativeValue(el, value.slice(0, Math.ceil((value.length * i) / chunks)));
      this.emit('type', label, { target, value: el.value, outcome: 'ok' });
      await sleep(this.pace / 6, this.ctx.signal);
    }
  }

  async check(target: string, checked: boolean, label: string) {
    const el = await this.approach(target, label);
    if (!(el instanceof HTMLInputElement)) throw new UiError(`“${target}” isn’t a checkbox.`);
    if (el.checked !== checked) el.click();
    this.emit('check', label, { target, value: String(checked), outcome: el.checked === checked ? 'ok' : 'failed' });
  }

  async click(target: string, label: string) {
    const el = await this.approach(target, label);
    el.click();
    this.emit('click', label, { target, outcome: 'ok' });
    await sleep(this.pace / 3, this.ctx.signal);
  }

  /** Lets other agents use the page while this one waits for a result. */
  release(label: string) {
    this.emit('release', label);
    this.ctx.releasePage();
  }

  wait(label: string) { this.emit('wait', label); }
  done(label: string) { this.emit('done', label, { outcome: 'ok' }); }
  fail(label: string) { this.emit('error', label, { outcome: 'failed' }); }
}

/** Resolves with the next run of `kind` the studio logs (results of UI actions). */
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
