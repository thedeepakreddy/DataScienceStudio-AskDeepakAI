"""Statistical tests with effect sizes, confidence intervals and assumption checks.

Every function here takes plain Python/pandas inputs and returns a JSON-ready
dict. Numbers come from SciPy and NumPy; nothing is estimated or invented.
The Statistics step in the studio calls these through /stats/* endpoints.
"""

from __future__ import annotations

import math
from typing import Any, Literal

import numpy as np
import pandas as pd
import scipy.stats as st
from scipy.optimize import brentq

Alternative = Literal["two-sided", "less", "greater"]


class StatsError(ValueError):
    """A problem with the inputs, explained in plain words."""


def _f(x: Any, digits: int = 6) -> float | None:
    """A finite float rounded for JSON, or None."""
    try:
        v = float(x)
    except (TypeError, ValueError):
        return None
    if not math.isfinite(v):
        return None
    # Significant figures (at least 8), so small p-values keep their precision;
    # the studio rounds for display.
    return float(f"{v:.{max(digits, 8)}g}")


def _pf(p: Any) -> str:
    """A p-value for a sentence: "< 0.001" or three decimals."""
    v = _f(p)
    if v is None:
        return "—"
    return "< 0.001" if v < 0.001 else f"{v:.3f}"


def _describe(values: np.ndarray) -> dict[str, Any]:
    return {
        "n": int(len(values)),
        "mean": _f(np.mean(values)) if len(values) else None,
        "sd": _f(np.std(values, ddof=1)) if len(values) > 1 else None,
        "median": _f(np.median(values)) if len(values) else None,
    }


def _magnitude(value: float | None, small: float, medium: float, large: float) -> str:
    if value is None:
        return "unknown"
    v = abs(value)
    if v < small:
        return "negligible"
    if v < medium:
        return "small"
    if v < large:
        return "medium"
    return "large"


def _normality(values: np.ndarray, label: str) -> dict[str, Any]:
    n = len(values)
    if n < 3:
        return {"name": f"Normality of {label}", "passed": None, "detail": "Too few values to check (needs 3+)."}
    if np.ptp(values) == 0:
        return {"name": f"Normality of {label}", "passed": False, "detail": "All values are identical."}
    if n > 5000:
        sample = np.random.default_rng(0).choice(values, 5000, replace=False)
    else:
        sample = values
    _, p = st.shapiro(sample)
    passed = bool(p >= 0.05) or n >= 30
    detail = f"Shapiro–Wilk p = {_pf(p)}"
    if p < 0.05 and n >= 30:
        detail += "; not normal, but with 30+ values the test of means is usually still reliable."
    return {"name": f"Normality of {label}", "passed": passed, "pValue": _f(p, 6), "detail": detail}


def _numeric(series: pd.Series, name: str) -> pd.Series:
    out = pd.to_numeric(series, errors="coerce")
    if out.notna().sum() == 0:
        raise StatsError(f"“{name}” has no numbers.")
    return out


# ---------------------------------------------------------------------------
# Comparing groups / testing relationships
# ---------------------------------------------------------------------------

def compare(
    df: pd.DataFrame,
    column_a: str,
    column_b: str,
    *,
    paired: bool = False,
    alpha: float = 0.05,
    alternative: Alternative = "two-sided",
) -> dict[str, Any]:
    """Picks the right test from the two columns' types and runs it with the
    effect size, a confidence interval, assumption checks and a non-parametric
    alternative."""
    for c in (column_a, column_b):
        if c not in df.columns:
            raise StatsError(f"There is no column called “{c}”.")
    if column_a == column_b:
        raise StatsError("Choose two different columns.")
    if not 0 < alpha < 0.5:
        raise StatsError("The significance level must be between 0 and 0.5.")

    sub = df[[column_a, column_b]].dropna()
    if len(sub) < 4:
        raise StatsError("Need at least 4 rows where both columns have values.")

    a_num = pd.api.types.is_numeric_dtype(sub[column_a]) and not pd.api.types.is_bool_dtype(sub[column_a])
    b_num = pd.api.types.is_numeric_dtype(sub[column_b]) and not pd.api.types.is_bool_dtype(sub[column_b])

    if paired:
        if not (a_num and b_num):
            raise StatsError("A paired comparison needs two numeric columns measured on the same rows.")
        result = _paired(sub[column_a].to_numpy(float), sub[column_b].to_numpy(float), column_a, column_b, alpha, alternative)
    elif a_num and b_num:
        result = _correlation(sub[column_a].to_numpy(float), sub[column_b].to_numpy(float), column_a, column_b, alpha, alternative)
    elif a_num != b_num:
        value_col, group_col = (column_a, column_b) if a_num else (column_b, column_a)
        result = _groups(sub, value_col, group_col, alpha, alternative)
        result["valueColumn"], result["groupColumn"] = value_col, group_col
    else:
        if alternative != "two-sided":
            raise StatsError("A test between two categories is always two-sided.")
        result = _categories(sub, column_a, column_b, alpha)

    result["alpha"] = alpha
    result["alternative"] = alternative
    result["rowsUsed"] = int(len(sub))
    result["rowsDropped"] = int(len(df) - len(sub))
    return result


