"""Hypothesis tests that choose themselves, with assumption checks and effect sizes.

`stats.compare` looks at the two variables (numeric or categorical, paired or
not, how many groups) and the assumptions (normality, equal variances), runs
the right test, and also reports the alternative it rejected and why.
"""
from __future__ import annotations

import itertools
from typing import Literal

import numpy as np
import pandas as pd
from pydantic import BaseModel, Field
from scipy import stats
from statsmodels.stats.multicomp import pairwise_tukeyhsd
from statsmodels.stats.multitest import multipletests
from statsmodels.stats.oneway import anova_oneway

from ..core import EngineError
from ..registry import capability
from ._util import NUMERIC, fmt_p, need

MAX_ROWS = 2_000_000


def _normal(x: np.ndarray, rng) -> dict:
    x = x[np.isfinite(x)]
    if len(x) < 8:
        return {"test": None, "p": None, "normal": None, "n": len(x)}
    s = x if len(x) <= 5000 else rng.choice(x, 5000, replace=False)
    w, p = stats.shapiro(s)
    # With big samples Shapiro rejects tiny departures; rely on skew/kurtosis there.
    if len(x) > 300:
        normal = abs(stats.skew(x)) < 1 and abs(stats.kurtosis(x)) < 3
    else:
        normal = p > 0.05
    return {"test": "Shapiro–Wilk", "statistic": w, "p": p, "normal": bool(normal), "n": len(x), "skew": stats.skew(x), "excessKurtosis": stats.kurtosis(x)}


BOOTSTRAP_MAX_ROWS = 200_000  # above this the bootstrap of a mean difference is indistinguishable from the normal interval
BOOTSTRAP_CHUNK = 20_000_000  # resampled values held in memory at once


