/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import type { DatasetVersion, RunRecord } from './workspaceStore';
import type { RegisteredModel } from './modelRegistry';

// Where results came from: the chain of data versions, the saved runs, and a
// Jupyter notebook that repeats the analysis outside the studio.

/** Versions from the import to `versionId`, oldest first. Stops at a pruned version. */
export function lineage(versions: DatasetVersion[], versionId: string | null): DatasetVersion[] {
  const byId = new Map(versions.map(v => [v.id, v]));
  const chain: DatasetVersion[] = [];
  let current = versionId ? byId.get(versionId) : undefined;
  const seen = new Set<string>();
  while (current && !seen.has(current.id)) {
    seen.add(current.id);
    chain.unshift(current);
    current = current.parentId ? byId.get(current.parentId) : undefined;
  }
  return chain;
}

const fp = (p: unknown) => (typeof p === 'number' ? (p < 0.001 ? '< 0.001' : p.toFixed(3)) : '—');
const f3 = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? (Math.abs(v) >= 100 ? v.toFixed(1) : v.toFixed(3)) : '—');

/** A saved run as plain sentences with its real numbers, for the report. */
export function describeRun(run: RunRecord): { heading: string; lines: string[] } {
  const r = (run.result ?? {}) as any;
  const p = (run.params ?? {}) as any;
  switch (run.kind) {
    case 'hypothesis-test': {
      if (!r.test) return { heading: run.title, lines: [run.summary] };
      const lines = [
        `${r.test}: ${r.statisticName ?? 'statistic'} = ${f3(r.statistic)}, p = ${fp(r.pValue)} — ${r.significant ? 'statistically significant' : 'not statistically significant'} at the ${r.alpha ?? 0.05} level.`,
      ];
      if (r.effectSize?.value !== undefined && r.effectSize?.value !== null) lines.push(`Effect size: ${r.effectSize.name} = ${f3(r.effectSize.value)} (${r.effectSize.magnitude ?? 'unrated'}).`);
      if (r.estimate?.ci?.[0] !== undefined && r.estimate?.ci?.[0] !== null) lines.push(`${r.estimate.name}: ${f3(r.estimate.value)}, ${Math.round((r.estimate.level ?? 0.95) * 100)}% CI ${f3(r.estimate.ci[0])} to ${f3(r.estimate.ci[1])}.`);
      if (r.recommendNonParametric && r.nonParametric?.test) lines.push(`An assumption was not met; ${r.nonParametric.test} gives p = ${fp(r.nonParametric.pValue)}.`);
      lines.push(`${r.rowsUsed ?? '?'} rows used.`);
      return { heading: run.title, lines };
    }
    case 'regression': {
      if (!r.coefficients) return { heading: run.title, lines: [run.summary] };
      const sig = (r.coefficients as any[]).filter(c => c.term !== '(Intercept)' && c.significant);
      return {
        heading: run.title,
        lines: [
          r.kind === 'linear'
            ? `R² ${f3(r.fit?.rSquared)} (adjusted ${f3(r.fit?.adjRSquared)}), model p = ${fp(r.fit?.fPValue)}, ${r.n} rows.`
            : `Pseudo R² ${f3(r.fit?.pseudoRSquared)}, model p = ${fp(r.fit?.lrPValue)}, ${r.n} rows.`,
          sig.length
            ? `Significant terms: ${sig.map(c => `${c.term} (${r.kind === 'logistic' ? `odds ratio ${f3(c.oddsRatio)}` : `estimate ${f3(c.estimate)}`}, p ${fp(c.pValue)})`).join('; ')}.`
            : 'No predictor was significant.',
        ],
      };
    }
    case 'forecast': {
      const best = r.leaderboard?.[0];
      const next = (r.forecast ?? []).slice(0, 3).map((x: any) => `${x.date}: ${f3(x.value)} (80% range ${f3(x.lo80)}–${f3(x.hi80)})`);
      return { heading: run.title, lines: [best ? `Best method by backtesting: ${best.label}, MAE ${f3(best.mae)}.` : run.summary, ...(next.length ? [`Next periods — ${next.join('; ')}.`] : [])] };
    }
    case 'ab-test':
      return { heading: run.title, lines: [run.summary, p.controlSize ? `Control ${p.controlSize} at ${(p.controlRate * 100).toFixed(1)}%, treatment ${p.treatmentSize} at ${(p.treatmentRate * 100).toFixed(1)}%.` : ''].filter(Boolean) };
    default:
      return { heading: run.title, lines: [run.summary] };
  }
}

