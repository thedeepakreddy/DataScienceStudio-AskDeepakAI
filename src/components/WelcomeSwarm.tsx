/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Check, Eye, MessageSquareText, ShieldCheck, Users, X } from 'lucide-react';
import { AGENTS, AgentRole } from '../swarm/agents';
import { HumanMover, Point } from '../swarm/humanMotion';
import { CursorGlyph } from './AgentCursor';
import Orb from './Orb';
import { demoResults } from './welcomeDemo';

// The agent team's welcome, each time the studio opens (about seventeen seconds).
// It says what the agents can do, then five of them do real work on a small
// sample, in order, while you watch: every number shown is computed from the
// rows (welcomeDemo.ts), nothing is drawn for show.
//
// 1. The Data Engineer fills two blank cells with each column's median.
// 2. The Statistician drags across two columns and the correlation appears.
// 3. The ML Engineer presses Train: a one-rule model is fitted on 14 rows and
//    scored on the 6 it never saw.
// 4. The Dashboard Designer drags a chart into the dashboard and widens it by
//    its curved corner.
// 5. The Verifier recomputes the results and ticks them off.
// Then the team flies into the Ask AI button: that's where you give them work.
// ×, Esc or a tap skips it; with reduced motion it is the finished picture.

const CAST: AgentRole[] = ['data_engineer', 'statistician', 'ml_engineer', 'dashboard_designer', 'verifier', 'orchestrator'];
const TEAM_SIZE = Object.keys(AGENTS).length;
const TOTAL_MS = 17000;
const SHOWN_ROWS = 8;

const POINTS = [
  { Icon: MessageSquareText, text: 'Give them a goal in plain words: “find why customers leave and build a dashboard”.' },
  { Icon: Users, text: 'They plan it, split it across specialists and do the work in your studio, step by step, in order.' },
  { Icon: Eye, text: 'You watch every step, and can pause, stop or undo any of it.' },
  { Icon: ShieldCheck, text: 'They check each other: a verifier recomputes the results, so nothing is made up.' },
];

const reducedMotion = () => typeof window !== 'undefined' && !!window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
const askButton = () => document.querySelector<HTMLElement>('[aria-label="Open the AI assistant"]');
const wait = (ms: number) => new Promise<void>(r => setTimeout(r, ms));
const pct = (x: number) => `${Math.round(x * 100)}%`;

interface Board {
  cells: Record<string, string>;      // "row:col" → shown text
  flash: string[];                    // cells just filled
  selectedCols: string[];             // columns the Statistician is dragging over
  r: string | null;
  training: number | null;            // 0–1 while training
  model: string | null;
  chartIn: boolean;                   // the chart is in the dashboard
  chartWide: number;                  // 0–1, how far it has been widened
  dragChart: Point | null;            // the chart following the pointer
  checks: number;                     // ticks shown
}

