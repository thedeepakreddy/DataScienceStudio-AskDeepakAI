/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Typed client for Engine v2, used by every studio panel that talks to the engine.
 *
 * The browser never calls the engine directly: requests go to this app's
 * server at /api/engine/*, which adds the engine token and forwards them to
 * <engine>/v2/*. Long requests go through `apiFetch`, so they survive Safari's
 * 60-second limit and appear in the jobs panel.
 *
 * Parameter types come from contract.generated.ts, which is generated from the
 * engine itself; client.test.ts fails if an engine route has no method here.
 */
import { apiFetch } from '../utils/api';
import type { CapabilityName, CapabilityParams, EngineRoute } from './contract.generated';

export * from './contract.generated';

// ------------------------------------------------------------------ response shapes
export type ColumnKind = 'integer' | 'number' | 'boolean' | 'datetime' | 'date' | 'duration' | 'text';

export interface DatasetColumn {
  name: string;
  type: ColumnKind;
  storageType: string;
}

export interface DatasetMeta {
  id: string;
  fingerprint: string;
  name: string;
  rows: number;
  columns: DatasetColumn[];
  bytes?: number;
  createdAt?: string;
  source?: Record<string, unknown>;
  [key: string]: unknown;
}

export interface Manifest {
  engineVersion: string;
  python: string;
  libraries: Record<string, string>;
  capability: CapabilityName;
  params: Record<string, unknown>;
  paramsFingerprint: string;
  dataset: { id: string; name?: string; rows?: number; columns: number; fingerprint: string } | null;
  seed: number;
  finishedAt: string;
  durationMs: number;
}

/** Every capability result: its own fields plus notes and the reproducibility manifest. */
export type CapabilityResult<T = Record<string, unknown>> = T & { notes?: string[]; manifest: Manifest };

export type JobStatus = 'queued' | 'running' | 'done' | 'failed' | 'cancelled';

export interface EngineJob {
  id: string;
  kind: string;
  label: string;
  status: JobStatus;
  progress: number;
  message: string;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  error: { message: string; code: string } | null;
  cacheKey?: string | null;
}

export type RunMode = 'auto' | 'sync' | 'job';

export type RunResponse =
  | { status: 'done'; cached: boolean; result: CapabilityResult; runId: string }
  | { status: 'queued'; job: EngineJob; runId: string };

export interface RunRecord {
  id: string;
  capability: CapabilityName | string;
  experiment: string | null;
  tags: string[];
  source: 'api' | 'pipeline' | 'schedule';
  status: 'running' | 'queued' | 'done' | 'error';
  startedAt: string;
  finishedAt?: string;
  dataset: { id: string; name?: string; fingerprint?: string } | null;
  params: Record<string, unknown>;
  paramsFingerprint: string;
  seed: number;
  metrics?: Record<string, number | string | boolean>;
  modelId?: string;
  datasetId?: string;
  jobId?: string;
  error?: string;
  cached?: boolean;
  durationSeconds?: number;
}

export type ModelStage = 'none' | 'staging' | 'production' | 'archived';

export interface ModelMeta {
  id: string;
  name: string | null;
  version: number | null;
  stage: ModelStage;
  createdAt: string;
  task: 'classification' | 'regression';
  target: string;
  features: string[];
  featureTypes: Record<string, ColumnKind | null>;
  classes: string[] | null;
  positiveClass: string | null;
  family: string;
  label: string;
  scoring: string;
  cvMean: number;
  testMetrics: Record<string, number>;
  conformal: Record<string, number> | null;
  threshold: number | null;
  description?: string | null;
  tags?: string[];
  approvedBy?: string;
  approvedAt?: string;
  history?: Array<Record<string, unknown>>;
  [key: string]: unknown;
}

export interface Prediction {
  prediction: string | number;
  decision?: string;
  prediction_set?: string[];
  lower?: number;
  upper?: number;
  reasons?: Array<{ feature: string; value: unknown; typical: unknown; effect: number }>;
  [probability: `probability_${string}`]: number;
}

export interface PredictResponse {
  model: { id: string; name: string | null; version: number | null; stage: ModelStage };
  predictions: Prediction[];
  milliseconds: number;
}