def _significance(p: float | None, alpha: float) -> bool:
    return p is not None and p < alpha


def _paired(a: np.ndarray, b: np.ndarray, na: str, nb: str, alpha: float, alt: Alternative) -> dict[str, Any]:
    d = a - b
    n = len(d)
    t, p = st.ttest_rel(a, b, alternative=alt)
    sd = np.std(d, ddof=1)
    dz = float(np.mean(d) / sd) if sd > 0 else None
    se = sd / math.sqrt(n)
    tcrit = st.t.ppf(1 - alpha / 2, n - 1)
    ci = [_f(np.mean(d) - tcrit * se), _f(np.mean(d) + tcrit * se)]
    assumptions = [_normality(d, f"the differences ({na} − {nb})")]
    try:
        w, pw = st.wilcoxon(a, b, alternative=alt)
        nonparam = {"test": "Wilcoxon signed-rank test", "statistic": _f(w, 4), "pValue": _f(pw), "significant": _significance(_f(pw), alpha)}
    except ValueError as err:
        nonparam = {"test": "Wilcoxon signed-rank test", "error": str(err)}
    return {
        "test": "Paired t-test",
        "family": "paired",
        "statistic": _f(t, 4), "statisticName": "t", "df": n - 1,
        "pValue": _f(p), "significant": _significance(_f(p), alpha),
        "estimate": {"name": f"Mean difference ({na} − {nb})", "value": _f(np.mean(d)), "ci": ci, "level": 1 - alpha},
        "effectSize": {"name": "Cohen’s dz", "value": _f(dz, 4), "magnitude": _magnitude(dz, 0.2, 0.5, 0.8)},
        "groups": [{"name": na, **_describe(a)}, {"name": nb, **_describe(b)}],
        "assumptions": assumptions,
        "nonParametric": nonparam,
        "recommendNonParametric": not all(x.get("passed") is not False for x in assumptions),
    }


def _fisher_ci(r: float, n: int, alpha: float) -> list[float | None]:
    if n <= 3 or abs(r) >= 1:
        return [None, None]
    z = np.arctanh(r)
    se = 1 / math.sqrt(n - 3)
    zc = st.norm.ppf(1 - alpha / 2)
    return [_f(np.tanh(z - zc * se), 4), _f(np.tanh(z + zc * se), 4)]


def _correlation(x: np.ndarray, y: np.ndarray, nx: str, ny: str, alpha: float, alt: Alternative) -> dict[str, Any]:
    n = len(x)
    if np.ptp(x) == 0 or np.ptp(y) == 0:
        raise StatsError("One of the columns has the same value in every row, so a correlation can’t be computed.")
    r, p = st.pearsonr(x, y, alternative=alt)
    rho, prho = st.spearmanr(x, y, alternative=alt)
    assumptions = [_normality(x, nx), _normality(y, ny)]
    return {
        "test": "Pearson correlation",
        "family": "correlation",
        "statistic": _f(r, 4), "statisticName": "r", "df": n - 2,
        "pValue": _f(p), "significant": _significance(_f(p), alpha),
        "estimate": {"name": "Correlation (r)", "value": _f(r, 4), "ci": _fisher_ci(float(r), n, alpha), "level": 1 - alpha},
        "effectSize": {"name": "r", "value": _f(r, 4), "magnitude": _magnitude(float(r), 0.1, 0.3, 0.5), "rSquared": _f(r * r, 4)},
        "groups": [{"name": nx, **_describe(x)}, {"name": ny, **_describe(y)}],
        "assumptions": assumptions,
        "nonParametric": {"test": "Spearman rank correlation", "statistic": _f(rho, 4), "statisticName": "ρ", "pValue": _f(prho), "significant": _significance(_f(prho), alpha)},
        "recommendNonParametric": any(a.get("passed") is False for a in assumptions),
    }


