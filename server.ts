/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import express from 'express';
import path from 'path';
import fs from 'fs';
import { randomUUID } from 'crypto';
import { AsyncLocalStorage } from 'async_hooks';
import { buildAdvisoryFallback } from './src/utils/advisoryFallback';
import { buildQualityFixes } from './src/utils/qualityAuditFixes';
import { type GeminiFailureKind, classifyGeminiError, describeGeminiFailure, mostTellingFailure, summarizeGeminiError } from './geminiHealth';
import { initializeApp, cert } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import { GoogleGenAI, Type, FunctionCallingConfigMode } from '@google/genai';
import { FALLBACK_GEMINI_MODELS, findFreeModels, rankGeminiModels, withFallback, type ListedModel, type ProbeOutcome } from './geminiModels';
import { arcConfigFromEnv, arcGenerateContent, describeArcFailure } from './arcClient';

const app = express();
// Render (and most hosts) put the app behind one proxy; trust it so req.ip is the visitor's address.
app.set('trust proxy', 1);
const PORT = process.env.PORT ? parseInt(process.env.PORT, 10) : 3000;

app.use(express.json({ limit: '50mb' }));

// --- VISITOR-SUPPLIED GEMINI KEY (optional) ---
// Visitors can add their own Gemini API key in the app. It is kept in their
// browser and sent with their own AI requests in the X-Gemini-Api-Key header.
// The server only holds it in memory for the duration of that request (via
// AsyncLocalStorage, so background jobs keep it too) and uses it only when
// the app's own key can't answer - out of quota, rejected or missing. It is
// never stored, never logged and never sent anywhere except Google.
type AiKeyContext = {
  userKey: string | null;
  /** What happened when this request fell back to the visitor's key, if it did. */
  visitorKeyResult?: { ok: true } | { ok: false; kind: GeminiFailureKind; detail: string };
};
const aiKeyContext = new AsyncLocalStorage<AiKeyContext>();
// Classic keys (AIza…) and newer AI Studio keys, which can contain dots (AQ.…).
const USER_KEY_SHAPE = /^[A-Za-z0-9._~+/=-]{20,300}$/;

app.use('/api', (req, _res, next) => {
  const raw = req.get('X-Gemini-Api-Key');
  const userKey = raw && USER_KEY_SHAPE.test(raw.trim()) ? raw.trim() : null;
  aiKeyContext.run({ userKey }, () => next());
});

const PLACEHOLDER_KEYS = new Set(['MY_GEMINI_API_KEY', 'DUMMY_KEY_FALLBACK']);
/** The app owner's key from the environment, if a real one is configured. */
function ownerGeminiKey(): string | null {
  const key = process.env.GEMINI_API_KEY;
  return key && !PLACEHOLDER_KEYS.has(key) ? key : null;
}
/** The visitor's own key for the current request, if they supplied one. */
function visitorGeminiKey(): string | null {
  return aiKeyContext.getStore()?.userKey ?? null;
}
// --- ARC (optional) ---
// With ARC_BASE_URL and ARC_API_KEY set, every AI call goes to ARC first: ARC holds the owner's
// provider keys (several per provider) and picks a healthy free model and key, with its own
// fallback. GEMINI_API_KEY and visitors' own keys stay as fallbacks if ARC can't answer.
const ARC = arcConfigFromEnv();
if (ARC) console.log(`[AskDeepakAI AI] Using ARC (${ARC.model}) first; Gemini keys are the fallback.`);

/** True when this request can reach an AI model: through ARC or with either Gemini key. */
function aiKeyAvailable(): boolean {
  return !!ARC || !!ownerGeminiKey() || !!visitorGeminiKey();
}

// --- LONG-RUNNING REQUESTS AS BACKGROUND JOBS ---
// Training, a cold ML-service wake-up or a retried Gemini call can each take
// well over a minute. A single request held open that long is fragile: WebKit
// (Safari, and every browser on iOS) drops a request that has been silent for
// 60 seconds and reports only "Load failed", switching tabs on a phone can
// abort it, and some proxies cut idle connections too.
//
// So when the client asks for it (X-Async-Job: 1), a POST is answered at once
// with a job id, the route's normal handler keeps running in the background
// with its response captured here instead of written to the socket, and the
// client collects the result from GET /api/jobs/:id with short polls. Handlers
// need no changes - they still just call res.status(...).json(...).
type AsyncJob = { done: boolean; status: number; body: unknown; finishedAt: number | null };
const asyncJobs = new Map<string, AsyncJob>();
const ASYNC_JOB_RESULT_TTL_MS = 10 * 60 * 1000;   // how long a finished result waits to be collected
const ASYNC_JOB_MAX_AGE_MS = 30 * 60 * 1000;      // a job that never finishes is dropped after this

setInterval(() => {
  const now = Date.now();
  for (const [id, job] of asyncJobs) {
    const createdAt = Number(id.split('-')[0]);
    if ((job.finishedAt && now - job.finishedAt > ASYNC_JOB_RESULT_TTL_MS) || now - createdAt > ASYNC_JOB_MAX_AGE_MS) {
      asyncJobs.delete(id);
    }
  }
}, 60 * 1000).unref();

app.use('/api', (req, res, next) => {
  if (req.method !== 'POST' || req.get('X-Async-Job') !== '1') return next();

  const jobId = `${Date.now()}-${randomUUID()}`;
  const job: AsyncJob = { done: false, status: 200, body: null, finishedAt: null };
  asyncJobs.set(jobId, job);
  res.status(202).json({ jobId });

  // From here on the handler's response is captured rather than sent.
  let status = 200;
  const finish = (body: unknown) => {
    if (job.done) return;
    job.done = true;
    job.status = status;
    job.body = body;
    job.finishedAt = Date.now();
  };
  const captured = res as any;
  captured.status = (code: number) => { status = code; return res; };
  captured.sendStatus = (code: number) => { status = code; finish(null); return res; };
  captured.json = (body: unknown) => { finish(body); return res; };
  captured.send = (body: unknown) => { finish(body); return res; };
  captured.end = () => { finish(null); return res; };
  captured.set = captured.setHeader = captured.type = () => res;
  Object.defineProperty(captured, 'headersSent', { get: () => job.done, configurable: true });

  next();
});

app.get('/api/jobs/:jobId', (req, res) => {
  const job = asyncJobs.get(req.params.jobId);
  res.set('Cache-Control', 'no-store');
  if (!job) return res.status(404).json({ error: 'Unknown or expired job.' });
  if (!job.done) return res.status(202).json({ done: false });
  res.json({ done: true, status: job.status, body: job.body });
});

// --- FIREBASE ADMIN INITIALIZATION ---
let db: FirebaseFirestore.Firestore | null = null;
try {
  const serviceAccountPath = path.join(process.cwd(), 'serviceAccountKey.json');
  if (fs.existsSync(serviceAccountPath)) {
    const serviceAccount = JSON.parse(fs.readFileSync(serviceAccountPath, 'utf8'));
    initializeApp({
      credential: cert(serviceAccount)
    });
    db = getFirestore();
    console.log('[Firebase] Admin SDK initialized via local serviceAccountKey.json.');
  } else if (process.env.FIREBASE_SERVICE_ACCOUNT) {
    const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
    initializeApp({
      credential: cert(serviceAccount)
    });
    db = getFirestore();
    console.log('[Firebase] Admin SDK initialized via FIREBASE_SERVICE_ACCOUNT environment variable.');
  } else {
    console.warn('[Firebase] Warning: No service account credentials found. Firestore logging will be disabled.');
  }
} catch (error) {
  console.error('[Firebase] Failed to initialize Admin SDK:', error);
}

// Helper to initialize GoogleGenAI client (Lazy initialization)
let aiClient: GoogleGenAI | null = null;
function getGeminiClient(): GoogleGenAI {
  if (!aiClient) {
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) {
      console.warn('GEMINI_API_KEY is missing. Falling back to local/intelligence rules.');
    }
    aiClient = new GoogleGenAI({
      apiKey: apiKey || 'DUMMY_KEY_FALLBACK',
      httpOptions: {
        headers: {
          'User-Agent': 'aistudio-build',
        },
      },
    });
  }
  return aiClient;
}

// --- GEMINI HEALTH ---
// Every AI feature degrades to a built-in template when Gemini fails, which is
// right for the feature but used to leave no trace outside the server log: the
// app just looked like "Gemini isn't responding". The outcome of each real call
// is recorded here and exposed at /api/ai/status so the UI can say why.
const geminiHealth: {
  lastOk: { at: number; model: string } | null;
  lastFailure: { at: number; kind: GeminiFailureKind; models: string[]; detail: string; via?: 'arc' } | null;
} = { lastOk: null, lastFailure: null };

// Which models to ask, best first. It starts as the built-in list and is
// replaced by what Google says this key can use (ListModels), so a retired
// model never needs a code change: discovery runs at start-up, again on its
// own when a model stops working, and from the "Update to latest model" button.
let GEMINI_MODELS = [...FALLBACK_GEMINI_MODELS];
// 'free' (the default): only models that answer on the key without billing,
// found by one tiny test call each. 'latest': the newest models, paid or free.
type GeminiTier = 'free' | 'latest';
let geminiTier: GeminiTier = process.env.GEMINI_MODEL_TIER === 'latest' ? 'latest' : 'free';
const geminiModelInfo: {
  source: 'built-in' | 'google'; tier: GeminiTier; updatedAt: number | null; models: string[]; error: string | null;
  tested: { model: string; outcome: ProbeOutcome }[];
} = { source: 'built-in', tier: geminiTier, updatedAt: null, models: GEMINI_MODELS, error: null, tested: [] };
const MODEL_REFRESH_MIN_MS = 10 * 60 * 1000;
let modelRefresh: Promise<boolean> | null = null;

async function listGeminiModels(apiKey: string): Promise<ListedModel[]> {
  const out: ListedModel[] = [];
  let pageToken = '';
  for (let page = 0; page < 5; page++) {
    const url = `https://generativelanguage.googleapis.com/v1beta/models?pageSize=1000${pageToken ? `&pageToken=${encodeURIComponent(pageToken)}` : ''}`;
    const res = await fetch(url, { headers: { 'x-goog-api-key': apiKey }, signal: AbortSignal.timeout(10_000) });
    if (!res.ok) throw new Error(`Google answered HTTP ${res.status} when listing models.`);
    const body = await res.json() as { models?: ListedModel[]; nextPageToken?: string };
    out.push(...(body.models ?? []));
    if (!body.nextPageToken) break;
    pageToken = body.nextPageToken;
  }
  return out;
}

/** Asks Google for the newest usable models; true when the list changed. `force` skips the 10-minute limit. */
function refreshGeminiModels(force = false, key = ownerGeminiKey() || visitorGeminiKey(), tier: GeminiTier = geminiTier): Promise<boolean> {
  if (!key) return Promise.resolve(false);
  if (modelRefresh) return modelRefresh;
  if (!force && geminiModelInfo.updatedAt && Date.now() - geminiModelInfo.updatedAt < MODEL_REFRESH_MIN_MS) return Promise.resolve(false);
  modelRefresh = (async () => {
    try {
      const listed = await listGeminiModels(key);
      let next: string[];
      let tested: { model: string; outcome: ProbeOutcome }[] = [];
      if (tier === 'free') {
        // Flash and Flash-Lite first: they're the ones with a free tier.
        const candidates = rankGeminiModels(listed, 12).sort((a, b) => Number(/pro/.test(a)) - Number(/pro/.test(b)));
        const client = new GoogleGenAI({ apiKey: key });
        const found = await findFreeModels(candidates, async model => {
          await client.models.generateContent({ model, contents: 'Reply with OK', config: { maxOutputTokens: 4, abortSignal: AbortSignal.timeout(12_000) } as any });
        });
        tested = found.results;
        if (!found.free.length) throw new Error(found.results.some(r => r.outcome === 'no_credits')
          ? 'the key’s Google project has no prepaid credits left — add credits in AI Studio, or use a key from a project without billing'
          : found.results.some(r => r.outcome === 'bad_key') ? 'Google rejected the key'
            : found.results.every(r => r.outcome === 'busy') ? 'every model was busy or over quota just now; try again in a few minutes'
              : 'no free-tier model answered on this key');
        next = found.free;
      } else {
        const ranked = rankGeminiModels(listed);
        if (!ranked.length) throw new Error('Google listed no text models this key can use.');
        next = withFallback(ranked);
      }
      const changed = next.join() !== GEMINI_MODELS.join();
      GEMINI_MODELS = next;
      geminiTier = tier;
      Object.assign(geminiModelInfo, { source: 'google', tier, updatedAt: Date.now(), models: next, error: null, tested });
      console.log(`[AskDeepakAI Gemini Client] Models from Google: ${next.join(', ')}`);
      return changed;
    } catch (err: any) {
      Object.assign(geminiModelInfo, { updatedAt: Date.now(), error: String(err?.message || err) });
      console.log(`[AskDeepakAI Gemini Client] Couldn't list models (${geminiModelInfo.error}); keeping ${GEMINI_MODELS.join(', ')}.`);
      return false;
    } finally {
      modelRefresh = null;
    }
  })();
  return modelRefresh;
}

class GeminiAttemptError extends Error {
  constructor(public lastError: any, public kinds: GeminiFailureKind[]) {
    super(String(lastError?.message || lastError || 'No response from any Gemini model.'));
  }
}

// A whole AI call (every model, every retry) gives up after this, so no feature
// waits on Gemini longer than this before using its built-in version.
const GEMINI_CALL_BUDGET_MS = 25_000;

// One key, every model in turn, with backoff on temporary errors (503/429).
async function runAcrossModels(client: GoogleGenAI, params: { contents: any; config?: any }) {
  let lastError: any = null;
  const kinds: GeminiFailureKind[] = [];
  const deadline = Date.now() + GEMINI_CALL_BUDGET_MS;

  for (const model of GEMINI_MODELS) {
    if (Date.now() > deadline) break;
    let attempts = 3;
    let delay = 600; // start with 600ms backoff delay

    while (attempts > 0 && Date.now() <= deadline) {
      try {
        console.log(`[AskDeepakAI Gemini Client] Querying model "${model}" (retries available: ${attempts})...`);
        const response = await client.models.generateContent({
          model: model,
          contents: params.contents,
          config: params.config,
        });
        if (response) {
          console.log(`[AskDeepakAI Gemini Client] Loaded analytical response successfully from model: "${model}"`);
          return { response, model };
        }
      } catch (err: any) {
        lastError = err;
        kinds.push(classifyGeminiError(err));
        const errMsg = (err?.message || String(err)).toLowerCase();

        // Match standard highly loaded/throttled or service error patterns
        const isTemporary = errMsg.includes('503') ||
                            errMsg.includes('500') ||
                            errMsg.includes('429') ||
                            errMsg.includes('unavailable') ||
                            errMsg.includes('overloaded') ||
                            errMsg.includes('high demand') ||
                            errMsg.includes('rate limit');

        if (isTemporary && attempts > 1) {
          console.log(`[AskDeepakAI Gemini Client] Service is busy at peak load. Auto-retrying connection in ${delay}ms...`);
          await new Promise(resolve => setTimeout(resolve, delay));
          delay *= 2.2; // robust factor for exponential backoff retry interval
          attempts--;
        } else {
          console.log(`[AskDeepakAI Gemini Client] Pipeline status checked on "${model}". Advancing fallback options...`);
          break; // break loop to advance to the next candidate model
        }
      }
    }
  }
  throw new GeminiAttemptError(lastError, kinds);
}

