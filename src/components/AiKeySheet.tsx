/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useEffect, useState } from 'react';
import { motion } from 'motion/react';
import { CheckCircle2, AlertTriangle, ExternalLink, Eye, EyeOff, KeyRound, Lock } from 'lucide-react';
import Orb from './Orb';
import { AI_KEY_HEADER, cleanGeminiKey, getUserGeminiKey, looksLikeGeminiKey, maskKey, setUserGeminiKey } from '../utils/aiKey';

type TestResult = { ok: boolean; message: string; reason?: string } | null;

/**
 * Lets a visitor add their own Gemini API key, used only when the app's own
 * key can't answer (for example when its free quota runs out).
 */
export default function AiKeySheet({ onClose, onChanged }: { onClose: () => void; onChanged: () => void }) {
  const [saved, setSaved] = useState<string | null>(() => getUserGeminiKey());
  const [draft, setDraft] = useState('');
  const [reveal, setReveal] = useState(false);
  const [testing, setTesting] = useState(false);
  const [result, setResult] = useState<TestResult>(null);

  // Close with Escape, like any system sheet.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const draftValid = looksLikeGeminiKey(draft);

  const test = async (key: string): Promise<TestResult> => {
    try {
      const res = await fetch('/api/ai/test-key', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', [AI_KEY_HEADER]: key },
      });
      const body = await res.json().catch(() => null);
      return { ok: !!body?.ok, reason: body?.reason, message: body?.message || `The check failed (HTTP ${res.status}).` };
    } catch {
      return { ok: false, message: 'Could not reach the server to check the key.' };
    }
  };

  const saveAndTest = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!draftValid) return;
    setTesting(true);
    setResult(null);
    const outcome = await test(cleanGeminiKey(draft));
    setTesting(false);
    setResult(outcome);
    // Save a key that works, or one that couldn't be checked only because Google
    // or the network was briefly unavailable. Never save a key Google rejected.
    if (outcome?.ok || outcome?.reason === 'busy' || outcome?.reason === 'network') {
      setUserGeminiKey(cleanGeminiKey(draft));
      setSaved(cleanGeminiKey(draft));
      setDraft('');
      onChanged();
    }
  };

  const retest = async () => {
    if (!saved) return;
    setTesting(true);
    setResult(null);
    setResult(await test(saved));
    setTesting(false);
  };

  const remove = () => {
    setUserGeminiKey(null);
    setSaved(null);
    setResult(null);
    onChanged();
  };

  return (
    <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center sm:p-4">
      <motion.div
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        exit={{ opacity: 0 }}
        transition={{ duration: 0.2 }}
        onClick={onClose}
        className="absolute inset-0 bg-[var(--scrim)]"
      />
      <motion.div
        role="dialog"
        aria-modal="true"
        aria-labelledby="ai-key-title"
        initial={{ opacity: 0, y: 24, scale: 0.98 }}
        animate={{ opacity: 1, y: 0, scale: 1 }}
        exit={{ opacity: 0, y: 24, scale: 0.98 }}
        transition={{ duration: 0.3, ease: [0.28, 0.11, 0.32, 1] }}
        className="relative z-10 w-full sm:max-w-md bg-raised rounded-t-3xl sm:rounded-3xl shadow-xl p-6 sm:p-7 max-h-[90vh] overflow-y-auto"
      >
        <div className="flex items-start justify-between gap-3">
          <div className="flex items-center gap-3">
            <span className="w-10 h-10 rounded-xl bg-blue/12 text-blue flex items-center justify-center shrink-0">
              <KeyRound className="w-5 h-5" />
            </span>
            <h2 id="ai-key-title" className="text-xl font-semibold tracking-tight text-label">Your Gemini API key</h2>
          </div>
          <button type="button" onClick={onClose} className="btn btn-plain font-semibold -mr-2 -mt-1">Done</button>
        </div>

        <p className="mt-4 text-sm text-label-2 leading-relaxed">
          Optional. The studio uses its own Gemini key first. If that runs out, AI features switch to your key so
          they keep working. Your key is only used when the studio’s key can’t answer.
        </p>

        {saved ? (
          <div className="mt-5 rounded-2xl bg-well p-4">
            <div className="flex items-center justify-between gap-3">
              <div className="min-w-0">
                <p className="text-xs text-label-2">Saved key</p>
                <p className="mt-0.5 font-code text-sm text-label truncate">{maskKey(saved)}</p>
              </div>
              <div className="flex gap-2 shrink-0">
                <button type="button" onClick={retest} disabled={testing} aria-busy={testing} className="btn btn-sm btn-secondary">
                  {testing ? <><Orb state="listening" label="Checking your key" /> Checking…</> : 'Test'}
                </button>
                <button type="button" onClick={remove} className="btn btn-sm bg-red/10 text-red hover:bg-red/15">
                  Remove
                </button>
              </div>
            </div>
          </div>
        ) : (
          <form onSubmit={saveAndTest} className="mt-5">
            <label htmlFor="ai-key-input" className="field-label">API key</label>
            <div className="relative">
              <input
                id="ai-key-input"
                type={reveal ? 'text' : 'password'}
                value={draft}
                onChange={(e) => { setDraft(e.target.value); setResult(null); }}
                placeholder="Paste your key"
                autoComplete="off"
                spellCheck={false}
                className="field pr-11 font-code text-[15px]"
              />
              <button
                type="button"
                onClick={() => setReveal(r => !r)}
                className="btn btn-icon w-8 h-8 absolute right-1.5 top-1/2 -translate-y-1/2"
                aria-label={reveal ? 'Hide key' : 'Show key'}
              >
                {reveal ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
              </button>
            </div>
            {draft && !draftValid && (
              <p className="mt-1.5 text-xs text-red">That doesn’t look like a Gemini API key. Copy it again from Google AI Studio (it usually starts with “AIza” or “AQ.”).</p>
            )}
            <button
              type="submit"
              disabled={!draftValid || testing}
              aria-busy={testing}
              className="btn btn-primary btn-lg w-full mt-4"
            >
              {testing ? <><Orb state="listening" onAccent label="Checking your key" /> Checking your key…</> : 'Save and Test'}
            </button>
          </form>
        )}

        {result && (
          <p
            role="status"
            className={`mt-3 flex items-start gap-2 text-sm ${result.ok ? 'text-green' : 'text-red'}`}
          >
            {result.ok
              ? <CheckCircle2 className="w-4 h-4 shrink-0 mt-0.5" />
              : <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" />}
            {result.message}
          </p>
        )}

        <a
          href="https://aistudio.google.com/app/apikey"
          target="_blank"
          rel="noopener noreferrer"
          className="mt-5 inline-flex items-center gap-1.5 text-sm text-blue hover:underline"
        >
          Get a free key in Google AI Studio <ExternalLink className="w-3.5 h-3.5" />
        </a>

        <p className="mt-4 pt-4 border-t border-separator flex items-start gap-2 text-xs text-label-3 leading-relaxed">
          <Lock className="w-3.5 h-3.5 shrink-0 mt-0.5" />
          Saved only in this browser. It’s sent with your AI requests and passed straight to Google — never stored
          or logged on the server. Anyone using this browser can use it, so remove it on shared computers.
        </p>
      </motion.div>
    </div>
  );
}
