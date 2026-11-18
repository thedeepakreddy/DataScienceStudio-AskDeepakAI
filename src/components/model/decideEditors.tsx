/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React from 'react';
import { Plus, X } from 'lucide-react';

// ================================================================== Monte Carlo inputs
export type Dist = 'normal' | 'uniform' | 'triangular' | 'poisson' | 'constant';
export interface VariableRow { name: string; distribution: Dist; a: string; b: string; c: string }

/** What a, b and c mean for each distribution (the engine's triangular takes low=a, high=b, most likely=c). */
export const DIST: Record<Dist, { label: string; params: { key: 'a' | 'b' | 'c'; label: string }[] }> = {
  normal: { label: 'Normal (bell curve)', params: [{ key: 'a', label: 'Average' }, { key: 'b', label: 'Std deviation' }] },
  triangular: { label: 'Triangular (low / likely / high)', params: [{ key: 'a', label: 'Lowest' }, { key: 'c', label: 'Most likely' }, { key: 'b', label: 'Highest' }] },
  uniform: { label: 'Uniform (anything in a range)', params: [{ key: 'a', label: 'Lowest' }, { key: 'b', label: 'Highest' }] },
  poisson: { label: 'Poisson (a count)', params: [{ key: 'a', label: 'Average count' }] },
  constant: { label: 'Fixed value', params: [{ key: 'a', label: 'Value' }] },
};

const NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

export const initialVariables = (): VariableRow[] => [
  { name: 'price', distribution: 'normal', a: '20', b: '2', c: '' },
  { name: 'volume', distribution: 'triangular', a: '800', b: '1300', c: '1000' },
  { name: 'fixed_cost', distribution: 'constant', a: '15000', b: '', c: '' },
];

export function checkVariables(rows: VariableRow[]): string | null {
  if (!rows.length) return 'Add at least one input.';
  const seen = new Set<string>();
  for (const r of rows) {
    if (!NAME.test(r.name)) return `“${r.name || '(blank)'}” isn’t a usable name: use letters, digits and _ (no spaces), starting with a letter.`;
    if (seen.has(r.name)) return `Two inputs are called “${r.name}”.`;
    seen.add(r.name);
    for (const p of DIST[r.distribution].params) if (r[p.key] === '' || Number.isNaN(Number(r[p.key]))) return `Enter ${p.label.toLowerCase()} for ${r.name}.`;
    const [a, b, c] = [Number(r.a), Number(r.b), Number(r.c)];
    if (r.distribution === 'normal' && b <= 0) return `${r.name}: the standard deviation must be above 0.`;
    if ((r.distribution === 'uniform' || r.distribution === 'triangular') && !(a < b)) return `${r.name}: the lowest value must be below the highest.`;
    if (r.distribution === 'triangular' && !(c >= a && c <= b)) return `${r.name}: the most likely value must be between lowest and highest.`;
    if (r.distribution === 'poisson' && a < 0) return `${r.name}: the average count can’t be negative.`;
  }
  return null;
}

export const variablesToParams = (rows: VariableRow[]) => rows.map(r => {
  const out: Record<string, unknown> = { name: r.name, distribution: r.distribution };
  for (const p of DIST[r.distribution].params) out[p.key] = Number(r[p.key]);
  return out;
});

