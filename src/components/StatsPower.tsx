/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState } from 'react';
import { AlertTriangle } from 'lucide-react';
import { apiFetch } from '../utils/api';
import Orb from './Orb';
import { useLogRun } from '../contexts/WorkspaceContext';

type PowerTest = 'two-sample-t' | 'paired-t' | 'anova' | 'correlation' | 'two-proportions';

const TESTS: Record<PowerTest, { label: string; effect: string; presets: [string, number][]; help: string }> = {
  'two-sample-t': { label: 'Compare two groups’ averages', effect: 'Cohen’s d', presets: [['Small', 0.2], ['Medium', 0.5], ['Large', 0.8]], help: 'd = difference in averages ÷ standard deviation.' },
  'paired-t': { label: 'Before/after on the same subjects', effect: 'Cohen’s dz', presets: [['Small', 0.2], ['Medium', 0.5], ['Large', 0.8]], help: 'dz = average change ÷ standard deviation of the changes.' },
  anova: { label: 'Compare 3+ groups’ averages', effect: 'Cohen’s f', presets: [['Small', 0.1], ['Medium', 0.25], ['Large', 0.4]], help: 'f describes how spread out the group averages are.' },
  correlation: { label: 'Detect a correlation', effect: 'Correlation r', presets: [['Small', 0.1], ['Medium', 0.3], ['Large', 0.5]], help: 'The smallest correlation you want to be able to detect.' },
  'two-proportions': { label: 'Compare two rates (e.g. conversion)', effect: 'Cohen’s h', presets: [['Small', 0.2], ['Medium', 0.5], ['Large', 0.8]], help: 'h = 2·asin(√p₁) − 2·asin(√p₂). 10% vs 12% is h ≈ 0.064.' },
};