/** The kinds of saved runs that can go in a report. */
export const REPORTABLE_KINDS: RunRecord['kind'][] = ['hypothesis-test', 'regression', 'forecast', 'ab-test'];

// --- Notebook --------------------------------------------------------------------

const py = (s: unknown) => JSON.stringify(s);

function cell(kind: 'markdown' | 'code', source: string) {
  const lines = source.split('\n').map((l, i, a) => (i < a.length - 1 ? `${l}\n` : l));
  return kind === 'markdown'
    ? { cell_type: 'markdown', metadata: {}, source: lines }
    : { cell_type: 'code', metadata: {}, execution_count: null, outputs: [], source: lines };
}

const ESTIMATORS: Record<string, { clf: string; reg: string; scale: boolean }> = {
  linear: { clf: 'LogisticRegression(max_iter=1000, random_state=SEED{C})', reg: 'LinearRegression()', scale: true },
  random_forest: { clf: 'RandomForestClassifier(n_estimators={n}, max_depth={d}, random_state=SEED, oob_score=True{extra})', reg: 'RandomForestRegressor(n_estimators={n}, max_depth={d}, random_state=SEED, oob_score=True{extra})', scale: false },
  gradient_boosting: { clf: 'GradientBoostingClassifier(n_estimators={n}, max_depth={d3}, learning_rate={lr}, random_state=SEED{extra})', reg: 'GradientBoostingRegressor(n_estimators={n}, max_depth={d3}, learning_rate={lr}, random_state=SEED{extra})', scale: false },
  xgboost: { clf: 'XGBClassifier(n_estimators={n}, max_depth={d6}, learning_rate={lr}, random_state=SEED, eval_metric="logloss"{extra})', reg: 'XGBRegressor(n_estimators={n}, max_depth={d6}, learning_rate={lr}, random_state=SEED{extra})', scale: false },
  mlp: { clf: 'MLPClassifier(hidden_layer_sizes=(64, 32), max_iter={ep}, random_state=SEED, early_stopping=True, n_iter_no_change=10{extra})', reg: 'MLPRegressor(hidden_layer_sizes=(64, 32), max_iter={ep}, random_state=SEED, early_stopping=True, n_iter_no_change=10{extra})', scale: true },
};

function estimatorCode(model: RegisteredModel): string {
  const spec = ESTIMATORS[model.modelKey] ?? ESTIMATORS.random_forest;
  const hp = model.recipe.hyperparameters ?? {};
  const tuned = model.tuning?.tuned ? model.tuning.bestParams : undefined;
  const pyVal = (v: unknown): string => (v === null || v === undefined ? 'None' : Array.isArray(v) ? `(${v.map(pyVal).join(', ')}${v.length === 1 ? ',' : ''})` : typeof v === 'string' ? py(v) : typeof v === 'boolean' ? (v ? 'True' : 'False') : String(v));
  const d = hp.max_depth === undefined || hp.max_depth === '' ? 'None' : String(hp.max_depth);
  let code = (model.task === 'classification' ? spec.clf : spec.reg)
    .replace('{n}', String(hp.n_estimators ?? 100))
    .replace('{d}', d).replace('{d3}', hp.max_depth ? String(hp.max_depth) : '3').replace('{d6}', hp.max_depth ? String(hp.max_depth) : '6')
    .replace('{lr}', String(hp.learning_rate ?? 0.1)).replace('{ep}', String(hp.epochs ?? 200))
    .replace('{C}', '');
  const extra = tuned ? Object.entries(tuned).map(([k, v]) => `, ${k}=${pyVal(v)}`).join('') : '';
  code = code.replace('{extra}', '');
  if (extra) code = code.replace(/\)$/, `${extra})`);
  return code;
}

