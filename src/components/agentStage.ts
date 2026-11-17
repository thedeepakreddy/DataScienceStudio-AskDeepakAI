/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { AGENTS, AgentRole } from '../swarm/agents';
import { HumanMover } from '../swarm/humanMotion';
import { findTarget } from '../swarm/interaction';
import { cursorHtml, tagPlacement } from './AgentCursor';
import { Dust, dustPalette } from './dust';

// The agents' work drawn on the page, around the panels they use (cards and
// sections). AgentCursorLayer drives it from the interaction events.
// - When a task starts on a panel, a thin branch grows from the Orchestrator
//   node to that panel; the task's partner cursor darts to the panel's centre,
//   touches it, and explodes into fine dust. The dust races to the panel's
//   edges and becomes a soft moving glow (the Gemini-style outer glow).
// - The worker cursor (AgentCursorLayer) then does the work inside.
// - When the task moves on or finishes, the panel's glow and branch settle to
//   a steady violet. They stay, across steps and reloads, until the run is
//   cleared (Clear in the chat or the Agents panel).
// - Panels the agents never use get nothing.
// Glows are drawn over the page with the panel itself cut out of them, so
// they never tint a panel's contents, and they fade out to nothing. The dust
// is dust.ts, shared with the welcome.

type GlowState = 'live' | 'done';

interface Branch { g: SVGGElement; grad: SVGLinearGradientElement; stops: SVGStopElement[]; glow: SVGPathElement; core: SVGPathElement; end: SVGCircleElement; growing: boolean; d: string }
interface Glow {
  key: string;
  /** A data-agent id that finds the panel: its own, or a control inside it. */
  target: string;
  state: GlowState;
  el: HTMLDivElement;
  branch: Branch;
  panel: HTMLElement | null;
  shape: string;
  /** Opacity while the dust is still arriving (null once lit). */
  igniting: number | null;
}
interface Partner { id: string; agent: AgentRole; el: HTMLDivElement; tag: HTMLSpanElement; mover: HumanMover; flying: boolean; watching: string | null; leaving: ReturnType<typeof setTimeout> | null }

const STORE = 'dss.agentGlows.v1';
const PAD = 44;
const PANEL_SEL = '[data-agent^="area-"], [data-agent^="dash-chart-"], .card, [role="region"], section';
const NS = 'http://www.w3.org/2000/svg';
const reducedMotion = () => typeof window !== 'undefined' && !!window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
const wait = (ms: number) => new Promise<void>(r => setTimeout(r, ms));

/** The panel (card or section) a control sits in, if it is one worth lighting up. */
export function panelOf(el: HTMLElement | null): HTMLElement | null {
  if (!el || el.closest('[data-swarm-ui]')) return null;
  if ((el.getAttribute('data-agent') ?? '').startsWith('nav-')) return null;
  let p = el.closest(PANEL_SEL) as HTMLElement | null;
  if (!p || p.closest('[data-swarm-ui]')) return null;
  // A dashboard chart's wrapper holds its caption and the chart card: light the card.
  if (p.matches('[data-agent^="dash-chart-"]')) {
    const cards = p.querySelectorAll<HTMLElement>(':scope > .card, :scope > * > .card');
    if (cards.length === 1) p = cards[0];
  }
  const r = p.getBoundingClientRect();
  if (r.width < 48 || r.height < 32) return null;
  // A whole page section is not a panel.
  if (r.height > window.innerHeight * 1.4 || (r.width > window.innerWidth * 0.97 && r.height > window.innerHeight * 0.8)) return null;
  return p;
}

/**
 * The box a panel's glow goes round. A dashboard group (several cards in one
 * wrapper, like the KPI row) is the box round just its cards, not the row.
 */
