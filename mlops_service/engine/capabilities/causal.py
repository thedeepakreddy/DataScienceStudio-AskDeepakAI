"""Causal inference: what changed *because of* something, not just alongside it.

Every method reports the estimate with a confidence interval and the check
that tells you whether to trust it: covariate balance for matching and
weighting, pre-trends for difference-in-differences, placebo tests for
synthetic control, first-stage strength for instruments, density at the
cutoff for regression discontinuity, and an E-value for sensitivity to
unmeasured confounding.
"""
from __future__ import annotations

from typing import Literal

import numpy as np
import pandas as pd
import statsmodels.api as sm
import statsmodels.formula.api as smf
from pydantic import BaseModel, Field
from scipy import optimize, stats
from sklearn.ensemble import GradientBoostingClassifier, GradientBoostingRegressor
from sklearn.linear_model import LogisticRegression
from sklearn.model_selection import train_test_split
from sklearn.neighbors import NearestNeighbors
from sklearn.preprocessing import StandardScaler

from ..registry import capability
from ._util import NUMERIC, need

MAX_ROWS = 500_000


def _binary(series: pd.Series, name: str, positive: str | None = None) -> pd.Series:
    s = series
    num = pd.to_numeric(s, errors="coerce")
    if num.notna().all() and set(num.unique()) <= {0, 1}:
        return num.astype(int)
    vals = sorted(s.dropna().astype(str).unique())
    need(len(vals) == 2, f"“{name}” must have exactly two values (treated / not treated).")
    pos = positive if positive is not None else vals[-1]
    return (s.astype(str) == str(pos)).astype(int)


def _design(df: pd.DataFrame, covariates: list[str], types: dict[str, str]) -> pd.DataFrame:
    X = pd.get_dummies(df[covariates].astype({c: "string" for c in covariates if types[c] not in NUMERIC}), drop_first=True, dtype=float)
    for c in covariates:
        if types[c] in NUMERIC:
            X[c] = pd.to_numeric(df[c], errors="coerce")
    return X


def evalue(rr: float) -> float:
    """VanderWeele & Ding's E-value for a risk ratio."""
    rr = rr if rr >= 1 else 1 / rr
    return float(rr + np.sqrt(rr * (rr - 1)))


class PropensityParams(BaseModel):
    treatment: str
    outcome: str
    covariates: list[str] = Field(..., min_length=1, max_length=100)
    method: Literal["matching", "ipw", "aipw"] = "aipw"
    estimand: Literal["ATE", "ATT"] = "ATE"
    treated_value: str | None = None
    caliper: float = Field(0.2, gt=0, le=2, description="Matching caliper in SDs of the propensity logit.")
    trim: float = Field(0.01, ge=0, lt=0.2, description="Drop units with propensity below trim or above 1 − trim.")
    bootstrap: int = Field(300, ge=0, le=2000)


@capability("causal.propensity", "causal", "Treatment effect (matching / weighting)",
            "Estimates the effect of a treatment from observational data by propensity-score matching, inverse probability weighting, or doubly robust AIPW — with covariate balance before and after, overlap, a bootstrap confidence interval and an E-value for unmeasured confounding.",
            PropensityParams, heavy=True, tags=["causal", "observational"])
