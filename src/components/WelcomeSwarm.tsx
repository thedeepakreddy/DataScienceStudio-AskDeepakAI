/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { BrainCircuit, FileText, LayoutDashboard, Lightbulb, Shapes, ShieldCheck, Sigma, TrendingUp, Wand2, X } from 'lucide-react';
import { AGENTS, AgentRole } from '../swarm/agents';
import { HumanMover, Point } from '../swarm/humanMotion';
import { CursorGlyph } from './AgentCursor';
import Orb from './Orb';
import { Box, scatterCards, seeded } from './welcomeLayout';

// The agent team's welcome, each time the studio opens (about seven seconds).
//
// 1. The swarm streams in from every edge on curved, hand-like paths,
//    leaving fading trails.
// 2. The Orchestrator types "Welcome to"; three agents drag selection boxes
//    over "Data", "Science" and "Studio", revealing each word.
// 3. Nine agents each drag a box out; when they let go it lands as a card
//    with one thing the team can do. On larger screens the cards are
//    scattered (a fresh arrangement each time, never overlapping the title,
//    the closing words, the Ask AI button or each other); on phones, or when a
//    screen is too tight to scatter, they sit in a loosely tilted grid.
// 4. A line draws from the closing words to the floating Ask AI button and
//    the swarm flies into it: that's where you give them work.
//
// The × (with a ring showing time left), Esc or a tap anywhere skips it.
// With reduced motion it is a still composition. Nothing on the page is
// touched.

const CARDS: { text: string; short: string; role: AgentRole; Icon: typeof Wand2 }[] = [
  { text: 'Clean & fix your data', short: 'Clean', role: 'data_engineer', Icon: Wand2 },
  { text: 'Find what drives results', short: 'Drivers', role: 'statistician', Icon: Sigma },
  { text: 'Train & tune models', short: 'Train', role: 'ml_engineer', Icon: BrainCircuit },
  { text: 'Explain every model', short: 'Explain', role: 'explainability_analyst', Icon: Lightbulb },
  { text: 'Discover segments', short: 'Segments', role: 'segmentation_analyst', Icon: Shapes },
  { text: 'Forecast the future', short: 'Forecast', role: 'time_series_analyst', Icon: TrendingUp },
  { text: 'Design your dashboard', short: 'Dashboard', role: 'dashboard_designer', Icon: LayoutDashboard },
  { text: 'Write & publish the report', short: 'Report', role: 'research_analyst', Icon: FileText },
  { text: 'Double-check & fix', short: 'Verify', role: 'verifier', Icon: ShieldCheck },
];
const WORDS = ['Data', 'Science', 'Studio'];
// Who selects each word (they go on to make cards afterwards).
const WORD_AGENTS = [0, 6, 1];
const TYPIST = 9;
// Every agent gets a cursor on big screens: the card makers, the Orchestrator, then the rest.
const ROLE_ORDER: AgentRole[] = [
  ...CARDS.map(c => c.role), 'orchestrator',
  ...(Object.keys(AGENTS) as AgentRole[]).filter(r => r !== 'orchestrator' && !CARDS.some(c => c.role === r)),
];
const TEAM_SIZE = Object.keys(AGENTS).length;
const TOTAL_MS = 7500;

type Size = 'desktop' | 'tablet' | 'phone';
const sizeOf = (w: number): Size => (w >= 1024 ? 'desktop' : w >= 640 ? 'tablet' : 'phone');
const COUNT: Record<Size, number> = { desktop: ROLE_ORDER.length, tablet: 16, phone: 12 };

const roleOf = (i: number): AgentRole => ROLE_ORDER[i % ROLE_ORDER.length];

const reducedMotion = () => typeof window !== 'undefined' && !!window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
const askButton = () => document.querySelector<HTMLElement>('[aria-label="Open the AI assistant"]');
const wait = (ms: number) => new Promise<void>(r => setTimeout(r, ms));

/** A CSS colour variable's actual value, for drawing on the canvas. */
function resolveColor(cssVar: string) {
  const name = cssVar.match(/var\((--[^)]+)\)/)?.[1];
  return (name && getComputedStyle(document.documentElement).getPropertyValue(name).trim()) || '#5b6b8c';
}

