"""Machine learning: AutoML v2, batch prediction, explanations, fairness and feature selection."""
from __future__ import annotations

import os
import tempfile
import time
from typing import Any, Literal

import numpy as np
import optuna
import pandas as pd
import pyarrow as pa
import pyarrow.parquet as pq
from pydantic import BaseModel, Field
from sklearn.base import clone
from sklearn.calibration import CalibratedClassifierCV, calibration_curve
from sklearn.dummy import DummyClassifier, DummyRegressor
from sklearn.ensemble import RandomForestClassifier, RandomForestRegressor, StackingClassifier, StackingRegressor
from sklearn.feature_selection import f_classif, f_regression, mutual_info_classif, mutual_info_regression
from sklearn.inspection import partial_dependence, permutation_importance
from sklearn.linear_model import LogisticRegression, RidgeCV
from sklearn.metrics import confusion_matrix, precision_recall_curve, roc_curve
from sklearn.model_selection import (
    GroupKFold,
    GroupShuffleSplit,
    KFold,
    RepeatedKFold,
    RepeatedStratifiedKFold,
    StratifiedKFold,
    TimeSeriesSplit,
    cross_val_predict,
    cross_val_score,
    train_test_split,
)
from sklearn.tree import DecisionTreeClassifier, DecisionTreeRegressor, export_text

from .. import ml_core as mc
from ..core import EngineError, fingerprint
from ..registry import capability
from ._util import NUMERIC, need

optuna.logging.set_verbosity(optuna.logging.WARNING)


class AutoMLParams(BaseModel):
    target: str
    features: list[str] | None = Field(None, description="Leave empty to use every other column (IDs and constants are left out automatically).")
    task: Literal["auto", "classification", "regression"] = "auto"
    models: list[str] | None = Field(None, description="Model families to try (all suitable ones when empty).")
    metric: Literal["auto", "roc_auc", "f1_macro", "accuracy", "balanced_accuracy", "neg_log_loss", "average_precision", "r2", "neg_root_mean_squared_error", "neg_mean_absolute_error"] = "auto"
    time_budget_s: int = Field(120, ge=5, le=3600, description="Total tuning time across models.")
    max_trials_per_model: int = Field(25, ge=1, le=500)
    cv_folds: int = Field(5, ge=2, le=10)
    cv_repeats: int = Field(1, ge=1, le=10)
    split: Literal["auto", "random", "time", "group"] = "auto"
    time_column: str | None = None
    group_column: str | None = None
    test_size: float = Field(0.2, gt=0.05, lt=0.5)
    balanced: Literal["auto", "on", "off"] = "auto"
    calibrate: Literal["none", "sigmoid", "isotonic"] = "none"
    ensemble: bool = True
    conformal_alpha: float = Field(0.1, gt=0.001, lt=0.5, description="Prediction intervals/sets cover the truth (1 − alpha) of the time.")
    sensitive_features: list[str] | None = Field(None, description="Columns to check fairness across (not used as features unless listed).")
    positive_class: str | None = None
    refit_full: bool = Field(True, description="Refit the champion on all rows for deployment after it's been evaluated.")
    max_rows: int = Field(300_000, ge=100, le=5_000_000)
    name: str | None = Field(None, description="Register the model under this name (versions are numbered).")


def _task(y: pd.Series, requested: str) -> str:
    numeric = pd.api.types.is_numeric_dtype(y)
    distinct = y.nunique()
    continuous = numeric and distinct > 15 and not (y.dropna() % 1 == 0).all()
    if requested == "classification" and continuous:
        return "regression"
    if requested != "auto":
        return requested
    return "regression" if (numeric and distinct > 15) else "classification"


@capability("ml.automl", "ml", "AutoML (train and compare models)",
            "Trains and tunes many model families (linear, elastic net, k-NN, SVM, naive Bayes, random forest, extra trees, histogram GB, XGBoost, LightGBM, CatBoost, neural net) with Optuna on a time budget, adds a stacked ensemble, and picks a champion by cross-validation with confidence intervals and a significance test against the runner-up. Reports full metrics and curves, calibration, conformal prediction intervals, permutation importance, leakage warnings and fairness, and saves the model.",
            AutoMLParams, heavy=True, tags=["ml", "automl"])