export const VariablesEditor: React.FC<{ value: VariableRow[]; onChange: (v: VariableRow[]) => void; id: string }> = ({ value: rows, onChange, id }) => {
  const set = (i: number, patch: Partial<VariableRow>) => onChange(rows.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  return (
    <div className="space-y-2" role="group" aria-labelledby={id}>
      {rows.map((r, i) => (
        <div key={i} className="grid grid-cols-2 sm:grid-cols-[minmax(0,1fr)_minmax(0,1.4fr)_repeat(3,minmax(0,0.8fr))_auto] gap-2 items-end rounded-xl sm:rounded-none bg-fill/50 sm:bg-transparent p-2 sm:p-0">
          <label className="text-xs text-label-2">Name<input className="input mt-0.5 font-mono" value={r.name} onChange={e => set(i, { name: e.target.value })} /></label>
          <label className="text-xs text-label-2">How it varies
            <select className="input mt-0.5" value={r.distribution} onChange={e => set(i, { distribution: e.target.value as Dist })}>
              {(Object.keys(DIST) as Dist[]).map(d => <option key={d} value={d}>{DIST[d].label}</option>)}
            </select>
          </label>
          {[0, 1, 2].map(k => {
            const p = DIST[r.distribution].params[k];
            return p
              ? <label key={k} className="text-xs text-label-2">{p.label}<input className="input mt-0.5" type="number" inputMode="decimal" step="any" value={r[p.key]} onChange={e => set(i, { [p.key]: e.target.value })} /></label>
              : <span key={k} className="hidden sm:block" />;
          })}
          <button type="button" aria-label={`Remove ${r.name || 'input'}`} className="btn btn-icon w-8 h-8 mb-1 text-label-3 disabled:opacity-30 justify-self-end" disabled={rows.length <= 1} onClick={() => onChange(rows.filter((_, j) => j !== i))}><X className="w-4 h-4" /></button>
        </div>
      ))}
      <button type="button" className="btn btn-plain -ml-2 !text-sm" onClick={() => onChange([...rows, { name: `input_${rows.length + 1}`, distribution: 'normal', a: '0', b: '1', c: '' }])}><Plus className="w-4 h-4" /> Add input</button>
    </div>
  );
};

// ================================================================== linear programme
export interface LpConstraintRow { name: string; coefficients: string[]; sense: '<=' | '>=' | '='; rhs: string }
export interface LpProblem { variables: string[]; objective: string[]; sense: 'maximize' | 'minimize'; constraints: LpConstraintRow[]; whole: boolean }

export const initialProblem = (): LpProblem => ({
  variables: ['chairs', 'tables'],
  objective: ['45', '80'],
  sense: 'maximize',
  constraints: [
    { name: 'wood', coefficients: ['5', '20'], sense: '<=', rhs: '400' },
    { name: 'labour_hours', coefficients: ['10', '15'], sense: '<=', rhs: '450' },
  ],
  whole: false,
});

const bad = (x: string) => x === '' || Number.isNaN(Number(x));

export function checkProblem(p: LpProblem): string | null {
  if (!p.variables.length) return 'Add at least one decision.';
  const seen = new Set<string>();
  for (const v of p.variables) {
    if (!v.trim()) return 'Give every decision a name.';
    if (seen.has(v)) return `Two decisions are called “${v}”.`;
    seen.add(v);
  }
  if (p.objective.some(bad)) return 'Enter a number for every decision in the goal row.';
  for (const c of p.constraints) if (c.coefficients.some(bad) || bad(c.rhs)) return `Fill in every number for the limit “${c.name || 'unnamed'}”.`;
  return null;
}

export const problemToParams = (p: LpProblem) => ({
  variables: p.variables,
  objective: p.objective.map(Number),
  sense: p.sense,
  constraints: p.constraints.map((c, i) => ({ name: c.name.trim() || `limit ${i + 1}`, coefficients: c.coefficients.map(Number), sense: c.sense, rhs: Number(c.rhs) })),
  ...(p.whole ? { integer: p.variables } : {}),
});

const cell = 'input !px-2 text-right tabular-nums min-w-[4.5rem]';

export const LpEditor: React.FC<{ value: LpProblem; onChange: (v: LpProblem) => void; id: string }> = ({ value: p, onChange, id }) => {
  const addVar = () => onChange({ ...p, variables: [...p.variables, `item_${p.variables.length + 1}`], objective: [...p.objective, '0'], constraints: p.constraints.map(c => ({ ...c, coefficients: [...c.coefficients, '0'] })) });
  const dropVar = (j: number) => onChange({ ...p, variables: p.variables.filter((_, k) => k !== j), objective: p.objective.filter((_, k) => k !== j), constraints: p.constraints.map(c => ({ ...c, coefficients: c.coefficients.filter((_, k) => k !== j) })) });
  const setC = (i: number, patch: Partial<LpConstraintRow>) => onChange({ ...p, constraints: p.constraints.map((c, k) => (k === i ? { ...c, ...patch } : c)) });
  return (
    <div className="space-y-3" role="group" aria-labelledby={id}>
      <div className="overflow-x-auto -mx-1 px-1">
        <table className="text-sm border-separate border-spacing-1">
          <thead>
            <tr>
              <th className="text-left text-xs font-medium text-label-2 pr-2">Decision →</th>
              {p.variables.map((v, j) => (
                <th key={j} className="font-normal">
                  <div className="flex items-center gap-1">
                    <input aria-label={`Decision ${j + 1} name`} className="input !px-2 font-mono min-w-[5.5rem]" value={v} onChange={e => onChange({ ...p, variables: p.variables.map((x, k) => (k === j ? e.target.value : x)) })} />
                    <button type="button" aria-label={`Remove ${v}`} className="text-label-3 disabled:opacity-30" disabled={p.variables.length <= 1} onClick={() => dropVar(j)}><X className="w-3.5 h-3.5" /></button>
                  </div>
                </th>
              ))}
              <th colSpan={2} className="text-left"><button type="button" className="btn btn-plain !text-sm whitespace-nowrap" onClick={addVar}><Plus className="w-4 h-4" /> Decision</button></th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td className="pr-2">
                <select aria-label="Goal" className="input !px-2" value={p.sense} onChange={e => onChange({ ...p, sense: e.target.value as LpProblem['sense'] })}>
                  <option value="maximize">Maximise</option><option value="minimize">Minimise</option>
                </select>
              </td>
              {p.objective.map((x, j) => <td key={j}><input aria-label={`Goal value per ${p.variables[j]}`} className={cell} type="number" inputMode="decimal" step="any" value={x} onChange={e => onChange({ ...p, objective: p.objective.map((y, k) => (k === j ? e.target.value : y)) })} /></td>)}
              <td colSpan={2} className="text-xs text-label-3 pl-1">per unit</td>
            </tr>
            {p.constraints.map((c, i) => (
              <tr key={i}>
                <td className="pr-2"><input aria-label={`Limit ${i + 1} name`} className="input !px-2 min-w-[7rem]" placeholder="Limit name" value={c.name} onChange={e => setC(i, { name: e.target.value })} /></td>
                {c.coefficients.map((x, j) => <td key={j}><input aria-label={`${c.name || `Limit ${i + 1}`} used per ${p.variables[j]}`} className={cell} type="number" inputMode="decimal" step="any" value={x} onChange={e => setC(i, { coefficients: c.coefficients.map((y, k) => (k === j ? e.target.value : y)) })} /></td>)}
                <td>
                  <select aria-label="Comparison" className="input !px-2" value={c.sense} onChange={e => setC(i, { sense: e.target.value as LpConstraintRow['sense'] })}>
                    <option value="<=">≤</option><option value=">=">≥</option><option value="=">=</option>
                  </select>
                </td>
                <td>
                  <div className="flex items-center gap-1">
                    <input aria-label={`${c.name || `Limit ${i + 1}`} available`} className={cell} type="number" inputMode="decimal" step="any" value={c.rhs} onChange={e => setC(i, { rhs: e.target.value })} />
                    <button type="button" aria-label={`Remove ${c.name || 'limit'}`} className="text-label-3" onClick={() => onChange({ ...p, constraints: p.constraints.filter((_, k) => k !== i) })}><X className="w-3.5 h-3.5" /></button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <button type="button" className="btn btn-plain -ml-2 !text-sm" onClick={() => onChange({ ...p, constraints: [...p.constraints, { name: '', coefficients: p.variables.map(() => '0'), sense: '<=', rhs: '0' }] })}><Plus className="w-4 h-4" /> Add limit</button>
        <label className="flex items-center gap-2 text-sm text-label"><input type="checkbox" checked={p.whole} onChange={e => onChange({ ...p, whole: e.target.checked })} /> Whole numbers only</label>
      </div>
      <p className="text-xs text-label-3">Each row of limits: how much of it one unit of each decision uses, and how much is available. Decisions can’t go below zero.</p>
    </div>
  );
};
