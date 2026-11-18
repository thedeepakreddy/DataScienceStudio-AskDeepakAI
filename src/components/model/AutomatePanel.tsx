/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useCallback, useEffect, useState } from 'react';
import { CalendarClock, Play, RotateCw, Trash2 } from 'lucide-react';
import { CAPABILITIES, engine, type CapabilityName, type EngineJob, type PipelineStep, type RunRecord, type Schedule } from '../../engine/client';
import Orb from '../Orb';

const title = (cap: string) => CAPABILITIES[cap as CapabilityName]?.title ?? cap;
const EVERY: { label: string; minutes: number }[] = [
  { label: 'Every hour', minutes: 60 }, { label: 'Every 6 hours', minutes: 360 }, { label: 'Every day', minutes: 1440 }, { label: 'Every week', minutes: 10080 },
];
/** The same analysis (capability, data and settings), whichever run of it. */
const keyOf = (r: RunRecord) => `${r.capability}|${r.dataset?.id ?? ''}|${r.paramsFingerprint}`;
const stepOf = (r: RunRecord): PipelineStep => ({ capability: r.capability as CapabilityName, dataset_id: r.dataset?.id ?? null, params: r.params });

/**
 * Re-run past engine analyses (as one pipeline) or put them on a schedule, so
 * a forecast, a drift check or a data-rule check repeats on its own.
 */
