/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useEffect, useRef, useState } from 'react';
import { MoreHorizontal } from 'lucide-react';

interface Item { label: string; icon: React.ReactNode; onSelect: () => void; className?: string }

/** Phones only: a "More" button holding the toolbar's less-used controls. */
export default function MoreMenu({ items }: { items: Item[] }) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => { if (!root.current?.contains(e.target as Node)) setOpen(false); };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    window.addEventListener('pointerdown', onDown);
    window.addEventListener('keydown', onKey);
    return () => { window.removeEventListener('pointerdown', onDown); window.removeEventListener('keydown', onKey); };
  }, [open]);

  return (
    <div ref={root} className="relative sm:hidden">
      <button type="button" className="btn btn-icon" aria-label="More" aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen(o => !o)}>
        <MoreHorizontal className="w-[18px] h-[18px]" />
      </button>
      {open && (
        <div role="menu" className="absolute right-0 top-full mt-1.5 z-50 w-60 rounded-2xl bg-raised shadow-xl border border-separator p-1.5">
          {items.map(it => (
            <button
              key={it.label}
              type="button"
              role="menuitem"
              className={`w-full flex items-center gap-3 rounded-xl px-3 py-2.5 text-sm text-label hover:bg-fill text-left ${it.className ?? ''}`}
              onClick={() => { setOpen(false); it.onSelect(); }}
            >
              <span className="text-label-2">{it.icon}</span>
              {it.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