export interface TextModelInfo {
  key: string;
  task: 'embedding' | 'sentiment' | 'zero_shot' | 'entities';
  title: string;
  languages: string;
  license: string;
  source: string;
  revision: string;
  dimensions: number | null;
  maxTokens: number;
  attribution: string | null;
  installed: boolean;
  default: boolean;
}

export interface EngineInfo {
  engineVersion: string;
  libraries: Record<string, string>;
  storage: 'local' | 'gcs';
  capabilities: number;
  areas: string[];
  maxUploadMb: number;
}

export interface PipelineStep<N extends CapabilityName = CapabilityName> {
  capability: N;
  /** A dataset id, or "$prev" for the dataset the previous step produced. */
  dataset_id?: string | null;
  /** Values may be "$prev" / "$prev_model" to use the previous step's dataset or model. */
  params?: Partial<CapabilityParams[N]> | Record<string, unknown>;
}

export interface PipelineBody {
  steps: PipelineStep[];
  seed?: number;
  experiment?: string | null;
  name?: string | null;
}

export interface Schedule {
  id: string;
  name: string | null;
  steps: PipelineStep[];
  seed: number;
  experiment: string | null;
  everyMinutes: number;
  enabled: boolean;
  createdAt: string;
  nextRunAt: number;
  lastRun?: { at: string; jobId: string };
  runs?: string[];
}

export interface AuditEvent {
  at: string;
  method: string;
  path: string;
  status: number;
  ms: number;
  actor: string | null;
  client: string | null;
}

export interface RunOptions {
  datasetId?: string | null;
  seed?: number;
  /** "sync" (default) keeps one request open, which Cloud Run needs to give the work CPU; "job" returns at once. */
  mode?: RunMode;
  useCache?: boolean;
  experiment?: string | null;
  tags?: string[];
  signal?: AbortSignal;
}

export interface WaitOptions extends RunOptions {
  /** Called with progress (0–1) and a message while a job runs. */
  onProgress?: (progress: number, message: string) => void;
  pollMs?: number;
  /** Give up after this long (the job keeps running on the engine). */
  timeoutMs?: number;
}

// ------------------------------------------------------------------ errors
/** An engine refusal ({detail, code}) or a studio proxy failure ({error}), with the HTTP status. */
export class EngineApiError extends Error {
  constructor(public status: number, public code: string, message: string) {
    super(message);
    this.name = 'EngineApiError';
  }
}

type Fetch = (url: string, init?: RequestInit) => Promise<Response>;

export interface EngineClientOptions {
  /** Where the studio's engine proxy lives. */
  base?: string;
  /** For long JSON calls (runs, pipelines, predictions): apiFetch by default (background job + jobs panel). */
  fetch?: Fetch;
  /** For quick reads and file uploads: the browser's fetch by default. */
  plainFetch?: Fetch;
  /** Sent as X-Engine-User, so the audit log and approvals know who acted. */
  user?: string;
}

const enc = encodeURIComponent;
const sleep = (ms: number, signal?: AbortSignal) => new Promise<void>((resolve, reject) => {
  const t = setTimeout(resolve, ms);
  signal?.addEventListener('abort', () => { clearTimeout(t); reject(new DOMException('Aborted', 'AbortError')); }, { once: true });
});

function query(params: Record<string, string | number | boolean | null | undefined>): string {
  const q = Object.entries(params).filter(([, v]) => v !== undefined && v !== null && v !== '').map(([k, v]) => `${enc(k)}=${enc(String(v))}`);
  return q.length ? `?${q.join('&')}` : '';
}

/**
 * Which engine route each client method calls. client.test.ts checks this
 * covers ENGINE_ROUTES exactly, so a new engine endpoint can't go unwired.
 */
