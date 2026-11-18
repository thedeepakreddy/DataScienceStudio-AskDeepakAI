// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { Driver, InteractionEvent, interactions } from './interaction';

const ctx = (taskId = 't1', agent: any = 'data_engineer') => ({ runId: 'r', taskId, agent, signal: new AbortController().signal, releasePage: () => {}, pace: 0 });
const events: InteractionEvent[] = [];
const off = interactions.subscribe(e => events.push(e));
afterEach(() => { events.length = 0; document.body.innerHTML = ''; });

describe('agents act for real, and only when needed', () => {
  it('a list that already has the value is left alone', async () => {
    document.body.innerHTML = `<select data-agent="target"><option value="a">A</option><option value="churn">Churn</option></select>`;
    const sel = document.querySelector('select')!;
    sel.value = 'churn';
    let changes = 0;
    sel.addEventListener('change', () => changes++);
    await new Driver(ctx()).select('target', 'churn', 'Predict: churn');
    expect(changes).toBe(0);
    expect(events.map(e => e.action)).toEqual(['skip']);
    expect(events[0].label).toBe('Already set: Churn');
  });

  it('choosing from a list opens it, runs down to the choice and picks it', async () => {
    document.body.innerHTML = `<select data-agent="target"><option value="a">A</option><option value="b">B</option><option value="c">C</option></select>`;
    await new Driver(ctx()).select('target', 'c', 'Predict');
    expect(document.querySelector('select')!.value).toBe('c');
    const acts = events.map(e => e.action);
    expect(acts[0]).toBe('move');
    expect(acts).toContain('open');
    expect(acts.indexOf('open')).toBeLessThan(acts.lastIndexOf('hover'));
    expect(events.filter(e => e.action === 'hover').at(-1)!.index).toBe(2);
    expect(acts.at(-1)).toBe('select');
  });

  it('a ticked box or a field with the right text is skipped', async () => {
    document.body.innerHTML = `<input type="checkbox" data-agent="box" checked><input data-agent="name" value="churn-model">`;
    await new Driver(ctx()).check('box', true, 'Nested CV');
    await new Driver(ctx()).type('name', 'churn-model', 'Name');
    expect(events.map(e => e.action)).toEqual(['skip', 'skip']);
  });

  it('typing replaces old text with the new value', async () => {
    document.body.innerHTML = `<input data-agent="name" value="old">`;
    await new Driver(ctx()).type('name', 'new name', 'Name');
    expect((document.querySelector('input') as HTMLInputElement).value).toBe('new name');
  });

  it('two agents never use the same control at once', async () => {
    document.body.innerHTML = `<button data-agent="go">Go</button>`;
    const a = new Driver(ctx('t1', 'statistician'));
    const b = new Driver(ctx('t2', 'ml_engineer'));
    // t1 takes the button and keeps it (no done yet); t2 waits and says so.
    await (a as any).takeTurn('go');
    let bDone = false;
    const pb = b.click('go', 'Run').then(() => { bDone = true; });
    await new Promise(r => setTimeout(r, 200));
    expect(bDone).toBe(false);
    expect(events.some(e => e.action === 'wait' && e.taskId === 't2' && /Waiting for statistician/.test(e.label))).toBe(true);
    a.done('Finished');
    await pb;
    expect(bDone).toBe(true);
  });
});

void off;