def propensity(ctx, p: PropensityParams):  # noqa: C901
    ctx.require(p.treatment, p.outcome, *p.covariates)
    types = {c["name"]: c["type"] for c in ctx.columns()}
    df = ctx.frame([p.treatment, p.outcome, *p.covariates], max_rows=MAX_ROWS).dropna()
    t = _binary(df[p.treatment], p.treatment, p.treated_value).to_numpy()
    y = pd.to_numeric(df[p.outcome], errors="coerce").to_numpy(float)
    X = _design(df, p.covariates, types)
    ok = np.isfinite(y) & X.notna().all(axis=1).to_numpy()
    X, t, y = X[ok], t[ok], y[ok]
    need(t.sum() >= 10 and (1 - t).sum() >= 10, "Need at least 10 treated and 10 untreated rows.")
    Xs = StandardScaler().fit_transform(X)

    def fit_ps(Xs_, t_):
        return LogisticRegression(max_iter=2000, C=1.0).fit(Xs_, t_).predict_proba(Xs_)[:, 1]

    def smd(a, b, wa=None, wb=None):
        ma, mb = np.average(a, weights=wa), np.average(b, weights=wb)
        va, vb = np.average((a - ma) ** 2, weights=wa), np.average((b - mb) ** 2, weights=wb)
        return float((ma - mb) / np.sqrt((va + vb) / 2)) if va + vb > 0 else 0.0

    def estimate(Xs_, t_, y_, X_raw, with_balance=False):
        ps = np.clip(fit_ps(Xs_, t_), 1e-6, 1 - 1e-6)
        keep = (ps >= p.trim) & (ps <= 1 - p.trim)
        ps, t_, y_, Xs_, X_raw = ps[keep], t_[keep], y_[keep], Xs_[keep], X_raw[keep]
        bal = None
        if p.method == "matching":
            logit = np.log(ps / (1 - ps))
            cal = p.caliper * logit.std()
            tr, co = np.where(t_ == 1)[0], np.where(t_ == 0)[0]
            nn = NearestNeighbors(n_neighbors=1).fit(logit[co].reshape(-1, 1))
            dist, idx = nn.kneighbors(logit[tr].reshape(-1, 1))
            good = dist[:, 0] <= cal
            mt, mc = tr[good], co[idx[good, 0]]
            effect = float(np.mean(y_[mt] - y_[mc]))
            if with_balance:
                bal = [{"covariate": c, "before": smd(X_raw[t_ == 1, j], X_raw[t_ == 0, j]), "after": smd(X_raw[mt, j], X_raw[mc, j])} for j, c in enumerate(X.columns)]
                bal = (bal, {"matchedTreated": int(good.sum()), "unmatchedTreated": int((~good).sum())})
            return effect, bal, ps, keep
        if p.estimand == "ATE":
            w = np.where(t_ == 1, 1 / ps, 1 / (1 - ps))
        else:
            w = np.where(t_ == 1, 1.0, ps / (1 - ps))
        if p.method == "ipw":
            effect = float(np.average(y_[t_ == 1], weights=w[t_ == 1]) - np.average(y_[t_ == 0], weights=w[t_ == 0]))
        else:
            m1 = GradientBoostingRegressor(random_state=ctx.seed, max_depth=3, n_estimators=150).fit(Xs_[t_ == 1], y_[t_ == 1])
            m0 = GradientBoostingRegressor(random_state=ctx.seed, max_depth=3, n_estimators=150).fit(Xs_[t_ == 0], y_[t_ == 0])
            mu1, mu0 = m1.predict(Xs_), m0.predict(Xs_)
            if p.estimand == "ATE":
                psi = mu1 - mu0 + t_ * (y_ - mu1) / ps - (1 - t_) * (y_ - mu0) / (1 - ps)
                effect = float(psi.mean())
            else:
                psi = (t_ * (y_ - mu0) - (1 - t_) * ps / (1 - ps) * (y_ - mu0))
                effect = float(psi.sum() / t_.sum())
        if with_balance:
            bal = ([{"covariate": c, "before": smd(X_raw[t_ == 1, j], X_raw[t_ == 0, j]),
                     "after": smd(X_raw[t_ == 1, j], X_raw[t_ == 0, j], w[t_ == 1], w[t_ == 0])} for j, c in enumerate(X.columns)],
                   {"effectiveSampleSize": float(w.sum() ** 2 / (w ** 2).sum())})
        return effect, bal, ps, keep

    Xraw = X.to_numpy(float)
    effect, (balance, extra), ps, keep = estimate(Xs, t, y, Xraw, with_balance=True)
    boots = []
    for b in range(p.bootstrap):
        if b % 25 == 0:
            ctx.progress(b / max(1, p.bootstrap), f"Bootstrap {b}/{p.bootstrap}")
        i = ctx.rng.integers(0, len(t), len(t))
        if t[i].sum() < 5 or (1 - t[i]).sum() < 5:
            continue
        try:
            boots.append(estimate(Xs[i], t[i], y[i], Xraw[i])[0])
        except ValueError:
            continue
    ci = [float(np.quantile(boots, 0.025)), float(np.quantile(boots, 0.975))] if len(boots) > 20 else None
    sd_y = float(np.std(y, ddof=1))
    d = effect / sd_y if sd_y > 0 else 0.0
    rr_approx = float(np.exp(0.91 * abs(d)))
    worst = max((abs(b["after"]) for b in balance), default=0)
    if worst > 0.1:
        ctx.note(f"Some covariates are still imbalanced after adjustment (largest |SMD| {worst:.2f} > 0.1); treat the estimate with caution.")
    return {"method": p.method, "estimand": "ATT" if p.method == "matching" else p.estimand, "effect": effect, "ci": ci,
            "bootstrapResamples": len(boots), "treated": int(t.sum()), "control": int((1 - t).sum()), "trimmed": int((~keep).sum()),
            "balance": balance, **extra,
            "overlap": {"treated": np.percentile(ps[t[keep] == 1], [0, 5, 50, 95, 100]).tolist(), "control": np.percentile(ps[t[keep] == 0], [0, 5, 50, 95, 100]).tolist()},
            "standardisedEffect": d, "eValue": evalue(rr_approx),
            "eValueMeaning": "How strongly an unmeasured confounder would need to be associated with both treatment and outcome (as a risk ratio) to explain the effect away.",
            "assumption": "No unmeasured confounding: every common cause of treatment and outcome is among the covariates."}


