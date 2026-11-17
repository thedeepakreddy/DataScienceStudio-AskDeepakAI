/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { AGENTS } from '../swarm/agents';
import { InteractionEvent, findTarget, interactions } from '../swarm/interaction';
import { HumanMover, Point } from '../swarm/humanMotion';
import { CursorGlyph, HumanPointer, NameTag, tagPlacement } from './AgentCursor';

// Draws the agents at work on the user's page (blueprint 11.4–11.7). Every
// running task has two cursors from the same agent:
// - the partner flies to the spot and drags a selection box open, corner to
//   corner, round the area the agent claims and round each control it uses;
// - the worker moves into the open box and does the real click, choice or
//   typing there.
// The agent waits (through interactions.addGate) until the box is open and the
// worker is inside, so the order on screen is the order of the real actions.
// Everything here comes from interaction events the engine emitted for real
// actions; nothing is drawn on its own.

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

interface Box { pointerId: string; agent: InteractionEvent['agent']; target: string; rect: DOMRect; label: string; key: string; closing?: boolean }
interface Ripple { id: string; x: number; y: number; color: string }
/** A small selection box round the exact control an agent is using right now. */
interface Mark { pointerId: string; agent: InteractionEvent['agent']; target: string; rect: DOMRect; verb: string; key: string; closing?: boolean }
/** One box for the partner cursor to drag open. */
interface Job { key: string; eventId: string; target: string; kind: 'mark' | 'box' }
interface Opener { id: string; agent: InteractionEvent['agent']; job?: Job }
interface Pending { pointerId: string; promise: Promise<void>; resolve: () => void; sentAt?: number }
type FrameHandle = { el: HTMLDivElement | null; open: () => void };

const VERB: Partial<Record<InteractionEvent['action'], string>> = {
  move: 'reaching', navigate: 'opening', select: 'choosing', type: 'typing', click: 'clicking', check: 'ticking',
};

/** Longest move of the working cursor into an opened box. */
const WORKER_MS = 520;
const PAD = { mark: 4, box: 6 } as const;

const centre = (el: HTMLElement) => {
  const r = el.getBoundingClientRect();
  return { x: r.left + Math.min(r.width / 2, 48), y: r.top + r.height / 2 };
};

/** The card around a target, which is what an agent claims. */
const areaOf = (el: HTMLElement) => (el.closest('.card, section, [role="region"]') as HTMLElement | null) ?? el;

const reducedMotion = () => typeof window !== 'undefined' && !!window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;

/** Page corners of the box for a job, read live from the page. */
function readBox(job: Job) {
  const t = findTarget(job.target);
  if (!t) return null;
  const r = (job.kind === 'box' ? areaOf(t) : t).getBoundingClientRect();
  const pad = PAD[job.kind];
  return { l: r.left - pad, t: r.top - pad, r: r.right + pad, b: r.bottom + pad };
}

