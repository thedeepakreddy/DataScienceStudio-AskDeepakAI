/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { ArrowRight, X } from 'lucide-react';
import { AGENTS, AgentRole } from '../swarm/agents';
import Orb from './Orb';

// The welcome the agent team gives each time the studio opens (about seven
// seconds): their cursors fly in, drag a selection box open over the title,
// each drag out a box with one thing they can do, then point to the floating
// Ask AI button, where the user gives them tasks. The × in the top-left, Esc
// or a tap anywhere skips it. This is a greeting, not work: nothing on the
// page is touched.

const SKILLS: { text: string; role: AgentRole }[] = [
  { text: 'Clean & fix your data', role: 'data_engineer' },
  { text: 'Explore & profile', role: 'data_scientist' },
  { text: 'Test what’s significant', role: 'statistician' },
  { text: 'Train & compare models', role: 'ml_engineer' },
  { text: 'Forecast the future', role: 'data_scientist' },
  { text: 'Build dashboards', role: 'bi_analyst' },
  { text: 'Write the report', role: 'research_analyst' },
  { text: 'Check every result twice', role: 'verifier' },
  { text: 'Undo anything, anytime', role: 'orchestrator' },
];
// The cursors after the nine skill-makers.
const EXTRA: AgentRole[] = ['orchestrator', 'data_quality', 'statistician', 'ml_engineer', 'data_engineer', 'research_analyst'];

type Size = 'desktop' | 'tablet' | 'phone';
const sizeOf = (w: number): Size => (w >= 1024 ? 'desktop' : w >= 640 ? 'tablet' : 'phone');
const LAYOUT = {
  desktop: { cursors: 15, cols: 3, perGroup: 9 },
  tablet: { cursors: 12, cols: 2, perGroup: 9 },
  phone: { cursors: 10, cols: 1, perGroup: 3 },
} as const;

interface Cursor { x: number; y: number; dur: number; delay: number; hidden: boolean }
type Phase = 'enter' | 'title' | 'skills' | 'ask';

const reducedMotion = () => typeof window !== 'undefined' && !!window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
const askButton = () => document.querySelector<HTMLElement>('[aria-label="Open the AI assistant"]');