// Every AI call goes through here. The app's own key is used first; a
// visitor's own key (if they added one) is used only when that fails - out of
// quota, rejected, missing or unavailable - so visitors' quota is only spent
// when it is actually needed. geminiHealth tracks the app's own key; the
// outcome with a visitor key is kept on that visitor's request only.
// (`_client` is kept for the existing call sites; the key decides the client.)
// When the app's own key has just failed on every model (out of quota, rejected,
// Gemini down), it rests for a while: features use their built-in versions at
// once instead of each one waiting through the same retries again.
const OWNER_KEY_REST_MS = 5 * 60 * 1000;
let ownerKeyRestingUntil = 0;

async function generateContentWithRetry(_client: GoogleGenAI, params: {
  contents: any;
  config?: any;
}) {
  const owner = ownerGeminiKey();
  const visitor = visitorGeminiKey();

  if (ARC) {
    try {
      const response = await arcGenerateContent({ ...ARC, timeoutMs: GEMINI_CALL_BUDGET_MS }, params);
      geminiHealth.lastOk = { at: Date.now(), model: `ARC: ${response.model ?? ARC.model}` };
      return response;
    } catch (err: any) {
      const kind = classifyGeminiError(err);
      geminiHealth.lastFailure = { at: Date.now(), kind, models: [`ARC (${ARC.model})`], detail: summarizeGeminiError(err), via: 'arc' };
      if (!owner && !visitor) throw err;
      console.log(`[AskDeepakAI AI] ARC could not answer (${kind}) - trying the Gemini key directly.`);
    }
  }

  if (!owner && !visitor) {
    geminiHealth.lastFailure = { at: Date.now(), kind: 'no_key', models: [], detail: 'GEMINI_API_KEY is not set.' };
    throw new Error('GEMINI_API_KEY is not set on the server.');
  }

  const ownerResting = Date.now() < ownerKeyRestingUntil;
  if (owner && ownerResting && !visitor) {
    throw new Error('AI is unavailable right now (the last attempt failed); using the built-in version.');
  }

  if (owner && !ownerResting) {
    try {
      let result: { response: any; model: string };
      try {
        result = await runAcrossModels(getGeminiClient(), params);
      } catch (first) {
        // A retired or renamed model: ask Google for the current ones and try once more.
        if (!((first as GeminiAttemptError).kinds ?? []).includes('model_unavailable') || !(await refreshGeminiModels(true, owner))) throw first;
        result = await runAcrossModels(getGeminiClient(), params);
      }
      const { response, model } = result;
      geminiHealth.lastOk = { at: Date.now(), model };
      ownerKeyRestingUntil = 0;
      return response;
    } catch (err) {
      const attempt = err as GeminiAttemptError;
      ownerKeyRestingUntil = Date.now() + OWNER_KEY_REST_MS;
      geminiHealth.lastFailure = {
        at: Date.now(),
        kind: mostTellingFailure(attempt.kinds ?? []),
        models: GEMINI_MODELS,
        detail: summarizeGeminiError(attempt.lastError ?? err),
      };
      if (!visitor) throw attempt.lastError ?? err;
      console.log("[AskDeepakAI Gemini Client] The app's key could not answer - trying the visitor's own key.");
    }
  }

  const store = aiKeyContext.getStore();
  try {
    const { response } = await runAcrossModels(new GoogleGenAI({ apiKey: visitor! }), params);
    if (store) store.visitorKeyResult = { ok: true };
    return response;
  } catch (err) {
    const attempt = err as GeminiAttemptError;
    if (store) {
      store.visitorKeyResult = {
        ok: false,
        kind: mostTellingFailure(attempt.kinds ?? []),
        detail: summarizeGeminiError(attempt.lastError ?? err),
      };
    }
    throw attempt.lastError ?? err;
  }
}

// --- REAL ML COMPUTE: PYTHON MLOPS MICROSERVICE CLIENT ---
// Every metric shown in the ML Pipeline UI must come from a model that was
// actually fit and evaluated by this service — never from Gemini, and never
// from a client-side formula. If the service is unreachable, callers must
// surface a clear error instead of silently substituting fabricated numbers.
// ONE ML service for everything: the wake button, the status probe, training,
// EDA and model downloads all resolve their target through getMlServiceUrl().
// (They used to disagree: with ML_SERVICE_URL unset, "wake" primed the hosted
// service while training still called 127.0.0.1:8000 - so the button reported
// the engine as on and the very next training run failed as "unreachable".)
//
//   1. ML_SERVICE_URL, when explicitly configured (production, docker).
//   2. Otherwise a Python service running on this machine, if one answers.
//   3. Otherwise the hosted free-tier deployment below.
const ML_SERVICE_LOCAL_URL = 'http://127.0.0.1:8000';
// The engine on Google Cloud Run (it also serves every v1 endpoint the old Render ML service had).
const ML_SERVICE_PUBLIC_URL = 'https://askdeepakai-engine-novnmz6s3a-uc.a.run.app';
const ML_SERVICE_CONFIGURED_URL = (process.env.ML_SERVICE_URL || '').replace(/\/+$/, '') || null;

// Shared secret for the engine (Cloud Run): when ENGINE_TOKEN is set here and on the
// engine, every call carries it in X-Engine-Token. It stays on the server; the
// browser only ever talks to this app.
const ENGINE_TOKEN = (process.env.ENGINE_TOKEN || '').trim();
function mlHeaders(extra: Record<string, string> = {}): Record<string, string> {
  return ENGINE_TOKEN ? { ...extra, 'X-Engine-Token': ENGINE_TOKEN } : extra;
}

// Re-check which service to use now and then, so starting (or stopping) a local
// uvicorn mid-session is picked up without restarting this server.
const ML_SERVICE_RESOLVE_TTL_MS = 30000;
let resolvedMlService: { url: string; at: number } | null = null;

// Newer builds of the ML service serve a "keep this tab open" page at "/" and
// say so in /health. Older deployments answer "/" with {"detail":"Not Found"},
// so remember what each service told us and only link to a page that exists.
const mlServicesWithKeepAlivePage = new Set<string>();
function noteMlServiceHealth(url: string, health: any) {
  if (health?.keep_alive_page === true) mlServicesWithKeepAlivePage.add(url);
  else mlServicesWithKeepAlivePage.delete(url);
}

async function isMlServiceListening(url: string, timeoutMs: number): Promise<boolean> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(`${url}/health`, { method: 'GET', signal: controller.signal });
    if (response.ok) noteMlServiceHealth(url, await response.json().catch(() => null));
    return response.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timeoutId);
  }
}

async function getMlServiceUrl(): Promise<string> {
  if (ML_SERVICE_CONFIGURED_URL) return ML_SERVICE_CONFIGURED_URL;
  if (resolvedMlService && Date.now() - resolvedMlService.at < ML_SERVICE_RESOLVE_TTL_MS) {
    return resolvedMlService.url;
  }
  const localIsUp = await isMlServiceListening(ML_SERVICE_LOCAL_URL, 1500);
  resolvedMlService = { url: localIsUp ? ML_SERVICE_LOCAL_URL : ML_SERVICE_PUBLIC_URL, at: Date.now() };
  return resolvedMlService.url;
}

// A link a person can open in their own browser to wake the service by hand -
// only meaningful for a public https host, not localhost or a docker hostname.
function mlServiceOpenUrl(url: string): string | null {
  if (!url.startsWith('https://')) return null;
  return mlServicesWithKeepAlivePage.has(url) ? `${url}/` : `${url}/health`;
}

// AutoML mode fits 5 real candidate models (with cross-validation refits) on
// the full dataset; on a free-tier host's slower, shared CPU a several
// -thousand-row dataset can genuinely take a few minutes, not seconds.
const ML_SERVICE_TIMEOUT_MS = 240000;

// Free-tier PaaS hosts (Render included) spin an idle service down and take
// ~25-60s to cold-start the next request; during that window their own edge
// proxy - not this app's Python service - answers with a bare 502/503/504
// before the origin container has registered. Retrying with backoff rides
// out that window instead of surfacing the platform's raw gateway HTML page.
const GATEWAY_RETRY_STATUSES = new Set([502, 503, 504]);
const GATEWAY_RETRY_DELAYS_MS = [3000, 5000, 8000, 12000, 18000, 25000]; // ~71s total coverage

// Free-tier hosts spin an idle instance down after ~15 minutes, and the next
// request then pays a cold start. The /api/ml-service/wake endpoint below lets
// the UI pay that cost up front, in the background, before any real training.
// A cold start is ~25-60s, so poll patiently but cap the whole thing well under
// a browser's patience. Each individual probe gets a short timeout so a hung
// socket doesn't eat the entire budget.
const WAKE_PROBE_TIMEOUT_MS = 20000;
const WAKE_TOTAL_BUDGET_MS = 120000;
const WAKE_POLL_INTERVAL_MS = 4000;

type WakeOutcome = {
  status: 'awake';
  url: string;
  attempts: number;
  elapsedMs: number;
  coldStart: boolean;
  service: any;
};

async function wakeMlService(baseUrl: string): Promise<WakeOutcome> {
  const startedAt = Date.now();
  let attempts = 0;
  let lastDetail = 'no response';

  while (Date.now() - startedAt < WAKE_TOTAL_BUDGET_MS) {
    attempts++;
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), WAKE_PROBE_TIMEOUT_MS);
    try {
      const response = await fetch(`${baseUrl}/health`, {
        method: 'GET',
        signal: controller.signal,
      });

      if (response.ok) {
        const service = await response.json().catch(() => null);
        noteMlServiceHealth(baseUrl, service);
        return {
          status: 'awake',
          url: baseUrl,
          attempts,
          elapsedMs: Date.now() - startedAt,
          // More than one probe means the first one hit a sleeping instance.
          coldStart: attempts > 1,
          service,
        };
      }

      lastDetail = `HTTP ${response.status}`;
      // Anything that is not a gateway status is the service itself answering
      // with a real error - retrying will not change the outcome.
      if (!GATEWAY_RETRY_STATUSES.has(response.status)) {
        throw new Error(`ML service responded with ${lastDetail}.`);
      }
      console.log(`[AskDeepakAI ML wake] ${lastDetail} from ${baseUrl} - still cold, probe ${attempts}...`);
    } catch (err: any) {
      if (err?.name === 'AbortError') {
        lastDetail = `probe timed out after ${WAKE_PROBE_TIMEOUT_MS / 1000}s`;
      } else if (/ECONNREFUSED|fetch failed|ENOTFOUND|terminated|socket hang up/i.test(String(err?.message || err))) {
        lastDetail = String(err?.message || err);
      } else {
        throw err;
      }
      console.log(`[AskDeepakAI ML wake] ${lastDetail} - probe ${attempts}...`);
    } finally {
      clearTimeout(timeoutId);
    }

    await new Promise(resolve => setTimeout(resolve, WAKE_POLL_INTERVAL_MS));
  }

  throw new Error(
    `The ML service at ${baseUrl} did not come up within ${WAKE_TOTAL_BUDGET_MS / 1000}s (last: ${lastDetail}). ` +
    `Free-tier cold starts are usually under a minute - try once more, or check the host's dashboard.`
  );
}


async function callMlService(path: string, options: { method?: string; body?: any } = {}) {
  const baseUrl = await getMlServiceUrl();
  for (let attempt = 0; ; attempt++) {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), ML_SERVICE_TIMEOUT_MS);
    try {
      const response = await fetch(`${baseUrl}${path}`, {
        method: options.method || 'POST',
        headers: mlHeaders({ 'Content-Type': 'application/json' }),
        body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
        signal: controller.signal,
      });
      const text = await response.text();
      let parsed: any = null;
      try { parsed = text ? JSON.parse(text) : null; } catch { /* non-JSON response, e.g. a platform gateway HTML page */ }

      if (!response.ok) {
        if (GATEWAY_RETRY_STATUSES.has(response.status) && attempt < GATEWAY_RETRY_DELAYS_MS.length) {
          const delay = GATEWAY_RETRY_DELAYS_MS[attempt];
          console.log(`[AskDeepakAI ML] Gateway ${response.status} from ml-service (likely a free-tier cold start) - retrying in ${delay}ms (attempt ${attempt + 1}/${GATEWAY_RETRY_DELAYS_MS.length})...`);
          await new Promise(resolve => setTimeout(resolve, delay));
          continue;
        }
        const detail = parsed?.detail || parsed?.error || (parsed ? JSON.stringify(parsed) : null);
        if (detail) {
          // Keep the service's status so callers can tell bad input (4xx) from an outage.
          throw Object.assign(new Error(typeof detail === 'string' ? detail : JSON.stringify(detail)), { status: response.status });
        }
        throw new Error(
          GATEWAY_RETRY_STATUSES.has(response.status)
            ? `The ML compute service is waking up from an idle sleep (its free-tier host spins it down after inactivity) and still hasn't responded after ~${Math.round(GATEWAY_RETRY_DELAYS_MS.reduce((a, b) => a + b, 0) / 1000)}s of retries. It should be warm now - please try again.`
            : `HTTP ${response.status}`
        );
      }
      return parsed;
    } catch (err: any) {
      if (err.name === 'AbortError') {
        throw new Error(`ML compute service timed out after ${ML_SERVICE_TIMEOUT_MS / 1000}s at ${baseUrl}.`, { cause: err });
      }
      const msg = String(err?.message || err);
      // Node's fetch (undici) wraps connection-level failures in a generic
      // "fetch failed" TypeError; the real signal lives in .cause. A dropped/
      // reset connection - the origin accepted the connection and then died
      // mid-request, e.g. an OOM crash during a large training job - needs
      // different handling (and is worth retrying, since the host likely
      // restarts) than a target that was never reachable at all.
      const causeMsg = String((err as any)?.cause?.message || (err as any)?.cause || '');
      const isConnectionDropped = /terminated|other side closed|socket hang up|ECONNRESET|EPIPE/i.test(`${msg} ${causeMsg}`);

      if (isConnectionDropped) {
        if (attempt < GATEWAY_RETRY_DELAYS_MS.length) {
          const delay = GATEWAY_RETRY_DELAYS_MS[attempt];
          console.log(`[AskDeepakAI ML] Connection to ml-service dropped mid-request (likely crashed/restarted under load) - retrying in ${delay}ms (attempt ${attempt + 1}/${GATEWAY_RETRY_DELAYS_MS.length})...`);
          await new Promise(resolve => setTimeout(resolve, delay));
          continue;
        }
        throw new Error(
          `The ML compute service's connection was interrupted while processing this request, most likely because it ran out of memory and restarted during a large training job. If this keeps happening on the same dataset, try switching off "Auto" and training a single algorithm instead of all 5, or training on fewer rows.`,
          { cause: err }
        );
      }
      if (/ECONNREFUSED|fetch failed|ENOTFOUND/i.test(msg)) {
        // The cached choice may be stale (e.g. a local service was just stopped).
        resolvedMlService = null;
        const openUrl = mlServiceOpenUrl(baseUrl);
        throw new Error(
          openUrl
            ? `The engine at ${baseUrl} is not responding yet - it may still be starting up. Please try again in a moment.`
            : `ML compute service is unreachable at ${baseUrl}. Start it with: cd mlops_service && pip install -r requirements.txt && uvicorn main:app --reload --port 8000`,
          { cause: err }
        );
      }
      throw err;
    } finally {
      clearTimeout(timeoutId);
    }
  }
}

