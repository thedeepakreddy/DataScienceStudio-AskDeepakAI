"""Machine learning building blocks: column typing, automatic feature engineering,
model families with search spaces, metrics, and conformal calibration."""
from __future__ import annotations

import warnings
from typing import Any

import numpy as np
import pandas as pd
from sklearn.base import BaseEstimator, ClassifierMixin, TransformerMixin, clone
from sklearn.compose import ColumnTransformer
from sklearn.decomposition import TruncatedSVD
from sklearn.ensemble import (
    ExtraTreesClassifier,
    ExtraTreesRegressor,
    HistGradientBoostingClassifier,
    HistGradientBoostingRegressor,
    RandomForestClassifier,
    RandomForestRegressor,
)
from sklearn.feature_extraction.text import TfidfVectorizer
from sklearn.impute import SimpleImputer
from sklearn.linear_model import ElasticNet, LogisticRegression, Ridge
from sklearn.metrics import (
    accuracy_score,
    average_precision_score,
    balanced_accuracy_score,
    brier_score_loss,
    explained_variance_score,
    f1_score,
    log_loss,
    matthews_corrcoef,
    mean_absolute_error,
    mean_absolute_percentage_error,
    mean_squared_error,
    median_absolute_error,
    precision_score,
    r2_score,
    recall_score,
    roc_auc_score,
)
from sklearn.naive_bayes import GaussianNB
from sklearn.neighbors import KNeighborsClassifier, KNeighborsRegressor
from sklearn.neural_network import MLPClassifier, MLPRegressor
from sklearn.pipeline import Pipeline
from sklearn.preprocessing import LabelEncoder, OneHotEncoder, StandardScaler, TargetEncoder
from sklearn.svm import SVC, SVR

warnings.filterwarnings("ignore", category=UserWarning, module="lightgbm")

try:
    from xgboost import XGBClassifier, XGBRegressor
except ImportError:  # pragma: no cover
    XGBClassifier = XGBRegressor = None
try:
    from lightgbm import LGBMClassifier, LGBMRegressor
except ImportError:  # pragma: no cover
    LGBMClassifier = LGBMRegressor = None
try:
    from catboost import CatBoostClassifier, CatBoostRegressor
except ImportError:  # pragma: no cover
    CatBoostClassifier = CatBoostRegressor = None


# ---------------------------------------------------------------- feature engineering
class DateParts(TransformerMixin, BaseEstimator):
    """Dates and timestamps become year, month, weekday, day of year, hour and cyclical month/weekday."""

    def fit(self, X, y=None):
        self.columns_ = list(X.columns)
        return self

    def transform(self, X):
        out = {}
        for c in self.columns_:
            d = pd.to_datetime(X[c], errors="coerce")
            out[f"{c}__year"] = d.dt.year
            out[f"{c}__month"] = d.dt.month
            out[f"{c}__weekday"] = d.dt.weekday
            out[f"{c}__dayofyear"] = d.dt.dayofyear
            out[f"{c}__hour"] = d.dt.hour
            out[f"{c}__month_sin"] = np.sin(2 * np.pi * (d.dt.month - 1) / 12)
            out[f"{c}__month_cos"] = np.cos(2 * np.pi * (d.dt.month - 1) / 12)
            out[f"{c}__weekday_sin"] = np.sin(2 * np.pi * d.dt.weekday / 7)
            out[f"{c}__weekday_cos"] = np.cos(2 * np.pi * d.dt.weekday / 7)
        return pd.DataFrame(out, index=X.index).astype(float)

    def get_feature_names_out(self, input_features=None):
        return np.array([f"{c}__{p}" for c in self.columns_ for p in ("year", "month", "weekday", "dayofyear", "hour", "month_sin", "month_cos", "weekday_sin", "weekday_cos")])