export default function WelcomeSwarm({ onClose }: { onClose: () => void }) {
  const [view, setView] = useState(() => ({ w: window.innerWidth, h: window.innerHeight }));
  const size = sizeOf(view.w);
  const { cursors: count, cols, perGroup } = LAYOUT[size];
  const roles: AgentRole[] = [...SKILLS.map(s => s.role), ...EXTRA].slice(0, count);
  const still = reducedMotion();

  const [phase, setPhase] = useState<Phase>(still ? 'ask' : 'enter');
  const [group, setGroup] = useState(0);
  const [revealed, setRevealed] = useState<number[]>(() => (still ? [0, 1, 2, 3, 4, 5, 6, 7, 8] : []));
  const [titleOpen, setTitleOpen] = useState(still);
  const [leaving, setLeaving] = useState(false);
  const [ask, setAsk] = useState<DOMRect | null>(null);
  const [angle, setAngle] = useState(0);
  const [cursors, setCursors] = useState<Cursor[]>(() => {
    // Off-screen, all round the edges, so they fly in from everywhere.
    const { w, h } = { w: window.innerWidth, h: window.innerHeight };
    const n = LAYOUT[sizeOf(w)].cursors;
    return Array.from({ length: n }, (_, i) => {
      const a = (i / n) * Math.PI * 2 + 0.4;
      return { x: w / 2 + Math.cos(a) * Math.max(w, h) * 0.75, y: h / 2 + Math.sin(a) * Math.max(w, h) * 0.75, dur: 0, delay: 0, hidden: false };
    });
  });

  const titleRef = useRef<HTMLDivElement | null>(null);
  const slotRefs = useRef<(HTMLDivElement | null)[]>([]);
  const tipRef = useRef<HTMLDivElement | null>(null);
  const closed = useRef(false);

  const close = useCallback(() => {
    if (closed.current) return;
    closed.current = true;
    setLeaving(true);
    setTimeout(onClose, 320);
  }, [onClose]);

  // Esc closes; the layout follows the window size.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') close(); };
    const onResize = () => setView({ w: window.innerWidth, h: window.innerHeight });
    window.addEventListener('keydown', onKey);
    window.addEventListener('resize', onResize);
    return () => { window.removeEventListener('keydown', onKey); window.removeEventListener('resize', onResize); };
  }, [close]);

  // The choreography. Targets are read from the laid-out boxes when each step runs.
  useEffect(() => {
    const timers: ReturnType<typeof setTimeout>[] = [];
    const at = (ms: number, fn: () => void) => timers.push(setTimeout(fn, ms));
    const move = (i: number, x: number, y: number, dur = 700, delay = 0) =>
      setCursors(prev => prev.map((c, k) => (k === i ? { ...c, x, y, dur, delay } : c)));
    const n = LAYOUT[sizeOf(window.innerWidth)].cursors;
    const layout = LAYOUT[sizeOf(window.innerWidth)];

    const finish = (t: number) => {
      // Point at the Ask AI button, then fly into it.
      at(t, () => {
        const w = window.innerWidth, h = window.innerHeight;
        const r = askButton()?.getBoundingClientRect() ?? new DOMRect(w - 80, h - 200, 64, 64);
        setAsk(r);
        setPhase('ask');
        // The arrow points from the tip to the button (measured once the tip has moved into place).
        at(60, () => {
          const tip = tipRef.current?.getBoundingClientRect();
          if (tip) setAngle(Math.atan2(r.top + r.height / 2 - (tip.top + tip.height / 2), r.left + r.width / 2 - (tip.left + tip.width / 2)));
        });
        // Gather on the side of the button that faces the screen, never off the edge.
        const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
        const facing = Math.atan2(h / 2 - cy, w / 2 - cx);
        setCursors(prev => prev.map((c, i) => {
          const a = facing + ((i / Math.max(1, prev.length - 1)) - 0.5) * 2.4;
          const rad = r.width * 0.8 + 18 + (i % 3) * 22;
          const x = Math.min(w - 26, Math.max(8, cx + Math.cos(a) * rad));
          const y = Math.min(h - 26, Math.max(8, cy + Math.sin(a) * rad));
          return { ...c, x, y, dur: 800, delay: i * 35 };
        }));
      });
      // Then they fly into the button.
      at(t + 1450, () => {
        const r = askButton()?.getBoundingClientRect();
        if (r) setCursors(prev => prev.map((c, i) => ({ ...c, x: r.left + r.width / 2, y: r.top + r.height / 2, dur: 500, delay: i * 20 })));
      });
      at(t + 1750, () => setCursors(prev => prev.map((c, i) => ({ ...c, hidden: true, delay: i * 15 }))));
      at(t + 2350, close);
    };

    if (still) {
      at(50, () => setAsk(askButton()?.getBoundingClientRect() ?? null));
      at(7000, close);
      return () => timers.forEach(clearTimeout);
    }

    // 1. Fly in and gather round the middle.
    at(60, () => setCursors(prev => prev.map((c, i) => {
      const a = (i / n) * Math.PI * 2;
      const w = window.innerWidth, h = window.innerHeight;
      const r = 0.55 + ((i * 37) % 10) / 25;
      return { ...c, x: w / 2 + Math.cos(a) * w * 0.32 * r, y: h / 2 + Math.sin(a) * h * 0.3 * r, dur: 850, delay: i * 30 };
    })));

    // 2. The Orchestrator drags the title box open; the rest surround it.
    at(950, () => {
      setPhase('title');
      const t = titleRef.current?.getBoundingClientRect();
      if (!t) return;
      move(0, t.left, t.top, 450);
      setCursors(prev => prev.map((c, i) => {
        if (i === 0) return c;
        const p = (i - 1) / (prev.length - 1);
        const per = 2 * (t.width + t.height);
        let d = p * per;
        const pt = d < t.width ? [t.left + d, t.top - 6]
          : (d -= t.width) < t.height ? [t.right + 6, t.top + d]
          : (d -= t.height) < t.width ? [t.right - d, t.bottom + 6]
          : [t.left - 6, t.bottom - (d - t.width)];
        return { ...c, x: pt[0], y: pt[1], dur: 700, delay: i * 25 };
      }));
    });
    at(1450, () => {
      const t = titleRef.current?.getBoundingClientRect();
      setTitleOpen(true);
      if (t) move(0, t.right - 8, t.bottom - 8, 850);
    });

    // 3. Each agent drags out a box with one thing the team can do.
    const start = 2450;
    const stagger = layout.perGroup === 9 ? 230 : 260;
    const groups = Math.ceil(SKILLS.length / layout.perGroup);
    const groupTime = layout.perGroup * stagger + 650;
    at(start, () => setPhase('skills'));
    for (let g = 0; g < groups; g++) {
      const g0 = start + g * groupTime;
      at(g0, () => { setGroup(g); setRevealed([]); });
      for (let k = 0; k < layout.perGroup; k++) {
        const i = g * layout.perGroup + k;
        if (i >= SKILLS.length) break;
        at(g0 + 40 + k * stagger, () => {
          const r = slotRefs.current[k]?.getBoundingClientRect();
          if (r) move(i, r.left + 4, r.top + 4, 320);
        });
        at(g0 + 40 + k * stagger + 330, () => {
          const r = slotRefs.current[k]?.getBoundingClientRect();
          setRevealed(prev => [...prev, k]);
          if (r) move(i, r.right - 10, r.bottom - 8, 480);
        });
      }
    }
    // The extra cursors hover above the boxes meanwhile.
    at(start + 200, () => setCursors(prev => prev.map((c, i) => {
      if (i < SKILLS.length) return c;
      const t = titleRef.current?.getBoundingClientRect();
      if (!t) return c;
      const k = i - SKILLS.length;
      return { ...c, x: t.left + ((k + 0.5) / Math.max(1, prev.length - SKILLS.length)) * t.width, y: t.bottom + 14, dur: 900, delay: k * 60 };
    })));

    finish(start + groups * groupTime);
    return () => timers.forEach(clearTimeout);
    // The choreography runs once per opening.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const skills = SKILLS.slice(group * perGroup, group * perGroup + perGroup);
  const width = Math.min(880, view.w - 32);

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Welcome to Data Science Studio"
      data-swarm-ui
      onClick={close}
      className="fixed inset-0 z-[10001] overflow-hidden select-none cursor-default"
      style={{
        background: 'color-mix(in srgb, var(--canvas) 88%, transparent)',
        backdropFilter: 'blur(10px)',
        WebkitBackdropFilter: 'blur(10px)',
        opacity: leaving ? 0 : 1,
        transition: 'opacity 300ms ease',
      }}
    >
      {/* Close: small and dim, top-left, clear of the notch. */}
      <button
        type="button"
        onClick={e => { e.stopPropagation(); close(); }}
        aria-label="Close welcome"
        className="absolute z-10 w-9 h-9 rounded-full flex items-center justify-center text-label-2 opacity-45 hover:opacity-100 focus-visible:opacity-100 hover:bg-fill transition-opacity"
        style={{ top: 'max(12px, env(safe-area-inset-top))', left: 'max(12px, env(safe-area-inset-left))' }}
      >
        <X className="w-5 h-5" />
      </button>

      <div
        className="absolute inset-0 flex flex-col items-center justify-center mx-auto"
        style={{ paddingTop: 'max(56px, env(safe-area-inset-top))', paddingBottom: size === 'phone' ? 150 : 110, paddingLeft: 16, paddingRight: 16 }}
      >
        {/* The title, revealed by the Orchestrator's selection box. */}
        <div
          ref={titleRef}
          className="relative rounded-[14px] border-2 text-center px-5 py-4 sm:px-10 sm:py-7"
          style={{
            maxWidth: width,
            borderColor: 'var(--blue)',
            background: 'color-mix(in srgb, var(--blue) 6%, transparent)',
            opacity: phase === 'enter' ? 0 : 1,
            animation: titleOpen ? 'agent-drag 850ms cubic-bezier(.22,.61,.36,1) both' : undefined,
            clipPath: titleOpen ? undefined : 'inset(0 100% 100% 0 round 14px)',
          }}
        >
          <span className="absolute -top-3 left-4 px-2 py-0.5 rounded-full text-[11px] font-semibold text-white" style={{ background: 'var(--blue)' }}>
            {AGENTS.orchestrator.name}
          </span>
          {['-left-1 -top-1', '-right-1 -top-1', '-left-1 -bottom-1', '-right-1 -bottom-1'].map(c => (
            <span key={c} className={`absolute ${c} w-2 h-2 rounded-sm bg-raised border-2`} style={{ borderColor: 'var(--blue)' }} aria-hidden="true" />
          ))}
          <h1 className="font-editorial font-semibold text-label tracking-tight" style={{ fontSize: 'clamp(30px, 5.4vw, 60px)', lineHeight: 1.06 }}>
            Welcome to Data Science Studio
          </h1>
          <p className="font-editorial italic text-label-2 mt-2" style={{ fontSize: 'clamp(17px, 2.1vw, 22px)' }}>
            Your team of AI agents
          </p>
        </div>

        {/* What the team can do: one box per agent. */}
        <div
          className="grid gap-2.5 sm:gap-3 mt-6 sm:mt-8"
          style={{ width, gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))`, display: size === 'phone' && phase === 'ask' ? 'none' : undefined }}
        >
          {skills.map((s, k) => {
            const color = AGENTS[s.role].color;
            const shown = revealed.includes(k);
            return (
              <div
                key={`${group}-${k}`}
                ref={el => { slotRefs.current[k] = el; }}
                className="relative rounded-[14px] border-2 px-4 py-3 sm:py-3.5"
                style={{
                  borderColor: color,
                  background: `color-mix(in srgb, ${color} 8%, var(--raised))`,
                  opacity: shown ? 1 : 0,
                  animation: shown ? 'agent-drag 480ms cubic-bezier(.22,.61,.36,1) both' : undefined,
                }}
              >
                <span className="absolute -top-2.5 left-3 px-1.5 py-px rounded-full text-[10px] font-semibold text-white whitespace-nowrap" style={{ background: color }}>
                  {AGENTS[s.role].name}
                </span>
                <p className="font-editorial font-semibold text-label" style={{ fontSize: 'clamp(16px, 1.7vw, 19px)' }}>{s.text}</p>
              </div>
            );
          })}
        </div>

        {/* Where to give them work. */}
        <div
          ref={tipRef}
          className="mt-6 sm:mt-8 text-center"
          style={{ maxWidth: width, opacity: phase === 'ask' ? 1 : 0, transform: phase === 'ask' ? 'none' : 'translateY(8px)', transition: 'opacity 400ms ease, transform 400ms ease' }}
        >
          <p className="font-editorial font-semibold text-label" style={{ fontSize: 'clamp(19px, 2.4vw, 26px)' }}>
            Just ask — we’ll do it right here on your page.
          </p>
          <p className="mt-1.5 text-label-2 inline-flex items-center gap-1.5 flex-wrap justify-center" style={{ fontSize: 'clamp(14px, 1.5vw, 16px)' }}>
            {size === 'phone' ? 'To give the agents a task, tap' : 'To give the agents a task, tap the floating'} <span className="font-semibold text-blue">Ask AI</span>{size === 'phone' ? '' : ' button'}
            <ArrowRight className="w-4 h-4 text-blue shrink-0" style={{ transform: `rotate(${angle}rad)`, transition: 'transform 300ms' }} aria-hidden="true" />
          </p>
        </div>
      </div>

      {/* The swarm. */}
      {!still && cursors.map((c, i) => {
        const role = roles[i] ?? 'orchestrator';
        const color = AGENTS[role].color;
        return (
          <div
            key={i}
            className="absolute left-0 top-0 pointer-events-none"
            aria-hidden="true"
            style={{
              transform: `translate(${c.x}px, ${c.y}px) scale(${c.hidden ? 0.5 : 1})`,
              opacity: c.hidden ? 0 : 1,
              transition: `transform ${c.dur}ms cubic-bezier(.22,.61,.36,1) ${c.delay}ms, opacity 300ms ease ${c.delay}ms`,
            }}
          >
            <svg width="20" height="20" viewBox="0 0 22 22" className="-ml-[3px] -mt-[2px] drop-shadow">
              <path d="M3 2 L3 18 L7.5 13.8 L10.6 20.4 L13.4 19.1 L10.4 12.6 L16.6 12.4 Z" fill={color} stroke="white" strokeWidth="1.4" strokeLinejoin="round" />
            </svg>
            {phase !== 'ask' && (
              <span
                className={`block -mt-1 w-max rounded-full px-2 py-0.5 font-medium text-white shadow-md whitespace-nowrap ${size === 'phone' ? 'text-[9px]' : 'text-[11px]'}`}
                // Near the right edge the name sits to the left of the pointer.
                style={{ background: color, transform: c.x > view.w - 150 ? 'translateX(calc(-100% - 2px))' : 'translateX(14px)' }}
              >
                {AGENTS[role].name}
              </span>
            )}
          </div>
        );
      })}
      {/* A ring round the real Ask AI button. */}
      {ask && (
        <div
          className="absolute z-10 rounded-full border-2 pointer-events-none flex items-center justify-center"
          style={{
            left: Math.min(view.w - ask.width - 20, Math.max(4, ask.left - 8)), top: Math.min(view.h - ask.height - 20, Math.max(4, ask.top - 8)),
            width: ask.width + 16, height: ask.height + 16,
            borderColor: 'var(--blue)', animation: 'agent-target 400ms ease-out both, welcome-pulse 1.2s ease-in-out 400ms infinite',
          }}
        >
          {/* The button itself sits under the welcome, so show the assistant here. */}
          <Orb state="breathing" size={64} label="Ask AI" />
          <span
            className="absolute whitespace-nowrap px-2.5 py-1 rounded-full text-[11px] font-semibold text-white shadow-lg"
            style={{ background: 'var(--blue)', ...(ask.top > 60 ? { top: -32 } : { bottom: -32 }), ...(ask.left > view.w / 2 ? { right: 0 } : { left: 0 }) }}
          >
            Ask AI · assign tasks here
          </span>
        </div>
      )}

    </div>
  );
}
