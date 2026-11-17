import { describe, expect, it } from 'vitest';
import { humanDuration, humanPath } from './humanMotion';

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