class PairwiseProducts(TransformerMixin, BaseEstimator):
    """Products of every pair of numeric columns (after median imputation), for interaction effects."""

    def fit(self, X, y=None):
        self.columns_ = list(X.columns)
        self.medians_ = X.apply(pd.to_numeric, errors="coerce").median().fillna(0).to_dict()
        self.pairs_ = [(a, b) for i, a in enumerate(self.columns_) for b in self.columns_[i + 1:]]
        return self

    def transform(self, X):
        Z = X.apply(pd.to_numeric, errors="coerce").fillna(self.medians_)
        return pd.DataFrame({f"{a}*{b}": Z[a] * Z[b] for a, b in self.pairs_}, index=X.index).astype(float)

    def get_feature_names_out(self, input_features=None):
        return np.array([f"{a}*{b}" for a, b in self.pairs_])


MAX_INTERACTION_COLUMNS = 15


class TextColumn(TransformerMixin, BaseEstimator):
    """A free-text column becomes TF-IDF compressed to a few dense dimensions."""

    def __init__(self, components: int = 20, seed: int = 0):
        self.components = components
        self.seed = seed

    def fit(self, X, y=None):
        text = X.iloc[:, 0].fillna("").astype(str)
        self.name_ = X.columns[0]
        self.vec_ = TfidfVectorizer(max_features=5000, min_df=2, ngram_range=(1, 2), sublinear_tf=True)
        M = self.vec_.fit_transform(text)
        k = max(1, min(self.components, M.shape[1] - 1, M.shape[0] - 1))
        self.svd_ = TruncatedSVD(n_components=k, random_state=self.seed).fit(M)
        return self

    def transform(self, X):
        return self.svd_.transform(self.vec_.transform(X.iloc[:, 0].fillna("").astype(str)))

    def get_feature_names_out(self, input_features=None):
        return np.array([f"{self.name_}__text{i}" for i in range(self.svd_.n_components)])


class LabelEncoded(ClassifierMixin, BaseEstimator):
    """Wraps classifiers that need 0..k-1 labels (XGBoost, LightGBM) so any labels work."""

    def __init__(self, estimator=None):
        self.estimator = estimator

    def fit(self, X, y, **kw):
        self.le_ = LabelEncoder().fit(y)
        self.estimator_ = clone(self.estimator).fit(X, self.le_.transform(y), **kw)
        self.classes_ = self.le_.classes_
        return self

    def predict(self, X):
        return self.le_.inverse_transform(np.asarray(self.estimator_.predict(X)).astype(int).ravel())

    def predict_proba(self, X):
        return self.estimator_.predict_proba(X)

    @property
    def feature_importances_(self):
        return self.estimator_.feature_importances_


_DATE_TEXT = r"^\d{4}-\d{1,2}-\d{1,2}([ T]\d{1,2}:\d{2}(:\d{2})?)?$|^\d{1,2}/\d{1,2}/\d{2,4}$"


def _looks_like_dates(s: pd.Series) -> bool:
    """Text that holds dates (2024-01-31, 31/01/2024, …) is treated as a date."""
    v = s.dropna().astype(str).head(500)
    if not len(v) or not v.str.match(_DATE_TEXT).mean() >= 0.95:
        return False
    return pd.to_datetime(v, errors="coerce", format="mixed").notna().mean() >= 0.95


def column_roles(X: pd.DataFrame, types: dict[str, str]) -> dict[str, list[str]]:
    """Sorts feature columns into numeric, boolean, date, low/high-cardinality categorical and free text."""
    roles: dict[str, list[str]] = {"numeric": [], "date": [], "low_card": [], "high_card": [], "text": [], "dropped": []}
    n = len(X)
    for c in X.columns:
        t = types.get(c, "text")
        s = X[c]
        if s.notna().sum() == 0 or s.nunique(dropna=True) <= 1:
            roles["dropped"].append(c)
        elif t in ("integer", "number") or pd.api.types.is_numeric_dtype(s) and not pd.api.types.is_bool_dtype(s):
            roles["numeric"].append(c)
        elif t in ("date", "datetime") or pd.api.types.is_datetime64_any_dtype(s) or _looks_like_dates(s):
            roles["date"].append(c)
        else:
            nun = s.nunique(dropna=True)
            avg_len = s.dropna().astype(str).str.len().mean()
            if nun >= 0.9 * s.notna().sum() and avg_len < 40 and n > 50:
                roles["dropped"].append(c)  # an ID: unique per row, carries no signal
            elif avg_len >= 40 and nun > 50:
                roles["text"].append(c)
            elif nun > 30:
                roles["high_card"].append(c)
            else:
                roles["low_card"].append(c)
    return roles


