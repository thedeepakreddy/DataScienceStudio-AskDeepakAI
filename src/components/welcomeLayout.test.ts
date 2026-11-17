import { describe, expect, it } from 'vitest';
import { Box, scatterCards, seeded } from './welcomeLayout';

const overlap = (a: Box, b: Box) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;

describe('welcome card scatter', () => {
  const sizes = Array.from({ length: 9 }, () => ({ w: 272, h: 76 }));
  const area = { x: 28, y: 64, w: 1440 - 56, h: 900 - 92 };
  const title = { x: 330, y: 50, w: 780, h: 290 };
  const tip = { x: 420, y: 760, w: 600, h: 80 };
  const ask = { x: 1150, y: 640, w: 290, h: 150 };

  it('places every card on a desktop without touching the title, the closing words, Ask AI or each other', () => {
    for (const seed of [1, 7, 42, 2024, 99999]) {
      const out = scatterCards(sizes, area, [title, tip, ask], seeded(seed), 20);
      expect(out, `seed ${seed}`).not.toBeNull();
      const boxes = out!.map(p => ({ x: p.x, y: p.y, w: 272, h: 76 }));
      for (const b of boxes) {
        for (const r of [title, tip, ask]) expect(overlap(b, r)).toBe(false);
        expect(b.x).toBeGreaterThanOrEqual(area.x);
        expect(b.x + b.w).toBeLessThanOrEqual(area.x + area.w);
        expect(b.y + b.h).toBeLessThanOrEqual(area.y + area.h);
      }
      for (let i = 0; i < boxes.length; i++) for (let j = i + 1; j < boxes.length; j++) expect(overlap(boxes[i], boxes[j])).toBe(false);
      for (const p of out!) expect(Math.abs(p.rot)).toBeLessThanOrEqual(3.2);
    }
  });

  it('is different each opening but the same for the same seed', () => {
    const a = scatterCards(sizes, area, [title, tip, ask], seeded(1), 20)!;
    const b = scatterCards(sizes, area, [title, tip, ask], seeded(2), 20)!;
    const a2 = scatterCards(sizes, area, [title, tip, ask], seeded(1), 20)!;
    expect(a).toEqual(a2);
    expect(a).not.toEqual(b);
  });

  it('gives up (so the grid is used) when the cards can’t fit', () => {
    expect(scatterCards(sizes, { x: 0, y: 0, w: 600, h: 300 }, [], seeded(3), 20)).toBeNull();
  });
});
