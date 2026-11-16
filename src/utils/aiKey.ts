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

/** Same rule the server applies; anything else is ignored there. */
export const looksLikeGeminiKey = (key: string) => /^[A-Za-z0-9_-]{20,200}$/.test(key.trim());

export function getUserGeminiKey(): string | null {
  try {
    const key = localStorage.getItem(STORAGE_KEY);
    return key && looksLikeGeminiKey(key) ? key : null;
  } catch {
    return null; // storage blocked (private mode, etc.)
  }
}

export function setUserGeminiKey(key: string | null): void {
  try {
    if (key) localStorage.setItem(STORAGE_KEY, key.trim());
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
