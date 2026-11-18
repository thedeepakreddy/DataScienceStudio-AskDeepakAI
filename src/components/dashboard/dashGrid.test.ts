import { describe, expect, it } from 'vitest';
import { COLS, Cell, cleanUp, resizeFromBottomLeft, resolve } from './dashGrid';

const noOverlap = (cs: Cell[]) => cs.every((a, i) => cs.every((b, j) => i === j || !(a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h)));

describe('dashboard grid', () => {
  const base: Cell[] = [
    { id: 'kpi', x: 0, y: 0, w: 12, h: 3 },
    { id: 'a', x: 0, y: 3, w: 6, h: 7 },
    { id: 'b', x: 6, y: 3, w: 6, h: 7 },
    { id: 't', x: 0, y: 10, w: 12, h: 10 },
  ];
  it('growing a panel pushes the others out of the way, never overlapping', () => {
    const grown = resizeFromBottomLeft(base[2], -3, 4); // wider to the left, taller
    expect(grown).toMatchObject({ x: 3, w: 9, h: 11 });
    const out = resolve(base.map(c => (c.id === 'b' ? grown : c)), 'b');
    expect(noOverlap(out)).toBe(true);
    expect(out.find(c => c.id === 'b')).toMatchObject({ x: 3, y: 3, w: 9, h: 11 });
    expect(out.find(c => c.id === 'a')!.y).toBeGreaterThanOrEqual(14); // pushed below b
  });
  it('shrinking closes the gap: panels below move up', () => {
    const out = resolve(base.map(c => (c.id === 'a' ? { ...c, h: 3 } : c.id === 'b' ? { ...c, h: 3 } : c)));
    expect(out.find(c => c.id === 't')!.y).toBe(6);
  });
  it('clean up makes tidy full rows by kind, with no gaps', () => {
    const messy: Cell[] = [
      { id: 't', x: 2, y: 0, w: 8, h: 6 }, { id: 'a', x: 0, y: 9, w: 5, h: 7 },
      { id: 'kpi', x: 0, y: 20, w: 12, h: 3 }, { id: 'b', x: 7, y: 9, w: 4, h: 5 }, { id: 'c', x: 0, y: 30, w: 4, h: 7 },
    ];
    const kind = (id: string) => (id === 'kpi' ? 'kpi' : id === 't' ? 'table' : 'chart') as any;
    const out = cleanUp(messy, kind);
    expect(noOverlap(out)).toBe(true);
    const at = (id: string) => out.find(c => c.id === id)!;
    expect(at('kpi')).toMatchObject({ x: 0, y: 0, w: 12 });
    expect(at('a').y).toBe(3);
    expect(at('a').w + at('b').w).toBe(COLS); // a and b fill a row
    expect(at('a').h).toBe(at('b').h);
    expect(at('c')).toMatchObject({ x: 0, w: 4 }); // alone on its row: keeps its size
    expect(at('t').y).toBe(at('c').y + at('c').h);
  });
});
