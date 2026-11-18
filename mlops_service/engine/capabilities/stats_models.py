"""Statistical models: GLMs, ANOVA/ANCOVA, mixed effects, robust and quantile regression,
bootstrap confidence intervals and power analysis.

Models are fitted with statsmodels through formulas. Columns are renamed to
safe internal names for the formula and named back in every output, so any
column name works.
"""
from __future__ import annotations

import re
from typing import Literal

import numpy as np
import pandas as pd
import statsmodels.api as sm
import statsmodels.formula.api as smf
from pydantic import BaseModel, Field
from scipy import stats
from statsmodels.stats import power as smp
from statsmodels.stats.anova import anova_lm
from statsmodels.stats.diagnostic import het_breuschpagan
from statsmodels.stats.multicomp import pairwise_tukeyhsd
from statsmodels.stats.outliers_influence import variance_inflation_factor
from statsmodels.stats.stattools import durbin_watson

from ..registry import capability
from ._util import NUMERIC, need

MAX_ROWS = 1_000_000


class _Frame:
    """The data for a formula model, with safe column names."""

    def __init__(self, ctx, outcome: str | None, predictors: list[str], extra: list[str] | None = None,
                 categorical: list[str] | None = None, max_rows: int = MAX_ROWS) -> None:
        cols = list(dict.fromkeys([c for c in [outcome, *predictors, *(extra or [])] if c]))
        ctx.require(*cols)
        types = {c["name"]: c["type"] for c in ctx.columns()}
        df = ctx.frame(cols, max_rows=max_rows)
        self.safe = {c: f"v{i}" for i, c in enumerate(cols)}
        self.back = {v: k for k, v in self.safe.items()}
        self.cat = {c for c in cols if c != outcome and (types[c] not in NUMERIC or c in (categorical or []))}
        d = pd.DataFrame({self.safe[c]: df[c] for c in cols})
        for c in cols:
            if c in self.cat:
                d[self.safe[c]] = d[self.safe[c]].astype("string")
            elif c != outcome or types[c] in NUMERIC:
                d[self.safe[c]] = pd.to_numeric(d[self.safe[c]], errors="coerce")
        before = len(d)
        self.df = d.dropna()
        self.dropped = before - len(self.df)
        if self.dropped:
            ctx.note(f"Left out {self.dropped:,} row(s) with missing values.")
        self.outcome = outcome

    def term(self, c: str) -> str:
        return f"C({self.safe[c]})" if c in self.cat else self.safe[c]

    def rhs(self, predictors: list[str], interactions: list[list[str]] | None = None) -> str:
        parts = [self.term(c) for c in predictors]
        for pair in interactions or []:
            parts.append(":".join(self.term(c) for c in pair))
        return " + ".join(parts) if parts else "1"

    def name(self, term: str) -> str:
        """Turns an internal term like C(v2)[T.b]:v3 into readable names."""
        def sub(m):
            return self.back.get(m.group(0), m.group(0))
        t = re.sub(r"C\((v\d+)\)\[T\.([^\]]*)\]", lambda m: f"{self.back[m.group(1)]} = {m.group(2)}", term)
        t = re.sub(r"C\((v\d+)\)", lambda m: self.back[m.group(1)], t)
        return re.sub(r"\bv\d+\b", sub, t)


def _coef_table(fr: _Frame, res, alpha: float, exp: bool = False) -> list[dict]:
    ci = res.conf_int(alpha=alpha)
    out = []
    for term in res.params.index:
        row = {"term": fr.name(term), "estimate": res.params[term], "se": res.bse[term], "statistic": res.tvalues[term],
               "p": res.pvalues[term], "ci": [ci.loc[term, 0], ci.loc[term, 1]]}
        if exp:
            row.update(expEstimate=float(np.exp(res.params[term])), expCi=[float(np.exp(ci.loc[term, 0])), float(np.exp(ci.loc[term, 1]))])
        out.append(row)
    return out


FAMILIES = {
    "gaussian": lambda link: sm.families.Gaussian(link),
    "binomial": lambda link: sm.families.Binomial(link),
    "poisson": lambda link: sm.families.Poisson(link),
    "negative_binomial": lambda link: sm.families.NegativeBinomial(link),
    "gamma": lambda link: sm.families.Gamma(link),
    "inverse_gaussian": lambda link: sm.families.InverseGaussian(link),
    "tweedie": lambda link: sm.families.Tweedie(link, var_power=1.5),
}
LINKS = {"identity": sm.families.links.Identity, "log": sm.families.links.Log, "logit": sm.families.links.Logit,
         "probit": sm.families.links.Probit, "cloglog": sm.families.links.CLogLog, "inverse": sm.families.links.InversePower, "sqrt": sm.families.links.Sqrt}


