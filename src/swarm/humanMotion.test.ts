import { describe, expect, it } from 'vitest';
import { HumanMover, humanDuration, humanPath } from './humanMotion';

const seeded = (seed = 3) => { let s = seed; return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 2 ** 32; }; };

describe('human cursor motion', () => {
  const from = { x: 0, y: 0 }, to = { x: 400, y: 0 };

  it('starts and ends exactly on its points', () => {
    const p = humanPath(from, to, {}, seeded());
    expect(p(0).x).toBeCloseTo(0, 0);
    expect(p(1)).toEqual(to);
  });

  it('curves instead of going straight', () => {
    const p = humanPath(from, to, { tremor: false }, seeded());
    expect(Math.abs(p(0.4).y)).toBeGreaterThan(15);
  });

  it('overshoots a long move a little, then settles', () => {
    const p = humanPath(from, to, { tremor: false, arc: 0.1 }, seeded());
    const xs = Array.from({ length: 101 }, (_, i) => p(i / 100).x);
    expect(Math.max(...xs)).toBeGreaterThan(400);
    expect(Math.max(...xs)).toBeLessThan(413);
  });

  it('is slow at the ends and fast in the middle', () => {
    const p = humanPath(from, to, { tremor: false, overshoot: false, arc: 0 }, seeded());
    const speed = (t: number) => Math.abs(p(t + 0.01).x - p(t).x);
    expect(speed(0.5)).toBeGreaterThan(speed(0.02) * 5);
    expect(speed(0.5)).toBeGreaterThan(speed(0.97) * 5);
  });

  it('takes longer for longer moves', () => {
    const r = () => 0.5;
    expect(humanDuration(800, r)).toBeGreaterThan(humanDuration(80, r));
    expect(humanDuration(5000, r)).toBeLessThanOrEqual(1150);
  });
});

describe('following a moving target', () => {
  it('ends exactly on where the target is now', async () => {
    const frames: Array<() => void> = [];
    const g = globalThis as unknown as { requestAnimationFrame: (f: (t: number) => void) => number; cancelAnimationFrame: (n: number) => void };
    const oldRaf = g.requestAnimationFrame, oldCancel = g.cancelAnimationFrame;
    let clock = 0;
    g.requestAnimationFrame = f => { frames.push(() => f(clock)); return frames.length; };
    g.cancelAnimationFrame = () => {};
    const realNow = performance.now.bind(performance);
    (performance as { now: () => number }).now = () => clock;
    try {
      const m = new HumanMover(null, { x: 0, y: 0 });
      let target = { x: 100, y: 100 };
      const done = m.moveTo({ x: 100, y: 100 }, { duration: 100, follow: () => target });
      for (let i = 0; i <= 12; i++) { clock = i * 10; if (i === 5) target = { x: 100, y: 260 }; frames.shift()?.(); }
      await done;
      expect(m.x).toBeCloseTo(100, 5);
      expect(m.y).toBeCloseTo(260, 5);
    } finally {
      g.requestAnimationFrame = oldRaf; g.cancelAnimationFrame = oldCancel;
      (performance as { now: () => number }).now = realNow;
    }
  });
});