// 0. ML SERVICE WAKE-UP (free-tier cold start primer)
// Deliberately server-side: the browser cannot probe the ML host directly
// without CORS on it, and proxying here also keeps the service URL out of the
// client bundle. Returns only status metadata - nothing is rendered to the user.
app.post('/api/ml-service/wake', async (_req, res) => {
  const url = await getMlServiceUrl();
  try {
    const outcome = await wakeMlService(url);
    console.log(`[AskDeepakAI ML wake] ${url} awake after ${outcome.attempts} probe(s) in ${outcome.elapsedMs}ms.`);
    res.json({ ...outcome, openUrl: mlServiceOpenUrl(url) });
  } catch (err: any) {
    console.error('[AskDeepakAI ML wake] Failed:', err?.message || err);
    res.status(503).json({
      status: 'unreachable',
      url,
      // Lets the UI offer "open it in a new tab" as a manual way to wake it.
      openUrl: mlServiceOpenUrl(url),
      error: err?.message || 'Failed to wake the ML service.',
    });
  }
});

// Lightweight, non-blocking status probe. Unlike /wake this never retries, so
// the UI can poll it cheaply to show whether the service is still warm.
app.get('/api/ml-service/status', async (_req, res) => {
  const url = await getMlServiceUrl();
  const awake = await isMlServiceListening(url, 5000);
  res.json({ status: awake ? 'awake' : 'asleep', url, openUrl: mlServiceOpenUrl(url) });
});

// AI STATUS - why Gemini is or isn't answering.
// Reports what the most recent real call did, at no cost. With ?probe=1 it
// makes one tiny live call first (rate-limited, so it cannot burn quota).
const AI_PROBE_MIN_INTERVAL_MS = 30000;
let lastAiProbeAt = 0;

function currentAiStatus() {
  const { lastOk, lastFailure } = geminiHealth;
  const configured = !!ARC || !!ownerGeminiKey();
  if (!configured) {
    return { state: 'unavailable' as const, reason: 'no_key' as const, message: describeGeminiFailure('no_key', []), detail: null, model: null };
  }
  if (lastFailure && (!lastOk || lastFailure.at > lastOk.at)) {
    return {
      state: 'unavailable' as const,
      reason: lastFailure.kind,
      message: lastFailure.via === 'arc' ? describeArcFailure(lastFailure.kind) : describeGeminiFailure(lastFailure.kind, lastFailure.models),
      detail: lastFailure.detail,
      model: null,
    };
  }
  if (lastOk) return { state: 'ok' as const, reason: null, message: lastOk.model.startsWith('ARC') ? 'AI is responding through ARC.' : 'Gemini is responding.', detail: null, model: lastOk.model };
  return { state: 'unknown' as const, reason: null, message: 'No AI request has been made yet.', detail: null, model: null };
}

app.get('/api/ai/status', async (req, res) => {
  res.set('Cache-Control', 'no-store');
  if (req.query.probe === '1' && aiKeyAvailable() && Date.now() - lastAiProbeAt > AI_PROBE_MIN_INTERVAL_MS) {
    lastAiProbeAt = Date.now();
    // "Check again" is a deliberate retry: it may try the app's key even while it rests.
    ownerKeyRestingUntil = 0;
    try {
      await generateContentWithRetry(getGeminiClient(), { contents: 'Reply with the single word: OK' });
    } catch { /* the failure is recorded in geminiHealth and reported below */ }
  }
  const visitorKeyResult = aiKeyContext.getStore()?.visitorKeyResult;
  res.json({
    ...currentAiStatus(),
    models: geminiModelInfo,
    // Whether this visitor sent their own key, and - if the probe fell back to
    // it - whether it worked. The key itself is never echoed back.
    visitorKey: !!visitorGeminiKey(),
    visitorKeyOk: visitorKeyResult ? visitorKeyResult.ok : null,
    visitorKeyMessage: visitorKeyResult && visitorKeyResult.ok === false ? describeVisitorKeyFailure(visitorKeyResult.kind) : null,
  });
});

// "Update to latest model": asks Google which models exist now, switches to the
// newest suitable ones, and tries them at once. Uses the app's key, or the
// visitor's own key when the app has none. Limited so it can't hammer Google.
let lastModelUpdateAt = 0;
app.post('/api/ai/refresh-models', async (req, res) => {
  const tier: GeminiTier = req.body?.tier === 'latest' ? 'latest' : req.body?.tier === 'free' ? 'free' : geminiTier;
  res.set('Cache-Control', 'no-store');
  if (!aiKeyAvailable()) return res.status(400).json({ ok: false, message: 'There is no Gemini key to ask Google with; add your own key first.', models: geminiModelInfo });
  if (Date.now() - lastModelUpdateAt < 15_000) return res.status(429).json({ ok: false, message: 'Updated a moment ago; try again in a few seconds.', models: geminiModelInfo });
  lastModelUpdateAt = Date.now();
  const before = GEMINI_MODELS[0];
  await refreshGeminiModels(true, undefined, tier);
  ownerKeyRestingUntil = 0;
  try {
    await generateContentWithRetry(getGeminiClient(), { contents: 'Reply with the single word: OK' });
  } catch { /* recorded in geminiHealth and reported below */ }
  const status = currentAiStatus();
  res.json({
    ok: status.state === 'ok', ...status, models: geminiModelInfo,
    message: geminiModelInfo.error
      ? `Couldn't ask Google for new models (${geminiModelInfo.error}); still using ${GEMINI_MODELS[0]}.`
      : status.state === 'ok'
        ? `Using ${status.model ?? GEMINI_MODELS[0]}${tier === 'free' ? ' (free tier, tested)' : ''}${GEMINI_MODELS[0] !== before ? ` — was ${before}` : ' — already the latest'}.`
        : `Updated to ${GEMINI_MODELS[0]}, but Gemini still isn't answering: ${status.message}`,
  });
});

function describeVisitorKeyFailure(kind: GeminiFailureKind): string {
  switch (kind) {
    case 'bad_key':
      return 'Google rejected this key. Check it was copied in full, or create a new one in Google AI Studio.';
    case 'quota':
      return 'This key has used up its Gemini quota for now. Free-tier limits reset on their own.';
    case 'busy':
      return 'Gemini is overloaded right now. Your key looks fine; try again in a minute.';
    case 'network':
      return "The server could not reach Google's Gemini API.";
    case 'model_unavailable':
      return 'This key cannot use the Gemini models the app needs.';
    case 'billing':
      return 'This key’s Google project has run out of prepaid credits. Add credits in Google AI Studio, or create a key in a project without billing (free tier).';
    default:
      return 'Gemini returned an unexpected error with this key.';
  }
}

// Check a visitor's key once, when they save it, using only that key. A
// cheap one-word request, limited per address so it cannot be used to hammer
// Google or test keys in bulk.
const keyTestLastAt = new Map<string, number>();
app.post('/api/ai/test-key', async (req, res) => {
  res.set('Cache-Control', 'no-store');
  const key = visitorGeminiKey();
  if (!key) return res.status(400).json({ ok: false, message: 'That does not look like a Gemini API key.' });

  const who = req.ip || 'unknown';
  const last = keyTestLastAt.get(who) ?? 0;
  if (Date.now() - last < 3000) {
    return res.status(429).json({ ok: false, message: 'Please wait a few seconds before testing again.' });
  }
  keyTestLastAt.set(who, Date.now());
  if (keyTestLastAt.size > 5000) keyTestLastAt.clear();

  try {
    const client = new GoogleGenAI({ apiKey: key });
    try {
      await runAcrossModels(client, { contents: 'Reply with the single word: OK' });
    } catch (first) {
      // The models may have been retired: ask Google with this key for current ones, then retry once.
      if (!((first as GeminiAttemptError).kinds ?? []).includes('model_unavailable') || !(await refreshGeminiModels(true, key))) throw first;
      await runAcrossModels(client, { contents: 'Reply with the single word: OK' });
    }
    res.json({ ok: true, message: 'Your key works.' });
  } catch (err) {
    const kind = mostTellingFailure((err as GeminiAttemptError).kinds ?? []);
    res.json({ ok: false, reason: kind, message: describeVisitorKeyFailure(kind) });
  }
});

// 1. DATASET ANALYSIS & AUTOMATED MODEL RECOMMENDATION
app.post('/api/analyze-dataset', async (req, res) => {
  const { filename, columns, rowCount } = req.body || {};
  
  const safeFilename = typeof filename === 'string' ? filename : 'dataset.csv';
  const safeRowCount = typeof rowCount === 'number' ? rowCount : 0;
  const safeColumns = Array.isArray(columns) ? columns : [];

  // Without AI, the advisory is built from the column statistics only - never
  // from canned text keyed on the file name.
  const getFallback = () => buildAdvisoryFallback(safeFilename, safeColumns, safeRowCount);

  const client = getGeminiClient();
  const hasKey = aiKeyAvailable();

  if (!hasKey) {
    console.log('[AskDeepakAI] No API Key configuration. Using offline dataset analytical falls.');
    return res.json(getFallback());
  }

  try {
    const prompt = `You are a top-tier Data Science and Automation Agent. Analyze this uploaded dataset metadata:
Dataset Filename: "${safeFilename}"
Total Rows: ${safeRowCount}
Columns Configuration: ${JSON.stringify(safeColumns)}

Generate a complete, high-intelligence structural analysis and automated layout report matching this exactly:
1. "overviewSummary": Exhaustive, professional 2-sentence summary of the dataset's nature and potential business value.
2. "recommendedTarget": The ideal target column for predictive machine learning, with reasoning.
3. "modelType": One of "classification", "regression", "timeseries" based on the ideal target.
4. "suggestedFeatures": An array of column names to use as training features.
5. "scientistFocus": The single column an analyst should investigate manually, and the full rationale of why.
6. "strategicSlicer": The categorical column perfect for a dashboard filter/slicer (e.g. ContractType or Region).
7. "insights": 3 major business outcomes or descriptive patterns that this dataset holds.

Respond strict JSON following the database schema structure.`;

    const aiResponse = await generateContentWithRetry(client, {
      contents: prompt,
      config: {
        responseMimeType: 'application/json',
        responseSchema: {
          type: Type.OBJECT,
          required: ['overviewSummary', 'recommendedTarget', 'modelType', 'suggestedFeatures', 'scientistFocus', 'scientistRationale', 'strategicSlicer', 'insights'],
          properties: {
            overviewSummary: { type: Type.STRING },
            recommendedTarget: { type: Type.STRING },
            modelType: { type: Type.STRING, description: 'Must be one of "classification", "regression", or "timeseries"' },
            suggestedFeatures: {
              type: Type.ARRAY,
              items: { type: Type.STRING }
            },
            scientistFocus: { type: Type.STRING },
            scientistRationale: { type: Type.STRING },
            strategicSlicer: { type: Type.STRING },
            insights: {
              type: Type.ARRAY,
              items: { type: Type.STRING }
            }
          }
        }
      }
    });

    const parsedData = JSON.parse(aiResponse.text || '{}');
    return res.json(parsedData);
  } catch (apiError: any) {
    console.error('[AskDeepakAI Gemini Client] Error during dataset scan, using template fallback:', apiError);
    return res.json(getFallback());
  }
});

// 1b. PIPELINE INTELLIGENCE (Business Context)
app.post('/api/pipeline-intelligence', async (req, res) => {
  const { datasetProfile, businessProblem } = req.body || {};
  
  const client = getGeminiClient();
  const hasKey = aiKeyAvailable();

  const getPipelineIntelligenceFallback = () => ({
    detectedDomain: 'Generic Data',
    inferredProblem: 'Analyze the dataset for trends and patterns.',
    recommendedTarget: datasetProfile?.columns?.[datasetProfile?.columns?.length - 1]?.name || 'Unknown',
    pipelineStrategy: 'Standard data analysis pipeline focusing on basic descriptive and predictive analytics.',
    stageInstructions: {}
  });

  if (!hasKey) {
    return res.json(getPipelineIntelligenceFallback());
  }

  try {
    const prompt = `You are a Principal Data Scientist and Business Strategist.
Given the following dataset profile:
${JSON.stringify(datasetProfile, null, 2)}

And the following stated business problem from the user (if any):
"${businessProblem || ''}"

Return a strategic plan for how to approach this data pipeline in JSON format.
1. "detectedDomain": The industry or domain (e.g. Finance, Healthcare, E-commerce).
2. "inferredProblem": If the user did NOT provide a business problem, state your best guess at what they want to solve based on the dataset structure. If they DID provide one, rephrase it formally.
3. "recommendedTarget": The ideal column to use as the target variable for Machine Learning.
4. "pipelineStrategy": A short paragraph explaining how the pipeline should be configured for this specific dataset and problem.
5. "stageInstructions": An object containing specific 1-2 sentence instructions or focus areas for each stage ("Stage 2: Cleaning Studio", "Stage 3: EDA", "Stage 4: ML Modeling", "Stage 5: Dashboard", "Stage 6: Stakeholder Insights").

Respond strict JSON following the schema structure.`;

    const aiResponse = await generateContentWithRetry(client, {
      contents: prompt,
      config: {
        responseMimeType: 'application/json',
        responseSchema: {
          type: Type.OBJECT,
          required: ['detectedDomain', 'inferredProblem', 'recommendedTarget', 'pipelineStrategy', 'stageInstructions'],
          properties: {
            detectedDomain: { type: Type.STRING },
            inferredProblem: { type: Type.STRING },
            recommendedTarget: { type: Type.STRING },
            pipelineStrategy: { type: Type.STRING },
            stageInstructions: {
              type: Type.OBJECT,
              properties: {
                "Stage 2: Cleaning Studio": { type: Type.STRING },
                "Stage 3: EDA": { type: Type.STRING },
                "Stage 4: ML Modeling": { type: Type.STRING },
                "Stage 5: Dashboard": { type: Type.STRING },
                "Stage 6: Stakeholder Insights": { type: Type.STRING }
              }
            }
          }
        }
      }
    });

    const parsedData = JSON.parse(aiResponse.text || '{}');
    return res.json(parsedData);
  } catch (err: any) {
    console.error('[AskDeepakAI] Pipeline Intelligence Error, using template fallback:', err);
    return res.json(getPipelineIntelligenceFallback());
  }
});