def _groups(sub: pd.DataFrame, value_col: str, group_col: str, alpha: float, alt: Alternative) -> dict[str, Any]:
    grouped = [(str(k), g[value_col].to_numpy(float)) for k, g in sub.groupby(group_col, sort=True)]
    grouped = [(k, v) for k, v in grouped if len(v) > 0]
    if len(grouped) < 2:
        raise StatsError(f"“{group_col}” needs at least 2 groups with values.")
    if len(grouped) > 30:
        raise StatsError(f"“{group_col}” has {len(grouped)} groups; choose a column with fewer categories.")
    small = [k for k, v in grouped if len(v) < 2]
    if small:
        raise StatsError(f"Every group needs at least 2 values; {', '.join(small[:3])} {'has' if len(small) == 1 else 'have'} fewer.")
    names = [k for k, _ in grouped]
    arrays = [v for _, v in grouped]
    descr = [{"name": k, **_describe(v)} for k, v in grouped]
    assumptions = [_normality(v, f"{value_col} in {k}") for k, v in grouped[:6]]
    if len(grouped) > 6:
        assumptions.append({"name": "Normality of the other groups", "passed": None, "detail": "Only the first 6 groups are checked."})
    lev, plev = st.levene(*arrays, center="median")
    equal_var = bool(plev >= 0.05)
    assumptions.append({
        "name": "Equal spread across groups", "passed": equal_var, "pValue": _f(plev),
        "detail": f"Levene p = {_pf(plev)}" + ("" if equal_var else "; Welch’s version is used, which doesn’t need equal spread."),
    })

    if len(grouped) == 2:
        a, b = arrays
        t, p = st.ttest_ind(a, b, equal_var=False, alternative=alt)
        va, vb, na, nb = np.var(a, ddof=1), np.var(b, ddof=1), len(a), len(b)
        se = math.sqrt(va / na + vb / nb)
        dfw = (va / na + vb / nb) ** 2 / ((va / na) ** 2 / (na - 1) + (vb / nb) ** 2 / (nb - 1)) if se > 0 else na + nb - 2
        tcrit = st.t.ppf(1 - alpha / 2, dfw)
        diff = float(np.mean(a) - np.mean(b))
        pooled = math.sqrt(((na - 1) * va + (nb - 1) * vb) / (na + nb - 2))
        d = diff / pooled if pooled > 0 else None
        g = d * (1 - 3 / (4 * (na + nb) - 9)) if d is not None else None
        u, pu = st.mannwhitneyu(a, b, alternative=alt)
        rank_biserial = 1 - 2 * u / (na * nb)
        return {
            "test": "Welch’s t-test",
            "family": "two-groups",
            "statistic": _f(t, 4), "statisticName": "t", "df": _f(dfw, 2),
            "pValue": _f(p), "significant": _significance(_f(p), alpha),
            "estimate": {"name": f"Difference in mean {value_col} ({names[0]} − {names[1]})", "value": _f(diff), "ci": [_f(diff - tcrit * se), _f(diff + tcrit * se)], "level": 1 - alpha},
            "effectSize": {"name": "Hedges’ g", "value": _f(g, 4), "magnitude": _magnitude(g, 0.2, 0.5, 0.8)},
            "groups": descr,
            "assumptions": assumptions,
            "nonParametric": {"test": "Mann–Whitney U test", "statistic": _f(u, 4), "statisticName": "U", "pValue": _f(pu), "significant": _significance(_f(pu), alpha), "effectSize": {"name": "Rank-biserial r", "value": _f(rank_biserial, 4)}},
            "recommendNonParametric": any(x.get("passed") is False and x["name"].startswith("Normality") for x in assumptions),
        }

    if alt != "two-sided":
        raise StatsError("Comparing 3+ groups is always two-sided.")
    # Welch's ANOVA (doesn't assume equal spread), plus classic ANOVA's eta squared.
    k = len(arrays)
    ns = np.array([len(v) for v in arrays], float)
    means = np.array([np.mean(v) for v in arrays])
    vars_ = np.array([np.var(v, ddof=1) for v in arrays])
    if np.any(vars_ == 0):
        f, p = st.f_oneway(*arrays)
        df1, df2 = k - 1, int(ns.sum() - k)
        test_name = "One-way ANOVA"
    else:
        w = ns / vars_
        mw = np.sum(w * means) / np.sum(w)
        a_term = np.sum(w * (means - mw) ** 2) / (k - 1)
        lam = np.sum((1 - w / np.sum(w)) ** 2 / (ns - 1))
        b_term = 1 + 2 * (k - 2) / (k ** 2 - 1) * lam
        f = a_term / b_term
        df1, df2 = k - 1, (k ** 2 - 1) / (3 * lam)
        p = st.f.sf(f, df1, df2)
        test_name = "Welch’s ANOVA"
    allv = np.concatenate(arrays)
    grand = np.mean(allv)
    ss_between = float(np.sum(ns * (means - grand) ** 2))
    ss_total = float(np.sum((allv - grand) ** 2))
    eta2 = ss_between / ss_total if ss_total > 0 else None
    ms_within = (ss_total - ss_between) / (len(allv) - k) if len(allv) > k else None
    omega2 = ((ss_between - (k - 1) * ms_within) / (ss_total + ms_within)) if ms_within is not None and ss_total > 0 else None
    h, ph = st.kruskal(*arrays)
    posthoc = []
    try:
        res = st.tukey_hsd(*arrays)
        ci = res.confidence_interval(confidence_level=1 - alpha)
        for i in range(k):
            for j in range(i + 1, k):
                posthoc.append({
                    "groups": [names[i], names[j]],
                    "difference": _f(means[i] - means[j]),
                    "ci": [_f(ci.low[i, j]), _f(ci.high[i, j])],
                    "pValue": _f(res.pvalue[i, j]),
                    "significant": _significance(_f(res.pvalue[i, j]), alpha),
                })
    except Exception:  # noqa: BLE001 - post-hoc is optional extra detail
        posthoc = []
    return {
        "test": test_name,
        "family": "many-groups",
        "statistic": _f(f, 4), "statisticName": "F", "df": [_f(df1, 2), _f(df2, 2)],
        "pValue": _f(p), "significant": _significance(_f(p), alpha),
        "effectSize": {"name": "Eta squared (η²)", "value": _f(eta2, 4), "magnitude": _magnitude(eta2, 0.01, 0.06, 0.14), "omegaSquared": _f(omega2, 4)},
        "groups": descr,
        "assumptions": assumptions,
        "nonParametric": {"test": "Kruskal–Wallis test", "statistic": _f(h, 4), "statisticName": "H", "pValue": _f(ph), "significant": _significance(_f(ph), alpha)},
        "postHoc": {"test": "Tukey HSD", "comparisons": posthoc},
        "recommendNonParametric": any(x.get("passed") is False and x["name"].startswith("Normality") for x in assumptions),
    }


