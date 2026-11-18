/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

// The dashboard's grid: panels sit on a 12-column grid at x, y with a width and
// height in cells. Moving or resizing one panel keeps it where you put it and
// slides the others out of its way and up into any gap ("resolve"). "Clean up"
// lines everything into tidy full rows by kind, like tidying icons on a desktop.

export const COLS = 12;
export const ROW_PX = 28;
export const GAP_PX = 20;

export interface Cell { id: string; x: number; y: number; w: number; h: number }
export type Kind = 'kpi' | 'chart' | 'wide' | 'table';

export const MIN = { w: 3, h: 3 };
export const MAX_H = 30;

/** Default size for a kind of panel; `perRow` is how many charts sit side by side. */
export function defaultSize(kind: Kind, perRow = 2): { w: number; h: number } {
  switch (kind) {
    case 'kpi': return { w: COLS, h: 3 };
    case 'wide': return { w: COLS, h: 9 };
    case 'table': return { w: COLS, h: 10 };
    default: return { w: Math.max(MIN.w, Math.floor(COLS / Math.max(1, perRow))), h: 7 };
  }
}

const overlaps = (a: Cell, b: Cell) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;

export const clampCell = (c: Cell): Cell => {
  const w = Math.max(MIN.w, Math.min(COLS, Math.round(c.w)));
  const h = Math.max(MIN.h, Math.min(MAX_H, Math.round(c.h)));
  return { ...c, w, h, x: Math.max(0, Math.min(COLS - w, Math.round(c.x))), y: Math.max(0, Math.round(c.y)) };
};

/**
 * Keeps `fixedId` (the panel being moved or resized) exactly where it is, then
 * places every other panel, top to bottom, at its column and as high as it fits
 * without overlapping: panels in the way are pushed down, and gaps close up.
 */
export function resolve(cells: Cell[], fixedId?: string): Cell[] {
  const all = cells.map(clampCell);
  const fixed = all.find(c => c.id === fixedId);
  const placed: Cell[] = fixed ? [fixed] : [];
  const rest = all.filter(c => c !== fixed).sort((a, b) => a.y - b.y || a.x - b.x);
  for (const c of rest) {
    let y = 0;
    const cand = { ...c, y };
    while (placed.some(p => overlaps(p, cand))) cand.y = ++y;
    placed.push(cand);
  }
  // Same order as given, so React keys stay stable.
  const byId = new Map(placed.map(p => [p.id, p]));
  return cells.map(c => byId.get(c.id)!);
}

/** New panels go below everything, in order, side by side where they fit. */
export function appendCells(cells: Cell[], add: { id: string; w: number; h: number }[]): Cell[] {
  let out = [...cells];
  for (const a of add) {
    const bottom = out.reduce((m, c) => Math.max(m, c.y + c.h), 0);
    // Next to the last panel when it fits, else on a new row.
    const last = out[out.length - 1];
    const x = last && last.x + last.w + a.w <= COLS && last.y + last.h >= bottom - 0 ? last.x + last.w : 0;
    const y = x > 0 && last ? last.y : bottom;
    out = resolve([...out, { ...a, x, y }], a.id);
  }
  return resolve(out);
}

/**
 * Clean up: KPIs first, then charts, then wide panels and tables (keeping their
 * order within each kind), packed into rows that fill the full width (a panel
 * alone on its row keeps its size), each row
 * as tall as its tallest panel. No gaps, no overlaps.
 */
export function cleanUp(cells: Cell[], kindOf: (id: string) => Kind): Cell[] {
  const rank: Record<Kind, number> = { kpi: 0, chart: 1, wide: 2, table: 3 };
  const ordered = [...cells].sort((a, b) => rank[kindOf(a.id)] - rank[kindOf(b.id)] || a.y - b.y || a.x - b.x);
  const rows: Cell[][] = [];
  for (const c of ordered.map(clampCell)) {
    const row = rows[rows.length - 1];
    const used = row ? row.reduce((s, r) => s + r.w, 0) : COLS;
    const sameKind = row && kindOf(row[0].id) === kindOf(c.id);
    if (row && sameKind && used + c.w <= COLS) row.push(c);
    else rows.push([c]);
  }
  const out: Cell[] = [];
  let y = 0;
  for (const row of rows) {
    // Stretch the row to the full width, sharing the spare columns fairly.
    const used = row.reduce((s, r) => s + r.w, 0);
    // A panel alone on its row keeps its size; a shared row is stretched to the full width.
    let spare = row.length > 1 ? COLS - used : 0;
    const widths = row.map(r => r.w);
    for (let i = 0; spare > 0; i = (i + 1) % row.length, spare--) widths[i]++;
    const h = Math.max(...row.map(r => r.h));
    let x = 0;
    row.forEach((r, i) => { out.push({ ...r, x, y, w: widths[i], h }); x += widths[i]; });
    y += h;
  }
  const byId = new Map(out.map(p => [p.id, p]));
  return cells.map(c => byId.get(c.id)!);
}

/** The grid size from pixels, for drag maths. */
export const colStep = (gridWidth: number) => (gridWidth - GAP_PX * (COLS - 1)) / COLS + GAP_PX;
export const rowStep = ROW_PX + GAP_PX;

/** Resizing from the bottom-left corner: the right edge and top stay put. */
export function resizeFromBottomLeft(start: Cell, dxCells: number, dyCells: number): Cell {
  const right = start.x + start.w;
  const w = Math.max(MIN.w, Math.min(right, start.w - dxCells));
  const h = Math.max(MIN.h, Math.min(MAX_H, start.h + dyCells));
  return { ...start, w, h, x: right - w };
}

export const bottomOf = (cells: Cell[]) => cells.reduce((m, c) => Math.max(m, c.y + c.h), 0);
