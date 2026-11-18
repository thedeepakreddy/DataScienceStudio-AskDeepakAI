/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

// Which Gemini models the studio asks, newest first. Google retires models
// regularly; instead of a list fixed in the code, the server asks Google which
// models the key can use (ListModels) and keeps the newest suitable ones. It
// refreshes on its own when a model stops working, and the studio has an
// "Update to latest model" button for the same thing.

/** Used until discovery has run, or when it can't (no key, Google unreachable). */
export const FALLBACK_GEMINI_MODELS = ['gemini-3.8-flash', 'gemini-3.6-flash', 'gemini-flash-latest', 'gemini-2.5-flash'];

export interface ListedModel { name?: string; supportedActions?: string[]; displayName?: string }

// Models for other jobs (pictures, speech, embeddings, live audio, robotics …), not text answers.
const NOT_FOR_TEXT = /(embed|image|imagen|tts|audio|live|native|vision|robotics|computer-use|aqa|learnlm|gemma|veo|thinking-exp|-exp-|-exp$|customtools)/;

/** The model's version (3.8 for gemini-3.8-flash-001), or null for aliases such as gemini-flash-latest. */
function version(id: string): number | null {
  const m = /^gemini-(\d+(?:\.\d+)?)/.exec(id);
  return m ? Number(m[1]) : null;
}

/**
 * The best models for the studio's text answers, best first: newest stable Flash,
 * then newest stable Pro and Flash-Lite, previews after stable ones; at most `limit`.
 */
export function rankGeminiModels(listed: ListedModel[], limit = 3): string[] {
  const ids = listed
    .filter(m => !m.supportedActions || m.supportedActions.includes('generateContent'))
    .map(m => String(m.name ?? '').replace(/^models\//, ''))
    .filter(id => id.startsWith('gemini-') && !NOT_FOR_TEXT.test(id));
  const score = (id: string) => {
    const v = version(id);
    const preview = /preview/.test(id);
    const lite = /lite/.test(id);
    const pro = /pro/.test(id);
    const flash = /flash/.test(id) && !lite;
    // A dated or numbered snapshot (-001, -09-2025) of the same model ranks just below its plain name.
    const snapshot = /-\d{3}$|-\d{2}-\d{4}$/.test(id) ? 1 : 0;
    const family = flash ? 0 : pro ? 1 : lite ? 2 : 3;
    return [preview ? 1 : 0, -(v ?? 0), v === null ? 1 : 0, family, snapshot, id.length] as const;
  };
  const sorted = [...new Set(ids)].sort((a, b) => {
    const x = score(a), y = score(b);
    for (let i = 0; i < x.length; i++) if (x[i] !== y[i]) return x[i] < y[i] ? -1 : 1;
    return a.localeCompare(b);
  });
  return sorted.slice(0, limit);
}

/** Discovered models first, then the built-in list as a safety net (no duplicates). */
export function withFallback(discovered: string[], fallback = FALLBACK_GEMINI_MODELS, max = 5): string[] {
  return [...new Set([...discovered, ...fallback])].slice(0, max);
}
