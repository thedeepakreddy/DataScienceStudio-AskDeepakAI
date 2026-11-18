import { describe, expect, it } from 'vitest';
import { EngineApiError, type EngineClient } from './client';
import { contentHash, datasetCsv, syncDataset } from './datasetSync';
import { textColumns } from '../components/explore/TextAnalysis';
import type { Dataset } from '../types';

const dataset = (rows: Record<string, unknown>[], filename = 'reviews.csv'): Dataset => ({
  filename, rows, rowCount: rows.length, originalRowCount: rows.length,
  columns: Object.keys(rows[0]).map(name => ({ name, type: typeof rows[0][name] === 'number' ? 'numeric' : 'categorical', missingCount: 0, distinctCount: rows.length, statistics: {} })) as Dataset['columns'],
});

function fakeEngine() {
  const store = new Map<string, any>();
  const calls = { upload: 0, get: 0 };
  const client = {
    datasets: {
      get: async (id: string) => { calls.get++; if (!store.has(id)) throw new EngineApiError(404, 'not_found', 'gone'); return store.get(id); },
      upload: async (file: File, name: string) => {
        calls.upload++;
        const id = `ds_${(await contentHash(await file.text())).slice(0, 8)}`;
        const meta = { id, name, rows: (await file.text()).trim().split('\n').length - 1, columns: [] };
        store.set(id, meta);
        return meta;
      },
      uploadLarge: async () => { throw new Error('not expected'); },
    },
  } as unknown as EngineClient;
  return { client, calls, store };
}

describe('engine dataset sync', () => {
  it('uploads a version once and reuses it, and uploads an edited version again', async () => {
    const { client, calls } = fakeEngine();
    const a = dataset([{ review: 'great, works well', stars: 5 }, { review: 'broke after a day', stars: 1 }], `a-${Math.random()}.csv`);
    const first = await syncDataset(a, client);
    const again = await syncDataset(a, client);
    expect(again.id).toBe(first.id);
    expect(calls.upload).toBe(1);
    const edited = { ...a, rows: a.rows.slice(0, 1), rowCount: 1 };
    const second = await syncDataset(edited, client);
    expect(second.id).not.toBe(first.id);
    expect(calls.upload).toBe(2);
    expect(second.rows).toBe(1);
  });

  it('uploads again when the engine has lost the dataset', async () => {
    const { client, calls, store } = fakeEngine();
    const d = dataset([{ note: `unique ${Math.random()}`, n: 1 }]);
    const first = await syncDataset(d, client);
    store.clear();
    const again = await syncDataset(d, client);
    expect(again.id).toBe(first.id);
    expect(calls.upload).toBe(2);
  });

  it('shares one upload between simultaneous requests', async () => {
    const { client, calls } = fakeEngine();
    const d = dataset([{ note: `same time ${Math.random()}`, n: 2 }]);
    const [x, y] = await Promise.all([syncDataset(d, client), syncDataset(d, client)]);
    expect(x.id).toBe(y.id);
    expect(calls.upload).toBe(1);
  });

  it('writes CSV with quoting the engine can read', () => {
    expect(datasetCsv(dataset([{ t: 'a, "quoted" one', n: 1 }]))).toBe('t,n\n"a, ""quoted"" one",1\n');
  });
});

describe('text column detection', () => {
  it('finds free text, not short categories or ids', () => {
    const rows = Array.from({ length: 20 }, (_, i) => ({
      review: ['The delivery was late and the box was damaged', 'Lovely quality, would buy again', 'Support never answered my emails'][i % 3],
      city: ['Paris', 'Rome', 'Oslo'][i % 3], id: `ID-${i}`, stars: i % 5,
    }));
    expect(textColumns(dataset(rows))).toEqual(['review']);
  });
});
