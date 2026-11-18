"""Experimentation: A/B tests with CUPED and sample-ratio checks, sequential
monitoring with alpha spending, sample-size planning and multi-armed bandits."""
from __future__ import annotations

from typing import Literal

import numpy as np
import pandas as pd
from pydantic import BaseModel, Field
from scipy import stats
from statsmodels.stats.multitest import multipletests
from statsmodels.stats.power import NormalIndPower, TTestIndPower
from statsmodels.stats.proportion import proportion_effectsize

from ..registry import capability
from ._util import need


def srm(observed: list[float], expected_share: list[float]) -> dict:
    total = sum(observed)
    exp = np.array(expected_share) / sum(expected_share) * total
    chi2, pv = stats.chisquare(observed, exp)
    return {"observed": observed, "expected": exp.tolist(), "chi2": chi2, "p": pv, "mismatch": bool(pv < 0.001)}


class AbParams(BaseModel):
    variant: str
    metric: str
    control: str | None = None
    covariate: str | None = Field(None, description="A pre-experiment measure of the metric, for CUPED variance reduction.")
    expected_split: list[float] | None = Field(None, description="Intended traffic shares, for the sample-ratio check (equal by default).")
    alpha: float = Field(0.05, gt=0, lt=0.5)
    kind: Literal["auto", "conversion", "continuous"] = "auto"


@capability("exp.ab_test", "experiments", "A/B test",
            "Compares variants on a conversion or continuous metric: lift with confidence intervals (absolute and relative), z or Welch tests, Holm adjustment for several variants, CUPED variance reduction using a pre-period covariate, and a sample-ratio-mismatch check.",
            AbParams, tags=["experiments"])
def ab_test(ctx, p: AbParams):
    ctx.require(p.variant, p.metric, p.covariate)
    df = ctx.frame([p.variant, p.metric] + ([p.covariate] if p.covariate else [])).dropna(subset=[p.variant, p.metric])
    y = pd.to_numeric(df[p.metric], errors="coerce")
    if y.isna().all():
        y = df[p.metric].astype(str).str.lower().isin(["1", "true", "yes"]).astype(float)
    df = df.assign(_y=y).dropna(subset=["_y"])
    binary = set(df["_y"].unique()) <= {0.0, 1.0}
    kind = p.kind if p.kind != "auto" else ("conversion" if binary else "continuous")
    variants = sorted(df[p.variant].astype(str).unique())
    need(len(variants) >= 2, "Need at least two variants.")
    control = p.control or variants[0]
    need(control in variants, f"Control “{control}” isn't a variant.")
    df["_v"] = df[p.variant].astype(str)
    theta, reduction = None, None
    if p.covariate:
        x = pd.to_numeric(df[p.covariate], errors="coerce")
        ok = x.notna()
        theta = float(np.cov(df.loc[ok, "_y"], x[ok])[0, 1] / x[ok].var())
        adj = df["_y"] - theta * (x - x[ok].mean())
        before = df.groupby("_v")["_y"].var().mean()
        df["_y"] = adj.where(ok, df["_y"])
        reduction = float(1 - df.groupby("_v")["_y"].var().mean() / before) if before > 0 else None
    groups = {v: g["_y"].to_numpy(float) for v, g in df.groupby("_v")}
    c = groups[control]
    zc = stats.norm.ppf(1 - p.alpha / 2)
    rows = []
    for v in variants:
        g = groups[v]
        row = {"variant": v, "n": len(g), "mean": g.mean(), "sd": g.std(ddof=1)}
        if v != control:
            diff = g.mean() - c.mean()
            if kind == "conversion" and not p.covariate:
                p1, p0 = g.mean(), c.mean()
                pool = (g.sum() + c.sum()) / (len(g) + len(c))
                se0 = np.sqrt(pool * (1 - pool) * (1 / len(g) + 1 / len(c)))
                z = diff / se0 if se0 > 0 else 0.0
                pv = 2 * stats.norm.sf(abs(z))
                se = np.sqrt(p1 * (1 - p1) / len(g) + p0 * (1 - p0) / len(c))
                test = "two-proportion z-test"
            else:
                t = stats.ttest_ind(g, c, equal_var=False)
                pv = t.pvalue
                se = np.sqrt(g.var(ddof=1) / len(g) + c.var(ddof=1) / len(c))
                test = "Welch t-test" + (" (CUPED-adjusted)" if p.covariate else "")
            rel_se = np.sqrt((se / c.mean()) ** 2 + (g.mean() * c.std(ddof=1) / np.sqrt(len(c)) / c.mean() ** 2) ** 2) if c.mean() else None
            row.update(test=test, difference=diff, ci=[diff - zc * se, diff + zc * se], p=pv,
                       relativeLift=diff / c.mean() if c.mean() else None,
                       relativeCi=[diff / c.mean() - zc * rel_se, diff / c.mean() + zc * rel_se] if rel_se else None)
        rows.append(row)
    others = [r for r in rows if r["variant"] != control]
    if len(others) > 1:
        adj = multipletests([r["p"] for r in others], method="holm")[1]
        for r, a in zip(others, adj):
            r["pAdjusted"] = a
    for r in others:
        r["significant"] = bool(r.get("pAdjusted", r["p"]) < p.alpha)
    counts = [len(groups[v]) for v in variants]
    check = srm(counts, p.expected_split or [1] * len(variants))
    if check["mismatch"]:
        ctx.note("Sample ratio mismatch: traffic didn't split as intended, so the assignment may be broken and the results unreliable.")
    return {"kind": kind, "control": control, "variants": rows, "cuped": {"theta": theta, "varianceReduction": reduction} if p.covariate else None,
            "sampleRatio": check, "alpha": p.alpha}


