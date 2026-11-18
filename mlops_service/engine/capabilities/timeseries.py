"""Time series: forecasting with rolling backtests and prediction intervals,
decomposition and stationarity, anomaly detection, change points, and
hierarchical (reconciled) forecasts."""
from __future__ import annotations

import itertools
import warnings
from typing import Literal

import numpy as np
import pandas as pd
from pydantic import BaseModel, Field
from scipy import stats
from statsmodels.tsa.forecasting.theta import ThetaModel
from statsmodels.tsa.holtwinters import ExponentialSmoothing
from statsmodels.tsa.seasonal import STL
from statsmodels.tsa.statespace.sarimax import SARIMAX
from statsmodels.tsa.stattools import acf, adfuller, kpss, pacf

from ..core import EngineError
from ..registry import capability
from ._util import need

warnings.filterwarnings("ignore", module="statsmodels")
FREQS = {"D": 7, "W": 52, "MS": 12, "M": 12, "QS": 4, "Q": 4, "H": 24, "h": 24, "B": 5, "YS": 1, "A": 1}


def _series(ctx, date: str, value: str, freq: str, agg: str, group: str | None = None, where: str | None = None):
    ctx.require(date, value, group)
    df = ctx.frame([date, value] + ([group] if group else []), where=where)
    d = pd.DataFrame({"ds": pd.to_datetime(df[date], errors="coerce"), "y": pd.to_numeric(df[value], errors="coerce")})
    if group:
        d["g"] = df[group].astype(str)
    d = d.dropna(subset=["ds", "y"])
    need(len(d) >= 8, "Need at least 8 dated values.")
    if freq == "auto":
        diffs = d["ds"].drop_duplicates().sort_values().diff().dt.total_seconds().dropna()
        med = diffs.median() / 86400 if len(diffs) else 1
        freq = "h" if med < 0.5 else "D" if med < 3 else "W" if med < 10 else "MS" if med < 45 else "QS" if med < 120 else "YS"
    return d, freq


def _regular(d: pd.DataFrame, freq: str, agg: str) -> pd.Series:
    s = d.set_index("ds")["y"].resample(freq).agg(agg)
    if agg == "sum":
        s = s.fillna(0)
    return s.interpolate(limit_direction="both")


def _season(freq: str, n: int, override: int | None) -> int:
    m = override or FREQS.get(freq, 1)
    return m if m > 1 and n >= 2 * m + 2 else 1


# ---- forecasters: each returns (point forecasts, lower, upper) or intervals as None
def f_naive(y, h, m, level, exog=None, exog_f=None):
    return np.repeat(y[-1], h), None, None


def f_seasonal_naive(y, h, m, level, exog=None, exog_f=None):
    if m <= 1:
        return f_naive(y, h, m, level)
    return np.array([y[-m + (i % m)] for i in range(h)]), None, None


def f_drift(y, h, m, level, exog=None, exog_f=None):
    slope = (y[-1] - y[0]) / max(1, len(y) - 1)
    return y[-1] + slope * np.arange(1, h + 1), None, None


def f_ets(y, h, m, level, exog=None, exog_f=None):
    best = None
    for trend, damped, seasonal in [(None, False, None), ("add", False, None), ("add", True, None),
                                    (None, False, "add" if m > 1 else None), ("add", True, "add" if m > 1 else None),
                                    ("add", True, "mul" if m > 1 and np.all(y > 0) else None)]:
        if seasonal is None and m > 1 and (trend, damped) in [(None, False)] and best is not None:
            continue
        try:
            fit = ExponentialSmoothing(y, trend=trend, damped_trend=damped, seasonal=seasonal, seasonal_periods=m if seasonal else None,
                                       initialization_method="estimated").fit(optimized=True)
            k = len(fit.params_formatted) if hasattr(fit, "params_formatted") else 3
            aicc = fit.aicc if np.isfinite(fit.aicc) else fit.aic + 2 * k * (k + 1) / max(1, len(y) - k - 1)
            if best is None or aicc < best[0]:
                best = (aicc, fit)
        except (ValueError, np.linalg.LinAlgError):
            continue
    need(best is not None, "Exponential smoothing couldn't fit this series.")
    fit = best[1]
    point = fit.forecast(h)
    sims = fit.simulate(h, repetitions=500, error="add", random_state=0)
    lo, hi = np.quantile(sims, (1 - level) / 2, axis=1), np.quantile(sims, 1 - (1 - level) / 2, axis=1)
    return np.asarray(point), np.asarray(lo), np.asarray(hi)


