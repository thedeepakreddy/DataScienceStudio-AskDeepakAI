/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useEffect, useId, useLayoutEffect, useRef } from 'react';
import { HumanMover, Point } from '../swarm/humanMotion';

// The agents' cursor: a soft rounded arrow with a gentle sheen, a white
// rim and a shadow, and a name tag tucked under its tail. Used on the page
// (AgentCursorLayer) and in the welcome.

/** The arrow. Its tip is at (2.5, 2.5) of a 22×22 box. */
export function CursorGlyph({ color, size = 22 }: { color: string; size?: number }) {
  const id = useId().replace(/:/g, '');
  return (
    <svg width={size} height={size} viewBox="0 0 22 22" aria-hidden="true" style={{ filter: 'drop-shadow(0 2px 3px rgba(0,0,0,0.28))', overflow: 'visible' }}>
      <defs>
        <linearGradient id={`g${id}`} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0%" stopColor={`color-mix(in srgb, ${color} 72%, white)`} />
          <stop offset="55%" stopColor={color} />
          <stop offset="100%" stopColor={`color-mix(in srgb, ${color} 82%, black)`} />
        </linearGradient>
      </defs>
      <path
        d="M3.6 2.2 L19.2 8.6 C20.3 9.05 20.2 10.6 19.05 10.9 L12.9 12.5 C12.55 12.6 12.3 12.85 12.2 13.2 L10.6 19.3 C10.3 20.45 8.75 20.55 8.3 19.45 L2.2 3.6 C1.8 2.6 2.6 1.8 3.6 2.2 Z"
        fill={`url(#g${id})`}
        stroke="white"
        strokeWidth="1.6"
        strokeLinejoin="round"
      />
    </svg>
  );
}

/** The name tag: rounded, with a tight corner pointing back at the arrow. */
export function NameTag({ color, name, detail, flip = false, small = false, dim = false }: {
  color: string; name: string; detail?: string; flip?: boolean; small?: boolean; dim?: boolean;
}) {
  return (
    <span
      className={`absolute top-[17px] whitespace-nowrap font-medium text-white shadow-[0_2px_6px_rgba(0,0,0,0.18)] ${small ? 'text-[9.5px] px-1.5 py-[2px]' : 'text-[11px] px-2 py-[3px]'}`}
      style={{
        background: color,
        borderRadius: flip ? '10px 3px 10px 10px' : '3px 10px 10px 10px',
        ...(flip ? { right: 'calc(100% - 6px)' } : { left: 12 }),
        opacity: dim ? 0.78 : 1,
        maxWidth: 280,
        overflow: 'hidden',
        textOverflow: 'ellipsis',
        boxShadow: '0 0 0 1px rgba(255,255,255,0.18) inset, 0 2px 6px rgba(0,0,0,0.18)',
      }}
    >
      <span className="font-semibold">{name}</span>
      {detail && <span className="opacity-90"> · {detail}</span>}
    </span>
  );
}

/**
 * A cursor that travels to (x, y) along a human-looking curve. `snap` moves
 * it at once (used to follow the page when it scrolls).
 */
export function HumanPointer({ x, y, snap, color, name, detail, waiting, maxDuration = 600, className = '', style }: {
  x: number; y: number; snap?: number; color: string; name: string; detail?: string; waiting?: boolean;
  maxDuration?: number; className?: string; style?: React.CSSProperties;
}) {
  const el = useRef<HTMLDivElement | null>(null);
  const mover = useRef<HumanMover | null>(null);

  useLayoutEffect(() => {
    mover.current = new HumanMover(el.current, { x, y });
    return () => mover.current?.stop();
    // Created once; later positions are animated below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => { mover.current?.moveTo({ x, y } as Point, { maxDuration }); }, [x, y, maxDuration]);
  useEffect(() => { if (snap) mover.current?.jump({ x, y }); }, [snap]); // eslint-disable-line react-hooks/exhaustive-deps

  const flip = typeof window !== 'undefined' && x > window.innerWidth - 220;
  return (
    <div ref={el} className={`absolute left-0 top-0 will-change-transform ${className}`} style={style}>
      <div className="-ml-[2.5px] -mt-[2.5px]"><CursorGlyph color={color} /></div>
      <NameTag color={color} name={name} detail={waiting ? `waiting: ${detail ?? ''}` : detail} flip={flip} dim={waiting} />
    </div>
  );
}
