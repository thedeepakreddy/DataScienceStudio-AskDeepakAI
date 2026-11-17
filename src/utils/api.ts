/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { aiKeyHeaders } from './aiKey';
import { finishJob, labelForUrl, startJob } from './jobs';

const JSON_HEADERS = { 'Content-Type': 'application/json' };

// Poll quickly at first so fast calls feel instant, then ease off.
const POLL_DELAYS_MS = [400, 800, 1200, 2000];
// A poll can fail for dull reasons (a phone switching tabs, a network blip);
// the work is still running on the server, so keep asking for a while.
const MAX_CONSECUTIVE_POLL_FAILURES = 8;
// Longest a single job is waited for before giving up.
const MAX_WAIT_MS = 12 * 60 * 1000;

const sleep = (ms: number, signal?: AbortSignal | null) =>
  new Promise<void>((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => {
      clearTimeout(timer);
      reject(new DOMException('Aborted', 'AbortError'));
    }, { once: true });
  });

const jsonResponse = (status: number, body: unknown) =>
  new Response(JSON.stringify(body ?? null), { status, headers: JSON_HEADERS });

/** Fired on `window` whenever an API call finishes, so status indicators can refresh. */
export const API_SETTLED_EVENT = 'studio:api-settled';
const announceSettled = () => window.dispatchEvent(new Event(API_SETTLED_EVENT));

/**
 * Drop-in replacement for `fetch` for calls to this app's own API that may be
 * slow (model training, waking the ML engine, AI calls).
 *
 * A plain request that waits minutes for its answer is unreliable: Safari and
 * every iOS browser drop a request after 60 silent seconds ("Load failed"),
 * and switching tabs on a phone can abort it. So the server answers at once
 * with a job id and this collects the result with short polls. The returned
 * Response has the status and JSON body the endpoint produced, so callers
 * keep using `res.ok`, `res.json()` and `res.text()` exactly as before.
 */
export async function apiFetch(url: string, init: RequestInit = {}): Promise<Response> {
  // Every call shows up in the jobs panel, which can stop waiting for it.
  const controller = new AbortController();
  init.signal?.addEventListener('abort', () => controller.abort(), { once: true });
  const jobId = startJob(labelForUrl(url), controller);
  try {
    const res = await runApiFetch(url, { ...init, signal: controller.signal });
    if (res.ok) {
      finishJob(jobId, 'succeeded');
    } else {
      const body = await res.clone().json().catch(() => null);
      finishJob(jobId, 'failed', body?.error || `HTTP ${res.status}`);
    }
    return res;
  } catch (err: any) {
    finishJob(jobId, err?.name === 'AbortError' ? 'stopped' : 'failed', err?.message);
    throw err;
  }
}

async function runApiFetch(url: string, init: RequestInit): Promise<Response> {
  const signal = init.signal;
  const start = await fetch(url, {
    ...init,
    headers: { ...JSON_HEADERS, ...(init.headers as Record<string, string> | undefined), ...aiKeyHeaders(), 'X-Async-Job': '1' },
  });

  // Not handed off as a job (e.g. an older server) - the response is the answer.
  if (start.status !== 202) {
    announceSettled();
    return start;
  }
  const jobId: string | undefined = (await start.json().catch(() => null))?.jobId;
  if (!jobId) return jsonResponse(502, { error: 'The server did not start the request. Please try again.' });

  const startedAt = Date.now();
  let failures = 0;
  for (let attempt = 0; ; attempt++) {
    await sleep(POLL_DELAYS_MS[Math.min(attempt, POLL_DELAYS_MS.length - 1)], signal);

    if (Date.now() - startedAt > MAX_WAIT_MS) {
      return jsonResponse(504, { error: 'This is taking longer than expected. Please try again.' });
    }

    let poll: Response;
    try {
      poll = await fetch(`/api/jobs/${encodeURIComponent(jobId)}`, { signal, cache: 'no-store' });
    } catch (err: any) {
      if (err?.name === 'AbortError') throw err;
      if (++failures >= MAX_CONSECUTIVE_POLL_FAILURES) throw err;
      continue;
    }
    failures = 0;

    if (poll.status === 404) {
      // The server restarted (free hosting does this) and lost the job.
      return jsonResponse(503, { error: 'The server restarted before this finished. Please try again.' });
    }
    const state = await poll.json().catch(() => null);
    if (state?.done) {
      announceSettled();
      return jsonResponse(state.status ?? 200, state.body);
    }
  }
}
