/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Dataset } from '../types';
import type { AppliedOperation } from '../operations/registry';
import type { QualityRule } from '../operations/qualityRules';
import type { KpiDefinition } from './kpiFormula';
import type { RegisteredModel } from './modelRegistry';
import type { SwarmRun } from '../swarm/runtime';

// The studio's saved work, kept in this browser's IndexedDB. The servers are
// stateless (free hosting loses its disk on restart), so the browser is where
// work lives: every dataset change is a version with a link to its parent, and
// every analysis run is recorded against the version it ran on.

const DB_NAME = 'askdeepak-studio';
const DB_VERSION = 7;
/** Versions kept per dataset; the oldest unpinned ones are pruned past this. */
export const MAX_VERSIONS_PER_DATASET = 25;

export interface DatasetVersion {
  id: string;
  /** Shared by every version that descends from the same import. */
  datasetId: string;
  parentId: string | null;
  /** What produced this version, in plain words ("Imported", "Removed 3 rows"). */
  label: string;
  createdAt: number;
  filename: string;
  rowCount: number;
  columnCount: number;
  /** The registry operation (and its settings) that produced this version, when known. */
  operation?: AppliedOperation;
  dataset: Dataset;
}

export type RunKind = 'ai-advisory' | 'model-training' | 'hypothesis-test' | 'ab-test' | 'quality-audit' | 'sql-query' | 'regression' | 'forecast' | 'power' | 'deep-eda' | 'other';

export interface RunRecord {
  id: string;
  kind: RunKind;
  /** The dataset version the run used (provenance). */
  versionId: string | null;
  title: string;
  /** One line with the headline result. */
  summary: string;
  status: 'succeeded' | 'failed';
  createdAt: number;
  params?: unknown;
  result?: unknown;
  error?: string;
}

export interface WorkspaceSession {
  activeVersionId: string | null;
  originalVersionId: string | null;
  activeTab: string;
  mlResult: unknown;
  aiAnalysis: unknown;
  savedAt: number;
}

const newId = () =>
  (typeof crypto !== 'undefined' && 'randomUUID' in crypto)
    ? crypto.randomUUID()
    : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;

// Strictly increasing timestamps, so records saved in the same millisecond
// still sort in the order they were made.
let lastTs = 0;
const nextTimestamp = () => (lastTs = Math.max(Date.now(), lastTs + 1));

let dbPromise: Promise<IDBDatabase> | null = null;

function openDb(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise<IDBDatabase>((resolve, reject) => {
    if (typeof indexedDB === 'undefined') {
      reject(new Error('This browser has no IndexedDB, so work can’t be saved.'));
      return;
    }
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('versions')) {
        const s = db.createObjectStore('versions', { keyPath: 'id' });
        s.createIndex('datasetId', 'datasetId');
      }
      if (!db.objectStoreNames.contains('runs')) {
        const s = db.createObjectStore('runs', { keyPath: 'id' });
        s.createIndex('createdAt', 'createdAt');
      }
      if (!db.objectStoreNames.contains('session')) {
        db.createObjectStore('session');
      }
      if (!db.objectStoreNames.contains('models')) {
        db.createObjectStore('models', { keyPath: 'modelId' });
      }
      if (!db.objectStoreNames.contains('rules')) {
        db.createObjectStore('rules');
      }
      if (!db.objectStoreNames.contains('swarmRuns')) {
        const s = db.createObjectStore('swarmRuns', { keyPath: 'id' });
        s.createIndex('updatedAt', 'updatedAt');
      }
      if (!db.objectStoreNames.contains('swarmCache')) {
        db.createObjectStore('swarmCache');
      }
      if (!db.objectStoreNames.contains('workflows')) {
        db.createObjectStore('workflows', { keyPath: 'id' });
      }
      if (!db.objectStoreNames.contains('registry')) {
        const s = db.createObjectStore('registry', { keyPath: 'id' });
        s.createIndex('datasetId', 'datasetId');
      }
      if (!db.objectStoreNames.contains('dashboards')) {
        const s = db.createObjectStore('dashboards', { keyPath: 'id' });
        s.createIndex('datasetId', 'datasetId');
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error('Could not open saved work.'));
    req.onblocked = () => reject(new Error('Saved work is open in an older tab. Close other tabs and reload.'));
  });
  // Let a later call retry if opening failed.
  dbPromise.catch(() => { dbPromise = null; });
  return dbPromise;
}