// 2. MACHINE LEARNING MODELLER & STAKEHOLDER REPORT
// Real AutoML: this endpoint trains and evaluates genuine scikit-learn/XGBoost
// models via the Python MLOps microservice. Gemini is invoked ONLY afterward,
// strictly to narrate the real numbers in business language — its response
// schema below has no numeric metric fields, so it is structurally incapable
// of returning a fabricated accuracy/R2/F1/etc. If the compute service is
// unreachable, this returns a clear error rather than silently faking results.
app.post('/api/run-ml-prediction', async (req, res) => {
  const { target, features, modelType, hyperparameters, datasetRows, skipNarrative } = req.body || {};

  const safeTarget = typeof target === 'string' ? target : '';
  const safeFeatures = Array.isArray(features) ? features.filter((f: any) => typeof f === 'string') : [];
  const safeHyperparameters = hyperparameters && typeof hyperparameters === 'object' ? hyperparameters : {};
  const rows = Array.isArray(datasetRows) ? datasetRows : [];

  if (!safeTarget) {
    return res.status(400).json({ error: 'A target column is required to train a model.' });
  }
  if (rows.length === 0) {
    return res.status(400).json({ error: 'No dataset rows were provided. Upload and select a dataset before training.' });
  }

  // 'auto' omits `models` entirely so the Python service's own DEFAULT_MODELS
  // (5 real candidates) is the single source of truth for the AutoML set.
  const REAL_MODEL_KEYS = ['linear', 'random_forest', 'gradient_boosting', 'xgboost', 'mlp'];
  const requestedAlgo = safeHyperparameters.selectedAlgorithmId || 'auto';
  const models = requestedAlgo === 'auto'
    ? undefined
    : (REAL_MODEL_KEYS.includes(requestedAlgo) ? [requestedAlgo] : ['random_forest']);

  const trainRatio = typeof safeHyperparameters.train_ratio === 'number' ? safeHyperparameters.train_ratio : 0.8;
  const testSize = Math.min(0.5, Math.max(0.1, 1 - trainRatio));

  let trainResult: any;
  try {
    trainResult = await callMlService('/train', {
      body: {
        data: rows,
        target: safeTarget,
        features: safeFeatures.length > 0 ? safeFeatures : undefined,
        task_type: (modelType === 'classification' || modelType === 'regression') ? modelType : undefined,
        models,
        test_size: testSize,
        cv_folds: 5,
        random_state: Number.isInteger(safeHyperparameters.seed) ? safeHyperparameters.seed : 42,
        split_strategy: ['random', 'time', 'group'].includes(safeHyperparameters.split_strategy) ? safeHyperparameters.split_strategy : 'random',
        time_column: typeof safeHyperparameters.time_column === 'string' ? safeHyperparameters.time_column : undefined,
        group_column: typeof safeHyperparameters.group_column === 'string' ? safeHyperparameters.group_column : undefined,
        tune: safeHyperparameters.tune === true,
        tune_iterations: Number.isInteger(safeHyperparameters.tune_iterations) ? safeHyperparameters.tune_iterations : 12,
        hyperparameters: {
          n_estimators: safeHyperparameters.n_estimators,
          max_depth: safeHyperparameters.max_depth,
          learning_rate: safeHyperparameters.learning_rate,
          epochs: safeHyperparameters.epochs,
        }
      }
    });
  } catch (err: any) {
    console.error('[AskDeepakAI ML] Real training call failed:', err);
    if (typeof err.status === 'number' && err.status >= 400 && err.status < 500) {
      return res.status(400).json({ error: err.message });
    }
    // A 5xx *from* the service means it is running but failed on this data - show its message,
    // and only suggest starting the service when it could not be reached at all.
    const serviceRejected = typeof err.status === 'number';
    return res.status(serviceRejected ? 422 : 503).json({
      error: err.message || 'The ML compute service is unavailable, so no model was trained.',
      ...(serviceRejected ? {} : { hint: 'Start the Python service: cd mlops_service && pip install -r requirements.txt && uvicorn main:app --reload --port 8000' })
    });
  }

  const champion = trainResult.champion;

  // Everything numeric below comes straight from the trained model's real evaluation.
  const baseResult = {
    // What was predicted from what - recorded so results can be traced and reproduced.
    target: safeTarget,
    features: safeFeatures,
    modelType: trainResult.task,
    modelAlgorithm: champion.modelName,
    modelKey: champion.modelKey,
    modelId: champion.modelId,
    hyperparameters: safeHyperparameters,
    metrics: champion.metrics,
    confusionMatrix: champion.confusionMatrix,
    featureImportance: champion.featureImportance,
    shapImportance: champion.shapImportance,
    predictions: champion.predictions,
    cv: champion.cv,
    comparison: trainResult.comparison,
    selectionReason: trainResult.selectionReason,
    estimators: champion.estimators,
    oobScore: champion.oobScore,
    deepLearning: champion.deepLearning,
    trainRows: champion.trainRows,
    testRows: champion.testRows,
    trainRatio: trainResult.trainRatio,
    split: trainResult.split,
    leakageWarnings: trainResult.leakageWarnings,
    tuning: trainResult.tuning,
    seed: trainResult.seed,
  };

  // Restoring a registered model only needs the fitted model, not a narrative.
  if (skipNarrative === true) {
    return res.json(baseResult);
  }

  // The model comes back as soon as it's trained, with a summary the studio writes
  // from the real metrics. An AI write-up, when AI is available, is asked for
  // separately (POST /api/model-narrative) so training never waits on it.
  const narrativeKey = randomUUID();
  rememberNarrativeInputs(narrativeKey, { trainResult, champion, safeTarget, safeFeatures });
  return res.json({ ...baseResult, ...buildTemplateNarrative(baseResult, safeTarget, safeFeatures), narrativeSource: 'studio', narrativeKey });
});

// What an AI write-up of a trained model needs, kept briefly after training.
const narrativeInputs = new Map<string, { at: number; trainResult: any; champion: any; safeTarget: string; safeFeatures: string[] }>();
function rememberNarrativeInputs(key: string, v: { trainResult: any; champion: any; safeTarget: string; safeFeatures: string[] }) {
  narrativeInputs.set(key, { ...v, at: Date.now() });
  for (const [k, x] of narrativeInputs) if (narrativeInputs.size > 50 || Date.now() - x.at > 60 * 60 * 1000) narrativeInputs.delete(k);
}

/** An AI-written business summary of an already-trained model (its numbers are never changed). */
async function aiModelNarrative({ trainResult, champion, safeTarget, safeFeatures }: { trainResult: any; champion: any; safeTarget: string; safeFeatures: string[] }) {
  const client = getGeminiClient();
    const realMetricsJson = JSON.stringify({
    task: trainResult.task,
    algorithm: champion.modelName,
    metrics: champion.metrics,
    confusionMatrix: champion.confusionMatrix,
    crossValidation: champion.cv,
    topFeatures: (champion.featureImportance || []).slice(0, 5),
    comparisonAcrossModels: trainResult.comparison,
    trainRows: champion.trainRows,
    testRows: champion.testRows
  });

  const systemInstruction = `You are a Business Translator summarizing the results of a machine learning model that has ALREADY been trained and evaluated by a real scikit-learn/XGBoost pipeline on held-out test data. You will be given REAL_METRICS — the exact, final, computed results.

STRICT RULES (violating these is a critical failure):
1. Do NOT invent, recompute, guess, or restate with different precision any numeric value. Every number you write must be copied verbatim from REAL_METRICS.
2. Do NOT output metric fields yourself. Your only output is business narrative text: markdownReport, risks, recommendations, and scientistCallout.
3. If you want to reference a number that is not present in REAL_METRICS, describe it qualitatively instead (e.g. "strong", "moderate") rather than fabricate a figure.
4. Focus on: what these real results mean for the business, deployment risks, actionable recommendations, and which column an analyst should manually validate next.

REAL_METRICS:
${realMetricsJson}

Target Variable: "${safeTarget}"
Feature Variables: ${JSON.stringify(safeFeatures)}`;

  const aiResponse = await generateContentWithRetry(client, {
    contents: 'Explain these real, already-computed model results in clear business language for a non-technical stakeholder. Reference numbers only from REAL_METRICS.',
    config: {
      systemInstruction,
      responseMimeType: 'application/json',
      responseSchema: {
        type: Type.OBJECT,
        required: ['markdownReport', 'risks', 'recommendations', 'scientistCallout'],
        properties: {
          markdownReport: { type: Type.STRING, description: 'Business-language markdown narrative. Any number cited must appear verbatim in REAL_METRICS.' },
          risks: {
            type: Type.ARRAY,
            items: {
              type: Type.OBJECT,
              required: ['title', 'riskLevel', 'description'],
              properties: {
                title: { type: Type.STRING },
                riskLevel: { type: Type.STRING, description: 'Must be "High", "Medium", or "Low"' },
                description: { type: Type.STRING }
              }
            }
          },
          recommendations: {
            type: Type.ARRAY,
            items: {
              type: Type.OBJECT,
              required: ['title', 'impact', 'details'],
              properties: {
                title: { type: Type.STRING },
                impact: { type: Type.STRING, description: 'Must be "High", "Medium", or "Low"' },
                details: { type: Type.STRING }
              }
            }
          },
          scientistCallout: {
            type: Type.OBJECT,
            required: ['focusColumns', 'justification', 'pathways'],
            properties: {
              focusColumns: { type: Type.ARRAY, items: { type: Type.STRING } },
              justification: { type: Type.STRING },
              pathways: { type: Type.ARRAY, items: { type: Type.STRING } }
            }
          }
        }
      }
    }
  });

  return JSON.parse(aiResponse.text || '{}');
}

app.post('/api/model-narrative', async (req, res) => {
  const inputs = narrativeInputs.get(String(req.body?.narrativeKey ?? ''));
  if (!inputs) return res.status(404).json({ error: 'That model’s details are no longer available for a write-up.' });
  if (!aiKeyAvailable()) return res.status(503).json({ error: 'AI is not set up.', reason: 'ai_unavailable' });
  try {
    return res.json({ ...(await aiModelNarrative(inputs)), narrativeSource: 'ai' });
  } catch (err: any) {
    return res.status(503).json({ error: err?.message || 'AI could not write the summary.', reason: 'ai_unavailable' });
  }
});

// 2b. REAL SERVER-SIDE EDA — correlation, skew, IQR outliers, and missing-value
// report are all computed by pandas/numpy in the Python service. Gemini is
// invoked ONLY afterward to narrate these real numbers, under the identical
// no-invented-numbers rule as the ML training endpoint above: its response
// schema carries no numeric fields, so it cannot report a statistic that
// wasn't actually computed.
app.post('/api/eda', async (req, res) => {
  const { datasetRows } = req.body || {};
  const rows = Array.isArray(datasetRows) ? datasetRows : [];

  if (rows.length === 0) {
    return res.status(400).json({ error: 'No dataset rows were provided.' });
  }

  let edaResult: any;
  try {
    edaResult = await callMlService('/eda', { body: { data: rows } });
  } catch (err: any) {
    console.error('[AskDeepakAI EDA] Real EDA computation failed:', err);
    // A 4xx/5xx *from* the service means it is running and rejected this data - show its message,
    // and only suggest starting the service when it could not be reached at all.
    const serviceRejected = typeof err.status === 'number';
    return res.status(serviceRejected ? 422 : 503).json({
      error: err.message || 'The EDA compute service is unavailable, so no analysis was run.',
      ...(serviceRejected ? {} : { hint: 'Start the Python service: cd mlops_service && pip install -r requirements.txt && uvicorn main:app --reload --port 8000' })
    });
  }

  // The analysis comes back at once with a summary the studio writes from the real
  // numbers; an AI write-up, when AI is available, is asked for separately
  // (POST /api/eda/narrative) so the numbers never wait on it.
  return res.json({ ...edaResult, narrative: buildEdaTemplateNarrative(edaResult), narrativeSource: 'studio' });
});

/** An AI-written summary of an already-computed EDA (the numbers are never changed). */
async function aiEdaNarrative(edaResult: any) {
  const client = getGeminiClient();
    const realEdaJson = JSON.stringify({
    rowCount: edaResult.rowCount,
    columnCount: edaResult.columnCount,
    numericSummaries: edaResult.numericSummaries,
    outliers: (edaResult.outliers || []).map((o: any) => ({
      column: o.column, outlierCount: o.outlierCount, outlierPercent: o.outlierPercent,
      lowerBound: o.lowerBound, upperBound: o.upperBound
    })),
    correlation: edaResult.correlation,
    missingReport: edaResult.missingReport,
    categoricalSummaries: edaResult.categoricalSummaries
  });

  const systemInstruction = `You are a Data Quality Analyst summarizing a REAL exploratory data analysis that has ALREADY been computed by pandas/numpy. You will be given REAL_EDA — every mean, median, std, skew, correlation, and outlier count in it was genuinely measured from the dataset.

STRICT RULES (violating these is a critical failure):
1. Do NOT invent, recompute, guess, or restate with different precision any numeric value. Every number you write must be copied verbatim from REAL_EDA.
2. Do NOT output numeric fields yourself. Your only output is narrative text: summary, dataQualityFlags, and recommendedNextSteps.
3. If you want to reference a number not present in REAL_EDA, describe it qualitatively instead (e.g. "moderately skewed") rather than fabricate a figure.
4. Focus on: what the skew/outliers/correlations/missing values mean for data quality, and what a data scientist should investigate or clean first.

REAL_EDA:
${realEdaJson}`;

  const aiResponse = await generateContentWithRetry(client, {
    contents: 'Summarize this real, already-computed exploratory data analysis in plain business language for a data scientist. Reference numbers only from REAL_EDA.',
    config: {
      systemInstruction,
      responseMimeType: 'application/json',
      responseSchema: {
        type: Type.OBJECT,
        required: ['summary', 'dataQualityFlags', 'recommendedNextSteps'],
        properties: {
          summary: { type: Type.STRING, description: 'Plain-language narrative. Any number cited must appear verbatim in REAL_EDA.' },
          dataQualityFlags: {
            type: Type.ARRAY,
            items: {
              type: Type.OBJECT,
              required: ['column', 'issue', 'severity'],
              properties: {
                column: { type: Type.STRING },
                issue: { type: Type.STRING },
                severity: { type: Type.STRING, description: 'Must be "High", "Medium", or "Low"' }
              }
            }
          },
          recommendedNextSteps: { type: Type.ARRAY, items: { type: Type.STRING } }
        }
      }
    }
  });

  return JSON.parse(aiResponse.text || '{}');
}

