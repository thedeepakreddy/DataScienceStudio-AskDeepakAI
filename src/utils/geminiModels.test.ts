import { describe, expect, it } from 'vitest';
import { rankGeminiModels, withFallback } from '../../geminiModels';

const m = (name: string, actions = ['generateContent', 'countTokens']) => ({ name: `models/${name}`, supportedActions: actions });

describe('Gemini model discovery', () => {
  it('prefers the newest stable Flash and skips models for other jobs', () => {
    const listed = [m('gemini-2.5-flash'), m('gemini-3.6-flash'), m('gemini-4.0-flash-preview-05-2027'), m('gemini-3.8-flash'),
      m('gemini-3.8-pro'), m('gemini-3.8-flash-lite'), m('gemini-3.8-flash-image'), m('gemini-embedding-001', ['embedContent']),
      m('gemini-3.8-flash-tts'), m('gemini-flash-latest'), m('gemma-3-27b-it')];
    expect(rankGeminiModels(listed)).toEqual(['gemini-3.8-flash', 'gemini-3.8-pro', 'gemini-3.8-flash-lite']);
  });
  it('keeps previews after stable models and the built-in list as a safety net', () => {
    const top = rankGeminiModels([m('gemini-5.0-flash-preview'), m('gemini-3.6-flash')], 2);
    expect(top).toEqual(['gemini-3.6-flash', 'gemini-5.0-flash-preview']);
    expect(withFallback(top).slice(0, 3)).toEqual(['gemini-3.6-flash', 'gemini-5.0-flash-preview', 'gemini-3.8-flash']);
  });
});

describe('finding free models', () => {
  it('keeps the newest models that answer, skips paid-only ones and stops on a rejected key', async () => {
    const { findFreeModels, isPaidOnlyError } = await import('../../geminiModels');
    const paid = new Set(['gemini-4.0-flash', 'gemini-3.8-flash']);
    const busy = new Set(['gemini-3.6-flash-lite']);
    const probe = async (m: string) => {
      if (paid.has(m)) throw new Error('429 RESOURCE_EXHAUSTED Quota exceeded for metric generate_content_free_tier_requests, limit: 0');
      if (busy.has(m)) throw new Error('503 The model is overloaded');
    };
    const r = await findFreeModels(['gemini-4.0-flash', 'gemini-3.8-flash', 'gemini-3.6-flash-lite', 'gemini-3.6-flash', 'gemini-2.5-flash', 'gemini-2.5-flash-lite', 'x'], probe, 2);
    expect(r.free).toEqual(['gemini-3.6-flash', 'gemini-2.5-flash', 'gemini-3.6-flash-lite']);
    expect(r.results.filter(x => x.outcome === 'paid').map(x => x.model)).toEqual(['gemini-4.0-flash', 'gemini-3.8-flash']);
    expect(isPaidOnlyError(new Error('429 Too many requests, retry later'))).toBe(false);
    const bad = await findFreeModels(['a', 'b'], async () => { throw new Error('400 API key not valid'); });
    expect(bad.results).toEqual([{ model: 'a', outcome: 'bad_key' }]);
  });
});

describe('a key whose project has no credits', () => {
  const depleted = 'RESOURCE_EXHAUSTED: Your prepayment credits are depleted. Please go to AI Studio at https://ai.studio/projects to manage your project and billing.';
  it('is reported as a billing problem, not a passing quota limit', async () => {
    const { classifyGeminiError, describeGeminiFailure, mostTellingFailure } = await import('../../geminiHealth');
    expect(classifyGeminiError(new Error(`429 ${depleted}`))).toBe('billing');
    expect(mostTellingFailure(['busy', 'billing', 'quota'])).toBe('billing');
    expect(describeGeminiFailure('billing', [])).toMatch(/prepaid credits/);
    expect(classifyGeminiError(new Error('429 Too many requests'))).toBe('quota');
  });
  it('stops the free-model search at once and keeps the current list', async () => {
    const { findFreeModels } = await import('../../geminiModels');
    let calls = 0;
    const r = await findFreeModels(['a', 'b', 'c'], async () => { calls++; throw new Error(depleted); });
    expect(calls).toBe(1);
    expect(r.free).toEqual([]);
    expect(r.results).toEqual([{ model: 'a', outcome: 'no_credits' }]);
  });
  it('never replaces the list with models that only said “busy”', async () => {
    const { findFreeModels } = await import('../../geminiModels');
    const r = await findFreeModels(['a', 'b'], async () => { throw new Error('503 overloaded'); });
    expect(r.free).toEqual([]);
  });
});