def preprocessor(roles: dict[str, list[str]], scale: bool, task: str, seed: int, interactions: bool = False) -> ColumnTransformer:
    parts = []
    if roles["numeric"]:
        steps = [("impute", SimpleImputer(strategy="median", add_indicator=True))]
        if scale:
            steps.append(("scale", StandardScaler()))
        parts.append(("num", Pipeline(steps), roles["numeric"]))
    if interactions and 2 <= len(roles["numeric"]) <= MAX_INTERACTION_COLUMNS:
        steps = [("products", PairwiseProducts())]
        if scale:
            steps.append(("scale", StandardScaler()))
        parts.append(("inter", Pipeline(steps), roles["numeric"]))
    if roles["low_card"]:
        parts.append(("cat", Pipeline([("impute", SimpleImputer(strategy="constant", fill_value="(missing)")),
                                       ("onehot", OneHotEncoder(handle_unknown="ignore", min_frequency=5, sparse_output=False))]), roles["low_card"]))
    if roles["high_card"]:
        # Cross-fitted target encoding: each row's encoding never uses its own target.
        steps = [("impute", SimpleImputer(strategy="constant", fill_value="(missing)")),
                 ("te", TargetEncoder(target_type="continuous" if task == "regression" else "auto", random_state=seed))]
        if scale:
            steps.append(("scale", StandardScaler()))
        parts.append(("te", Pipeline(steps), roles["high_card"]))
    if roles["date"]:
        steps = [("parts", DateParts()), ("impute", SimpleImputer(strategy="median"))]
        if scale:
            steps.append(("scale", StandardScaler()))
        parts.append(("date", Pipeline(steps), roles["date"]))
    for c in roles["text"]:
        parts.append((f"text_{c}", TextColumn(seed=seed), [c]))
    return ColumnTransformer(parts, remainder="drop", sparse_threshold=0, verbose_feature_names_out=True)


# ---------------------------------------------------------------- model families
SCALED = {"linear", "elastic_net", "knn", "svm", "mlp", "naive_bayes"}
FAMILIES = ["linear", "elastic_net", "knn", "svm", "naive_bayes", "random_forest", "extra_trees", "hist_gradient_boosting",
            "xgboost", "lightgbm", "catboost", "mlp"]
LABELS = {"linear": "Linear / logistic regression", "elastic_net": "Elastic net", "knn": "k-nearest neighbours", "svm": "Support vector machine",
          "naive_bayes": "Naive Bayes", "random_forest": "Random forest", "extra_trees": "Extra trees",
          "hist_gradient_boosting": "Histogram gradient boosting", "xgboost": "XGBoost", "lightgbm": "LightGBM", "catboost": "CatBoost",
          "mlp": "Neural network (MLP)", "stacked": "Stacked ensemble"}


def available(task: str, n_rows: int) -> list[str]:
    out = []
    for f in FAMILIES:
        if f == "naive_bayes" and task == "regression":
            continue
        if f == "elastic_net" and task != "regression":
            continue
        if f == "svm" and n_rows > 15_000:
            continue  # kernel SVMs scale quadratically
        if f == "xgboost" and XGBClassifier is None or f == "lightgbm" and LGBMClassifier is None or f == "catboost" and CatBoostClassifier is None:
            continue
        out.append(f)
    return out