app.post('/api/eda/narrative', async (req, res) => {
  const { eda } = req.body || {};
  if (!eda || typeof eda !== 'object') return res.status(400).json({ error: 'The analysis to summarise is required.' });
  if (!aiKeyAvailable()) return res.status(503).json({ error: 'AI is not set up.', reason: 'ai_unavailable' });
  try {
    return res.json({ narrative: await aiEdaNarrative(eda), narrativeSource: 'ai' });
  } catch (err: any) {
    return res.status(503).json({ error: err?.message || 'AI could not write the summary.', reason: 'ai_unavailable' });
  }
});


// The Ask AI chat talks to the agent team through /api/swarm/plan below.

// LOG TRAINING DATA FOR DEEPAKLLMS
app.post('/api/log-training-data', async (req, res) => {
  try {
    const payload = req.body;
    if (!payload || !payload.action) {
      return res.status(400).json({ error: 'Invalid training data payload' });
    }

    // Attempt to write to Firestore if configured
    if (db) {
      // We don't await this so it doesn't block the frontend response
      db.collection('deepakllm_training_data').add(payload)
        .then(() => console.log('[AskDeepakAI Training Logger] Logged action to Firestore:', payload.action))
        .catch(err => console.error('[AskDeepakAI Training Logger] Firestore write failed:', err));
    } else {
      // Fallback to local file logging if Firestore isn't connected
      const logLine = JSON.stringify(payload) + '\n';
      const filePath = path.join(process.cwd(), 'deepakllm_training_data.jsonl');
      fs.promises.appendFile(filePath, logLine, 'utf8').catch(err => 
        console.error('[AskDeepakAI Training Logger] Local file write failed:', err)
      );
    }
    
    return res.status(200).json({ success: true });
  } catch (err: any) {
    console.error('[AskDeepakAI Training Logger] Error handling request:', err);
    return res.status(500).json({ error: 'Failed to process training data' });
  }
});

// --- NEW MODULE ENDPOINTS ---

// MODULE 1: SQL Assistant
app.post('/api/sql-assistant', async (req, res) => {
  const { schema, question } = req.body || {};
  const client = getGeminiClient();
  const hasKey = aiKeyAvailable();

  if (!hasKey) {
    return res.status(503).json({ error: 'SQL generation needs a Gemini API key. Add your own free key with the key button in the toolbar - there is no honest offline way to translate arbitrary English into SQL, so this feature cannot fall back to a template like the other modules.' });
  }

  try {
    const prompt = `You are an expert SQL Generator. Given the following database schema (or csv headers):
${schema}
User question: ${question}

Generate the correct SQL query, and provide a line-by-line plain English explanation of the query.
Return strict JSON with exactly this structure:
{
  "sql": "SELECT ...",
  "explanation": "1. The SELECT clause... 2. The WHERE clause..."
}`;
    const aiResponse = await generateContentWithRetry(client, {
      contents: prompt,
      config: {
        responseMimeType: 'application/json',
        responseSchema: {
          type: Type.OBJECT,
          properties: {
            sql: { type: Type.STRING },
            explanation: { type: Type.STRING }
          },
          required: ["sql", "explanation"]
        }
      }
    });
    return res.json(JSON.parse(aiResponse.text || '{}'));
  } catch (err: any) {
    console.error('[AskDeepakAI] SQL Assistant error:', err);
    return res.status(503).json({ error: 'AI SQL generation is temporarily unavailable (the model is likely rate-limited). Please try again in a moment.' });
  }
});

// MODULE 2: Deep Quality Audit
app.post('/api/deep-quality-audit', async (req, res) => {
  const { auditSummary } = req.body || {};
  const client = getGeminiClient();
  const hasKey = aiKeyAvailable();

  if (!hasKey) {
    return res.json({ fixes: buildDeepQualityAuditFallback(auditSummary) });
  }

  try {
    const prompt = `You are a Data Quality Engineer. Given this data quality audit summary:
${JSON.stringify(auditSummary)}

For each issue found (nulls, duplicates, type mismatches, etc.), generate a specific Python code snippet using pandas to fix the issue.
Return strict JSON:
{
  "fixes": [
    {
      "issueName": "Missing values in Age",
      "severity": "High",
      "description": "Found 50 missing values...",
      "pythonFix": "df['Age'].fillna(df['Age'].median(), inplace=True)"
    }
  ]
}`;
    const aiResponse = await generateContentWithRetry(client, {
      contents: prompt,
      config: {
        responseMimeType: 'application/json',
        responseSchema: {
          type: Type.OBJECT,
          properties: {
            fixes: {
              type: Type.ARRAY,
              items: {
                type: Type.OBJECT,
                properties: {
                  issueName: { type: Type.STRING },
                  severity: { type: Type.STRING },
                  description: { type: Type.STRING },
                  pythonFix: { type: Type.STRING }
                },
                required: ["issueName", "severity", "description", "pythonFix"]
              }
            }
          },
          required: ["fixes"]
        }
      }
    });
    return res.json(JSON.parse(aiResponse.text || '{}'));
  } catch (err: any) {
    console.error('[AskDeepakAI] Deep Quality Audit error, using template fixes built from the real audit summary:', err);
    return res.json({ fixes: buildDeepQualityAuditFallback(auditSummary) });
  }
});

// MODULE 3: Hypothesis Lab
app.post('/api/hypothesis-lab/generate', async (req, res) => {
  const { columns, dataSample } = req.body || {};
  const client = getGeminiClient();
  const hasKey = aiKeyAvailable();

  if (!hasKey) {
    return res.status(503).json({ error: 'Hypothesis generation needs a Gemini API key. Add your own free key with the key button in the toolbar - proposing meaningful business hypotheses needs real language understanding, not a template. (You can still test any two columns directly - see the "Run This Test" panel, which always uses a real scipy.stats computation.)' });
  }

  try {
    const prompt = `You are a Principal Data Scientist. Given these columns and sample data:
Columns: ${JSON.stringify(columns)}
Sample: ${JSON.stringify(dataSample)}

Generate 6 to 8 specific, testable business hypotheses.
Return strict JSON:
{
  "hypotheses": [
    {
      "statement": "Users on premium contracts have significantly higher monthly charges than basic contracts.",
      "suggestedTest": "t-test",
      "columnsInvolved": ["ContractType", "MonthlyCharges"]
    }
  ]
}`;
    const aiResponse = await generateContentWithRetry(client, {
      contents: prompt,
      config: {
        responseMimeType: 'application/json',
        responseSchema: {
          type: Type.OBJECT,
          properties: {
            hypotheses: {
              type: Type.ARRAY,
              items: {
                type: Type.OBJECT,
                properties: {
                  statement: { type: Type.STRING },
                  suggestedTest: { type: Type.STRING },
                  columnsInvolved: { type: Type.ARRAY, items: { type: Type.STRING } }
                },
                required: ["statement", "suggestedTest", "columnsInvolved"]
              }
            }
          },
          required: ["hypotheses"]
        }
      }
    });
    return res.json(JSON.parse(aiResponse.text || '{}'));
  } catch (err: any) {
    console.error('[AskDeepakAI] Hypothesis Lab generate error:', err);
    return res.status(503).json({ error: 'AI hypothesis generation is temporarily unavailable (the model is likely rate-limited). Please try again in a moment.' });
  }
});

app.post('/api/hypothesis-lab/interpret', async (req, res) => {
  const { hypothesis, result } = req.body || {};
  const client = getGeminiClient();
  const hasKey = aiKeyAvailable();

  if (!hasKey) {
    const r = result || {};
    return res.json({ interpretation: `Real test result: ${r.testName || 'statistical test'} on ${r.sampleSize ?? 'the'} rows produced a p-value of ${r.pValue ?? 'N/A'}, so the null hypothesis is ${r.rejectNull ? 'rejected' : 'not rejected'} at the 0.05 significance level. Enable the AI assistant for a plain-English write-up of this same result.` });
  }

  try {
    const prompt = `You are a Data Science Translator. Given this hypothesis and statistical test result:
Hypothesis: ${JSON.stringify(hypothesis)}
Result: ${JSON.stringify(result)}

Generate a plain-English business interpretation of these results. What does it mean for the business?
Return strict JSON: { "interpretation": "Your interpretation here..." }`;
    const aiResponse = await generateContentWithRetry(client, {
      contents: prompt,
      config: {
        responseMimeType: 'application/json',
        responseSchema: {
          type: Type.OBJECT,
          properties: { interpretation: { type: Type.STRING } },
          required: ["interpretation"]
        }
      }
    });
    return res.json(JSON.parse(aiResponse.text || '{}'));
  } catch (err: any) {
    console.error('[AskDeepakAI] Hypothesis Lab interpret error:', err);
    const r = result || {};
    return res.json({ interpretation: `Real test result: ${r.testName || 'statistical test'} on ${r.sampleSize ?? 'the'} rows produced a p-value of ${r.pValue ?? 'N/A'}, so the null hypothesis is ${r.rejectNull ? 'rejected' : 'not rejected'} at the 0.05 significance level. (AI narration is temporarily unavailable; this is a template built from the same real numbers.)` });
  }
});

// Real hypothesis test - proxies to the Python service's scipy.stats computation.
// This is what runTest() in HypothesisLab.tsx calls; the result then gets
// narrated (not computed) by /api/hypothesis-lab/interpret above.
app.post('/api/hypothesis-lab/run-test', async (req, res) => {
  try {
    const result = await callMlService('/hypothesis-test', { body: req.body });
    return res.json(result);
  } catch (err: any) {
    console.error('[AskDeepakAI] /api/hypothesis-lab/run-test proxy failed:', err);
    return res.status(503).json({ error: err.message || 'ML compute service unavailable.' });
  }
});

// Agent swarm: plans a request into tasks when the browser's built-in rules
// can't. One AI call; the browser validates the plan against its catalog
// before anything runs, and only the studio's own operations execute it.
app.post('/api/swarm/plan', async (req, res) => {
  const { request, catalog, dataset, history, skills } = req.body || {};
  if (typeof request !== 'string' || !request.trim() || typeof catalog !== 'string') {
    return res.status(400).json({ error: 'A request and the capability catalog are required.' });
  }
  if (!aiKeyAvailable()) {
    return res.status(503).json({ error: 'AI planning is unavailable (no Gemini key). Try a simpler request the built-in planner understands.', reason: 'ai_unavailable' });
  }
  const columns = Array.isArray(dataset?.columns) ? dataset.columns.slice(0, 200) : [];
  const systemInstruction = `You are the Orchestrator of a data science agent team inside "Data Science Studio". Turn the user's request into a small task plan.
Rules:
- Use ONLY these capabilities (id, studio, usual specialist, params):
${catalog}
- Specialist roles and what each knows (follow their playbooks):
${typeof skills === 'string' ? skills.slice(0, 12000) : 'data_engineer, data_scientist, statistician, ml_engineer, bi_analyst, research_analyst, data_quality, verifier'}
- Give each task to the role that usually owns its capability (shown in the list above).
- Use exact column names from the dataset. Never invent columns or results.
- dependsOn lists task ids that must finish first. Data changes run in order; analyses that need clean data depend on the cleaning tasks.
- Keep the plan as small as the request needs (at most 30 tasks). Order: clean before analysing; analyses before dashboards and reports. For dashboards use dashboard.design with focus set to the user's words.
- If the user asks a question (about the data, statistics, the studio or a previous result) rather than asking for work, return NO tasks and answer it in reply, using only the facts given here. Say so when the facts don't answer it; never invent numbers or results.
- If the request is outside data science work in this studio, return no tasks and say so briefly in reply.
- params must be a JSON object string matching the capability's params.
- When there are tasks, reply is one or two plain sentences describing what the team will do (not claiming it is done).`;
  const fmt = (v: unknown) => (typeof v === 'number' ? Number(v.toPrecision(4)) : v);
  const safeHistory = (Array.isArray(history) ? history : []).slice(-8)
    .map((h: any) => `${h?.role === 'assistant' ? 'Assistant' : 'User'}: ${String(h?.content ?? '').slice(0, 600)}`).join('\n');
  const sample = Array.isArray(dataset?.sample) ? JSON.stringify(dataset.sample.slice(0, 3)).slice(0, 1500) : '';
  const prompt = `Dataset: ${String(dataset?.filename ?? 'unknown')} with ${Number(dataset?.rows ?? 0)} rows.
Columns: ${columns.map((c: any) => `${c.name} (${c.type}${c.missing ? `, ${c.missing} missing` : ''}${c.distinct != null ? `, ${c.distinct} distinct` : ''}${c.mean != null ? `, mean ${fmt(c.mean)}` : ''}${c.min != null ? `, min ${fmt(c.min)}` : ''}${c.max != null ? `, max ${fmt(c.max)}` : ''}${Array.isArray(c.top) && c.top.length ? `, most common ${c.top.slice(0, 3).join('/')}` : ''})`).join(', ')}
${sample ? `Sample rows: ${sample}\n` : ''}${safeHistory ? `Conversation so far:\n${safeHistory}\n` : ''}Request: ${request.slice(0, 2000)}`;
  try {
    const aiResponse: any = await generateContentWithRetry(getGeminiClient(), {
      contents: prompt,
      config: {
        systemInstruction,
        responseMimeType: 'application/json',
        responseSchema: {
          type: Type.OBJECT,
          required: ['reply', 'tasks'],
          properties: {
            reply: { type: Type.STRING },
            tasks: {
              type: Type.ARRAY,
              items: {
                type: Type.OBJECT,
                required: ['id', 'capability', 'params', 'role', 'dependsOn', 'why'],
                properties: {
                  id: { type: Type.STRING },
                  capability: { type: Type.STRING },
                  params: { type: Type.STRING, description: 'JSON object string' },
                  role: { type: Type.STRING },
                  dependsOn: { type: Type.ARRAY, items: { type: Type.STRING } },
                  why: { type: Type.STRING },
                },
              },
            },
          },
        },
      },
    });
    const parsed = JSON.parse(aiResponse?.text || '{}');
    const tasks = (Array.isArray(parsed.tasks) ? parsed.tasks : []).map((t: any) => {
      let params: unknown;
      try { params = JSON.parse(t.params || '{}'); } catch { params = {}; }
      return { ...t, params };
    });
    const usage = aiResponse?.usageMetadata || {};
    return res.json({
      reply: typeof parsed.reply === 'string' ? parsed.reply : '',
      tasks,
      usage: { inputTokens: usage.promptTokenCount ?? 0, outputTokens: usage.candidatesTokenCount ?? 0 },
    });
  } catch (err: any) {
    console.error('[AskDeepakAI] /api/swarm/plan failed:', err);
    return res.status(503).json({ error: 'AI planning failed: ' + (err?.message || 'unknown error'), reason: 'ai_failed' });
  }
});