def f_arima(y, h, m, level, exog=None, exog_f=None):
    best = None
    seasonal = [(0, 0, 0)] + ([(1, 0, 0), (0, 1, 1), (1, 1, 0)] if m > 1 else [])
    d_opts = [0, 1] if adfuller(y, autolag="AIC")[1] > 0.05 else [0]
    for (p_, d_, q_), sea in itertools.product([(a, b, c) for a in range(3) for b in d_opts for c in range(3)], seasonal):
        try:
            res = SARIMAX(y, exog=exog, order=(p_, d_, q_), seasonal_order=(*sea, m) if sea != (0, 0, 0) else (0, 0, 0, 0),
                          trend="c" if d_ == 0 else None, enforce_stationarity=False, enforce_invertibility=False).fit(disp=False, maxiter=200)
            if best is None or res.aic < best[0]:
                best = (res.aic, res)
        except (ValueError, np.linalg.LinAlgError):
            continue
    need(best is not None, "ARIMA couldn't fit this series.")
    fc = best[1].get_forecast(h, exog=exog_f)
    ci = fc.conf_int(alpha=1 - level)
    return np.asarray(fc.predicted_mean), np.asarray(ci[:, 0]), np.asarray(ci[:, 1])


def f_theta(y, h, m, level, exog=None, exog_f=None):
    res = ThetaModel(y, period=m if m > 1 else None, deseasonalize=m > 1).fit()
    point = res.forecast(h)
    pi = res.prediction_intervals(h, alpha=1 - level)
    return np.asarray(point), np.asarray(pi.iloc[:, 0]), np.asarray(pi.iloc[:, 1])


