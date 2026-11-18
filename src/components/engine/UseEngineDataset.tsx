/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { createContext, useContext, useState } from 'react';
import { Table as TableIcon } from 'lucide-react';
import type { Dataset } from '../../types';
import { engine } from '../../engine/client';
import { datasetFromRecords } from '../../utils/csvParser';
import Orb from '../Orb';

/**
 * How engine-made data reaches the studio. Provided by the App:
 * - open: start working on it as a new dataset (imports, connectors);
 * - replace: make it the next version of the current dataset (cleaning results).
 */
export const StudioDataContext = createContext<{
  open: (ds: Dataset) => void;
  replace: (ds: Dataset, summary: string) => void;
} | null>(null);

const PAGE = 10_000;
export const MAX_STUDIO_ROWS = 100_000;

/** Reads an engine dataset into the studio's in-browser form (at most MAX_STUDIO_ROWS rows). */
export async function loadEngineDataset(id: string, name: string, rows?: number): Promise<Dataset> {
  const out: Record<string, unknown>[] = [];
  let columns: string[] = [];
  const total = Math.min(rows ?? MAX_STUDIO_ROWS, MAX_STUDIO_ROWS);
  for (let offset = 0; offset < total; offset += PAGE) {
    const page = await engine.datasets.query(id, `SELECT * FROM data LIMIT ${Math.min(PAGE, total - offset)} OFFSET ${offset}`, PAGE);
    columns = page.columns;
    out.push(...page.rows);
    if (page.rows.length < PAGE) break;
  }
  return datasetFromRecords(columns, out, name);
}

/** "Open in the studio" / "Use as the next version" for a dataset the engine made. */
export default function UseEngineDataset({ dataset, mode, summary, label, agent }: {
  dataset: { id: string; name: string; rows: number };
  mode: 'open' | 'replace';
  summary?: string;
  label?: string;
  agent?: string;
}) {
  const studio = useContext(StudioDataContext);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  if (!studio) return null;
  const go = async () => {
    setBusy(true); setError(null);
    try {
      const ds = await loadEngineDataset(dataset.id, dataset.name, dataset.rows);
      if (mode === 'open') studio.open(ds);
      else studio.replace(ds, summary ?? `Replaced with “${dataset.name}” from the engine (${ds.rows.length.toLocaleString()} rows)`);
      setDone(true);
    } catch (err) {
      setError((err as Error)?.message || 'Could not load the data.');
    } finally { setBusy(false); }
  };
  return (
    <div className="space-y-1">
      <button type="button" className="btn btn-secondary" onClick={go} disabled={busy || done} data-agent={agent}>
        {busy ? <><Orb state="connecting" label="Loading" /> Loading…</> : <><TableIcon className="w-4 h-4" /> {done ? 'Done' : label ?? (mode === 'open' ? 'Open in the studio' : 'Use as the next version')}</>}
      </button>
      {dataset.rows > MAX_STUDIO_ROWS && <p className="text-xs text-label-3">The studio works on the first {MAX_STUDIO_ROWS.toLocaleString()} rows; the engine keeps all {dataset.rows.toLocaleString()}.</p>}
      {error && <p className="text-sm text-red">{error}</p>}
    </div>
  );
}
