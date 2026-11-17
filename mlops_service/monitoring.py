"""Data drift between a model's training data and new data.

For each feature: a statistical test (Kolmogorov-Smirnov for numbers,
chi-squared for categories), the Population Stability Index (PSI) with bins
taken from the training data, the change in missing values, and values never
seen in training. PSI bands follow common practice: under 0.1 stable,
0.1-0.25 moderate shift, over 0.25 major shift.
"""

from __future__ import annotations

import math
from typing import Any

import numpy as np
import pandas as pd
import scipy.stats as st

EPS = 1e-4


class DriftError(ValueError):
    pass


def psi(expected: np.ndarray, actual: np.ndarray) -> float:
    """PSI from two arrays of bin proportions (each summing to 1)."""
    e = np.clip(expected, EPS, None)
    a = np.clip(actual, EPS, None)
    return float(np.sum((a - e) * np.log(a / e)))


def _band(value: float) -> str:
    return "stable" if value < 0.1 else "moderate" if value < 0.25 else "major"


def _numeric(ref: pd.Series, cur: pd.Series, bins: int = 10) -> dict[str, Any]:
    r, c = ref.dropna().astype(float), cur.dropna().astype(float)
    if len(r) < 5 or len(c) < 5:
        return {"type": "numeric", "skipped": "Fewer than 5 values on one side."}
    edges = np.unique(np.quantile(r, np.linspace(0, 1, bins + 1)))
    if len(edges) < 3:
        edges = np.array([r.min() - 0.5, r.min() + 0.5, r.max() + 0.5]) if r.min() == r.max() else np.linspace(r.min(), r.max(), 3)
    edges[0], edges[-1] = -np.inf, np.inf
    rp = np.histogram(r, edges)[0] / len(r)
    cp = np.histogram(c, edges)[0] / len(c)
    ks, p = st.ks_2samp(r, c)
    value = psi(rp, cp)
    return {
        "type": "numeric",
        "test": "Kolmogorov–Smirnov", "statistic": round(float(ks), 4), "pValue": float(f"{p:.6g}"),
        "psi": round(value, 4), "level": _band(value),
        "reference": {"mean": round(float(r.mean()), 4), "median": round(float(r.median()), 4), "min": round(float(r.min()), 4), "max": round(float(r.max()), 4)},
        "current": {"mean": round(float(c.mean()), 4), "median": round(float(c.median()), 4), "min": round(float(c.min()), 4), "max": round(float(c.max()), 4)},
        "outsideTrainingRange": int(((c < r.min()) | (c > r.max())).sum()),
    }


def _categorical(ref: pd.Series, cur: pd.Series) -> dict[str, Any]:
    r, c = ref.dropna().astype(str), cur.dropna().astype(str)
    if len(r) < 5 or len(c) < 5:
        return {"type": "categorical", "skipped": "Fewer than 5 values on one side."}
    cats = sorted(set(r) | set(c))
    rc = r.value_counts().reindex(cats, fill_value=0)
    cc = c.value_counts().reindex(cats, fill_value=0)
    value = psi((rc / len(r)).to_numpy(), (cc / len(c)).to_numpy())
    table = np.vstack([rc.to_numpy(), cc.to_numpy()])
    table = table[:, table.sum(axis=0) > 0]
    if table.shape[1] >= 2:
        chi2, p, *_ = st.chi2_contingency(table)
    else:
        chi2, p = 0.0, 1.0
    unseen = sorted(set(c) - set(r))
    shifts = sorted(
        ({"value": k, "reference": round(float(rc[k] / len(r)), 4), "current": round(float(cc[k] / len(c)), 4)} for k in cats),
        key=lambda x: -abs(x["current"] - x["reference"]),
    )[:5]
    return {
        "type": "categorical",
        "test": "Chi-squared", "statistic": round(float(chi2), 4), "pValue": float(f"{p:.6g}"),
        "psi": round(value, 4), "level": _band(value),
        "unseenValues": unseen[:10], "unseenRows": int(c.isin(unseen).sum()),
        "largestShifts": shifts,
    }


def compare(reference: list[dict[str, Any]], current: list[dict[str, Any]], features: list[str], alpha: float = 0.05) -> dict[str, Any]:
    if not reference or not current:
        raise DriftError("Both the training data and the new data are needed.")
    ref, cur = pd.DataFrame(reference), pd.DataFrame(current)
    missing = [f for f in features if f not in cur.columns]
    report = []
    for f in features:
        if f not in ref.columns:
            continue
        if f not in cur.columns:
            report.append({"feature": f, "missingColumn": True, "level": "major"})
            continue
        is_num = pd.api.types.is_numeric_dtype(ref[f]) and not pd.api.types.is_bool_dtype(ref[f])
        cur_col = pd.to_numeric(cur[f], errors="coerce") if is_num else cur[f]
        item = _numeric(ref[f], cur_col) if is_num else _categorical(ref[f], cur[f])
        item["feature"] = f
        item["missingRate"] = {"reference": round(float(ref[f].isna().mean()), 4), "current": round(float(cur[f].isna().mean()), 4)}
        if "pValue" in item:
            item["significant"] = bool(item["pValue"] < alpha)
        report.append(item)
    order = {"major": 0, "moderate": 1, "stable": 2}
    report.sort(key=lambda x: (order.get(x.get("level", "stable"), 3), -x.get("psi", 0) if isinstance(x.get("psi"), (int, float)) and not math.isnan(x.get("psi", 0)) else 0))
    counts = {k: sum(1 for x in report if x.get("level") == k) for k in ("major", "moderate", "stable")}
    return {
        "referenceRows": int(len(ref)), "currentRows": int(len(cur)),
        "features": report, "summary": counts, "missingColumns": missing,
        "overall": "major" if counts["major"] else "moderate" if counts["moderate"] else "stable",
        "method": "PSI with 10 bins from the training data (numbers) or per category; KS / chi-squared tests at the given level.",
    }
