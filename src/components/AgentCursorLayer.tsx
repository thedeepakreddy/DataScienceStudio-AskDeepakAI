/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useEffect, useRef, useState } from 'react';
import { AGENTS } from '../swarm/agents';
import { InteractionEvent, findTarget, interactions } from '../swarm/interaction';
import { HumanPointer } from './AgentCursor';

// Draws the agents at work on the user's page (blueprint 11.4–11.7): one
// pointer per running task (so an agent can show several), a selection box
// over the area it claimed, a ripple where it clicked and the text it is
// typing. Everything here comes from interaction events the engine emitted
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
}

interface Box { pointerId: string; agent: InteractionEvent['agent']; target: string; rect: DOMRect; label: string }
interface Ripple { id: string; x: number; y: number; color: string }
/** A small selection box round the exact control an agent is using right now. */
interface Mark { pointerId: string; agent: InteractionEvent['agent']; target: string; rect: DOMRect; verb: string; key: string }

const VERB: Partial<Record<InteractionEvent['action'], string>> = {
  move: 'reaching', navigate: 'opening', select: 'choosing', type: 'typing', click: 'clicking', check: 'ticking',
};

const centre = (el: HTMLElement) => {
  const r = el.getBoundingClientRect();
  return { x: r.left + Math.min(r.width / 2, 48), y: r.top + r.height / 2 };
};

/** The card around a target, which is what an agent claims. */
const areaOf = (el: HTMLElement) => (el.closest('.card, section, [role="region"]') as HTMLElement | null) ?? el;