def make_model(family: str, task: str, params: dict[str, Any], seed: int, balanced: bool) -> Any:
    clf = task != "regression"
    cw = "balanced" if (balanced and clf) else None
    p = dict(params)
    if family == "linear":
        return LogisticRegression(max_iter=3000, C=p.get("C", 1.0), class_weight=cw) if clf else Ridge(alpha=p.get("alpha", 1.0))
    if family == "elastic_net":
        return ElasticNet(alpha=p.get("alpha", 0.01), l1_ratio=p.get("l1_ratio", 0.5), max_iter=5000, random_state=seed)
    if family == "knn":
        k = p.get("n_neighbors", 15)
        return KNeighborsClassifier(n_neighbors=k, weights=p.get("weights", "distance")) if clf else KNeighborsRegressor(n_neighbors=k, weights=p.get("weights", "distance"))
    if family == "svm":
        return SVC(C=p.get("C", 1.0), gamma=p.get("gamma", "scale"), probability=True, class_weight=cw, random_state=seed) if clf else SVR(C=p.get("C", 1.0), gamma=p.get("gamma", "scale"))
    if family == "naive_bayes":
        return GaussianNB(var_smoothing=p.get("var_smoothing", 1e-9))
    if family in ("random_forest", "extra_trees"):
        cls = {("random_forest", True): RandomForestClassifier, ("random_forest", False): RandomForestRegressor,
               ("extra_trees", True): ExtraTreesClassifier, ("extra_trees", False): ExtraTreesRegressor}[(family, clf)]
        kw = dict(n_estimators=p.get("n_estimators", 300), max_depth=p.get("max_depth"), min_samples_leaf=p.get("min_samples_leaf", 1),
                  max_features=p.get("max_features", "sqrt" if clf else 1.0), random_state=seed, n_jobs=-1)
        if clf:
            kw["class_weight"] = cw
        return cls(**kw)
    if family == "hist_gradient_boosting":
        kw = dict(learning_rate=p.get("learning_rate", 0.1), max_leaf_nodes=p.get("max_leaf_nodes", 31), l2_regularization=p.get("l2", 0.0),
                  max_iter=p.get("max_iter", 300), early_stopping=True, random_state=seed)
        return HistGradientBoostingClassifier(class_weight=cw, **kw) if clf else HistGradientBoostingRegressor(**kw)
    if family == "xgboost":
        kw = dict(n_estimators=p.get("n_estimators", 300), max_depth=p.get("max_depth", 6), learning_rate=p.get("learning_rate", 0.1),
                  subsample=p.get("subsample", 1.0), colsample_bytree=p.get("colsample_bytree", 1.0), reg_lambda=p.get("reg_lambda", 1.0),
                  tree_method="hist", random_state=seed, n_jobs=2, verbosity=0)
        return LabelEncoded(XGBClassifier(eval_metric="logloss", **kw)) if clf else XGBRegressor(**kw)
    if family == "lightgbm":
        kw = dict(n_estimators=p.get("n_estimators", 300), num_leaves=p.get("num_leaves", 31), learning_rate=p.get("learning_rate", 0.1),
                  subsample=p.get("subsample", 1.0), subsample_freq=1, colsample_bytree=p.get("colsample_bytree", 1.0),
                  reg_lambda=p.get("reg_lambda", 0.0), min_child_samples=p.get("min_child_samples", 20),
                  random_state=seed, n_jobs=1, deterministic=True, force_row_wise=True, verbose=-1)
        return LabelEncoded(LGBMClassifier(class_weight=cw, **kw)) if clf else LGBMRegressor(**kw)
    if family == "catboost":
        kw = dict(iterations=p.get("iterations", 400), depth=p.get("depth", 6), learning_rate=p.get("learning_rate", 0.08),
                  l2_leaf_reg=p.get("l2_leaf_reg", 3.0), random_seed=seed, verbose=False, thread_count=2, allow_writing_files=False)
        return CatBoostClassifier(auto_class_weights="Balanced" if cw else None, **kw) if clf else CatBoostRegressor(**kw)
    if family == "mlp":
        layers = tuple([p.get("width", 64)] * p.get("depth", 2))
        kw = dict(hidden_layer_sizes=layers, alpha=p.get("alpha", 1e-4), learning_rate_init=p.get("lr", 1e-3), max_iter=400,
                  early_stopping=True, n_iter_no_change=15, random_state=seed)
        return MLPClassifier(**kw) if clf else MLPRegressor(**kw)
    raise ValueError(f"Unknown model family {family}")