def _categories(sub: pd.DataFrame, ca: str, cb: str, alpha: float) -> dict[str, Any]:
    table = pd.crosstab(sub[ca].astype(str), sub[cb].astype(str))
    if table.shape[0] < 2 or table.shape[1] < 2:
        raise StatsError(f"Both “{ca}” and “{cb}” need at least 2 different values.")
    if table.shape[0] * table.shape[1] > 400:
        raise StatsError("Too many combinations of categories to test; choose columns with fewer values.")
    chi2, p, dof, expected = st.chi2_contingency(table, correction=table.shape == (2, 2))
    n = int(table.to_numpy().sum())
    r, c = table.shape
    v = math.sqrt(chi2 / (n * (min(r, c) - 1))) if n > 0 else None
    low = float((expected < 5).mean())
    assumptions = [{
        "name": "Expected counts of 5 or more",
        "passed": bool(low <= 0.2 and expected.min() >= 1),
        "detail": f"{round(low * 100)}% of cells expect fewer than 5 rows (smallest {round(float(expected.min()), 2)})."
                  + ("" if low <= 0.2 else " The chi-squared p-value may be unreliable."),
    }]
    nonparam = None
    if table.shape == (2, 2):
        odds, pf = st.fisher_exact(table.to_numpy())
        nonparam = {"test": "Fisher’s exact test", "statistic": _f(odds, 4), "statisticName": "odds ratio", "pValue": _f(pf), "significant": _significance(_f(pf), alpha)}
    return {
        "test": "Chi-squared test of independence" + (" (with Yates’ correction)" if table.shape == (2, 2) else ""),
        "family": "categories",
        "statistic": _f(chi2, 4), "statisticName": "χ²", "df": int(dof),
        "pValue": _f(p), "significant": _significance(_f(p), alpha),
        "effectSize": {"name": "Cramér’s V", "value": _f(v, 4), "magnitude": _magnitude(v, 0.1, 0.3, 0.5)},
        "contingency": {"rows": [str(x) for x in table.index], "columns": [str(x) for x in table.columns], "counts": table.to_numpy().astype(int).tolist()},
        "assumptions": assumptions,
        "nonParametric": nonparam,
        "recommendNonParametric": nonparam is not None and not assumptions[0]["passed"],
    }


