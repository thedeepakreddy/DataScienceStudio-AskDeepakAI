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