class DidParams(BaseModel):
    outcome: str
    treated: str = Field(..., description="1 for units that get the treatment, 0 for comparison units.")
    post: str | None = Field(None, description="1 for periods after the treatment started. Or give time + start.")
    time: str | None = None
    start: float | str | None = Field(None, description="First treated period (with time).")
    unit: str | None = Field(None, description="Unit ID, for clustered standard errors and unit fixed effects.")
    covariates: list[str] | None = None


@capability("causal.did", "causal", "Difference-in-differences",
            "The effect of a change that hit one group and not another, comparing before and after — with clustered standard errors, unit and time fixed effects when available, and an event-study check of parallel pre-trends.",
            DidParams, tags=["causal", "policy"])
def did(ctx, p: DidParams):
    need(p.post or (p.time and p.start is not None), "Give a post column, or a time column and the start period.")
    cols = [p.outcome, p.treated] + [c for c in [p.post, p.time, p.unit] if c] + (p.covariates or [])
    ctx.require(*cols)
    df = ctx.frame(list(dict.fromkeys(cols)), max_rows=MAX_ROWS).dropna()
    d = pd.DataFrame({"y": pd.to_numeric(df[p.outcome], errors="coerce"), "treated": _binary(df[p.treated], p.treated)})
    if p.post:
        d["post"] = _binary(df[p.post], p.post)
    else:
        tt = df[p.time]
        start = p.start
        if not pd.api.types.is_numeric_dtype(tt):
            tt, start = pd.to_datetime(tt, errors="coerce"), pd.to_datetime(start)
        d["post"] = (tt >= start).astype(int)
        d["time"] = tt
    for c in p.covariates or []:
        d[c] = pd.to_numeric(df[c], errors="coerce")
    if p.unit:
        d["unit"] = df[p.unit].astype(str)
    d = d.dropna()
    cov = "".join(f" + Q('{c}')" for c in p.covariates or [])
    fe = ""
    if p.unit and "time" in d:
        fe = " + C(unit) + C(time)"
        formula = f"y ~ treated:post{cov}{fe}"
    else:
        formula = f"y ~ treated * post{cov}"
    model = smf.ols(formula, d)
    res = model.fit(cov_type="cluster", cov_kwds={"groups": pd.factorize(d["unit"])[0]}) if p.unit else model.fit(cov_type="HC1")
    term = "treated:post"
    ci = res.conf_int().loc[term].tolist()
    means = d.groupby(["treated", "post"])["y"].mean()
    out = {"effect": res.params[term], "se": res.bse[term], "p": res.pvalues[term], "ci": ci, "n": int(res.nobs),
           "standardErrors": "clustered by unit" if p.unit else "heteroskedasticity-robust (HC1)",
           "fixedEffects": bool(fe), "groupMeans": [{"treated": int(k[0]), "post": int(k[1]), "mean": v} for k, v in means.items()],
           "assumption": "Parallel trends: without the treatment, both groups would have changed by the same amount."}
    if "time" in d and d["time"].nunique() >= 4:
        periods = sorted(d["time"].unique())
        start_idx = next((i for i, x in enumerate(periods) if d.loc[d["time"] == x, "post"].max() == 1), len(periods))
        ref = periods[start_idx - 1] if start_idx > 0 else periods[0]
        ev = d.assign(rel=d["time"].map({x: i - start_idx for i, x in enumerate(periods)}))
        ev = ev[ev["time"] != ref]
        dummies = pd.get_dummies(ev["rel"], prefix="r", dtype=float).mul(ev["treated"], axis=0)
        dummies.columns = [c.replace("-", "m") for c in dummies.columns]
        X = sm.add_constant(pd.concat([ev[["treated"]], pd.get_dummies(ev["time"].astype(str), drop_first=True, dtype=float), dummies], axis=1))
        er = sm.OLS(ev["y"].to_numpy(float), X.to_numpy(float)).fit(cov_type="HC1")
        names = list(X.columns)
        study = []
        for c in dummies.columns:
            j = names.index(c)
            rel = int(c[2:].replace("m", "-"))
            lo, hi = er.conf_int()[j]
            study.append({"relativePeriod": rel, "estimate": er.params[j], "ci": [lo, hi], "p": er.pvalues[j]})
        pre = [s for s in study if s["relativePeriod"] < 0]
        out["eventStudy"] = sorted(study, key=lambda s: s["relativePeriod"])
        if pre:
            bad = [s for s in pre if s["p"] < 0.05]
            out["preTrendsOk"] = not bad
            if bad:
                ctx.note("Some pre-treatment periods already differ between groups: the parallel-trends assumption looks doubtful.")
    return out