// The Orchestrator's final review: does the run answer the request? One AI
// call, only when the browser asks for it (after a run). Proposed fixes are
// validated in the browser like any plan.
app.post('/api/swarm/review', async (req, res) => {
  const { request, tasks, catalog, dataset } = req.body || {};
  if (typeof request !== 'string' || !Array.isArray(tasks) || typeof catalog !== 'string') {
    return res.status(400).json({ error: 'The request, tasks and catalog are required.' });
  }
  if (!aiKeyAvailable()) return res.status(503).json({ error: 'AI review is unavailable (no Gemini key).', reason: 'ai_unavailable' });
  const columns = Array.isArray(dataset?.columns) ? dataset.columns.slice(0, 200) : [];
  const systemInstruction = `You are the Orchestrator of a data science agent team doing the final review of a finished run, before the user sees the report.
Decide whether the results answer the user's request. Use only the facts given.
- issues: concrete problems (at most 5): something requested but not delivered, a failed or contradicted result, a result that doesn't answer the question. Empty if none.
- tasks: corrective tasks only when a capability below can fix an issue (at most 4). Use ONLY these capabilities and exact column names:
${catalog}
  params must be a JSON object string; dependsOn may only list other new task ids. Never repeat a task that already succeeded with the same params.
- summary: one plain sentence for the user (what was checked and the outcome).`;
  const prompt = `Dataset columns: ${columns.map((c: any) => `${c.name} (${c.type})`).join(', ')}
Request: ${request.slice(0, 2000)}
Tasks and results:
${JSON.stringify(tasks).slice(0, 14000)}`;
  try {
    const aiResponse: any = await generateContentWithRetry(getGeminiClient(), {
      contents: prompt,
      config: {
        systemInstruction,
        responseMimeType: 'application/json',
        responseSchema: {
          type: Type.OBJECT,
          required: ['summary', 'issues', 'tasks'],
          properties: {
            summary: { type: Type.STRING },
            issues: { type: Type.ARRAY, items: { type: Type.STRING } },
            tasks: {
              type: Type.ARRAY,
              items: {
                type: Type.OBJECT,
                required: ['id', 'capability', 'params', 'dependsOn', 'why'],
                properties: {
                  id: { type: Type.STRING }, capability: { type: Type.STRING }, params: { type: Type.STRING, description: 'JSON object string' },
                  dependsOn: { type: Type.ARRAY, items: { type: Type.STRING } }, why: { type: Type.STRING },
                },
              },
            },
          },
        },
      },
    });
    const parsed = JSON.parse(aiResponse?.text || '{}');
    const out = (Array.isArray(parsed.tasks) ? parsed.tasks : []).slice(0, 4).map((t: any) => {
      let params: unknown;
      try { params = JSON.parse(t.params || '{}'); } catch { params = {}; }
      return { ...t, params };
    });
    const usage = aiResponse?.usageMetadata || {};
    return res.json({
      summary: typeof parsed.summary === 'string' ? parsed.summary : '',
      issues: Array.isArray(parsed.issues) ? parsed.issues.filter((x: unknown) => typeof x === 'string').slice(0, 5) : [],
      tasks: out,
      usage: { inputTokens: usage.promptTokenCount ?? 0, outputTokens: usage.candidatesTokenCount ?? 0 },
    });
  } catch (err: any) {
    console.error('[AskDeepakAI] /api/swarm/review failed:', err);
    return res.status(503).json({ error: 'AI review failed: ' + (err?.message || 'unknown error'), reason: 'ai_failed' });
  }
});

// Data drift between a model's training data and new data.
app.post('/api/monitor/drift', async (req, res) => {
  try {
    return res.json(await callMlService('/monitor/drift', { body: req.body }));
  } catch (err: any) {
    const status = typeof err.status === 'number' && err.status >= 400 && err.status < 500 ? 400 : 503;
    return res.status(status).json({ error: err.message || 'ML compute service unavailable.' });
  }
});

// Baseline forecasting with backtesting (Model step).
app.post('/api/forecast', async (req, res) => {
  try {
    return res.json(await callMlService('/forecast', { body: req.body }));
  } catch (err: any) {
    const status = typeof err.status === 'number' && err.status >= 400 && err.status < 500 ? 400 : 503;
    return res.status(status).json({ error: err.message || 'ML compute service unavailable.' });
  }
});

// Statistics step: real tests, regression and power analysis from the Python service.
for (const route of ['compare', 'regression', 'power'] as const) {
  app.post(`/api/stats/${route}`, async (req, res) => {
    try {
      return res.json(await callMlService(`/stats/${route}`, { body: req.body }));
    } catch (err: any) {
      const status = typeof err.status === 'number' && err.status >= 400 && err.status < 500 ? 400 : 503;
      return res.status(status).json({ error: err.message || 'ML compute service unavailable.' });
    }
  });
}

// --------------------------------------------------------------------------
// PHASE 2: Agentic analysis mode.
//
// A real reason -> act -> observe loop. Gemini is given the champion model's
// real metrics and a real EDA summary, and must call exactly one of a fixed,
// whitelisted set of real ml-service functions per turn (function-calling
// mode ANY, never free-text parsing). Each call executes a genuine retrain,
// feature drop, or VIF computation against the Python service; the real
// result is fed back to Gemini before it decides on the next step. There is
// no path here to arbitrary code execution - only these functions.
// --------------------------------------------------------------------------

const AGENT_MAX_STEPS = 5;
const AGENT_PLATEAU_THRESHOLD = 0.01; // stop if the latest step's relative gain falls below 1%

const AGENT_TOOLS = [
  {
    name: 'retrain_with_transform',
    description: 'Apply a real transform (log, sqrt, or standardize) to one numeric column - a feature or the target - and retrain the current model on the transformed data. Use this to address skew or scale issues visible in the real EDA output.',
    parameters: {
      type: Type.OBJECT,
      properties: {
        reasoning: { type: Type.STRING, description: 'Why this is worth trying, grounded in the real metrics/EDA you were given. Do not state a specific numeric outcome here - only the real result returned after this call is authoritative.' },
        column: { type: Type.STRING, description: 'The exact real column name to transform. Must be numeric.' },
        method: { type: Type.STRING, enum: ['log', 'sqrt', 'standardize'], description: 'Which transform to apply.' },
      },
      required: ['reasoning', 'column', 'method'],
    },
  },
  {
    name: 'drop_feature',
    description: 'Retrain the current model excluding one real feature. Use this if a feature looks noisy, redundant, or flagged by a multicollinearity check.',
    parameters: {
      type: Type.OBJECT,
      properties: {
        reasoning: { type: Type.STRING, description: 'Why this feature is suspected to hurt the model.' },
        feature: { type: Type.STRING, description: 'The exact real feature column name to drop.' },
      },
      required: ['reasoning', 'feature'],
    },
  },
  {
    name: 'check_multicollinearity',
    description: 'Compute real Variance Inflation Factor (VIF) scores for the current numeric features. Use this as a diagnostic before deciding whether to drop a feature.',
    parameters: {
      type: Type.OBJECT,
      properties: {
        reasoning: { type: Type.STRING, description: 'Why you want to check multicollinearity right now.' },
      },
      required: ['reasoning'],
    },
  },
  {
    name: 'declare_done',
    description: 'Stop the analysis loop because further steps are unlikely to help, or a satisfying conclusion has been reached.',
    parameters: {
      type: Type.OBJECT,
      properties: {
        reasoning: { type: Type.STRING, description: 'Why you are stopping now.' },
      },
      required: ['reasoning'],
    },
  },
];

const AGENT_TOOL_NAMES = AGENT_TOOLS.map(t => t.name);

app.post('/api/agent/run', async (req, res) => {
  const { data, target, features, modelKey, primaryMetric, primaryMetricValue } = req.body || {};

  if (!Array.isArray(data) || data.length === 0 || !target || !modelKey || typeof primaryMetricValue !== 'number') {
    return res.status(400).json({ error: 'data, target, modelKey, and a real primaryMetricValue are required to start the agent.' });
  }
  if (!aiKeyAvailable()) {
    return res.status(503).json({ error: 'Agentic mode needs a Gemini API key. Add your own free key with the key button in the toolbar - there is no honest way to run a reasoning loop without a real LLM to reason with. (Everything else in this app degrades to a template narrative without a key; this feature cannot, because the reasoning itself is the point.)' });
  }

  const client = getGeminiClient();

  let edaSummary: any = null;
  try {
    edaSummary = await callMlService('/eda', { body: { data } });
  } catch (err: any) {
    console.warn('[Agent] Real EDA fetch failed, proceeding without it:', err.message);
  }
  const compactEda = edaSummary ? {
    numericSummaries: (edaSummary.numericSummaries || []).map((s: any) => ({ column: s.column, mean: s.mean, std: s.std, skew: s.skew })),
    outliers: (edaSummary.outliers || []).filter((o: any) => o.outlierCount > 0).map((o: any) => ({ column: o.column, outlierPercent: o.outlierPercent })),
    missingReport: (edaSummary.missingReport || []).filter((m: any) => m.missingCount > 0).map((m: any) => ({ column: m.column, missingPercent: m.missingPercent })),
  } : null;

  let currentFeatures: string[] | null = Array.isArray(features) && features.length > 0 ? [...features] : null;
  let bestMetricValue = primaryMetricValue;
  let bestModelId: string | null = null;
  const triedActions = new Set<string>();
  const steps: any[] = [];

  const systemInstruction = `You are an ML diagnostics agent working on a REAL trained model - not a simulation. You will be given real metrics and a real EDA summary. On each turn, propose exactly ONE real diagnostic or fix by calling one of the provided tools. Ground every "reasoning" argument in the actual numbers you were given; never invent a statistic. After each call you will be told the REAL result before your next turn. You have at most ${AGENT_MAX_STEPS} steps - call declare_done as soon as further steps are unlikely to help.`;

  const history: any[] = [{
    role: 'user',
    parts: [{
      text: `Current champion model: ${modelKey} on target "${target}".
Real ${primaryMetric}: ${primaryMetricValue}.
Real feature list: ${JSON.stringify(currentFeatures)}
Real EDA summary (numeric column stats, outliers, missing values): ${JSON.stringify(compactEda)}

Propose the next diagnostic or fix.`,
    }],
  }];

  let stopReason = 'cap_reached';

  for (let stepNum = 1; stepNum <= AGENT_MAX_STEPS; stepNum++) {
    let response;
    try {
      response = await generateContentWithRetry(client, {
        contents: history,
        config: {
          systemInstruction,
          tools: [{ functionDeclarations: AGENT_TOOLS }],
          toolConfig: {
            functionCallingConfig: { mode: FunctionCallingConfigMode.ANY, allowedFunctionNames: AGENT_TOOL_NAMES },
          },
        },
      });
    } catch (err: any) {
      steps.push({ step: stepNum, error: err.message || 'Agent reasoning call failed.' });
      stopReason = 'error';
      break;
    }

    const calls = response.functionCalls;
    if (!calls || calls.length === 0) {
      stopReason = 'no_action_proposed';
      break;
    }
    const call = calls[0];
    history.push({ role: 'model', parts: [{ functionCall: { name: call.name, args: call.args } }] });

    if (call.name === 'declare_done') {
      steps.push({ step: stepNum, tool: 'declare_done', reasoning: (call.args as any)?.reasoning });
      stopReason = 'agent_declared_done';
      break;
    }

    const actionKey = `${call.name}:${JSON.stringify(call.args)}`;
    if (triedActions.has(actionKey)) {
      history.push({ role: 'user', parts: [{ functionResponse: { name: call.name!, response: { output: { note: 'This exact action was already tried this run. Propose something different or call declare_done.' } } } }] });
      continue;
    }
    triedActions.add(actionKey);

    let toolResult: any = null;
    let toolError: string | null = null;
    try {
      const args: any = call.args || {};
      if (call.name === 'retrain_with_transform') {
        toolResult = await callMlService('/agent/retrain-with-transform', {
          body: { data, target, features: currentFeatures, model_key: modelKey, column: args.column, method: args.method },
        });
      } else if (call.name === 'drop_feature') {
        toolResult = await callMlService('/agent/drop-feature', {
          body: { data, target, features: currentFeatures, model_key: modelKey, drop_feature: args.feature },
        });
      } else if (call.name === 'check_multicollinearity') {
        toolResult = await callMlService('/agent/check-multicollinearity', {
          body: { data, features: currentFeatures || [] },
        });
      } else {
        toolError = `Unknown tool "${call.name}" - not in the whitelist.`;
      }
    } catch (err: any) {
      toolError = err.message || String(err);
    }

    const stepRecord: any = { step: stepNum, tool: call.name, args: call.args, reasoning: (call.args as any)?.reasoning };

    if (toolError) {
      stepRecord.error = toolError;
      history.push({ role: 'user', parts: [{ functionResponse: { name: call.name!, response: { error: toolError } } }] });
    } else {
      stepRecord.result = toolResult;
      if (toolResult && typeof toolResult.primaryMetricValue === 'number') {
        const before = bestMetricValue;
        const after = toolResult.primaryMetricValue;
        stepRecord.metricBefore = before;
        stepRecord.metricAfter = after;
        stepRecord.improved = after > before;
        if (stepRecord.improved) {
          bestMetricValue = after;
          bestModelId = toolResult.modelId;
          if (call.name === 'drop_feature' && Array.isArray(toolResult.remainingFeatures)) {
            currentFeatures = toolResult.remainingFeatures;
          }
        }
      }
      history.push({ role: 'user', parts: [{ functionResponse: { name: call.name!, response: { output: toolResult } } }] });
    }

    steps.push(stepRecord);

    if (!toolError && typeof stepRecord.metricBefore === 'number' && stepNum > 1) {
      const denom = Math.abs(stepRecord.metricBefore) > 1e-9 ? Math.abs(stepRecord.metricBefore) : 1;
      const relativeGain = (stepRecord.metricAfter - stepRecord.metricBefore) / denom;
      if (relativeGain < AGENT_PLATEAU_THRESHOLD) {
        stopReason = 'plateau';
        break;
      }
    }
  }

  return res.json({
    steps,
    startingMetricValue: primaryMetricValue,
    finalPrimaryMetricValue: bestMetricValue,
    finalModelId: bestModelId,
    stopReason,
    maxSteps: AGENT_MAX_STEPS,
    whitelistedFunctions: AGENT_TOOL_NAMES,
  });
});