/** A selection box. Closed until the partner cursor drags it open (or a safety timer opens it). */
function Frame({ id, rect, pad, color, rounded, tint, register, closing = false, children }: {
  id: string; rect: DOMRect; pad: number; color: string; rounded: string; tint: number; closing?: boolean;
  register: (id: string, h: FrameHandle | null) => void; children: React.ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  useLayoutEffect(() => {
    register(id, { el: ref.current, open: () => setOpen(true) });
    return () => register(id, null);
  }, [id, register]);
  // Never left closed if its partner cursor couldn't reach it.
  useEffect(() => { const t = setTimeout(() => setOpen(true), 2400); return () => clearTimeout(t); }, []);

  return (
    <div
      ref={ref}
      className={`absolute border-2 ${rounded}`}
      style={{
        left: rect.left - pad, top: rect.top - pad,
        // While closed the partner cursor sets the size frame by frame.
        width: open ? rect.width + pad * 2 : 0, height: open ? rect.height + pad * 2 : 0,
        opacity: open && !closing ? 1 : 0,
        borderColor: color, background: `color-mix(in srgb, ${color} ${tint}%, transparent)`,
        // Position tracks scrolling exactly; only a change of size eases.
        transition: open ? 'width 240ms ease-out, height 240ms ease-out, opacity 260ms ease' : 'none',
      }}
    >
      <div style={{ opacity: open ? 1 : 0, transition: 'opacity 180ms ease' }}>{children}</div>
    </div>
  );
}

/**
 * The partner cursor: a lighter twin of the agent's cursor. For each job it
 * flies to the box's top-left corner, presses, and drags to the bottom-right,
 * growing the box as it goes; then it holds the corner.
 */
function PartnerPointer({ id, agent, job, live, frames, onSetOff, onOpened }: {
  id: string; agent: InteractionEvent['agent']; job?: Job; live: boolean;
  frames: React.MutableRefObject<Map<string, FrameHandle>>;
  onSetOff: (pointerId: string, job: Job) => void;
  onOpened: (pointerId: string, job: Job) => void;
}) {
  const el = useRef<HTMLDivElement>(null);
  const glyph = useRef<HTMLDivElement>(null);
  const mover = useRef<HumanMover | null>(null);
  const run = useRef(0);
  const holding = useRef<Job | null>(null);
  const [phase, setPhase] = useState<'idle' | 'opening' | 'holding'>('idle');
  const [tag, setTag] = useState(() => tagPlacement(window.innerWidth - 56));
  const color = AGENTS[agent].color;

  useLayoutEffect(() => {
    mover.current = new HumanMover(el.current, { x: window.innerWidth - 56, y: window.innerHeight - 92 });
    const runs = run;
    return () => { runs.current++; mover.current?.stop(); };
  }, []);

  useEffect(() => {
    if (!job) return;
    const token = ++run.current;
    const alive = () => token === run.current;
    const m = mover.current!;
    holding.current = null;
    void (async () => {
      // Fly at once; if the page is still scrolling, it corrects onto the real corner on arrival.
      const first = readBox(job);
      if (!first) { onSetOff(id, job); onOpened(id, job); return; }
      const edge = (x: number) => setTag(tagPlacement(x));
      if (reducedMotion()) {
        m.jump({ x: first.r, y: first.b }); edge(first.r);
        onSetOff(id, job); onOpened(id, job);
        holding.current = job; setPhase('holding');
        return;
      }
      setPhase('opening');
      edge(first.l);
      // The page may still be scrolling to the control, or shift as a chart loads: the
      // flight and the drag follow the live corners and land exactly on them.
      let live = first;
      const now = () => (live = readBox(job) ?? live);
      await m.moveTo({ x: first.l, y: first.t }, { maxDuration: 340, follow: () => { const b = now(); return { x: b.l, y: b.t }; } });
      if (!alive()) return;
      const box = now();
      const f0 = frames.current.get(job.key)?.el;
      if (f0) { f0.style.left = `${box.l}px`; f0.style.top = `${box.t}px`; f0.style.width = '0px'; f0.style.height = '0px'; f0.style.opacity = '1'; }
      if (glyph.current) glyph.current.style.transform = 'scale(0.84)';
      const w = box.r - box.l, h = box.b - box.t;
      edge(box.r);
      // The working cursor sets off as the drag starts and arrives as the box finishes opening.
      onSetOff(id, job);
      await m.moveTo({ x: box.r, y: box.b }, {
        duration: Math.round(Math.min(440, 180 + Math.hypot(w, h) * 0.3)),
        arc: 0.035, overshoot: false, tremor: false,
        follow: () => { const b = now(); return { x: b.r, y: b.b }; },
        onFrame: (p: Point) => {
          if (!alive()) return;
          const f = frames.current.get(job.key)?.el;
          if (f) {
            f.style.left = `${live.l}px`; f.style.top = `${live.t}px`;
            f.style.width = `${Math.max(0, p.x - live.l)}px`; f.style.height = `${Math.max(0, p.y - live.t)}px`;
          }
        },
      });
      if (glyph.current) glyph.current.style.transform = '';
      if (!alive()) return;
      onOpened(id, job);
      const end = readBox(job);
      if (end) m.jump({ x: end.r, y: end.b });
      holding.current = job;
      setPhase('holding');
    })();
    // A new job is what starts a drag; the callbacks are stable.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [job?.key]);

  // Keep holding the corner while the page scrolls.
  useEffect(() => {
    let frame = 0;
    const follow = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        const j = holding.current;
        const b = j && readBox(j);
        if (b) mover.current?.jump({ x: b.r, y: b.b });
      });
    };
    window.addEventListener('scroll', follow, true);
    window.addEventListener('resize', follow);
    return () => { window.removeEventListener('scroll', follow, true); window.removeEventListener('resize', follow); cancelAnimationFrame(frame); };
  }, []);

  const detail = phase === 'opening' ? 'opening' : phase === 'holding' && live ? 'holding' : undefined;
  return (
    <div ref={el} className="absolute left-0 top-0 will-change-transform" data-agent-partner={id}>
      <div ref={glyph} className="-ml-[2.5px] -mt-[2.5px] transition-transform duration-150" style={{ transformOrigin: '2.5px 2.5px' }}>
        <CursorGlyph color={`color-mix(in srgb, ${color} 62%, white)`} size={20} />
      </div>
      <NameTag color={`color-mix(in srgb, ${color} 82%, white)`} name={AGENTS[agent].name} detail={detail} flip={tag.flip} maxWidth={tag.maxWidth} small dim={phase !== 'opening'} />
    </div>
  );
}