# ---------------------------------------------------------------------------
# Regression
# ---------------------------------------------------------------------------

def _design(df: pd.DataFrame, predictors: list[str]) -> tuple[np.ndarray, list[str], list[str]]:
    parts, names, notes = [], [], []
    for p in predictors:
        s = df[p]
        if pd.api.types.is_bool_dtype(s):
            parts.append(s.astype(float).to_numpy()[:, None])
            names.append(p)
        elif pd.api.types.is_numeric_dtype(s):
            parts.append(s.astype(float).to_numpy()[:, None])
            names.append(p)
        else:
            levels = sorted(s.astype(str).unique())
            if len(levels) > 20:
                raise StatsError(f"“{p}” has {len(levels)} categories; regression needs 20 or fewer per text column.")
            base, rest = levels[0], levels[1:]
            notes.append(f"“{p}” is compared against “{base}”.")
            for lvl in rest:
                parts.append((s.astype(str) == lvl).astype(float).to_numpy()[:, None])
                names.append(f"{p} = {lvl}")
    x = np.hstack([np.ones((len(df), 1)), *parts]) if parts else np.ones((len(df), 1))
    return x, ["(Intercept)", *names], notes


def regression(df: pd.DataFrame, outcome: str, predictors: list[str], kind: Literal["linear", "logistic"], alpha: float = 0.05) -> dict[str, Any]:
    if outcome not in df.columns:
        raise StatsError(f"There is no column called “{outcome}”.")
    if not predictors:
        raise StatsError("Choose at least one predictor.")
    missing = [p for p in predictors if p not in df.columns]
    if missing:
        raise StatsError(f"There is no column called “{missing[0]}”.")
    if outcome in predictors:
        raise StatsError("The outcome can’t also be a predictor.")
    sub = df[[outcome, *predictors]].dropna()
    notes: list[str] = []
    if kind == "linear":
        y = _numeric(sub[outcome], outcome).to_numpy(float)
    else:
        vals = sorted(sub[outcome].astype(str).unique())
        if len(vals) != 2:
            raise StatsError(f"Logistic regression needs an outcome with exactly 2 values; “{outcome}” has {len(vals)}.")
        positive = next((v for v in vals if v.lower() in ("1", "true", "yes")), vals[1])
        y = (sub[outcome].astype(str) == positive).astype(float).to_numpy()
        notes.append(f"Models the chance that “{outcome}” is “{positive}”.")
    x, names, design_notes = _design(sub, predictors)
    notes.extend(design_notes)
    n, k = x.shape
    if n <= k + 1:
        raise StatsError(f"Need more rows than predictors: {n} complete rows for {k - 1} predictor terms.")
    if np.linalg.matrix_rank(x) < k:
        raise StatsError("Some predictors are exact copies or combinations of others (perfect collinearity). Remove one.")
    return _ols(x, y, names, n, k, alpha, notes, outcome) if kind == "linear" else _logit(x, y, names, n, k, alpha, notes, outcome)