function promisify<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function done(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error ?? new Error('Saving was cancelled.'));
  });
}

// --- Versions ---------------------------------------------------------------

/** Saves a dataset as a new version. A null parent starts a new dataset. */
export async function saveVersion(
  dataset: Dataset,
  opts: { parentId: string | null; label: string; operation?: AppliedOperation; keep?: string[] },
): Promise<DatasetVersion> {
  const db = await openDb();
  let datasetId: string;
  if (opts.parentId) {
    const parent = await getVersion(opts.parentId);
    datasetId = parent?.datasetId ?? newId();
  } else {
    datasetId = newId();
  }
  const version: DatasetVersion = {
    id: newId(),
    datasetId,
    parentId: opts.parentId,
    label: opts.label,
    ...(opts.operation ? { operation: opts.operation } : {}),
    createdAt: nextTimestamp(),
    filename: dataset.filename,
    rowCount: dataset.rows.length,
    columnCount: dataset.columns.length,
    dataset,
  };
  const tx = db.transaction('versions', 'readwrite');
  tx.objectStore('versions').put(version);
  await done(tx);
  await pruneVersions(datasetId, [version.id, ...(opts.keep ?? [])]);
  return version;
}

export async function getVersion(id: string): Promise<DatasetVersion | undefined> {
  const db = await openDb();
  return promisify(db.transaction('versions').objectStore('versions').get(id));
}

/** All versions of a dataset, oldest first. */
export async function listVersions(datasetId: string): Promise<DatasetVersion[]> {
  const db = await openDb();
  const all = await promisify(
    db.transaction('versions').objectStore('versions').index('datasetId').getAll(datasetId),
  ) as DatasetVersion[];
  return all.sort((a, b) => a.createdAt - b.createdAt);
}

/**
 * Keeps a dataset to MAX_VERSIONS_PER_DATASET versions by deleting the oldest,
 * never an imported version or any id in `keep`. A pruned version's
 * children keep pointing at it; the history shows the gap honestly.
 */
async function pruneVersions(datasetId: string, keep: string[]) {
  const versions = await listVersions(datasetId);
  if (versions.length <= MAX_VERSIONS_PER_DATASET) return;
  const removable = versions.filter(v => v.parentId !== null && !keep.includes(v.id));
  const excess = versions.length - MAX_VERSIONS_PER_DATASET;
  const db = await openDb();
  const tx = db.transaction('versions', 'readwrite');
  removable.slice(0, excess).forEach(v => tx.objectStore('versions').delete(v.id));
  await done(tx);
}

// --- Runs -------------------------------------------------------------------

export async function recordRun(run: Omit<RunRecord, 'id' | 'createdAt'>): Promise<RunRecord> {
  const db = await openDb();
  const record: RunRecord = { ...run, id: newId(), createdAt: nextTimestamp() };
  const tx = db.transaction('runs', 'readwrite');
  tx.objectStore('runs').put(record);
  await done(tx);
  return record;
}

/** Most recent runs first. */
export async function listRuns(limit = 100): Promise<RunRecord[]> {
  const db = await openDb();
  const all = await promisify(db.transaction('runs').objectStore('runs').getAll()) as RunRecord[];
  return all.sort((a, b) => b.createdAt - a.createdAt).slice(0, limit);
}

// --- Trained model files ---------------------------------------------------
// The ML service keeps trained models in memory only, so a restart (common on
// free hosting) loses them. A copy of each model file is kept here so it can
// still be downloaded later.

export const MAX_SAVED_MODELS = 10;

export interface SavedModelFile {
  modelId: string;
  filename: string;
  bytes: ArrayBuffer;
  savedAt: number;
  versionId: string | null;
  target?: string;
  algorithm?: string;
}

