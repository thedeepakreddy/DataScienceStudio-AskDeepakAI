"""Bayesian analysis and survival analysis.

Bayesian results use exact conjugate posteriors (Beta–Binomial, Normal) with
seeded Monte Carlo draws where a quantity has no closed form; Bayes factors
for two-group comparisons use the JZS prior (Rouder et al., 2009). Survival
analysis uses lifelines (Kaplan–Meier, log-rank, Cox, AFT).
"""
from __future__ import annotations

from typing import Literal

import numpy as np
import pandas as pd
from lifelines import CoxPHFitter, KaplanMeierFitter, LogLogisticAFTFitter, LogNormalAFTFitter, WeibullAFTFitter
from lifelines.statistics import multivariate_logrank_test, proportional_hazard_test
from lifelines.utils import median_survival_times
from pydantic import BaseModel, Field
from scipy import integrate, stats

from ..registry import capability
from ._util import NUMERIC, need

DRAWS = 200_000


# ---------------------------------------------------------------- Bayesian A/B
class Group(BaseModel):
    name: str
    successes: float | None = Field(None, ge=0)
    trials: float | None = Field(None, gt=0)
    mean: float | None = None
    sd: float | None = Field(None, gt=0)
    n: float | None = Field(None, gt=1)


class BayesAbParams(BaseModel):
    variant: str | None = Field(None, description="With a dataset: the column naming each row's variant.")
    metric: str | None = Field(None, description="With a dataset: the outcome (0/1 for conversion, or a number).")
    groups: list[Group] | None = Field(None, description="Without a dataset: summary numbers per variant.")
    kind: Literal["auto", "conversion", "continuous"] = "auto"
    prior_alpha: float = Field(1.0, gt=0)
    prior_beta: float = Field(1.0, gt=0)
    credible: float = Field(0.95, gt=0.5, lt=1)
    baseline: str | None = None


@capability("bayes.ab_test", "bayes", "Bayesian A/B test",
            "For conversion rates (Beta–Binomial) or averages (Normal): each variant's posterior, the probability each is best, expected loss of choosing it, and the credible interval for lift over the baseline. Works from a dataset or from summary numbers.",
            BayesAbParams, needs_dataset=False, tags=["experiments", "bayesian"])
def bayes_ab(ctx, p: BayesAbParams):
    rng = ctx.rng
    if p.groups:
        groups = p.groups
    else:
        need(ctx.dataset is not None and p.variant and p.metric, "Give a dataset with variant and metric columns, or summary numbers (groups).")
        ctx.require(p.variant, p.metric)
        df = ctx.frame([p.variant, p.metric]).dropna()
        y = pd.to_numeric(df[p.metric], errors="coerce")
        if y.isna().all():
            y = df[p.metric].astype(str).str.lower().isin(["1", "true", "yes", "y"]).astype(float)
        df = df.assign(_y=y).dropna(subset=["_y"])
        binary = set(df["_y"].unique()) <= {0.0, 1.0}
        kind = p.kind if p.kind != "auto" else ("conversion" if binary else "continuous")
        groups = []
        for k, g in df.groupby(p.variant, sort=True):
            if kind == "conversion":
                groups.append(Group(name=str(k), successes=float(g["_y"].sum()), trials=float(len(g))))
            else:
                groups.append(Group(name=str(k), mean=float(g["_y"].mean()), sd=float(g["_y"].std(ddof=1)), n=float(len(g))))
    need(len(groups) >= 2, "Need at least two variants.")
    conversion = all(g.successes is not None and g.trials is not None for g in groups)
    need(conversion or all(g.mean is not None and g.sd is not None and g.n is not None for g in groups),
         "Each variant needs successes and trials (conversion) or mean, sd and n (continuous).")
    samples = {}
    summary = []
    lo_q, hi_q = (1 - p.credible) / 2, 1 - (1 - p.credible) / 2
    for g in groups:
        if conversion:
            need(g.successes <= g.trials, f"{g.name}: successes can't exceed trials.")
            a, b = p.prior_alpha + g.successes, p.prior_beta + g.trials - g.successes
            s = rng.beta(a, b, DRAWS)
            summary.append({"name": g.name, "observed": g.successes / g.trials, "n": g.trials, "posteriorMean": a / (a + b), "credible": [stats.beta.ppf(lo_q, a, b), stats.beta.ppf(hi_q, a, b)]})
        else:
            se = g.sd / np.sqrt(g.n)
            s = g.mean + se * rng.standard_t(g.n - 1, DRAWS)
            summary.append({"name": g.name, "observed": g.mean, "n": g.n, "posteriorMean": g.mean, "credible": [g.mean + se * stats.t.ppf(lo_q, g.n - 1), g.mean + se * stats.t.ppf(hi_q, g.n - 1)]})
        samples[g.name] = s
    names = list(samples)
    mat = np.vstack([samples[n] for n in names])
    best = mat.argmax(axis=0)
    top = mat.max(axis=0)
    base = p.baseline or names[0]
    need(base in samples, f"Baseline “{base}” isn't one of the variants.")
    for i, row in enumerate(summary):
        row["probabilityBest"] = float((best == i).mean())
        row["expectedLoss"] = float((top - mat[i]).mean())
        if row["name"] != base:
            lift = (samples[row["name"]] - samples[base]) / np.where(samples[base] == 0, np.nan, samples[base])
            lift = lift[np.isfinite(lift)]
            row["liftOverBaseline"] = {"mean": float(lift.mean()), "credible": [float(np.quantile(lift, lo_q)), float(np.quantile(lift, hi_q))],
                                       "probabilityBetter": float((samples[row["name"]] > samples[base]).mean())}
    winner = max(summary, key=lambda r: r["probabilityBest"])
    return {"kind": "conversion" if conversion else "continuous", "baseline": base, "variants": summary, "draws": DRAWS,
            "leader": winner["name"], "leaderProbability": winner["probabilityBest"],
            "summary": f"{winner['name']} is best with probability {winner['probabilityBest']:.1%}; expected loss if chosen {winner['expectedLoss']:.4g}."}


