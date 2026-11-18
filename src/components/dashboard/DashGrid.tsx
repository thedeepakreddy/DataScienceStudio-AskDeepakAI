/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { motion } from 'motion/react';
import { LayoutGrid, RotateCcw, Undo2 } from 'lucide-react';
import { COLS, Cell, GAP_PX, Kind, ROW_PX, appendCells, bottomOf, clampCell, cleanUp, colStep, defaultSize, resizeFromBottomLeft, resolve, rowStep } from './dashGrid';

export interface GridItem { id: string; kind: Kind; title: string; agent: string; node: React.ReactNode }

const load = (key: string): Cell[] | null => {
  try { const v = JSON.parse(localStorage.getItem(key) || 'null'); return Array.isArray(v) ? v : null; } catch { return null; }
};
const save = (key: string, cells: Cell[]) => { try { localStorage.setItem(key, JSON.stringify(cells)); } catch { /* private window */ } };

function initial(items: GridItem[], perRow: number): Cell[] {
  return cleanUp(appendCells([], items.map(i => ({ id: i.id, ...defaultSize(i.kind, perRow) }))), id => items.find(i => i.id === id)?.kind ?? 'chart');
}

/**
 * The dashboard's panels on a 12-column grid. Drag the curved bottom-left
 * corner to resize (the right edge stays put), or the three dots on top to move;
 * the other panels slide out of the way and close up gaps. "Clean up" lines
 * everything into tidy rows. The layout is saved per dataset in this browser.
 */