export function rectOf(panel: HTMLElement): DOMRect {
  if (panel.matches('[data-agent^="dash-chart-"]')) {
    const cards = [...panel.querySelectorAll<HTMLElement>('.card')].map(c => c.getBoundingClientRect()).filter(r => r.width > 0);
    if (cards.length > 1) {
      const l = Math.min(...cards.map(r => r.left)), t = Math.min(...cards.map(r => r.top));
      const rr = Math.max(...cards.map(r => r.right)), b = Math.max(...cards.map(r => r.bottom));
      return new DOMRect(l, t, rr - l, b - t);
    }
  }
  const r = panel.getBoundingClientRect();
  // A plain section (no card background or border) gets a little room, so its glow doesn't hug the text.
  const cs = getComputedStyle(panel);
  const plain = (cs.backgroundColor === 'rgba(0, 0, 0, 0)' || cs.backgroundColor === 'transparent') && parseFloat(cs.borderTopWidth) === 0;
  return plain ? new DOMRect(r.left - 12, r.top - 10, r.width + 24, r.height + 20) : r;
}

/** The corner radius of a panel (or of the cards in a group). */
function radiusOf(panel: HTMLElement) {
  const el = panel.matches('[data-agent^="dash-chart-"]') ? panel.querySelector<HTMLElement>('.card') ?? panel : panel;
  return parseFloat(getComputedStyle(el).borderTopLeftRadius) || 18;
}

function roundedRect(x: number, y: number, w: number, h: number, r: number) {
  r = Math.max(0, Math.min(r, w / 2, h / 2));
  return `M${x + r} ${y}H${x + w - r}A${r} ${r} 0 0 1 ${x + w} ${y + r}V${y + h - r}A${r} ${r} 0 0 1 ${x + w - r} ${y + h}H${x + r}A${r} ${r} 0 0 1 ${x} ${y + h - r}V${y + r}A${r} ${r} 0 0 1 ${x + r} ${y}Z`;
}

export class AgentStage {
  private host: HTMLElement;
  private canvas: HTMLCanvasElement;
  private dust: Dust;
  private svg: SVGSVGElement;
  private rootEl: HTMLDivElement;
  private glowLayer: HTMLDivElement;
  private glows = new Map<string, Glow>();
  private partners = new Map<string, Partner>();
  /** The panel each running task is working in. */
  private taskPanel = new Map<string, string>();
  private raf = 0;
  private last = 0;
  private w = 0;
  private h = 0;
  private alive = true;

  constructor(host: HTMLElement) {
    this.host = host;
    this.glowLayer = document.createElement('div');
    this.glowLayer.className = 'absolute inset-0';
    this.svg = document.createElementNS(NS, 'svg');
    this.svg.setAttribute('class', 'agent-tree');
    this.rootEl = document.createElement('div');
    this.rootEl.className = 'agent-root';
    this.rootEl.innerHTML = '<i></i>Orchestrator';
    this.canvas = document.createElement('canvas');
    this.canvas.className = 'absolute inset-0 w-full h-full';
    host.append(this.glowLayer, this.svg, this.rootEl, this.canvas);
    this.dust = new Dust(this.canvas);
    this.resize();
    window.addEventListener('resize', this.resize);
    this.restore();
    this.raf = requestAnimationFrame(this.frame);
  }

  destroy() {
    this.alive = false;
    cancelAnimationFrame(this.raf);
    window.removeEventListener('resize', this.resize);
    this.partners.forEach(p => p.mover.stop());
    this.host.replaceChildren();
  }

  private resize = () => {
    this.w = window.innerWidth; this.h = window.innerHeight;
    this.dust.resize(this.w, this.h);
  };

  // ---- What the cursor layer calls ----