# ---------------------------------------------------------------- Bayes factor t-test
def jzs_bf10(t: float, n1: int, n2: int | None, r: float) -> float:
    """JZS Bayes factor for a one- or two-sample t statistic (Rouder et al., 2009)."""
    if n2 is None:
        n_eff, nu = n1, n1 - 1
    else:
        n_eff, nu = n1 * n2 / (n1 + n2), n1 + n2 - 2

    def integrand(g):
        return ((1 + n_eff * g) ** -0.5 * (1 + t ** 2 / ((1 + n_eff * g) * nu)) ** (-(nu + 1) / 2)
                * r / np.sqrt(2 * np.pi) * g ** -1.5 * np.exp(-r ** 2 / (2 * g)))

    num, _ = integrate.quad(integrand, 0, np.inf, limit=200)
    den = (1 + t ** 2 / nu) ** (-(nu + 1) / 2)
    return float(num / den)


class BayesTParams(BaseModel):
    value: str
    group: str | None = Field(None, description="Group column with two groups (two-sample); leave empty for a one-sample test against mu.")
    mu: float = 0.0
    prior_scale: float = Field(0.7071, gt=0, description="Cauchy prior scale on the effect size (√2/2 is the default 'medium').")


@capability("bayes.ttest", "bayes", "Bayes factor t-test",
            "How strongly the data favour a difference versus no difference (Bayes factor BF₁₀ with the JZS prior), for one or two groups, with the effect size's posterior and an evidence label.",
            BayesTParams, tags=["bayesian", "hypothesis"])
def bayes_ttest(ctx, p: BayesTParams):
    ctx.require(p.value, p.group)
    df = ctx.frame([p.value] + ([p.group] if p.group else []))
    x = pd.to_numeric(df[p.value], errors="coerce")
    if p.group:
        d = pd.DataFrame({"x": x, "g": df[p.group]}).dropna()
        gs = [g["x"].to_numpy(float) for _, g in d.groupby("g", sort=True)]
        labels = [str(k) for k, _ in d.groupby("g", sort=True)]
        need(len(gs) == 2, "The group column must have exactly two groups.")
        t = stats.ttest_ind(gs[0], gs[1]).statistic
        bf = jzs_bf10(t, len(gs[0]), len(gs[1]), p.prior_scale)
        pooled = np.sqrt(((len(gs[0]) - 1) * gs[0].var(ddof=1) + (len(gs[1]) - 1) * gs[1].var(ddof=1)) / (len(gs[0]) + len(gs[1]) - 2))
        d_ = (gs[0].mean() - gs[1].mean()) / pooled
        info = {"groups": labels, "n": [len(gs[0]), len(gs[1])], "cohenD": d_}
    else:
        v = x.dropna().to_numpy(float)
        t = stats.ttest_1samp(v, p.mu).statistic
        bf = jzs_bf10(t, len(v), None, p.prior_scale)
        info = {"n": len(v), "cohenD": (v.mean() - p.mu) / v.std(ddof=1)}
    label = ("extreme" if bf > 100 else "very strong" if bf > 30 else "strong" if bf > 10 else "moderate" if bf > 3 else "anecdotal" if bf > 1 else
             "anecdotal (for no difference)" if bf > 1 / 3 else "moderate (for no difference)" if bf > 0.1 else "strong (for no difference)")
    return {"t": t, "bf10": bf, "bf01": 1 / bf if bf else None, "evidence": label, "priorScale": p.prior_scale, **info}


