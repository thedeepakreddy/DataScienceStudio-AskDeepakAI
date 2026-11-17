/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

// Fine glittering dust on a canvas, shared by the page (agentStage.ts) and
// the welcome. A touch explodes like a star: a soft flash, then a dense shell
// of tiny specks racing out in every direction to the edges of a box (that is
// where the glow takes over) while slower dust drifts and twinkles away. The
// same dust gathers back into a cursor when it re-forms.

export interface Point { x: number; y: number }
export interface Rect { left: number; top: number; right: number; bottom: number; width: number; height: number }
/** Picks a colour for the next speck. */
export type Pick = () => string;

interface Speck {
  k: 'flash' | 'star' | 'to';
  x: number; y: number; t: number; dur: number; c: string; s: number;
  ux?: number; uy?: number; dist?: number; shell?: boolean; life?: number; ph?: number;
  x1?: number; y1?: number; rad?: number; arrive?: (() => void) | null;
}

const rand = (a: number, b: number) => a + Math.random() * (b - a);
const easeOut = (t: number) => 1 - Math.pow(1 - t, 3);
const easeMJ = (t: number) => t * t * t * (10 - 15 * t + 6 * t * t);

/** A CSS colour (including var(--x)) as a value the canvas can use. */
export function resolveColor(c: string, fallback = '#8e78c9') {
  const m = /^var\((--[\w-]+)\)$/.exec(c.trim());
  return m ? getComputedStyle(document.documentElement).getPropertyValue(m[1]).trim() || fallback : c;
}

/** The glow colours, mostly, with the agent's own colour mixed in. */
export function dustPalette(agentColor: string): Pick {
  const cs = getComputedStyle(document.documentElement);
  const g = ['--ag-g1', '--ag-g2', '--ag-g3'].map(v => cs.getPropertyValue(v).trim() || '#8e78c9');
  const a = resolveColor(agentColor);
  return () => (Math.random() < 0.18 ? a : g[(Math.random() * 3) | 0]);
}

export class Dust {
  private ctx: CanvasRenderingContext2D;
  private specks: Speck[] = [];
  private w = 0;
  private h = 0;

  constructor(private canvas: HTMLCanvasElement) {
    this.ctx = canvas.getContext('2d')!;
  }

  get busy() { return this.specks.length > 0; }