export async function saveModelFile(file: Omit<SavedModelFile, 'savedAt'>): Promise<void> {
  const db = await openDb();
  const tx = db.transaction('models', 'readwrite');
  const store = tx.objectStore('models');
  store.put({ ...file, savedAt: nextTimestamp() });
  await done(tx);
  // Keep only the most recent models; files can be several megabytes.
  const all = await promisify(db.transaction('models').objectStore('models').getAll()) as SavedModelFile[];
  if (all.length > MAX_SAVED_MODELS) {
    const old = all.sort((a, b) => a.savedAt - b.savedAt).slice(0, all.length - MAX_SAVED_MODELS);
    const del = db.transaction('models', 'readwrite');
    old.forEach(m => del.objectStore('models').delete(m.modelId));
    await done(del);
  }
}

export async function getModelFile(modelId: string): Promise<SavedModelFile | undefined> {
  const db = await openDb();
  return promisify(db.transaction('models').objectStore('models').get(modelId));
}

// --- Quality rules (per dataset) ----------------------------------------------

export async function saveRules(datasetId: string, rules: QualityRule[]): Promise<void> {
  const db = await openDb();
  const tx = db.transaction('rules', 'readwrite');
  tx.objectStore('rules').put(rules, datasetId);
  await done(tx);
}

export async function loadRules(datasetId: string): Promise<QualityRule[]> {
  const db = await openDb();
  return ((await promisify(db.transaction('rules').objectStore('rules').get(datasetId))) as QualityRule[] | undefined) ?? [];
}

// --- Saved dashboards ---------------------------------------------------------

export interface SavedDashboard {
  id: string;
  datasetId: string;
  name: string;
  savedAt: number;
  activeComponents: string[];
  layout: string;
  config: unknown;
  categoryFilters: Record<string, string[]>;
  numericSlicers: Record<string, unknown>;
  kpis: KpiDefinition[];
}

export async function saveDashboard(d: Omit<SavedDashboard, 'savedAt'>): Promise<SavedDashboard> {
  const db = await openDb();
  const record = { ...d, savedAt: nextTimestamp() };
  const tx = db.transaction('dashboards', 'readwrite');
  tx.objectStore('dashboards').put(record);
  await done(tx);
  return record;
}

/** A dataset's saved dashboards, most recently saved first. */
export async function listDashboards(datasetId: string): Promise<SavedDashboard[]> {
  const db = await openDb();
  const all = await promisify(db.transaction('dashboards').objectStore('dashboards').index('datasetId').getAll(datasetId)) as SavedDashboard[];
  return all.sort((a, b) => b.savedAt - a.savedAt);
}

export async function deleteDashboard(id: string): Promise<void> {
  const db = await openDb();
  const tx = db.transaction('dashboards', 'readwrite');
  tx.objectStore('dashboards').delete(id);
  await done(tx);
}

// --- Agent swarm runs and plan cache ---------------------------------------------

export async function saveSwarmRun(run: SwarmRun): Promise<void> {
  const db = await openDb();
  const tx = db.transaction('swarmRuns', 'readwrite');
  tx.objectStore('swarmRuns').put(run);
  await done(tx);
}

/** Most recent runs first. */
export async function listSwarmRuns(limit = 20): Promise<SwarmRun[]> {
  const db = await openDb();
  const all = await promisify(db.transaction('swarmRuns').objectStore('swarmRuns').getAll()) as SwarmRun[];
  return all.sort((a, b) => b.updatedAt - a.updatedAt).slice(0, limit);
}

export async function getCachedPlan(key: string): Promise<unknown | undefined> {
  const db = await openDb();
  return promisify(db.transaction('swarmCache').objectStore('swarmCache').get(key));
}

export async function setCachedPlan(key: string, value: unknown): Promise<void> {
  const db = await openDb();
  const tx = db.transaction('swarmCache', 'readwrite');
  tx.objectStore('swarmCache').put(value, key);
  await done(tx);
}

// --- Workflows (saved sequences of operations) ----------------------------------

export interface SavedWorkflow {
  id: string;
  name: string;
  steps: AppliedOperation[];
  createdAt: number;
  /** Where the steps were taken from, for provenance. */
  source: { datasetName: string; versionLabel: string };
}

export async function saveWorkflow(w: SavedWorkflow): Promise<void> {
  const db = await openDb();
  const tx = db.transaction('workflows', 'readwrite');
  tx.objectStore('workflows').put(w);
  await done(tx);
}