class BayesRegParams(BaseModel):
    outcome: str
    predictors: list[str] = Field(..., min_length=1, max_length=50)
    credible: float = Field(0.95, gt=0.5, lt=1)


@capability("bayes.regression", "bayes", "Bayesian linear regression",
            "Linear regression with the reference (Jeffreys) prior: posterior means, credible intervals, the probability each effect is positive, and Bayes factors for each predictor and the whole model (BIC approximation).",
            BayesRegParams, tags=["bayesian", "regression"])
def bayes_regression(ctx, p: BayesRegParams):
    ctx.require(p.outcome, *p.predictors)
    types = {c["name"]: c["type"] for c in ctx.columns()}
    df = ctx.frame([p.outcome, *p.predictors]).dropna()
    X = pd.get_dummies(df[p.predictors], drop_first=True, dtype=float)
    for c in p.predictors:
        if types[c] in NUMERIC:
            X[c] = pd.to_numeric(df[c], errors="coerce")
    X = X.dropna()
    y = pd.to_numeric(df.loc[X.index, p.outcome], errors="coerce").to_numpy(float)
    names = ["(Intercept)"] + list(X.columns)
    Xm = np.column_stack([np.ones(len(X)), X.to_numpy(float)])
    n, k = Xm.shape
    need(n > k + 1, "Too few rows for this many predictors.")
    XtX_inv = np.linalg.inv(Xm.T @ Xm)
    beta = XtX_inv @ Xm.T @ y
    resid = y - Xm @ beta
    s2 = resid @ resid / (n - k)
    se = np.sqrt(np.diag(XtX_inv) * s2)
    tq = stats.t.ppf(0.5 + p.credible / 2, n - k)

    def bic(cols):
        Z = Xm[:, cols]
        b = np.linalg.lstsq(Z, y, rcond=None)[0]
        rss = ((y - Z @ b) ** 2).sum()
        return n * np.log(rss / n) + len(cols) * np.log(n)

    full = bic(list(range(k)))
    coefs = []
    for j, nm in enumerate(names):
        post = stats.t(n - k, loc=beta[j], scale=se[j])
        row = {"term": nm, "posteriorMean": beta[j], "posteriorSd": se[j] * np.sqrt((n - k) / (n - k - 2)) if n - k > 2 else None,
               "credible": [beta[j] - tq * se[j], beta[j] + tq * se[j]], "probabilityPositive": float(post.sf(0))}
        if j > 0:
            reduced = bic([i for i in range(k) if i != j])
            row["bf10"] = float(np.exp((reduced - full) / 2))
        coefs.append(row)
    null = bic([0])
    return {"n": n, "coefficients": coefs, "sigma": float(np.sqrt(s2)), "modelBf10VsInterceptOnly": float(np.exp(min(700, (null - full) / 2))),
            "r2": 1 - (resid @ resid) / ((y - y.mean()) @ (y - y.mean())), "prior": "Jeffreys (reference) prior; Bayes factors by BIC approximation"}


# ---------------------------------------------------------------- survival
def _surv_frame(ctx, duration, event, extra):
    ctx.require(duration, event, *extra)
    df = ctx.frame([duration, event, *extra])
    d = pd.DataFrame({"T": pd.to_numeric(df[duration], errors="coerce")})
    ev = df[event]
    evn = pd.to_numeric(ev, errors="coerce")
    d["E"] = evn if evn.notna().any() else ev.astype(str).str.lower().isin(["1", "true", "yes", "event", "died", "churned"]).astype(float)
    for c in extra:
        d[c] = df[c]
    d = d.dropna(subset=["T", "E"])
    need((d["T"] >= 0).all(), "Durations can't be negative.")
    need(len(d) >= 5 and d["E"].sum() >= 1, "Need at least 5 rows and one event.")
    return d


class KmParams(BaseModel):
    duration: str
    event: str = Field(..., description="1 (or yes/true) when the event happened, 0 when the row was censored.")
    group: str | None = None
    at_times: list[float] | None = None
    points: int = Field(200, ge=10, le=2000)


@capability("survival.kaplan_meier", "survival", "Survival curves (Kaplan–Meier)",
            "Kaplan–Meier survival curves with confidence bands, median survival, survival at chosen times, numbers at risk, and a log-rank test between groups.",
            KmParams, tags=["survival", "churn", "retention"])
