import { describe, expect, it } from 'vitest';
import { cleanGeminiKey, looksLikeGeminiKey } from './aiKey';

describe('Gemini key check', () => {
  it('accepts classic and newer AI Studio keys', () => {
    expect(looksLikeGeminiKey('AIzaSyA1234567890abcdefghijklmnopqrstuv')).toBe(true);
    expect(looksLikeGeminiKey('AQ.Ab8RN6Ij1234567890abcdefGHIJKLmnop_qrs-tuv')).toBe(true);
  });

  it('tidies what pasting adds', () => {
    expect(cleanGeminiKey(' "AIzaSyA1234567890abcdefghijklmnopqrstuv"\n')).toBe('AIzaSyA1234567890abcdefghijklmnopqrstuv');
    expect(cleanGeminiKey('GEMINI_API_KEY=AIzaSyA1234567890abcdefghijklmnopqrstuv')).toBe('AIzaSyA1234567890abcdefghijklmnopqrstuv');
    expect(cleanGeminiKey('AIzaSyA12345​67890abcdefghijklmnop')).toBe('AIzaSyA1234567890abcdefghijklmnop');
  });

  it('rejects text that is not a key', () => {
    expect(looksLikeGeminiKey('hello')).toBe(false);
    expect(looksLikeGeminiKey('my key is <secret>')).toBe(false);
  });
});