def _coef_table(names, beta, se, dist, df, alpha, transform=None):
    rows = []
    crit = dist.ppf(1 - alpha / 2, df) if df is not None else dist.ppf(1 - alpha / 2)
    for name, b, s in zip(names, beta, se):
        stat = b / s if s > 0 else float("nan")
        p = 2 * (dist.sf(abs(stat), df) if df is not None else dist.sf(abs(stat)))
        row = {"term": name, "estimate": _f(b), "se": _f(s), "statistic": _f(stat, 4), "pValue": _f(p),
               "ci": [_f(b - crit * s), _f(b + crit * s)], "significant": _significance(_f(p), alpha)}
        if transform:
            row["oddsRatio"] = _f(transform(b), 4)
            row["oddsRatioCi"] = [_f(transform(b - crit * s), 4), _f(transform(b + crit * s), 4)]
        rows.append(row)
    return rows


def _ols(x, y, names, n, k, alpha, notes, outcome):
    beta, *_ = np.linalg.lstsq(x, y, rcond=None)
    resid = y - x @ beta
    dof = n - k
    sigma2 = float(resid @ resid) / dof
    cov = sigma2 * np.linalg.inv(x.T @ x)
    se = np.sqrt(np.diag(cov))
    ss_tot = float(np.sum((y - y.mean()) ** 2))
    ss_res = float(resid @ resid)
    r2 = 1 - ss_res / ss_tot if ss_tot > 0 else None
    adj = 1 - (1 - r2) * (n - 1) / dof if r2 is not None else None
    f = ((ss_tot - ss_res) / (k - 1)) / (ss_res / dof) if k > 1 and ss_res > 0 else None
    pf = st.f.sf(f, k - 1, dof) if f is not None else None
    _, p_resid = st.shapiro(resid if n <= 5000 else np.random.default_rng(0).choice(resid, 5000, replace=False)) if n >= 3 else (None, None)
    return {
        "kind": "linear", "outcome": outcome, "n": n, "alpha": alpha,
        "coefficients": _coef_table(names, beta, se, st.t, dof, alpha),
        "fit": {"rSquared": _f(r2, 4), "adjRSquared": _f(adj, 4), "fStatistic": _f(f, 4), "fPValue": _f(pf), "df": [k - 1, dof], "residualSe": _f(math.sqrt(sigma2))},
        "assumptions": [{"name": "Normality of residuals", "passed": bool(p_resid is None or p_resid >= 0.05 or n >= 30), "pValue": _f(p_resid),
                         "detail": f"Shapiro–Wilk p = {_pf(p_resid)}" + (" (with 30+ rows the coefficient tests are usually still reliable)" if p_resid is not None and p_resid < 0.05 and n >= 30 else "")}],
        "notes": notes,
    }


def _logit(x, y, names, n, k, alpha, notes, outcome):
    beta = np.zeros(k)
    converged = False
    for _ in range(100):
        eta = np.clip(x @ beta, -30, 30)
        prob = 1 / (1 + np.exp(-eta))
        w = prob * (1 - prob)
        hess = x.T @ (x * w[:, None])
        grad = x.T @ (y - prob)
        try:
            step = np.linalg.solve(hess, grad)
        except np.linalg.LinAlgError as err:
            raise StatsError("The model couldn’t be fitted (the predictors separate the outcome perfectly or are collinear).") from err
        beta = beta + step
        if np.max(np.abs(step)) < 1e-8:
            converged = True
            break
    eta = np.clip(x @ beta, -30, 30)
    prob = 1 / (1 + np.exp(-eta))
    if not converged or np.max(np.abs(beta)) > 25:
        notes.append("The fit didn’t settle, which usually means a predictor separates the outcome almost perfectly; treat these estimates with caution.")
    cov = np.linalg.inv(x.T @ (x * (prob * (1 - prob))[:, None]))
    se = np.sqrt(np.diag(cov))
    ll = float(np.sum(y * np.log(np.clip(prob, 1e-15, 1)) + (1 - y) * np.log(np.clip(1 - prob, 1e-15, 1))))
    p0 = y.mean()
    ll0 = float(len(y) * (p0 * math.log(p0) + (1 - p0) * math.log(1 - p0))) if 0 < p0 < 1 else 0.0
    lr = 2 * (ll - ll0)
    acc = float(np.mean((prob >= 0.5) == (y == 1)))
    return {
        "kind": "logistic", "outcome": outcome, "n": n, "alpha": alpha,
        "coefficients": _coef_table(names, beta, se, st.norm, None, alpha, transform=math.exp),
        "fit": {"pseudoRSquared": _f(1 - ll / ll0, 4) if ll0 != 0 else None, "logLikelihood": _f(ll, 4),
                "lrStatistic": _f(lr, 4), "lrPValue": _f(st.chi2.sf(lr, k - 1)), "df": [k - 1],
                "accuracy": _f(acc, 4), "baseRate": _f(max(p0, 1 - p0), 4)},
        "assumptions": [],
        "converged": converged,
        "notes": notes,
    }