export async function listWorkflows(): Promise<SavedWorkflow[]> {
  const db = await openDb();
  const all = await promisify(db.transaction('workflows').objectStore('workflows').getAll()) as SavedWorkflow[];
  return all.sort((a, b) => b.createdAt - a.createdAt);
}

export async function deleteWorkflow(id: string): Promise<void> {
  const db = await openDb();
  const tx = db.transaction('workflows', 'readwrite');
  tx.objectStore('workflows').delete(id);
  await done(tx);
}

// --- Model registry -----------------------------------------------------------

export async function saveRegisteredModel(m: RegisteredModel): Promise<void> {
  const db = await openDb();
  const tx = db.transaction('registry', 'readwrite');
  tx.objectStore('registry').put(m);
  await done(tx);
}

/** A dataset's registered models, newest version first. */
export async function listRegisteredModels(datasetId: string): Promise<RegisteredModel[]> {
  const db = await openDb();
  const all = await promisify(db.transaction('registry').objectStore('registry').index('datasetId').getAll(datasetId)) as RegisteredModel[];
  return all.sort((a, b) => b.version - a.version);
}

/** Makes one model the active one for its dataset (used for predictions); others become inactive. */
export async function setActiveModel(datasetId: string, id: string): Promise<void> {
  const all = await listRegisteredModels(datasetId);
  const db = await openDb();
  const tx = db.transaction('registry', 'readwrite');
  all.forEach(m => tx.objectStore('registry').put({ ...m, active: m.id === id }));
  await done(tx);
}

export async function deleteRegisteredModel(id: string): Promise<void> {
  const db = await openDb();
  const tx = db.transaction('registry', 'readwrite');
  tx.objectStore('registry').delete(id);
  await done(tx);
}

// --- Session ----------------------------------------------------------------

export async function saveSession(session: Omit<WorkspaceSession, 'savedAt'>): Promise<void> {
  const db = await openDb();
  const tx = db.transaction('session', 'readwrite');
  tx.objectStore('session').put({ ...session, savedAt: Date.now() }, 'current');
  await done(tx);
}

export async function loadSession(): Promise<WorkspaceSession | undefined> {
  const db = await openDb();
  return promisify(db.transaction('session').objectStore('session').get('current'));
}

/** Deletes every saved version, run, model file and the session. */
export async function clearWorkspace(): Promise<void> {
  const db = await openDb();
  const tx = db.transaction(['versions', 'runs', 'session', 'models', 'rules', 'dashboards', 'registry', 'workflows', 'swarmRuns', 'swarmCache'], 'readwrite');
  tx.objectStore('swarmRuns').clear();
  tx.objectStore('swarmCache').clear();
  tx.objectStore('workflows').clear();
  tx.objectStore('registry').clear();
  tx.objectStore('dashboards').clear();
  tx.objectStore('models').clear();
  tx.objectStore('rules').clear();
  tx.objectStore('versions').clear();
  tx.objectStore('runs').clear();
  tx.objectStore('session').clear();
  await done(tx);
}

// --- Export / import ---------------------------------------------------------
// The whole workspace as one JSON file: the backup, and the way to move work
// to another browser or device.

export const WORKSPACE_FORMAT = 'askdeepak-studio-workspace';
export const WORKSPACE_FORMAT_VERSION = 1;

interface WorkspaceFile {
  format: typeof WORKSPACE_FORMAT;
  formatVersion: number;
  exportedAt: string;
  session: WorkspaceSession | null;
  versions: DatasetVersion[];
  runs: RunRecord[];
  models: (Omit<SavedModelFile, 'bytes'> & { bytesBase64: string })[];
  rules?: Record<string, QualityRule[]>;
  dashboards?: SavedDashboard[];
  registry?: RegisteredModel[];
  workflows?: SavedWorkflow[];
}

const toBase64 = (buf: ArrayBuffer) => {
  const bytes = new Uint8Array(buf);
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
};
const fromBase64 = (b64: string) => {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out.buffer;
};