class SeqParams(BaseModel):
    looks: int = Field(5, ge=2, le=20, description="Planned number of analyses (interim + final).")
    information: list[float] | None = Field(None, description="Information fraction at each look (equal by default).")
    spending: Literal["obrien_fleming", "pocock"] = "obrien_fleming"
    alpha: float = Field(0.05, gt=0, lt=0.5)
    observed_z: list[float] | None = Field(None, description="Z statistics observed so far, to decide whether to stop.")
    simulations: int = Field(200_000, ge=20_000, le=1_000_000)


@capability("exp.sequential", "experiments", "Sequential test boundaries",
            "Plans a group-sequential test you can check several times without inflating false positives: efficacy boundaries from Lan–DeMets alpha spending (O'Brien–Fleming or Pocock), found by seeded simulation, and whether to stop given the z statistics so far.",
            SeqParams, needs_dataset=False, tags=["experiments", "design"])
def sequential(ctx, p: SeqParams):
    t = np.array(p.information or np.linspace(1 / p.looks, 1, p.looks))
    need(len(t) == p.looks and np.all(np.diff(t) > 0) and t[-1] <= 1 + 1e-9, "Information fractions must increase up to 1, one per look.")
    # Spending per side, as in standard software (gsDesign's sfLDOF / sfLDPocock), for a symmetric two-sided test.
    side = p.alpha / 2
    if p.spending == "obrien_fleming":
        spend = 2 * (2 - 2 * stats.norm.cdf(stats.norm.ppf(1 - side / 2) / np.sqrt(t)))
    else:
        spend = 2 * side * np.log(1 + (np.e - 1) * t)
    inc = np.diff(np.concatenate([[0], spend]))
    # Brownian motion at the information times.
    steps = ctx.rng.normal(size=(p.simulations, p.looks)) * np.sqrt(np.diff(np.concatenate([[0], t])))
    Z = np.abs(np.cumsum(steps, axis=1) / np.sqrt(t))
    alive = np.ones(p.simulations, bool)
    bounds = []
    for k in range(p.looks):
        z_k = Z[alive, k]
        need_frac = inc[k] * p.simulations / max(1, alive.sum())
        b = float(np.quantile(z_k, 1 - min(1.0, need_frac))) if need_frac < 1 else 0.0
        bounds.append(b)
        alive &= ~(Z[:, k] >= b)
    plan = [{"look": k + 1, "information": float(t[k]), "alphaSpent": float(spend[k]), "boundaryZ": b, "nominalP": float(2 * stats.norm.sf(b))} for k, b in enumerate(bounds)]
    decision = None
    if p.observed_z:
        need(len(p.observed_z) <= p.looks, "More observed looks than planned.")
        decision = {"stop": False, "atLook": None}
        for k, z in enumerate(p.observed_z):
            if abs(z) >= bounds[k]:
                decision = {"stop": True, "atLook": k + 1, "reason": "efficacy boundary crossed"}
                break
        if not decision["stop"]:
            decision["reason"] = "continue" if len(p.observed_z) < p.looks else "final look reached without crossing: no significant effect"
    return {"spending": p.spending, "alpha": p.alpha, "plan": plan, "decision": decision, "simulations": p.simulations}