export default function AutomatePanel() {
  const [runs, setRuns] = useState<RunRecord[] | null>(null);
  const [schedules, setSchedules] = useState<Schedule[]>([]);
  const [picked, setPicked] = useState<string[]>([]);
  const [every, setEvery] = useState(1440);
  const [name, setName] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [job, setJob] = useState<EngineJob | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const [r, s] = await Promise.all([engine.runs.list({ limit: 60 }), engine.schedules.list()]);
      // One row per distinct analysis (same capability, data and settings), newest first.
      const seen = new Set<string>();
      setRuns(r.filter(x => x.status === 'done' && !x.capability.startsWith('connect.')).filter(x => { const k = keyOf(x); if (seen.has(k)) return false; seen.add(k); return true; }));
      setSchedules(s);
      setError(null);
    } catch (e) { setError((e as Error).message); }
  }, []);
  useEffect(() => { load(); }, [load]);

  // Follow a pipeline until it ends.
  useEffect(() => {
    if (!job || ['done', 'error', 'cancelled'].includes(job.status)) return;
    const t = setTimeout(() => engine.jobs.get(job.id).then(setJob).catch(() => {}), 1500);
    return () => clearTimeout(t);
  }, [job]);
  useEffect(() => { if (job?.status === 'done') load(); }, [job?.status, load]);

  const chosen = (runs ?? []).filter(r => picked.includes(keyOf(r)));
  const act = async (label: string, fn: () => Promise<unknown>) => {
    setBusy(label); setError(null);
    try { await fn(); } catch (e) { setError((e as Error).message); } finally { setBusy(null); }
  };
  const runNow = () => act('run', async () => setJob((await engine.pipelines.run({ steps: chosen.map(stepOf), name: name || `Re-run of ${chosen.length} analyses` })).job));
  const schedule = () => act('schedule', async () => {
    await engine.schedules.create({ steps: chosen.map(stepOf), every_minutes: every, name: name || chosen.map(r => title(r.capability)).join(' + ') });
    setPicked([]); setName(''); await load();
  });

  return (
    <div className="space-y-6" data-agent="area-automate">
      <div className="card p-4 sm:p-5 space-y-4">
        <div>
          <h3 className="card-title">Repeat analyses</h3>
          <p className="mt-1 text-sm text-label-2">Pick analyses the engine has already run. Run them again now as one pipeline, or schedule them — a daily drift check, a weekly forecast, data rules every hour. Each run is saved in the history.</p>
        </div>
        {error && <p className="text-sm text-red" role="alert">{error}</p>}
        {!runs && <p className="text-sm text-label-2">Loading…</p>}
        {runs && !runs.length && <p className="text-sm text-label-2">No engine analyses yet. Run one in Statistics, Explore or Model first.</p>}
        {runs && runs.length > 0 && (
          <ul className="max-h-80 overflow-y-auto divide-y divide-separator rounded-xl border border-separator">
            {runs.map(r => (
              <li key={r.id}>
                <label className="flex items-center gap-3 px-3 py-2 cursor-pointer hover:bg-fill/50">
                  <input type="checkbox" checked={picked.includes(keyOf(r))} onChange={e => setPicked(p => (e.target.checked ? [...p, keyOf(r)] : p.filter(x => x !== keyOf(r))))} />
                  <span className="flex-1 min-w-0">
                    <span className="block text-sm text-label truncate">{title(r.capability)}</span>
                    <span className="block text-xs text-label-3 truncate">{r.dataset?.name ?? 'no dataset'} · {new Date(r.startedAt).toLocaleString()}{r.experiment ? ` · ${r.experiment}` : ''}</span>
                  </span>
                </label>
              </li>
            ))}
          </ul>
        )}
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 items-end">
          <div><label className="field-label" htmlFor="auto-name">Name (optional)</label><input id="auto-name" className="input" value={name} onChange={e => setName(e.target.value)} /></div>
          <div><label className="field-label" htmlFor="auto-every">Repeat</label>
            <select id="auto-every" className="input" value={every} onChange={e => setEvery(Number(e.target.value))}>{EVERY.map(x => <option key={x.minutes} value={x.minutes}>{x.label}</option>)}</select>
          </div>
          <div className="flex gap-2">
            <button type="button" className="btn btn-secondary flex-1" disabled={!chosen.length || !!busy} onClick={runNow} data-agent="automate-run"><Play className="w-4 h-4" /> Run now</button>
            <button type="button" className="btn btn-primary flex-1" disabled={!chosen.length || !!busy} onClick={schedule} data-agent="automate-schedule"><CalendarClock className="w-4 h-4" /> Schedule</button>
          </div>
        </div>
        {job && (
          <p className={`text-sm ${job.status === 'error' ? 'text-red' : 'text-label-2'}`} role="status">
            {['queued', 'running'].includes(job.status) ? <><Orb state="solving" label="Running" /> {job.message} · {Math.round(job.progress * 100)}%</>
              : job.status === 'done' ? `Done: ${job.label}. The results are in the run history (Report → Engine runs).` : `${job.label}: ${job.error?.message ?? job.status}`}
          </p>
        )}
      </div>

      <div className="card p-4 sm:p-5 space-y-3">
        <div className="flex items-start justify-between gap-3">
          <div>
            <h3 className="card-title">Schedules</h3>
            <p className="mt-1 text-sm text-label-2">The engine runs these when they’re due (checked each minute while it’s awake; when it has been asleep, due ones run as soon as it wakes).</p>
          </div>
          <div className="flex gap-2">
            <button type="button" className="btn btn-sm btn-secondary" disabled={!!busy} onClick={() => act('tick', async () => { await engine.schedules.tick(true); await load(); })}>
              {busy === 'tick' ? <><Orb state="solving" label="Running" /> Running…</> : 'Run due now'}
            </button>
            <button type="button" className="btn btn-icon w-8 h-8" aria-label="Reload" onClick={load}><RotateCw className="w-4 h-4" /></button>
          </div>
        </div>
        {!schedules.length && <p className="text-sm text-label-2">No schedules yet.</p>}
        <ul className="divide-y divide-separator">
          {schedules.map(s => (
            <li key={s.id} className="py-2.5 flex flex-wrap items-center gap-x-3 gap-y-2">
              <div className="flex-1 min-w-0">
                <p className="text-sm font-medium text-label truncate">{s.name ?? s.steps.map(x => title(x.capability)).join(' + ')}</p>
                <p className="text-xs text-label-3">
                  {EVERY.find(e => e.minutes === s.everyMinutes)?.label ?? `Every ${s.everyMinutes} minutes`} · next {new Date(s.nextRunAt * 1000).toLocaleString()}
                  {s.lastRun ? ` · last ran ${new Date(s.lastRun.at).toLocaleString()}` : ' · not run yet'}
                </p>
              </div>
              <label className="flex items-center gap-2 text-sm text-label">
                <input type="checkbox" checked={s.enabled} onChange={e => act('toggle', async () => { await engine.schedules.update(s.id, { enabled: e.target.checked }); await load(); })} /> On
              </label>
              <button type="button" className="btn btn-icon w-8 h-8 text-red" aria-label={`Delete schedule ${s.name ?? ''}`} onClick={() => act('delete', async () => { await engine.schedules.remove(s.id); await load(); })}><Trash2 className="w-4 h-4" /></button>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