def _boot_diff(a, b, rng, fn=np.mean, n=2000, conf=0.95):
    """Percentile bootstrap interval for fn(a) − fn(b), resampled in memory-bounded chunks.
    For a mean difference on very large samples it returns the Welch normal interval instead."""
    if len(a) * len(b) == 0:
        return [None, None]
    if fn is np.mean and len(a) + len(b) > BOOTSTRAP_MAX_ROWS:
        se = np.sqrt(np.var(a, ddof=1) / len(a) + np.var(b, ddof=1) / len(b))
        z = stats.norm.ppf(1 - (1 - conf) / 2)
        d = float(np.mean(a) - np.mean(b))
        return [d - z * se, d + z * se]
    per = max(1, BOOTSTRAP_CHUNK // (len(a) + len(b)))
    d = []
    for start in range(0, n, per):
        k = min(per, n - start)
        d.append(fn(a[rng.integers(0, len(a), (k, len(a)))], axis=1) - fn(b[rng.integers(0, len(b), (k, len(b)))], axis=1))
    d = np.concatenate(d)
    return [float(np.quantile(d, (1 - conf) / 2)), float(np.quantile(d, 1 - (1 - conf) / 2))]


class CompareParams(BaseModel):
    a: str = Field(..., description="Outcome (or first) column.")
    b: str = Field(..., description="Group (or second) column.")
    paired: bool = Field(False, description="True when a and b are two measurements of the same rows.")
    alpha: float = Field(0.05, gt=0, lt=0.5)
    alternative: Literal["two-sided", "less", "greater"] = "two-sided"
    force: Literal["auto", "parametric", "nonparametric"] = "auto"
    max_groups: int = Field(30, ge=2, le=200)


@capability("stats.compare", "stats", "Compare two variables (auto test)",
            "Chooses and runs the right test for two columns: t-test / Welch / Mann–Whitney, paired t / Wilcoxon, ANOVA / Welch ANOVA / Kruskal–Wallis with post-hoc tests, chi-square / Fisher, or Pearson / Spearman / Kendall correlation — with assumption checks, effect sizes and confidence intervals.",
            CompareParams, tags=["hypothesis", "auto"])
def compare(ctx, p: CompareParams):  # noqa: C901 - one branch per kind of comparison
    ctx.require(p.a, p.b)
    types = {c["name"]: c["type"] for c in ctx.columns()}
    df = ctx.frame([p.a, p.b] if p.a != p.b else [p.a], max_rows=MAX_ROWS)
    rng = ctx.rng
    num_a, num_b = types[p.a] in NUMERIC, types[p.b] in NUMERIC
    distinct_b = df[p.b].nunique(dropna=True)
    out: dict = {"a": p.a, "b": p.b, "alpha": p.alpha}

    if p.paired:
        need(num_a and num_b, "A paired comparison needs two numeric columns.")
        d = df[[p.a, p.b]].apply(pd.to_numeric, errors="coerce").dropna()
        need(len(d) >= 3, "Too few complete pairs.")
        diff = (d[p.a] - d[p.b]).to_numpy(float)
        norm = _normal(diff, rng)
        use_t = p.force == "parametric" or (p.force == "auto" and norm["normal"] is not False)
        t = stats.ttest_rel(d[p.a], d[p.b], alternative=p.alternative)
        w = stats.wilcoxon(d[p.a], d[p.b], alternative=p.alternative) if np.any(diff != 0) else None
        dz = diff.mean() / diff.std(ddof=1) if diff.std(ddof=1) > 0 else None
        ci = stats.t.interval(1 - p.alpha, len(diff) - 1, loc=diff.mean(), scale=stats.sem(diff))
        chosen = {"test": "Paired t-test", "statistic": t.statistic, "p": t.pvalue} if use_t else {"test": "Wilcoxon signed-rank", "statistic": w.statistic, "p": w.pvalue}
        out.update(kind="paired", n=len(d), meanDifference=diff.mean(), ci=list(ci), effect={"cohen_dz": dz}, assumptions={"differencesNormal": norm},
                   chosen=chosen, alternative=({"test": "Wilcoxon signed-rank", "p": w.pvalue if w else None} if use_t else {"test": "Paired t-test", "p": t.pvalue}),
                   why="Differences look normal, so the paired t-test." if use_t else "Differences aren't normal, so the rank-based Wilcoxon test.")
    elif num_a and num_b and distinct_b > p.max_groups:
        d = df[[p.a, p.b]].apply(pd.to_numeric, errors="coerce").dropna()
        need(len(d) >= 4, "Too few complete rows.")
        x, y = d[p.a].to_numpy(float), d[p.b].to_numpy(float)
        pr, sp, kd = stats.pearsonr(x, y, alternative=p.alternative), stats.spearmanr(x, y, alternative=p.alternative), stats.kendalltau(x, y, alternative=p.alternative)
        nx, ny = _normal(x, rng), _normal(y, rng)
        use_p = p.force == "parametric" or (p.force == "auto" and nx["normal"] is not False and ny["normal"] is not False)
        z = np.arctanh(np.clip(pr.statistic, -0.999999, 0.999999))
        se = 1 / np.sqrt(len(x) - 3)
        zc = stats.norm.ppf(1 - p.alpha / 2)
        out.update(kind="correlation", n=len(d), pearson={"r": pr.statistic, "p": pr.pvalue, "ci": [np.tanh(z - zc * se), np.tanh(z + zc * se)]},
                   spearman={"rho": sp.statistic, "p": sp.pvalue}, kendall={"tau": kd.statistic, "p": kd.pvalue},
                   assumptions={"aNormal": nx, "bNormal": ny},
                   chosen={"test": "Pearson correlation", "statistic": pr.statistic, "p": pr.pvalue} if use_p else {"test": "Spearman correlation", "statistic": sp.statistic, "p": sp.pvalue},
                   why="Both look normal, so Pearson (linear) correlation." if use_p else "Not both normal, so Spearman (rank) correlation, which is robust to outliers and curves.",
                   effect={"r_squared": pr.statistic ** 2})
    elif num_a:
        d = df[[p.a, p.b]].dropna()
        d = d.assign(**{p.a: pd.to_numeric(d[p.a], errors="coerce")}).dropna()
        groups = {str(k): g[p.a].to_numpy(float) for k, g in d.groupby(p.b, sort=True)}
        groups = {k: v for k, v in groups.items() if len(v) >= 2}
        need(len(groups) >= 2, f"“{p.b}” needs at least two groups with two or more values each.")
        need(len(groups) <= p.max_groups, f"“{p.b}” has {len(groups)} groups; the limit is {p.max_groups}.")
        norms = {k: _normal(v, rng) for k, v in groups.items()}
        all_normal = all(n["normal"] is not False for n in norms.values())
        lev = stats.levene(*groups.values(), center="median")
        equal_var = lev.pvalue > 0.05
        desc = [{"group": k, "n": len(v), "mean": v.mean(), "sd": v.std(ddof=1), "median": float(np.median(v))} for k, v in groups.items()]
        use_param = p.force == "parametric" or (p.force == "auto" and all_normal)
        if len(groups) == 2:
            (ka, a), (kb, b) = list(groups.items())
            t = stats.ttest_ind(a, b, equal_var=equal_var, alternative=p.alternative)
            u = stats.mannwhitneyu(a, b, alternative=p.alternative)
            pooled = np.sqrt(((len(a) - 1) * a.var(ddof=1) + (len(b) - 1) * b.var(ddof=1)) / (len(a) + len(b) - 2))
            d_ = (a.mean() - b.mean()) / pooled if pooled > 0 else None
            g = d_ * (1 - 3 / (4 * (len(a) + len(b)) - 9)) if d_ is not None else None
            rbc = 1 - 2 * u.statistic / (len(a) * len(b))
            name = "Student t-test" if equal_var else "Welch t-test"
            out.update(kind="two_groups", groups=desc, meanDifference=a.mean() - b.mean(), ciBootstrap=_boot_diff(a, b, rng),
                       ciMethod="percentile bootstrap" if len(a) + len(b) <= BOOTSTRAP_MAX_ROWS else "Welch normal interval (sample too large to need a bootstrap)",
                       effect={"cohen_d": d_, "hedges_g": g, "rank_biserial": rbc},
                       assumptions={"normality": norms, "levene": {"statistic": lev.statistic, "p": lev.pvalue, "equalVariances": bool(equal_var)}},
                       chosen={"test": name, "statistic": t.statistic, "p": t.pvalue} if use_param else {"test": "Mann–Whitney U", "statistic": u.statistic, "p": u.pvalue},
                       alternative={"test": "Mann–Whitney U", "p": u.pvalue} if use_param else {"test": name, "p": t.pvalue},
                       why=(f"Both groups look normal, so the {name}" + ("" if equal_var else " (variances differ, so Welch's version)") + ".") if use_param
                       else "At least one group isn't normal, so the rank-based Mann–Whitney test.")
        else:
            vals = list(groups.values())
            f = stats.f_oneway(*vals)
            welch = anova_oneway(vals, use_var="unequal")
            kw = stats.kruskal(*vals)
            allv = np.concatenate(vals)
            ss_b = sum(len(v) * (v.mean() - allv.mean()) ** 2 for v in vals)
            ss_t = ((allv - allv.mean()) ** 2).sum()
            k, n = len(vals), len(allv)
            ms_w = (ss_t - ss_b) / (n - k)
            eta2 = ss_b / ss_t if ss_t > 0 else None
            omega2 = (ss_b - (k - 1) * ms_w) / (ss_t + ms_w) if ss_t > 0 else None
            eps2 = kw.statistic / ((n ** 2 - 1) / (n + 1))
            if use_param:
                tk = pairwise_tukeyhsd(np.concatenate(vals), np.concatenate([[g] * len(v) for g, v in groups.items()]), alpha=p.alpha)
                posthoc = [{"a": str(r[0]), "b": str(r[1]), "meanDifference": float(r[2]), "pAdjusted": float(r[3]), "ci": [float(r[4]), float(r[5])], "significant": bool(r[6])}
                           for r in tk.summary().data[1:]]
                ph_name = "Tukey HSD"
            else:
                pairs = list(itertools.combinations(groups, 2))
                raw = [stats.mannwhitneyu(groups[x], groups[y]).pvalue for x, y in pairs]
                adj = multipletests(raw, method="holm")[1]
                posthoc = [{"a": x, "b": y, "p": r, "pAdjusted": a_, "significant": bool(a_ < p.alpha)} for (x, y), r, a_ in zip(pairs, raw, adj)]
                ph_name = "Pairwise Mann–Whitney, Holm-adjusted"
            name = "One-way ANOVA" if equal_var else "Welch ANOVA"
            pval = f.pvalue if equal_var else welch.pvalue
            out.update(kind="many_groups", groups=desc, effect={"eta_squared": eta2, "omega_squared": omega2, "epsilon_squared": eps2},
                       assumptions={"normality": norms, "levene": {"statistic": lev.statistic, "p": lev.pvalue, "equalVariances": bool(equal_var)}},
                       chosen={"test": name, "statistic": f.statistic if equal_var else welch.statistic, "p": pval} if use_param else {"test": "Kruskal–Wallis", "statistic": kw.statistic, "p": kw.pvalue},
                       alternative={"test": "Kruskal–Wallis", "p": kw.pvalue} if use_param else {"test": name, "p": pval},
                       posthoc={"method": ph_name, "pairs": posthoc},
                       why=(f"All groups look normal, so {name}" + ("" if equal_var else " (variances differ)") + f", then {ph_name}.") if use_param
                       else f"Not all groups are normal, so the rank-based Kruskal–Wallis test, then {ph_name}.")
    else:
        d = df[[p.a, p.b]].dropna().astype(str)
        table = pd.crosstab(d[p.a], d[p.b])
        need(table.shape[0] >= 2 and table.shape[1] >= 2, "Both columns need at least two categories.")
        need(table.shape[0] * table.shape[1] <= 2500, "Too many categories for a contingency table.")
        chi2, pv, dof, exp = stats.chi2_contingency(table, correction=table.shape == (2, 2))
        n = table.values.sum()
        v = np.sqrt(chi2 / (n * (min(table.shape) - 1)))
        low_expected = float((exp < 5).mean())
        fisher = stats.fisher_exact(table.values) if table.shape == (2, 2) else None
        use_fisher = fisher is not None and low_expected > 0.2
        resid = (table.values - exp) / np.sqrt(exp)
        out.update(kind="categorical", n=int(n), table={"rows": [str(x) for x in table.index], "columns": [str(x) for x in table.columns], "counts": table.values.tolist(), "expected": exp.tolist(), "standardisedResiduals": resid.tolist()},
                   effect={"cramers_v": v, **({"odds_ratio": fisher.statistic} if fisher else {})},
                   assumptions={"shareOfCellsExpectedBelow5": low_expected},
                   chosen={"test": "Fisher exact", "statistic": fisher.statistic, "p": fisher.pvalue} if use_fisher else {"test": "Chi-square test of independence", "statistic": chi2, "p": pv, "df": dof},
                   alternative={"test": "Chi-square", "p": pv} if use_fisher else ({"test": "Fisher exact", "p": fisher.pvalue} if fisher else None),
                   why="Many expected counts are below 5, so Fisher's exact test." if use_fisher else "Expected counts are large enough for the chi-square test.")
    pv = out["chosen"]["p"]
    out["significant"] = bool(pv is not None and pv < p.alpha)
    out["summary"] = f"{out['chosen']['test']}: {fmt_p(pv)} — {'a significant' if out['significant'] else 'no significant'} difference/association at α = {p.alpha}."
    return out


class CorrParams(BaseModel):
    columns: list[str] | None = None
    method: Literal["pearson", "spearman", "kendall"] = "pearson"
    partial_on: list[str] | None = Field(None, description="Control for these columns (partial correlation).")
    adjust: Literal["holm", "fdr_bh", "bonferroni", "none"] = "holm"
    max_rows: int = Field(500_000, ge=100, le=5_000_000)


@capability("stats.correlation_matrix", "stats", "Correlation matrix with p-values",
            "Pearson, Spearman or Kendall correlations between numeric columns, with p-values adjusted for multiple testing, confidence intervals, and optional partial correlations controlling for other columns.",
            CorrParams, tags=["correlation"])
def correlation_matrix(ctx, p: CorrParams):
    cols = p.columns or [c["name"] for c in ctx.columns() if c["type"] in NUMERIC]
    need(len(cols) >= 2, "Choose at least two numeric columns.")
    need(len(cols) <= 60, "At most 60 columns at once.")
    ctx.require(*cols, *(p.partial_on or []))
    df = ctx.frame(cols + [c for c in (p.partial_on or []) if c not in cols], max_rows=p.max_rows).apply(pd.to_numeric, errors="coerce").dropna()
    need(len(df) >= 5, "Too few complete rows.")
    data = df[cols]
    if p.partial_on:
        Z = np.column_stack([np.ones(len(df)), df[p.partial_on].to_numpy(float)])
        data = pd.DataFrame({c: df[c] - Z @ np.linalg.lstsq(Z, df[c].to_numpy(float), rcond=None)[0] for c in cols})
    k = len(cols)
    r = np.eye(k)
    pv = np.zeros((k, k))
    pairs = []
    for i in range(k):
        for j in range(i + 1, k):
            x, y = data.iloc[:, i].to_numpy(float), data.iloc[:, j].to_numpy(float)
            res = {"pearson": stats.pearsonr, "spearman": stats.spearmanr, "kendall": stats.kendalltau}[p.method](x, y)
            r[i, j] = r[j, i] = res.statistic
            pv[i, j] = pv[j, i] = res.pvalue
            pairs.append((i, j))
    raw = [pv[i, j] for i, j in pairs]
    adj = raw if p.adjust == "none" else list(multipletests(raw, method=p.adjust)[1])
    n = len(data) - len(p.partial_on or [])
    table = []
    for (i, j), a in zip(pairs, adj):
        z, se = np.arctanh(np.clip(r[i, j], -0.999999, 0.999999)), 1 / np.sqrt(max(n - 3, 1))
        table.append({"a": cols[i], "b": cols[j], "r": r[i, j], "p": pv[i, j], "pAdjusted": a, "ci": [np.tanh(z - 1.96 * se), np.tanh(z + 1.96 * se)]})
    table.sort(key=lambda x: -abs(x["r"]))
    return {"method": p.method, "partialOn": p.partial_on, "n": len(df), "columns": cols, "matrix": r.tolist(), "pairs": table, "adjustment": p.adjust}


class NormalityParams(BaseModel):
    column: str
    max_rows: int = Field(200_000, ge=20, le=5_000_000)


@capability("stats.normality", "stats", "Normality tests",
            "Shapiro–Wilk, D'Agostino–Pearson, Anderson–Darling and Jarque–Bera tests, skewness and kurtosis, and Q–Q plot points.",
            NormalityParams, tags=["assumptions"])
def normality(ctx, p: NormalityParams):
    ctx.require(p.column)
    x = pd.to_numeric(ctx.frame([p.column], max_rows=p.max_rows)[p.column], errors="coerce").dropna().to_numpy(float)
    need(len(x) >= 8, "Need at least 8 values.")
    s = x if len(x) <= 5000 else ctx.rng.choice(x, 5000, replace=False)
    sw = stats.shapiro(s)
    dp = stats.normaltest(x)
    ad = stats.anderson(x, dist="norm")
    jb = stats.jarque_bera(x)
    qs = np.linspace(0.005, 0.995, 100)
    theo = stats.norm.ppf(qs, loc=x.mean(), scale=x.std(ddof=1))
    return {"n": len(x), "skewness": stats.skew(x), "excessKurtosis": stats.kurtosis(x),
            "tests": [{"test": "Shapiro–Wilk" + (" (5,000-value sample)" if len(x) > 5000 else ""), "statistic": sw.statistic, "p": sw.pvalue},
                      {"test": "D'Agostino–Pearson", "statistic": dp.statistic, "p": dp.pvalue},
                      {"test": "Jarque–Bera", "statistic": jb.statistic, "p": jb.pvalue},
                      {"test": "Anderson–Darling", "statistic": ad.statistic, "criticalValues": dict(zip([f"{v}%" for v in ad.significance_level], ad.critical_values))}],
            "qq": [{"theoretical": t, "sample": v} for t, v in zip(theo, np.quantile(x, qs))],
            "note": "With large samples tiny departures become 'significant'; look at skewness, kurtosis and the Q–Q plot too."}


class NonparamParams(BaseModel):
    test: Literal["mann_whitney", "wilcoxon", "kruskal", "friedman", "sign", "ks_2samp", "anderson_ksamp", "mood_median", "permutation"]
    columns: list[str] = Field(..., min_length=1, description="Value column(s); for wilcoxon/friedman/sign: the repeated measures.")
    group: str | None = Field(None, description="Group column, for tests that compare groups of one value column.")
    alternative: Literal["two-sided", "less", "greater"] = "two-sided"
    permutations: int = Field(9999, ge=99, le=100_000)


@capability("stats.nonparametric", "stats", "Nonparametric tests",
            "Mann–Whitney, Wilcoxon, Kruskal–Wallis, Friedman, sign test, Kolmogorov–Smirnov, Anderson–Darling k-sample, Mood's median and a seeded permutation test.",
            NonparamParams, tags=["hypothesis", "robust"])
def nonparametric(ctx, p: NonparamParams):
    ctx.require(*p.columns, p.group)
    df = ctx.frame(p.columns + ([p.group] if p.group else []), max_rows=MAX_ROWS)
    if p.test in ("wilcoxon", "sign", "friedman"):
        d = df[p.columns].apply(pd.to_numeric, errors="coerce").dropna()
        if p.test == "friedman":
            need(len(p.columns) >= 3, "Friedman needs three or more repeated-measure columns.")
            r = stats.friedmanchisquare(*[d[c] for c in p.columns])
            return {"test": "Friedman", "statistic": r.statistic, "p": r.pvalue, "n": len(d)}
        need(len(p.columns) == 2, f"{p.test} needs exactly two columns.")
        if p.test == "wilcoxon":
            r = stats.wilcoxon(d[p.columns[0]], d[p.columns[1]], alternative=p.alternative)
            return {"test": "Wilcoxon signed-rank", "statistic": r.statistic, "p": r.pvalue, "n": len(d)}
        diff = d[p.columns[0]] - d[p.columns[1]]
        pos, nonzero = int((diff > 0).sum()), int((diff != 0).sum())
        r = stats.binomtest(pos, nonzero, 0.5, alternative=p.alternative)
        return {"test": "Sign test", "positive": pos, "nonZero": nonzero, "p": r.pvalue}
    need(p.group is not None, f"{p.test} compares groups: choose a group column.")
    d = df[[p.columns[0], p.group]].dropna()
    groups = [pd.to_numeric(g[p.columns[0]], errors="coerce").dropna().to_numpy(float) for _, g in d.groupby(p.group, sort=True)]
    labels = [str(k) for k, _ in d.groupby(p.group, sort=True)]
    need(len(groups) >= 2, "Need at least two groups.")
    two = groups[:2]
    if p.test == "mann_whitney":
        r = stats.mannwhitneyu(*two, alternative=p.alternative)
    elif p.test == "kruskal":
        r = stats.kruskal(*groups)
    elif p.test == "ks_2samp":
        r = stats.ks_2samp(*two, alternative=p.alternative)
    elif p.test == "anderson_ksamp":
        res = stats.anderson_ksamp(groups)
        return {"test": "Anderson–Darling k-sample", "statistic": res.statistic, "p": res.pvalue, "groups": labels}
    elif p.test == "mood_median":
        stat, pv, med, _ = stats.median_test(*groups)
        return {"test": "Mood's median test", "statistic": stat, "p": pv, "grandMedian": med, "groups": labels}
    else:
        need(len(groups) == 2, "The permutation test compares exactly two groups.")
        r = stats.permutation_test(two, lambda x, y: np.mean(x) - np.mean(y), n_resamples=p.permutations, alternative=p.alternative, random_state=ctx.seed)
        return {"test": "Permutation test (difference in means)", "statistic": r.statistic, "p": r.pvalue, "permutations": p.permutations, "groups": labels[:2]}
    return {"test": {"mann_whitney": "Mann–Whitney U", "kruskal": "Kruskal–Wallis", "ks_2samp": "Kolmogorov–Smirnov"}[p.test],
            "statistic": r.statistic, "p": r.pvalue, "groups": labels if p.test == "kruskal" else labels[:2]}


class MultiParams(BaseModel):
    p_values: list[float] = Field(..., min_length=1, max_length=100_000)
    labels: list[str] | None = None
    method: Literal["bonferroni", "holm", "hochberg", "sidak", "fdr_bh", "fdr_by", "hommel"] = "holm"
    alpha: float = Field(0.05, gt=0, lt=1)


@capability("stats.multiple_testing", "stats", "Adjust p-values for multiple tests",
            "Bonferroni, Holm, Hochberg, Šidák, Hommel, Benjamini–Hochberg and Benjamini–Yekutieli corrections.",
            MultiParams, needs_dataset=False, tags=["hypothesis"])
def multiple_testing(ctx, p: MultiParams):
    if any(not 0 <= x <= 1 for x in p.p_values):
        raise EngineError("P-values must be between 0 and 1.")
    reject, adj, _, _ = multipletests(p.p_values, alpha=p.alpha, method=p.method)
    labels = p.labels or [f"test {i + 1}" for i in range(len(p.p_values))]
    return {"method": p.method, "alpha": p.alpha, "rejected": int(reject.sum()),
            "results": [{"label": lab, "p": raw, "pAdjusted": a, "significant": bool(r)} for lab, raw, a, r in zip(labels, p.p_values, adj, reject)]}
