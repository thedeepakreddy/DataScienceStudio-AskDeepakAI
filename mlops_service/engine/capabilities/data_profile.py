"""Profiling at scale and estimates from samples.

Profiles are computed inside DuckDB over the whole dataset, so they work on
data much larger than memory; only correlations use a seeded sample (noted).
"""
from __future__ import annotations

import math
from typing import Literal

import numpy as np
from pydantic import BaseModel, Field
from scipy import stats

from ..registry import capability
from ._util import NUMERIC, need, q

PATTERNS = {
    "email": r"^[^@\s]+@[^@\s]+\.[A-Za-z]{2,}$",
    "url": r"^https?://",
    "phone": r"^\+?[\d\s().-]{7,}$",
    "number_as_text": r"^-?\d+(\.\d+)?$",
}


class ProfileParams(BaseModel):
    columns: list[str] | None = Field(None, description="Columns to profile (all when empty).")
    top_values: int = Field(10, ge=1, le=100)
    histogram_bins: int = Field(20, ge=2, le=200)
    correlation_sample: int = Field(200_000, ge=1000, le=5_000_000)


@capability("data.profile", "data", "Profile the data",
            "Every column's type, missing values, distinct count, statistics, histogram, top values and patterns, plus duplicates and correlations — computed over the whole dataset.",
            ProfileParams, heavy=True, tags=["eda", "quality"])
def profile(ctx, p: ProfileParams):
    meta_cols = ctx.columns()
    cols = [c for c in meta_cols if not p.columns or c["name"] in p.columns]
    ctx.require(*(p.columns or []))
    n = ctx.dataset["rows"]
    out_cols = []
    for i, c in enumerate(cols):
        ctx.progress(i / max(1, len(cols)) * 0.85, f"Profiling {c['name']}")
        name, kind = c["name"], c["type"]
        base = ctx.sql(f"SELECT count({q(name)}) AS present, approx_count_distinct({q(name)}) AS distinct_approx FROM data").iloc[0]
        present = int(base["present"])
        info = {"name": name, "type": kind, "count": present, "missing": n - present,
                "missingShare": (n - present) / n if n else 0.0, "distinct": int(base["distinct_approx"])}
        if kind in NUMERIC and present:
            s = ctx.sql(
                f"SELECT avg(v) mean, stddev_samp(v) sd, min(v) mn, quantile_cont(v, 0.01) p01, quantile_cont(v, 0.25) q1, "
                f"median(v) med, quantile_cont(v, 0.75) q3, quantile_cont(v, 0.99) p99, max(v) mx, skewness(v) skew, kurtosis(v) kurt, "
                f"sum(CASE WHEN v = 0 THEN 1 ELSE 0 END) zeros, sum(CASE WHEN v < 0 THEN 1 ELSE 0 END) negatives, sum(v) total "
                f"FROM (SELECT CAST({q(name)} AS DOUBLE) v FROM data WHERE {q(name)} IS NOT NULL)").iloc[0]
            iqr = s["q3"] - s["q1"]
            lo, hi = s["q1"] - 1.5 * iqr, s["q3"] + 1.5 * iqr
            outliers = int(ctx.sql(f"SELECT count(*) c FROM data WHERE CAST({q(name)} AS DOUBLE) < {lo} OR CAST({q(name)} AS DOUBLE) > {hi}").iloc[0]["c"]) if np.isfinite(iqr) else 0
            hist = []
            if s["mx"] > s["mn"]:
                width = (s["mx"] - s["mn"]) / p.histogram_bins
                h = ctx.sql(f"SELECT least(floor((CAST({q(name)} AS DOUBLE) - {s['mn']}) / {width}), {p.histogram_bins - 1}) b, count(*) n "
                            f"FROM data WHERE {q(name)} IS NOT NULL GROUP BY 1 ORDER BY 1")
                counts = dict(zip(h["b"].astype(int), h["n"].astype(int)))
                hist = [{"from": s["mn"] + b * width, "to": s["mn"] + (b + 1) * width, "count": counts.get(b, 0)} for b in range(p.histogram_bins)]
            info.update(mean=s["mean"], sd=s["sd"], min=s["mn"], p01=s["p01"], q1=s["q1"], median=s["med"], q3=s["q3"], p99=s["p99"],
                        max=s["mx"], skewness=s["skew"], kurtosis=s["kurt"], zeros=int(s["zeros"]), negatives=int(s["negatives"]),
                        sum=s["total"], outliersIqr=outliers, histogram=hist)
        elif kind in ("date", "datetime") and present:
            s = ctx.sql(f"SELECT min({q(name)}) mn, max({q(name)}) mx FROM data").iloc[0]
            per = ctx.sql(f"SELECT date_trunc('month', {q(name)}) m, count(*) n FROM data WHERE {q(name)} IS NOT NULL GROUP BY 1 ORDER BY 1 LIMIT 600")
            info.update(min=s["mn"], max=s["mx"], perMonth=[{"month": r.m, "count": int(r.n)} for r in per.itertuples()])
        if kind not in NUMERIC and present:
            top = ctx.sql(f"SELECT CAST({q(name)} AS VARCHAR) v, count(*) n FROM data WHERE {q(name)} IS NOT NULL GROUP BY 1 ORDER BY n DESC, v LIMIT {p.top_values}")
            info["topValues"] = [{"value": r.v, "count": int(r.n), "share": int(r.n) / present} for r in top.itertuples()]
            if kind == "text":
                pat = ", ".join(f"avg(CASE WHEN regexp_matches(v, '{rx}') THEN 1 ELSE 0 END) AS {k}" for k, rx in PATTERNS.items())
                s = ctx.sql(f"SELECT avg(length(v)) avg_len, max(length(v)) max_len, {pat}, "
                            f"avg(CASE WHEN v <> trim(v) THEN 1 ELSE 0 END) padded FROM (SELECT CAST({q(name)} AS VARCHAR) v FROM data WHERE {q(name)} IS NOT NULL)").iloc[0]
                info.update(avgLength=s["avg_len"], maxLength=int(s["max_len"]), patterns={k: s[k] for k in PATTERNS}, paddedShare=s["padded"])
        info["flags"] = _flags(info, n)
        out_cols.append(info)
    ctx.progress(0.88, "Checking duplicates")
    all_cols = ", ".join(q(c["name"]) for c in meta_cols)
    dup = int(ctx.sql(f"SELECT count(*) - count(DISTINCT ({all_cols})) d FROM data").iloc[0]["d"]) if meta_cols else 0
    ctx.progress(0.92, "Correlations")
    num = [c["name"] for c in cols if c["type"] in NUMERIC][:40]
    corr = None
    if len(num) >= 2:
        df = ctx.frame(num, max_rows=p.correlation_sample).astype(float)
        m = df.corr(method="pearson")
        sm = df.corr(method="spearman")
        pairs = []
        for a in range(len(num)):
            for b in range(a + 1, len(num)):
                r, rs = m.iloc[a, b], sm.iloc[a, b]
                if np.isfinite(r):
                    pairs.append({"a": num[a], "b": num[b], "pearson": r, "spearman": rs})
        pairs.sort(key=lambda x: -abs(x["pearson"]))
        corr = {"columns": num, "pearson": m.values.tolist(), "spearman": sm.values.tolist(), "strongest": pairs[:15]}
    return {"rows": n, "columnCount": len(meta_cols), "duplicateRows": dup, "columns": out_cols, "correlations": corr}