def f_ml_lags(y, h, m, level, exog=None, exog_f=None):
    from lightgbm import LGBMRegressor

    lags = sorted({1, 2, 3, *([m] if m > 1 else []), *([2 * m] if m > 1 and len(y) > 4 * m else [])})
    lags = [lag for lag in lags if lag < len(y) - 5]
    need(bool(lags), "The series is too short for lag features.")
    mx = max(lags)
    X = np.column_stack([y[mx - lag: len(y) - lag] for lag in lags] + [np.arange(mx, len(y))])
    target = y[mx:]
    model = LGBMRegressor(n_estimators=300, learning_rate=0.05, num_leaves=15, min_child_samples=max(3, len(target) // 20),
                          random_state=0, n_jobs=1, deterministic=True, force_row_wise=True, verbose=-1).fit(X, target)
    hist = list(y)
    out = []
    for i in range(h):
        row = [hist[-lag] for lag in lags] + [len(hist)]
        nxt = float(model.predict(np.array([row]))[0])
        out.append(nxt)
        hist.append(nxt)
    return np.array(out), None, None


MODELS = {"naive": f_naive, "seasonal_naive": f_seasonal_naive, "drift": f_drift, "ets": f_ets, "arima": f_arima, "theta": f_theta, "ml_lags": f_ml_lags}


def _mase_scale(insample, m):
    """Mean absolute error of the in-sample seasonal-naive forecast (lag-m differences)."""
    lag = m if m > 1 and len(insample) > m else 1
    return float(np.mean(np.abs(insample[lag:] - insample[:-lag]))) or 1e-9


def _scores(actual, pred, insample, m):
    scale = _mase_scale(insample, m)
    err = actual - pred
    return {"mase": float(np.mean(np.abs(err)) / scale), "rmse": float(np.sqrt(np.mean(err ** 2))), "mae": float(np.mean(np.abs(err))),
            "smape": float(np.mean(2 * np.abs(err) / np.maximum(1e-9, np.abs(actual) + np.abs(pred))))}


class ForecastParams(BaseModel):
    date: str
    value: str
    horizon: int = Field(12, ge=1, le=1000)
    freq: str = Field("auto", description="auto, h, D, B, W, MS, QS or YS.")
    agg: Literal["sum", "mean", "last", "max", "min"] = "sum"
    models: list[Literal["naive", "seasonal_naive", "drift", "ets", "arima", "theta", "ml_lags"]] | None = None
    season_length: int | None = Field(None, ge=2, le=400)
    backtest_windows: int = Field(3, ge=1, le=20)
    level: float = Field(0.9, gt=0.5, lt=0.999, description="Prediction-interval coverage.")
    ensemble: bool = True


@capability("ts.forecast", "timeseries", "Forecast",
            "Forecasts a series with naive, seasonal naive, drift, ETS (auto by AICc), auto-ARIMA/SARIMA, Theta and a LightGBM lag model, compares them with rolling-origin backtests (MASE, sMAPE, RMSE), adds an ensemble of the best, and gives prediction intervals calibrated on backtest errors.",
            ForecastParams, heavy=True, tags=["forecasting", "time series"])
def forecast(ctx, p: ForecastParams):  # noqa: C901
    d, freq = _series(ctx, p.date, p.value, p.freq, p.agg)
    s = _regular(d, freq, p.agg)
    y = s.to_numpy(float)
    m = _season(freq, len(y), p.season_length)
    need(len(y) >= p.horizon + 8, f"The series has {len(y)} points; it needs at least {p.horizon + 8} to forecast {p.horizon} ahead with a backtest.")
    names = p.models or ["naive", "seasonal_naive", "drift", "ets", "arima", "theta", "ml_lags"]
    windows = min(p.backtest_windows, max(1, (len(y) - p.horizon - 8) // max(1, p.horizon) + 1))
    bt: dict[str, list] = {n: [] for n in names}
    errs: dict[str, list] = {n: [] for n in names}
    for w in range(windows):
        cut = len(y) - p.horizon * (windows - w)
        train, test = y[:cut], y[cut: cut + p.horizon]
        for i, n in enumerate(names):
            ctx.progress((w * len(names) + i) / (windows * len(names) + len(names)) * 0.8, f"Backtest {w + 1}: {n}")
            try:
                pred = MODELS[n](train, len(test), _season(freq, len(train), p.season_length), p.level)[0]
                bt[n].append(_scores(test, pred, train, m))
                errs[n].append(test - pred)
            except EngineError:
                raise
            except Exception:  # noqa: BLE001 - a model that can't fit a window just doesn't score there
                continue
    board = []
    for n in names:
        if bt[n]:
            board.append({"model": n, **{k: float(np.mean([b[k] for b in bt[n]])) for k in ("mase", "smape", "rmse", "mae")}, "windows": len(bt[n])})
    need(bool(board), "No forecaster could fit this series.")
    board.sort(key=lambda r: r["mase"])
    fits = {}
    for i, r in enumerate(board[:4]):
        ctx.progress(0.8 + 0.15 * i / 4, f"Final fit: {r['model']}")
        try:
            fits[r["model"]] = MODELS[r["model"]](y, p.horizon, m, p.level)
        except Exception:  # noqa: BLE001
            continue
    need(bool(fits), "The forecasters failed on the full series.")
    if p.ensemble and len(fits) >= 3:
        # Only members scored on every backtest window, so the ensemble's errors line up window by window.
        top = [r["model"] for r in board if r["model"] in fits and len(errs[r["model"]]) == windows][:3]
        ens_err = []
        for w in range(windows if len(top) >= 2 else 0):
            ens_err.append(np.mean([errs[t][w] for t in top], axis=0))
        if ens_err:
            mase = np.mean([np.mean(np.abs(e)) / _mase_scale(y[: len(y) - p.horizon * (windows - w)], m) for w, e in enumerate(ens_err)])
            board.append({"model": "ensemble", "mase": float(mase), "members": top, "windows": len(ens_err)})
            fits["ensemble"] = (np.mean([fits[t][0] for t in top], axis=0), None, None)
            errs["ensemble"] = ens_err
            board.sort(key=lambda r: r["mase"])
    best = next(r["model"] for r in board if r["model"] in fits)
    point, lo, hi = fits[best]
    method = "model"
    if lo is None:
        # Empirical intervals from backtest errors at each step ahead.
        E = np.array(errs[best]) if errs[best] else None
        if E is not None and len(E):
            q_lo, q_hi = np.quantile(E, (1 - p.level) / 2, axis=0), np.quantile(E, 1 - (1 - p.level) / 2, axis=0)
            lo, hi = point + q_lo[: p.horizon], point + q_hi[: p.horizon]
            method = "backtest errors"
    future = pd.date_range(s.index[-1], periods=p.horizon + 1, freq=freq)[1:]
    return {"frequency": freq, "seasonLength": m, "points": len(y), "best": best, "leaderboard": board, "backtestWindows": windows,
            "intervalMethod": method if lo is not None else None, "level": p.level,
            "history": [{"date": t, "value": float(v)} for t, v in zip(s.index[-500:], y[-500:])],
            "forecast": [{"date": t, "value": float(v), "lower": None if lo is None else float(a), "upper": None if hi is None else float(b)}
                         for t, v, a, b in zip(future, point, lo if lo is not None else [None] * p.horizon, hi if hi is not None else [None] * p.horizon)]}


class DecomposeParams(BaseModel):
    date: str
    value: str
    freq: str = "auto"
    agg: Literal["sum", "mean", "last", "max", "min"] = "sum"
    season_length: int | None = Field(None, ge=2, le=400)
    lags: int = Field(36, ge=4, le=200)


@capability("ts.decompose", "timeseries", "Decompose a series",
            "Splits a series into trend, seasonality and remainder (STL), measures the strength of each, and reports autocorrelation (ACF/PACF) and stationarity tests (ADF, KPSS).",
            DecomposeParams, tags=["time series", "eda"])
def decompose(ctx, p: DecomposeParams):
    d, freq = _series(ctx, p.date, p.value, p.freq, p.agg)
    s = _regular(d, freq, p.agg)
    y = s.to_numpy(float)
    m = _season(freq, len(y), p.season_length)
    out = {"frequency": freq, "seasonLength": m, "points": len(y)}
    if m > 1:
        res = STL(s, period=m, robust=True).fit()
        trend, seas, resid = res.trend.to_numpy(), res.seasonal.to_numpy(), res.resid.to_numpy()
        out["strength"] = {"trend": float(max(0, 1 - np.var(resid) / np.var(trend + resid))), "seasonal": float(max(0, 1 - np.var(resid) / np.var(seas + resid)))}
    else:
        trend = s.rolling(max(3, len(y) // 10), center=True, min_periods=1).mean().to_numpy()
        seas, resid = np.zeros_like(y), y - trend
        out["strength"] = {"trend": float(max(0, 1 - np.var(resid) / np.var(y))) if np.var(y) else 0.0, "seasonal": 0.0}
    out["components"] = [{"date": t, "value": float(v), "trend": float(a), "seasonal": float(b), "remainder": float(c)} for t, v, a, b, c in zip(s.index, y, trend, seas, resid)]
    lags = min(p.lags, len(y) // 2 - 1)
    out["acf"] = acf(y, nlags=lags, fft=True).tolist()
    out["pacf"] = pacf(y, nlags=lags).tolist() if lags >= 2 else []
    adf = adfuller(y, autolag="AIC")
    with warnings.catch_warnings():
        warnings.simplefilter("ignore")
        kp = kpss(y, regression="c", nlags="auto")
    out["stationarity"] = {"adf": {"statistic": adf[0], "p": adf[1]}, "kpss": {"statistic": kp[0], "p": kp[1]},
                           "stationary": bool(adf[1] < 0.05 and kp[1] > 0.05)}
    return out


class AnomalyParams(BaseModel):
    date: str
    value: str
    freq: str = "auto"
    agg: Literal["sum", "mean", "last", "max", "min"] = "sum"
    threshold: float = Field(4.0, gt=1, le=20, description="Robust z-score of the remainder above which a point is an anomaly.")
    season_length: int | None = Field(None, ge=2, le=400)


@capability("ts.anomalies", "timeseries", "Find anomalies in a series",
            "Flags unusual points after removing trend and seasonality (STL, refitted with anomalies masked), using a robust z-score of what's left, so normal peaks aren't flagged; gives the expected value and normal band for every point.",
            AnomalyParams, tags=["time series", "anomaly"])
def anomalies(ctx, p: AnomalyParams):
    d, freq = _series(ctx, p.date, p.value, p.freq, p.agg)
    s = _regular(d, freq, p.agg)
    m = _season(freq, len(s), p.season_length)
    # Iterative clean-and-refit: anomalies are masked and interpolated before the next decomposition,
    # so they don't bend the trend/seasonality, and the noise scale comes only from normal points.
    # (Robust STL is avoided here: its down-weighting makes ordinary residuals heavy-tailed.)
    flags = np.zeros(len(s), bool)
    for _ in range(6):
        y = s.copy()
        if flags.any():
            y[flags] = np.nan
            y = y.interpolate(limit_direction="both")
        if m > 1:
            fit = STL(y, period=m, seasonal=13 if m >= 4 else 7).fit()
            expected = fit.seasonal + fit.trend
        else:
            expected = y.rolling(7, center=True, min_periods=1).median()
        resid = (s - expected).to_numpy()
        clean = resid[~flags]
        med = np.median(clean)
        scale = np.median(np.abs(clean - med)) * 1.4826 or (np.std(clean) or 1.0)
        z = (resid - med) / scale
        new = np.abs(z) > p.threshold
        if (new == flags).all():
            break
        flags = new
    return {"frequency": freq, "points": len(s), "anomalies": int(flags.sum()),
            "noiseScale": float(scale), "series": [{"date": t, "value": float(v), "expected": float(e), "lower": float(e + med - p.threshold * scale),
                       "upper": float(e + med + p.threshold * scale), "score": float(zz), "anomaly": bool(f)}
                      for t, v, e, zz, f in zip(s.index, s.to_numpy(), expected.to_numpy(), z, flags)]}


def pelt(y: np.ndarray, penalty: float, min_size: int = 2) -> list[int]:
    """Exact PELT change-point search for shifts in the mean (L2 cost)."""
    n = len(y)
    cs, cs2 = np.concatenate([[0], np.cumsum(y)]), np.concatenate([[0], np.cumsum(y ** 2)])

    def cost(a, b):
        s, s2, k = cs[b] - cs[a], cs2[b] - cs2[a], b - a
        return s2 - s * s / k

    F = np.full(n + 1, np.inf)
    F[0] = -penalty
    last = np.zeros(n + 1, int)
    cands = [0]
    for t in range(min_size, n + 1):
        vals = [(F[s] + cost(s, t) + penalty, s) for s in cands if t - s >= min_size]
        if not vals:
            continue
        F[t], last[t] = min(vals)
        cands = [s for s in cands if t - s < min_size or F[s] + cost(s, t) <= F[t]] + [t - min_size + 1]
    cps, t = [], n
    while t > 0:
        t = last[t]
        if t > 0:
            cps.append(t)
    return sorted(cps)


class ChangeParams(BaseModel):
    date: str
    value: str
    freq: str = "auto"
    agg: Literal["sum", "mean", "last", "max", "min"] = "sum"
    penalty: float | None = Field(None, gt=0, description="Higher = fewer change points (BIC-style by default).")
    min_segment: int = Field(3, ge=2, le=1000)


@capability("ts.changepoints", "timeseries", "Find change points",
            "Finds where a series' level shifts (exact PELT search with a BIC-style penalty), with the mean of each segment and a test of each shift.",
            ChangeParams, tags=["time series", "anomaly"])
def changepoints(ctx, p: ChangeParams):
    d, freq = _series(ctx, p.date, p.value, p.freq, p.agg)
    s = _regular(d, freq, p.agg)
    y = s.to_numpy(float)
    sigma2 = np.var(np.diff(y)) / 2 or np.var(y) or 1.0
    pen = p.penalty if p.penalty else 2 * sigma2 * np.log(len(y))
    cps = pelt(y, pen, p.min_segment)
    bounds = [0, *cps, len(y)]
    segs = []
    for a, b in zip(bounds[:-1], bounds[1:]):
        segs.append({"start": s.index[a], "end": s.index[b - 1], "mean": float(y[a:b].mean()), "n": b - a})
    shifts = []
    for k, c in enumerate(cps):
        left, right = y[bounds[k]:c], y[c:bounds[k + 2]]
        t = stats.ttest_ind(left, right, equal_var=False) if len(left) > 1 and len(right) > 1 else None
        shifts.append({"date": s.index[c], "from": float(left.mean()), "to": float(right.mean()), "p": float(t.pvalue) if t else None})
    return {"frequency": freq, "changePoints": shifts, "segments": segs, "penalty": pen}


class HierParams(BaseModel):
    date: str
    value: str
    levels: list[str] = Field(..., min_length=1, max_length=3, description="Hierarchy columns from top to bottom, e.g. [region, store].")
    horizon: int = Field(12, ge=1, le=365)
    freq: str = "auto"
    agg: Literal["sum", "mean"] = "sum"
    max_series: int = Field(300, ge=2, le=2000)


@capability("ts.hierarchical", "timeseries", "Hierarchical forecast",
            "Forecasts every level of a hierarchy (total, e.g. region, store) and reconciles them so the pieces add up to the totals (OLS reconciliation), with the coherence check.",
            HierParams, heavy=True, tags=["forecasting", "time series"])
def hierarchical(ctx, p: HierParams):
    ctx.require(p.date, p.value, *p.levels)
    df = ctx.frame([p.date, p.value, *p.levels])
    df["ds"] = pd.to_datetime(df[p.date], errors="coerce")
    df["y"] = pd.to_numeric(df[p.value], errors="coerce")
    df = df.dropna(subset=["ds", "y"])
    _, freq = _series(ctx, p.date, p.value, p.freq, p.agg)
    bottom_keys = df[p.levels].astype(str).drop_duplicates().sort_values(p.levels)
    need(len(bottom_keys) <= p.max_series, f"{len(bottom_keys)} bottom series exceed the limit of {p.max_series}.")
    nodes = [("Total",)]
    for k in range(1, len(p.levels) + 1):
        nodes += [tuple(r) for r in df[p.levels[:k]].astype(str).drop_duplicates().sort_values(p.levels[:k]).itertuples(index=False)]
    bottom = [tuple(r) for r in bottom_keys.itertuples(index=False)]
    S = np.array([[1.0 if (n == ("Total",) or b[: len(n)] == n) else 0.0 for b in bottom] for n in nodes])
    idx = pd.date_range(df["ds"].min(), df["ds"].max(), freq=freq)
    base, hist = [], []
    for i, n in enumerate(nodes):
        ctx.progress(i / len(nodes), f"Forecasting {' / '.join(n)}")
        sub = df if n == ("Total",) else df[(df[p.levels[: len(n)]].astype(str) == list(n)).all(axis=1)]
        s = sub.set_index("ds")["y"].resample(freq).agg(p.agg).reindex(idx).fillna(0)
        y = s.to_numpy(float)
        m = _season(freq, len(y), None)
        try:
            fc = f_ets(y, p.horizon, m, 0.9)[0]
        except Exception:  # noqa: BLE001
            fc = f_naive(y, p.horizon, m, 0.9)[0]
        base.append(fc)
        hist.append(y)
    Yhat = np.array(base)
    P = S @ np.linalg.pinv(S.T @ S) @ S.T
    Ytil = P @ Yhat
    future = pd.date_range(idx[-1], periods=p.horizon + 1, freq=freq)[1:]
    incoherence = float(np.abs(S @ Yhat[[nodes.index(b) for b in bottom]] - Yhat).max())
    return {"frequency": freq, "levels": p.levels, "nodes": len(nodes), "bottomSeries": len(bottom), "baseIncoherence": incoherence,
            "series": [{"node": list(n), "level": len(n) if n != ("Total",) else 0,
                        "forecast": [{"date": t, "base": float(a), "reconciled": float(b)} for t, a, b in zip(future, Yhat[i], Ytil[i])]}
                       for i, n in enumerate(nodes)],
            "method": "OLS reconciliation of ETS base forecasts"}