export default function AgentCursorLayer() {
  const [pointers, setPointers] = useState<Record<string, Pointer>>({});
  const [boxes, setBoxes] = useState<Record<string, Box>>({});
  const [ripples, setRipples] = useState<Ripple[]>([]);
  const [marks, setMarks] = useState<Record<string, Mark>>({});
  const markTimers = useRef(new Map<string, ReturnType<typeof setTimeout>>());
  const timers = useRef(new Map<string, ReturnType<typeof setTimeout>>());

  useEffect(() => interactions.subscribe(e => {
    const color = AGENTS[e.agent].color;
    const el = e.target ? findTarget(e.target) : null;
    const pos = el ? centre(el) : undefined;

    setPointers(prev => {
      const old = prev[e.pointerId];
      const base = old ?? { id: e.pointerId, agent: e.agent, x: window.innerWidth - 80, y: window.innerHeight - 120, waiting: false };
      return {
        ...prev,
        [e.pointerId]: {
          ...base, agent: e.agent, label: e.action === 'type' && e.value ? `${e.label}: “${e.value}”` : e.label, action: e.action,
          target: e.target ?? base.target, x: pos?.x ?? base.x, y: pos?.y ?? base.y, at: e.at, waiting: e.action === 'release' || e.action === 'wait',
        },
      };
    });

    // Every action gets a box round the control it touches (it fades a moment later).
    const verb = VERB[e.action];
    if (verb && el && e.target) {
      const pointerId = e.pointerId;
      setMarks(prev => ({ ...prev, [pointerId]: { pointerId, agent: e.agent, target: e.target!, rect: el.getBoundingClientRect(), verb, key: prev[pointerId]?.target === e.target ? prev[pointerId].key : e.id } }));
      clearTimeout(markTimers.current.get(pointerId));
      markTimers.current.set(pointerId, setTimeout(() => setMarks(prev => { const n = { ...prev }; delete n[pointerId]; return n; }), e.action === 'move' ? 1600 : 1100));
    }
    if (e.action === 'claim' && el) {
      setBoxes(prev => ({ ...prev, [e.pointerId]: { pointerId: e.pointerId, agent: e.agent, target: e.target!, rect: areaOf(el).getBoundingClientRect(), label: e.label } }));
    }
    if ((e.action === 'click' || e.action === 'navigate' || e.action === 'check') && pos) {
      const r = { id: e.id, x: pos.x, y: pos.y, color };
      setRipples(prev => [...prev, r]);
      setTimeout(() => setRipples(prev => prev.filter(x => x.id !== r.id)), 650);
    }
    // A pointer leaves shortly after its task finishes or fails.
    if (e.action === 'done' || e.action === 'error') {
      clearTimeout(timers.current.get(e.pointerId));
      timers.current.set(e.pointerId, setTimeout(() => {
        setPointers(prev => { const n = { ...prev }; delete n[e.pointerId]; return n; });
        setBoxes(prev => { const n = { ...prev }; delete n[e.pointerId]; return n; });
      }, e.action === 'error' ? 2500 : 1400));
    }
  }), []);

  // Keep pointers and boxes on their targets while the page scrolls or resizes.
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
        setMarks(prev => {
          const next: Record<string, Mark> = {};
          for (const m of Object.values(prev) as Mark[]) {
            const el = findTarget(m.target);
            if (el) next[m.pointerId] = { ...m, rect: el.getBoundingClientRect() };
          }
          return next;
        });
        setBoxes(prev => {
          const next: Record<string, Box> = {};
          for (const b of Object.values(prev) as Box[]) {
            const el = findTarget(b.target);
            if (el) next[b.pointerId] = { ...b, rect: areaOf(el).getBoundingClientRect() };
          }
          return next;
        });
      });
    };
    window.addEventListener('scroll', update, true);
    window.addEventListener('resize', update);
    return () => { window.removeEventListener('scroll', update, true); window.removeEventListener('resize', update); cancelAnimationFrame(frame); };
  }, []);

  const list = Object.values(pointers) as Pointer[];
  if (!list.length && !ripples.length && !Object.keys(marks).length) return null;

  return (
    <div className="fixed inset-0 pointer-events-none z-[9990]" aria-live="polite" data-swarm-ui>
      {(Object.values(boxes) as Box[]).map(b => (
        <div
          key={b.pointerId}
          className="absolute rounded-2xl border-2 transition-all duration-500 ease-out"
          style={{
            left: b.rect.left - 6, top: b.rect.top - 6, width: b.rect.width + 12, height: b.rect.height + 12,
            borderColor: AGENTS[b.agent].color, background: `color-mix(in srgb, ${AGENTS[b.agent].color} 7%, transparent)`,
            animation: 'agent-claim 0.45s ease-out',
          }}
        >
          <span className="absolute -top-3 left-3 px-2 py-0.5 rounded-full text-[11px] font-semibold text-white" style={{ background: AGENTS[b.agent].color }}>
            {AGENTS[b.agent].name}
          </span>
        </div>
      ))}

      {(Object.values(marks) as Mark[]).map(m => {
        const color = AGENTS[m.agent].color;
        return (
          <div
            key={m.key}
            className="absolute rounded-lg border-2 transition-all duration-300 ease-out"
            style={{
              left: m.rect.left - 4, top: m.rect.top - 4, width: m.rect.width + 8, height: m.rect.height + 8,
              borderColor: color, background: `color-mix(in srgb, ${color} 10%, transparent)`,
              animation: 'agent-drag 260ms ease-out both',
            }}
          >
            <span className="absolute -top-2.5 right-2 px-1.5 rounded-full text-[10px] font-semibold text-white leading-4" style={{ background: color }}>{m.verb}</span>
          </div>
        );
      })}

      {ripples.map(r => (
        <span key={r.id} className="absolute w-8 h-8 -ml-4 -mt-4 rounded-full border-2" style={{ left: r.x, top: r.y, borderColor: r.color, animation: 'agent-ripple 0.6s ease-out forwards' }} />
      ))}

      {list.map(p => (
        <React.Fragment key={p.id}>
        <HumanPointer
          x={p.x}
          y={p.y}
          snap={p.snap}
          color={AGENTS[p.agent].color}
          name={AGENTS[p.agent].name}
          detail={p.label}
          waiting={p.waiting}
        />
        </React.Fragment>
      ))}
    </div>
  );
}