class SynthParams(BaseModel):
    unit: str
    time: str
    outcome: str
    treated_unit: str
    start: float | str = Field(..., description="First period of the intervention.")
    placebos: int = Field(20, ge=0, le=100)


def _synth_weights(Y0_pre: np.ndarray, y1_pre: np.ndarray) -> np.ndarray:
    k = Y0_pre.shape[1]
    res = optimize.minimize(lambda w: ((y1_pre - Y0_pre @ w) ** 2).sum(), np.full(k, 1 / k), method="SLSQP",
                            bounds=[(0, 1)] * k, constraints=[{"type": "eq", "fun": lambda w: w.sum() - 1}], options={"maxiter": 500, "ftol": 1e-10})
    return res.x


@capability("causal.synthetic_control", "causal", "Synthetic control",
            "The effect of an intervention on one unit (a country, store or region), estimated by building a weighted 'synthetic twin' from untreated units, with pre-period fit and a placebo (permutation) test.",
            SynthParams, heavy=True, tags=["causal", "policy", "time series"])
def synthetic_control(ctx, p: SynthParams):
    ctx.require(p.unit, p.time, p.outcome)
    df = ctx.frame([p.unit, p.time, p.outcome]).dropna()
    wide = df.pivot_table(index=p.time, columns=p.unit, values=p.outcome, aggfunc="mean").sort_index().dropna(axis=1)
    wide.columns = wide.columns.astype(str)
    need(str(p.treated_unit) in wide.columns, f"“{p.treated_unit}” wasn't found (or has gaps) in {p.unit}.")
    idx = wide.index
    start = pd.to_datetime(p.start) if not pd.api.types.is_numeric_dtype(idx) else float(p.start)
    if not pd.api.types.is_numeric_dtype(idx):
        idx = pd.to_datetime(idx)
    pre = np.asarray(idx < start)
    need(pre.sum() >= 3 and (~pre).sum() >= 1, "Need at least 3 periods before and 1 after the start.")
    donors = [c for c in wide.columns if c != str(p.treated_unit)]
    need(len(donors) >= 2, "Need at least two untreated units.")

    def fit(unit):
        others = [c for c in wide.columns if c != unit and c != str(p.treated_unit)] if unit != str(p.treated_unit) else donors
        Y0, y1 = wide[others].to_numpy(float), wide[unit].to_numpy(float)
        w = _synth_weights(Y0[pre], y1[pre])
        synth = Y0 @ w
        gap = y1 - synth
        rmspe_pre = float(np.sqrt(np.mean(gap[pre] ** 2)))
        rmspe_post = float(np.sqrt(np.mean(gap[~pre] ** 2)))
        return w, others, synth, gap, rmspe_pre, rmspe_post

    w, others, synth, gap, pre_r, post_r = fit(str(p.treated_unit))
    ratios = [post_r / pre_r if pre_r > 0 else np.inf]
    for i, u in enumerate(donors[: p.placebos]):
        ctx.progress(i / max(1, p.placebos), f"Placebo {u}")
        _, _, _, _, a, b = fit(u)
        ratios.append(b / a if a > 0 else np.inf)
    rank = sum(r >= ratios[0] for r in ratios)
    weights = sorted(({"unit": u, "weight": float(x)} for u, x in zip(others, w) if x > 0.001), key=lambda r: -r["weight"])
    return {"treatedUnit": p.treated_unit, "weights": weights, "preRmspe": pre_r, "postRmspe": post_r,
            "averageEffect": float(gap[~pre].mean()), "cumulativeEffect": float(gap[~pre].sum()),
            "series": [{"time": t, "actual": a, "synthetic": s, "gap": g} for t, a, s, g in zip(wide.index, wide[str(p.treated_unit)], synth, gap)],
            "placeboP": rank / len(ratios) if p.placebos else None, "placebos": len(ratios) - 1,
            "assumption": "The donor units, weighted, track the treated unit closely before the intervention and weren't affected by it."}


