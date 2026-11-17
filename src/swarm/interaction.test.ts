import { describe, expect, it } from 'vitest';
import { interactions } from './interaction';

// The cursor layer holds an agent while its partner cursor drags a box open
// and the working cursor moves in. These check that hold is real but bounded.

const ev = () => interactions.emit({ runId: 'r', taskId: 't', agent: 'statistician', pointerId: 't', action: 'move', label: 'x' });

describe('interaction gates', () => {
  it('does not wait when nothing is drawing', async () => {
    const t0 = Date.now();
    await interactions.ready(ev(), 1000);
    expect(Date.now() - t0).toBeLessThan(50);
  });

  it('waits until the page says the box is open', async () => {
    let open!: () => void;
    const off = interactions.addGate(() => new Promise<void>(r => { open = r; }));
    let done = false;
    const p = interactions.ready(ev(), 2000).then(() => { done = true; });
    await new Promise(r => setTimeout(r, 30));
    expect(done).toBe(false);
    open();
    await p;
    expect(done).toBe(true);
    off();
  });

  it('never stalls an agent when drawing gets stuck', async () => {
    const off = interactions.addGate(() => new Promise<void>(() => {}));
    const t0 = Date.now();
    await interactions.ready(ev(), 60);
    expect(Date.now() - t0).toBeGreaterThanOrEqual(55);
    off();
  });

  it('ignores gates with nothing to wait for', async () => {
    const off = interactions.addGate(() => undefined);
    const t0 = Date.now();
    await interactions.ready(ev(), 1000);
    expect(Date.now() - t0).toBeLessThan(50);
    off();
  });
});