  /**
   * The task reached a control. If that control's panel is new to the task,
   * the panel lights up; the returned promise resolves once the dust has
   * reached its edges (the worker goes in then). Otherwise returns null.
   */
  reach(pointerId: string, agent: AgentRole, target: string): Promise<void> | null {
    const panel = panelOf(findTarget(target));
    if (!panel) return null;
    let glow = this.glowFor(panel);
    const current = this.taskPanel.get(pointerId);
    if (glow && current === glow.key) return null;
    if (current && current !== glow?.key) this.settle(current, pointerId);
    if (glow) {
      // A panel worked on before: it lights up again without another explosion.
      this.setState(glow, 'live');
      this.taskPanel.set(pointerId, glow.key);
      this.watch(this.partner(pointerId, agent), glow.key);
      return null;
    }
    const own = panel.getAttribute('data-agent');
    glow = this.createGlow(own ?? target, own ?? target, 'live');
    glow.panel = panel;
    this.taskPanel.set(pointerId, glow.key);
    return this.ignite(pointerId, agent, glow, panel);
  }

  /** The task finished: its panel settles and both of its cursors leave. */
  finish(pointerId: string) {
    const key = this.taskPanel.get(pointerId);
    if (key) this.settle(key, pointerId);
    this.taskPanel.delete(pointerId);
    const p = this.partners.get(pointerId);
    if (p && !p.leaving) {
      p.leaving = setTimeout(() => {
        p.el.style.opacity = '0';
        setTimeout(() => { p.mover.stop(); p.el.remove(); this.partners.delete(pointerId); }, 300);
      }, 1100);
    }
  }

  /** Clear: every glow, branch and partner fades away. */
  clear() {
    this.taskPanel.clear();
    this.glows.forEach(g => {
      g.el.style.opacity = '0'; g.branch.g.style.opacity = '0';
      setTimeout(() => { g.el.remove(); g.branch.g.remove(); }, 700);
    });
    this.glows.clear();
    this.partners.forEach(p => { p.el.style.opacity = '0'; setTimeout(() => p.el.remove(), 300); p.mover.stop(); });
    this.partners.clear();
    this.dust.clear();
    this.save();
  }

  // ---- Glows ----

  private glowFor(panel: HTMLElement) {
    for (const g of this.glows.values()) if (this.panelEl(g) === panel) return g;
    return undefined;
  }

  private panelEl(g: Glow): HTMLElement | null {
    if (g.panel && g.panel.isConnected) return g.panel;
    g.panel = panelOf(findTarget(g.target));
    return g.panel;
  }

  private createGlow(key: string, target: string, state: GlowState): Glow {
    const el = document.createElement('div');
    el.className = 'agent-glow';
    el.dataset.state = state;
    el.innerHTML = '<span class="bloom"></span><span class="halo"></span><span class="ring"></span>';
    el.style.setProperty('--p', `${PAD}px`);
    this.glowLayer.appendChild(el);
    const g: Glow = { key, target, state, el, branch: this.createBranch(), panel: null, shape: '', igniting: null };
    this.glows.set(key, g);
    this.setState(g, state);
    this.save();
    return g;
  }

  private setState(g: Glow, state: GlowState) {
    g.state = state;
    g.el.dataset.state = state;
    const color = state === 'live' ? null : 'var(--ag-done)';
    g.branch.stops.forEach((st, i) => { st.style.stopColor = color ?? `var(--ag-g${i + 1})`; });
    g.branch.end.style.fill = color ?? 'var(--ag-g3)';
    this.save();
  }

  /** A panel the agents have finished with keeps a steady glow. */
  private settle(key: string, by: string) {
    const g = this.glows.get(key);
    if (!g || g.state === 'done') return;
    // Still in use by another running task?
    for (const [id, k] of this.taskPanel) if (k === key && id !== by) return;
    this.setState(g, 'done');
  }

  private createBranch(): Branch {
    const id = `ag-br-${Math.random().toString(36).slice(2, 9)}`;
    const g = document.createElementNS(NS, 'g');
    g.innerHTML = `<defs><linearGradient id="${id}" gradientUnits="userSpaceOnUse"><stop offset="0"/><stop offset="0.5"/><stop offset="1"/></linearGradient></defs>`
      + `<path class="b-glow" stroke="url(#${id})"/><path class="b-core" stroke="url(#${id})"/><circle r="2.2" style="opacity:0"/>`;
    this.svg.appendChild(g);
    return {
      g, grad: g.querySelector('linearGradient')!, stops: [...g.querySelectorAll('stop')],
      glow: g.querySelector('.b-glow')!, core: g.querySelector('.b-core')!, end: g.querySelector('circle')!, growing: false, d: '',
    };
  }

