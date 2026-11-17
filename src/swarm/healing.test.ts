import { describe, expect, it, vi } from 'vitest';
import { parseCSV } from '../utils/csvParser';
import { rulePlan } from './plan';
import { offlineReply } from './gateway';
import { diagnose, fingerprint } from './recovery';
import { permutationTest, reviewTest, needsReview } from './review';
import { csv, fakePort, make, runToEnd } from './testkit';

const linked = parseCSV(['x,y', ...Array.from({ length: 60 }, (_, i) => `${i},${i * 2 + (i % 3)}`)].join('\n'), 'l.csv');
const noise = parseCSV(['x,y', ...Array.from({ length: 60 }, (_, i) => `${i},${(i * 37) % 11}`)].join('\n'), 'n.csv');

describe('independent review', () => {
  it('permutation test finds a strong link and no link in noise', () => {
    expect(permutationTest(linked, 'x', 'y').pValue).toBeLessThan(0.01);
    expect(permutationTest(noise, 'x', 'y').pValue).toBeGreaterThan(0.05);
  });

  it('agrees with a matching conclusion and flags a contradiction', () => {
    expect(reviewTest(linked, { columnA: 'x', columnB: 'y' }, { pValue: 0.0001, test: 'Pearson' }).agrees).toBe(true);
    const r = reviewTest(noise, { columnA: 'x', columnB: 'y' }, { pValue: 0.0001, test: 'Pearson' });
    expect(r.agrees).toBe(false);
    expect(r.detail).toContain('different conclusions');
  });

  it('reviews risky results only', () => {
    expect(needsReview('stats.compare', null, null)).toBe(true);
    expect(needsReview('explore.profile', null, null)).toBe(false);
    expect(needsReview('data.filter_rows', linked, { ...linked, rows: linked.rows.slice(0, 10) })).toBe(true);
    expect(needsReview('data.filter_rows', linked, { ...linked, rows: linked.rows.slice(0, 59) })).toBe(false);
  });
});

describe('self-healing', () => {
  it('diagnoses known failures and leaves unknown ones to the user', () => {
    expect(diagnose('The ML service is not responding', { usedPage: false, uiOnly: false }).repair).toBe('wake_ml');
    expect(diagnose('The control “x” isn’t on the page.', { usedPage: true, uiOnly: false }).repair).toBe('direct');
    expect(diagnose('The control “x” isn’t on the page.', { usedPage: true, uiOnly: true }).repair).toBeNull();
    expect(diagnose('Timed out after 30s.', { usedPage: false, uiOnly: false }).repair).toBe('more_time');
    expect(diagnose('Something odd', { usedPage: false, uiOnly: false }).repair).toBeNull();
    expect(fingerprint('a', 'Row 12 “x” failed')).toBe(fingerprint('a', 'Row 7 “y” failed'));
  });

  it('wakes the ML service, re-runs the task and closes the incident once it succeeds', async () => {
    let calls = 0;
    const wakeMl = vi.fn(async () => true);
    const port = fakePort(parseCSV(csv, 'c.csv'), { api: vi.fn(async () => { if (++calls === 1) throw new Error('The ML service is not responding'); return { test: 'Welch’s t-test', pValue: 0.5, significant: false, rowsUsed: 4, assumptions: [] }; }) });
    const { rt } = make([{ id: 't1', capability: 'stats.compare', params: { columnA: 'MonthlyCharges', columnB: 'Churn' }, role: 'statistician', dependsOn: [], why: '' }], port, { wakeMl });
    rt.start();
    const run = await runToEnd(rt);
    expect(wakeMl).toHaveBeenCalledTimes(1);
    expect(run.tasks[0].status).toBe('completed');
    expect(run.incidents).toEqual([expect.objectContaining({ repair: 'wake_ml', state: 'closed' })]);
    expect(run.report!.incidents[0].state).toBe('closed');
    expect(run.telemetry.aiCalls).toBe(0);
  });

  it('escalates when the repair doesn’t work, without looping', async () => {
    const wakeMl = vi.fn(async () => false);
    const api = vi.fn(async () => { throw new Error('The ML service is not responding'); });
    const port = fakePort(parseCSV(csv, 'c.csv'), { api });
    const { rt } = make([{ id: 't1', capability: 'stats.compare', params: { columnA: 'MonthlyCharges', columnB: 'Churn' }, role: 'statistician', dependsOn: [], why: '' }], port, { wakeMl });
    rt.start();
    const run = await runToEnd(rt);
    expect(run.tasks[0].status).toBe('failed');
    expect(api).toHaveBeenCalledTimes(2); // the first try and one repair, no more
    expect(wakeMl).toHaveBeenCalledTimes(1);
    expect(run.incidents).toEqual([expect.objectContaining({ state: 'escalated' })]);
  });

  it('escalates unknown failures straight away', async () => {
    const port = fakePort(parseCSV(csv, 'c.csv'), { api: vi.fn(async () => { throw new Error('Something odd happened'); }) });
    const { rt } = make([{ id: 't1', capability: 'stats.compare', params: { columnA: 'MonthlyCharges', columnB: 'Churn' }, role: 'statistician', dependsOn: [], why: '' }], port);
    rt.start();
    const run = await runToEnd(rt);
    expect(run.incidents![0]).toMatchObject({ state: 'escalated', diagnosis: 'Unrecognised failure.' });
    expect(run.messages.some(m => m.to === 'user' && m.text.startsWith('Needs you'))).toBe(true);
  });
});

describe('chat commands (no AI call)', () => {
  const ds = parseCSV(csv, 'c.csv');
  it('plans exact commands', () => {
    expect(rulePlan('drop the Contract column', ds).tasks).toEqual([expect.objectContaining({ capability: 'data.drop_columns', params: { columns: ['Contract'] } })]);
    expect(rulePlan('fill missing values with median', ds).tasks).toEqual([expect.objectContaining({ capability: 'data.fill_missing', params: { column: 'MonthlyCharges', strategy: 'median' } })]);
    expect(rulePlan('remove duplicate rows', ds).tasks[0].capability).toBe('data.remove_duplicates');
    expect(rulePlan('open the dashboard', ds).tasks[0]).toMatchObject({ capability: 'nav.open_step', params: { step: 'dashboard' } });
    expect(rulePlan('SELECT * FROM dataset LIMIT 3', ds).tasks[0].capability).toBe('sql.query');
    expect(rulePlan('reset the data', ds).tasks[0].capability).toBe('data.reset');
    expect(rulePlan('drop the Contract column', ds).reply).toBe('I’ll remove “Contract”.');
  });

  it('answers simple questions from the data when no AI is available', () => {
    expect(offlineReply('how many rows?', ds)).toBe('c.csv has 5 rows and 5 columns.');
    expect(offlineReply('which columns have missing values?', ds)).toContain('MonthlyCharges 1');
    expect(offlineReply('what is the average MonthlyCharges?', ds)).toBe('The average of MonthlyCharges is 52.5 (4 non-empty values).');
    expect(offlineReply('most common Contract', ds)).toBe('Most common in Contract: Monthly (3), Yearly (2).');
    expect(offlineReply('write a poem', ds)).toContain('Try:');
    expect(offlineReply('anything', null)).toContain('Import a dataset first');
  });
});
