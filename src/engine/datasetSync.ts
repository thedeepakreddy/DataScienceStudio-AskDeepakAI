/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Keeps the engine in step with the studio's data without the user re-uploading.
 *
 * The studio holds the working dataset in the browser. The first time an
 * engine analysis needs it, its current version is sent to the engine as CSV
 * and the engine's dataset id is remembered by a hash of the content: the same
 * rows are never uploaded twice, and an edited version is uploaded once more.
 * If the engine has lost the dataset (a fresh deploy), it is uploaded again.
 */
import type { Dataset } from '../types';
import { rowsToCsv } from '../utils/provenance';
import { EngineApiError, engine as defaultEngine, type DatasetMeta, type EngineClient } from './client';

/** Cloud Run caps a request at 32 MiB; anything near that goes straight to Cloud Storage. */
const DIRECT_UPLOAD_LIMIT = 28 * 1024 * 1024;
const STORE_PREFIX = 'engine-dataset:';

const inFlight = new Map<string, Promise<DatasetMeta>>();

export function datasetCsv(dataset: Dataset): string {
  return rowsToCsv(dataset.rows, dataset.columns.map(c => c.name));
}

export async function contentHash(text: string): Promise<string> {
  const bytes = new TextEncoder().encode(text);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest), b => b.toString(16).padStart(2, '0')).join('').slice(0, 32);
}

// Kept in memory for this visit, and in localStorage across visits when the browser allows it.
const memory = new Map<string, string>();

function remembered(hash: string): string | null {
  if (memory.has(hash)) return memory.get(hash)!;
  try { return typeof localStorage === 'undefined' ? null : localStorage.getItem(STORE_PREFIX + hash); } catch { return null; }
}

function remember(hash: string, id: string) {
  memory.set(hash, id);
  try { if (typeof localStorage !== 'undefined') localStorage.setItem(STORE_PREFIX + hash, id); } catch { /* private mode: memory still works */ }
}

/** The engine's copy of this dataset version, uploading it if the engine doesn't have it yet. */
export async function syncDataset(dataset: Dataset, client: EngineClient = defaultEngine): Promise<DatasetMeta> {
  const csv = datasetCsv(dataset);
  const hash = await contentHash(csv);
  const pending = inFlight.get(hash);
  if (pending) return pending;
  const task = (async () => {
    const known = remembered(hash);
    if (known) {
      try {
        return await client.datasets.get(known);
      } catch (err) {
        if (!(err instanceof EngineApiError && err.status === 404)) throw err;
      }
    }
    const name = dataset.filename.replace(/\.[^.]+$/, '') || 'dataset';
    const file = new File([csv], `${name}.csv`, { type: 'text/csv' });
    const meta = file.size > DIRECT_UPLOAD_LIMIT
      ? await client.datasets.uploadLarge(file, name)
      : await client.datasets.upload(file, name, file.name);
    remember(hash, meta.id);
    return meta;
  })();
  inFlight.set(hash, task);
  try {
    return await task;
  } finally {
    inFlight.delete(hash);
  }
}
