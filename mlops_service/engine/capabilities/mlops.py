"""Model monitoring: data drift, prediction drift and performance decay against
what a saved model saw when it was trained."""
from __future__ import annotations

import json
import uuid
from typing import Any, Literal

import numpy as np
import pandas as pd
from pydantic import BaseModel, Field
from scipy import stats

from .. import ml_core as mc
from ..core import now_iso, stamp
from ..registry import capability
from ._util import need

EPS = 1e-4
HIGHER_IS_BETTER = {"r2", "explainedVariance", "accuracy", "balancedAccuracy", "f1Macro", "f1Weighted", "mcc", "precision", "recall", "f1",
                    "rocAuc", "prAuc", "rocAucOvr"}
SCORER_TO_METRIC = {"r2": "r2", "roc_auc": "rocAuc", "f1_macro": "f1Macro", "accuracy": "accuracy", "balanced_accuracy": "balancedAccuracy",
                    "neg_root_mean_squared_error": "rmse", "neg_mean_absolute_error": "mae", "f1": "f1", "average_precision": "prAuc",
                    "neg_log_loss": "logLoss"}


def psi(expected: np.ndarray, actual: np.ndarray) -> float:
    """Population stability index between two share vectors over the same bins."""
    e, a = np.clip(np.asarray(expected, float), EPS, None), np.clip(np.asarray(actual, float), EPS, None)
    e, a = e / e.sum(), a / a.sum()
    return float(np.sum((a - e) * np.log(a / e)))


def numeric_drift(ref: dict[str, Any], values: pd.Series) -> dict[str, Any]:
    q = np.asarray(ref["quantiles"], float)
    v = pd.to_numeric(values, errors="coerce").dropna().to_numpy(float)
    if not len(v):
        return {"kind": "numeric", "psi": None, "status": "no data"}
    # Reference deciles carry 10% each; collapsed (tied) deciles are point masses, binned like the new values.
    edges = np.unique(q[1:-1])
    mids = (q[:-1] + q[1:]) / 2
    exp = np.bincount(np.searchsorted(edges, mids, side="right"), minlength=len(edges) + 1) / 10
    act = np.bincount(np.searchsorted(edges, v, side="right"), minlength=len(edges) + 1) / len(v)
    # KS distance to the reference CDF interpolated through its deciles (approximate: only deciles are stored).
    grid = np.unique(np.concatenate([q, np.quantile(v, np.linspace(0, 1, 51))]))
    f_ref = np.interp(grid, q, np.linspace(0, 1, 11), left=0, right=1)
    f_new = np.searchsorted(np.sort(v), grid, side="right") / len(v)
    d = float(np.max(np.abs(f_new - f_ref)))
    sd = ref.get("sd") or 0
    return {"kind": "numeric", "psi": psi(exp, act), "ks": d, "ksP": float(stats.kstwo.sf(d, len(v))),
            "referenceMean": ref.get("mean"), "currentMean": float(v.mean()),
            "meanShiftSd": float((v.mean() - ref["mean"]) / sd) if sd else None,
            "bins": [{"upTo": float(e) if i < len(edges) else None, "reference": float(x), "current": float(y)}
                     for i, (e, x, y) in enumerate(zip([*edges, np.inf], exp, act))]}


def categorical_drift(ref: dict[str, Any], values: pd.Series) -> dict[str, Any]:
    v = values.dropna().astype(str)
    if not len(v):
        return {"kind": "categorical", "psi": None, "status": "no data"}
    shares = ref["shares"]
    cats = list(shares)
    other_ref = max(0.0, 1 - sum(shares.values()))
    cur = v.value_counts(normalize=True)
    exp = np.array([shares[c] for c in cats] + [other_ref])
    act = np.array([float(cur.get(c, 0)) for c in cats] + [float(cur[~cur.index.isin(cats)].sum())])
    counts = act * len(v)
    expected_counts = np.clip(exp, EPS, None) / np.clip(exp, EPS, None).sum() * len(v)
    chi = stats.chisquare(counts, expected_counts)
    unseen = cur[~cur.index.isin(cats)]
    return {"kind": "categorical", "psi": psi(exp, act), "chiSquareP": float(chi.pvalue),
            "newCategories": [{"value": k, "share": float(s)} for k, s in unseen.head(10).items()] if other_ref < 0.01 else [],
            "shares": [{"value": c, "reference": float(e), "current": float(a)} for c, e, a in zip([*cats, "(other)"], exp, act)]}


