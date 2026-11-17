/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { CheckCircle2, CircleSlash, ListChecks, XCircle } from 'lucide-react';
import Orb from './Orb';
import { Job, clearFinishedJobs, getJobs, stopJob, subscribeJobs } from '../utils/jobs';

const elapsed = (job: Job, now: number) => {
  const s = Math.max(0, Math.round(((job.endedAt ?? now) - job.startedAt) / 1000));
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`;
};

/** Toolbar button and panel listing the work the studio is waiting on. */
export default function JobsButton() {
  const jobs = useSyncExternalStore(subscribeJobs, getJobs, getJobs);
  const [open, setOpen] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const ref = useRef<HTMLDivElement>(null);
  const running = jobs.filter(j => j.status === 'running');

  // Tick the timers while something is running and the panel is open.
  useEffect(() => {
    if (!open || running.length === 0) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [open, running.length]);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => { if (!ref.current?.contains(e.target as Node)) setOpen(false); };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', onDown);
    window.addEventListener('keydown', onKey);
    return () => { document.removeEventListener('mousedown', onDown); window.removeEventListener('keydown', onKey); };
  }, [open]);

  if (jobs.length === 0) return null;

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        onClick={() => { setNow(Date.now()); setOpen(o => !o); }}
        className="btn btn-icon relative"
        aria-expanded={open}
        aria-label={running.length ? `${running.length} job${running.length === 1 ? '' : 's'} running` : 'Recent jobs'}
        title="Jobs"
      >
        {running.length ? <Orb state="working" label="Jobs running" /> : <ListChecks className="w-[18px] h-[18px]" />}
        {running.length > 1 && (
          <span className="absolute -top-0.5 -right-0.5 min-w-4 h-4 px-1 rounded-full bg-blue text-white text-[10px] font-semibold leading-4 tabular-nums">
            {running.length}
          </span>
        )}
      </button>

      {open && (
        <div
          role="dialog"
          aria-label="Jobs"
          className="absolute right-0 top-11 z-50 w-[min(340px,calc(100vw-32px))] rounded-2xl bg-raised shadow-xl border border-separator p-2"
        >
          <div className="flex items-center justify-between px-2 pt-1 pb-2">
            <p className="text-sm font-semibold text-label">Jobs</p>
            {jobs.some(j => j.status !== 'running') && (
              <button type="button" onClick={clearFinishedJobs} className="btn btn-plain btn-sm -mr-1">Clear</button>
            )}
          </div>
          <ul className="max-h-[320px] overflow-y-auto">
            {jobs.map(j => (
              <li key={j.id} className="flex items-center gap-3 rounded-xl px-2 py-2 hover:bg-fill">
                <span className="w-5 h-5 flex items-center justify-center shrink-0">
                  {j.status === 'running' && <Orb state="working" label="Running" />}
                  {j.status === 'succeeded' && <CheckCircle2 className="w-4 h-4 text-green" aria-label="Done" />}
                  {j.status === 'failed' && <XCircle className="w-4 h-4 text-red" aria-label="Failed" />}
                  {j.status === 'stopped' && <CircleSlash className="w-4 h-4 text-label-3" aria-label="Stopped" />}
                </span>
                <div className="min-w-0 flex-1">
                  <p className="text-sm text-label truncate">{j.label}</p>
                  <p className="text-xs text-label-2 truncate tabular-nums">
                    {j.status === 'running' ? `Running · ${elapsed(j, now)}`
                      : j.status === 'failed' ? `Failed · ${j.error ?? ''}`
                      : j.status === 'stopped' ? 'Stopped waiting'
                      : `Done in ${elapsed(j, now)}`}
                  </p>
                </div>
                {j.status === 'running' && (
                  <button type="button" onClick={() => stopJob(j.id)} className="btn btn-sm btn-secondary shrink-0">Stop</button>
                )}
              </li>
            ))}
          </ul>
          <p className="px-2 pt-2 pb-1 text-[11px] text-label-3 leading-relaxed">
            Stop ends the wait in this browser. Work already running on the server finishes on its own.
          </p>
        </div>
      )}
    </div>
  );
}