def _flags(info, n):
    f = []
    if n and info["missingShare"] > 0.3:
        f.append("many_missing")
    if info["count"] and info["distinct"] <= 1:
        f.append("constant")
    if info["type"] == "text" and n and info["distinct"] >= 0.95 * info["count"] and info["count"] > 20:
        f.append("id_like")
    if info.get("skewness") is not None and abs(info["skewness"] or 0) > 2:
        f.append("skewed")
    if info.get("outliersIqr") and info["count"] and info["outliersIqr"] / info["count"] > 0.05:
        f.append("many_outliers")
    if info.get("patterns", {}).get("number_as_text", 0) > 0.95:
        f.append("numbers_stored_as_text")
    if info.get("paddedShare", 0) > 0.01:
        f.append("extra_spaces")
    return f


class EstimateParams(BaseModel):
    column: str
    statistic: Literal["mean", "proportion", "total"] = "mean"
    sample_size: int = Field(10_000, ge=30, le=5_000_000)
    confidence: float = Field(0.95, gt=0.5, lt=1)
    value: str | None = Field(None, description="For a proportion: the value whose share is estimated.")
    compare_exact: bool = True


@capability("data.estimate", "data", "Estimate from a sample",
            "A fast estimate of a mean, proportion or total from a random sample, with a confidence interval (finite-population corrected), and the exact value for comparison.",
            EstimateParams, tags=["sampling", "big data"])
def estimate(ctx, p: EstimateParams):
    ctx.require(p.column)
    N = ctx.dataset["rows"]
    df = ctx.frame([p.column], max_rows=p.sample_size)
    s = df[p.column].dropna()
    need(len(s) >= 2, "Too few values to estimate from.")
    z = stats.norm.ppf(0.5 + p.confidence / 2)
    n = len(df)
    fpc = math.sqrt(max(0.0, (N - n) / (N - 1))) if N > 1 else 0.0
    if p.statistic == "proportion":
        need(p.value is not None, "Choose the value whose share to estimate.")
        x = (s.astype(str) == str(p.value)).astype(float)
    else:
        x = s.astype(float)
    est = x.mean()
    se = x.std(ddof=1) / math.sqrt(len(x)) * fpc
    out = {"statistic": p.statistic, "sampleRows": n, "populationRows": N, "estimate": est, "standardError": se,
           "ci": [est - z * se, est + z * se], "confidence": p.confidence}
    if p.statistic == "total":
        scale = N * (len(s) / n)
        out.update(estimate=est * scale, standardError=se * scale, ci=[(est - z * se) * scale, (est + z * se) * scale])
    if p.compare_exact:
        col = q(p.column)
        if p.statistic == "mean":
            exact = ctx.sql(f"SELECT avg(CAST({col} AS DOUBLE)) v FROM data").iloc[0]["v"]
        elif p.statistic == "total":
            exact = ctx.sql(f"SELECT sum(CAST({col} AS DOUBLE)) v FROM data").iloc[0]["v"]
        else:
            exact = ctx.sql(f"SELECT avg(CASE WHEN CAST({col} AS VARCHAR) = '{str(p.value).replace(chr(39), chr(39) * 2)}' THEN 1.0 ELSE 0.0 END) v FROM data WHERE {col} IS NOT NULL").iloc[0]["v"]
        out["exact"] = exact
        out["exactInsideCi"] = bool(out["ci"][0] <= exact <= out["ci"][1])
    return out