def kaplan_meier(ctx, p: KmParams):
    d = _surv_frame(ctx, p.duration, p.event, [p.group] if p.group else [])
    groups = [("all", d)] if not p.group else [(str(k), g) for k, g in d.groupby(p.group, sort=True)]
    need(len(groups) <= 20, "At most 20 groups.")
    curves = []
    for name, g in groups:
        km = KaplanMeierFitter().fit(g["T"], g["E"], label=name)
        sf, ci = km.survival_function_, km.confidence_interval_
        take = np.unique(np.linspace(0, len(sf) - 1, min(p.points, len(sf))).astype(int))
        med = km.median_survival_time_
        med_ci = median_survival_times(km.confidence_interval_)
        curves.append({"group": name, "n": len(g), "events": int(g["E"].sum()),
                       "curve": [{"t": float(sf.index[i]), "s": float(sf.iloc[i, 0]), "lo": float(ci.iloc[i, 0]), "hi": float(ci.iloc[i, 1])} for i in take],
                       "median": None if not np.isfinite(med) else float(med),
                       "medianCi": [float(x) if np.isfinite(x) else None for x in med_ci.iloc[0].tolist()],
                       "at": [{"t": t, "s": float(km.predict(t))} for t in (p.at_times or [])]})
    out = {"curves": curves}
    if p.group and len(groups) >= 2:
        lr = multivariate_logrank_test(d["T"], d[p.group].astype(str), d["E"])
        out["logRank"] = {"statistic": lr.test_statistic, "p": lr.p_value, "df": lr.degrees_of_freedom}
    return out


class CoxParams(BaseModel):
    duration: str
    event: str
    covariates: list[str] = Field(..., min_length=1, max_length=100)
    strata: list[str] | None = None
    penalizer: float = Field(0.0, ge=0, le=10)
    model: Literal["cox", "weibull_aft", "lognormal_aft", "loglogistic_aft"] = "cox"
    alpha: float = Field(0.05, gt=0, lt=0.5)


@capability("survival.regression", "survival", "Survival regression (Cox, AFT)",
            "Cox proportional hazards (hazard ratios, concordance and a proportional-hazards check) or accelerated failure time models (Weibull, log-normal, log-logistic) with acceleration factors.",
            CoxParams, heavy=True, tags=["survival", "churn", "regression"])
def survival_regression(ctx, p: CoxParams):
    d = _surv_frame(ctx, p.duration, p.event, p.covariates + (p.strata or []))
    X = pd.get_dummies(d[p.covariates], drop_first=True, dtype=float)
    for c in p.covariates:
        if c in X:
            X[c] = pd.to_numeric(X[c], errors="coerce")
    data = pd.concat([d[["T", "E"]], X, d[p.strata] if p.strata else None], axis=1).dropna()
    if p.model == "cox":
        m = CoxPHFitter(penalizer=p.penalizer, alpha=p.alpha)
        m.fit(data, "T", "E", strata=p.strata)
        s = m.summary
        rows = [{"term": str(i), "coef": r["coef"], "hazardRatio": r["exp(coef)"], "ci": [r[f"exp(coef) lower {100 * (1 - p.alpha):g}%"], r[f"exp(coef) upper {100 * (1 - p.alpha):g}%"]],
                 "se": r["se(coef)"], "z": r["z"], "p": r["p"]} for i, r in s.iterrows()]
        ph = None
        try:
            t = proportional_hazard_test(m, data, time_transform="rank")
            ph = [{"term": str(i[0] if isinstance(i, tuple) else i), "statistic": float(r["test_statistic"]), "p": float(r["p"])} for i, r in t.summary.iterrows()]
        except Exception:  # noqa: BLE001 - the check is a diagnostic, not essential
            ph = None
        return {"model": "cox", "n": len(data), "events": int(data["E"].sum()), "coefficients": rows, "concordance": m.concordance_index_,
                "logLik": m.log_likelihood_, "aicPartial": m.AIC_partial_, "proportionalHazards": ph}
    fitter = {"weibull_aft": WeibullAFTFitter, "lognormal_aft": LogNormalAFTFitter, "loglogistic_aft": LogLogisticAFTFitter}[p.model](penalizer=p.penalizer, alpha=p.alpha)
    need(not p.strata, "Strata are only available for the Cox model.")
    need((data["T"] > 0).all(), "AFT models need durations above zero.")
    fitter.fit(data, "T", "E")
    s = fitter.summary
    rows = [{"parameter": str(i[0]), "term": str(i[1]), "coef": r["coef"], "accelerationFactor": r["exp(coef)"], "p": r["p"], "se": r["se(coef)"]} for i, r in s.iterrows()]
    return {"model": p.model, "n": len(data), "events": int(data["E"].sum()), "coefficients": rows, "concordance": fitter.concordance_index_,
            "logLik": fitter.log_likelihood_, "aic": fitter.AIC_, "median": float(np.median(fitter.predict_median(data)))}

