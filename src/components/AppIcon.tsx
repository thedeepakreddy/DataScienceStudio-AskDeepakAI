/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React from 'react';

/**
 * The product mark. The artwork lives in /public (logo.png here; favicon and
 * home-screen sizes alongside it), so the same icon is used everywhere.
 */
export default function AppIcon({ size = 28, className = '' }: { size?: number; className?: string }) {
  return (
    <img
      src="/logo.png"
      width={size}
      height={size}
      alt="Data Science Studio"
      draggable={false}
      className={`shrink-0 select-none ${className}`}
      // The tile is near-white, so a hairline and a soft shadow keep its edge
      // visible on the light canvas; both follow the icon's rounded shape.
      style={{ filter: 'drop-shadow(0 0 0.5px rgba(0, 0, 0, 0.28)) drop-shadow(0 1px 2px rgba(0, 0, 0, 0.1))' }}
    />
  );
}