  /**
   * Where the Orchestrator node sits: in the sticky step bar's free space,
   * just right of the step tabs, so it never covers the page. On narrow
   * screens (the tabs fill the bar) it sits at the right, just under the bar.
   * `x, y` is the node's centre.
   */
  private rootPoint() {
    const bar = findTarget('nav-ingest')?.closest('.sticky') as HTMLElement | null;
    const nav = findTarget('nav-ingest')?.closest('nav') as HTMLElement | null;
    const b = bar?.getBoundingClientRect();
    const barBottom = b ? b.bottom : 56;
    const half = (this.rootEl.offsetWidth || 104) / 2;
    const n = nav?.getBoundingClientRect();
    if (b && n && n.right + 18 + half * 2 < b.right - 8) return { x: n.right + 18 + half, y: b.top + b.height / 2, barBottom };
    return { x: this.w - 16 - half, y: barBottom + 18, barBottom };
  }

  // ---- The partner cursor ----

  private partner(pointerId: string, agent: AgentRole): Partner {
    const have = this.partners.get(pointerId);
    if (have) { if (have.leaving) { clearTimeout(have.leaving); have.leaving = null; have.el.style.opacity = '1'; } return have; }
    const el = document.createElement('div');
    el.className = 'absolute left-0 top-0 will-change-transform';
    el.style.transition = 'opacity 200ms ease';
    el.innerHTML = cursorHtml(AGENTS[agent].color, 'soft', 20);
    const tag = document.createElement('span');
    tag.className = 'agent-tag small';
    el.appendChild(tag);
    this.host.insertBefore(el, this.canvas);
    const root = this.rootPoint();
    const p: Partner = { id: pointerId, agent, el, tag, mover: new HumanMover(el, { x: root.x, y: root.y + 18 }), flying: false, watching: null, leaving: null };
    this.partners.set(pointerId, p);
    this.say(p, 'partner');
    return p;
  }

  private say(p: Partner, detail: string) {
    p.tag.textContent = '';
    const name = document.createElement('span'); name.className = 'font-semibold'; name.textContent = AGENTS[p.agent].name;
    const d = document.createElement('span'); d.className = 'detail'; d.textContent = ` · ${detail}`;
    p.tag.append(name, d);
    const place = tagPlacement(p.mover.x);
    p.tag.style.left = place.flip ? '' : '14px';
    p.tag.style.right = place.flip ? 'calc(100% - 4px)' : '';
    p.tag.style.maxWidth = `${place.maxWidth}px`;
  }

  private watch(p: Partner, key: string) { p.watching = key; this.say(p, 'watching'); }

  /** Light a panel: branch, partner dart, touch, dust explosion, glow. */
  private async ignite(pointerId: string, agent: AgentRole, glow: Glow, panel: HTMLElement) {
    const p = this.partner(pointerId, agent);
    p.watching = null;
    const centre = () => { const r = rectOf(panel); return { x: r.left + r.width / 2 - 3, y: r.top + r.height / 2 - 3 }; };
    this.growBranch(glow);
    if (reducedMotion()) {
      p.mover.jump(centre());
      glow.el.style.opacity = '1';
      this.watch(p, glow.key);
      return;
    }
    glow.igniting = 0;
    this.say(p, 'touching');
    p.flying = true;
    // The partner darts (about twice the worker's speed), following the panel if the page is still scrolling.
    await p.mover.moveTo(centre(), { maxDuration: 320, follow: centre });
    if (!this.alive) return;
    p.el.classList.add('is-touching', 'is-pressing');
    await wait(150);
    p.el.classList.remove('is-pressing');
    await wait(120);
    p.el.style.opacity = '0';
    const burst = this.dust.burst(rectOf(panel), p.mover.x + 2, p.mover.y + 2, dustPalette(AGENTS[agent].color), share => { glow.igniting = share; })
      .then(() => { glow.igniting = null; });
    await wait(650);
    p.el.classList.remove('is-touching');
    // It re-forms from the dust beside the panel and watches.
    const r = rectOf(panel);
    const spot = { x: Math.min(this.w - 40, r.right - 18), y: Math.min(this.h - 30, r.bottom + 12) };
    p.mover.jump(spot);
    this.dust.gather(spot, dustPalette(AGENTS[agent].color));
    setTimeout(() => { p.el.style.opacity = '1'; p.flying = false; this.watch(p, glow.key); }, 300);
    await burst;
  }