export default function DashGrid({ items, storageKey, perRow }: { items: GridItem[]; storageKey: string; perRow: number }) {
  const kindOf = useCallback((id: string) => items.find(i => i.id === id)?.kind ?? 'chart', [items]);
  const [cells, setCells] = useState<Cell[]>(() => {
    const saved = load(storageKey);
    return saved ? sync(saved, items, perRow) : initial(items, perRow);
  });
  const [keep, setKeep] = useState<boolean>(() => { try { return localStorage.getItem('dash-keep-arranged') === '1'; } catch { return false; } });
  const [active, setActive] = useState<{ id: string; mode: 'resize' | 'move' } | null>(null);
  const undo = useRef<Cell[][]>([]);
  const [undoCount, setUndoCount] = useState(0);
  const gridRef = useRef<HTMLDivElement>(null);

  // New or removed charts (a new design, an agent, the customise panel).
  const ids = items.map(i => i.id).join('|');
  useEffect(() => {
    // The panels on the dashboard changed elsewhere: keep their places, add new ones below.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setCells(prev => {
      const fromStore = load(storageKey);
      return sync(fromStore && prev.length === 0 ? fromStore : prev, items, perRow);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ids, storageKey]);
  useEffect(() => { if (!active) save(storageKey, cells); }, [cells, active, storageKey]);
  // Choosing 1, 2 or 3 charts per row re-lays the dashboard at that width.
  const firstPerRow = useRef(perRow);
  useEffect(() => {
    if (perRow === firstPerRow.current) return;
    firstPerRow.current = perRow;
    setCells(prev => { undo.current = [...undo.current.slice(-19), prev]; return initial(items, perRow); });
    setUndoCount(c => c + 1);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [perRow]);

  const commit = (next: Cell[], before: Cell[]) => {
    undo.current = [...undo.current.slice(-19), before];
    setUndoCount(undo.current.length);
    setCells(keep ? cleanUp(next, kindOf) : next);
  };

  const startDrag = (e: React.PointerEvent, id: string, mode: 'resize' | 'move') => {
    if (e.button !== 0) return;
    e.preventDefault(); e.stopPropagation();
    const start = cells.find(c => c.id === id)!;
    const before = cells;
    const width = gridRef.current?.getBoundingClientRect().width ?? 1200;
    const cs = colStep(width);
    const x0 = e.clientX, y0 = e.clientY;
    setActive({ id, mode });
    let last = cells;
    const onMove = (ev: PointerEvent) => {
      const dx = Math.round((ev.clientX - x0) / cs), dy = Math.round((ev.clientY - y0) / rowStep);
      const moved = mode === 'resize' ? resizeFromBottomLeft(start, dx, dy) : clampCell({ ...start, x: start.x + dx, y: start.y + dy });
      last = resolve(before.map(c => (c.id === id ? moved : c)), id);
      setCells(last);
    };
    const onUp = () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      setActive(null);
      if (last !== before) commit(resolve(last), before);
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
  };

  // Keyboard: arrows on the corner resize, on the dots move.
  const onKey = (e: React.KeyboardEvent, id: string, mode: 'resize' | 'move') => {
    const d = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] }[e.key];
    if (!d) return;
    e.preventDefault();
    const c = cells.find(x => x.id === id)!;
    const moved = mode === 'resize' ? resizeFromBottomLeft(c, d[0], d[1]) : clampCell({ ...c, x: c.x + d[0], y: c.y + d[1] });
    commit(resolve(cells.map(x => (x.id === id ? moved : x)), id), cells);
  };

  const tidy = () => commit(cleanUp(cells, kindOf), cells);
  const reset = () => commit(initial(items, perRow), cells);
  const back = () => { const prev = undo.current.pop(); setUndoCount(undo.current.length); if (prev) setCells(prev); };
  const toggleKeep = () => {
    const v = !keep; setKeep(v);
    try { localStorage.setItem('dash-keep-arranged', v ? '1' : '0'); } catch { /* ignore */ }
    if (v) setCells(c => cleanUp(c, kindOf));
  };

  const byId = useMemo(() => new Map(cells.map(c => [c.id, c])), [cells]);
  const rows = bottomOf(cells);

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2" data-agent="dash-arrange">
        <p className="text-xs text-label-3">Drag a panel’s curved corner to resize it, or the dots on top to move it. The others make room.</p>
        <div className="flex flex-wrap items-center gap-2">
          <label className="flex items-center gap-1.5 text-xs text-label-2 mr-1">
            <input type="checkbox" checked={keep} onChange={toggleKeep} data-agent="dash-keep-arranged" /> Keep arranged
          </label>
          <button type="button" className="btn btn-sm btn-plain" onClick={back} disabled={!undoCount} aria-label="Undo the last layout change"><Undo2 className="w-3.5 h-3.5" /> Undo</button>
          <button type="button" className="btn btn-sm btn-plain" onClick={reset}><RotateCcw className="w-3.5 h-3.5" /> Reset</button>
          <button type="button" className="btn btn-sm btn-secondary" onClick={tidy} data-agent="dash-clean-up"><LayoutGrid className="w-3.5 h-3.5" /> Clean up</button>
        </div>
      </div>
      <div ref={gridRef} className={`dash-grid ${active ? 'select-none' : ''}`}
        style={{ gridTemplateColumns: `repeat(${COLS}, minmax(0, 1fr))`, gridAutoRows: `${ROW_PX}px`, gap: `${GAP_PX}px`, minHeight: rows * rowStep }}>
        {items.map(it => {
          const c = byId.get(it.id);
          if (!c) return null;
          const isActive = active?.id === it.id;
          return (
            <motion.div key={it.id} layout={!isActive} transition={{ type: 'spring', stiffness: 420, damping: 38, mass: 0.7 }}
              className={`dash-panel group relative ${isActive ? 'z-20 dash-panel-active' : 'z-0'}`} data-agent={it.agent} data-kind={it.kind}
              style={{ gridColumn: `${c.x + 1} / span ${c.w}`, gridRow: `${c.y + 1} / span ${c.h}` }}>
              {it.node}
              {/* Move: three dots, like a window on iPad. */}
              <button type="button" className="dash-grip" aria-label={`Move ${it.title}`} title="Drag to move"
                onPointerDown={e => startDrag(e, it.id, 'move')} onKeyDown={e => onKey(e, it.id, 'move')}>
                <span /><span /><span />
              </button>
              {/* Resize: the curved bottom-left corner. */}
              <button type="button" className="dash-corner" aria-label={`Resize ${it.title} (${c.w} by ${c.h})`} title="Drag to resize"
                onPointerDown={e => startDrag(e, it.id, 'resize')} onKeyDown={e => onKey(e, it.id, 'resize')}>
                <svg viewBox="0 0 28 28" aria-hidden="true"><path d="M4 5 C4 16 10 24 23 24" /></svg>
              </button>
              {isActive && active?.mode === 'resize' && (
                <span className="absolute top-2 right-2 z-30 rounded-full bg-black/75 text-white px-2 py-0.5 text-[11px] font-semibold tabular-nums">{c.w} × {c.h}</span>
              )}
            </motion.div>
          );
        })}
      </div>
    </div>
  );
}

/** Saved cells kept for charts still on the dashboard; new charts added below. */
function sync(cells: Cell[], items: GridItem[], perRow: number): Cell[] {
  const want = new Set(items.map(i => i.id));
  const kept = cells.filter(c => want.has(c.id));
  const have = new Set(kept.map(c => c.id));
  const add = items.filter(i => !have.has(i.id)).map(i => ({ id: i.id, ...defaultSize(i.kind, perRow) }));
  return add.length || kept.length !== cells.length ? appendCells(resolve(kept), add) : cells;
}