def suggest(trial, family: str, task: str) -> dict[str, Any]:
    """Optuna search spaces."""
    clf = task != "regression"
    if family == "linear":
        return {"C": trial.suggest_float("C", 1e-3, 100, log=True)} if clf else {"alpha": trial.suggest_float("alpha", 1e-3, 100, log=True)}
    if family == "elastic_net":
        return {"alpha": trial.suggest_float("alpha", 1e-4, 10, log=True), "l1_ratio": trial.suggest_float("l1_ratio", 0.05, 1.0)}
    if family == "knn":
        return {"n_neighbors": trial.suggest_int("n_neighbors", 3, 75), "weights": trial.suggest_categorical("weights", ["uniform", "distance"])}
    if family == "svm":
        return {"C": trial.suggest_float("C", 1e-2, 100, log=True), "gamma": trial.suggest_float("gamma", 1e-4, 1, log=True)}
    if family == "naive_bayes":
        return {"var_smoothing": trial.suggest_float("var_smoothing", 1e-12, 1e-3, log=True)}
    if family in ("random_forest", "extra_trees"):
        return {"n_estimators": trial.suggest_int("n_estimators", 100, 600, step=50), "max_depth": trial.suggest_categorical("max_depth", [None, 6, 10, 16, 24]),
                "min_samples_leaf": trial.suggest_int("min_samples_leaf", 1, 20), "max_features": trial.suggest_categorical("max_features", ["sqrt", 0.5, 1.0])}
    if family == "hist_gradient_boosting":
        return {"learning_rate": trial.suggest_float("learning_rate", 0.02, 0.3, log=True), "max_leaf_nodes": trial.suggest_int("max_leaf_nodes", 8, 128, log=True),
                "l2": trial.suggest_float("l2", 1e-6, 10, log=True), "max_iter": trial.suggest_int("max_iter", 100, 600, step=50)}
    if family == "xgboost":
        return {"n_estimators": trial.suggest_int("n_estimators", 100, 800, step=50), "max_depth": trial.suggest_int("max_depth", 2, 10),
                "learning_rate": trial.suggest_float("learning_rate", 0.01, 0.3, log=True), "subsample": trial.suggest_float("subsample", 0.5, 1.0),
                "colsample_bytree": trial.suggest_float("colsample_bytree", 0.4, 1.0), "reg_lambda": trial.suggest_float("reg_lambda", 1e-3, 10, log=True)}
    if family == "lightgbm":
        return {"n_estimators": trial.suggest_int("n_estimators", 100, 800, step=50), "num_leaves": trial.suggest_int("num_leaves", 8, 256, log=True),
                "learning_rate": trial.suggest_float("learning_rate", 0.01, 0.3, log=True), "subsample": trial.suggest_float("subsample", 0.5, 1.0),
                "colsample_bytree": trial.suggest_float("colsample_bytree", 0.4, 1.0), "reg_lambda": trial.suggest_float("reg_lambda", 1e-3, 10, log=True),
                "min_child_samples": trial.suggest_int("min_child_samples", 5, 100, log=True)}
    if family == "catboost":
        return {"iterations": trial.suggest_int("iterations", 200, 1000, step=100), "depth": trial.suggest_int("depth", 3, 9),
                "learning_rate": trial.suggest_float("learning_rate", 0.02, 0.3, log=True), "l2_leaf_reg": trial.suggest_float("l2_leaf_reg", 1, 20, log=True)}
    if family == "mlp":
        return {"width": trial.suggest_categorical("width", [32, 64, 128, 256]), "depth": trial.suggest_int("depth", 1, 3),
                "alpha": trial.suggest_float("alpha", 1e-6, 1e-1, log=True), "lr": trial.suggest_float("lr", 1e-4, 1e-2, log=True)}
    return {}


