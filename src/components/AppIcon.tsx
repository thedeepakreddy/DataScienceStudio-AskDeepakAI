/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React from 'react';

/** The product mark: a rounded-square app icon with three rising bars. */
export default function AppIcon({ size = 28, className = '' }: { size?: number; className?: string }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 64 64"
      className={`shrink-0 ${className}`}
      role="img"
      aria-label="Data Science Studio"
    >
      <defs>
        <linearGradient id="app-icon-fill" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#42a1ff" />
          <stop offset="1" stopColor="#0071e3" />
        </linearGradient>
      </defs>
      <rect width="64" height="64" rx="14.5" fill="url(#app-icon-fill)" />
      <g fill="#fff">
        <rect x="15" y="34" width="8" height="15" rx="2.5" />
        <rect x="28" y="24" width="8" height="25" rx="2.5" />
        <rect x="41" y="15" width="8" height="34" rx="2.5" />
      </g>
    </svg>
  );
}
