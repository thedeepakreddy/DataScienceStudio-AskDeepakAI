/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

// A visitor's own API key - optional: a Gemini key, or an ARC key (their own ARC
// workspace, which picks a model and falls back across their provider keys). It
// lives only in this browser (localStorage) and is sent with this visitor's AI
// requests so the server can use it when the app's own key has run out. The
// server never stores it.

const STORAGE_KEY = 'userGeminiApiKey';
export const AI_KEY_CHANGED_EVENT = 'studio:ai-key-changed';
export const AI_KEY_HEADER = 'X-Gemini-Api-Key';

/**
 * Tidies a pasted key: drops spaces and line breaks (including invisible
 * ones), surrounding quotes and a leading "GEMINI_API_KEY=".
 */
export function cleanGeminiKey(raw: string): string {
  return raw
    .replace(/[\s\u200B-\u200D\uFEFF]+/g, '')
    .replace(/^(?:export)?(?:GEMINI_API_KEY|GOOGLE_API_KEY|ARC_API_KEY|API_KEY|key)[:=]/i, '')
    .replace(/^["'`]+|["'`]+$/g, '');
}

/**
 * Same rule the server applies. Classic keys look like "AIza…"; newer AI
 * Studio keys can contain dots (e.g. "AQ.…").
 */
export const looksLikeGeminiKey = (key: string) => {
  const k = cleanGeminiKey(key);
  // Something that starts like an ARC key must be a whole one.
  if (/^ARC_/.test(k)) return isArcKey(k);
  return /^[A-Za-z0-9._~+/=-]{20,300}$/.test(k);
};

/** ARC API key shape: ARC_DEE_<key id>_PAK_<secret>. */
export const isArcKey = (key: string) => /^ARC_DEE_[0-9A-Za-z]{17}_PAK_[0-9A-Za-z]{43}$/.test(cleanGeminiKey(key));

/** Which service a key belongs to. */
export const keyKind = (key: string): 'arc' | 'gemini' => (isArcKey(key) ? 'arc' : 'gemini');

/** Where visitors get an ARC key: sign up, add provider keys, create an app, issue a key. */
export const ARC_DASHBOARD_URL = 'https://arc-ai.run.place/dashboard';

export function getUserGeminiKey(): string | null {
  try {
    const key = localStorage.getItem(STORAGE_KEY);
    return key && looksLikeGeminiKey(key) ? cleanGeminiKey(key) : null;
  } catch {
    return null; // storage blocked (private mode, etc.)
  }
}

export function setUserGeminiKey(key: string | null): void {
  try {
    if (key) localStorage.setItem(STORAGE_KEY, cleanGeminiKey(key));
    else localStorage.removeItem(STORAGE_KEY);
  } catch { /* storage blocked - the key just won't persist */ }
  window.dispatchEvent(new Event(AI_KEY_CHANGED_EVENT));
}

/** Header to attach to this app's own API requests, when a key is saved. */
export function aiKeyHeaders(): Record<string, string> {
  const key = getUserGeminiKey();
  return key ? { [AI_KEY_HEADER]: key } : {};
}

/** Show only the last few characters, e.g. "••••••••AbC9". */
export const maskKey = (key: string) => `••••••••${key.slice(-4)}`;