class SrmParams(BaseModel):
    observed: list[float] = Field(..., min_length=2)
    expected_share: list[float] | None = None


@capability("exp.srm", "experiments", "Sample ratio mismatch check",
            "Checks whether traffic split between variants as intended (chi-square); a mismatch usually means broken assignment or logging.",
            SrmParams, needs_dataset=False, tags=["experiments", "quality"])
def srm_check(ctx, p: SrmParams):
    return srm(p.observed, p.expected_share or [1] * len(p.observed))


class SampleSizeParams(BaseModel):
    metric: Literal["conversion", "continuous"] = "conversion"
    baseline: float = Field(..., gt=0, description="Baseline conversion rate (0–1), or baseline mean.")
    mde: float = Field(..., gt=0, description="Smallest effect worth detecting, relative (0.05 = 5% lift).")
    sd: float | None = Field(None, gt=0, description="Standard deviation (continuous metrics).")
    alpha: float = Field(0.05, gt=0, lt=0.5)
    power: float = Field(0.8, gt=0.5, lt=1)
    variants: int = Field(2, ge=2, le=20)
    daily_traffic: float | None = Field(None, gt=0)


@capability("exp.sample_size", "experiments", "A/B test sample size",
            "How many users each variant needs to detect a given lift (with Bonferroni correction for several variants), and how many days that takes at your traffic.",
            SampleSizeParams, needs_dataset=False, tags=["experiments", "design"])
def sample_size(ctx, p: SampleSizeParams):
    alpha = p.alpha / (p.variants - 1)
    if p.metric == "conversion":
        need(p.baseline < 1, "A conversion baseline is a rate between 0 and 1.")
        target = min(0.999999, p.baseline * (1 + p.mde))
        es = abs(proportion_effectsize(target, p.baseline))
        n = NormalIndPower().solve_power(es, alpha=alpha, power=p.power)
    else:
        need(p.sd is not None, "Continuous metrics need the standard deviation.")
        es = p.baseline * p.mde / p.sd
        n = TTestIndPower().solve_power(es, alpha=alpha, power=p.power)
    per = int(np.ceil(n))
    total = per * p.variants
    return {"perVariant": per, "total": total, "effectSize": es, "alphaPerComparison": alpha,
            "days": float(np.ceil(total / p.daily_traffic)) if p.daily_traffic else None}


class BanditParams(BaseModel):
    arms: list[dict] = Field(..., min_length=2, description="[{name, successes, trials}]")
    method: Literal["thompson", "ucb1"] = "thompson"
    draws: int = Field(100_000, ge=1000, le=1_000_000)


@capability("exp.bandit", "experiments", "Multi-armed bandit allocation",
            "Recommends how to split the next traffic between options from results so far: Thompson sampling (probability each arm is best) or UCB1 scores.",
            BanditParams, needs_dataset=False, tags=["experiments", "optimisation"])
def bandit(ctx, p: BanditParams):
    names = [str(a.get("name", f"arm {i + 1}")) for i, a in enumerate(p.arms)]
    s = np.array([float(a.get("successes", 0)) for a in p.arms])
    n = np.array([float(a.get("trials", 0)) for a in p.arms])
    need(np.all(n >= s) and np.all(s >= 0), "Each arm needs successes ≤ trials.")
    if p.method == "thompson":
        samples = ctx.rng.beta(1 + s[:, None], 1 + (n - s)[:, None], size=(len(s), p.draws))
        best = np.bincount(samples.argmax(axis=0), minlength=len(s)) / p.draws
        return {"method": "Thompson sampling", "arms": [{"name": nm, "rate": (si / ni) if ni else None, "probabilityBest": float(b), "suggestedShare": float(b)}
                                                        for nm, si, ni, b in zip(names, s, n, best)]}
    total = n.sum()
    with np.errstate(divide="ignore", invalid="ignore"):
        score = np.where(n > 0, s / n + np.sqrt(2 * np.log(max(total, 1)) / n), np.inf)
    pick = int(np.argmax(score))
    return {"method": "UCB1", "arms": [{"name": nm, "rate": (si / ni) if ni else None, "score": float(sc) if np.isfinite(sc) else None, "next": i == pick}
                                       for i, (nm, si, ni, sc) in enumerate(zip(names, s, n, score))]}
