/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

// Cursor movement that looks like a person's hand, not a straight tween:
// - the path curves (a Bézier bent to one side, more early than late),
// - speed rises and falls smoothly (the minimum-jerk profile of human reaching),
// - long moves overshoot a little and settle back onto the target,
// - a faint tremor fades out as the pointer arrives,
// - time grows with distance the way it does for people (Fitts's law).

export interface Point { x: number; y: number }

export type Random = () => number;

/** Time a person takes to reach a target this far away. */
export function humanDuration(distance: number, rand: Random = Math.random) {
  const base = 240 + 120 * Math.log2(1 + distance / 28);
  return Math.round(Math.min(1150, Math.max(220, base)) * (0.9 + rand() * 0.2));
}

/** Smooth start and stop with the fastest part in the middle (minimum-jerk). */
const minimumJerk = (t: number) => t * t * t * (10 - 15 * t + 6 * t * t);
const easeOutCubic = (t: number) => 1 - (1 - t) ** 3;

function bezier(p0: Point, p1: Point, p2: Point, p3: Point, t: number): Point {
  const u = 1 - t;
  const a = u * u * u, b = 3 * u * u * t, c = 3 * u * t * t, d = t * t * t;
  return { x: a * p0.x + b * p1.x + c * p2.x + d * p3.x, y: a * p0.y + b * p1.y + c * p2.y + d * p3.y };
}

export interface PathOptions {
  /** How far the path bows, as a share of the distance (default 0.1–0.28). */
  arc?: number;
  /** Bow direction; random when not given. */
  side?: 1 | -1;
  /** Overshoot and settle on moves longer than ~120px (default true). */
  overshoot?: boolean;
  /** Faint tremor (default true). */
  tremor?: boolean;
}

/** A human-looking path from `from` to `to`, as position at time t (0–1). */
export function humanPath(from: Point, to: Point, opts: PathOptions = {}, rand: Random = Math.random): (t: number) => Point {
  const dx = to.x - from.x, dy = to.y - from.y;
  const dist = Math.hypot(dx, dy);
  if (dist < 0.5) return () => ({ ...to });
  const nx = -dy / dist, ny = dx / dist;
  const side = opts.side ?? (rand() < 0.5 ? -1 : 1);
  const bow = (opts.arc ?? 0.1 + rand() * 0.18) * dist * side;
  // Overshoot a little past the target on long moves, then settle back.
  const over = opts.overshoot !== false && dist > 120 ? Math.min(12, dist * (0.015 + rand() * 0.02)) : 0;
  const end = { x: to.x + (dx / dist) * over, y: to.y + (dy / dist) * over };
  const c1 = { x: from.x + dx * (0.25 + rand() * 0.1) + nx * bow, y: from.y + dy * (0.25 + rand() * 0.1) + ny * bow };
  const c2 = { x: from.x + dx * (0.72 + rand() * 0.08) + nx * bow * 0.35, y: from.y + dy * (0.72 + rand() * 0.08) + ny * bow * 0.35 };
  const phase = rand() * Math.PI * 2;
  const tremor = opts.tremor === false ? 0 : Math.min(0.9, dist / 300);
  const split = over ? 0.86 : 1;

  return (t: number) => {
    const tt = Math.min(1, Math.max(0, t));
    let p: Point;
    if (tt < split) {
      p = bezier(from, c1, c2, end, minimumJerk(tt / split));
    } else {
      const s = easeOutCubic((tt - split) / (1 - split));
      p = { x: end.x + (to.x - end.x) * s, y: end.y + (to.y - end.y) * s };
    }
    if (tt >= 1) return { ...to };
    // Tremor: none at the start (no jump) and gone by the arrival.
    const fade = Math.sin(Math.PI * tt) * (1 - tt * 0.5);
    return {
      x: p.x + Math.sin(tt * 23 + phase) * tremor * fade,
      y: p.y + Math.cos(tt * 19 + phase) * tremor * fade,
    };
  };
}

export interface MoveOptions extends PathOptions {
  duration?: number;
  /** Longest a move may take (keeps the pointer ahead of the action it shows). */
  maxDuration?: number;
  delay?: number;
  onFrame?: (p: Point, t: number) => void;
  /**
   * Where the target is now, if it can move while the pointer travels (a page
   * still scrolling). The path bends smoothly toward it and ends exactly on it.
   */
  follow?: () => Point | null;
}

/** Moves one element along human-looking paths; a new move starts from wherever it is. */
export class HumanMover {
  x: number;
  y: number;
  private el: HTMLElement | null;
  private frame = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private done: (() => void) | null = null;

  constructor(el: HTMLElement | null, start: Point) {
    this.el = el;
    this.x = start.x;
    this.y = start.y;
    this.apply();
  }

  attach(el: HTMLElement | null) { this.el = el; this.apply(); }

  private apply() {
    if (this.el) this.el.style.transform = `translate3d(${this.x}px, ${this.y}px, 0)`;
  }

  /** Stops the current move where it is. */
  stop() {
    cancelAnimationFrame(this.frame);
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.done?.();
    this.done = null;
  }

  jump(p: Point) { this.stop(); this.x = p.x; this.y = p.y; this.apply(); }

  moveTo(to: Point, opts: MoveOptions = {}): Promise<void> {
    this.stop();
    return new Promise(resolve => {
      this.done = resolve;
      const start = () => {
        this.timer = null;
        const from = { x: this.x, y: this.y };
        const dist = Math.hypot(to.x - from.x, to.y - from.y);
        const duration = Math.min(opts.maxDuration ?? Infinity, opts.duration ?? humanDuration(dist));
        const path = humanPath(from, to, opts);
        const t0 = performance.now();
        const step = (now: number) => {
          const t = duration > 0 ? Math.min(1, (now - t0) / duration) : 1;
          const p = path(t);
          const live = opts.follow?.();
          if (live) {
            const k = minimumJerk(t);
            p.x += (live.x - to.x) * k;
            p.y += (live.y - to.y) * k;
          }
          this.x = p.x;
          this.y = p.y;
          this.apply();
          opts.onFrame?.(p, t);
          if (t < 1) this.frame = requestAnimationFrame(step);
          else { const d = this.done; this.done = null; d?.(); }
        };
        this.frame = requestAnimationFrame(step);
      };
      if (opts.delay) this.timer = setTimeout(start, opts.delay);
      else start();
    });
  }
}
