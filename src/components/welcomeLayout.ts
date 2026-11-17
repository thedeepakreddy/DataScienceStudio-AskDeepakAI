/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

// Where the welcome's cards go: scattered, never overlapping (tested).

/** A small seeded generator, so one opening's layout is stable while it plays. */
export function seeded(seed: number) {
  let s = seed >>> 0 || 1;
  return () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 2 ** 32; };
}

export interface Box { x: number; y: number; w: number; h: number }
const overlaps = (a: Box, b: Box, pad: number) =>
  a.x < b.x + b.w + pad && b.x < a.x + a.w + pad && a.y < b.y + b.h + pad && b.y < a.y + a.h + pad;

/**
 * Scatters cards over an area without touching each other or the reserved
 * boxes. Best-candidate sampling: of the places a card fits, it takes the one
 * furthest from the cards already placed, so the result looks random but
 * evenly spread. Returns null when the cards don't fit (the caller falls back
 * to a grid).
 */
export function scatterCards(sizes: { w: number; h: number }[], area: Box, reserved: Box[], rand: () => number, pad = 18): { x: number; y: number; rot: number }[] | null {
  const placed: Box[] = [];
  for (const { w, h } of sizes) {
    let best: Box | null = null;
    let bestScore = -1;
    let valid = 0;
    for (let attempt = 0; attempt < 400 && valid < 24; attempt++) {
      const c = { x: area.x + rand() * Math.max(0, area.w - w), y: area.y + rand() * Math.max(0, area.h - h), w, h };
      if (c.x + w > area.x + area.w || c.y + h > area.y + area.h) continue;
      if (reserved.some(r => overlaps(c, r, pad)) || placed.some(p => overlaps(c, p, pad))) continue;
      valid++;
      const cx = c.x + w / 2, cy = c.y + h / 2;
      const score = placed.length
        ? Math.min(...placed.map(p => Math.hypot(cx - (p.x + p.w / 2), (cy - (p.y + p.h / 2)) * 1.4)))
        : rand();
      if (score > bestScore) { bestScore = score; best = c; }
    }
    if (!best) return null;
    placed.push(best);
  }
  return placed.map(p => ({ x: p.x, y: p.y, rot: (rand() * 2 - 1) * 3.2 }));
}