export function buildNotebook(opts: {
  datasetName: string;
  dataFile: string;
  versionLabel: string;
  model?: RegisteredModel | null;
  tests?: RunRecord[];
}): string {
  const cells = [
    cell('markdown', `# Reproducing the analysis of ${opts.datasetName}

Exported from Data Science Studio on ${new Date().toISOString().slice(0, 10)}.
Data: \`${opts.dataFile}\` — data version “${opts.versionLabel}”.

Run with Python 3.10+ and: \`pip install pandas scikit-learn scipy xgboost\`.
Library versions can shift scores slightly; the studio’s numbers are printed alongside for comparison.`),
    cell('code', `import pandas as pd
import numpy as np
from scipy import stats

df = pd.read_csv(${py(opts.dataFile)})
print(df.shape)
df.describe(include="all").T.head(30)`),
  ];

  const m = opts.model;
  if (m) {
    const split = m.split ?? { strategy: 'random', testSize: 0.2 } as any;
    const isClf = m.task === 'classification';
    const splitCode = split.strategy === 'time'
      ? `order = pd.to_datetime(df.loc[X.index, ${py(split.timeColumn)}], errors="coerce", utc=True).sort_values(kind="stable").dropna().index
n_test = max(1, int(round(len(order) * TEST_SIZE)))
X_train, X_test = X.loc[order[:-n_test]], X.loc[order[-n_test:]]
y_train, y_test = y.loc[X_train.index], y.loc[X_test.index]`
      : split.strategy === 'group'
      ? `from sklearn.model_selection import GroupShuffleSplit
groups = df.loc[X.index, ${py(split.groupColumn)}].astype(str)
tr, te = next(GroupShuffleSplit(n_splits=1, test_size=TEST_SIZE, random_state=SEED).split(X, y, groups))
X_train, X_test, y_train, y_test = X.iloc[tr], X.iloc[te], y.iloc[tr], y.iloc[te]`
      : `from sklearn.model_selection import train_test_split
strat = y if ${isClf ? 'True' : 'False'} and y.value_counts().min() >= 2 else None
X_train, X_test, y_train, y_test = train_test_split(X, y, test_size=TEST_SIZE, random_state=SEED, stratify=strat)`;
    const expected = isClf ? m.metrics.accuracy : m.metrics.r2Score;
    cells.push(
      cell('markdown', `## Model: ${m.name} v${m.version}

${m.algorithm} predicting **${m.recipe.target}** from ${m.recipe.features.length} columns, seed ${m.seed ?? m.recipe.hyperparameters?.seed ?? 42}, ${split.strategy} split. Preprocessing matches the studio: median-fill numbers${ESTIMATORS[m.modelKey]?.scale ? ' and standardise them' : ''}, most-frequent-fill and one-hot encode text, fitted on training rows only.`),
      cell('code', `from sklearn.compose import ColumnTransformer
from sklearn.impute import SimpleImputer
from sklearn.pipeline import Pipeline
from sklearn.preprocessing import OneHotEncoder, StandardScaler
from sklearn.linear_model import LinearRegression, LogisticRegression
from sklearn.ensemble import RandomForestClassifier, RandomForestRegressor, GradientBoostingClassifier, GradientBoostingRegressor
from sklearn.neural_network import MLPClassifier, MLPRegressor
from sklearn.metrics import accuracy_score, r2_score

SEED = ${m.seed ?? m.recipe.hyperparameters?.seed ?? 42}
TEST_SIZE = ${split.testSize ?? 0.2}
TARGET = ${py(m.recipe.target)}
FEATURES = ${py(m.recipe.features)}

data = df[df[TARGET].notna()]
X, y = data[FEATURES], data[TARGET]
${splitCode}

num = X_train.select_dtypes(include=[np.number]).columns.tolist()
cat = [c for c in X_train.columns if c not in num]
num_steps = [("imputer", SimpleImputer(strategy="median"))]${ESTIMATORS[m.modelKey]?.scale ? '\nnum_steps.append(("scaler", StandardScaler()))' : ''}
pre = ColumnTransformer([t for t in [
    ("num", Pipeline(num_steps), num) if num else None,
    ("cat", Pipeline([("imputer", SimpleImputer(strategy="most_frequent")), ("onehot", OneHotEncoder(handle_unknown="ignore"))]), cat) if cat else None,
] if t], remainder="drop")
${m.modelKey === 'xgboost' ? 'from xgboost import XGBClassifier, XGBRegressor\n' : ''}model = Pipeline([("preprocess", pre), ("model", ${estimatorCode(m)})])
${m.modelKey === 'xgboost' && isClf ? 'from sklearn.preprocessing import LabelEncoder\nenc = LabelEncoder().fit(y_train)\nmodel.fit(X_train, enc.transform(y_train))\npred = enc.inverse_transform(model.predict(X_test))' : 'model.fit(X_train, y_train)\npred = model.predict(X_test)'}
score = ${isClf ? 'accuracy_score(y_test, pred)' : 'r2_score(y_test, pred)'}
print(f"${isClf ? 'Accuracy' : 'R²'} here: {score:.4f}  |  in the studio: ${typeof expected === 'number' ? expected.toFixed(4) : 'n/a'}")`),
    );
  }

  const tests = (opts.tests ?? []).filter(t => t.kind === 'hypothesis-test' && (t.result as any)?.test);
  if (tests.length) {
    cells.push(cell('markdown', '## Statistical tests\n\nEach test from the studio, recomputed with SciPy.'));
    for (const t of tests) {
      const r = t.result as any;
      const a = (t.params as any)?.columnA;
      const b = (t.params as any)?.columnB;
      if (!a || !b) continue;
      const alt = py(r.alternative ?? 'two-sided');
      let code: string;
      if (r.test === 'Welch’s t-test') {
        code = `sub = df[[${py(r.valueColumn ?? a)}, ${py(r.groupColumn ?? b)}]].dropna()
groups = [g[${py(r.valueColumn ?? a)}].to_numpy(float) for _, g in sub.groupby(${py(r.groupColumn ?? b)}, sort=True)]
res = stats.ttest_ind(groups[0], groups[1], equal_var=False, alternative=${alt})`;
      } else if (r.test === 'Pearson correlation') {
        code = `sub = df[[${py(a)}, ${py(b)}]].dropna()
res = stats.pearsonr(sub[${py(a)}], sub[${py(b)}], alternative=${alt})`;
      } else if (r.test === 'Paired t-test') {
        code = `sub = df[[${py(a)}, ${py(b)}]].dropna()
res = stats.ttest_rel(sub[${py(a)}], sub[${py(b)}], alternative=${alt})`;
      } else if (String(r.test).startsWith('Chi-squared')) {
        code = `sub = df[[${py(a)}, ${py(b)}]].dropna()
table = pd.crosstab(sub[${py(a)}].astype(str), sub[${py(b)}].astype(str))
chi2, p, dof, _ = stats.chi2_contingency(table, correction=table.shape == (2, 2))
res = type("R", (), {"pvalue": p})()`;
      } else if (r.test === 'One-way ANOVA' || r.test === 'Welch’s ANOVA') {
        code = `sub = df[[${py(r.valueColumn ?? a)}, ${py(r.groupColumn ?? b)}]].dropna()
groups = [g[${py(r.valueColumn ?? a)}].to_numpy(float) for _, g in sub.groupby(${py(r.groupColumn ?? b)}, sort=True)]
res = stats.f_oneway(*groups)  # classic ANOVA${r.test === 'Welch’s ANOVA' ? '; the studio used Welch’s version (pingouin.welch_anova gives the same result)' : ''}`;
      } else {
        continue;
      }
      cells.push(cell('code', `# ${t.title}
${code}
print(f"p = {res.pvalue:.6g}  |  in the studio: ${r.pValue}")`));
    }
  }

  return JSON.stringify({
    cells,
    metadata: { kernelspec: { display_name: 'Python 3', language: 'python', name: 'python3' }, language_info: { name: 'python' } },
    nbformat: 4,
    nbformat_minor: 5,
  }, null, 1);
}

export function rowsToCsv(rows: Record<string, unknown>[], columns: string[]): string {
  const c = (v: unknown) => {
    if (v === null || v === undefined) return '';
    const s = typeof v === 'object' ? JSON.stringify(v) : String(v);
    return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return [columns.map(c).join(','), ...rows.map(r => columns.map(k => c(r[k])).join(','))].join('\n') + '\n';
}
