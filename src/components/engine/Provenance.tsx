/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState } from 'react';
import { Check, Copy, Download, Info } from 'lucide-react';
import { engine, type Manifest } from '../../engine/client';

/**
 * "How this was computed": every engine result says which method ran, on which
 * data, with which libraries and seed, and offers the methods paragraph (with
 * references) and a notebook that reproduces it.
 */
export default function Provenance({ manifest, runId, notes }: { manifest: Manifest; runId?: string; notes?: string[] }) {
  const [open, setOpen] = useState(false);
  const [methods, setMethods] = useState<{ text: string; references: string[]; markdown: string } | null>(null);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const toggle = async () => {
    const next = !open;
    setOpen(next);
    if (next && runId && !methods) {
      try { setMethods(await engine.runs.methods(runId)); } catch (e: any) { setError(e.message); }
    }
  };
  const copy = async () => {
    if (!methods) return;
    try { await navigator.clipboard.writeText(methods.markdown); setCopied(true); setTimeout(() => setCopied(false), 1800); } catch { /* clipboard blocked */ }
  };
  const libs = Object.entries(manifest.libraries || {}).slice(0, 8).map(([k, v]) => `${k} ${v}`).join(' · ');

  return (
    <div className="text-xs">
      <button type="button" onClick={toggle} aria-expanded={open} className="inline-flex items-center gap-1.5 text-label-2 hover:text-label">
        <Info className="w-3.5 h-3.5" /> How this was computed
      </button>
      {open && (
        <div className="mt-2 rounded-xl bg-fill px-3 py-3 space-y-2 text-label-2 animate-fade-in">
          {methods && <p className="text-sm text-label leading-relaxed">{methods.text}</p>}
          {!methods && !error && runId && <p>Loading the methods…</p>}
          {error && <p className="text-red">{error}</p>}
          {methods?.references.length ? (
            <ul className="list-disc pl-4 space-y-0.5">{methods.references.map(r => <li key={r}>{r}</li>)}</ul>
          ) : null}
          {notes?.map(n => <p key={n} className="text-orange">Note: {n}</p>)}
          <p className="tabular-nums">
            Engine {manifest.engineVersion} · Python {manifest.python} · seed {manifest.seed} · {(manifest.durationMs / 1000).toFixed(1)}s
            {manifest.dataset && <> · data {manifest.dataset.fingerprint.slice(0, 12)} ({manifest.dataset.rows?.toLocaleString()} rows)</>}
          </p>
          <p className="text-label-3">{libs}</p>
          {runId && (
            <div className="flex flex-wrap gap-2 pt-1">
              <button type="button" className="btn btn-secondary !py-1.5 !text-xs" onClick={copy} disabled={!methods}>
                {copied ? <Check className="w-3.5 h-3.5" /> : <Copy className="w-3.5 h-3.5" />} {copied ? 'Copied' : 'Copy methods'}
              </button>
              <a className="btn btn-secondary !py-1.5 !text-xs" href={engine.runs.notebookUrl(runId)} download>
                <Download className="w-3.5 h-3.5" /> Notebook
              </a>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