  // ---- The tree ----

  private growBranch(glow: Glow) {
    const b = glow.branch;
    this.placeBranch(glow);
    if (reducedMotion() || !b.d) { b.end.style.opacity = '1'; return; }
    const len = b.core.getTotalLength();
    b.growing = true;
    [b.core, b.glow].forEach(el => { el.style.transition = 'none'; el.style.strokeDasharray = `${len}`; el.style.strokeDashoffset = `${len}`; });
    void b.core.getBoundingClientRect();
    [b.core, b.glow].forEach(el => { el.style.transition = 'stroke-dashoffset 480ms cubic-bezier(.22,.61,.36,1)'; el.style.strokeDashoffset = '0'; });
    setTimeout(() => {
      [b.core, b.glow].forEach(el => { el.style.transition = ''; el.style.strokeDasharray = ''; el.style.strokeDashoffset = ''; });
      b.growing = false; b.end.style.opacity = '1';
    }, 500);
  }

  private placeBranch(glow: Glow) {
    const b = glow.branch;
    const panel = this.panelEl(glow);
    const r = panel ? rectOf(panel) : null;
    if (!r || !r.width) { b.g.style.display = 'none'; return; }
    b.g.style.display = '';
    const root = this.rootPoint();
    const x0 = root.x, y0 = root.y + 12;
    let x1: number, y1: number, d: string;
    const f = (n: number) => n.toFixed(1);
    if (r.top >= y0 || r.bottom <= y0) {
      // Into the panel's near edge (top, or bottom when it is above).
      x1 = r.left + r.width / 2; y1 = r.top >= y0 ? r.top : r.bottom;
      const dy = y1 - y0;
      d = `M${f(x0)},${f(y0)} C${f(x0)},${f(y0 + dy * 0.6)} ${f(x1)},${f(y1 - dy * 0.6)} ${f(x1)},${f(y1)}`;
    } else {
      // The panel runs past the node (scrolled, or very tall): into its nearer side, never across it.
      const right = Math.abs(r.right - x0) <= Math.abs(r.left - x0);
      x1 = right ? r.right : r.left;
      y1 = Math.min(r.bottom - 18, Math.max(r.top + 18, y0 + 48));
      const out = right ? 36 : -36;
      d = `M${f(x0)},${f(y0)} C${f(x0)},${f(y0 + (y1 - y0) * 0.8)} ${f(x1 + out)},${f(y1)} ${f(x1)},${f(y1)}`;
    }
    if (d === b.d) return;
    b.d = d;
    b.core.setAttribute('d', d); b.glow.setAttribute('d', d);
    b.grad.setAttribute('x1', `${x0}`); b.grad.setAttribute('y1', `${y0}`); b.grad.setAttribute('x2', `${x1}`); b.grad.setAttribute('y2', `${y1}`);
    b.end.setAttribute('cx', `${x1}`); b.end.setAttribute('cy', `${y1}`);
  }

  // ---- Every frame: keep glows, branches and partners on their panels ----

