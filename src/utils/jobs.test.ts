import { describe, expect, it } from 'vitest';
import { clearFinishedJobs, finishJob, getJobs, labelForUrl, startJob, stopJob, subscribeJobs } from './jobs';

describe('jobs', () => {
  it('labels known endpoints', () => {
    expect(labelForUrl('/api/run-ml-prediction')).toBe('Training a model');
    expect(labelForUrl('/api/hypothesis-lab/run-test')).toBe('Statistical test');
    expect(labelForUrl('/api/unknown')).toBe('Working');
  });

  it('tracks, finishes and stops jobs', () => {
    let calls = 0;
    const unsub = subscribeJobs(() => calls++);
    const a = startJob('A', new AbortController());
    const c = new AbortController();
    const b = startJob('B', c);
    expect(getJobs().map(j => j.status)).toEqual(['running', 'running']);
    finishJob(a, 'succeeded');
    stopJob(b);
    expect(c.signal.aborted).toBe(true);
    expect(getJobs().find(j => j.id === b)?.status).toBe('stopped');
    clearFinishedJobs();
    expect(getJobs()).toEqual([]);
    expect(calls).toBeGreaterThan(3);
    unsub();
  });
});