class GlmParams(BaseModel):
    outcome: str
    predictors: list[str] = Field(..., min_length=1, max_length=200)
    family: Literal["gaussian", "binomial", "poisson", "negative_binomial", "gamma", "inverse_gaussian", "tweedie"] = "gaussian"
    link: Literal["default", "identity", "log", "logit", "probit", "cloglog", "inverse", "sqrt"] = "default"
    categorical: list[str] | None = Field(None, description="Numeric columns to treat as categories.")
    interactions: list[list[str]] | None = None
    weights: str | None = None
    offset: str | None = Field(None, description="A column of log-exposure (for rates).")
    robust: Literal["none", "hc3", "cluster"] = "none"
    cluster: str | None = None
    success: str | None = Field(None, description="For a binomial outcome that isn't 0/1: the value that counts as success.")
    alpha: float = Field(0.05, gt=0, lt=0.5)


@capability("stats.glm", "stats", "Generalised linear model",
            "Linear, logistic, probit, Poisson, negative binomial, gamma, inverse-Gaussian and Tweedie regression, with categorical predictors, interactions, weights, offsets, robust or clustered standard errors, odds/rate ratios, fit statistics and diagnostics (VIF, influence, heteroskedasticity, autocorrelation).",
            GlmParams, heavy=True, tags=["regression", "inference"])
def glm(ctx, p: GlmParams):
    extra = [x for x in [p.weights, p.offset, p.cluster] if x]
    fr = _Frame(ctx, p.outcome, p.predictors, extra, p.categorical)
    y = fr.safe[p.outcome]
    if p.family == "binomial":
        vals = fr.df[y]
        if not set(pd.unique(vals.dropna())) <= {0, 1, 0.0, 1.0, True, False}:
            need(p.success is not None or vals.nunique() == 2, "A binomial outcome needs two values; say which one is success.")
            succ = p.success if p.success is not None else sorted(vals.astype(str).unique())[-1]
            fr.df[y] = (vals.astype(str) == str(succ)).astype(float)
            ctx.note(f"Modelled the probability that {p.outcome} = {succ}.")
        else:
            fr.df[y] = vals.astype(float)
    need(len(fr.df) > len(p.predictors) + 2, "Too few complete rows for this many predictors.")
    link = None if p.link == "default" else LINKS[p.link]()
    family = FAMILIES[p.family](link)
    formula = f"{y} ~ {fr.rhs(p.predictors, p.interactions)}"
    kw = {}
    if p.weights:
        kw["freq_weights"] = fr.df[fr.safe[p.weights]]
    if p.offset:
        kw["offset"] = fr.df[fr.safe[p.offset]]
    model = smf.glm(formula, fr.df, family=family, **kw)
    if p.robust == "cluster":
        need(p.cluster is not None, "Clustered standard errors need a cluster column.")
        res = model.fit(cov_type="cluster", cov_kwds={"groups": pd.factorize(fr.df[fr.safe[p.cluster]])[0]})
    elif p.robust == "hc3":
        res = model.fit(cov_type="HC3")
    else:
        res = model.fit()
    exp = p.family in ("binomial", "poisson", "negative_binomial") or (p.link in ("log", "logit"))
    llnull = res.llnull
    out = {"family": p.family, "link": type(family.link).__name__, "n": int(res.nobs), "formula": fr.name(formula),
           "coefficients": _coef_table(fr, res, p.alpha, exp), "expMeaning": ("odds ratio" if p.family == "binomial" else "rate ratio") if exp else None,
           "fit": {"aic": res.aic, "bic": res.bic_llf, "deviance": res.deviance, "nullDeviance": res.null_deviance, "logLik": res.llf,
                   "pseudoR2McFadden": 1 - res.llf / llnull if llnull else None, "pearsonChi2": res.pearson_chi2, "dfResid": res.df_resid,
                   "dispersion": res.scale},
           "robust": p.robust}
    X = model.exog
    if X.shape[1] > 2:
        names = model.exog_names
        out["vif"] = [{"term": fr.name(names[i]), "vif": float(variance_inflation_factor(X, i))} for i in range(1, X.shape[1])]
    infl = res.get_influence()
    cooks = infl.cooks_distance[0]
    top = np.argsort(-np.nan_to_num(cooks))[:10]
    out["influential"] = [{"row": int(fr.df.index[i]), "cooksDistance": float(cooks[i])} for i in top if cooks[i] > 4 / len(cooks)]
    resid = res.resid_deviance
    out["diagnostics"] = {"durbinWatson": durbin_watson(resid)}
    if p.family == "gaussian":
        bp = het_breuschpagan(res.resid_response, X)
        out["diagnostics"].update(breuschPagan={"statistic": bp[0], "p": bp[1]}, residualsNormal=stats.normaltest(resid).pvalue if len(resid) >= 8 else None,
                                  r2=1 - (res.resid_response ** 2).sum() / ((fr.df[y] - fr.df[y].mean()) ** 2).sum())
    if p.family in ("poisson",):
        ratio = res.pearson_chi2 / res.df_resid
        out["diagnostics"]["overdispersion"] = ratio
        if ratio > 1.5:
            ctx.note(f"The data are overdispersed (ratio {ratio:.2f}); a negative binomial model may fit better.")
    pred = res.predict()
    take = np.linspace(0, len(pred) - 1, min(500, len(pred))).astype(int)
    out["predictedVsActual"] = [{"predicted": float(pred[i]), "actual": float(fr.df[y].iloc[i])} for i in take]
    return out


