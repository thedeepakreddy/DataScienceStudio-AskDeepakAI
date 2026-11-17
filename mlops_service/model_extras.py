"""Leakage-safe data splits, hyperparameter tuning and leakage warnings for /train.

Kept apart from main.py so each piece can be tested on its own.
"""

from __future__ import annotations

from typing import Any, Literal

import numpy as np
import pandas as pd
from scipy.stats import loguniform, randint, uniform
from sklearn.model_selection import (
    GroupKFold,
    GroupShuffleSplit,
    KFold,
    RandomizedSearchCV,
    StratifiedKFold,
    TimeSeriesSplit,
    train_test_split,
)

SplitStrategy = Literal["random", "time", "group"]


class SplitError(ValueError):
    pass


def build_split(
    df: pd.DataFrame,
    X: pd.DataFrame,
    y: pd.Series,
    *,
    task: str,
    strategy: SplitStrategy,
    test_size: float,
    cv_folds: int,
    random_state: int,
    time_column: str | None = None,
    group_column: str | None = None,
) -> dict[str, Any]:
    """Returns the train/test split and a matching cross-validation splitter.

    - random: shuffled (stratified for classification).
    - time:   rows sorted by time; the most recent rows are the test set and
              cross-validation only ever trains on the past (no look-ahead).
    - group:  all rows of a group (e.g. one customer) stay on the same side,
              so the model is tested on groups it has never seen.
    """
    info: dict[str, Any] = {"strategy": strategy, "testSize": test_size, "seed": random_state}
    groups_train = None

    if strategy == "time":
        if not time_column or time_column not in df.columns:
            raise SplitError("Choose the date/time column to split by.")
        times = pd.to_datetime(df.loc[X.index, time_column], errors="coerce", utc=True)
        if times.isna().mean() > 0.2:
            raise SplitError(f"More than 20% of “{time_column}” couldn’t be read as dates.")
        order = times.sort_values(kind="stable").index
        order = [i for i in order if pd.notna(times.loc[i])]
        n_test = max(1, int(round(len(order) * test_size)))
        train_idx, test_idx = order[:-n_test], order[-n_test:]
        X_train, X_test, y_train, y_test = X.loc[train_idx], X.loc[test_idx], y.loc[train_idx], y.loc[test_idx]
        cv = TimeSeriesSplit(n_splits=max(2, min(cv_folds, len(train_idx) // 10 or 2)))
        info.update({
            "timeColumn": time_column,
            "trainUntil": str(times.loc[train_idx[-1]].date()) if len(train_idx) else None,
            "testFrom": str(times.loc[test_idx[0]].date()),
            "testTo": str(times.loc[test_idx[-1]].date()),
        })
    elif strategy == "group":
        if not group_column or group_column not in df.columns:
            raise SplitError("Choose the column that identifies groups (for example a customer ID).")
        groups = df.loc[X.index, group_column].astype(str)
        n_groups = groups.nunique()
        if n_groups < 4:
            raise SplitError(f"“{group_column}” has only {n_groups} groups; a group split needs at least 4.")
        gss = GroupShuffleSplit(n_splits=1, test_size=test_size, random_state=random_state)
        tr, te = next(gss.split(X, y, groups))
        X_train, X_test, y_train, y_test = X.iloc[tr], X.iloc[te], y.iloc[tr], y.iloc[te]
        groups_train = groups.iloc[tr].to_numpy()
        cv = GroupKFold(n_splits=max(2, min(cv_folds, len(set(groups_train)))))
        info.update({"groupColumn": group_column, "trainGroups": int(len(set(groups_train))), "testGroups": int(groups.iloc[te].nunique())})
    else:
        stratify = y if (task == "classification" and y.value_counts().min() >= 2) else None
        try:
            X_train, X_test, y_train, y_test = train_test_split(X, y, test_size=test_size, random_state=random_state, stratify=stratify)
        except ValueError:
            X_train, X_test, y_train, y_test = train_test_split(X, y, test_size=test_size, random_state=random_state)
        folds = cv_folds
        if task == "classification":
            folds = max(2, min(cv_folds, int(y_train.value_counts().min())))
        if len(X_train) > 5000:
            folds = min(folds, 3)
        cv = (StratifiedKFold(n_splits=folds, shuffle=True, random_state=random_state)
              if task == "classification" else KFold(n_splits=folds, shuffle=True, random_state=random_state))

    if len(X_train) < 10 or len(X_test) < 2:
        raise SplitError("Too few rows on one side of the split; use a larger dataset or a different test size.")
    if task == "classification" and y_train.nunique() < 2:
        raise SplitError("The training rows contain only one class after this split.")
    info.update({"trainRows": int(len(X_train)), "testRows": int(len(X_test))})
    return {"X_train": X_train, "X_test": X_test, "y_train": y_train, "y_test": y_test,
            "cv": cv, "groups_train": groups_train, "info": info}


# Search spaces are over the pipeline step "model". XGBoost classifiers are
# wrapped (see LabelEncodedClassifier), hence the base_estimator prefix.
def search_space(model_key: str, task: str) -> dict[str, Any] | None:
    if model_key == "linear":
        return {"model__C": loguniform(1e-3, 1e2)} if task == "classification" else None
    if model_key == "random_forest":
        return {"model__n_estimators": randint(50, 400), "model__max_depth": [None, 4, 6, 8, 12, 16],
                "model__min_samples_leaf": randint(1, 10), "model__max_features": ["sqrt", "log2", None]}
    if model_key == "gradient_boosting":
        return {"model__n_estimators": randint(50, 400), "model__max_depth": randint(2, 6),
                "model__learning_rate": loguniform(0.01, 0.3), "model__subsample": uniform(0.6, 0.4)}
    if model_key == "xgboost":
        p = "model__base_estimator__" if task == "classification" else "model__"
        return {f"{p}n_estimators": randint(50, 400), f"{p}max_depth": randint(2, 8),
                f"{p}learning_rate": loguniform(0.01, 0.3), f"{p}subsample": uniform(0.6, 0.4),
                f"{p}colsample_bytree": uniform(0.6, 0.4)}
    if model_key == "mlp":
        return {"model__alpha": loguniform(1e-5, 1e-1), "model__learning_rate_init": loguniform(1e-4, 1e-2),
                "model__hidden_layer_sizes": [(32,), (64,), (64, 32), (128, 64)]}
    return None


def tune(pipeline, model_key: str, task: str, X_train, y_train, cv, groups, scoring: str, n_iter: int, random_state: int):
    """Randomized search on the training rows only. Returns (best_pipeline, report)."""
    space = search_space(model_key, task)
    if not space:
        return pipeline.fit(X_train, y_train), {"tuned": False, "reason": "This model has no settings worth tuning."}
    search = RandomizedSearchCV(pipeline, space, n_iter=n_iter, cv=cv, scoring=scoring,
                                random_state=random_state, n_jobs=1, refit=True, error_score="raise")
    search.fit(X_train, y_train, groups=groups)
    res = search.cv_results_
    trials = sorted(
        ({"params": {k.split("__")[-1]: _native(v) for k, v in res["params"][i].items()},
          "mean": round(float(res["mean_test_score"][i]), 4), "std": round(float(res["std_test_score"][i]), 4)}
         for i in range(len(res["params"]))),
        key=lambda t: -t["mean"],
    )
    return search.best_estimator_, {
        "tuned": True, "iterations": n_iter, "metric": scoring,
        "bestParams": {k.split("__")[-1]: _native(v) for k, v in search.best_params_.items()},
        "bestCvScore": round(float(search.best_score_), 4),
        "trials": trials,
    }


def _native(v):
    if isinstance(v, (np.integer,)):
        return int(v)
    if isinstance(v, (np.floating,)):
        return round(float(v), 6)
    if isinstance(v, tuple):
        return list(v)
    return v


def leakage_warnings(X_train: pd.DataFrame, y_train: pd.Series, task: str, target: str) -> list[dict[str, str]]:
    """Columns that look like they contain the answer, checked on training rows only."""
    out: list[dict[str, str]] = []
    y = y_train
    y_num = pd.to_numeric(y, errors="coerce") if task == "regression" else None
    for col in X_train.columns:
        s = X_train[col]
        name_hit = target.lower() in col.lower() and col.lower() != target.lower()
        if name_hit:
            out.append({"column": col, "reason": f"Its name contains the target “{target}”."})
            continue
        valid = s.notna() & y.notna()
        if valid.sum() < 10:
            continue
        if pd.api.types.is_numeric_dtype(s) and task == "regression":
            r = np.corrcoef(s[valid].astype(float), y_num[valid])[0, 1] if s[valid].std() > 0 and y_num[valid].std() > 0 else 0
            if abs(r) > 0.98:
                out.append({"column": col, "reason": f"It is almost perfectly correlated with the target (r = {r:.3f})."})
        elif task == "classification":
            sv, yv = s[valid].astype(str), y[valid].astype(str)
            n_vals = sv.nunique()
            if 1 < n_vals <= max(2, len(sv) // 5):
                purity = (pd.crosstab(sv, yv).max(axis=1).sum()) / len(sv)
                if purity >= 0.99 and yv.value_counts(normalize=True).max() < 0.95:
                    out.append({"column": col, "reason": f"Its values predict the target almost perfectly ({purity * 100:.1f}% of training rows)."})
    return out