class IvParams(BaseModel):
    outcome: str
    treatment: str = Field(..., description="The endogenous variable.")
    instruments: list[str] = Field(..., min_length=1)
    covariates: list[str] | None = None


@capability("causal.iv", "causal", "Instrumental variables (2SLS)",
            "Two-stage least squares with robust standard errors, the first-stage F statistic (weak-instrument check), a Wu–Hausman endogeneity test and, with several instruments, a Sargan over-identification test.",
            IvParams, tags=["causal", "econometrics"])
def iv(ctx, p: IvParams):
    cols = [p.outcome, p.treatment, *p.instruments, *(p.covariates or [])]
    ctx.require(*cols)
    df = ctx.frame(list(dict.fromkeys(cols)), max_rows=MAX_ROWS).apply(pd.to_numeric, errors="coerce").dropna()
    n = len(df)
    need(n > len(cols) + 5, "Too few complete rows.")
    y = df[p.outcome].to_numpy(float)
    x = df[p.treatment].to_numpy(float)
    W = np.column_stack([np.ones(n)] + [df[c].to_numpy(float) for c in p.covariates or []])
    Z = df[p.instruments].to_numpy(float)
    first = sm.OLS(x, np.column_stack([W, Z])).fit()
    restricted = sm.OLS(x, W).fit()
    q_ = Z.shape[1]
    f_first = ((restricted.ssr - first.ssr) / q_) / (first.ssr / (n - W.shape[1] - q_))
    xhat = first.fittedvalues
    X2 = np.column_stack([xhat, W])
    beta = np.linalg.lstsq(X2, y, rcond=None)[0]
    Xs = np.column_stack([x, W])
    resid = y - Xs @ beta
    bread = np.linalg.inv(X2.T @ X2)
    meat = (X2 * resid[:, None] ** 2).T @ X2
    cov = bread @ meat @ bread * n / (n - X2.shape[1])
    se = float(np.sqrt(cov[0, 0]))
    zc = stats.norm.ppf(0.975)
    ols = sm.OLS(y, Xs).fit(cov_type="HC1")
    cf = sm.OLS(y, np.column_stack([x, W, first.resid])).fit(cov_type="HC1")
    out = {"effect": float(beta[0]), "se": se, "ci": [beta[0] - zc * se, beta[0] + zc * se], "p": float(2 * stats.norm.sf(abs(beta[0] / se))),
           "olsEffect": float(ols.params[0]), "n": n, "firstStageF": float(f_first), "weakInstruments": bool(f_first < 10),
           "wuHausman": {"statistic": float(cf.tvalues[-1]), "p": float(cf.pvalues[-1])}}
    if q_ > 1:
        u = sm.OLS(resid, np.column_stack([W, Z])).fit()
        sargan = n * u.rsquared
        out["sargan"] = {"statistic": float(sargan), "df": q_ - 1, "p": float(stats.chi2.sf(sargan, q_ - 1))}
    if f_first < 10:
        ctx.note(f"The instruments are weak (first-stage F = {f_first:.1f} < 10), so the IV estimate can be badly biased.")
    out["assumption"] = "The instruments affect the outcome only through the treatment, and are unrelated to unmeasured confounders."
    return out