class AnovaParams(BaseModel):
    outcome: str
    factors: list[str] = Field(..., min_length=1, max_length=4)
    covariates: list[str] | None = Field(None, description="Numeric covariates (ANCOVA).")
    interactions: bool = True
    type: Literal[1, 2, 3] = 2
    posthoc: bool = True
    alpha: float = Field(0.05, gt=0, lt=0.5)


@capability("stats.anova", "stats", "ANOVA / ANCOVA",
            "One-, two- and multi-way ANOVA with interactions and covariates (ANCOVA), type I/II/III sums of squares, eta², partial eta² and omega², assumption checks and Tukey post-hoc tests.",
            AnovaParams, tags=["anova", "inference"])
def anova(ctx, p: AnovaParams):
    fr = _Frame(ctx, p.outcome, p.factors + (p.covariates or []), categorical=p.factors)
    y = fr.safe[p.outcome]
    fac = [fr.term(f) for f in p.factors]
    rhs = (" * ".join(fac) if p.interactions and len(fac) > 1 else " + ".join(fac))
    if p.covariates:
        rhs += " + " + " + ".join(fr.safe[c] for c in p.covariates)
    if p.type == 3:
        fac_sum = [f"C({fr.safe[f]}, Sum)" for f in p.factors]
        rhs = (" * ".join(fac_sum) if p.interactions and len(fac_sum) > 1 else " + ".join(fac_sum)) + ("".join(f" + {fr.safe[c]}" for c in p.covariates or []))
    res = smf.ols(f"{y} ~ {rhs}", fr.df).fit()
    table = anova_lm(res, typ=p.type)
    ss_res = table.loc["Residual", "sum_sq"]
    ss_tot = ((fr.df[y] - fr.df[y].mean()) ** 2).sum()
    ms_res = ss_res / table.loc["Residual", "df"]
    rows = []
    for term, r in table.iterrows():
        if term in ("Residual", "Intercept"):
            continue
        name = fr.name(re.sub(r", Sum\)", ")", term))
        rows.append({"term": name, "sumSq": r["sum_sq"], "df": r["df"], "F": r["F"], "p": r["PR(>F)"],
                     "etaSquared": r["sum_sq"] / ss_tot, "partialEtaSquared": r["sum_sq"] / (r["sum_sq"] + ss_res),
                     "omegaSquared": (r["sum_sq"] - r["df"] * ms_res) / (ss_tot + ms_res)})
    groups = fr.df.groupby([fr.safe[f] for f in p.factors])[y]
    lev = stats.levene(*[g.to_numpy() for _, g in groups if len(g) > 1], center="median") if groups.ngroups > 1 else None
    out = {"n": int(res.nobs), "type": p.type, "table": rows, "r2": res.rsquared, "adjR2": res.rsquared_adj,
           "assumptions": {"levene": {"statistic": lev.statistic, "p": lev.pvalue} if lev else None,
                           "residualsNormalP": stats.normaltest(res.resid).pvalue if len(res.resid) >= 8 else None},
           "cellMeans": [{"cell": k if isinstance(k, str) else " × ".join(map(str, k)), "mean": g.mean(), "sd": g.std(), "n": len(g)} for k, g in groups]}
    if p.posthoc:
        out["posthoc"] = {}
        for f in p.factors:
            tk = pairwise_tukeyhsd(fr.df[y], fr.df[fr.safe[f]], alpha=p.alpha)
            out["posthoc"][f] = [{"a": str(r[0]), "b": str(r[1]), "meanDifference": float(r[2]), "pAdjusted": float(r[3]), "ci": [float(r[4]), float(r[5])], "significant": bool(r[6])}
                                 for r in tk.summary().data[1:]]
    return out