/** How many rows a study needs, or how likely it is to detect an effect. */
export default function StatsPower() {
  const logRun = useLogRun();
  const [test, setTest] = useState<PowerTest>('two-sample-t');
  const [effect, setEffect] = useState('0.5');
  const [alpha, setAlpha] = useState(0.05);
  const [solveFor, setSolveFor] = useState<'n' | 'power'>('n');
  const [power, setPower] = useState('0.8');
  const [n, setN] = useState('50');
  const [groups, setGroups] = useState('3');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<{ n: number; power: number; achievedPower?: number; unit?: string; solvedFor: 'n' | 'power' } | null>(null);
  const meta = TESTS[test];

  const run = async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await apiFetch('/api/stats/power', {
        method: 'POST',
        body: JSON.stringify({
          test, effect: Number(effect), alpha, groups: Number(groups),
          ...(solveFor === 'n' ? { power: Number(power) } : { n: Number(n) }),
        }),
      });
      const body = await res.json().catch(() => null);
      if (!res.ok || !body) throw new Error(body?.error || `The calculation couldn’t run (HTTP ${res.status}).`);
      setResult(body);
      logRun({
        kind: 'power',
        title: `${TESTS[test].label}: ${TESTS[test].effect} = ${effect}`,
        summary: body.solvedFor === 'n' ? `${body.n} ${body.unit} needed for ${Math.round(Number(power) * 100)}% power` : `${(body.power * 100).toFixed(1)}% power with ${n}`,
        status: 'succeeded',
        params: { test, effect: Number(effect), alpha },
        result: body,
      });
    } catch (err) {
      setResult(null);
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  };

  const unitFor = (t: PowerTest) => ({ 'two-sample-t': 'per group', 'paired-t': 'pairs', anova: 'per group', correlation: 'in total', 'two-proportions': 'per group' }[t]);

  return (
    <div className="space-y-6">
      <div className="card p-4 sm:p-5 space-y-4">
        <div>
          <h3 className="card-title" data-agent="area-power">Sample size and power</h3>
          <p className="mt-1 text-sm text-label-2">
            Plan a study: how many rows you need to reliably detect an effect of a given size, or how likely your current sample is to detect it.
          </p>
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <div>
            <label className="field-label" htmlFor="pw-test">What you want to test</label>
            <select id="pw-test" data-agent="pw-test" className="input" value={test} onChange={e => { const t = e.target.value as PowerTest; setTest(t); setEffect(String(TESTS[t].presets[1][1])); setResult(null); }}>
              {(Object.keys(TESTS) as PowerTest[]).map(t => <option key={t} value={t}>{TESTS[t].label}</option>)}
            </select>
          </div>
          <div>
            <label className="field-label" htmlFor="pw-effect">Effect size ({meta.effect})</label>
            <div className="flex gap-2">
              <input id="pw-effect" data-agent="pw-effect" className="input flex-1" inputMode="decimal" value={effect} onChange={e => setEffect(e.target.value)} />
              {meta.presets.map(([label, v]) => (
                <button key={label} type="button" className={`btn btn-sm ${Number(effect) === v ? 'btn-primary' : 'btn-secondary'}`} onClick={() => setEffect(String(v))}>{label}</button>
              ))}
            </div>
            <p className="mt-1 text-xs text-label-2">{meta.help}</p>
          </div>
          <div>
            <span className="field-label">Find</span>
            <div className="segmented w-max" role="group" aria-label="What to calculate">
              <button type="button" aria-pressed={solveFor === 'n'} onClick={() => { setSolveFor('n'); setResult(null); }}>Sample size</button>
              <button type="button" aria-pressed={solveFor === 'power'} onClick={() => { setSolveFor('power'); setResult(null); }}>Power</button>
            </div>
          </div>
          {solveFor === 'n' ? (
            <div>
              <label className="field-label" htmlFor="pw-power">Desired power</label>
              <select id="pw-power" data-agent="pw-power" className="input" value={power} onChange={e => setPower(e.target.value)}>
                <option value="0.8">80% (common)</option>
                <option value="0.9">90%</option>
                <option value="0.95">95%</option>
              </select>
            </div>
          ) : (
            <div>
              <label className="field-label" htmlFor="pw-n">Sample size ({unitFor(test)})</label>
              <input id="pw-n" data-agent="pw-n" className="input" inputMode="numeric" value={n} onChange={e => setN(e.target.value)} />
            </div>
          )}
          <div>
            <label className="field-label" htmlFor="pw-alpha">Significance level</label>
            <select id="pw-alpha" data-agent="pw-alpha" className="input" value={alpha} onChange={e => setAlpha(Number(e.target.value))}>
              <option value={0.01}>0.01</option>
              <option value={0.05}>0.05</option>
              <option value={0.1}>0.10</option>
            </select>
          </div>
          {test === 'anova' && (
            <div>
              <label className="field-label" htmlFor="pw-groups">Number of groups</label>
              <input id="pw-groups" data-agent="pw-groups" className="input" inputMode="numeric" value={groups} onChange={e => setGroups(e.target.value)} />
            </div>
          )}
        </div>
        <button type="button" data-agent="pw-run" onClick={run} disabled={loading} aria-busy={loading} className="btn btn-primary">
          {loading ? <><Orb state="solving" onAccent label="Calculating" /> Calculating…</> : 'Calculate'}
        </button>
        {error && (
          <p role="alert" className="flex items-start gap-2 rounded-xl bg-red/10 px-3 py-2.5 text-sm text-red">
            <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" /> {error}
          </p>
        )}
        {result && (
          <div className="rounded-2xl bg-well p-4 animate-fade-in" role="status">
            {result.solvedFor === 'n' ? (
              <>
                <p className="text-[28px] font-semibold tracking-tight tabular-nums text-label">{result.n.toLocaleString()} <span className="text-base font-normal text-label-2">{result.unit}</span></p>
                <p className="mt-1 text-sm text-label-2">
                  needed for a {Math.round(Number(power) * 100)}% chance of detecting {meta.effect} = {effect} at the {alpha} level
                  {result.achievedPower ? ` (this size gives ${(result.achievedPower * 100).toFixed(1)}% power)` : ''}.
                </p>
              </>
            ) : (
              <>
                <p className="text-[28px] font-semibold tracking-tight tabular-nums text-label">{(result.power * 100).toFixed(1)}% <span className="text-base font-normal text-label-2">power</span></p>
                <p className="mt-1 text-sm text-label-2">
                  chance of detecting {meta.effect} = {effect} with {Number(n).toLocaleString()} {unitFor(test)} at the {alpha} level.
                  {result.power < 0.8 && ' Below the usual 80% target — a non-significant result would be hard to interpret.'}
                </p>
              </>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