export const CLIENT_ROUTES = {
  info: 'GET /v2/info',
  capabilities: 'GET /v2/capabilities',
  textModels: 'GET /v2/text-models',
  'datasets.list': 'GET /v2/datasets',
  'datasets.fromRows': 'POST /v2/datasets',
  'datasets.upload': 'POST /v2/datasets/upload',
  'datasets.uploadUrl': 'POST /v2/datasets/upload-url',
  'datasets.get': 'GET /v2/datasets/{ds_id}',
  'datasets.remove': 'DELETE /v2/datasets/{ds_id}',
  'datasets.preview': 'GET /v2/datasets/{ds_id}/preview',
  'datasets.query': 'POST /v2/datasets/{ds_id}/query',
  run: 'POST /v2/run/{name}',
  'jobs.list': 'GET /v2/jobs',
  'jobs.get': 'GET /v2/jobs/{job_id}',
  'jobs.result': 'GET /v2/jobs/{job_id}/result',
  'jobs.cancel': 'POST /v2/jobs/{job_id}/cancel',
  'models.list': 'GET /v2/models',
  'models.get': 'GET /v2/models/{ref}',
  'models.update': 'PATCH /v2/models/{model_id}',
  'models.remove': 'DELETE /v2/models/{model_id}',
  'models.card': 'GET /v2/models/{ref}/card',
  'models.downloadUrl': 'GET /v2/models/{ref}/download',
  'models.monitoring': 'GET /v2/models/{ref}/monitoring',
  'models.predict': 'POST /v2/models/{ref}/predict',
  'runs.list': 'GET /v2/runs',
  'runs.get': 'GET /v2/runs/{run_id}',
  'runs.compare': 'POST /v2/runs/compare',
  'runs.methods': 'GET /v2/runs/{run_id}/methods',
  'runs.notebookUrl': 'GET /v2/runs/{run_id}/notebook',
  experiments: 'GET /v2/experiments',
  'pipelines.run': 'POST /v2/pipelines/run',
  'schedules.list': 'GET /v2/schedules',
  'schedules.create': 'POST /v2/schedules',
  'schedules.update': 'PATCH /v2/schedules/{sid}',
  'schedules.remove': 'DELETE /v2/schedules/{sid}',
  'schedules.tick': 'POST /v2/schedules/tick',
  audit: 'GET /v2/audit',
} as const satisfies Record<string, EngineRoute>;