class MixedParams(BaseModel):
    outcome: str
    predictors: list[str] = Field(default_factory=list)
    group: str = Field(..., description="The grouping (random effect) column, e.g. school or patient.")
    random_slopes: list[str] | None = None
    categorical: list[str] | None = None
    reml: bool = True
    alpha: float = Field(0.05, gt=0, lt=0.5)


@capability("stats.mixed", "stats", "Mixed-effects model",
            "Linear mixed model with a random intercept (and optional random slopes) per group — for repeated measures, students within schools, etc. — with the intraclass correlation.",
            MixedParams, heavy=True, tags=["regression", "multilevel"])
def mixed(ctx, p: MixedParams):
    fr = _Frame(ctx, p.outcome, p.predictors, [p.group, *(p.random_slopes or [])], p.categorical)
    y = fr.safe[p.outcome]
    need(fr.df[fr.safe[p.group]].nunique() >= 3, "A mixed model needs at least three groups.")
    re_formula = "~" + " + ".join(fr.safe[s] for s in p.random_slopes) if p.random_slopes else None
    model = smf.mixedlm(f"{y} ~ {fr.rhs(p.predictors)}", fr.df, groups=fr.df[fr.safe[p.group]].astype(str), re_formula=re_formula)
    res, last_err = None, None
    # Some optimisers hit numerical trouble on some data; try the next one.
    for method in ("bfgs", "powell", "nm", "lbfgs"):
        try:
            res = model.fit(reml=p.reml, method=method)
            if res.converged:
                break
        except (np.linalg.LinAlgError, ValueError) as err:
            last_err = err
    need(res is not None, f"The mixed model didn't fit: {last_err}")
    fe = res.fe_params.index
    ci = res.conf_int(alpha=p.alpha)
    coefs = [{"term": fr.name(t), "estimate": res.params[t], "se": res.bse[t], "z": res.tvalues[t], "p": res.pvalues[t], "ci": [ci.loc[t, 0], ci.loc[t, 1]]} for t in fe]
    var_group = float(res.cov_re.iloc[0, 0])
    var_resid = float(res.scale)
    return {"n": int(res.nobs), "groups": int(fr.df[fr.safe[p.group]].nunique()), "fixedEffects": coefs,
            "randomEffects": {"groupVariance": var_group, "residualVariance": var_resid, "covariance": res.cov_re.values.tolist()},
            "icc": var_group / (var_group + var_resid) if var_group + var_resid > 0 else None,
            "fit": {"logLik": res.llf, "aic": res.aic if np.isfinite(res.aic) else None, "converged": bool(res.converged), "reml": p.reml}}


class RobustParams(BaseModel):
    outcome: str
    predictors: list[str] = Field(..., min_length=1)
    method: Literal["huber", "tukey_biweight", "quantile"] = "huber"
    quantiles: list[float] = Field(default_factory=lambda: [0.1, 0.5, 0.9])
    categorical: list[str] | None = None
    alpha: float = Field(0.05, gt=0, lt=0.5)


@capability("stats.robust_regression", "stats", "Robust and quantile regression",
            "Regression that resists outliers (Huber or Tukey biweight M-estimation) or models chosen quantiles (e.g. median, 10th and 90th percentiles) instead of the mean.",
            RobustParams, tags=["regression", "robust"])