def status_of(value: float | None, warn: float, alert: float) -> str:
    if value is None:
        return "no data"
    return "alert" if value >= alert else ("warning" if value >= warn else "ok")


def load_prediction_log(storage, model_id: str, max_rows: int) -> pd.DataFrame:
    rows: list[dict[str, Any]] = []
    for key in reversed(storage.list(f"predlog/{model_id}")):
        rows.extend(json.loads(storage.get(key))["rows"])
        if len(rows) >= max_rows:
            break
    return pd.DataFrame(rows[:max_rows])


class MonitorParams(BaseModel):
    model: str = Field(..., description="Model id, or name@production / name@staging / name@v3.")
    source: Literal["dataset", "prediction_log"] = "dataset"
    target: str | None = Field(None, description="Column with the true outcome, to measure performance decay.")
    psi_warning: float = Field(0.1, gt=0)
    psi_alert: float = Field(0.25, gt=0)
    max_performance_drop: float = Field(0.1, gt=0, lt=1, description="Relative drop in the primary metric that raises an alert.")
    max_rows: int = Field(200_000, ge=50, le=5_000_000)
    save: bool = Field(True, description="Keep the report in the model's monitoring history.")


@capability("mlops.monitor", "mlops", "Monitor a model",
            "Checks a saved model against new data or its live prediction log: data drift per feature (PSI, KS / chi-square, mean shift, missing values, new categories), prediction drift, and — when outcomes are known — performance decay versus its test metrics, with an overall status and alerts.",
            MonitorParams, needs_dataset=False, cacheable=False, tags=["mlops", "drift", "monitoring"])