// MODULE 4: A/B Test Interpreter
app.post('/api/ab-test-interpreter', async (req, res) => {
  const { results } = req.body || {};
  const client = getGeminiClient();
  const hasKey = aiKeyAvailable();

  if (!hasKey) {
    return res.status(503).json({ error: 'A/B test memo generation needs a Gemini API key. Add your own free key with the key button in the toolbar.' });
  }

  try {
    const prompt = `You are a Product Analyst. Given these A/B test results:
${JSON.stringify(results)}

Generate a business recommendation memo: should we ship this feature or not, and why?
Return strict JSON: { "memo": "Memo content..." }`;
    const aiResponse = await generateContentWithRetry(client, {
      contents: prompt,
      config: {
        responseMimeType: 'application/json',
        responseSchema: {
          type: Type.OBJECT,
          properties: { memo: { type: Type.STRING } },
          required: ["memo"]
        }
      }
    });
    return res.json(JSON.parse(aiResponse.text || '{}'));
  } catch (err: any) {
    console.error('[AskDeepakAI] A/B Test Interpreter error:', err);
    return res.status(503).json({ error: 'AI memo generation is temporarily unavailable (the model is likely rate-limited). Please try again in a moment.' });
  }
});

// MODULE 5: Model Explainer
app.post('/api/model-explainer', async (req, res) => {
  const { featureImportance, metrics, context } = req.body || {};
  const client = getGeminiClient();
  const hasKey = aiKeyAvailable();

  if (!hasKey) {
    return res.json(buildModelExplainerFallback(featureImportance, metrics));
  }

  try {
    const prompt = `You are an AI Explainer. Given the following model feature importance, metrics, and context:
Feature Importance: ${JSON.stringify(featureImportance)}
Metrics: ${JSON.stringify(metrics)}
Context: ${JSON.stringify(context)}

Generate a plain-English narrative:
- Why the top 3 features matter most
- What each feature's high or low value means for the target
- One paragraph of business insight per top feature
- An overall model quality summary

Return strict JSON:
{
  "overallSummary": "The model performs well...",
  "topFeatures": [
    { "featureName": "Age", "explanation": "Why Age matters...", "impact": "High Age means...", "insight": "Business insight..." }
  ]
}`;
    const aiResponse = await generateContentWithRetry(client, {
      contents: prompt,
      config: {
        responseMimeType: 'application/json',
        responseSchema: {
          type: Type.OBJECT,
          properties: {
            overallSummary: { type: Type.STRING },
            topFeatures: {
              type: Type.ARRAY,
              items: {
                type: Type.OBJECT,
                properties: {
                  featureName: { type: Type.STRING },
                  explanation: { type: Type.STRING },
                  impact: { type: Type.STRING },
                  insight: { type: Type.STRING }
                },
                required: ["featureName", "explanation", "impact", "insight"]
              }
            }
          },
          required: ["overallSummary", "topFeatures"]
        }
      }
    });
    return res.json(JSON.parse(aiResponse.text || '{}'));
  } catch (err: any) {
    console.error('[AskDeepakAI] Model Explainer error, using template narrative built from the real feature importance/metrics:', err);
    return res.json(buildModelExplainerFallback(featureImportance, metrics));
  }
});

// MODULE 6: Executive PDF Report
app.post('/api/executive-pdf-report', async (req, res) => {
  const { reportData } = req.body || {};
  const client = getGeminiClient();
  const hasKey = aiKeyAvailable();

  if (!hasKey) {
    return res.json({ executiveSummary: 'Add a Gemini API key (the key button in the toolbar) to generate an AI-written executive summary. All underlying figures in this report are already real, computed values from the pipeline stages above.' });
  }

  try {
    const prompt = `You are a Chief Data Officer. Given the compiled data from all stages of analysis:
${JSON.stringify(reportData)}

Write a polished executive summary paragraph for a PDF report.
Return strict JSON: { "executiveSummary": "Summary here..." }`;
    const aiResponse = await generateContentWithRetry(client, {
      contents: prompt,
      config: {
        responseMimeType: 'application/json',
        responseSchema: {
          type: Type.OBJECT,
          properties: { executiveSummary: { type: Type.STRING } },
          required: ["executiveSummary"]
        }
      }
    });
    return res.json(JSON.parse(aiResponse.text || '{}'));
  } catch (err: any) {
    console.error('[AskDeepakAI] Executive PDF Report error:', err);
    return res.json({ executiveSummary: 'AI-written executive summary is temporarily unavailable (the model is likely rate-limited). All underlying figures in this report are still real, computed values from the pipeline stages above.' });
  }
});

// MODULE 7: ETL Script Generator
app.post('/api/etl-script-generator', async (req, res) => {
  const { transformations } = req.body || {};
  const client = getGeminiClient();
  const hasKey = aiKeyAvailable();

  if (!hasKey) {
    return res.status(503).json({ error: 'ETL script generation needs a Gemini API key. Add your own free key with the key button in the toolbar.' });
  }

  try {
    const prompt = `You are a Data Engineer. Given these data cleaning and transformation steps applied by the user:
${JSON.stringify(transformations)}

Generate a complete ready-to-run Python ETL script using pandas.
It should include:
- Data loading step
- All cleaning steps in order
- Export step to CSV

Return strict JSON with the python code:
{ "script": "import pandas as pd\\n..." }`;
    const aiResponse = await generateContentWithRetry(client, {
      contents: prompt,
      config: {
        responseMimeType: 'application/json',
        responseSchema: {
          type: Type.OBJECT,
          properties: { script: { type: Type.STRING } },
          required: ["script"]
        }
      }
    });
    return res.json(JSON.parse(aiResponse.text || '{}'));
  } catch (err: any) {
    console.error('[AskDeepakAI] ETL Script Generator error:', err);
    return res.status(503).json({ error: 'AI ETL script generation is temporarily unavailable (the model is likely rate-limited). Please try again in a moment.' });
  }
});

// MODULE 8: Dashboard Configurator
app.post('/api/dashboard/auto-configure', async (req, res) => {
  const { profile, customProblem } = req.body || {};
  const client = getGeminiClient();
  const hasKey = aiKeyAvailable();

  if (!hasKey) {
    return res.json(buildDashboardAutoConfigFallback(profile, customProblem));
  }

  try {
    const prompt = `You are an expert dashboard designer. Given this dataset profile:
${JSON.stringify(profile)}
${customProblem ? `\nThe user explicitly stated the business problem is: ${customProblem}` : ''}

Recommend the most appropriate dashboard components from this list: KPI Cards, Line Chart, Bar Chart, Pie Chart, Scatter Plot, Histogram, Heatmap Correlation Matrix, Geographic Map, Treemap, Funnel Chart, Box Plot, Area Chart, Data Table, Filters Panel, Slicers Panel.

For each recommended component, specify:
1. type: The component type (exact match with the list above).
2. columnsToUse: Which column names from the dataset to use.
3. questionAnswered: What business question it answers.
4. whyRelevant: Why it is relevant to this dataset.

Also identify the top 5 most important KPIs (numerical columns to track).
Return strict JSON:
{
  "recommendedComponents": [
    {
      "type": "string",
      "columnsToUse": ["col1", "col2"],
      "questionAnswered": "string",
      "whyRelevant": "string"
    }
  ],
  "topKPIs": ["col1", "col2", "col3"],
  "detectedDomain": "string",
  "detectedProblem": "string"
}`;
    const aiResponse = await generateContentWithRetry(client, {
      contents: prompt,
      config: {
        responseMimeType: 'application/json',
        responseSchema: {
          type: Type.OBJECT,
          properties: {
            recommendedComponents: {
              type: Type.ARRAY,
              items: {
                type: Type.OBJECT,
                properties: {
                  type: { type: Type.STRING },
                  columnsToUse: { type: Type.ARRAY, items: { type: Type.STRING } },
                  questionAnswered: { type: Type.STRING },
                  whyRelevant: { type: Type.STRING }
                },
                required: ["type", "columnsToUse", "questionAnswered", "whyRelevant"]
              }
            },
            topKPIs: { type: Type.ARRAY, items: { type: Type.STRING } },
            detectedDomain: { type: Type.STRING },
            detectedProblem: { type: Type.STRING }
          },
          required: ["recommendedComponents", "topKPIs", "detectedDomain", "detectedProblem"]
        }
      }
    });
    return res.json(JSON.parse(aiResponse.text || '{}'));
  } catch (err: any) {
    console.error('[AskDeepakAI] Dashboard auto-configure error, using a rule-based default layout:', err);
    return res.json(buildDashboardAutoConfigFallback(profile, customProblem));
  }
});

// MODULE 9: Dashboard Insight Banner
app.post('/api/dashboard/insight-banner', async (req, res) => {
  const { dataStateSummary } = req.body || {};
  const client = getGeminiClient();
  const hasKey = aiKeyAvailable();

  if (!hasKey) {
    return res.json({ insights: [] });
  }

  try {
    const prompt = `You are an executive business analyst. Given this summary of the current filtered data state on a dashboard:
${JSON.stringify(dataStateSummary)}

Return 3 bullet points of the most critical business insights visible in this current dashboard view. These should be short, concise, and highly actionable or descriptive. DO NOT return markdown formatting like '*' or '-', just the raw sentences in an array.

Return strict JSON:
{
  "insights": ["Insight 1", "Insight 2", "Insight 3"]
}`;
    const aiResponse = await generateContentWithRetry(client, {
      contents: prompt,
      config: {
        responseMimeType: 'application/json',
        responseSchema: {
          type: Type.OBJECT,
          properties: {
            insights: { type: Type.ARRAY, items: { type: Type.STRING } }
          },
          required: ["insights"]
        }
      }
    });
    return res.json(JSON.parse(aiResponse.text || '{}'));
  } catch (err: any) {
    console.error('[AskDeepakAI] Dashboard insight banner error:', err);
    return res.json({ insights: [] });
  }
});

// --- ENTERPRISE ENDPOINTS: INGESTION, DB CONNECTIONS, AND MLOPS ---

import { Client } from 'pg';

const savedDbConfig: any = null;

app.post('/api/db-connections', async (req, res) => {
  const { provider, connectionString } = req.body;

  if (!provider || !connectionString) {
    return res.status(400).json({ error: "Provider and Connection string required." });
  }

  if (provider === 'PostgreSQL') {
    // Always use SSL for non-localhost connections, with real certificate
    // verification (the pg/Node default) - accepting any certificate
    // (rejectUnauthorized: false) defeats SSL's MITM protection entirely
    // while still claiming to be secure.
    const isLocal = connectionString.includes('localhost') || connectionString.includes('127.0.0.1');

    const client = new Client({
      connectionString,
      connectionTimeoutMillis: 10000,
      ...(!isLocal ? { ssl: true } : {})
    });

    try {
      await client.connect();
      // fetch all tables in public schema
      const tablesRes = await client.query(`
        SELECT table_name
        FROM information_schema.tables
        WHERE table_schema = 'public'
        AND table_type = 'BASE TABLE'
      `);

      if (tablesRes.rows.length === 0) {
        await client.end();
        return res.status(400).json({ error: "No tables found in the public schema of the provided database." });
      }

      // query the first table
      const firstTable = tablesRes.rows[0].table_name;
      const dataRes = await client.query(`SELECT * FROM "${firstTable}" LIMIT 2000`);

      await client.end();

      return res.json({
        status: "success",
        message: `Connected to PostgreSQL. Loaded ${dataRes.rows.length} rows from table "${firstTable}".`,
        data: dataRes.rows
      });

    } catch (err: any) {
      // try to end client if it's connected
      try { await client.end(); } catch { /* connection already closed */ }

      let errorMsg = err.message || String(err);

      // Friendly messages for common connection errors
      if (errorMsg.includes('EAI_AGAIN') || errorMsg.includes('ENOTFOUND')) {
        errorMsg = `Could not resolve hostname '${errorMsg.split(' ').pop()}'. Please check if your connection string has the correct database host URL, and that it is publicly accessible.`;
      } else if (errorMsg.includes('ECONNREFUSED')) {
        errorMsg = `Connection refused. The database might be offline or blocking port standard database ports.`;
      } else if (errorMsg.includes('ETIMEDOUT') || errorMsg.includes('Connection timed out') || errorMsg.includes('timeout expired')) {
        errorMsg = 'Connection timed out. The database is either unreachable, offline, or blocking traffic from this IP via a firewall. Make sure the database allows public outside connections.';
      } else if (errorMsg.includes('no pg_hba.conf entry')) {
        errorMsg = 'Database rejected connection (no pg_hba.conf entry). You may need to allow public access or add this IP to the allowlist.';
      } else if (errorMsg.includes('password authentication failed')) {
        errorMsg = 'Password authentication failed. Please verify your database username and password.';
      } else if (errorMsg.includes('self signed certificate') || errorMsg.includes('self-signed certificate') || errorMsg.includes('unable to verify the first certificate') || errorMsg.includes('unable to get local issuer certificate')) {
        errorMsg = 'Could not verify the database\'s SSL certificate (it may be self-signed or use an untrusted certificate authority). For security, connections with an unverifiable certificate are refused rather than silently accepted.';
      }

      return res.status(500).json({ error: "Failed to connect to PostgreSQL: " + errorMsg });
    }
  }

  // Only PostgreSQL is supported; never report a connection that didn't happen.
  return res.status(400).json({ error: `${provider || 'This provider'} is not supported yet. Only PostgreSQL connections are available.` });
});

// Mock BI utility for schema validation check
app.post('/api/validate-schema', (req, res) => {
  const { data } = req.body;
  if (!Array.isArray(data) || data.length === 0) {
     return res.status(400).json({ status: "error", error: "Empty Dataset" });
  }
  
  const sample = data[0];
  const schemaNullsCount = Object.keys(sample).filter(k => sample[k] === null || sample[k] === undefined).length;
  
  if (schemaNullsCount > Object.keys(sample).length * 0.5) {
     return res.status(400).json({ status: "error", error: "Schema Validation Failed: Excess null columns detected." });
  }
  
  return res.json({ status: "success", message: "Schema validated for Data Warehouse ingestion" });
});

// Real MLOps API Layer — thin proxies to the Python FastAPI compute service.
// No mock data here: if the Python service is down, callers get a clear 503
// error rather than a fabricated "success" response.
app.post('/api/train', async (req, res) => {
  const { data, target } = req.body || {};
  if (!Array.isArray(data) || data.length === 0 || !target) {
    return res.status(400).json({ error: 'Missing training data or target column.' });
  }
  try {
    const result = await callMlService('/train', { body: req.body });
    return res.json(result);
  } catch (err: any) {
    console.error('[AskDeepakAI] /api/train proxy failed:', err);
    return res.status(503).json({ error: err.message || 'ML compute service unavailable.' });
  }
});