def robust_regression(ctx, p: RobustParams):
    fr = _Frame(ctx, p.outcome, p.predictors, categorical=p.categorical)
    formula = f"{fr.safe[p.outcome]} ~ {fr.rhs(p.predictors)}"
    if p.method == "quantile":
        need(all(0 < x < 1 for x in p.quantiles), "Quantiles must be between 0 and 1.")
        fits = []
        for qv in p.quantiles:
            res = smf.quantreg(formula, fr.df).fit(q=qv)
            fits.append({"quantile": qv, "coefficients": _coef_table(fr, res, p.alpha), "pseudoR2": res.prsquared})
        ols = smf.ols(formula, fr.df).fit()
        return {"method": "quantile", "n": len(fr.df), "fits": fits, "ols": _coef_table(fr, ols, p.alpha)}
    norm = sm.robust.norms.HuberT() if p.method == "huber" else sm.robust.norms.TukeyBiweight()
    res = smf.rlm(formula, fr.df, M=norm).fit()
    ols = smf.ols(formula, fr.df).fit()
    w = res.weights
    return {"method": p.method, "n": len(fr.df), "coefficients": _coef_table(fr, res, p.alpha), "ols": _coef_table(fr, ols, p.alpha),
            "downweightedRows": int((w < 0.99).sum()), "lowestWeights": [{"row": int(fr.df.index[i]), "weight": float(w[i])} for i in np.argsort(w)[:10]]}


class BootstrapParams(BaseModel):
    statistic: Literal["mean", "median", "std", "quantile", "trimmed_mean", "correlation", "mean_difference", "median_difference", "ratio_of_means"]
    column: str
    other: str | None = Field(None, description="Second column (correlation, ratio) or group column (differences).")
    quantile: float = Field(0.5, gt=0, lt=1)
    resamples: int = Field(5000, ge=200, le=100_000)
    confidence: float = Field(0.95, gt=0.5, lt=1)
    method: Literal["BCa", "percentile", "basic"] = "BCa"
    max_rows: int = Field(200_000, ge=100, le=2_000_000)


@capability("stats.bootstrap", "stats", "Bootstrap confidence interval",
            "A seeded bootstrap confidence interval (BCa, percentile or basic) for a mean, median, standard deviation, quantile, trimmed mean, correlation, ratio, or a difference between two groups.",
            BootstrapParams, heavy=True, tags=["inference", "resampling"])