def monitor(ctx, p: MonitorParams):  # noqa: C901
    from ..mlops_api import resolve_model

    model_id = resolve_model(ctx.models, p.model)
    pipeline, meta = ctx.models.load(model_id)
    reference = meta.get("reference") or {}
    need(bool(reference), "This model has no training reference profile (it was saved by an older engine); retrain it to monitor drift.")
    feats = meta["features"]
    if p.source == "prediction_log":
        df = load_prediction_log(ctx.models.storage, model_id, p.max_rows)
        need(len(df) > 0, "There are no logged predictions for this model yet.")
        source = {"kind": "prediction_log", "rows": len(df)}
    else:
        need(ctx.dataset is not None, "Choose the new data to check (dataset_id), or use source = prediction_log.")
        ctx.require(*[f for f in feats if f in ctx.column_names()], p.target)
        cols = [c for c in dict.fromkeys(feats + ([p.target] if p.target else [])) if c in ctx.column_names()]
        df = ctx.frame(cols, max_rows=p.max_rows)
        source = {"kind": "dataset", "id": ctx.dataset_id, "name": ctx.dataset.get("name"), "rows": len(df)}
    alerts: list[dict[str, Any]] = []
    features = []
    for f in feats:
        ref = reference.get(f)
        if ref is None:
            continue
        if f not in df:
            features.append({"feature": f, "status": "alert", "issue": "missing column"})
            alerts.append({"level": "alert", "kind": "schema", "message": f"Feature “{f}” is missing from the new data."})
            continue
        r = numeric_drift(ref, df[f]) if ref["kind"] == "numeric" else categorical_drift(ref, df[f])
        r["feature"] = f
        r["status"] = status_of(r.get("psi"), p.psi_warning, p.psi_alert)
        miss = float(df[f].isna().mean())
        r["missing"] = {"reference": ref.get("missing"), "current": miss}
        if ref.get("missing") is not None and miss - ref["missing"] > 0.1:
            r["status"] = "alert"
            alerts.append({"level": "alert", "kind": "missing", "message": f"“{f}” is missing in {miss:.0%} of rows (was {ref['missing']:.0%})."})
        if r["status"] in ("warning", "alert") and r.get("psi") is not None:
            alerts.append({"level": r["status"], "kind": "data drift", "message": f"“{f}” has drifted (PSI {r['psi']:.2f})."})
        features.append(r)
    features.sort(key=lambda r: -(r.get("psi") or 0))
    ctx.progress(0.5, "Scoring the new data")
    X = df[[f for f in feats if f in df]].copy()
    for f in feats:
        if f not in X:
            X[f] = np.nan
    X = X[feats]
    out: dict[str, Any] = {"model": {"id": model_id, "name": meta.get("name"), "version": meta.get("version"), "stage": meta.get("stage")},
                           "source": source, "features": features}
    pred = proba = None
    try:
        pred = pipeline.predict(X)
        proba = pipeline.predict_proba(X) if meta["task"] == "classification" and hasattr(pipeline, "predict_proba") else None
    except Exception as err:  # noqa: BLE001 - a scoring failure is itself a finding
        alerts.append({"level": "alert", "kind": "scoring", "message": f"The model couldn't score the new data: {str(err).splitlines()[0]}"})
    pref = meta.get("predictionReference")
    if pred is not None and pref:
        if pref["kind"] == "numeric":
            pdrift = numeric_drift(pref, pd.Series(np.asarray(pred, float)))
        else:
            pdrift = categorical_drift(pref, pd.Series(np.asarray(pred).astype(str)))
            if proba is not None and pref.get("positiveProbability"):
                classes = meta["classes"]
                k = classes.index(meta["positiveClass"]) if meta.get("positiveClass") in classes else 1
                pdrift["positiveProbability"] = numeric_drift(pref["positiveProbability"], pd.Series(proba[:, k]))
        pdrift["status"] = status_of(pdrift.get("psi"), p.psi_warning, p.psi_alert)
        if pdrift["status"] != "ok":
            alerts.append({"level": pdrift["status"], "kind": "prediction drift", "message": f"The model's predictions have shifted (PSI {pdrift['psi']:.2f})."})
        out["predictionDrift"] = pdrift
    if p.target and pred is not None and p.target in df:
        y = df[p.target]
        keep = y.notna().to_numpy()
        if keep.sum() >= 10:
            if meta["task"] == "classification":
                yt = y[keep].astype(str).to_numpy()
                now = mc.metrics("classification", yt, np.asarray(pred)[keep].astype(str), proba[keep] if proba is not None else None,
                                 meta.get("classes"), meta.get("positiveClass"))
            else:
                now = mc.metrics("regression", pd.to_numeric(y[keep], errors="coerce").to_numpy(float), np.asarray(pred, float)[keep])
            ref_metrics = meta.get("testMetrics") or {}
            primary = SCORER_TO_METRIC.get(meta.get("scoring", ""), "r2" if meta["task"] == "regression" else "accuracy")
            perf = {"rows": int(keep.sum()), "current": now, "reference": ref_metrics, "primaryMetric": primary}
            if primary in now and ref_metrics.get(primary) is not None:
                a, b = float(ref_metrics[primary]), float(now[primary])
                drop = (a - b) / abs(a) if primary in HIGHER_IS_BETTER else (b - a) / abs(a)
                drop = drop if abs(a) > 1e-12 else 0.0
                perf["relativeDrop"] = drop
                perf["status"] = "alert" if drop > p.max_performance_drop else ("warning" if drop > p.max_performance_drop / 2 else "ok")
                if perf["status"] != "ok":
                    alerts.append({"level": perf["status"], "kind": "performance", "message": f"{primary} fell from {a:.3f} to {b:.3f} ({drop:.0%} worse)."})
            out["performance"] = perf
    drifted = [f for f in features if f.get("status") in ("warning", "alert")]
    out["summary"] = {"featuresChecked": len(features), "featuresDrifted": len(drifted), "driftShare": len(drifted) / max(1, len(features)),
                      "status": "alert" if any(a["level"] == "alert" for a in alerts) else ("warning" if alerts else "ok")}
    out["alerts"] = alerts
    out["checkedAt"] = now_iso()
    if p.save:
        report_id = stamp() + "_" + uuid.uuid4().hex[:6]
        compact = {k: out[k] for k in ("model", "source", "summary", "alerts", "checkedAt")}
        compact["topFeatures"] = [{"feature": f["feature"], "psi": f.get("psi"), "status": f.get("status")} for f in features[:10]]
        if "performance" in out:
            compact["performance"] = {k: out["performance"].get(k) for k in ("primaryMetric", "relativeDrop", "status")}
        ctx.models.storage.put(f"monitoring/{model_id}/{report_id}.json", json.dumps(compact, default=str).encode())
        out["reportId"] = report_id
    return out