app.post('/api/predict', async (req, res) => {
  const { features } = req.body || {};
  if (!features || !Array.isArray(features)) {
    return res.status(400).json({ error: 'Missing features array' });
  }
  try {
    const result = await callMlService('/predict', { body: req.body });
    return res.json(result);
  } catch (err: any) {
    console.error('[AskDeepakAI] /api/predict proxy failed:', err);
    // 404 means the service restarted and forgot the model; the studio then restores it.
    const status = typeof err.status === 'number' && err.status >= 400 && err.status < 500 ? err.status : 503;
    return res.status(status).json({ error: err.message || 'ML compute service unavailable.' });
  }
});

app.post('/api/drift-metrics', async (req, res) => {
  try {
    const result = await callMlService('/drift-metrics', { body: req.body });
    return res.json(result);
  } catch (err: any) {
    console.error('[AskDeepakAI] /api/drift-metrics proxy failed:', err);
    return res.status(503).json({ error: err.message || 'ML compute service unavailable.' });
  }
});

// Streams the real, genuinely-fitted joblib artifact back from the Python service.
app.get('/api/ml/download/:modelId', async (req, res) => {
  try {
    const upstream = await fetch(`${await getMlServiceUrl()}/download/${encodeURIComponent(req.params.modelId)}`, { headers: mlHeaders() });
    if (!upstream.ok) {
      const text = await upstream.text().catch(() => '');
      return res.status(upstream.status).json({ error: text || 'Model not found or expired. Train again.' });
    }
    const disposition = upstream.headers.get('content-disposition');
    if (disposition) res.setHeader('Content-Disposition', disposition);
    res.setHeader('Content-Type', upstream.headers.get('content-type') || 'application/octet-stream');
    const buffer = Buffer.from(await upstream.arrayBuffer());
    return res.send(buffer);
  } catch (err: any) {
    console.error('[AskDeepakAI] /api/ml/download proxy failed:', err);
    return res.status(503).json({ error: 'ML compute service is unavailable, so the model artifact cannot be downloaded.' });
  }
});

// Engine v2 (datasets, analyses, jobs, models, monitoring, runs, schedules):
// /api/engine/<path> is passed through to <engine>/v2/<path> with the token added.
// JSON bodies are re-sent as JSON; anything else (file uploads) is streamed as is.
const ENGINE_PROXY_TIMEOUT_MS = 30 * 60 * 1000; // matches how long a background studio job may live
const ENGINE_FORWARD_RESPONSE_HEADERS = ['content-type', 'content-disposition'];
app.all('/api/engine/*', async (req, res) => {
  const tail = req.originalUrl.replace(/^\/api\/engine\/?/, '');
  if (tail.split('?')[0].split('/').some(part => part === '..')) {
    return res.status(400).json({ error: 'Invalid engine path.' });
  }
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), ENGINE_PROXY_TIMEOUT_MS);
  try {
    const baseUrl = await getMlServiceUrl();
    const hasBody = !['GET', 'HEAD'].includes(req.method);
    const isJson = req.is('application/json');
    const headers = mlHeaders({
      ...(hasBody && req.get('content-type') ? { 'Content-Type': req.get('content-type') as string } : {}),
      // Who acted, for the engine's audit log and model approvals (an attribution hint, not authentication).
      ...(req.get('x-engine-user') ? { 'X-Engine-User': String(req.get('x-engine-user')).slice(0, 200) } : {}),
    });
    const init: any = { method: req.method, headers, signal: controller.signal };
    if (hasBody) {
      if (isJson) init.body = JSON.stringify(req.body ?? {});
      else { init.body = req; init.duplex = 'half'; }
    }
    const upstream = await fetch(`${baseUrl}/v2/${tail}`, init);
    res.status(upstream.status);
    const contentType = upstream.headers.get('content-type') || '';
    // JSON goes back through res.json so the background-job layer (X-Async-Job) can capture it.
    if (contentType.includes('application/json') && !upstream.headers.get('content-disposition')) {
      const text = await upstream.text();
      let parsed: unknown = null;
      try { parsed = text ? JSON.parse(text) : null; } catch { parsed = { error: text }; }
      return res.json(parsed);
    }
    for (const name of ENGINE_FORWARD_RESPONSE_HEADERS) {
      const value = upstream.headers.get(name);
      if (value) res.setHeader(name, value);
    }
    return res.send(Buffer.from(await upstream.arrayBuffer()));
  } catch (err: any) {
    console.error('[AskDeepakAI] /api/engine proxy failed:', err);
    const timedOut = err?.name === 'AbortError';
    return res.status(timedOut ? 504 : 503).json({
      error: timedOut ? 'The engine took too long to answer.' : 'The analysis engine is unavailable right now.',
    });
  } finally {
    clearTimeout(timeoutId);
  }
});

async function start() {
  if (process.env.NODE_ENV !== 'production') {
    const { createServer: createViteServer } = await import('vite');
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    // Production serving from dist/
    const distPath = path.join(process.cwd(), 'dist');
    app.use(express.static(distPath));
    app.get('*', (req, res) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  // Learn which Gemini models exist now (in the background), and check again daily.
  if (ownerGeminiKey()) {
    refreshGeminiModels(true).catch(() => {});
    setInterval(() => { refreshGeminiModels(true).catch(() => {}); }, 24 * 60 * 60 * 1000).unref();
  }
  app.listen(PORT, '0.0.0.0', () => {
    console.log(`[AskDeepakAI Working Server] Running on http://localhost:${PORT}`);
  });
}

start();


// --- FAILBACK HELPERS TO ENERGIZE THE WORKSTATION INSTANTLY EVEN WITHOUT KEYS ---




// Truthful, non-AI fallback narrative used only when GEMINI_API_KEY isn't
// configured or the interpretation call fails. Every figure it quotes is read
// straight out of baseResult (the real Python training response) — nothing
// here is invented, unlike the metrics this function used to fabricate.
function buildTemplateNarrative(baseResult: any, target: string, features: string[]) {
  const isClassification = baseResult.modelType === 'classification';
  const m = baseResult.metrics || {};
  const scoreLine = isClassification
    ? `Accuracy: ${(((m.accuracy ?? 0)) * 100).toFixed(1)}% · F1: ${(((m.f1Score ?? 0)) * 100).toFixed(1)}% · Precision: ${(((m.precision ?? 0)) * 100).toFixed(1)}% · Recall: ${(((m.recall ?? 0)) * 100).toFixed(1)}%`
    : `R²: ${(m.r2Score ?? 0).toFixed(3)} · RMSE: ${(m.rmse ?? 0).toFixed(2)} · MAE: ${(m.mae ?? 0).toFixed(2)}`;

  const topFeatures: string[] = (baseResult.featureImportance || []).slice(0, 3).map((f: any) => f.feature);
  const cv = baseResult.cv;
  const cvLine = cv && typeof cv.mean === 'number'
    ? `#### Cross-Validation (${cv.folds}-fold)\nMean ${cv.metric}: ${cv.metric === 'accuracy' ? (cv.mean * 100).toFixed(1) + '%' : cv.mean.toFixed(3)} (± ${cv.std.toFixed(3)})\n`
    : '';

  const markdownReport = `### Model Performance Brief: predicting ${target}

**Algorithm**: ${baseResult.modelAlgorithm}
**Train / Test rows**: ${baseResult.trainRows ?? '-'} / ${baseResult.testRows ?? '-'}

#### Real Evaluation Results (held-out test set)
${scoreLine}

${cvLine}
#### Top Predictive Features
${topFeatures.length > 0 ? topFeatures.map((f, i) => `${i + 1}. ${f}`).join('\n') : 'No feature importances were returned for this model.'}

_These numbers come directly from a scikit-learn/XGBoost model trained and evaluated on a held-out test split. Enable the AI assistant for a written business narrative of these same results._`;

  return {
    markdownReport,
    risks: [
      {
        title: 'Single Held-Out Split',
        riskLevel: 'Medium' as const,
        description: `These metrics reflect one random ${Math.round((1 - (baseResult.trainRatio ?? 0.8)) * 100)}% held-out test split. Re-run with a different split or monitor live performance before fully trusting the model in production.`
      }
    ],
    recommendations: [
      {
        title: 'Validate the Top Feature With a Domain Expert',
        impact: 'High' as const,
        details: `"${topFeatures[0] || 'the top-ranked feature'}" carries the highest measured importance for predicting ${target}. Confirm this matches business intuition before acting on it.`
      }
    ],
    scientistCallout: {
      focusColumns: topFeatures.slice(0, 2).length > 0 ? topFeatures.slice(0, 2) : features.slice(0, 2),
      justification: 'These are the columns with the largest real feature-importance weights extracted from the trained model.',
      pathways: [
        `Plot ${topFeatures[0] || 'the top feature'} against ${target} to visually confirm the relationship.`,
        'Re-run training with a different random seed or test split to check how stable these metrics are.'
      ]
    }
  };
}

// Truthful, non-AI narrative for the real EDA endpoint — used only when
// GEMINI_API_KEY isn't configured or the interpretation call fails. Every
// figure it cites is read straight out of edaResult (the real pandas/numpy
// computation), nothing here is invented.
function buildEdaTemplateNarrative(edaResult: any) {
  const missingReport = edaResult.missingReport || [];
  const numericSummaries = edaResult.numericSummaries || [];
  const outliers = edaResult.outliers || [];

  const highMissing = missingReport.filter((m: any) => m.missingPercent > 20);
  const highSkew = numericSummaries.filter((s: any) => Math.abs(s.skew) > 1);
  const withOutliers = outliers.filter((o: any) => o.outlierCount > 0);

  const summary = `Real EDA scan of ${edaResult.rowCount} rows across ${edaResult.columnCount} columns. ` +
    `${highMissing.length} column(s) exceed 20% missing values. ` +
    `${highSkew.length} numeric column(s) show skew beyond ±1. ` +
    `${withOutliers.length} numeric column(s) have IQR-flagged outliers. ` +
    `Enable the AI assistant for a written narrative of these same real numbers.`;

  const dataQualityFlags = [
    ...highMissing.map((m: any) => ({
      column: m.column,
      issue: `${m.missingPercent}% missing values`,
      severity: (m.missingPercent > 50 ? 'High' : 'Medium') as 'High' | 'Medium' | 'Low'
    })),
    ...withOutliers.map((o: any) => ({
      column: o.column,
      issue: `${o.outlierCount} IQR-flagged outliers (${o.outlierPercent}%)`,
      severity: (o.outlierPercent > 10 ? 'High' : 'Low') as 'High' | 'Medium' | 'Low'
    }))
  ];

  const recommendedNextSteps = [
    highMissing.length > 0 ? `Decide an imputation or drop strategy for: ${highMissing.map((m: any) => m.column).join(', ')}.` : null,
    withOutliers.length > 0 ? `Review outliers in: ${withOutliers.map((o: any) => o.column).join(', ')} before training a model.` : null,
    'Re-run this scan after cleaning to confirm the real numbers improved.'
  ].filter((s): s is string => !!s);

  return { summary, dataQualityFlags, recommendedNextSteps };
}

// Truthful, non-AI fixes for the Deep Quality Audit — used only when
// GEMINI_API_KEY isn't configured or the interpretation call fails. Every
// issue here was already found by real, client-computed checks (missing
// counts, constant columns, high-cardinality, mixed types); this only
// supplies a mechanical, genuinely-correct pandas snippet for each one,
// nothing about the underlying finding is invented.
// The audit's rules live in src/utils/qualityAuditFixes.ts (shared with the studio).
const buildDeepQualityAuditFallback = buildQualityFixes;

// Truthful, non-AI narrative for the Model Explainer — used only when
// GEMINI_API_KEY isn't configured or the interpretation call fails. Every
// feature name and score here is copied verbatim from the real, already-
// computed featureImportance/metrics passed in; nothing is invented.
function buildModelExplainerFallback(featureImportance: any, metrics: any) {
  const ranked = (Array.isArray(featureImportance) ? featureImportance : []).slice(0, 3);
  const m = metrics || {};
  const metricLine = typeof m.accuracy === 'number'
    ? `${(m.accuracy * 100).toFixed(1)}% accuracy`
    : typeof m.r2Score === 'number'
      ? `an R² of ${m.r2Score.toFixed(3)}`
      : 'the metrics shown';

  return {
    overallSummary: `AI-written explanation is currently unavailable, so here are the measured results: this model reached ${metricLine}, and its real, measured feature-importance weights are listed below in ranked order.`,
    topFeatures: ranked.map((f: any) => ({
      featureName: f.feature,
      explanation: `"${f.feature}" carries a real measured importance score of ${f.score} in the trained model — the highest-weighted features drive most of its predictions.`,
      impact: `Higher or lower values of "${f.feature}" shift the model's prediction more than most other features.`,
      insight: `Validate whether "${f.feature}"'s relationship with the target matches domain expectations before trusting this model in production.`
    }))
  };
}

// Rule-based dashboard layout — used only when GEMINI_API_KEY isn't
// configured or the interpretation call fails. Recommends components with
// an empty columnsToUse so the frontend's own column-selection fallback
// (IntelligentDashboardLayer's getColsForComp) picks real columns from the
// real dataset profile; nothing here is a fabricated insight, just a
// sensible default layout.
function buildDashboardAutoConfigFallback(profile: any, customProblem?: string) {
  const columns = Array.isArray(profile?.columns) ? profile.columns : [];
  const numericCols = columns.filter((c: any) => c.type === 'numeric').map((c: any) => c.name);
  const categoricalCols = columns.filter((c: any) => c.type === 'categorical' || c.type === 'boolean').map((c: any) => c.name);

  const recommendedComponents: Array<{ type: string; columnsToUse: string[]; questionAnswered: string; whyRelevant: string }> = [
    { type: 'KPI Cards', columnsToUse: [], questionAnswered: 'What are the current headline numbers?', whyRelevant: 'Numeric columns summarized at a glance.' }
  ];
  if (categoricalCols.length > 0 && numericCols.length > 0) {
    recommendedComponents.push({ type: 'Bar Chart', columnsToUse: [], questionAnswered: 'How does the metric break down by category?', whyRelevant: 'A categorical and a numeric column are both available.' });
  }
  if (numericCols.length > 0) {
    recommendedComponents.push({ type: 'Histogram', columnsToUse: [], questionAnswered: 'How is this metric distributed?', whyRelevant: 'Numeric columns are present to profile.' });
  }
  if (numericCols.length >= 2) {
    recommendedComponents.push({ type: 'Heatmap Correlation Matrix', columnsToUse: [], questionAnswered: 'Which numeric features move together?', whyRelevant: 'At least 2 numeric columns are available to correlate.' });
  }
  recommendedComponents.push({ type: 'Data Table', columnsToUse: [], questionAnswered: 'What do the raw records look like?', whyRelevant: 'A row-level view is always useful alongside aggregates.' });

  return {
    recommendedComponents,
    topKPIs: numericCols.slice(0, 5),
    detectedDomain: 'Generic Data',
    detectedProblem: customProblem || 'Analyze the dataset for trends and patterns.'
  };
}