export function createEngineClient(options: EngineClientOptions = {}) {
  const base = (options.base ?? '/api/engine').replace(/\/+$/, '');
  const longFetch: Fetch = options.fetch ?? apiFetch;
  const plainFetch: Fetch = options.plainFetch ?? ((url, init) => fetch(url, init));
  const userHeader: Record<string, string> = options.user ? { 'X-Engine-User': options.user } : {};

  async function call<T>(method: string, path: string, body?: unknown, signal?: AbortSignal, long = false): Promise<T> {
    const isForm = typeof FormData !== 'undefined' && body instanceof FormData;
    const doFetch = long && !isForm ? longFetch : plainFetch;
    const res = await doFetch(`${base}${path}`, {
      method,
      headers: { ...userHeader, ...(body !== undefined && !isForm ? { 'Content-Type': 'application/json' } : {}) },
      body: body === undefined ? undefined : isForm ? (body as FormData) : JSON.stringify(body),
      signal,
    });
    const text = await res.text();
    let parsed: any = null;
    try { parsed = text ? JSON.parse(text) : null; } catch { /* not JSON */ }
    if (!res.ok) {
      const detail = parsed?.detail ?? parsed?.error;
      const message = typeof detail === 'string' ? detail
        : Array.isArray(detail) ? detail.map((d: any) => `${(d.loc || []).slice(1).join('.')}: ${d.msg}`).join('; ')
          : text || `HTTP ${res.status}`;
      throw new EngineApiError(res.status, parsed?.code ?? (res.status === 422 ? 'invalid_params' : 'http_error'), message);
    }
    return parsed as T;
  }

  const datasets = {
    list: () => call<DatasetMeta[]>('GET', '/datasets'),
    fromRows: (rows: Array<Record<string, unknown>>, name = 'dataset') => call<DatasetMeta>('POST', '/datasets', { name, rows }, undefined, true),
    /** Up to ~30 MB through Cloud Run; use uploadLarge for bigger files. */
    upload: (file: Blob, name?: string, filename = (file as File).name || 'upload.csv') => {
      const form = new FormData();
      form.append('file', file, filename);
      if (name) form.append('name', name);
      return call<DatasetMeta>('POST', '/datasets/upload', form);
    },
    uploadUrl: (filename: string, contentType = 'application/octet-stream') =>
      call<{ url: string; method: 'PUT'; headers: Record<string, string>; gcsUri: string; expiresInSeconds: number }>(
        'POST', '/datasets/upload-url', { filename, content_type: contentType }),
    get: (id: string) => call<DatasetMeta>('GET', `/datasets/${enc(id)}`),
    remove: (id: string) => call<{ deleted: string }>('DELETE', `/datasets/${enc(id)}`),
    preview: (id: string, limit = 50) => call<{ columns: string[]; rows: Array<Record<string, unknown>> }>('GET', `/datasets/${enc(id)}/preview${query({ limit })}`),
    /** Read-only SQL over the dataset, which is the view `data`. */
    query: (id: string, sql: string, limit = 1000) =>
      call<{ columns: string[]; rows: Array<Record<string, unknown>>; truncated?: boolean; [k: string]: unknown }>('POST', `/datasets/${enc(id)}/query`, { sql, limit }, undefined, true),
  };

  async function run<N extends CapabilityName>(name: N, params: CapabilityParams[N], opts: RunOptions = {}): Promise<RunResponse> {
    return call<RunResponse>('POST', `/run/${enc(name)}`, {
      dataset_id: opts.datasetId ?? null, params, seed: opts.seed ?? 42, mode: opts.mode ?? 'sync',
      use_cache: opts.useCache ?? true, experiment: opts.experiment ?? null, tags: opts.tags ?? [],
    }, opts.signal, true);
  }

  const jobs = {
    list: (limit = 50) => call<EngineJob[]>('GET', `/jobs${query({ limit })}`),
    get: (id: string) => call<EngineJob>('GET', `/jobs/${enc(id)}`),
    result: <T = Record<string, unknown>>(id: string) => call<CapabilityResult<T>>('GET', `/jobs/${enc(id)}/result`),
    cancel: (id: string) => call<EngineJob>('POST', `/jobs/${enc(id)}/cancel`),
  };

  /** Runs a capability and resolves with its result, following the job if the engine queued one. */
  async function runAndWait<N extends CapabilityName, T = Record<string, unknown>>(
    name: N, params: CapabilityParams[N], opts: WaitOptions = {},
  ): Promise<CapabilityResult<T> & { runId: string }> {
    const first = await run(name, params, opts);
    if (first.status === 'done') return { ...(first.result as CapabilityResult<T>), runId: first.runId };
    const started = Date.now();
    let job = first.job;
    let delay = opts.pollMs ?? 500;
    while (job.status === 'queued' || job.status === 'running') {
      if (opts.signal?.aborted) {
        await jobs.cancel(job.id).catch(() => undefined);
        throw new DOMException('Aborted', 'AbortError');
      }
      if (opts.timeoutMs && Date.now() - started > opts.timeoutMs) throw new EngineApiError(504, 'timeout', 'The analysis is taking too long; it is still running on the engine.');
      await sleep(delay, opts.signal).catch(async (err) => { await jobs.cancel(job.id).catch(() => undefined); throw err; });
      delay = Math.min(delay * 1.5, 3000);
      job = await jobs.get(job.id);
      opts.onProgress?.(job.progress, job.message);
    }
    if (job.status !== 'done') throw new EngineApiError(job.status === 'cancelled' ? 499 : 500, job.error?.code ?? job.status, job.error?.message ?? `The analysis ${job.status}.`);
    return { ...(await jobs.result<T>(job.id)), runId: first.runId };
  }

  /** Files bigger than Cloud Run's 32 MB request cap go straight to Cloud Storage, then are imported. */
  async function uploadLarge(file: File, name?: string, opts: WaitOptions = {}): Promise<DatasetMeta> {
    const target = await datasets.uploadUrl(file.name, file.type || 'application/octet-stream');
    const put = await fetch(target.url, { method: 'PUT', headers: target.headers, body: file, signal: opts.signal });
    if (!put.ok) throw new EngineApiError(put.status, 'upload_failed', `Uploading to Cloud Storage failed (HTTP ${put.status}).`);
    const res = await runAndWait('connect.gcs', { uri: target.gcsUri, name: name ?? file.name }, { ...opts, useCache: false });
    return (res as unknown as { dataset: DatasetMeta }).dataset;
  }

  const models = {
    list: (filter: { name?: string; stage?: ModelStage } = {}) => call<ModelMeta[]>('GET', `/models${query(filter)}`),
    /** `ref` is a model id, or name, name@production, name@staging, name@latest, name@v3. */
    get: (ref: string) => call<ModelMeta>('GET', `/models/${enc(ref)}`),
    update: (id: string, patch: { stage?: ModelStage; name?: string; description?: string; tags?: string[]; approved_by?: string; note?: string }) =>
      call<ModelMeta>('PATCH', `/models/${enc(id)}`, patch),
    remove: (id: string) => call<{ deleted: string }>('DELETE', `/models/${enc(id)}`),
    card: (ref: string) => call<{ id: string; markdown: string }>('GET', `/models/${enc(ref)}/card`),
    /** A link the browser can open to download the model file (through the studio proxy). */
    downloadUrl: (ref: string) => `${base}/models/${enc(ref)}/download`,
    monitoring: (ref: string, limit = 100) => call<Array<Record<string, unknown>>>('GET', `/models/${enc(ref)}/monitoring${query({ limit })}`),
    predict: (ref: string, rows: Array<Record<string, unknown>>, opts: { explain?: boolean; reasons?: number; log?: boolean } = {}) =>
      call<PredictResponse>('POST', `/models/${enc(ref)}/predict`, { rows, explain: opts.explain ?? false, reasons: opts.reasons ?? 3, log: opts.log ?? true }, undefined, true),
  };

  const runs = {
    list: (filter: { experiment?: string; capability?: string; limit?: number } = {}) => call<RunRecord[]>('GET', `/runs${query(filter)}`),
    get: (id: string) => call<RunRecord & { result: CapabilityResult | null; job?: EngineJob }>('GET', `/runs/${enc(id)}`),
    compare: (ids: string[]) => call<{
      runs: Array<Pick<RunRecord, 'id' | 'capability' | 'experiment' | 'startedAt' | 'dataset' | 'seed' | 'status'>>;
      params: Array<{ param: string; values: unknown[]; differs: boolean }>;
      metrics: Array<{ metric: string; values: unknown[] }>;
    }>('POST', '/runs/compare', { ids }),
    methods: (id: string) => call<{ runId: string; capability: string; text: string; references: string[]; markdown: string }>('GET', `/runs/${enc(id)}/methods`),
    /** A link that downloads a Jupyter notebook reproducing the run. */
    notebookUrl: (id: string, engineUrl?: string) => `${base}/runs/${enc(id)}/notebook${query({ engine_url: engineUrl })}`,
  };

  const schedules = {
    list: () => call<Schedule[]>('GET', '/schedules'),
    create: (body: PipelineBody & { every_minutes: number; enabled?: boolean; start_at?: number }) => call<Schedule>('POST', '/schedules', body),
    update: (id: string, patch: { enabled?: boolean; every_minutes?: number; name?: string }) => call<Schedule>('PATCH', `/schedules/${enc(id)}`, patch),
    remove: (id: string) => call<{ deleted: string }>('DELETE', `/schedules/${enc(id)}`),
    tick: (wait = false) => call<{ started: Array<{ schedule: string; job: string; status?: JobStatus }> }>('POST', `/schedules/tick${query({ wait })}`, undefined, undefined, wait),
  };

  return {
    info: () => call<EngineInfo>('GET', '/info'),
    capabilities: (area?: string) => call<Array<{ name: CapabilityName; area: string; title: string; summary: string; needsDataset: boolean; heavy: boolean;
      tags: string[]; cacheable: boolean; params: Record<string, unknown> }>>('GET', `/capabilities${query({ area })}`),
    textModels: () => call<TextModelInfo[]>('GET', '/text-models'),
    datasets: { ...datasets, uploadLarge },
    run,
    runAndWait,
    jobs,
    models,
    runs,
    experiments: () => call<Array<{ experiment: string; runs: number; capabilities: string[]; lastRunAt: string }>>('GET', '/experiments'),
    pipelines: {
      run: (body: PipelineBody) => call<{ status: 'queued'; job: EngineJob }>('POST', '/pipelines/run', body, undefined, true),
    },
    schedules,
    audit: (limit = 200) => call<AuditEvent[]>('GET', `/audit${query({ limit })}`),
  };
}

export type EngineClient = ReturnType<typeof createEngineClient>;

/** The studio's shared client. */
export const engine = createEngineClient();
