/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

// Turns a failed Gemini call into a reason a person can act on. Kept free of
// side effects (and of the server) so it can be exercised on its own.

export type GeminiFailureKind = 'no_key' | 'bad_key' | 'quota' | 'model_unavailable' | 'busy' | 'network' | 'unknown';

export function classifyGeminiError(err: any): GeminiFailureKind {
  const text = `${err?.status ?? ''} ${err?.message || err}`.toLowerCase();
  if (/api key not valid|api_key_invalid|api key expired|permission_denied|unauthenticated|\b40[13]\b/.test(text)) return 'bad_key';
  if (/\b429\b|resource_exhausted|quota|rate limit/.test(text)) return 'quota';
  if (/\b404\b|not_found|is not found|not supported for generatecontent|no longer available/.test(text)) return 'model_unavailable';
  if (/\b50[03]\b|unavailable|overloaded|high demand/.test(text)) return 'busy';
  if (/fetch failed|enotfound|econnrefused|econnreset|network|timed out|timeout/.test(text)) return 'network';
  return 'unknown';
}

// Several models are tried in turn and can fail for different reasons. A key
// or quota problem explains everything; "model unavailable" is only the story
// when it is the reason every single model gave.
const FAILURE_PRIORITY: GeminiFailureKind[] = ['no_key', 'bad_key', 'quota', 'busy', 'network', 'unknown'];

export function mostTellingFailure(kinds: GeminiFailureKind[]): GeminiFailureKind {
  if (kinds.length === 0) return 'unknown';
  if (kinds.every(k => k === 'model_unavailable')) return 'model_unavailable';
  return FAILURE_PRIORITY.find(k => kinds.includes(k)) ?? 'unknown';
}

export function describeGeminiFailure(kind: GeminiFailureKind, models: string[]): string {
  switch (kind) {
    case 'no_key':
      return 'No Gemini API key is set on the server. Add GEMINI_API_KEY in your hosting environment settings and redeploy.';
    case 'bad_key':
      return 'Google rejected the Gemini API key (invalid, expired or restricted). Create a new key in Google AI Studio and update GEMINI_API_KEY.';
    case 'quota':
      return 'The Gemini quota for this API key is used up for now. Free-tier limits reset on their own; wait a little, or enable billing for the key.';
    case 'model_unavailable':
      return `Google no longer serves the Gemini models this app asks for (${models.join(', ')}). The model list in server.ts needs updating.`;
    case 'busy':
      return 'Gemini is temporarily overloaded. Try again in a minute.';
    case 'network':
      return "The server could not reach Google's Gemini API.";
    default:
      return 'Gemini returned an unexpected error.';
  }
}

/** Google's errors arrive as a JSON string; keep just the human-readable part. */
export function summarizeGeminiError(err: any): string {
  const raw = String(err?.message || err || 'No response from any model.');
  try {
    const parsed = JSON.parse(raw)?.error;
    if (parsed?.message) return `${parsed.status ? `${parsed.status}: ` : ''}${parsed.message}`.slice(0, 300);
  } catch { /* not JSON - use it as is */ }
  return raw.slice(0, 300);
}