def bootstrap(ctx, p: BootstrapParams):
    ctx.require(p.column, p.other)
    df = ctx.frame([p.column] + ([p.other] if p.other else []), max_rows=p.max_rows)
    x = pd.to_numeric(df[p.column], errors="coerce")
    fns = {"mean": np.mean, "median": np.median, "std": lambda a, axis=-1: np.std(a, ddof=1, axis=axis),
           "quantile": lambda a, axis=-1: np.quantile(a, p.quantile, axis=axis), "trimmed_mean": lambda a, axis=-1: stats.trim_mean(a, 0.1, axis=axis)}
    if p.statistic in fns:
        data = (x.dropna().to_numpy(float),)
        fn = fns[p.statistic]
        estimate = fn(data[0])
        paired = False
    elif p.statistic in ("correlation", "ratio_of_means"):
        need(p.other is not None, "Choose the second column.")
        d = pd.DataFrame({"x": x, "y": pd.to_numeric(df[p.other], errors="coerce")}).dropna()
        data = (d["x"].to_numpy(float), d["y"].to_numpy(float))
        fn = (lambda a, b, axis=-1: np.array([np.corrcoef(a[i], b[i])[0, 1] for i in range(a.shape[0])]) if a.ndim > 1 else np.corrcoef(a, b)[0, 1]) \
            if p.statistic == "correlation" else (lambda a, b, axis=-1: np.mean(a, axis=axis) / np.mean(b, axis=axis))
        estimate = fn(*data)
        paired = True
    else:
        need(p.other is not None, "Choose the group column.")
        d = pd.DataFrame({"x": x, "g": df[p.other]}).dropna()
        groups = [g["x"].to_numpy(float) for _, g in d.groupby("g", sort=True)]
        labels = [str(k) for k, _ in d.groupby("g", sort=True)]
        need(len(groups) == 2, "Differences need a group column with exactly two groups.")
        base = np.mean if p.statistic == "mean_difference" else np.median
        data = tuple(groups)
        fn = lambda a, b, axis=-1: base(a, axis=axis) - base(b, axis=axis)  # noqa: E731
        estimate = fn(*data)
        paired = False
        ctx.note(f"Difference = {labels[0]} − {labels[1]}.")
    res = stats.bootstrap(data, fn, n_resamples=p.resamples, confidence_level=p.confidence, method=p.method,
                          random_state=ctx.seed, paired=paired, vectorized=p.statistic != "correlation",
                          batch=max(1, 20_000_000 // max(1, sum(len(a) for a in data))))  # bounded memory on big data
    dist = res.bootstrap_distribution
    return {"statistic": p.statistic, "estimate": estimate, "ci": [res.confidence_interval.low, res.confidence_interval.high],
            "confidence": p.confidence, "method": p.method, "resamples": p.resamples, "standardError": res.standard_error,
            "distribution": np.histogram(dist[np.isfinite(dist)], bins=40)[0].tolist(), "distributionRange": [float(np.nanmin(dist)), float(np.nanmax(dist))]}


class PowerParams(BaseModel):
    test: Literal["t_two_sample", "t_paired", "t_one_sample", "proportions", "anova", "chi_square", "correlation"]
    effect_size: float | None = Field(None, gt=0, description="Cohen's d / h / f / w, or r for correlation.")
    n: float | None = Field(None, gt=1, description="Per group (or total for chi-square, correlation and one-sample).")
    power: float | None = Field(None, gt=0, lt=1)
    alpha: float = Field(0.05, gt=0, lt=0.5)
    groups: int = Field(3, ge=2, le=50)
    df: int = Field(1, ge=1, le=1000)
    ratio: float = Field(1.0, gt=0)
    alternative: Literal["two-sided", "larger", "smaller"] = "two-sided"


@capability("stats.power", "stats", "Power and sample size",
            "Solves for whichever of sample size, power or detectable effect size is left blank, for t-tests, proportions, ANOVA, chi-square and correlation, with a power curve.",
            PowerParams, needs_dataset=False, tags=["design"])
def power(ctx, p: PowerParams):
    blanks = [k for k in ("effect_size", "n", "power") if getattr(p, k) is None]
    need(len(blanks) == 1, "Leave exactly one of effect_size, n and power blank to solve for it.")
    alt = p.alternative

    def solve(es, n, pw):
        if p.test in ("t_two_sample",):
            return smp.TTestIndPower().solve_power(effect_size=es, nobs1=n, alpha=p.alpha, power=pw, ratio=p.ratio, alternative=alt)
        if p.test in ("t_paired", "t_one_sample"):
            return smp.TTestPower().solve_power(effect_size=es, nobs=n, alpha=p.alpha, power=pw, alternative=alt)
        if p.test == "proportions":
            return smp.NormalIndPower().solve_power(effect_size=es, nobs1=n, alpha=p.alpha, power=pw, ratio=p.ratio, alternative=alt)
        if p.test == "anova":
            return smp.FTestAnovaPower().solve_power(effect_size=es, nobs=None if n is None else n * p.groups, alpha=p.alpha, power=pw, k_groups=p.groups)
        if p.test == "chi_square":
            return smp.GofChisquarePower().solve_power(effect_size=es, nobs=n, alpha=p.alpha, power=pw, n_bins=p.df + 1)
        # correlation via Fisher z
        if es is not None:
            es = float(np.arctanh(es)) * 1.0
        zc = stats.norm.ppf(1 - p.alpha / (2 if alt == "two-sided" else 1))
        if n is None:
            return ((zc + stats.norm.ppf(pw)) / es) ** 2 + 3
        if pw is None:
            return float(stats.norm.cdf(es * np.sqrt(n - 3) - zc))
        return float(np.tanh((zc + stats.norm.ppf(pw)) / np.sqrt(n - 3)))

    value = float(np.squeeze(solve(p.effect_size, p.n, p.power)))
    if p.test == "anova" and blanks[0] == "n":
        value = value / p.groups
    solved = {"effect_size": p.effect_size, "n": p.n, "power": p.power, blanks[0]: value}
    curve = []
    if solved["effect_size"]:
        for n in np.unique(np.linspace(5, max(20, solved["n"] * 2.5), 40).astype(int)):
            curve.append({"n": int(n), "power": float(np.squeeze(solve(solved["effect_size"], float(n), None)))})
    return {"test": p.test, "solvedFor": blanks[0], "result": solved, "nIsPer": "group" if p.test in ("t_two_sample", "proportions", "anova") else "total",
            "nRoundedUp": int(np.ceil(solved["n"])) if solved["n"] else None, "curve": curve}

