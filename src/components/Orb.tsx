/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React from 'react';
import { ThinkingOrb } from 'thinking-orbs';
import type { OrbState } from 'thinking-orbs';

/**
 * The app's one activity indicator - a dotted "thinking orb" from the
 * thinking-orbs package (MIT, Jakub Antalik). Each state is a distinct
 * animation, chosen to match what is actually happening:
 *
 *   working     agent analysis, model download, server-side statistics
 *   searching   quality audit, AI hunting for hypotheses
 *   solving     model training, statistical tests, building the dashboard
 *   listening   waiting to hear back from the ML engine or Gemini
 *   connecting  waking the ML engine, connecting a database
 *   weaving     combining data + goal into a plan, assembling a pipeline
 *   composing   AI writing text: replies, explanations, reports, SQL
 *   breathing   AI thinking about the dataset; the idle assistant
 *   shaping     adding columns or rows from the assistant
 *
 * Sizes are the two hand-tuned designs the package ships: 20 sits inline
 * with text and buttons, 64 is the large standalone indicator.
 * Light/dark follows the app's appearance automatically; `onAccent` forces
 * light dots for solid-colour buttons.
 */
export default function Orb({
  state,
  size = 20,
  onAccent = false,
  label,
  className = '',
}: {
  state: OrbState;
  size?: 20 | 64;
  onAccent?: boolean;
  label?: string;
  className?: string;
}) {
  return (
    <ThinkingOrb
      state={state}
      size={size}
      theme={onAccent ? 'dark' : 'auto'}
      aria-label={label}
      className={`shrink-0 ${className}`}
    />
  );
}