export default function WelcomeSwarm({ onClose }: { onClose: () => void }) {
  const still = reducedMotion();
  const demo = useMemo(() => demoResults(), []);
  const [view, setView] = useState(() => ({ w: window.innerWidth, h: window.innerHeight }));
  const phone = view.w < 640;

  const initialCells = useMemo(() => {
    const c: Record<string, string> = {};
    demo.raw.slice(0, SHOWN_ROWS).forEach((x, i) => {
      c[`${i}:tenure`] = x.tenure == null ? '' : String(x.tenure);
      c[`${i}:charges`] = x.charges == null ? '' : String(x.charges);
    });
    return c;
  }, [demo]);
  const finished: Board = useMemo(() => {
    const cells = { ...initialCells };
    demo.fills.forEach(f => { cells[`${f.row}:${f.col}`] = String(f.value); });
    return { cells, flash: [], selectedCols: [], r: demo.r.toFixed(2), training: null, model: pct(demo.model.accuracy), chartIn: true, chartWide: 1, dragChart: null, checks: 3 };
  }, [demo, initialCells]);
  const [board, setBoard] = useState<Board>(() => (still ? finished : { cells: initialCells, flash: [], selectedCols: [], r: null, training: null, model: null, chartIn: false, chartWide: 0, dragChart: null, checks: 0 }));
  const patch = (p: Partial<Board> | ((b: Board) => Partial<Board>)) => setBoard(b => ({ ...b, ...(typeof p === 'function' ? p(b) : p) }));

  const [leaving, setLeaving] = useState(false);
  const [ask, setAsk] = useState<DOMRect | null>(null);
  const [labels, setLabels] = useState<string[]>(() => CAST.map(() => ''));
  const say = (i: number, text: string) => setLabels(l => l.map((x, k) => (k === i ? text : x)));

  const root = useRef<HTMLDivElement | null>(null);
  const cursorEls = useRef<(HTMLDivElement | null)[]>([]);
  const movers = useRef<HumanMover[]>([]);
  const closed = useRef(false);

  const close = useCallback(() => {
    if (closed.current) return;
    closed.current = true;
    movers.current.forEach(m => m.stop());
    setLeaving(true);
    setTimeout(onClose, 420);
  }, [onClose]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') close(); };
    const onResize = () => setView({ w: window.innerWidth, h: window.innerHeight });
    window.addEventListener('keydown', onKey);
    window.addEventListener('resize', onResize);
    return () => { window.removeEventListener('keydown', onKey); window.removeEventListener('resize', onResize); };
  }, [close]);

  const ringAtAsk = useCallback(() => {
    const w = window.innerWidth, h = window.innerHeight;
    const r = askButton()?.getBoundingClientRect() ?? new DOMRect(w - 84, h - 200, 64, 64);
    const ring = new DOMRect(Math.min(w - r.width - 20, Math.max(4, r.left - 8)), Math.min(h - r.height - 20, Math.max(4, r.top - 8)), r.width + 16, r.height + 16);
    setAsk(ring);
    return ring;
  }, []);

  // The choreography.
  useEffect(() => {
    if (still) {
      requestAnimationFrame(() => ringAtAsk());
      const t = setTimeout(close, 13500);
      return () => clearTimeout(t);
    }
    const w = window.innerWidth, h = window.innerHeight;
    movers.current = CAST.map((_, i) => {
      const a = (i / CAST.length) * Math.PI * 2 + 0.6;
      const R = Math.hypot(w, h) * 0.6;
      return new HumanMover(cursorEls.current[i], { x: w / 2 + Math.cos(a) * R, y: h / 2 + Math.sin(a) * R });
    });
    const m = movers.current;
    let alive = true;
    const q = (sel: string) => root.current?.querySelector<HTMLElement>(sel)?.getBoundingClientRect() ?? null;
    // Brings the part being worked on into view (on phones the board is below the words).
    const show = async (sel: string) => {
      const el = root.current?.querySelector<HTMLElement>(sel);
      const r = el?.getBoundingClientRect();
      if (!el || !r || (r.top > 70 && r.bottom < window.innerHeight - 40)) return;
      el.scrollIntoView({ block: 'center', behavior: 'smooth' });
      await wait(420);
    };
    // Between steps each agent waits just outside the board, out of the way.
    const park = (i: number) => {
      const b = q('[data-demo="board"]');
      if (!b) return Promise.resolve();
      const spot = { x: b.left + 24 + (i * (b.width - 48)) / (CAST.length - 1), y: Math.min(window.innerHeight - 30, b.bottom + 22) };
      say(i, '');
      return go(i, spot, { maxDuration: 700, arc: 0.2 });
    };
    const at = (r: DOMRect | null, fx = 0.5, fy = 0.5): Point => (r ? { x: r.left + r.width * fx, y: r.top + r.height * fy } : { x: w / 2, y: h / 2 });
    const go = (i: number, to: Point, opts: Parameters<HumanMover['moveTo']>[1] = {}) => (alive ? m[i].moveTo(to, opts) : Promise.resolve());
    const press = async (i: number) => {
      const el = cursorEls.current[i];
      el?.classList.add('is-pressing');
      await wait(130);
      el?.classList.remove('is-pressing');
    };

    const run = async () => {
      await wait(60);
      // Everyone arrives just below the board, where the work happens.
      await show('[data-demo="board"]');
      CAST.forEach((_, i) => { setTimeout(() => park(i), i * 90); });
      await wait(1250);

      // 1. Data Engineer: fill each blank with the median, typed in.
      for (const f of demo.fills) {
        if (!alive) return;
        const key = `${f.row}:${f.col}`;
        await show(`[data-cell="${key}"]`);
        say(0, `Filling a blank ${f.col} with the median`);
        await go(0, at(q(`[data-cell="${key}"]`), 0.3, 0.6), { maxDuration: 520 });
        await press(0);
        const text = String(f.value);
        for (let k = 1; k <= text.length; k++) { patch(bd => ({ cells: { ...bd.cells, [key]: text.slice(0, k) } })); await wait(110); }
        patch(bd => ({ flash: [...bd.flash, key] }));
        await wait(260);
      }
      say(0, 'No blanks left');
      await wait(300);
      park(0);

      // 2. Statistician: drag across the two columns; the correlation is computed from all 20 rows.
      if (!alive) return;
      await show('[data-head="tenure"]');
      say(1, 'Selecting tenure and charges');
      await go(1, at(q('[data-head="tenure"]')), { maxDuration: 560 });
      await press(1);
      patch({ selectedCols: ['tenure'] });
      await go(1, at(q('[data-head="charges"]')), { duration: 420, arc: 0.05, overshoot: false });
      patch({ selectedCols: ['tenure', 'charges'] });
      await wait(220);
      patch({ r: demo.r.toFixed(2) });
      say(1, `Correlation r = ${demo.r.toFixed(2)}`);
      await go(1, at(q('[data-demo="r"]'), 0.15), { maxDuration: 480 });
      await wait(380);
      patch({ selectedCols: [] });
      park(1);

      // 3. ML Engineer: train a one-rule model on 14 rows, score it on the other 6.
      if (!alive) return;
      await show('[data-demo="train"]');
      say(2, 'Training on 14 rows');
      await go(2, at(q('[data-demo="train"]')), { maxDuration: 560 });
      await press(2);
      for (let s = 0; s <= 1.0001 && alive; s += 0.1) { patch({ training: s }); await wait(120); }
      patch({ training: null, model: pct(demo.model.accuracy) });
      say(2, `${pct(demo.model.accuracy)} right on 6 rows it never saw`);
      await wait(700);
      park(2);

      // 4. Dashboard Designer: drag the chart into the dashboard, then widen it by its curved corner.
      if (!alive) return;
      await show('[data-demo="tray"]');
      say(3, 'Adding a chart to the dashboard');
      const tray = q('[data-demo="tray"]');
      await go(3, at(tray), { maxDuration: 560 });
      await press(3);
      const slot = q('[data-demo="slot"]');
      if (tray && slot) {
        const from = at(tray), to = { x: slot.left + slot.width * 0.72, y: slot.top + slot.height / 2 };
        const steps = 14;
        for (let k = 1; k <= steps && alive; k++) {
          const p = { x: from.x + ((to.x - from.x) * k) / steps, y: from.y + ((to.y - from.y) * k) / steps };
          patch({ dragChart: p });
          m[3].jump(p);
          await wait(26);
        }
      }
      patch({ dragChart: null, chartIn: true });
      await wait(260);
      say(3, 'Making it wider');
      const corner = q('[data-demo="corner"]');
      if (corner) {
        await go(3, at(corner, 0.4, 0.6), { maxDuration: 420 });
        await press(3);
        const start = at(corner, 0.4, 0.6);
        for (let k = 1; k <= 12 && alive; k++) {
          patch({ chartWide: k / 12 });
          m[3].jump({ x: start.x - (k / 12) * (slot ? slot.width * 0.38 : 120), y: start.y + k * 1.5 });
          await wait(30);
        }
      }
      await wait(300);
      park(3);

      // 5. Verifier: recomputes and ticks each result.
      if (!alive) return;
      for (let k = 0; k < 3 && alive; k++) {
        await show(`[data-check="${k}"]`);
        say(4, ['Checking the blanks', 'Recomputing r', 'Rescoring the model'][k]);
        await go(4, at(q(`[data-check="${k}"]`), 0.08), { maxDuration: 460 });
        await press(4);
        patch({ checks: k + 1 });
        await wait(260);
      }
      say(4, 'All checked');
      await wait(700);

      // The team heads for Ask AI.
      if (!alive) return;
      const ring = ringAtAsk();
      const cx = ring.left + ring.width / 2, cy = ring.top + ring.height / 2;
      CAST.forEach((_, i) => say(i, ''));
      await Promise.all(CAST.map((_, i) => go(i, { x: cx - 3, y: cy - 3 }, { duration: 700, delay: i * 70, arc: 0.25, overshoot: false })));
      cursorEls.current.forEach((el, i) => { if (el) { el.style.transition = `opacity 260ms ease ${i * 30}ms`; el.style.opacity = '0'; } });
      await wait(900);
      if (alive) close();
    };
    run();
    return () => { alive = false; m.forEach(mv => mv.stop()); };
    // The choreography runs once per opening.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const color = (role: AgentRole) => AGENTS[role].color;
  const shown = demo.raw.slice(0, SHOWN_ROWS);
  const maxRate = Math.max(...demo.byPlan.map(g => g.rate), 0.01);

  return (
    <div ref={root} role="dialog" aria-modal="true" aria-label="Meet your AI agents" data-swarm-ui onClick={close}
      className="fixed inset-0 z-[10001] overflow-y-auto overflow-x-hidden select-none cursor-default"
      style={{ opacity: leaving ? 0 : 1, transition: 'opacity 420ms ease' }}>
      <div className="fixed inset-0" style={{ background: 'color-mix(in srgb, var(--canvas) 86%, transparent)', backdropFilter: 'blur(22px) saturate(1.15)', WebkitBackdropFilter: 'blur(22px) saturate(1.15)' }} />
      {([['--agent-orchestrator', '-12vmax', '-14vmax', 0], ['--agent-ml-engineer', '58vw', '-10vmax', -4], ['--agent-statistician', '46vw', '56vh', -8]] as const).map(([c, left, top, delay]) => (
        <div key={c} aria-hidden="true" className="fixed rounded-full pointer-events-none"
          style={{ left, top, width: '52vmax', height: '52vmax', background: `radial-gradient(circle, color-mix(in srgb, var(${c}) 26%, transparent) 0%, transparent 62%)`, filter: 'blur(30px)', opacity: 0.7, animation: `welcome-drift 14s ease-in-out ${delay}s infinite alternate` }} />
      ))}

      {/* Skip, with a ring showing the time left. */}
      <button type="button" onClick={e => { e.stopPropagation(); close(); }} aria-label="Close welcome"
        className="fixed z-40 w-10 h-10 rounded-full flex items-center justify-center text-label-2 opacity-50 hover:opacity-100 focus-visible:opacity-100 transition-opacity"
        style={{ top: 'max(12px, env(safe-area-inset-top))', left: 'max(12px, env(safe-area-inset-left))' }}>
        <svg width="36" height="36" viewBox="0 0 36 36" className="absolute inset-0.5 -rotate-90" aria-hidden="true">
          <circle cx="18" cy="18" r="16" fill="none" stroke="currentColor" strokeOpacity="0.18" strokeWidth="1.5" />
          {!still && <circle cx="18" cy="18" r="16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeDasharray="100.53" style={{ animation: `welcome-progress ${TOTAL_MS}ms linear forwards` }} />}
        </svg>
        <X className="w-4 h-4" />
      </button>

      <div className="relative min-h-full flex items-center justify-center px-4 sm:px-8 py-16">
        <div className="w-full max-w-[1120px] grid grid-cols-1 lg:grid-cols-[minmax(0,400px)_minmax(0,1fr)] gap-8 lg:gap-12 items-center">
          {/* What the agents do. */}
          <div className="animate-fade-in">
            <p className="text-[12px] font-semibold uppercase tracking-[0.28em] text-label-2">Your AI team</p>
            <h1 className="font-editorial font-semibold text-label mt-3 leading-[1.02] tracking-[-0.02em]" style={{ fontSize: phone ? 34 : 'clamp(38px, 4.2vw, 52px)' }}>
              {TEAM_SIZE} specialists that work right on your page.
            </h1>
            <ul className={phone ? 'mt-4 space-y-2.5' : 'mt-6 space-y-3.5'}>
              {POINTS.map(({ Icon, text }) => (
                <li key={text} className={`flex items-start gap-3 text-label leading-relaxed ${phone ? 'text-[13.5px]' : 'text-[15px]'}`}>
                  <span className="mt-0.5 w-8 h-8 shrink-0 rounded-xl flex items-center justify-center" style={{ background: 'color-mix(in srgb, var(--agent-orchestrator) 13%, transparent)', color: 'var(--agent-orchestrator)' }}><Icon className="w-4 h-4" /></span>
                  <span>{text}</span>
                </li>
              ))}
            </ul>
            <p className="mt-6 text-[15px] text-label-2">
              To give them a task, tap <span className="font-semibold" style={{ color: color('orchestrator') }}>Ask AI</span>{phone ? '.' : ', the floating button.'}
            </p>
          </div>

          {/* The live demo. */}
          <div className="min-w-0">
            <div data-demo="board" className="rounded-3xl border border-separator p-4 sm:p-5 space-y-4 animate-fade-in"
              style={{ background: 'color-mix(in srgb, var(--raised) 94%, transparent)', boxShadow: '0 1px 2px rgba(0,0,0,0.04), 0 24px 60px -24px rgba(0,0,0,0.28)' }}>
              <div className="flex items-baseline justify-between gap-2">
                <p className="text-sm font-semibold text-label">customers.csv <span className="font-normal text-label-3">· 20 rows</span></p>
                <p className="text-[11px] text-label-3">Live · every number is computed</p>
              </div>

              <div className="overflow-hidden rounded-xl border border-separator">
                <table className="w-full text-[12.5px] tabular-nums">
                  <thead className="bg-fill">
                    <tr>
                      {(['id', 'plan', 'tenure', 'charges', 'churned'] as const).map(c => (
                        <th key={c} data-head={c} className="px-2.5 py-1.5 text-left font-semibold text-label-2 transition-colors"
                          style={board.selectedCols.includes(c) ? { background: `color-mix(in srgb, ${color('statistician')} 22%, transparent)`, color: 'var(--label)' } : undefined}>{c}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {shown.map((x, i) => (
                      <tr key={x.id} className="border-t border-separator">
                        <td className="px-2.5 py-1 text-label-3">{x.id}</td>
                        <td className="px-2.5 py-1 text-label">{x.plan}</td>
                        {(['tenure', 'charges'] as const).map(c => {
                          const key = `${i}:${c}`;
                          const blank = board.cells[key] === '';
                          const filled = board.flash.includes(key);
                          return (
                            <td key={c} data-cell={key} className="px-2.5 py-1 transition-colors duration-500"
                              style={{ background: board.selectedCols.includes(c) ? `color-mix(in srgb, ${color('statistician')} 10%, transparent)` : filled ? 'color-mix(in srgb, var(--green) 16%, transparent)' : undefined }}>
                              {blank ? <span className="inline-block w-10 rounded bg-orange/15 text-orange text-[11px] text-center">blank</span> : <span className={filled ? 'font-semibold text-label' : 'text-label'}>{board.cells[key]}</span>}
                            </td>
                          );
                        })}
                        <td className="px-2.5 py-1" style={{ color: x.churned === 'Yes' ? 'var(--orange)' : 'var(--label-2)' }}>{x.churned}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div data-demo="r" className="rounded-xl bg-well px-3 py-2.5">
                  <p className="text-[11px] uppercase tracking-wide text-label-3">Tenure × charges</p>
                  <p className="text-[15px] font-semibold text-label tabular-nums">{board.r ? `r = ${board.r}` : '—'}</p>
                </div>
                <div className="rounded-xl bg-well px-3 py-2.5 flex items-center gap-3">
                  <button type="button" tabIndex={-1} data-demo="train" className="btn btn-sm btn-primary pointer-events-none">Train</button>
                  <div className="min-w-0 flex-1">
                    {board.training != null ? (
                      <div className="h-1.5 rounded-full bg-fill overflow-hidden"><div className="h-full rounded-full" style={{ width: pct(board.training), background: color('ml_engineer'), transition: 'width 110ms linear' }} /></div>
                    ) : board.model ? (
                      <p className="text-[12.5px] text-label leading-snug"><b className="tabular-nums">{board.model}</b> right on {demo.model.testRows} new rows <span className="text-label-3">· rule: {demo.model.rule}</span></p>
                    ) : <p className="text-[12.5px] text-label-3">A model of churn</p>}
                  </div>
                </div>
              </div>

              {/* A mini dashboard: the chart is dragged in, then widened by its curved corner. */}
              <div className="grid grid-cols-[1fr_auto] gap-3 items-stretch">
                <div data-demo="slot" className="rounded-xl border border-dashed border-separator-strong min-h-[92px] p-2 flex justify-end">
                  {board.chartIn ? (
                    <div className="relative rounded-lg bg-raised border border-separator p-2.5 transition-[width] duration-150" style={{ width: `${56 + board.chartWide * 44}%` }}>
                      <p className="text-[11px] font-semibold text-label mb-1.5">Churn rate by plan</p>
                      {demo.byPlan.map(g => (
                        <div key={g.plan} className="flex items-center gap-2 text-[11px] text-label-2 mb-1">
                          <span className="w-12 shrink-0">{g.plan}</span>
                          <span className="h-2.5 rounded-sm" style={{ width: `${(g.rate / maxRate) * 70}%`, background: color('dashboard_designer') }} />
                          <span className="tabular-nums">{pct(g.rate)}</span>
                        </div>
                      ))}
                      <span data-demo="corner" className="absolute left-0 bottom-0 w-5 h-5" aria-hidden="true">
                        <svg viewBox="0 0 20 20" className="w-full h-full"><path d="M3 3 C3 11 7 17 16 17" fill="none" stroke="var(--label-3)" strokeWidth="3" strokeLinecap="round" /></svg>
                      </span>
                    </div>
                  ) : <p className="m-auto text-[11px] text-label-3">Dashboard</p>}
                </div>
                <div data-demo="tray" className="w-24 rounded-xl bg-well flex flex-col items-center justify-center gap-1 p-2" style={{ opacity: board.chartIn ? 0.35 : 1 }}>
                  <span className="flex items-end gap-0.5 h-6">{[0.5, 0.9, 0.35].map((v, k) => <span key={k} className="w-2 rounded-sm" style={{ height: `${v * 100}%`, background: color('dashboard_designer') }} />)}</span>
                  <span className="text-[10px] text-label-3">Chart</span>
                </div>
              </div>

              <ul className="space-y-1.5">
                {[`Blanks filled with medians (${demo.fills.map(f => f.value).join(', ')}): none left`, `Correlation recomputed from all 20 rows: ${demo.r.toFixed(2)}`, `Model rescored on the 6 held-out rows: ${pct(demo.model.accuracy)}`].map((t, k) => (
                  <li key={k} data-check={k} className="flex items-center gap-2 text-[12.5px] transition-colors" style={{ color: board.checks > k ? 'var(--label)' : 'var(--label-3)' }}>
                    <span className="w-4 h-4 rounded-full flex items-center justify-center shrink-0 transition-colors" style={{ background: board.checks > k ? color('verifier') : 'var(--fill)', color: '#fff' }}>{board.checks > k && <Check className="w-3 h-3" strokeWidth={3} />}</span>
                    {t}
                  </li>
                ))}
              </ul>
            </div>
          </div>
        </div>
      </div>

      {/* The chart being carried. */}
      {board.dragChart && (
        <div className="fixed z-30 pointer-events-none rounded-lg bg-raised border border-separator shadow-xl px-3 py-2 text-[11px] font-semibold text-label" style={{ left: board.dragChart.x - 30, top: board.dragChart.y - 16, transform: 'rotate(-2deg)' }}>
          Churn rate by plan
        </div>
      )}

      {/* Ask AI: the real button is under the welcome, so it is shown here. */}
      {ask && (
        <div className="fixed z-30 rounded-full border-2 pointer-events-none flex items-center justify-center"
          style={{ left: ask.left, top: ask.top, width: ask.width, height: ask.height, borderColor: color('orchestrator'), background: 'var(--raised)', animation: 'agent-target 400ms ease-out both, welcome-pulse 1.4s ease-in-out 400ms infinite' }}>
          <Orb state="breathing" size={64} label="Ask AI" />
          <span className="absolute whitespace-nowrap px-2.5 py-1 text-[11px] font-semibold text-white shadow-lg"
            style={{ background: color('orchestrator'), borderRadius: 999, ...(ask.top > 60 ? { top: -32 } : { bottom: -32 }), ...(ask.left > view.w / 2 ? { right: 0 } : { left: 0 }) }}>
            {phone ? 'Ask AI' : 'Ask AI · give the team a task'}
          </span>
        </div>
      )}

      {/* The agents at work. */}
      {!still && CAST.map((role, i) => (
        <div key={role} ref={el => { cursorEls.current[i] = el; }} className="fixed left-0 top-0 z-40 pointer-events-none will-change-transform" aria-hidden="true" style={{ transform: 'translate3d(-100px,-100px,0)' }}>
          <CursorGlyph color={color(role)} variant="solid" size={phone ? 19 : 22} />
          <span className={`agent-tag${phone ? ' small' : ''}`} style={{ left: 14, top: phone ? 15 : 17 }}>
            <span className="font-semibold">{AGENTS[role].name}</span>{labels[i] && <span className="opacity-80"> · {labels[i]}</span>}
          </span>
        </div>
      ))}
    </div>
  );
}