# ---------------------------------------------------------------------------
# Power and sample size
# ---------------------------------------------------------------------------

PowerTest = Literal["two-sample-t", "paired-t", "anova", "correlation", "two-proportions"]


def _power(test: PowerTest, effect: float, n: float, alpha: float, groups: int = 3, alternative: Alternative = "two-sided") -> float:
    tails = 2 if alternative == "two-sided" else 1
    if test == "two-sample-t":
        df = 2 * n - 2
        nc = effect * math.sqrt(n / 2)
    elif test == "paired-t":
        df = n - 1
        nc = effect * math.sqrt(n)
    elif test == "anova":
        df1, df2 = groups - 1, groups * (n - 1)
        crit = st.f.isf(alpha, df1, df2)
        return float(st.ncf.sf(crit, df1, df2, effect ** 2 * groups * n))
    elif test == "correlation":
        z = math.atanh(effect) * math.sqrt(n - 3)
        zc = st.norm.isf(alpha / tails)
        return float(st.norm.sf(zc - abs(z)) + (st.norm.cdf(-zc - abs(z)) if tails == 2 else 0))
    else:  # two-proportions, Cohen's h
        z = abs(effect) * math.sqrt(n / 2)
        zc = st.norm.isf(alpha / tails)
        return float(st.norm.sf(zc - z) + (st.norm.cdf(-zc - z) if tails == 2 else 0))
    crit = st.t.isf(alpha / tails, df)
    upper = st.nct.sf(crit, df, abs(nc))
    lower = st.nct.cdf(-crit, df, abs(nc)) if tails == 2 else 0.0
    return float(upper + lower)


def power_analysis(test: PowerTest, effect: float, alpha: float = 0.05, power: float | None = None, n: float | None = None,
                   groups: int = 3, alternative: Alternative = "two-sided") -> dict[str, Any]:
    if effect is None or effect == 0 or not math.isfinite(effect):
        raise StatsError("Enter a non-zero effect size.")
    if test == "correlation" and not -1 < effect < 1:
        raise StatsError("A correlation must be between −1 and 1.")
    if not 0 < alpha < 0.5:
        raise StatsError("The significance level must be between 0 and 0.5.")
    if (power is None) == (n is None):
        raise StatsError("Give either the target power (to find the sample size) or the sample size (to find the power).")
    minimum = {"two-sample-t": 2, "paired-t": 2, "anova": 2, "correlation": 4, "two-proportions": 2}[test]
    if n is not None:
        if n < minimum:
            raise StatsError(f"The sample size must be at least {minimum}.")
        return {"test": test, "effect": effect, "alpha": alpha, "n": n, "power": _f(_power(test, effect, n, alpha, groups, alternative), 4), "solvedFor": "power"}
    if not 0 < power < 1:
        raise StatsError("Power must be between 0 and 1.")
    f = lambda m: _power(test, effect, m, alpha, groups, alternative) - power  # noqa: E731
    hi = 10.0
    while f(hi) < 0:
        hi *= 2
        if hi > 1e8:
            raise StatsError("That effect is too small to detect with any realistic sample.")
    lo = float(minimum)
    if f(lo) >= 0:
        needed = lo
    else:
        needed = brentq(f, lo, hi, xtol=1e-6)
    per = math.ceil(needed - 1e-9)
    unit = {"two-sample-t": "per group", "paired-t": "pairs", "anova": "per group", "correlation": "in total", "two-proportions": "per group"}[test]
    return {"test": test, "effect": effect, "alpha": alpha, "power": power, "n": per, "nExact": _f(needed, 3),
            "achievedPower": _f(_power(test, effect, per, alpha, groups, alternative), 4), "unit": unit, "solvedFor": "n"}
