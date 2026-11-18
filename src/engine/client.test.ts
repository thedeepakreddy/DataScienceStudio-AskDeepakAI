import { describe, expect, it } from 'vitest';
import { CAPABILITIES, CLIENT_ROUTES, ENGINE_ROUTES, EngineApiError, createEngineClient } from './client';
import { labelForUrl } from '../utils/jobs';

type Call = { url: string; init: RequestInit };

/** A fetch stub that answers from a queue and records every request. */
function stub(...answers: Array<{ status?: number; body: unknown }>) {
  const calls: Call[] = [];
  const fetch = async (url: string, init: RequestInit = {}) => {
    calls.push({ url, init });
    const a = answers.shift() ?? { body: null };
    return new Response(JSON.stringify(a.body), { status: a.status ?? 200, headers: { 'Content-Type': 'application/json' } });
  };
  return { calls, client: createEngineClient({ fetch, plainFetch: fetch, user: 'tester' }) };
}

describe('engine contract', () => {
  it('has a client method for every engine route, and no stale ones', () => {
    expect([...new Set(Object.values(CLIENT_ROUTES))].sort()).toEqual([...ENGINE_ROUTES].sort());
  });

  it('knows every capability', () => {
    expect(Object.keys(CAPABILITIES).length).toBeGreaterThanOrEqual(60);
    expect(CAPABILITIES['text.sentiment'].area).toBe('text');
    expect(CAPABILITIES['ml.automl'].heavy).toBe(true);
  });
});

describe('engine client', () => {
  it('runs a capability synchronously by default, with typed params', async () => {
    const { calls, client } = stub({ body: { status: 'done', cached: false, result: { chosen: { test: 'Welch t-test' }, manifest: {} }, runId: 'run_1' } });
    const r = await client.run('stats.compare', { a: 'y', b: 'g' }, { datasetId: 'ds_1', experiment: 'exp' });
    expect(r.status).toBe('done');
    expect(calls[0].url).toBe('/api/engine/run/stats.compare');
    const body = JSON.parse(String(calls[0].init.body));
    expect(body).toEqual({ dataset_id: 'ds_1', params: { a: 'y', b: 'g' }, seed: 42, mode: 'sync', use_cache: true, experiment: 'exp', tags: [] });
    expect((calls[0].init.headers as Record<string, string>)['X-Engine-User']).toBe('tester');
    // @ts-expect-error — `stats.compare` has no `column` parameter, and needs `a` and `b`.
    void (() => client.run('stats.compare', { column: 'x' }));
  });

  it('follows a queued job to its result and reports progress', async () => {
    const { calls, client } = stub(
      { body: { status: 'queued', runId: 'run_2', job: { id: 'job_1', status: 'queued', progress: 0, message: 'Waiting' } } },
      { body: { id: 'job_1', status: 'running', progress: 0.5, message: 'Tuning LightGBM' } },
      { body: { id: 'job_1', status: 'done', progress: 1, message: 'Done' } },
      { body: { champion: { label: 'LightGBM' }, manifest: {} } },
    );
    const seen: string[] = [];
    const res = await client.runAndWait('ml.automl', { target: 'churn' }, { mode: 'job', pollMs: 1, onProgress: (p, m) => seen.push(`${p}:${m}`) });
    expect(res.runId).toBe('run_2');
    expect((res as any).champion.label).toBe('LightGBM');
    expect(seen).toEqual(['0.5:Tuning LightGBM', '1:Done']);
    expect(calls.map(c => c.url)).toEqual(['/api/engine/run/ml.automl', '/api/engine/jobs/job_1', '/api/engine/jobs/job_1', '/api/engine/jobs/job_1/result']);
  });

  it('turns a failed job into an error with its code', async () => {
    const { client } = stub(
      { body: { status: 'queued', runId: 'r', job: { id: 'j', status: 'queued', progress: 0, message: '' } } },
      { body: { id: 'j', status: 'failed', progress: 0.2, message: 'Failed', error: { message: 'The target has only one class.', code: 'bad_request' } } },
    );
    await expect(client.runAndWait('ml.automl', { target: 'y' }, { pollMs: 1 })).rejects.toMatchObject({ code: 'bad_request', message: 'The target has only one class.' });
  });

  it('maps engine, validation and proxy errors', async () => {
    const { client } = stub(
      { status: 404, body: { detail: 'No model is registered as “x”.', code: 'not_found' } },
      { status: 422, body: { detail: [{ loc: ['body', 'rows'], msg: 'Field required' }] } },
      { status: 503, body: { error: 'The analysis engine is unavailable right now.' } },
    );
    await expect(client.models.get('x')).rejects.toEqual(new EngineApiError(404, 'not_found', 'No model is registered as “x”.'));
    await expect(client.models.predict('x', [])).rejects.toMatchObject({ status: 422, code: 'invalid_params', message: 'rows: Field required' });
    await expect(client.info()).rejects.toMatchObject({ status: 503, message: 'The analysis engine is unavailable right now.' });
  });

  it('uploads files as multipart without forcing a JSON content type', async () => {
    const { calls, client } = stub({ body: { id: 'ds_9', rows: 3 } });
    await client.datasets.upload(new Blob(['a,b\n1,2\n'], { type: 'text/csv' }), 'sales', 'sales.csv');
    expect(calls[0].init.body).toBeInstanceOf(FormData);
    expect((calls[0].init.headers as Record<string, string>)['Content-Type']).toBeUndefined();
    expect((calls[0].init.body as FormData).get('name')).toBe('sales');
  });

  it('builds query strings and links', () => {
    const client = createEngineClient({ fetch: async () => new Response('null'), base: '/api/engine/' });
    expect(client.models.downloadUrl('churn@production')).toBe('/api/engine/models/churn%40production/download');
    expect(client.runs.notebookUrl('run_1', 'https://engine.example')).toBe('/api/engine/runs/run_1/notebook?engine_url=https%3A%2F%2Fengine.example');
  });

  it('labels engine work in the jobs panel by capability', () => {
    expect(labelForUrl('/api/engine/run/ts.forecast')).toBe(CAPABILITIES['ts.forecast'].title);
    expect(labelForUrl('/api/engine/models/m/predict')).toBe('Predicting');
  });
});
