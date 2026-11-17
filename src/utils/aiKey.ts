/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

// A visitor's own Gemini API key - optional. It lives only in this browser
// (localStorage) and is sent with this visitor's AI requests so the server can
// use it when the app's own key has run out. The server never stores it.

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
    .replace(/^(?:export)?(?:GEMINI_API_KEY|GOOGLE_API_KEY|API_KEY|key)[:=]/i, '')
    .replace(/^["'`]+|["'`]+$/g, '');
}

/**
 * Same rule the server applies. Classic keys look like "AIza…"; newer AI
 * Studio keys can contain dots (e.g. "AQ.…").
 */
export const looksLikeGeminiKey = (key: string) => /^[A-Za-z0-9._~+/=-]{20,300}$/.test(cleanGeminiKey(key));

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
