import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  MAX_VERSIONS_PER_DATASET, _resetConnectionForTests, clearWorkspace, getVersion, listRuns,
  listVersions, loadSession, recordRun, saveSession, saveVersion,
} from './workspaceStore';
import type { Dataset } from '../types';

const ds = (n: number): Dataset => ({
  filename: 'sales.csv',
  rows: Array.from({ length: n }, (_, i) => ({ id: i })),
  rowCount: n,
  originalRowCount: n,
  columns: [{ name: 'id', type: 'numeric', missingCount: 0, distinctCount: n, statistics: {} }],
});

beforeEach(() => {
  _resetConnectionForTests();
  globalThis.indexedDB = new IDBFactory();
});

describe('workspace store', () => {
  it('saves versions with lineage', async () => {
    const root = await saveVersion(ds(3), { parentId: null, label: 'Imported' });
    const child = await saveVersion(ds(2), { parentId: root.id, label: 'Removed 1 row' });
    expect(child.datasetId).toBe(root.datasetId);
    expect(child.parentId).toBe(root.id);
    const all = await listVersions(root.datasetId);
    expect(all.map(v => v.label)).toEqual(['Imported', 'Removed 1 row']);
    expect((await getVersion(child.id))?.dataset.rows).toHaveLength(2);
  });

  it('starts a separate dataset for a new import', async () => {
    const a = await saveVersion(ds(3), { parentId: null, label: 'Imported' });
    const b = await saveVersion(ds(4), { parentId: null, label: 'Imported' });
    expect(a.datasetId).not.toBe(b.datasetId);
  });

  it('prunes old versions but keeps the import and pinned ones', async () => {
    const root = await saveVersion(ds(1), { parentId: null, label: 'Imported' });
    let parent = root.id;
    const pinned = (await saveVersion(ds(1), { parentId: parent, label: 'v1' })).id;
    parent = pinned;
    for (let i = 0; i < MAX_VERSIONS_PER_DATASET + 5; i++) {
      parent = (await saveVersion(ds(1), { parentId: parent, label: `step ${i}`, keep: [pinned] })).id;
    }
    const all = await listVersions(root.datasetId);
    expect(all).toHaveLength(MAX_VERSIONS_PER_DATASET);
    expect(all[0].id).toBe(root.id);
    expect(all.some(v => v.id === pinned)).toBe(true);
    expect(all[all.length - 1].id).toBe(parent);
  });

  it('records runs newest first', async () => {
    await recordRun({ kind: 'ai-advisory', versionId: null, title: 'First', summary: '', status: 'succeeded' });
    await recordRun({ kind: 'model-training', versionId: null, title: 'Second', summary: '', status: 'failed', error: 'x' });
    expect((await listRuns()).map(r => r.title)).toEqual(['Second', 'First']);
  });

  it('saves the session and clears everything', async () => {
    const v = await saveVersion(ds(2), { parentId: null, label: 'Imported' });
    await saveSession({ activeVersionId: v.id, originalVersionId: v.id, activeTab: 'eda', mlResult: null, aiAnalysis: { a: 1 } });
    expect((await loadSession())?.activeTab).toBe('eda');
    await clearWorkspace();
    expect(await loadSession()).toBeUndefined();
    expect(await getVersion(v.id)).toBeUndefined();
    expect(await listRuns()).toEqual([]);
  });
});
