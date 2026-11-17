/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useEffect, useLayoutEffect, useRef } from 'react';
import { HumanMover, Point } from '../swarm/humanMotion';

// The agents' cursors, in the style of modern click cursors: a rounded
// arrowhead with a contrasting rim (dark on light pages, light on dark),
// the agent's colour as a small dot, and a slim name tag.
// - "solid" is the worker, which clicks and types; three short rays flash at
//   its tip on each click.
// - "soft" (two-tone) is its partner, which touches panels; two rings ripple
//   from its tip when it does.
// Used on the page (AgentCursorLayer, agentStage) and in the welcome.

/** The arrowhead. Its tip is at (3, 3) of the drawing. */
export const CURSOR_ARROW = 'M3.6 2.4 L18.9 8.7 C20 9.15 19.9 10.3 18.8 10.6 L12.4 12.3 C12 12.4 11.75 12.65 11.65 13.05 L9.95 19.4 C9.65 20.5 8.4 20.6 8.05 19.55 L2.4 3.6 C2.05 2.6 2.75 2.05 3.6 2.4 Z';
const RAYS = '<g class="rays"><path d="M3 -1.2 L3 -4.6"/><path d="M0.1 0.1 L-2.3 -2.3"/><path d="M-1.2 3 L-4.6 3"/></g>';
const RINGS = '<g class="rings"><path d="M-1.4 6.2 A5 5 0 1 1 6.2 -1.4"/><path d="M-4.6 8.2 A8.6 8.6 0 1 1 8.2 -4.6"/></g>';

export type CursorVariant = 'solid' | 'soft';

/** The cursor's markup, for code that builds cursors without React (the stage, the welcome). */
export function cursorHtml(color: string, variant: CursorVariant = 'solid', size = 22) {
  return `<span class="agent-cursor" data-variant="${variant}" style="--cur-size:${size}px">`
    + `<svg width="${size}" height="${size}" viewBox="-3 -3 25 25" aria-hidden="true">${variant === 'soft' ? RINGS : RAYS}<path class="arrow" d="${CURSOR_ARROW}"/></svg>`
    + `<span class="cursor-dot" style="background:${color};box-shadow:0 0 0 1.5px #fff,0 0 8px ${color}"></span></span>`;
}

/** The cursor, in React. Its tip sits at the element's origin. */
export function CursorGlyph({ color, variant = 'solid', size = 22 }: { color: string; variant?: CursorVariant; size?: number }) {
  return (
    <span className="agent-cursor" data-variant={variant} aria-hidden="true" style={{ '--cur-size': `${size}px` } as React.CSSProperties}>
      <svg width={size} height={size} viewBox="-3 -3 25 25">
        {variant === 'soft' ? (
          <g className="rings"><path d="M-1.4 6.2 A5 5 0 1 1 6.2 -1.4" /><path d="M-4.6 8.2 A8.6 8.6 0 1 1 8.2 -4.6" /></g>
        ) : (
          <g className="rays"><path d="M3 -1.2 L3 -4.6" /><path d="M0.1 0.1 L-2.3 -2.3" /><path d="M-1.2 3 L-4.6 3" /></g>
        )}
        <path className="arrow" d={CURSOR_ARROW} />
      </svg>
      <span className="cursor-dot" style={{ background: color, boxShadow: `0 0 0 1.5px #fff, 0 0 8px ${color}` }} />
    </span>
  );
}

/** The slim name tag beside a cursor. */
export function NameTag({ name, detail, flip = false, small = false, dim = false, maxWidth = 280 }: {
  name: string; detail?: string; flip?: boolean; small?: boolean; dim?: boolean; maxWidth?: number;
}) {
  return (
    <span
      className={`agent-tag${small ? ' small' : ''}`}
      style={{ ...(flip ? { right: 'calc(100% - 4px)' } : { left: 14 }), opacity: dim ? 0.8 : 1, maxWidth }}
    >
      <span className="font-semibold">{name}</span>
      {detail && <span className="detail"> · {detail}</span>}
    </span>
  );
}

/** Which side of a cursor at `x` its name tag goes, and how wide it may be, so it stays on screen. */
export function tagPlacement(x: number) {
  if (typeof window === 'undefined') return { flip: false, maxWidth: 280 };
  const right = window.innerWidth - x - 20, left = x - 14;
  const flip = right < 220 && left > right;
  return { flip, maxWidth: Math.round(Math.max(110, Math.min(280, (flip ? left : right) - 8))) };
}

/**
 * A cursor that travels to (x, y) along a human-looking curve. `snap` moves
 * it at once (used to follow the page when it scrolls); a new `clickKey`
 * flashes the click rays.
 */
export function HumanPointer({ x, y, snap, color, name, detail, waiting, clickKey, maxDuration = 600, className = '', style }: {
  x: number; y: number; snap?: number; color: string; name: string; detail?: string; waiting?: boolean; clickKey?: number;
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
  useEffect(() => {
    const node = el.current;
    if (!clickKey || !node) return;
    node.classList.remove('is-clicking', 'is-pressing');
    void node.offsetWidth;
    node.classList.add('is-clicking', 'is-pressing');
    const a = setTimeout(() => node.classList.remove('is-pressing'), 140);
    const b = setTimeout(() => node.classList.remove('is-clicking'), 440);
    return () => { clearTimeout(a); clearTimeout(b); };
  }, [clickKey]);

  const { flip, maxWidth: tagWidth } = tagPlacement(x);
  return (
    <div ref={el} className={`absolute left-0 top-0 will-change-transform ${className}`} style={style}>
      <CursorGlyph color={color} variant="solid" />
      <NameTag name={name} detail={waiting ? `waiting: ${detail ?? ''}` : detail} flip={flip} dim={waiting} maxWidth={tagWidth} />
    </div>
  );
}