def pipeline(roles, family, task, params, seed, balanced, interactions: bool = False) -> Pipeline:
    return Pipeline([("prep", preprocessor(roles, family in SCALED, task, seed, interactions)), ("model", make_model(family, task, params, seed, balanced))])


# ---------------------------------------------------------------- metrics
def scorer_name(task: str, binary: bool, metric: str) -> str:
    if metric != "auto":
        return metric
    return "r2" if task == "regression" else ("roc_auc" if binary else "f1_macro")


def metrics(task: str, y_true, y_pred, proba=None, classes=None, positive=None) -> dict[str, Any]:
    if task == "regression":
        yt, yp = np.asarray(y_true, float), np.asarray(y_pred, float)
        out = {"r2": r2_score(yt, yp), "rmse": float(np.sqrt(mean_squared_error(yt, yp))), "mae": mean_absolute_error(yt, yp),
               "medianAe": median_absolute_error(yt, yp), "explainedVariance": explained_variance_score(yt, yp)}
        if np.all(np.abs(yt) > 1e-9):
            out["mape"] = mean_absolute_percentage_error(yt, yp)
        return out
    out = {"accuracy": accuracy_score(y_true, y_pred), "balancedAccuracy": balanced_accuracy_score(y_true, y_pred),
           "f1Macro": f1_score(y_true, y_pred, average="macro"), "f1Weighted": f1_score(y_true, y_pred, average="weighted"),
           "mcc": matthews_corrcoef(y_true, y_pred)}
    if classes is not None and len(classes) == 2:
        pos = positive if positive is not None else classes[1]
        out.update(precision=precision_score(y_true, y_pred, pos_label=pos, zero_division=0), recall=recall_score(y_true, y_pred, pos_label=pos, zero_division=0),
                   f1=f1_score(y_true, y_pred, pos_label=pos, zero_division=0))
        if proba is not None:
            pidx = list(classes).index(pos)
            yb = (np.asarray(y_true) == pos).astype(int)
            out.update(rocAuc=roc_auc_score(yb, proba[:, pidx]), prAuc=average_precision_score(yb, proba[:, pidx]),
                       logLoss=log_loss(yb, np.clip(proba[:, pidx], 1e-15, 1 - 1e-15)), brier=brier_score_loss(yb, proba[:, pidx]))
    elif proba is not None:
        try:
            out.update(rocAucOvr=roc_auc_score(y_true, proba, multi_class="ovr", labels=classes), logLoss=log_loss(y_true, proba, labels=classes))
        except ValueError:
            pass
    return out


def ci_from_folds(scores: np.ndarray, n_train: int, n_test: int) -> list[float]:
    """Confidence interval for a CV mean using the Nadeau–Bengio corrected variance."""
    from scipy import stats

    k = len(scores)
    if k < 2:
        return [float(scores.mean()), float(scores.mean())]
    var = (1 / k + n_test / max(1, n_train)) * scores.var(ddof=1)
    half = stats.t.ppf(0.975, k - 1) * np.sqrt(var)
    return [float(scores.mean() - half), float(scores.mean() + half)]


def corrected_ttest(a: np.ndarray, b: np.ndarray, n_train: int, n_test: int) -> dict[str, float]:
    """Nadeau–Bengio corrected resampled t-test between two models scored on the same folds."""
    from scipy import stats

    d = np.asarray(a) - np.asarray(b)
    k = len(d)
    var = (1 / k + n_test / max(1, n_train)) * d.var(ddof=1)
    if var <= 0:
        return {"meanDifference": float(d.mean()), "t": None, "p": 1.0}
    t = d.mean() / np.sqrt(var)
    return {"meanDifference": float(d.mean()), "t": float(t), "p": float(2 * stats.t.sf(abs(t), k - 1))}
