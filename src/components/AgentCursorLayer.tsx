/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { AGENTS } from '../swarm/agents';
import { InteractionEvent, SWARM_CLEARED_EVENT, findTarget, interactions } from '../swarm/interaction';
import { HumanPointer } from './AgentCursor';
import { AgentStage } from './agentStage';

// Draws the agents at work on the user's page (blueprint 11.4–11.7). Every
// running task has two cursors from the same agent:
// - the partner (two-tone, fast) lights up each panel the task works in: it
//   darts to the panel's centre, touches it and explodes into fine dust that
//   becomes the panel's glow (agentStage.ts, which also draws the tree from
//   the Orchestrator to every panel worked on);
// - the worker (solid) moves in and does the real clicks, choices and typing,
//   with a flash of click rays each time.
// The agent waits (through interactions.addGate) until a new panel is lit and
// the worker is inside, so the order on screen is the order of the real
// actions. Everything here comes from interaction events the engine emitted
// for real actions; nothing is drawn on its own.

interface Pointer {
  id: string;
  agent: InteractionEvent['agent'];
  target?: string;
  label: string;
  action: InteractionEvent['action'];
  x: number;
  y: number;
  at: number;
  waiting: boolean;
  /** Bumped to make the pointer jump (following a scroll) instead of travelling. */
  snap?: number;
  /** Bumped on each click or keystroke, to flash the click rays. */
  clicks?: number;
}

interface Ripple { id: string; x: number; y: number; color: string }
/** A list an agent opened: drawn over the real select (whose own list can't be opened by a script). */
interface OpenList { pointerId: string; target: string; options: string[]; index: number; color: string; rect: { left: number; top: number; width: number } }
const OPTION_PX = 30;

/** Longest move of the working cursor into a panel. */
const WORKER_MS = 460;
const CLICKY = new Set<InteractionEvent['action']>(['click', 'navigate', 'check', 'select', 'type']);

const centre = (el: HTMLElement) => {
  const r = el.getBoundingClientRect();
  return { x: r.left + Math.min(r.width / 2, 48), y: r.top + r.height / 2 };
};

/** At most eight rows, kept round the highlighted one. */
function visibleOptions(l: OpenList) {
  const all = l.options.map((text, i) => ({ text, i }));
  if (all.length <= 8) return all;
  const start = Math.max(0, Math.min(all.length - 8, l.index - 3));
  return all.slice(start, start + 8);
}