export default function AgentCursorLayer() {
  const [pointers, setPointers] = useState<Record<string, Pointer>>({});
  const [openers, setOpeners] = useState<Record<string, Opener>>({});
  const [boxes, setBoxes] = useState<Record<string, Box>>({});
  const [ripples, setRipples] = useState<Ripple[]>([]);
  const [marks, setMarks] = useState<Record<string, Mark>>({});
  const markTimers = useRef(new Map<string, ReturnType<typeof setTimeout>>());
  const timers = useRef(new Map<string, ReturnType<typeof setTimeout>>());
  /** The open mark per pointer: same target keeps the same box. */
  const markKeys = useRef(new Map<string, { target: string; key: string }>());
  const frames = useRef(new Map<string, FrameHandle>());
  /** Agents waiting for a box to open, by event id. */
  const pending = useRef(new Map<string, Pending>());

  /** Re-reads every box from the page (scrolls, resizes, and layout shifts when a box opens). */
  const refresh = useRef<() => void>(() => {});

  const register = useCallback((id: string, h: FrameHandle | null) => {
    if (h) frames.current.set(id, h); else frames.current.delete(id);
  }, []);

  const settle = useCallback((eventId: string, after = 0) => {
    const p = pending.current.get(eventId);
    if (!p) return;
    pending.current.delete(eventId);
    if (after > 0) setTimeout(p.resolve, after); else p.resolve();
  }, []);

  /** The partner lets go: the control's box fades out a moment after the worker's last action there. */
  const letGo = useCallback((pointerId: string, after: number) => {
    const key = markKeys.current.get(pointerId)?.key;
    if (!key) return;
    clearTimeout(markTimers.current.get(pointerId));
    markTimers.current.set(pointerId, setTimeout(() => {
      if (markKeys.current.get(pointerId)?.key !== key) return;
      markKeys.current.delete(pointerId);
      setMarks(prev => (prev[pointerId]?.key === key ? { ...prev, [pointerId]: { ...prev[pointerId], closing: true } } : prev));
      setTimeout(() => setMarks(prev => { if (prev[pointerId]?.key !== key) return prev; const n = { ...prev }; delete n[pointerId]; return n; }), 280);
    }, after));
  }, []);

  /** Sends the working cursor into the box round `target`. */
  const sendWorker = useCallback((pointerId: string, target: string) => {
    const el = findTarget(target);
    if (!el) return;
    const c = centre(el);
    setPointers(prev => {
      const p = prev[pointerId];
      if (!p || (p.target === target && Math.abs(p.x - c.x) < 0.5 && Math.abs(p.y - c.y) < 0.5)) return prev;
      return { ...prev, [pointerId]: { ...p, target, x: c.x, y: c.y } };
    });
  }, []);

  const onSetOff = useCallback((pointerId: string, job: Job) => {
    if (job.kind === 'mark') sendWorker(pointerId, job.target);
    const p = pending.current.get(job.eventId);
    if (p && p.sentAt === undefined) p.sentAt = performance.now();
  }, [sendWorker]);

  const onOpened = useCallback((pointerId: string, job: Job) => {
    refresh.current();
    frames.current.get(job.key)?.open();
    if (job.kind === 'mark') sendWorker(pointerId, job.target);
    const p = pending.current.get(job.eventId);
    // A mark waits for the worker to arrive inside; an area box is ready once open.
    const left = job.kind === 'mark' && p ? Math.max(0, WORKER_MS - (performance.now() - (p.sentAt ?? performance.now()))) : 0;
    settle(job.eventId, left);
  }, [sendWorker, settle]);

  // Agents wait at a move or claim until the box is open and the worker is inside.
  useEffect(() => interactions.addGate(e => pending.current.get(e.id)?.promise), []);

  useEffect(() => interactions.subscribe(e => {
    const color = AGENTS[e.agent].color;
    const el = e.target ? findTarget(e.target) : null;
    const pos = el ? centre(el) : undefined;
    const pointerId = e.pointerId;
    let job: Job | undefined;

    const wait = () => {
      let resolve!: () => void;
      const promise = new Promise<void>(r => { resolve = r; });
      pending.current.set(e.id, { pointerId, promise, resolve });
    };

    // Every action gets a box round the control it touches. The partner holds it open until
    // the worker's work there is finished: it lets go when the agent moves on to another
    // control, starts waiting for a result, or the task ends.
    const verb = VERB[e.action];
    if (verb && el && e.target) {
      const known = markKeys.current.get(pointerId);
      const fresh = known?.target !== e.target;
      const key = fresh ? e.id : known!.key;
      clearTimeout(markTimers.current.get(pointerId));
      markKeys.current.set(pointerId, { target: e.target, key });
      setMarks(prev => ({ ...prev, [pointerId]: { pointerId, agent: e.agent, target: e.target!, rect: el.getBoundingClientRect(), verb, key } }));
      if (e.action === 'move' && fresh) { job = { key, eventId: e.id, target: e.target, kind: 'mark' }; wait(); }
    }
    if (e.action === 'claim' && el && e.target) {
      job = { key: e.id, eventId: e.id, target: e.target, kind: 'box' };
      wait();
      setBoxes(prev => ({ ...prev, [pointerId]: { pointerId, agent: e.agent, target: e.target!, rect: areaOf(el).getBoundingClientRect(), label: e.label, key: e.id } }));
    }

    setPointers(prev => {
      const old = prev[pointerId];
      const base = old ?? { id: pointerId, agent: e.agent, x: window.innerWidth - 80, y: window.innerHeight - 120, waiting: false };
      // While a box is being opened for it, the worker stays put; the partner calls it in.
      const hold = job?.kind === 'mark';
      return {
        ...prev,
        [pointerId]: {
          ...base, agent: e.agent, label: e.action === 'type' && e.value ? `${e.label}: “${e.value}”` : e.label, action: e.action,
          target: hold ? base.target : e.target ?? base.target,
          x: hold ? base.x : pos?.x ?? base.x, y: hold ? base.y : pos?.y ?? base.y,
          at: e.at, waiting: e.action === 'release' || e.action === 'wait',
        },
      };
    });
    setOpeners(prev => ({ ...prev, [pointerId]: { id: pointerId, agent: e.agent, job: job ?? prev[pointerId]?.job } }));

    if ((e.action === 'click' || e.action === 'navigate' || e.action === 'check') && pos) {
      const r = { id: e.id, x: pos.x, y: pos.y, color };
      setRipples(prev => [...prev, r]);
      setTimeout(() => setRipples(prev => prev.filter(x => x.id !== r.id)), 650);
    }
    if (e.action === 'release' || e.action === 'wait' || e.action === 'done' || e.action === 'error') letGo(pointerId, e.action === 'release' || e.action === 'wait' ? 250 : 700);
    // Both cursors leave shortly after the task finishes or fails.
    if (e.action === 'done' || e.action === 'error') {
      for (const [id, p] of pending.current) if (p.pointerId === pointerId) settle(id);
      clearTimeout(timers.current.get(pointerId));
      timers.current.set(pointerId, setTimeout(() => {
        setPointers(prev => { const n = { ...prev }; delete n[pointerId]; return n; });
        setOpeners(prev => { const n = { ...prev }; delete n[pointerId]; return n; });
        setBoxes(prev => { const n = { ...prev }; delete n[pointerId]; return n; });
      }, e.action === 'error' ? 2500 : 1400));
      setTimeout(() => setBoxes(prev => (prev[pointerId] ? { ...prev, [pointerId]: { ...prev[pointerId], closing: true } } : prev)), e.action === 'error' ? 2200 : 1100);
    }
  }), [settle, letGo]);

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
    refresh.current = update;
    window.addEventListener('scroll', update, true);
    window.addEventListener('resize', update);
    return () => { window.removeEventListener('scroll', update, true); window.removeEventListener('resize', update); cancelAnimationFrame(frame); };
  }, []);

  const list = Object.values(pointers) as Pointer[];
  if (!list.length && !ripples.length && !Object.keys(marks).length) return null;
  const liveKeys = new Set([...(Object.values(marks) as Mark[]).map(m => m.key), ...(Object.values(boxes) as Box[]).map(b => b.key)]);

  return (
    <div className="fixed inset-0 pointer-events-none z-[9990]" aria-live="polite" data-swarm-ui>
      {(Object.values(boxes) as Box[]).map(b => (
        <React.Fragment key={b.key}>
        <Frame id={b.key} rect={b.rect} pad={PAD.box} color={AGENTS[b.agent].color} rounded="rounded-2xl" tint={7} register={register} closing={b.closing}>
          <span className="absolute -top-3 left-3 px-2 py-0.5 rounded-full text-[11px] font-semibold text-white whitespace-nowrap" style={{ background: AGENTS[b.agent].color }}>
            {AGENTS[b.agent].name}
          </span>
        </Frame>
        </React.Fragment>
      ))}

      {(Object.values(marks) as Mark[]).map(m => {
        const color = AGENTS[m.agent].color;
        return (
          <React.Fragment key={m.key}>
          <Frame id={m.key} rect={m.rect} pad={PAD.mark} color={color} rounded="rounded-lg" tint={10} register={register} closing={m.closing}>
            <span className="absolute -top-2.5 right-2 px-1.5 rounded-full text-[10px] font-semibold text-white leading-4" style={{ background: color }}>{m.verb}</span>
          </Frame>
          </React.Fragment>
        );
      })}

      {ripples.map(r => (
        <span key={r.id} className="absolute w-8 h-8 -ml-4 -mt-4 rounded-full border-2" style={{ left: r.x, top: r.y, borderColor: r.color, animation: 'agent-ripple 0.6s ease-out forwards' }} />
      ))}

      {(Object.values(openers) as Opener[]).map(o => (
        <React.Fragment key={o.id}>
        <PartnerPointer
          id={o.id}
          agent={o.agent}
          job={o.job}
          live={!!o.job && liveKeys.has(o.job.key)}
          frames={frames}
          onSetOff={onSetOff}
          onOpened={onOpened}
        />
        </React.Fragment>
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
          maxDuration={WORKER_MS}
        />
        </React.Fragment>
      ))}
    </div>
  );
}
