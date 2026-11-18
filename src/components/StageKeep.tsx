/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React from 'react';

/**
 * Keeps a step mounted once it has been opened and only hides it while another
 * step is shown, so analyses, results and form choices are still there when
 * you come back to it.
 */
export default function StageKeep({ tab, active, visited, children }: { tab: string; active: string; visited: Set<string>; children: React.ReactNode }) {
  if (tab !== active && !visited.has(tab)) return null;
  return (
    <div hidden={tab !== active} data-stage={tab} className={tab === active ? 'animate-fade-in' : undefined}>
      {children}
    </div>
  );
}
