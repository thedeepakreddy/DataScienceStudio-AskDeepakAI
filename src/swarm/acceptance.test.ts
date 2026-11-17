import { describe, expect, it, vi } from 'vitest';

// The blueprint's acceptance tests (A01–A25), run against the real swarm code
// with a fake studio. A17–A19 are about what the user sees on the page; they
// are checked in the browser walkthrough (see docs/SWARM.md).

vi.mock('../utils/workspaceStore', () => ({ getCachedPlan: async () => undefined, setCachedPlan: async () => {} }));
const apiFetch = vi.fn();
vi.mock('../utils/api', () => ({ apiFetch: (...a: unknown[]) => apiFetch(...a) }));

import { parseCSV } from '../utils/csvParser';
import { applyOperation } from '../operations/registry';
import { CAPABILITIES, NOT_FOR_AGENTS } from './catalog';
import { LIMITS, TaskSpec, rulePlan, validatePlan } from './plan';
import { planRequest } from './gateway';
import { newRun } from './runtime';
import { Driver, InteractionEvent, interactions } from './interaction';
import { csv, fakePort, make, runToEnd } from './testkit';

const ds = () => parseCSV(csv, 'c.csv');
const task = (id: string, capability: string, params: Record<string, unknown>, dependsOn: string[] = []): TaskSpec =>
  ({ id, capability, params, role: CAPABILITIES[capability].defaultRole, dependsOn, why: '' });
const noise = parseCSV(['x,y', ...Array.from({ length: 60 }, (_, i) => `${i},${(i * 37) % 11}`)].join('\n'), 'n.csv');