  private frame = (now: number) => {
    if (!this.alive) return;
    const dt = Math.min(48, now - (this.last || now));
    this.last = now;
    const root = this.rootPoint();
    // Glows and dust never spill over the sticky step bar (the tree starts in it).
    const clip = `inset(${Math.max(0, root.barBottom)}px 0 0 0)`;
    this.glowLayer.style.clipPath = clip; this.canvas.style.clipPath = clip;
    let visible = 0;
    for (const g of this.glows.values()) {
      const panel = this.panelEl(g);
      const r = panel ? rectOf(panel) : null;
      if (!r || !r.width || r.bottom < root.barBottom - 40 || r.top > this.h + 40) {
        g.el.style.display = 'none';
        if (!r || !r.width) { this.placeBranch(g); continue; }
      } else {
        g.el.style.display = '';
        visible++;
      }
      const radius = panel ? radiusOf(panel) : 12;
      const W = Math.round(r.width) + PAD * 2, H = Math.round(r.height) + PAD * 2;
      const shape = `${W}x${H}x${radius}`;
      if (shape !== g.shape) {
        g.shape = shape;
        g.el.style.width = `${W}px`; g.el.style.height = `${H}px`;
        g.el.style.setProperty('--r', `${radius}px`);
        // Cut the panel itself out of its glow, so the glow never tints its contents.
        const svg = `<svg xmlns='${NS}' width='${W}' height='${H}'><path fill-rule='evenodd' d='M0 0H${W}V${H}H0Z ${roundedRect(PAD, PAD, Math.round(r.width), Math.round(r.height), radius)}'/></svg>`;
        const url = `url("data:image/svg+xml,${encodeURIComponent(svg)}")`;
        g.el.style.maskImage = url;
        g.el.style.setProperty('-webkit-mask-image', url);
      }
      g.el.style.transform = `translate3d(${(r.left - PAD).toFixed(1)}px, ${(r.top - PAD).toFixed(1)}px, 0)`;
      g.el.style.transition = g.igniting !== null ? 'opacity 120ms linear' : '';
      g.el.style.opacity = g.igniting !== null ? `${g.igniting}` : '1';
      if (!g.branch.growing) this.placeBranch(g);
    }
    this.rootEl.style.transform = `translate3d(calc(${root.x}px - 50%), calc(${root.y}px - 50%), 0)`;
    this.rootEl.style.opacity = visible ? '1' : '0';
    this.svg.style.opacity = visible ? '1' : '0';
    for (const p of this.partners.values()) {
      if (p.flying || !p.watching) continue;
      const panel = this.glows.get(p.watching) && this.panelEl(this.glows.get(p.watching)!);
      const r = panel ? rectOf(panel) : null;
      if (!r || !r.width) continue;
      const spot = { x: Math.min(this.w - 40, r.right - 18), y: Math.min(this.h - 30, r.bottom + 12) };
      if (Math.abs(spot.x - p.mover.x) > 0.5 || Math.abs(spot.y - p.mover.y) > 0.5) p.mover.jump(spot);
    }
    this.dust.draw(dt);
    this.raf = requestAnimationFrame(this.frame);
  };

  // ---- Kept until Clear, across steps and reloads ----

  private save() {
    try {
      const list = [...this.glows.values()].map(g => ({ key: g.key, target: g.target }));
      if (list.length) localStorage.setItem(STORE, JSON.stringify(list)); else localStorage.removeItem(STORE);
    } catch { /* storage unavailable: glows last for this visit */ }
  }

  private restore() {
    try {
      const list = JSON.parse(localStorage.getItem(STORE) ?? '[]') as { key: string; target: string }[];
      // Nothing is running after a reload, so every panel is finished.
      for (const { key, target } of list) if (key && target && !this.glows.has(key)) {
        const g = this.createGlow(key, target, 'done');
        g.branch.end.style.opacity = '1';
      }
    } catch { /* ignore a damaged entry */ }
  }
}