export async function exportWorkspace(): Promise<string> {
  const db = await openDb();
  const tx = db.transaction(['versions', 'runs', 'models', 'session', 'rules', 'dashboards', 'registry', 'workflows']);
  const [versions, runs, models, session, ruleKeys, ruleValues, dashboards, registry, workflows] = await Promise.all([
    promisify(tx.objectStore('versions').getAll()),
    promisify(tx.objectStore('runs').getAll()),
    promisify(tx.objectStore('models').getAll()),
    promisify(tx.objectStore('session').get('current')),
    promisify(tx.objectStore('rules').getAllKeys()),
    promisify(tx.objectStore('rules').getAll()),
    promisify(tx.objectStore('dashboards').getAll()),
    promisify(tx.objectStore('registry').getAll()),
    promisify(tx.objectStore('workflows').getAll()),
  ]);
  const file: WorkspaceFile = {
    format: WORKSPACE_FORMAT,
    formatVersion: WORKSPACE_FORMAT_VERSION,
    exportedAt: new Date().toISOString(),
    session: (session as WorkspaceSession) ?? null,
    versions: versions as DatasetVersion[],
    runs: runs as RunRecord[],
    models: (models as SavedModelFile[]).map(({ bytes, ...m }) => ({ ...m, bytesBase64: toBase64(bytes) })),
    rules: Object.fromEntries((ruleKeys as string[]).map((k, i) => [k, (ruleValues as QualityRule[][])[i]])),
    dashboards: dashboards as SavedDashboard[],
    registry: registry as RegisteredModel[],
    workflows: workflows as SavedWorkflow[],
  };
  return JSON.stringify(file);
}

/** Replaces the saved workspace with the contents of an exported file. */
export async function importWorkspace(text: string): Promise<{ versions: number; runs: number; models: number }> {
  let file: WorkspaceFile;
  try {
    file = JSON.parse(text);
  } catch {
    throw new Error('That file isn’t a workspace export (it isn’t valid JSON).');
  }
  if (file?.format !== WORKSPACE_FORMAT) throw new Error('That file isn’t a Data Science Studio workspace export.');
  if (typeof file.formatVersion !== 'number' || file.formatVersion > WORKSPACE_FORMAT_VERSION) {
    throw new Error('This workspace was exported by a newer version of the studio.');
  }
  if (!Array.isArray(file.versions) || !Array.isArray(file.runs) || !Array.isArray(file.models)) {
    throw new Error('The workspace file is incomplete.');
  }
  const validVersion = (v: any) =>
    v && typeof v.id === 'string' && typeof v.datasetId === 'string' && v.dataset && Array.isArray(v.dataset.rows) && Array.isArray(v.dataset.columns);
  if (!file.versions.every(validVersion)) throw new Error('The workspace file has a damaged dataset version.');

  const db = await openDb();
  const tx = db.transaction(['versions', 'runs', 'models', 'session', 'rules', 'dashboards', 'registry', 'workflows'], 'readwrite');
  ['versions', 'runs', 'models', 'session', 'rules', 'dashboards', 'registry', 'workflows'].forEach(n => tx.objectStore(n).clear());
  (file.workflows ?? []).forEach(w => { if (w && typeof w.id === 'string') tx.objectStore('workflows').put(w); });
  (file.registry ?? []).forEach(m => { if (m && typeof m.id === 'string') tx.objectStore('registry').put(m); });
  (file.dashboards ?? []).forEach(d => { if (d && typeof d.id === 'string') tx.objectStore('dashboards').put(d); });
  Object.entries(file.rules ?? {}).forEach(([k, r]) => { if (Array.isArray(r)) tx.objectStore('rules').put(r, k); });
  file.versions.forEach(v => tx.objectStore('versions').put(v));
  file.runs.forEach(r => tx.objectStore('runs').put(r));
  file.models.forEach(({ bytesBase64, ...m }) => tx.objectStore('models').put({ ...m, bytes: fromBase64(bytesBase64) }));
  if (file.session) tx.objectStore('session').put(file.session, 'current');
  await done(tx);
  const maxTs = Math.max(0, ...file.versions.map(v => v.createdAt), ...file.runs.map(r => r.createdAt));
  lastTs = Math.max(lastTs, maxTs);
  return { versions: file.versions.length, runs: file.runs.length, models: file.models.length };
}

/** For tests: forget the open connection so a fresh database can be used. */
export function _resetConnectionForTests() {
  dbPromise?.then(db => db.close()).catch(() => {});
  dbPromise = null;
}
