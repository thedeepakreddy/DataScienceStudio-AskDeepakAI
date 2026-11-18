import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { CAPABILITIES } from './contract.generated';
import { CLIENT_ROUTES } from './client';
import { ENGINE_METHODS } from '../components/stats/methods';

// Everything the engine can do must be reachable in the studio: every
// capability has a page that runs it, and every engine route is used. A new
// engine feature fails here until the studio gets it.

const src = join(__dirname, '..');
const files = (dir: string): string[] => readdirSync(dir).flatMap(f => {
  const p = join(dir, f);
  return statSync(p).isDirectory() ? files(p) : /\.(tsx?|jsx?)$/.test(f) && !/\.test\./.test(f) && !f.includes('contract.generated') ? [p] : [];
});
const sources = files(src).map(p => [p.slice(src.length + 1), readFileSync(p, 'utf8')] as const);
const ui = sources.filter(([p]) => p !== 'engine/client.ts');

/** Routes the client uses on the studio's behalf (uploading data, following jobs). */
const INTERNAL = new Set(['run', 'datasets.upload', 'datasets.uploadUrl', 'datasets.get', 'jobs.get']);
/** For scripts and notebooks only, with the reason the studio doesn't need them. */
const SCRIPTS_ONLY: Record<string, string> = {
  'datasets.fromRows': 'Sends rows as JSON; the studio uploads the same data as CSV (datasets.upload), which is smaller.',
};

describe('every engine feature is in the studio', () => {
  it('every capability has a page that runs it', () => {
    const viaMethods = new Set(Object.values(ENGINE_METHODS).map(m => m.cap));
    const missing = Object.keys(CAPABILITIES).filter(cap => !viaMethods.has(cap as any) && !ui.some(([, s]) => s.includes(`'${cap}'`)));
    expect(missing).toEqual([]);
  });

  it('every engine route is used by the studio', () => {
    const all = sources.map(([, s]) => s).join('\n');
    const missing = Object.keys(CLIENT_ROUTES).filter(route => {
      if (SCRIPTS_ONLY[route]) return false;
      if (INTERNAL.has(route)) return !new RegExp(`\\b${route.split('.').pop()}\\(`).test(all.replace(/^.*CLIENT_ROUTES[\s\S]*?as const/m, ''));
      return !ui.some(([, s]) => s.includes(`engine.${route}(`) || s.includes(`engine.${route}.`));
    });
    expect(missing).toEqual([]);
  });
});