describe('acceptance (blueprint A01–A25)', () => {
  it('A01 a request becomes a validated task graph', () => {
    const p = rulePlan('Do a full analysis and write a report', ds());
    expect(p.tasks.length).toBeGreaterThan(3);
    expect(validatePlan(p.tasks, ds())).toEqual([]);
    expect(validatePlan([task('a', 'explore.profile', {}, ['b']), task('b', 'explore.profile', {}, ['a'])], ds()).map(x => x.message)).toContain('The plan has a dependency loop.');
  });

  it('A02 agents have capabilities in all six studios', () => {
    expect(new Set(Object.values(CAPABILITIES).map(c => c.studio))).toEqual(new Set(['Data', 'Explore', 'Statistics', 'Models', 'Deploy', 'Research']));
  });

  it('A03 agents and the studio’s buttons use the same registered operations', async () => {
    const port = fakePort(ds());
    await CAPABILITIES['data.fill_missing'].run({ column: 'MonthlyCharges', strategy: 'median' }, port, new AbortController().signal);
    expect(port.getDataset()!.rows).toEqual(applyOperation(ds(), 'fill_missing', { column: 'MonthlyCharges', strategy: 'median' }).dataset.rows);
  });

  it('A04 numbers come from the studio’s engines, not from AI', async () => {
    const port = fakePort(ds());
    const { rt } = make([task('t1', 'stats.compare', { columnA: 'MonthlyCharges', columnB: 'Churn' })], port);
    rt.start();
    const run = await runToEnd(rt);
    expect(port.api).toHaveBeenCalledWith('/api/stats/compare', expect.anything(), expect.anything());
    expect((run.tasks[0].result!.data as any).pValue).toBe(0.01);
    expect(run.telemetry.aiCalls).toBe(0);
  });

  it('A05 agents talk through structured messages that are saved', async () => {
    const { rt, saved } = make([task('t1', 'explore.profile', {}), task('t2', 'report.build', {}, ['t1'])], fakePort(ds()));
    rt.start();
    const run = await runToEnd(rt);
    expect(run.messages.every(m => m.id && m.from && m.to && m.type && m.text)).toBe(true);
    expect(run.messages.some(m => m.type === 'handoff')).toBe(true);
    expect(saved.at(-1)!.messages.length).toBe(run.messages.length);
  });

  it('A06 plans and tasks added while running stay within limits', async () => {
    const many = Array.from({ length: LIMITS.maxTasks + 1 }, (_, i) => task(`t${i}`, 'explore.profile', {}));
    expect(validatePlan(many, ds()).some(p => p.message.includes('limit'))).toBe(true);
    const { rt } = make([task('t1', 'quality.check', {})], fakePort(ds()));
    rt.start();
    await new Promise(r => setTimeout(r, 40));
    expect(rt.run.dynamicAdded).toBeLessThanOrEqual(LIMITS.maxDynamicTasks);
  });

  it('A07 data changes run one at a time', async () => {
    const { rt } = make([task('a', 'data.remove_duplicates', {}), task('b', 'data.drop_columns', { columns: ['const'] })], fakePort(ds()));
    rt.approveBatch();
    rt.start();
    const run = await runToEnd(rt);
    const [a, b] = run.tasks;
    expect(b.inputVersionId).toBe(a.outputVersionId); // b started from a’s result, not alongside it
  });

  it('A08 every data change makes a new version', async () => {
    const port = fakePort(ds());
    const { rt } = make([task('a', 'data.remove_duplicates', {})], port);
    rt.approveBatch();
    rt.start();
    const run = await runToEnd(rt);
    expect(run.tasks[0].inputVersionId).not.toBe(run.tasks[0].outputVersionId);
    expect(port.commits).toEqual(['Removed 1 duplicate row.']);
  });

  it('A09 results record their data version, task and check', async () => {
    const { rt } = make([task('a', 'data.remove_duplicates', {})], fakePort(ds()));
    rt.approveBatch();
    rt.start();
    const t = (await runToEnd(rt)).tasks[0];
    expect(t).toMatchObject({ id: 'a', inputVersionId: 'v0', outputVersionId: 'v1', check: { ok: true, kind: 'self-check' } });
    expect(t.result!.summary).toBeTruthy();
  });

  it('A10 temporary failures retry without repeating a change', async () => {
    let n = 0;
    const port = fakePort(ds(), { api: vi.fn(async () => { if (++n === 1) throw new Error('HTTP 503'); return { test: 'x', pValue: 0.5, significant: false, rowsUsed: 4, assumptions: [] }; }) });
    const { rt } = make([task('t1', 'stats.compare', { columnA: 'MonthlyCharges', columnB: 'Churn' })], port);
    rt.start();
    await new Promise<void>(res => { const iv = setInterval(() => { if (rt.run.status === 'completed') { clearInterval(iv); res(); } }, 20); });
    expect(rt.run.telemetry.retries).toBe(1);
    // Data changes are not idempotent, so they are never retried blindly.
    expect(CAPABILITIES['data.fill_missing'].idempotent).toBe(false);
  });

  it('A11 pause, resume and cancel work for the run and for one task', async () => {
    const { rt } = make([task('t1', 'explore.profile', {}), task('t2', 'report.build', {}, ['t1']), task('t3', 'explore.profile', {})], fakePort(ds()));
    rt.cancelTask('t3');
    rt.start();
    rt.pause();
    expect(rt.run.status).toBe('paused');
    rt.resume();
    const run = await runToEnd(rt);
    expect(run.tasks.find(t => t.id === 't3')!.status).toBe('cancelled');
    expect(run.tasks.find(t => t.id === 't2')!.status).toBe('completed');
  });

  it('A12 self-checks and independent reviews are told apart', async () => {
    const { rt } = make([task('t1', 'stats.compare', { columnA: 'MonthlyCharges', columnB: 'Churn' })], fakePort(ds()));
    rt.start();
    const run = await runToEnd(rt);
    expect(run.tasks.find(t => t.id === 't1')!.check!.kind).toBe('self-check');
    expect(run.tasks.find(t => t.id === 't1.review')).toMatchObject({ role: 'verifier', check: { kind: 'independent' } });
  });

  it('A13 contradictions are surfaced, never hidden', async () => {
    const port = fakePort(noise, { api: vi.fn(async () => ({ test: 'Pearson', pValue: 0.0001, significant: true, rowsUsed: 60, assumptions: [] })) });
    const { rt } = make([task('t1', 'stats.compare', { columnA: 'x', columnB: 'y' })], port);
    rt.start();
    const run = await runToEnd(rt);
    expect(run.report!.reviews[0].agrees).toBe(false);
    expect(run.report!.headline).toContain('contradiction');
    expect(run.report!.limitations.join(' ')).toContain('disagreed');
  });

  it('A14 the team abstains when it can’t act on a request', () => {
    expect(rulePlan('write me a poem', ds()).tasks).toEqual([]);
    expect(validatePlan([task('t1', 'stats.compare', { columnA: 'Nope', columnB: 'Churn' })], ds()).length).toBeGreaterThan(0);
  });

  it('A15 inputs are re-checked when the data changed after approval', async () => {
    const { rt } = make([task('a', 'data.drop_columns', { columns: ['Contract'] }), task('b', 'stats.compare', { columnA: 'Contract', columnB: 'Churn' }, ['a'])], fakePort(ds()));
    rt.approveBatch();
    rt.start();
    const run = await runToEnd(rt);
    expect(run.tasks.find(t => t.id === 'b')).toMatchObject({ status: 'failed', error: expect.stringContaining('Contract') });
  });

  it('A16 critical actions need their own approval; prohibited ones are refused', async () => {
    const { rt } = make([task('c', 'data.custom_code', { code: '(d) => d' })], fakePort(ds()));
    rt.approveBatch();
    expect(rt.run.tasks[0].approved).toBe(false);
    rt.approveTask('c');
    expect(rt.run.tasks[0].approved).toBe(true);
    for (const id of Object.keys(NOT_FOR_AGENTS)) expect(validatePlan([task('x', 'explore.profile', {}), { ...task('y', 'explore.profile', {}), capability: id }], ds()).length).toBeGreaterThan(0);
  });

  it.todo('A17 (changed at the user’s request: agents work on the user’s own page) — one agent holds the page at a time and a person’s click pauses them; checked in the browser');
  it.todo('A18 the user can follow the run in the chat, open Details, take over and resume; checked in the browser');

  it('A19 each running task gets its own pointer', () => {
    const seen: InteractionEvent[] = [];
    const off = interactions.subscribe(e => seen.push(e));
    const signal = new AbortController().signal;
    new Driver({ runId: 'r', taskId: 't1', agent: 'statistician', signal, releasePage: () => {} }).wait('waiting');
    new Driver({ runId: 'r', taskId: 't2', agent: 'statistician', signal, releasePage: () => {} }).wait('waiting');
    off();
    expect(new Set(seen.map(e => e.pointerId))).toEqual(new Set(['t1', 't2']));
  });

  it('A20 every pointer event names its agent, task and run', () => {
    const seen: InteractionEvent[] = [];
    const off = interactions.subscribe(e => seen.push(e));
    let released = false;
    const d = new Driver({ runId: 'run-1', taskId: 'task-1', agent: 'data_engineer', signal: new AbortController().signal, releasePage: () => { released = true; } });
    d.release('waiting for the result');
    d.done('finished');
    off();
    expect(released).toBe(true);
    expect(seen.map(e => [e.runId, e.taskId, e.agent, e.action])).toEqual([['run-1', 'task-1', 'data_engineer', 'release'], ['run-1', 'task-1', 'data_engineer', 'done']]);
    expect(seen[1].seq).toBeGreaterThan(seen[0].seq);
  });

  it('A21 success comes from results, not animation, and needs no AI', async () => {
    const seen: InteractionEvent[] = [];
    const off = interactions.subscribe(e => seen.push(e));
    const { rt } = make([task('a', 'data.fill_missing', { column: 'MonthlyCharges', strategy: 'mean' })], fakePort(ds()), { onPage: () => false });
    rt.approveBatch();
    rt.start();
    const run = await runToEnd(rt);
    off();
    expect(run.tasks[0]).toMatchObject({ status: 'completed', check: { ok: true } });
    expect(run.tasks[0].usedPage).toBeFalsy();
    expect(seen).toEqual([]);
    expect(run.telemetry.aiCalls).toBe(0);
  });

  it('A22 AI calls are few and counted', async () => {
    expect((await planRequest('clean the data', ds())).aiCalls).toBe(0);
    apiFetch.mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ reply: 'ok', tasks: [{ id: 't1', capability: 'explore.profile', params: {}, role: 'data_scientist', dependsOn: [], why: '' }], usage: { inputTokens: 900, outputTokens: 80 } }) });
    const ai = await planRequest('give me the gist of this', ds());
    expect(ai).toMatchObject({ plannedBy: 'ai', aiCalls: 1, inputTokens: 900, outputTokens: 80, problems: [] });
  });

  it('A23 the AI provider sits behind one server endpoint, with a fallback when it is unavailable', async () => {
    apiFetch.mockResolvedValueOnce({ ok: false, status: 503, json: async () => ({ error: 'no key', reason: 'ai_unavailable' }) });
    const off = await planRequest('how many rows does it have', ds());
    expect(apiFetch).toHaveBeenLastCalledWith('/api/swarm/plan', expect.anything());
    expect(off).toMatchObject({ answer: true, aiCalls: 0, reply: 'c.csv has 5 rows and 5 columns.' });
  });

  it('A24 backend jobs are limited so the small ML service isn’t overloaded', async () => {
    let now = 0, peak = 0;
    const port = fakePort(ds(), { api: vi.fn(async () => { peak = Math.max(peak, ++now); await new Promise(r => setTimeout(r, 25)); now--; return { test: 'x', pValue: 0.5, significant: false, rowsUsed: 4, assumptions: [] }; }) });
    const { rt } = make(['MonthlyCharges', 'Contract', 'id'].map((c, i) => task(`t${i}`, 'stats.compare', { columnA: c, columnB: 'Churn' })), port);
    rt.start();
    await runToEnd(rt);
    expect(peak).toBeLessThanOrEqual(LIMITS.maxConcurrentBackend);
    expect(port.api).toHaveBeenCalledTimes(3);
  });

  it('A25 the completion report matches what really happened', async () => {
    const port = fakePort(ds(), { api: vi.fn(async () => { throw new Error('There is no column called “x”.'); }) });
    const { rt } = make([task('t1', 'explore.profile', {}), task('t2', 'stats.compare', { columnA: 'MonthlyCharges', columnB: 'Churn' })], port);
    rt.start();
    const run = await runToEnd(rt);
    expect(run.report!.status).toBe('partial');
    expect(run.report!.done.map(d => d.label)).toEqual(['Profile the dataset']);
    expect(run.report!.problems).toEqual([expect.objectContaining({ status: 'failed', reason: expect.stringContaining('no column') })]);
    expect(newRun({ request: 'x', reply: '', plannedBy: 'rules', tasks: [], datasetId: null, startVersionId: null }).telemetry).toMatchObject({ aiCalls: 0, retries: 0 });
  });
});