export default function WelcomeSwarm({ onClose }: { onClose: () => void }) {
  const [view, setView] = useState(() => ({ w: window.innerWidth, h: window.innerHeight }));
  const size = sizeOf(view.w);
  const count = COUNT[size];
  const still = reducedMotion();

  const [phase, setPhase] = useState<'intro' | 'sub' | 'ask'>(still ? 'ask' : 'intro');
  const [leaving, setLeaving] = useState(false);
  const [ask, setAsk] = useState<{ ring: DOMRect; path: string } | null>(null);
  const [scale, setScale] = useState(1);
  // A fresh arrangement each opening, stable while it plays.
  const [seed] = useState(() => (Date.now() & 0x7fffffff) || 1);
  const [mode, setMode] = useState<'grid' | 'scatter'>(() => (sizeOf(window.innerWidth) === 'phone' ? 'grid' : 'scatter'));
  const [placements, setPlacements] = useState<{ x: number; y: number; rot: number }[] | null>(null);
  // The serif loads on first use; measure only once it has (text wraps differently before).
  const [fontsReady, setFontsReady] = useState(false);
  useEffect(() => {
    let live = true;
    const fonts = typeof document !== 'undefined' ? document.fonts : undefined;
    const done = () => { if (live) setFontsReady(true); };
    if (!fonts?.load) { done(); return; }
    Promise.all([fonts.load('600 18px "Source Serif 4"'), fonts.load('italic 400 20px "Source Serif 4"'), fonts.load('600 60px "Source Serif 4"')])
      .then(done, done);
    // Never wait long: if the font is slow, measure with what's there.
    const t = setTimeout(done, 1200);
    return () => { live = false; clearTimeout(t); };
  }, []);
  // In the grid, each card is tilted and nudged a little so it still feels hand-placed.
  const tilts = useMemo(() => { const r = seeded(seed + 7); return CARDS.map(() => ({ rot: (r() * 2 - 1) * 2.4, dy: (r() * 2 - 1) * 6 })); }, [seed]);

  const root = useRef<HTMLDivElement | null>(null);
  const column = useRef<HTMLDivElement | null>(null);
  const canvas = useRef<HTMLCanvasElement | null>(null);
  const eyebrow = useRef<HTMLSpanElement | null>(null);
  const words = useRef<(HTMLSpanElement | null)[]>([]);
  const wordBoxes = useRef<(HTMLDivElement | null)[]>([]);
  const cards = useRef<(HTMLDivElement | null)[]>([]);
  const cardBoxes = useRef<(HTMLDivElement | null)[]>([]);
  const tip = useRef<HTMLDivElement | null>(null);
  const caret = useRef<HTMLSpanElement | null>(null);
  const grid = useRef<HTMLDivElement | null>(null);
  const cursorEls = useRef<(HTMLDivElement | null)[]>([]);
  const tagEls = useRef<(HTMLSpanElement | null)[]>([]);
  const movers = useRef<HumanMover[]>([]);
  const closed = useRef(false);
  const phaseRef = useRef(phase);
  useEffect(() => { phaseRef.current = phase; }, [phase]);

  const close = useCallback(() => {
    if (closed.current) return;
    closed.current = true;
    movers.current.forEach(m => m.stop());
    setLeaving(true);
    setTimeout(onClose, 420);
  }, [onClose]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') close(); };
    const onResize = () => {
      setView({ w: window.innerWidth, h: window.innerHeight });
      // Re-arrange for the new size (scatter where it fits, otherwise the grid).
      setPlacements(null);
      setMode(sizeOf(window.innerWidth) === 'phone' ? 'grid' : 'scatter');
    };
    window.addEventListener('keydown', onKey);
    window.addEventListener('resize', onResize);
    return () => { window.removeEventListener('keydown', onKey); window.removeEventListener('resize', onResize); };
  }, [close]);

  // Scatter the cards: measure the title, the closing words and each card, then
  // find places that touch none of them, the Ask AI button or each other.
  useLayoutEffect(() => {
    if (mode !== 'scatter' || placements || !fontsReady) return;
    const head = column.current?.getBoundingClientRect();
    const t = tip.current?.getBoundingClientRect();
    const sizes = cards.current.map(c => ({ w: c?.offsetWidth ?? 0, h: c?.offsetHeight ?? 0 }));
    if (!head || !t || sizes.some(z => !z.w)) return;
    const W = view.w, H = view.h, margin = 28;
    const b = askButton()?.getBoundingClientRect();
    const reserved: Box[] = [
      { x: head.x - 16, y: head.y - 12, w: head.width + 32, h: head.height + 24 },
      { x: t.x - 16, y: t.y - 12, w: t.width + 32, h: t.height + 24 },
      // The Ask AI ring and its label at the end.
      ...(b ? [{ x: b.x - 200, y: b.y - 60, w: b.width + 224, h: b.height + 84 }] : []),
      { x: 0, y: 0, w: 72, h: 72 },
    ];
    const result = scatterCards(sizes, { x: margin, y: 64, w: W - 2 * margin, h: H - 64 - margin }, reserved, seeded(seed), W >= 1024 ? 22 : 18);
    if (result) setPlacements(result);
    else setMode('grid');
  }, [view, mode, placements, seed, fontsReady]);

  // Shrink the whole composition on short screens (e.g. a phone held sideways).
  useLayoutEffect(() => {
    if (mode === 'scatter') return; // the scattered layout uses the whole screen instead
    const el = column.current;
    if (!el) return;
    const h = el.scrollHeight;
    const room = view.h - 72;
    setScale(h > room ? Math.max(0.6, room / h) : 1);
  }, [view, size, mode]);

  // The ring round Ask AI and the line drawn to it from the closing words.
  const pointToAsk = useCallback(() => {
    const w = window.innerWidth, h = window.innerHeight;
    const r = askButton()?.getBoundingClientRect() ?? new DOMRect(w - 84, h - 200, 64, 64);
    const ring = new DOMRect(Math.min(w - r.width - 20, Math.max(4, r.left - 8)), Math.min(h - r.height - 20, Math.max(4, r.top - 8)), r.width + 16, r.height + 16);
    const t = tip.current?.getBoundingClientRect();
    let path = '';
    if (t) {
      const narrow = w < 640;
      const sx = narrow ? t.left + t.width / 2 : t.right + 10;
      const sy = narrow ? t.bottom + 8 : t.top + t.height / 2;
      const ex = ring.left + ring.width / 2 - (ring.left > sx ? ring.width / 2 + 6 : -ring.width / 2 - 6);
      const ey = ring.top + ring.height / 2;
      path = `M ${sx} ${sy} C ${sx + (ex - sx) * 0.55} ${sy}, ${ex - (ex - sx) * 0.1} ${sy + (ey - sy) * 0.35}, ${ex} ${ey}`;
    }
    setAsk({ ring, path });
    return ring;
  }, []);

  // The choreography.
  useEffect(() => {
    if (still) {
      cards.current.forEach(c => { if (c) c.dataset.landed = '1'; });
      words.current.forEach(wd => { if (wd) { wd.style.opacity = '1'; wd.style.clipPath = 'none'; } });
      if (eyebrow.current) eyebrow.current.textContent = 'Welcome to';
      requestAnimationFrame(() => pointToAsk());
      const t = setTimeout(close, 6500);
      return () => clearTimeout(t);
    }

    const w = window.innerWidth, h = window.innerHeight;
    const n = COUNT[sizeOf(w)];
    // Every cursor starts just off-screen, spread round all four edges.
    movers.current = Array.from({ length: n }, (_, i) => {
      const a = (i / n) * Math.PI * 2 + 0.5;
      const R = Math.hypot(w, h) * 0.62;
      return new HumanMover(cursorEls.current[i], { x: w / 2 + Math.cos(a) * R, y: h / 2 + Math.sin(a) * R });
    });
    const m = movers.current;
    let alive = true;

    // Name tags sit to the left near the right edge.
    const face = (i: number, x: number) => {
      const tag = tagEls.current[i];
      if (!tag) return;
      const flip = x > window.innerWidth - 190;
      tag.style.left = flip ? '' : '12px';
      tag.style.right = flip ? 'calc(100% - 6px)' : '';
      tag.style.borderRadius = flip ? '10px 3px 10px 10px' : '3px 10px 10px 10px';
    };
    const go = (i: number, to: Point, opts: Parameters<HumanMover['moveTo']>[1] = {}) => {
      if (!alive || !m[i]) return Promise.resolve();
      face(i, to.x);
      return m[i].moveTo(to, opts);
    };

    // A drag: from the top-left of `rect` to its bottom-right, the marquee following the hand.
    const drag = async (i: number, rect: DOMRect, box: HTMLDivElement | null, onProgress?: (x: number) => void) => {
      const pad = 6;
      const sx = rect.left - pad, sy = rect.top - pad;
      await go(i, { x: sx, y: sy }, { maxDuration: 480, arc: 0.22 });
      if (!alive) return;
      if (box) { box.style.display = 'block'; box.style.opacity = '1'; }
      await go(i, { x: rect.right + pad, y: rect.bottom + pad }, {
        duration: 420 + Math.min(200, rect.width * 0.3), arc: 0.05, overshoot: false,
        onFrame: p => {
          if (box) {
            box.style.left = `${Math.min(sx, p.x)}px`;
            box.style.top = `${Math.min(sy, p.y)}px`;
            box.style.width = `${Math.abs(p.x - sx)}px`;
            box.style.height = `${Math.abs(p.y - sy)}px`;
          }
          onProgress?.(p.x);
        },
      });
      if (box) { box.style.opacity = '0'; setTimeout(() => { if (box) box.style.display = 'none'; }, 320); }
    };

    // Short comet trails behind every cursor, redrawn from the last ~0.35s each frame.
    const cv = canvas.current;
    const ctx = cv?.getContext('2d') ?? null;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    if (cv) { cv.width = w * dpr; cv.height = h * dpr; }
    const colors = Array.from({ length: n }, (_, i) => resolveColor(AGENTS[roleOf(i)].color));
    const trails: { x: number; y: number; t: number }[][] = m.map(() => []);
    const LIFE = 360;
    let raf = 0;
    const paint = (now: number) => {
      if (ctx) {
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        ctx.clearRect(0, 0, w, h);
        ctx.lineCap = 'round';
        m.forEach((mv, i) => {
          const tr = trails[i];
          const last = tr[tr.length - 1];
          if (!last || Math.hypot(mv.x - last.x, mv.y - last.y) > 0.6) tr.push({ x: mv.x, y: mv.y, t: now });
          while (tr.length && now - tr[0].t > LIFE) tr.shift();
          ctx.strokeStyle = colors[i];
          for (let k = 1; k < tr.length; k++) {
            const life = 1 - (now - tr[k].t) / LIFE;
            ctx.globalAlpha = 0.5 * life * life;
            ctx.lineWidth = 0.6 + 2.2 * life;
            ctx.beginPath();
            ctx.moveTo(tr[k - 1].x + 3, tr[k - 1].y + 3);
            ctx.lineTo(tr[k].x + 3, tr[k].y + 3);
            ctx.stroke();
          }
        });
        ctx.globalAlpha = 1;
      }
      raf = requestAnimationFrame(paint);
    };
    raf = requestAnimationFrame(paint);

    // Roaming cursors drift through the open space while the others work —
    // never over the words or the cards.
    const roam = async (i: number) => {
      while (alive && phaseRef.current !== 'ask') {
        const W = window.innerWidth, H = window.innerHeight;
        const avoid = [column.current, tip.current, ...cards.current].map(el => el?.getBoundingClientRect()).filter((r): r is DOMRect => !!r && r.width > 0);
        let to: Point | null = null;
        for (let k = 0; k < 16 && !to; k++) {
          const x = 16 + Math.random() * (W - 60), y = 70 + Math.random() * (H - 110);
          if (!avoid.some(r => x > r.left - 16 && x < r.right + 16 && y > r.top - 16 && y < r.bottom + 16)) to = { x, y };
        }
        if (to) await go(i, to, { maxDuration: 1100 });
        await wait(150 + Math.random() * 450);
      }
    };

    const run = async () => {
      await wait(30);
      // 1. Stream in round the title.
      const c = column.current?.getBoundingClientRect() ?? new DOMRect(w * 0.2, h * 0.2, w * 0.6, h * 0.6);
      m.forEach((_, i) => {
        const a = (i / n) * Math.PI * 2;
        const r = 0.42 + ((i * 37) % 10) / 30;
        go(i, { x: c.left + c.width / 2 + Math.cos(a) * c.width * r, y: c.top + c.height * 0.32 + Math.sin(a) * c.height * r * 0.7 }, { duration: 800 + (i % 4) * 80, delay: i * 25, arc: 0.3 });
      });
      await wait(750);

      // 2. "Welcome to", typed by the Orchestrator…
      const eb = eyebrow.current?.getBoundingClientRect();
      const text = 'Welcome to';
      if (eb) {
        await go(TYPIST, { x: eb.left - 4, y: eb.bottom - 2 }, { maxDuration: 380 });
        go(TYPIST, { x: eb.left + eb.width * 0.95, y: eb.bottom }, { duration: text.length * 42, arc: 0.02, overshoot: false, tremor: false });
      }
      (async () => {
        for (let k = 1; k <= text.length && alive; k++) {
          if (eyebrow.current) eyebrow.current.textContent = text.slice(0, k);
          await wait(42);
        }
        await wait(500);
        if (caret.current) caret.current.style.display = 'none';
      })();

      // …while three agents select the words, revealing each one.
      WORDS.forEach((_, k) => {
        const el = words.current[k];
        const r = el?.getBoundingClientRect();
        if (!el || !r) return;
        setTimeout(() => {
          if (!alive) return;
          el.style.opacity = '1';
          el.style.clipPath = 'inset(-20% 100% -20% 0)';
          drag(WORD_AGENTS[k], r, wordBoxes.current[k], x => {
            const right = Math.max(0, Math.min(100, ((r.right - x) / r.width) * 100));
            el.style.clipPath = `inset(-20% ${right}% -20% 0)`;
          }).then(() => { el.style.clipPath = 'none'; });
        }, 120 + k * 280);
      });
      await wait(1350);
      if (!alive) return;
      setPhase('sub');
      for (let i = TYPIST + 1; i < n; i++) roam(i);

      // 3. Nine agents drag out the cards.
      const builds = CARDS.map((_, k) => wait(k * 110).then(async () => {
        const el = cards.current[k];
        const r = el?.getBoundingClientRect();
        if (!el || !r || !alive) return;
        await drag(k, r, cardBoxes.current[k]);
        el.dataset.landed = '1';
        // Step back a little from the finished card.
        go(k, { x: r.right + 10 + Math.random() * 14, y: r.bottom + 6 + Math.random() * 12 }, { maxDuration: 420, overshoot: false });
      }));
      await Promise.all(builds);
      // Let the finished set be seen before moving on.
      await wait(700);
      if (!alive) return;

      // 4. Point to Ask AI, then fly into it. If the closing words would sit
      // under the button (short screens), the composition slides up first.
      phaseRef.current = 'ask';
      const btn = askButton()?.getBoundingClientRect();
      const t = tip.current?.getBoundingClientRect();
      const col = column.current;
      const gr = grid.current;
      if (btn && t && col && gr) {
        const overlap = t.bottom + 22 - (btn.top - 10);
        const sideBySide = btn.left > t.right + 12;
        const headroom = Math.max(0, col.getBoundingClientRect().top - 44);
        if (!sideBySide && overlap > 0) {
          if (headroom >= overlap) {
            col.style.transition = 'transform 520ms cubic-bezier(.22,.61,.36,1)';
            col.style.transform = `${scale < 1 ? `scale(${scale}) ` : ''}translateY(${-overlap / (scale || 1)}px)`;
            await wait(540);
          } else {
            // No room above: the cards bow out and the closing words take their place.
            // Collapse smoothly so the title glides instead of jumping.
            gr.style.overflow = 'hidden';
            gr.style.maxHeight = `${gr.scrollHeight}px`;
            void gr.offsetHeight;
            gr.style.transition = 'opacity 300ms ease, filter 300ms ease, max-height 520ms cubic-bezier(.22,.61,.36,1), margin 520ms cubic-bezier(.22,.61,.36,1)';
            gr.style.opacity = '0';
            gr.style.filter = 'blur(4px)';
            gr.style.maxHeight = '0px';
            gr.style.marginTop = '0px';
            await wait(540);
          }
        }
      }
      setPhase('ask');
      await wait(60);
      const ring = pointToAsk();
      const cx = ring.left + ring.width / 2, cy = ring.top + ring.height / 2;
      const facing = Math.atan2(h / 2 - cy, w / 2 - cx);
      // Names fade so the arrows read as one flock heading for the button.
      tagEls.current.forEach((t, i) => { if (t) { t.style.transition = `opacity 300ms ease ${i * 30}ms`; t.style.opacity = '0'; } });
      m.forEach((_, i) => {
        const a = facing + (i / Math.max(1, n - 1) - 0.5) * 2.2;
        const rad = ring.width * 0.75 + 16 + (i % 3) * 18;
        go(i, { x: Math.min(w - 24, Math.max(8, cx + Math.cos(a) * rad)), y: Math.min(h - 24, Math.max(8, cy + Math.sin(a) * rad)) }, { delay: 150 + i * 14, maxDuration: 700, arc: 0.28 });
      });
      await wait(150 + n * 14 + 700);
      m.forEach((_, i) => {
        const el = cursorEls.current[i];
        go(i, { x: cx - 3, y: cy - 3 }, { duration: 340, delay: i * 10, overshoot: false });
        if (el) { el.style.transition = `opacity 240ms ease ${i * 10 + 160}ms`; el.style.opacity = '0'; }
      });
      await wait(340 + n * 10 + 240);
      if (alive) close();
    };
    run();

    return () => { alive = false; cancelAnimationFrame(raf); m.forEach(mv => mv.stop()); };
    // The choreography runs once per opening.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const phone = size === 'phone';
  const gridWidth = size === 'desktop' ? Math.min(960, view.w - 96) : view.w - (phone ? 32 : 64);

  return (
    <div
      ref={root}
      role="dialog"
      aria-modal="true"
      aria-label="Welcome to Data Science Studio"
      data-swarm-ui
      onClick={close}
      className="fixed inset-0 z-[10001] overflow-hidden select-none cursor-default"
      style={{ opacity: leaving ? 0 : 1, transition: 'opacity 420ms ease' }}
    >
      {/* The stage: the studio blurred behind soft drifting light and a dot grid. */}
      <div className="absolute inset-0" style={{ background: 'color-mix(in srgb, var(--canvas) 84%, transparent)', backdropFilter: 'blur(22px) saturate(1.15)', WebkitBackdropFilter: 'blur(22px) saturate(1.15)' }} />
      {([
        ['--agent-orchestrator', '-12vmax', '-14vmax', 0],
        ['--agent-ml-engineer', '58vw', '-10vmax', -4],
        ['--agent-statistician', '46vw', '56vh', -8],
        ['--agent-data-engineer', '-10vmax', '48vh', -2],
      ] as const).map(([c, left, top, delay]) => (
        <div
          key={c}
          aria-hidden="true"
          className="absolute rounded-full pointer-events-none"
          style={{
            left, top, width: '52vmax', height: '52vmax',
            background: `radial-gradient(circle, color-mix(in srgb, var(${c}) 30%, transparent) 0%, transparent 62%)`,
            filter: 'blur(30px)', opacity: 0.75,
            animation: `welcome-drift 14s ease-in-out ${delay}s infinite alternate`,
          }}
        />
      ))}
      <div
        aria-hidden="true"
        className="absolute inset-0 pointer-events-none"
        style={{
          backgroundImage: 'radial-gradient(circle, color-mix(in srgb, var(--label) 13%, transparent) 1px, transparent 1.5px)',
          backgroundSize: '26px 26px',
          maskImage: 'radial-gradient(ellipse 70% 65% at 50% 45%, black 20%, transparent 75%)',
          WebkitMaskImage: 'radial-gradient(ellipse 70% 65% at 50% 45%, black 20%, transparent 75%)',
        }}
      />
      <canvas ref={canvas} aria-hidden="true" className="absolute inset-0 w-full h-full pointer-events-none" />

      {/* Skip: small and dim, top-left, clear of the notch; the ring shows the time left. */}
      <button
        type="button"
        onClick={e => { e.stopPropagation(); close(); }}
        aria-label="Close welcome"
        className="absolute z-20 w-10 h-10 rounded-full flex items-center justify-center text-label-2 opacity-50 hover:opacity-100 focus-visible:opacity-100 transition-opacity"
        style={{ top: 'max(12px, env(safe-area-inset-top))', left: 'max(12px, env(safe-area-inset-left))' }}
      >
        <svg width="36" height="36" viewBox="0 0 36 36" className="absolute inset-0.5 -rotate-90" aria-hidden="true">
          <circle cx="18" cy="18" r="16" fill="none" stroke="currentColor" strokeOpacity="0.18" strokeWidth="1.5" />
          {!still && (
            <circle cx="18" cy="18" r="16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeDasharray="100.53" style={{ animation: `welcome-progress ${TOTAL_MS}ms linear forwards` }} />
          )}
        </svg>
        <X className="w-4 h-4" />
      </button>

      {/* The composition. */}
      {(() => {
        const head = (
          <>
            <p className="h-5 font-semibold uppercase text-label-2" style={{ fontSize: phone ? 11 : 13, letterSpacing: '0.32em' }}>
              <span ref={eyebrow} />
              {!still && <span ref={caret} aria-hidden="true" className="inline-block w-[1.5px] h-[1em] align-[-2px] ml-1" style={{ background: AGENTS.orchestrator.color, animation: 'welcome-caret 0.9s steps(1) infinite' }} />}
            </p>
            <h1
              className="font-editorial font-semibold text-label mt-3"
              style={{ fontSize: phone ? 'clamp(38px, 11.5vw, 52px)' : 'clamp(52px, 7.6vw, 96px)', lineHeight: 0.98, letterSpacing: '-0.025em', maxWidth: gridWidth }}
            >
              {WORDS.map((wd, k) => (
                <React.Fragment key={wd}>
                  <span ref={el => { words.current[k] = el; }} className={`inline-block ${k === 2 ? 'italic font-normal' : ''}`} style={{ opacity: 0, paddingInline: '0.04em' }}>{wd}</span>
                  {k < WORDS.length - 1 && ' '}
                </React.Fragment>
              ))}
            </h1>
            <p className="welcome-reveal font-editorial italic text-label-2 mt-4" data-on={phase !== 'intro' ? '1' : '0'} style={{ fontSize: phone ? 17 : 'clamp(18px, 1.9vw, 23px)' }}>
              Your team of {TEAM_SIZE} AI agents
            </p>
          </>
        );
        const tipEl = (
          <div ref={tip} className="welcome-reveal" data-on={phase === 'ask' ? '1' : '0'}>
            <p className="font-editorial font-semibold text-label" style={{ fontSize: phone ? 20 : 'clamp(21px, 2.3vw, 28px)', letterSpacing: '-0.01em' }}>
              Just ask — we’ll do it right here on your page.
            </p>
            <p className="mt-1.5 text-label-2" style={{ fontSize: phone ? 14 : 16 }}>
              To give the agents a task, tap <span className="font-semibold" style={{ color: AGENTS.orchestrator.color }}>Ask AI</span>{phone ? '.' : ', the floating button.'}
            </p>
          </div>
        );
        const card = (c: typeof CARDS[number], k: number) => {
          const color = AGENTS[c.role].color;
          return (
            <div
              ref={el => { cards.current[k] = el; }}
              className={`welcome-card rounded-2xl border border-separator text-left ${phone ? 'flex flex-col items-center gap-1.5 px-1.5 py-3' : 'flex items-center gap-3 px-4 py-3.5'}`}
              style={{ background: 'color-mix(in srgb, var(--raised) 82%, transparent)', boxShadow: '0 1px 2px rgba(0,0,0,0.04), 0 10px 30px -12px rgba(0,0,0,0.18)' }}
            >
              <span className={`welcome-icon shrink-0 rounded-xl flex items-center justify-center ${phone ? 'w-8 h-8' : 'w-10 h-10'}`} style={{ background: `color-mix(in srgb, ${color} 13%, transparent)`, color }}>
                <c.Icon className={phone ? 'w-4 h-4' : 'w-[19px] h-[19px]'} strokeWidth={1.9} />
              </span>
              {phone ? (
                <span className="font-editorial font-semibold text-label text-[14px] leading-tight text-center">{c.short}</span>
              ) : (
                <span className="min-w-0">
                  <span className="block font-semibold uppercase text-[10px] tracking-[0.14em] whitespace-nowrap overflow-hidden text-ellipsis" style={{ color }}>{AGENTS[c.role].name}</span>
                  <span className="block font-editorial font-semibold text-label leading-snug" style={{ fontSize: size === 'desktop' ? 18 : 16 }}>{c.text}</span>
                </span>
              )}
            </div>
          );
        };

        if (mode === 'scatter') {
          const cardW = size === 'desktop' ? 284 : 262;
          return (
            <>
              <div className="absolute inset-x-0 flex justify-center px-4" style={{ top: 'max(56px, 7vh)' }}>
                <div ref={column} className="flex flex-col items-center text-center">{head}</div>
              </div>
              <div className="absolute inset-x-0 flex justify-center px-4 text-center" style={{ bottom: 'max(40px, 7vh)' }}>{tipEl}</div>
              {/* Scattered, each a little tilted; hidden until their places are found. */}
              {CARDS.map((c, k) => (
                <div
                  key={c.text}
                  className="absolute left-0 top-0"
                  style={{
                    width: cardW,
                    visibility: placements ? 'visible' : 'hidden',
                    transform: placements ? `translate(${placements[k].x}px, ${placements[k].y}px) rotate(${placements[k].rot}deg)` : undefined,
                  }}
                >
                  {card(c, k)}
                </div>
              ))}
            </>
          );
        }
        return (
          <div className="absolute inset-0 flex items-center justify-center px-4" style={{ paddingTop: 'max(52px, env(safe-area-inset-top))', paddingBottom: phone ? 120 : 96 }}>
            <div ref={column} className="flex flex-col items-center text-center" style={{ transform: scale < 1 && mode === 'grid' ? `scale(${scale})` : undefined }}>
              {head}
              {/* A loosely tilted grid: phones, and screens too tight to scatter on. */}
              <div ref={grid} className="grid mt-7 sm:mt-10" style={{ width: gridWidth, gridTemplateColumns: 'repeat(3, minmax(0, 1fr))', gap: phone ? 10 : 14 }}>
                {CARDS.map((c, k) => (
                  <div key={c.text} style={{ transform: `rotate(${tilts[k].rot}deg) translateY(${tilts[k].dy}px)` }}>{card(c, k)}</div>
                ))}
              </div>
              <div className="mt-8 sm:mt-10">{tipEl}</div>
            </div>
          </div>
        );
      })()}

      {/* The line to Ask AI, with a dot travelling along it. */}
      {ask?.path && (
        <svg className="absolute inset-0 w-full h-full pointer-events-none" aria-hidden="true">
          <defs>
            <mask id="welcome-line-mask">
              <path d={ask.path} fill="none" stroke="white" strokeWidth="6" pathLength={1} strokeDasharray="1" style={{ animation: 'welcome-draw 700ms cubic-bezier(.22,.61,.36,1) both' }} />
            </mask>
          </defs>
          <path d={ask.path} fill="none" stroke={AGENTS.orchestrator.color} strokeOpacity="0.7" strokeWidth="1.6" strokeDasharray="3 6" strokeLinecap="round" mask="url(#welcome-line-mask)" />
          <circle r="3.2" fill={AGENTS.orchestrator.color}>
            <animateMotion dur="1.6s" repeatCount="indefinite" path={ask.path} begin="0.6s" />
          </circle>
        </svg>
      )}

      {/* Ask AI: the button itself is under the welcome, so it is shown here. */}
      {ask && (
        <div
          className="absolute z-10 rounded-full border-2 pointer-events-none flex items-center justify-center"
          style={{
            left: ask.ring.left, top: ask.ring.top, width: ask.ring.width, height: ask.ring.height,
            borderColor: AGENTS.orchestrator.color, background: 'var(--raised)',
            animation: 'agent-target 400ms ease-out both, welcome-pulse 1.4s ease-in-out 400ms infinite',
          }}
        >
          <Orb state="breathing" size={64} label="Ask AI" />
          <span
            className="absolute whitespace-nowrap px-2.5 py-1 text-[11px] font-semibold text-white shadow-lg"
            style={{
              background: AGENTS.orchestrator.color, borderRadius: 999,
              ...(ask.ring.top > 60 ? { top: -32 } : { bottom: -32 }), ...(ask.ring.left > view.w / 2 ? { right: 0 } : { left: 0 }),
            }}
          >
            {phone ? 'Ask AI' : 'Ask AI · give the team a task'}
          </span>
        </div>
      )}

      {/* Live selection boxes, drawn by the cursors as they drag. */}
      {WORDS.map((wd, k) => {
        const color = AGENTS[roleOf(WORD_AGENTS[k])].color;
        return <div key={wd} ref={el => { wordBoxes.current[k] = el; }} className="welcome-marquee" style={{ borderColor: color, background: `color-mix(in srgb, ${color} 9%, transparent)` }} />;
      })}
      {CARDS.map((c, k) => {
        const color = AGENTS[c.role].color;
        return <div key={c.text} ref={el => { cardBoxes.current[k] = el; }} className="welcome-marquee" style={{ borderColor: color, background: `color-mix(in srgb, ${color} 7%, transparent)`, borderRadius: 16 }} />;
      })}

      {/* The swarm. */}
      {!still && Array.from({ length: count }, (_, i) => {
        const role = roleOf(i);
        const color = AGENTS[role].color;
        return (
          <div key={i} ref={el => { cursorEls.current[i] = el; }} className="absolute left-0 top-0 z-30 pointer-events-none will-change-transform" aria-hidden="true" style={{ transform: 'translate3d(-100px,-100px,0)' }}>
            <div className="-ml-[2.5px] -mt-[2.5px]"><CursorGlyph color={color} size={phone ? 19 : 22} /></div>
            <span
              ref={el => { tagEls.current[i] = el; }}
              className={`absolute whitespace-nowrap font-medium text-white ${phone ? 'top-[15px] text-[9.5px] px-1.5 py-[2px]' : 'top-[17px] text-[11px] px-2 py-[3px]'}`}
              style={{ left: 12, background: color, borderRadius: '3px 10px 10px 10px', boxShadow: '0 0 0 1px rgba(255,255,255,0.18) inset, 0 2px 6px rgba(0,0,0,0.18)' }}
            >
              {AGENTS[role].name}
            </span>
          </div>
        );
      })}
    </div>
  );
}