class RddParams(BaseModel):
    outcome: str
    running: str = Field(..., description="The score that decides treatment at the cutoff.")
    cutoff: float
    bandwidth: float | None = Field(None, gt=0)
    kernel: Literal["triangular", "uniform"] = "triangular"


@capability("causal.rdd", "causal", "Regression discontinuity",
            "The jump in an outcome at a cutoff in a score (e.g. a grade or threshold), by local linear regression on each side, with robustness at half and double the bandwidth and a density check for manipulation of the score.",
            RddParams, tags=["causal", "policy"])
def rdd(ctx, p: RddParams):
    ctx.require(p.outcome, p.running)
    df = ctx.frame([p.outcome, p.running], max_rows=MAX_ROWS).apply(pd.to_numeric, errors="coerce").dropna()
    xr = df[p.running].to_numpy(float) - p.cutoff
    y = df[p.outcome].to_numpy(float)
    need(((xr < 0).sum() >= 10) and ((xr >= 0).sum() >= 10), "Need at least 10 observations on each side of the cutoff.")
    h0 = p.bandwidth or float(1.84 * np.std(xr) * len(xr) ** (-1 / 5))

    def jump(h):
        keep = np.abs(xr) <= h
        x_, y_ = xr[keep], y[keep]
        w = (1 - np.abs(x_) / h) if p.kernel == "triangular" else np.ones_like(x_)
        d = (x_ >= 0).astype(float)
        X = np.column_stack([np.ones_like(x_), d, x_, d * x_])
        res = sm.WLS(y_, X, weights=w).fit(cov_type="HC1")
        return {"bandwidth": h, "estimate": float(res.params[1]), "se": float(res.bse[1]), "p": float(res.pvalues[1]),
                "ci": res.conf_int()[1].tolist(), "n": int(keep.sum())}

    main = jump(h0)
    left = ((xr < 0) & (xr >= -h0)).sum()
    right = ((xr >= 0) & (xr <= h0)).sum()
    dens = stats.binomtest(int(right), int(left + right), 0.5)
    bins = np.linspace(-h0, h0, 21)
    plot = []
    for a, b in zip(bins[:-1], bins[1:]):
        m = (xr >= a) & (xr < b)
        if m.any():
            plot.append({"x": float((a + b) / 2 + p.cutoff), "y": float(y[m].mean()), "n": int(m.sum())})
    out = {"jump": main, "robustness": [jump(h0 / 2), jump(h0 * 2)], "density": {"left": int(left), "right": int(right), "p": dens.pvalue},
           "binnedMeans": plot, "bandwidthRule": "user" if p.bandwidth else "rule of thumb (1.84 × SD × n^−1/5)",
           "assumption": "Units just either side of the cutoff are alike in everything except treatment, and can't precisely control their score."}
    if dens.pvalue < 0.05:
        ctx.note("There are noticeably more units on one side of the cutoff: the score may have been manipulated.")
    return out