  resize(w: number, h: number) {
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    this.w = w; this.h = h;
    this.canvas.width = Math.round(w * dpr); this.canvas.height = Math.round(h * dpr);
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  clear() { this.specks = []; this.ctx.clearRect(0, 0, this.w, this.h); }

  /**
   * Explodes at (px, py) across `r`. `onLit` reports how much of the shell has
   * reached the edges (0–1); the promise resolves when it all has.
   */
  burst(r: Rect, px: number, py: number, pick: Pick, onLit?: (share: number) => void, scale = 1): Promise<void> {
    const reach = (dx: number, dy: number) => {
      const tx = dx > 0 ? (r.right - 1 - px) / dx : dx < 0 ? (r.left + 1 - px) / dx : Infinity;
      const ty = dy > 0 ? (r.bottom - 1 - py) / dy : dy < 0 ? (r.top + 1 - py) / dy : Infinity;
      return Math.max(0, Math.min(tx, ty));
    };
    const SHELL = Math.round(Math.max(500, Math.min(2600, (r.width + r.height) * 3)) * scale);
    const DUST = Math.round(Math.max(500, Math.min(3000, (r.width * r.height) / 40)) * scale);
    // A small, soft violet flash where it was touched.
    this.specks.push({ k: 'flash', x: px, y: py, t: 0, dur: 480, c: resolveColor('var(--ag-g2)'), s: 0, rad: Math.min(150, Math.max(r.width, r.height) * 0.3) });
    let arrived = 0;
    return new Promise(resolve => {
      let settled = false;
      const done = () => { if (!settled) { settled = true; onLit?.(1); resolve(); } };
      for (let i = 0; i < SHELL; i++) {
        const a = Math.random() * Math.PI * 2, ux = Math.cos(a), uy = Math.sin(a), dist = reach(ux, uy);
        const dur = Math.min(1100, Math.max(320, dist / 0.42)) * rand(0.85, 1.15);
        this.specks.push({ k: 'star', x: px, y: py, ux, uy, dist, t: 0, dur, c: pick(), s: Math.random() < 0.06 ? rand(0.7, 0.95) : rand(0.22, 0.55), ph: rand(0, 6.28), shell: true,
          arrive: () => { arrived++; onLit?.(Math.min(1, (arrived / SHELL) * 1.3)); if (arrived === SHELL) done(); } });
      }
      for (let i = 0; i < DUST; i++) {
        const a = Math.random() * Math.PI * 2, ux = Math.cos(a), uy = Math.sin(a);
        const dist = reach(ux, uy) * Math.pow(Math.random(), 0.7) * 0.96;
        this.specks.push({ k: 'star', x: px, y: py, ux, uy, dist, t: 0, dur: rand(900, 1900), life: rand(1400, 2400), c: pick(), s: Math.random() < 0.05 ? rand(0.6, 0.85) : rand(0.18, 0.45), ph: rand(0, 6.28), shell: false });
      }
      // Never leave anything half-lit (a hidden tab, a slow frame).
      setTimeout(done, 1600);
    });
  }

  /** Dust gathering into a cursor (its tip at `at`) as it re-forms. */
  gather(at: Point, pick: Pick, count = 260) {
    for (let i = 0; i < count; i++) {
      const a = Math.random() * Math.PI * 2, rr = rand(18, 70);
      this.specks.push({ k: 'to', x: at.x + 6 + Math.cos(a) * rr, y: at.y + 9 + Math.sin(a) * rr, x1: at.x + 6, y1: at.y + 9, t: 0, dur: rand(240, 420), c: pick(), s: rand(0.2, 0.6) });
    }
  }

  private speck(x: number, y: number, s: number, c: string, alpha: number, dark: boolean) {
    if (alpha <= 0.01) return;
    const ctx = this.ctx;
    ctx.globalAlpha = alpha; ctx.fillStyle = c;
    ctx.fillRect(x - s, y - s, s * 2, s * 2);
    if (dark && s > 0.6) { ctx.globalAlpha = alpha * 0.35; ctx.fillStyle = '#fff'; ctx.fillRect(x - s * 0.35, y - s * 0.35, s * 0.7, s * 0.7); }
  }

  /** Advances and draws one frame (`dt` in ms). */
  draw(dt: number) {
    const ctx = this.ctx;
    ctx.clearRect(0, 0, this.w, this.h);
    if (!this.specks.length) return;
    const dark = document.documentElement.dataset.theme === 'dark';
    const keep: Speck[] = [];
    for (const p of this.specks) {
      p.t += dt;
      if (p.k === 'flash') {
        const f = p.t / p.dur; if (f >= 1) continue;
        const rad = p.rad! * (0.25 + 0.75 * easeOut(f));
        const g = ctx.createRadialGradient(p.x, p.y, 0, p.x, p.y, rad);
        g.addColorStop(0, dark ? 'rgba(255,255,255,0.55)' : 'rgba(255,255,255,1)');
        g.addColorStop(0.25, p.c); g.addColorStop(1, /^#[0-9a-f]{6}$/i.test(p.c) ? `${p.c}00` : 'rgba(255,255,255,0)');
        ctx.globalAlpha = (1 - f) * (dark ? 0.4 : 0.55); ctx.fillStyle = g;
        ctx.beginPath(); ctx.arc(p.x, p.y, rad, 0, 6.283); ctx.fill();
      } else if (p.k === 'star') {
        const f = Math.min(1, p.t / p.dur);
        const e = p.shell ? 1 - Math.pow(1 - f, 1.6) : 1 - Math.pow(1 - f, 3);
        const x = p.x + p.ux! * p.dist! * e, y = p.y + p.uy! * p.dist! * e;
        const tw = 0.6 + 0.4 * Math.sin(p.t * 0.045 + p.ph!);
        let a: number;
        if (p.shell) {
          if (f >= 1 && p.arrive) { p.arrive(); p.arrive = null; }
          a = f < 1 ? 1 : 1 - (p.t - p.dur) / 240;
          if (a <= 0) continue;
        } else {
          if (p.t >= p.life!) continue;
          a = 1 - Math.max(0, (p.t - p.life! * 0.45) / (p.life! * 0.55));
        }
        this.speck(x, y, p.s, p.c, a * tw, dark);
      } else {
        const f = Math.min(1, p.t / p.dur); if (f >= 1) continue;
        const e = easeMJ(f);
        this.speck(p.x + (p.x1! - p.x) * e, p.y + (p.y1! - p.y) * e, p.s, p.c, 0.35 + 0.65 * e, dark);
      }
      keep.push(p);
    }
    ctx.globalAlpha = 1;
    this.specks = keep;
  }
}
