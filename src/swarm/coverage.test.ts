import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { CAPABILITIES, FEATURES_WITHOUT_PAGE, NOT_FOR_AGENTS } from './catalog';
import { UI_SCRIPTS } from './uiScripts';
import { STAGE_ORDER } from '../stages';

// Agents must be able to operate every feature, now and later: every control
// a UI script uses must exist on the page, every capability must be runnable,
// and every feature component must be covered. A new feature fails here until
// it registers a capability (and data-agent tags) or is listed as not for agents.

const root = join(__dirname, '..');
const read = (p: string) => readFileSync(join(root, p), 'utf8');
// Every component, including those in sub-folders (model/, stats/, explore/, engine/).
const componentFiles = (readdirSync(join(root, 'components'), { recursive: true }) as string[])
  .filter(f => f.endsWith('.tsx') && !f.endsWith('.test.tsx')).map(f => `components/${f.replace(/\\/g, '/')}`);
const pageSources = [...componentFiles, 'App.tsx'].map(f => [f, read(f)] as const);

// data-agent="x" (static) and data-agent={`x-${…}`} (template prefix). Column
// pickers take their id as a prop: data-agent={id} with columnSelect('x', …).
const staticTags = new Set<string>();
const prefixes = new Set<string>();
for (const [, src] of pageSources) {
  // Shared controls (RunBar, PinButton) take their tag as an `agent` prop.
  for (const m of src.matchAll(/(?:data-agent|\bagent)="([^"]+)"/g)) staticTags.add(m[1]);
  for (const m of src.matchAll(/(?:data-agent|\bagent)=\{`([^`$]*)\$\{/g)) prefixes.add(m[1]);
  if (/data-agent=\{id\}/.test(src)) for (const m of src.matchAll(/columnSelect\('([^']+)'/g)) staticTags.add(m[1]);
  for (const m of src.matchAll(/htmlFor="([^"]+)"[^>]*>[^<]*<\/label>\s*\{columnSelect/g)) staticTags.add(m[1]);
}
const onPage = (target: string) => staticTags.has(target) || [...prefixes].some(p => p && target.startsWith(p));

// Page scripts: the hand-written ones, and those for the engine's analyses.
const scripts = read('swarm/uiScripts.ts') + read('swarm/engineCapabilities.ts');

describe('agents can operate every feature', () => {
  it('every control a UI script uses is on the page', () => {
    const literal = [...scripts.matchAll(/d\.(?:click|select|type|claim|check|waitFor)\('([^']+)'/g)].map(m => m[1]);
    const templated = [...scripts.matchAll(/d\.(?:click|select|type|claim|check|waitFor)\(`([^`$]+)\$\{/g)].map(m => m[1]);
    expect(literal.length).toBeGreaterThan(30);
    expect(literal.filter(t => !onPage(t))).toEqual([]);
    expect(templated.filter(p => ![...prefixes].includes(p))).toEqual([]);
  });

  it('every step can be opened from the step bar', () => {
    expect(prefixes.has('nav-')).toBe(true);
    expect(STAGE_ORDER.length).toBeGreaterThan(5);
  });

  it('every UI script belongs to a capability, and page-only capabilities have one', () => {
    for (const id of Object.keys(UI_SCRIPTS)) expect(CAPABILITIES[id], id).toBeDefined();
    for (const c of Object.values(CAPABILITIES)) {
      if (c.uiOnly) expect(c.ui, `${c.id} is page-only but has no UI script`).toBeTypeOf('function');
      expect(typeof c.run === 'function' || typeof c.ui === 'function', c.id).toBe(true);
      expect(c.label(c.id === 'verify.review' ? { target: { label: 'x' } } : {})).toBeTypeOf('string');
    }
  });

  it('every feature component is operable by agents or explicitly covered', () => {
    const features = componentFiles.filter(f => /logRun\(|onUpdateDataset\(|onDatasetChange\(/.test(read(f)));
    expect(features.length).toBeGreaterThan(5);
    const uncovered = features.filter(f => {
      const name = f.replace(/^components\/(?:.*\/)?/, '').replace('.tsx', '');
      if (read(f).includes('data-agent')) return false;
      return !(FEATURES_WITHOUT_PAGE[name]?.every(id => CAPABILITIES[id]));
    });
    expect(uncovered).toEqual([]);
  });

  it('what agents may not do is listed with a reason, and isn’t in the catalog', () => {
    for (const [id, why] of Object.entries(NOT_FOR_AGENTS)) {
      expect(CAPABILITIES[id]).toBeUndefined();
      expect(why.length).toBeGreaterThan(10);
    }
  });
});