class UpliftParams(BaseModel):
    treatment: str
    outcome: str
    features: list[str] = Field(..., min_length=1, max_length=200)
    treated_value: str | None = None
    test_size: float = Field(0.3, gt=0.1, lt=0.5)


@capability("causal.uplift", "causal", "Uplift modelling",
            "Who responds to a treatment (e.g. a campaign): per-person uplift from a two-model learner, uplift by decile and a Qini curve on held-out data, so you can target the people it actually changes.",
            UpliftParams, heavy=True, tags=["causal", "marketing"])
def uplift(ctx, p: UpliftParams):
    ctx.require(p.treatment, p.outcome, *p.features)
    types = {c["name"]: c["type"] for c in ctx.columns()}
    df = ctx.frame([p.treatment, p.outcome, *p.features], max_rows=MAX_ROWS).dropna()
    t = _binary(df[p.treatment], p.treatment, p.treated_value).to_numpy()
    yraw = df[p.outcome]
    binary = pd.to_numeric(yraw, errors="coerce").isin([0, 1]).all() or yraw.nunique() == 2
    y = _binary(yraw, p.outcome).to_numpy(float) if binary else pd.to_numeric(yraw, errors="coerce").to_numpy(float)
    X = _design(df, p.features, types).fillna(0).to_numpy(float)
    Xtr, Xte, ttr, tte, ytr, yte = train_test_split(X, t, y, test_size=p.test_size, random_state=ctx.seed, stratify=t)
    Model = GradientBoostingClassifier if binary else GradientBoostingRegressor

    def fitp(Xa, ya):
        m = Model(random_state=ctx.seed, n_estimators=200, max_depth=3).fit(Xa, ya)
        return (lambda Z: m.predict_proba(Z)[:, 1]) if binary else m.predict

    f1, f0 = fitp(Xtr[ttr == 1], ytr[ttr == 1]), fitp(Xtr[ttr == 0], ytr[ttr == 0])
    u = f1(Xte) - f0(Xte)
    order = np.argsort(-u)
    deciles = []
    for k, chunk in enumerate(np.array_split(order, 10)):
        tt, yy = tte[chunk], yte[chunk]
        obs = yy[tt == 1].mean() - yy[tt == 0].mean() if tt.sum() and (1 - tt).sum() else None
        deciles.append({"decile": k + 1, "predictedUplift": float(u[chunk].mean()), "observedUplift": obs, "n": len(chunk)})
    cum_t = np.cumsum(tte[order] * yte[order])
    cum_c = np.cumsum((1 - tte[order]) * yte[order])
    nt, nc = np.cumsum(tte[order]), np.cumsum(1 - tte[order])
    qini = cum_t - np.divide(cum_c * nt, nc, out=np.zeros_like(cum_c), where=nc > 0)
    take = np.linspace(0, len(qini) - 1, min(100, len(qini))).astype(int)
    random_line = qini[-1] * (np.arange(1, len(qini) + 1) / len(qini))
    qini_coef = float((qini - random_line).mean() / max(1, len(qini)))
    return {"learner": "two-model (T-learner), gradient boosting", "testRows": len(yte), "averageUplift": float(u.mean()),
            "deciles": deciles, "qini": [{"share": float((i + 1) / len(qini)), "qini": float(qini[i]), "random": float(random_line[i])} for i in take],
            "qiniCoefficient": qini_coef, "binaryOutcome": bool(binary),
            "assumption": "Treatment was assigned at random (an experiment), or all confounders are among the features."}