export default function AgentCursorLayer() {
  const [pointers, setPointers] = useState<Record<string, Pointer>>({});
  const [ripples, setRipples] = useState<Ripple[]>([]);
  const [lists, setLists] = useState<Record<string, OpenList>>({});
  const host = useRef<HTMLDivElement>(null);
  const stage = useRef<AgentStage | null>(null);
  const timers = useRef(new Map<string, ReturnType<typeof setTimeout>>());
  /** Agents waiting for a panel to light up, by event id. */
  const pending = useRef(new Map<string, Promise<void>>());

  useEffect(() => {
    if (!host.current) return;
    const s = new AgentStage(host.current);
    stage.current = s;
    const onClear = () => s.clear();
    window.addEventListener(SWARM_CLEARED_EVENT, onClear);
    return () => { window.removeEventListener(SWARM_CLEARED_EVENT, onClear); s.destroy(); stage.current = null; };
  }, []);

  /** Sends the working cursor to `target`. */
  const sendWorker = useCallback((pointerId: string, target: string) => {
    const el = findTarget(target);
    if (!el) return;
    const c = centre(el);
    setPointers(prev => {
      const p = prev[pointerId];
      return p ? { ...prev, [pointerId]: { ...p, target, x: c.x, y: c.y } } : prev;
    });
  }, []);

  // Agents wait while a new panel lights up and the worker moves in.
  useEffect(() => interactions.addGate(e => pending.current.get(e.id)), []);

  useEffect(() => interactions.subscribe(e => {
    const color = AGENTS[e.agent].color;
    const el = e.target ? findTarget(e.target) : null;
    let pos = el ? centre(el) : undefined;
    const pointerId = e.pointerId;

    // A list opens under the select, the pointer runs down to the choice, the pick closes it.
    if ((e.action === 'open' || e.action === 'hover') && el && e.options) {
      const r = el.getBoundingClientRect();
      const list: OpenList = { pointerId, target: e.target!, options: e.options, index: e.index ?? 0, color, rect: { left: r.left, top: r.bottom + 4, width: Math.max(r.width, 180) } };
      setLists(prev => ({ ...prev, [pointerId]: list }));
      const shown = visibleOptions(list);
      const row = shown.findIndex(o => o.i === list.index);
      if (e.action === 'hover' && row >= 0) pos = { x: list.rect.left + Math.min(list.rect.width / 2, 60), y: list.rect.top + 6 + row * OPTION_PX + OPTION_PX / 2 };
    }
    if (e.action === 'select' || e.action === 'done' || e.action === 'error' || e.action === 'release') {
      setLists(prev => { if (!prev[pointerId]) return prev; const n = { ...prev }; delete n[pointerId]; return n; });
    }
    // The result of a click: the pointer goes to what appeared.
    if (e.action === 'point' && e.point) pos = e.point;

    // Reaching a control in a panel this task hasn't used yet lights that panel up first.
    let lighting: Promise<void> | null = null;
    if ((e.action === 'move' || e.action === 'claim') && e.target && stage.current) {
      lighting = stage.current.reach(pointerId, e.agent, e.target);
      if (lighting) {
        const target = e.target;
        const gate = lighting.then(() => { sendWorker(pointerId, target); return new Promise<void>(r => setTimeout(r, WORKER_MS)); });
        pending.current.set(e.id, gate);
        gate.finally(() => pending.current.delete(e.id));
      }
    }

    setPointers(prev => {
      const old = prev[pointerId];
      const base = old ?? { id: pointerId, agent: e.agent, x: window.innerWidth - 80, y: window.innerHeight - 120, waiting: false, clicks: 0 };
      const hold = !!lighting;
      // Rays flash on each click, and once when typing into a field starts.
      const click = CLICKY.has(e.action) && !(e.action === 'type' && base.action === 'type') || e.action === 'open';
      return {
        ...prev,
        [pointerId]: {
          ...base, agent: e.agent, label: e.action === 'type' && e.value ? `${e.label}: “${e.value}”` : e.label, action: e.action,
          target: hold || e.action === 'hover' || e.action === 'point' ? (e.action === 'point' || e.action === 'hover' ? undefined : base.target) : e.target ?? base.target,
          x: hold ? base.x : pos?.x ?? base.x, y: hold ? base.y : pos?.y ?? base.y,
          at: e.at, waiting: e.action === 'release' || e.action === 'wait',
          clicks: (base.clicks ?? 0) + (click ? 1 : 0),
        },
      };
    });

    if ((e.action === 'click' || e.action === 'navigate' || e.action === 'check') && pos) {
      const r = { id: e.id, x: pos.x, y: pos.y, color };
      setRipples(prev => [...prev, r]);
      setTimeout(() => setRipples(prev => prev.filter(x => x.id !== r.id)), 650);
    }
    // The task's panel settles to its finished glow; both cursors leave shortly after.
    if (e.action === 'done' || e.action === 'error') {
      stage.current?.finish(pointerId);
      clearTimeout(timers.current.get(pointerId));
      timers.current.set(pointerId, setTimeout(() => {
        setPointers(prev => { const n = { ...prev }; delete n[pointerId]; return n; });
      }, e.action === 'error' ? 2500 : 1400));
    }
  }), [sendWorker]);

  // Keep the workers on their targets while the page scrolls or resizes.
  useEffect(() => {
    let frame = 0;
    const update = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        setPointers(prev => {
          let changed = false;
          const next = { ...prev };
          for (const p of Object.values(prev) as Pointer[]) {
            const el = p.target ? findTarget(p.target) : null;
            if (!el) continue;
            const c = centre(el);
            if (Math.abs(c.x - p.x) > 0.5 || Math.abs(c.y - p.y) > 0.5) { next[p.id] = { ...p, ...c, snap: (p.snap ?? 0) + 1 }; changed = true; }
          }
          return changed ? next : prev;
        });
      });
    };
    window.addEventListener('scroll', update, true);
    window.addEventListener('resize', update);
    return () => { window.removeEventListener('scroll', update, true); window.removeEventListener('resize', update); cancelAnimationFrame(frame); };
  }, []);

  const list = Object.values(pointers) as Pointer[];

  return (
    <div className="fixed inset-0 pointer-events-none z-[9990]" aria-live="polite" data-swarm-ui>
      {/* Glows, the tree, partner cursors and dust (agentStage.ts). */}
      <div ref={host} className="absolute inset-0" />

      {ripples.map(r => (
        <span key={r.id} className="absolute w-8 h-8 -ml-4 -mt-4 rounded-full border-2" style={{ left: r.x, top: r.y, borderColor: r.color, animation: 'agent-ripple 0.6s ease-out forwards' }} />
      ))}

      {(Object.values(lists) as OpenList[]).map(l => (
        <ul key={l.pointerId} role="presentation" className="absolute rounded-xl bg-raised shadow-xl border border-separator py-1.5 text-sm animate-fade-in overflow-hidden"
          style={{ left: l.rect.left, top: l.rect.top, width: l.rect.width, maxWidth: 320 }}>
          {visibleOptions(l).map(o => (
            <li key={o.i} className="px-3 truncate flex items-center" style={{ height: OPTION_PX, background: o.i === l.index ? `color-mix(in srgb, ${l.color} 18%, transparent)` : undefined, color: o.i === l.index ? 'var(--label)' : 'var(--label-2)', fontWeight: o.i === l.index ? 600 : 400 }}>
              {o.text || '—'}
            </li>
          ))}
        </ul>
      ))}

      {list.map(p => (
        <React.Fragment key={p.id}>
          <HumanPointer
            x={p.x}
            y={p.y}
            snap={p.snap}
            clickKey={p.clicks}
            color={AGENTS[p.agent].color}
            name={AGENTS[p.agent].name}
            detail={p.label}
            waiting={p.waiting}
            maxDuration={WORKER_MS}
          />
        </React.Fragment>
      ))}
    </div>
  );
}