def automl(ctx, p: AutoMLParams):  # noqa: C901 - the AutoML flow is one sequence of stages
    started = time.monotonic()
    types = {c["name"]: c["type"] for c in ctx.columns()}
    ctx.require(p.target, p.time_column, p.group_column, *(p.features or []), *(p.sensitive_features or []))
    split = p.split if p.split != "auto" else ("time" if p.time_column else "group" if p.group_column else "random")
    aux = [c for c in [p.time_column, p.group_column] if c]
    feats = p.features or [c for c in ctx.column_names() if c != p.target and c not in aux and c not in (p.sensitive_features or [])]
    need(bool(feats), "No feature columns to train on.")
    cols = list(dict.fromkeys([p.target, *feats, *aux, *(p.sensitive_features or [])]))
    df = ctx.frame(cols, max_rows=p.max_rows)
    df = df[df[p.target].notna()].reset_index(drop=True)
    need(len(df) >= 30, "Need at least 30 rows with a target value.")
    y = df[p.target]
    task = _task(y, p.task)
    if task == "classification":
        y = y.astype(str)
        counts = y.value_counts()
        need(len(counts) >= 2, "The target has only one class.")
        rare = counts[counts < 2]
        if len(rare):
            ctx.note(f"Dropped {int(rare.sum())} row(s) of classes seen only once.")
            keep = ~y.isin(rare.index)
            df, y = df[keep].reset_index(drop=True), y[keep].reset_index(drop=True)
    else:
        y = pd.to_numeric(y, errors="coerce")
    X = df[feats]
    roles = mc.column_roles(X, types)
    if roles["dropped"]:
        ctx.note(f"Left out {', '.join(roles['dropped'])} (constant, empty or ID-like).")
    used = [c for c in feats if c not in roles["dropped"]]
    need(bool(used), "Every feature was constant, empty or an ID.")
    X = X[used]
    classes = sorted(y.unique()) if task == "classification" else None
    binary = task == "classification" and len(classes) == 2
    positive = (p.positive_class if p.positive_class in (classes or []) else (classes[1] if binary else None)) if binary else None
    imbalance = float(y.value_counts(normalize=True).min()) if task == "classification" else None
    balanced = p.balanced == "on" or (p.balanced == "auto" and imbalance is not None and imbalance < 0.2)
    if balanced:
        ctx.note("Classes are imbalanced, so models weight the rarer classes more.")

    # ---- split ----
    ctx.progress(0.02, "Splitting the data")
    groups = df[p.group_column].astype(str) if split == "group" else None
    if split == "time":
        order = np.argsort(pd.to_datetime(df[p.time_column], errors="coerce").fillna(pd.Timestamp.min).to_numpy(), kind="stable")
        cut = int(len(order) * (1 - p.test_size))
        tr, te = order[:cut], order[cut:]
    elif split == "group":
        tr, te = next(GroupShuffleSplit(1, test_size=p.test_size, random_state=ctx.seed).split(X, y, groups))
    else:
        tr, te = train_test_split(np.arange(len(X)), test_size=p.test_size, random_state=ctx.seed, stratify=y if task == "classification" else None)
    Xtr, Xte, ytr, yte = X.iloc[tr], X.iloc[te], y.iloc[tr], y.iloc[te]
    need(len(Xtr) >= 20 and len(Xte) >= 5, "Too few rows to split into training and test sets.")
    if split == "time":
        cv = TimeSeriesSplit(n_splits=p.cv_folds)
    elif split == "group":
        cv = GroupKFold(n_splits=min(p.cv_folds, groups.iloc[tr].nunique()))
    elif task == "classification":
        cv = RepeatedStratifiedKFold(n_splits=p.cv_folds, n_repeats=p.cv_repeats, random_state=ctx.seed) if p.cv_repeats > 1 else StratifiedKFold(p.cv_folds, shuffle=True, random_state=ctx.seed)
    else:
        cv = RepeatedKFold(n_splits=p.cv_folds, n_repeats=p.cv_repeats, random_state=ctx.seed) if p.cv_repeats > 1 else KFold(p.cv_folds, shuffle=True, random_state=ctx.seed)
    gtr = groups.iloc[tr] if groups is not None else None
    scoring = mc.scorer_name(task, binary, p.metric)
    if scoring == "roc_auc" and not binary:
        scoring = "roc_auc_ovr"
    n_test_fold = len(Xtr) // p.cv_folds

    def cv_scores(est) -> np.ndarray:
        return cross_val_score(est, Xtr, ytr, cv=cv, scoring=scoring, groups=gtr, error_score="raise")

    base = DummyClassifier(strategy="prior") if task == "classification" else DummyRegressor()
    base_scores = cross_val_score(mc.Pipeline([("prep", mc.preprocessor(roles, False, task, ctx.seed)), ("model", base)]), Xtr, ytr, cv=cv, scoring=scoring, groups=gtr)

    # ---- search ----
    families = [f for f in (p.models or mc.available(task, len(Xtr))) if f in mc.available(task, len(Xtr))]
    need(bool(families), "None of the chosen model families can be used for this task.")
    budget = p.time_budget_s / len(families)
    board = []
    for i, fam in enumerate(families):
        ctx.progress(0.05 + 0.6 * i / len(families), f"Tuning {mc.LABELS[fam]}")
        study = optuna.create_study(direction="maximize", sampler=optuna.samplers.TPESampler(seed=ctx.seed))

        def objective(trial, fam=fam):
            ctx.check()
            params = {} if trial.number == 0 else mc.suggest(trial, fam, task)
            s = cv_scores(mc.pipeline(roles, fam, task, params, ctx.seed, balanced))
            trial.set_user_attr("scores", s.tolist())
            trial.set_user_attr("params", params)
            return float(s.mean())

        t0 = time.monotonic()
        try:
            study.optimize(objective, n_trials=p.max_trials_per_model, timeout=budget, catch=(ValueError, np.linalg.LinAlgError))
        except EngineError:
            raise
        except Exception as err:  # noqa: BLE001 - one family failing mustn't stop the others
            board.append({"family": fam, "label": mc.LABELS[fam], "error": str(err).splitlines()[0]})
            continue
        done = [t for t in study.trials if t.value is not None]
        if not done:
            board.append({"family": fam, "label": mc.LABELS[fam], "error": "no trial finished"})
            continue
        best = max(done, key=lambda t: t.value)
        s = np.array(best.user_attrs["scores"])
        board.append({"family": fam, "label": mc.LABELS[fam], "cvMean": float(s.mean()), "cvSd": float(s.std(ddof=1)) if len(s) > 1 else 0.0,
                      "cvCi": mc.ci_from_folds(s, len(Xtr) - n_test_fold, n_test_fold), "foldScores": s.tolist(),
                      "params": best.user_attrs["params"], "trials": len(done), "seconds": round(time.monotonic() - t0, 1)})
    ranked = sorted([b for b in board if "cvMean" in b], key=lambda b: -b["cvMean"])
    need(bool(ranked), "Every model family failed: " + "; ".join(f"{b['label']}: {b.get('error')}" for b in board))

    if p.ensemble and len(ranked) >= 3:
        ctx.progress(0.7, "Building a stacked ensemble")
        top = ranked[:3]
        est = [(b["family"], mc.pipeline(roles, b["family"], task, b["params"], ctx.seed, balanced)) for b in top]
        stack = (StackingClassifier(est, final_estimator=LogisticRegression(max_iter=2000), cv=3, stack_method="auto")
                 if task == "classification" else StackingRegressor(est, final_estimator=RidgeCV(), cv=3))
        try:
            s = cv_scores(stack)
            ranked.append({"family": "stacked", "label": f"Stacked ensemble ({', '.join(b['label'] for b in top)})", "cvMean": float(s.mean()),
                           "cvSd": float(s.std(ddof=1)), "cvCi": mc.ci_from_folds(s, len(Xtr) - n_test_fold, n_test_fold), "foldScores": s.tolist(),
                           "params": {"members": [b["family"] for b in top]}, "trials": 1, "estimator": stack})
            ranked.sort(key=lambda b: -b["cvMean"])
        except Exception as err:  # noqa: BLE001
            ctx.note(f"The stacked ensemble couldn't be built ({str(err).splitlines()[0]}).")

    champ = ranked[0]
    model = champ.pop("estimator", None) or mc.pipeline(roles, champ["family"], task, champ["params"], ctx.seed, balanced)
    for b in ranked:
        b.pop("estimator", None)
    comparison = None
    if len(ranked) > 1 and len(ranked[1]["foldScores"]) == len(champ["foldScores"]):
        comparison = {"runnerUp": ranked[1]["label"], **mc.corrected_ttest(np.array(champ["foldScores"]), np.array(ranked[1]["foldScores"]), len(Xtr) - n_test_fold, n_test_fold)}
        comparison["significant"] = bool(comparison["p"] is not None and comparison["p"] < 0.05)
        if not comparison["significant"]:
            ctx.note(f"The champion isn't significantly better than {ranked[1]['label']} (corrected t-test p = {comparison['p']:.2f}); either is a sound choice.")

    # ---- final fit and test ----
    ctx.progress(0.75, "Testing the champion on held-out data")
    model.fit(Xtr, ytr)
    if task == "classification" and p.calibrate != "none":
        model = CalibratedClassifierCV(model, method=p.calibrate, cv=3).fit(Xtr, ytr)
    pred = model.predict(Xte)
    proba = model.predict_proba(Xte) if task == "classification" and hasattr(model, "predict_proba") else None
    test = mc.metrics(task, yte, pred, proba, classes, positive)
    base_fit = clone(base).fit(np.zeros((len(ytr), 1)), ytr)
    baseline_test = mc.metrics(task, yte, base_fit.predict(np.zeros((len(yte), 1))), base_fit.predict_proba(np.zeros((len(yte), 1))) if task == "classification" else None, classes, positive)
    out: dict[str, Any] = {
        "task": task, "target": p.target, "classes": classes, "positiveClass": positive, "scoring": scoring, "split": split,
        "rows": {"train": len(Xtr), "test": len(Xte)}, "features": {"used": used, **{k: v for k, v in roles.items() if v}},
        "leaderboard": ranked + [b for b in board if "error" in b], "baseline": {"cvMean": float(base_scores.mean()), "test": baseline_test},
        "champion": {"family": champ["family"], "label": champ["label"], "params": champ["params"], "cvMean": champ["cvMean"], "cvCi": champ["cvCi"],
                     "calibrated": p.calibrate if task == "classification" else None},
        "comparison": comparison, "test": test,
    }
    # ---- curves ----
    if task == "classification":
        cm = confusion_matrix(yte, pred, labels=classes)
        out["confusionMatrix"] = {"labels": classes, "matrix": cm.tolist()}
        if binary and proba is not None:
            pidx = classes.index(positive)
            score = proba[:, pidx]
            yb = (yte.to_numpy() == positive).astype(int)
            fpr, tpr, _ = roc_curve(yb, score)
            prec, rec, _ = precision_recall_curve(yb, score)
            take = lambda n: np.unique(np.linspace(0, n - 1, min(200, n)).astype(int))  # noqa: E731
            out["roc"] = [{"fpr": float(fpr[i]), "tpr": float(tpr[i])} for i in take(len(fpr))]
            out["pr"] = [{"recall": float(rec[i]), "precision": float(prec[i])} for i in take(len(rec))]
            frac, mean_pred = calibration_curve(yb, score, n_bins=10, strategy="quantile")
            out["calibration"] = {"bins": [{"predicted": float(a), "observed": float(b)} for a, b in zip(mean_pred, frac)],
                                  "ece": float(np.mean(np.abs(frac - mean_pred)))}
            order = np.argsort(-score)
            base_rate = yb.mean()
            out["lift"] = [{"decile": k + 1, "rate": float(yb[c].mean()), "lift": float(yb[c].mean() / base_rate) if base_rate else None,
                            "cumulativeGain": float(yb[order[: (k + 1) * len(order) // 10]].sum() / max(1, yb.sum()))}
                           for k, c in enumerate(np.array_split(order, 10))]
            thresholds = []
            for th in np.round(np.arange(0.05, 0.96, 0.05), 2):
                pb = (score >= th).astype(int)
                tp, fp, fn = int(((pb == 1) & (yb == 1)).sum()), int(((pb == 1) & (yb == 0)).sum()), int(((pb == 0) & (yb == 1)).sum())
                pr_, rc_ = (tp / (tp + fp) if tp + fp else 0.0), (tp / (tp + fn) if tp + fn else 0.0)
                thresholds.append({"threshold": float(th), "precision": pr_, "recall": rc_, "f1": 2 * pr_ * rc_ / (pr_ + rc_) if pr_ + rc_ else 0.0, "flagged": int(pb.sum())})
            out["thresholds"] = thresholds
            out["bestF1Threshold"] = max(thresholds, key=lambda t: t["f1"])["threshold"]
    else:
        res = yte.to_numpy(float) - np.asarray(pred, float)
        take = np.unique(np.linspace(0, len(res) - 1, min(400, len(res))).astype(int))
        out["residuals"] = {"mean": float(res.mean()), "sd": float(res.std(ddof=1)), "points": [{"predicted": float(pred[i]), "actual": float(yte.iloc[i]), "residual": float(res[i])} for i in take]}
    # ---- importance ----
    ctx.progress(0.82, "Permutation importance")
    imp_n = min(len(Xte), 3000)
    pi = permutation_importance(model, Xte.iloc[:imp_n], yte.iloc[:imp_n], n_repeats=5, random_state=ctx.seed, scoring=scoring)
    out["importance"] = sorted([{"feature": f, "importance": float(m), "ci": [float(m - 1.96 * s / np.sqrt(5)), float(m + 1.96 * s / np.sqrt(5))]}
                                for f, m, s in zip(used, pi.importances_mean, pi.importances_std)], key=lambda r: -r["importance"])
    # ---- conformal ----
    ctx.progress(0.88, "Conformal calibration")
    conformal = None
    try:
        oof_cv = KFold(5, shuffle=True, random_state=ctx.seed)
        champion_est = clone(model.estimator if isinstance(model, CalibratedClassifierCV) else model)
        n = len(Xtr)
        level = min(1.0, np.ceil((n + 1) * (1 - p.conformal_alpha)) / n)
        if task == "regression":
            oof = cross_val_predict(champion_est, Xtr, ytr, cv=oof_cv)
            qhat = float(np.quantile(np.abs(ytr.to_numpy(float) - oof), level))
            cover = float(np.mean(np.abs(yte.to_numpy(float) - np.asarray(pred, float)) <= qhat))
            conformal = {"alpha": p.conformal_alpha, "halfWidth": qhat, "testCoverage": cover}
        elif proba is not None:
            oof = cross_val_predict(champion_est, Xtr, ytr, cv=StratifiedKFold(5, shuffle=True, random_state=ctx.seed), method="predict_proba")
            idx = np.array([classes.index(v) for v in ytr])
            qhat = float(np.quantile(1 - oof[np.arange(len(idx)), idx], level))
            sets = (1 - proba) <= qhat
            tidx = np.array([classes.index(v) for v in yte])
            conformal = {"alpha": p.conformal_alpha, "threshold": qhat, "testCoverage": float(sets[np.arange(len(tidx)), tidx].mean()),
                         "averageSetSize": float(sets.sum(axis=1).mean())}
    except Exception as err:  # noqa: BLE001 - intervals are extra; the model still stands
        ctx.note(f"Conformal intervals couldn't be computed ({str(err).splitlines()[0]}).")
    out["conformal"] = conformal
    # ---- fairness ----
    if p.sensitive_features:
        out["fairness"] = _fairness(task, df.iloc[te], yte, pred, proba, classes, positive, p.sensitive_features)
    # ---- leakage ----
    try:
        import model_extras

        out["leakage"] = model_extras.leakage_warnings(Xtr, ytr, task, p.target)
    except Exception:  # noqa: BLE001
        out["leakage"] = []
    # ---- save ----
    ctx.progress(0.94, "Saving the model")
    final = model
    if p.refit_full:
        final = clone(model).fit(X, y)
    meta = {"name": p.name, "task": task, "target": p.target, "features": used, "featureTypes": {c: types.get(c) for c in used},
            "classes": classes, "positiveClass": positive, "family": champ["family"], "label": champ["label"], "params": champ["params"],
            "scoring": scoring, "cvMean": champ["cvMean"], "testMetrics": test, "conformal": conformal,
            "threshold": out.get("bestF1Threshold") if binary else None, "trainedOn": {"dataset": ctx.dataset_id, "fingerprint": ctx.dataset["fingerprint"],
            "rows": len(X), "refitOnAllRows": p.refit_full}, "seed": ctx.seed, "paramsFingerprint": fingerprint(p.model_dump()),
            "reference": _reference_profile(X, used, types)}
    record = ctx.models.save(final, meta)
    out["model"] = {"id": record["id"], "name": record.get("name"), "version": record.get("version")}
    out["seconds"] = round(time.monotonic() - started, 1)
    return out


def _reference_profile(X: pd.DataFrame, used: list[str], types: dict) -> dict:
    """Training distributions kept with the model, for drift monitoring later."""
    prof = {}
    for c in used:
        s = X[c]
        if types.get(c) in NUMERIC:
            v = pd.to_numeric(s, errors="coerce").dropna()
            if len(v):
                prof[c] = {"kind": "numeric", "quantiles": np.quantile(v, np.linspace(0, 1, 11)).tolist(), "mean": float(v.mean()), "sd": float(v.std())}
        else:
            vc = s.astype(str).value_counts(normalize=True).head(50)
            prof[c] = {"kind": "categorical", "shares": vc.to_dict()}
    return prof


def _fairness(task, frame, y_true, y_pred, proba, classes, positive, sensitive) -> list[dict]:
    out = []
    for col in sensitive:
        groups = frame[col].astype(str).to_numpy()
        rows = []
        for g in sorted(set(groups)):
            m = groups == g
            if m.sum() < 5:
                continue
            yt, yp = y_true.to_numpy()[m], np.asarray(y_pred)[m]
            row = {"group": g, "n": int(m.sum())}
            if task == "regression":
                row.update(mae=float(np.mean(np.abs(yt.astype(float) - yp.astype(float)))), meanPrediction=float(np.mean(yp.astype(float))))
            else:
                row["accuracy"] = float(np.mean(yt == yp))
                if positive is not None:
                    pos_t, pos_p = yt == positive, yp == positive
                    row.update(selectionRate=float(pos_p.mean()), tpr=float(pos_p[pos_t].mean()) if pos_t.any() else None,
                               fpr=float(pos_p[~pos_t].mean()) if (~pos_t).any() else None)
            rows.append(row)
        summary = {}
        if rows and task != "regression" and positive is not None:
            sr = [r["selectionRate"] for r in rows]
            tprs = [r["tpr"] for r in rows if r["tpr"] is not None]
            fprs = [r["fpr"] for r in rows if r["fpr"] is not None]
            summary = {"demographicParityDifference": max(sr) - min(sr), "disparateImpactRatio": (min(sr) / max(sr)) if max(sr) > 0 else None,
                       "equalizedOddsDifference": max((max(tprs) - min(tprs)) if tprs else 0, (max(fprs) - min(fprs)) if fprs else 0)}
            summary["passesFourFifthsRule"] = summary["disparateImpactRatio"] is None or summary["disparateImpactRatio"] >= 0.8
        elif rows and task == "regression":
            maes = [r["mae"] for r in rows]
            summary = {"maeGap": max(maes) - min(maes)}
        out.append({"feature": col, "groups": rows, "summary": summary})
    return out


def _model_frame(ctx, model_id: str, extra: list[str] | None = None, max_rows: int | None = None):
    pipeline, meta = ctx.models.load(model_id)
    missing = [c for c in meta["features"] if c not in ctx.column_names()]
    need(not missing, f"The data is missing feature column(s) the model needs: {', '.join(missing)}.")
    cols = list(dict.fromkeys(meta["features"] + [c for c in (extra or []) if c]))
    return pipeline, meta, ctx.frame(cols, max_rows=max_rows)


class PredictParams(BaseModel):
    model_id: str
    keep_columns: list[str] | None = Field(None, description="Columns to carry into the output (all when empty).")
    intervals: bool = True
    batch_rows: int = Field(100_000, ge=1000, le=1_000_000)
    name: str | None = None


@capability("ml.predict", "ml", "Score data with a model (batch)",
            "Scores a whole dataset with a saved model in batches — predictions, class probabilities, and conformal prediction intervals or sets — and saves the scored dataset.",
            PredictParams, heavy=True, tags=["ml", "scoring", "big data"])
def predict(ctx, p: PredictParams):
    pipeline, meta = ctx.models.load(p.model_id)
    missing = [c for c in meta["features"] if c not in ctx.column_names()]
    need(not missing, f"The data is missing feature column(s) the model needs: {', '.join(missing)}.")
    keep = p.keep_columns if p.keep_columns is not None else ctx.column_names()
    ctx.require(*keep)
    n = ctx.dataset["rows"]
    out_path = tempfile.NamedTemporaryFile(suffix=".parquet", delete=False).name
    writer = None
    conf = meta.get("conformal") if p.intervals else None
    classes = meta.get("classes")
    try:
        for start in range(0, n, p.batch_rows):
            ctx.progress(start / max(1, n), f"Scored {start:,} of {n:,} rows")
            cols = ", ".join('"' + c.replace('"', '""') + '"' for c in dict.fromkeys(keep + meta["features"]))
            chunk = ctx.sql(f"SELECT {cols} FROM data LIMIT {p.batch_rows} OFFSET {start}")
            X = chunk[meta["features"]]
            res = chunk[keep].copy()
            pred = pipeline.predict(X)
            res["prediction"] = pred
            if meta["task"] == "classification" and hasattr(pipeline, "predict_proba"):
                proba = pipeline.predict_proba(X)
                for k, c in enumerate(classes):
                    res[f"probability_{c}"] = proba[:, k]
                if conf and "threshold" in conf:
                    res["prediction_set"] = [" | ".join(c for c, keep_ in zip(classes, row) if keep_) for row in (1 - proba) <= conf["threshold"]]
            elif meta["task"] == "regression" and conf and "halfWidth" in conf:
                res["lower"] = np.asarray(pred, float) - conf["halfWidth"]
                res["upper"] = np.asarray(pred, float) + conf["halfWidth"]
            table = pa.Table.from_pandas(res, preserve_index=False)
            if writer is None:
                writer = pq.ParquetWriter(out_path, table.schema, compression="zstd")
            writer.write_table(table.cast(writer.schema))
    finally:
        if writer:
            writer.close()
    if writer is None:
        os.unlink(out_path)
        raise EngineError("The dataset has no rows to score.")
    ds = ctx.datasets.ingest_parquet(out_path, p.name or f"{ctx.dataset['name']} – scored", {"kind": "scored", "model": p.model_id, "from": ctx.dataset_id})
    if conf:
        ctx.note(f"Intervals/sets are calibrated to cover the truth {1 - conf['alpha']:.0%} of the time (test coverage {conf['testCoverage']:.1%}).")
    return {"dataset": ds, "model": {"id": p.model_id, "name": meta.get("name"), "version": meta.get("version")}, "rows": n}


class ExplainParams(BaseModel):
    model_id: str
    rows: list[int] | None = Field(None, description="Row positions to explain individually (the first 5 when empty).")
    sample: int = Field(500, ge=50, le=5000)
    pdp_features: list[str] | None = Field(None, description="Features for partial dependence (top 4 by importance when empty).")
    surrogate_depth: int = Field(3, ge=1, le=6)


def _source(name: str, features: list[str]) -> str:
    raw = name.split("__", 1)[1] if "__" in name else name
    best = ""
    for f in features:
        if (raw == f or raw.startswith(f + "_") or raw.startswith(f + "__")) and len(f) > len(best):
            best = f
    return best or raw


@capability("ml.explain", "ml", "Explain a model",
            "Why a model predicts what it does: SHAP importance (global) and per-row reasons (local), partial dependence and ICE curves, and a small decision-tree surrogate with its fidelity.",
            ExplainParams, heavy=True, tags=["ml", "explainability"])
def explain(ctx, p: ExplainParams):  # noqa: C901
    import shap

    pipeline, meta, df = _model_frame(ctx, p.model_id, max_rows=max(p.sample, 2000))
    feats = meta["features"]
    X = df[feats]
    S = X.sample(min(p.sample, len(X)), random_state=ctx.seed)
    task = meta["task"]
    inner = pipeline.estimator if isinstance(pipeline, CalibratedClassifierCV) else pipeline
    out: dict[str, Any] = {"model": {"id": p.model_id, "label": meta.get("label")}}
    ctx.progress(0.1, "SHAP values")
    # SHAP: fast exact TreeExplainer on the transformed features for tree models, otherwise a permutation explainer.
    try:
        prep, est = inner.named_steps["prep"], inner.named_steps["model"]
        base_est = getattr(est, "estimator_", est)
        names = list(prep.get_feature_names_out())
        Z = prep.transform(S)
        tree_like = meta["family"] in ("random_forest", "extra_trees", "xgboost", "lightgbm", "catboost", "hist_gradient_boosting")
        if tree_like and meta["family"] != "hist_gradient_boosting":
            expl = shap.TreeExplainer(base_est)
            sv = expl.shap_values(Z)
        else:
            f = (lambda A: base_est.predict_proba(A)) if task == "classification" else base_est.predict
            expl = shap.PermutationExplainer(f, shap.maskers.Independent(Z[:100]), seed=ctx.seed)
            sv = expl(Z[: min(200, len(Z))]).values
        sv = np.asarray(sv)
        if sv.ndim == 3:  # (rows, features, classes): explain the positive (or top) class
            cls = meta["classes"].index(meta["positiveClass"]) if meta.get("positiveClass") in (meta.get("classes") or []) else -1
            sv = sv[:, :, cls] if sv.shape[1] == len(names) else sv[:, cls, :]
        src = [_source(n, feats) for n in names]
        agg = pd.DataFrame(np.abs(sv), columns=names).T.groupby(src).sum().T
        signed = pd.DataFrame(sv, columns=names).T.groupby(src).sum().T
        out["shapGlobal"] = sorted([{"feature": c, "meanAbsShap": float(agg[c].mean())} for c in agg.columns], key=lambda r: -r["meanAbsShap"])
        rows = p.rows or list(range(min(5, len(S))))
        local = []
        for r in rows:
            if r >= len(signed):
                continue
            contrib = signed.iloc[r].sort_values(key=lambda v: -v.abs())
            local.append({"row": int(r), "values": {f: S.iloc[r][f] for f in feats[:50]},
                          "reasons": [{"feature": k, "contribution": float(v)} for k, v in contrib.head(5).items()]})
        out["local"] = local
        out["shapMethod"] = "TreeExplainer (exact)" if tree_like and meta["family"] != "hist_gradient_boosting" else "Permutation explainer"
    except Exception as err:  # noqa: BLE001
        ctx.note(f"SHAP values couldn't be computed ({str(err).splitlines()[0]}); see partial dependence instead.")
    # Partial dependence and ICE.
    ctx.progress(0.6, "Partial dependence")
    top = p.pdp_features or [r["feature"] for r in out.get("shapGlobal", [])[:4]] or feats[:4]
    pdp = []
    for f in top:
        if f not in feats:
            continue
        try:
            cat = meta["featureTypes"].get(f) not in NUMERIC
            kw = {"categorical_features": [f]} if cat else {}
            res = partial_dependence(pipeline, S, [f], kind="both", grid_resolution=20, **kw)
            grid = res["grid_values"][0]
            avg = res["average"]
            k = (meta["classes"].index(meta["positiveClass"]) if meta.get("positiveClass") else 0) if task == "classification" and avg.shape[0] > 1 else 0
            ice = res["individual"][k][:30]
            pdp.append({"feature": f, "grid": [x if isinstance(x, str) else float(x) for x in grid], "average": avg[k].tolist(), "ice": ice.tolist()})
        except Exception as err:  # noqa: BLE001
            ctx.note(f"No partial dependence for {f} ({str(err).splitlines()[0]}).")
    out["partialDependence"] = pdp
    # Surrogate tree.
    ctx.progress(0.85, "Surrogate tree")
    try:
        prep = inner.named_steps["prep"]
        Z = prep.transform(S)
        target = pipeline.predict(S)
        tree = (DecisionTreeClassifier if task == "classification" else DecisionTreeRegressor)(max_depth=p.surrogate_depth, random_state=ctx.seed).fit(Z, target)
        fidelity = float(tree.score(Z, target))
        out["surrogate"] = {"depth": p.surrogate_depth, "fidelity": fidelity, "fidelityMeaning": "accuracy" if task == "classification" else "R²",
                            "rules": export_text(tree, feature_names=[n.split("__", 1)[-1] for n in prep.get_feature_names_out()], max_depth=p.surrogate_depth)}
    except Exception as err:  # noqa: BLE001
        ctx.note(f"No surrogate tree ({str(err).splitlines()[0]}).")
    return out


class FairnessParams(BaseModel):
    model_id: str
    target: str
    sensitive_features: list[str] = Field(..., min_length=1)


@capability("ml.fairness", "ml", "Fairness audit",
            "Compares a model's accuracy, selection rate, true- and false-positive rates (or error, for regression) across groups, with demographic parity, equalised odds, the disparate-impact ratio and the four-fifths rule.",
            FairnessParams, tags=["ml", "fairness", "governance"])
def fairness(ctx, p: FairnessParams):
    pipeline, meta, df = _model_frame(ctx, p.model_id, [p.target, *p.sensitive_features])
    df = df[df[p.target].notna()]
    y = df[p.target].astype(str) if meta["task"] == "classification" else pd.to_numeric(df[p.target], errors="coerce")
    pred = pipeline.predict(df[meta["features"]])
    proba = pipeline.predict_proba(df[meta["features"]]) if meta["task"] == "classification" else None
    return {"model": {"id": p.model_id, "label": meta.get("label")}, "rows": len(df),
            "fairness": _fairness(meta["task"], df, y, pred, proba, meta.get("classes"), meta.get("positiveClass"), p.sensitive_features)}


class SelectParams(BaseModel):
    target: str
    features: list[str] | None = None
    max_rows: int = Field(100_000, ge=100, le=1_000_000)
    shadow_rounds: int = Field(10, ge=3, le=50)
    redundancy: float = Field(0.9, gt=0.5, le=1)


@capability("ml.feature_selection", "ml", "Feature selection",
            "Ranks features by mutual information, univariate tests and random-forest importance, runs a Boruta-style test against shuffled 'shadow' copies, flags redundant (highly correlated) pairs, and recommends a set.",
            SelectParams, heavy=True, tags=["ml", "features"])
def feature_selection(ctx, p: SelectParams):
    types = {c["name"]: c["type"] for c in ctx.columns()}
    feats = p.features or [c for c in ctx.column_names() if c != p.target]
    ctx.require(p.target, *feats)
    df = ctx.frame([p.target, *feats], max_rows=p.max_rows)
    df = df[df[p.target].notna()]
    task = _task(df[p.target], "auto")
    y = df[p.target].astype(str) if task == "classification" else pd.to_numeric(df[p.target], errors="coerce")
    X = pd.DataFrame(index=df.index)
    for c in feats:
        X[c] = pd.to_numeric(df[c], errors="coerce") if types.get(c) in NUMERIC else df[c].astype("category").cat.codes.replace(-1, np.nan)
    X = X.fillna(X.median(numeric_only=True)).fillna(0)
    disc = [types.get(c) not in NUMERIC for c in feats]
    mi = (mutual_info_classif if task == "classification" else mutual_info_regression)(X, y, discrete_features=disc, random_state=ctx.seed)
    fstat, fp = (f_classif if task == "classification" else f_regression)(X, y)
    Forest = RandomForestClassifier if task == "classification" else RandomForestRegressor
    rf = Forest(n_estimators=300, random_state=ctx.seed, n_jobs=-1).fit(X, y)
    hits = np.zeros(len(feats))
    for r in range(p.shadow_rounds):
        ctx.progress(r / p.shadow_rounds, f"Shadow round {r + 1}")
        shadow = X.apply(lambda s: ctx.rng.permutation(s.to_numpy()))
        shadow.columns = [f"shadow_{c}" for c in feats]
        m = Forest(n_estimators=150, random_state=ctx.seed + r, n_jobs=-1, max_depth=12).fit(pd.concat([X, shadow], axis=1), y)
        imp = m.feature_importances_
        hits += imp[: len(feats)] > imp[len(feats):].max()
    corr = X.corr(method="spearman").abs()
    redundant = [{"a": feats[i], "b": feats[j], "spearman": float(corr.iloc[i, j])} for i in range(len(feats)) for j in range(i + 1, len(feats)) if corr.iloc[i, j] >= p.redundancy]
    table = sorted([{"feature": f, "mutualInformation": float(m), "fStatistic": float(s) if np.isfinite(s) else None, "fP": float(pv) if np.isfinite(pv) else None,
                     "forestImportance": float(i), "beatsShadowShare": float(h / p.shadow_rounds), "confirmed": bool(h / p.shadow_rounds >= 0.6)}
                    for f, m, s, pv, i, h in zip(feats, mi, fstat, fp, rf.feature_importances_, hits)], key=lambda r: -r["forestImportance"])
    drop = {min((r["a"], r["b"]), key=lambda f: next(t["forestImportance"] for t in table if t["feature"] == f)) for r in redundant}
    recommended = [r["feature"] for r in table if r["confirmed"] and r["feature"] not in drop]
    return {"task": task, "rows": len(X), "features": table, "redundantPairs": redundant, "recommended": recommended}

