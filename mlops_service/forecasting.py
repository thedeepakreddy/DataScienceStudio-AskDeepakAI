"""Baseline forecasting with rolling-origin backtesting.

Simple, well-understood methods (naive, seasonal naive, moving average, drift,
linear trend, Holt's and Holt-Winters exponential smoothing) are each scored by
backtesting: forecasting past periods from the data before them and measuring
the error. The best one by MAE makes the forecast, and its prediction
intervals come from its real backtest errors.
"""

from __future__ import annotations

import itertools
import math
from collections.abc import Callable
from typing import Any, Literal

import numpy as np
import pandas as pd

Freq = Literal["auto", "D", "W", "MS", "QS", "YS"]
FREQ_LABEL = {"D": "day", "W": "week", "MS": "month", "QS": "quarter", "YS": "year"}
SEASON = {"D": 7, "W": 52, "MS": 12, "QS": 4, "YS": 1}
MAX_POINTS = 2000


class ForecastError(ValueError):
    pass


def infer_freq(dates: pd.Series) -> str:
    # Unique dates: several rows on the same date (e.g. one per region) are one period.
    diffs = dates.drop_duplicates().sort_values().diff().dropna().dt.total_seconds() / 86400
    if diffs.empty:
        raise ForecastError("Need at least two different dates.")
    d = float(diffs.median())
    if d <= 1.5:
        return "D"
    if d <= 8:
        return "W"
    if d <= 32:
        return "MS"
    if d <= 95:
        return "QS"
    return "YS"


def prepare_series(df: pd.DataFrame, date_column: str, value_column: str, freq: Freq, agg: Literal["sum", "mean"]) -> tuple[pd.Series, str, list[str]]:
    for c in (date_column, value_column):
        if c not in df.columns:
            raise ForecastError(f"There is no column called “{c}”.")
    dates = pd.to_datetime(df[date_column], errors="coerce", utc=True).dt.tz_localize(None)
    values = pd.to_numeric(df[value_column], errors="coerce")
    ok = dates.notna() & values.notna()
    if ok.sum() < 8:
        raise ForecastError("Need at least 8 rows with both a valid date and a number.")
    notes = []
    if (~ok).sum():
        notes.append(f"{int((~ok).sum())} rows without a valid date or number were skipped.")
    f = infer_freq(dates[ok]) if freq == "auto" else freq
    series = pd.Series(values[ok].to_numpy(), index=dates[ok]).sort_index()
    resampled = series.resample(f).sum(min_count=1) if agg == "sum" else series.resample(f).mean()
    gaps = int(resampled.isna().sum())
    if gaps:
        if agg == "sum":
            resampled = resampled.fillna(0)
            notes.append(f"{gaps} {FREQ_LABEL[f]}s had no rows and count as 0.")
        else:
            resampled = resampled.interpolate(limit_direction="both")
            notes.append(f"{gaps} {FREQ_LABEL[f]}s had no rows and were filled by interpolation.")
    if len(resampled) > MAX_POINTS:
        resampled = resampled.iloc[-MAX_POINTS:]
        notes.append(f"Only the latest {MAX_POINTS} {FREQ_LABEL[f]}s are used.")
    return resampled.astype(float), f, notes


# --- Methods: each takes the history and a horizon, returns h predictions ---

def naive(y, h, m):
    return np.repeat(y[-1], h)


def seasonal_naive(y, h, m):
    last = y[-m:]
    return np.array([last[i % m] for i in range(h)])


def moving_average(y, h, m):
    w = max(3, min(m, len(y)))
    return np.repeat(np.mean(y[-w:]), h)


def drift(y, h, m):
    slope = (y[-1] - y[0]) / (len(y) - 1) if len(y) > 1 else 0.0
    return y[-1] + slope * np.arange(1, h + 1)


def linear_trend(y, h, m):
    t = np.arange(len(y))
    b, a = np.polyfit(t, y, 1)
    return a + b * np.arange(len(y), len(y) + h)


def _holt_fit(y, alpha, beta):
    level, trend = y[0], (y[1] - y[0]) if len(y) > 1 else 0.0
    sse = 0.0
    for x in y[1:]:
        pred = level + trend
        sse += (x - pred) ** 2
        new_level = alpha * x + (1 - alpha) * (level + trend)
        trend = beta * (new_level - level) + (1 - beta) * trend
        level = new_level
    return level, trend, sse


def holt(y, h, m):
    grid = [0.1, 0.3, 0.5, 0.7, 0.9]
    best = min(((a, b) for a in grid for b in grid), key=lambda p: _holt_fit(y, *p)[2])
    level, trend, _ = _holt_fit(y, *best)
    return level + trend * np.arange(1, h + 1)


def _hw_fit(y, m, alpha, beta, gamma):
    level = np.mean(y[:m])
    trend = (np.mean(y[m:2 * m]) - np.mean(y[:m])) / m
    season = list(y[:m] - level)
    sse = 0.0
    for i in range(m, len(y)):
        s = season[i - m]
        pred = level + trend + s
        sse += (y[i] - pred) ** 2
        new_level = alpha * (y[i] - s) + (1 - alpha) * (level + trend)
        trend = beta * (new_level - level) + (1 - beta) * trend
        season.append(gamma * (y[i] - new_level) + (1 - gamma) * s)
        level = new_level
    return level, trend, season, sse


def holt_winters(y, h, m):
    grid = [0.1, 0.3, 0.6]
    best = min(itertools.product(grid, [0.05, 0.2], grid), key=lambda p: _hw_fit(y, m, *p)[3])
    level, trend, season, _ = _hw_fit(y, m, *best)
    n = len(y)
    return np.array([level + (i + 1) * trend + season[n - m + (i % m)] for i in range(h)])


METHODS: dict[str, tuple[str, Callable, Callable[[int, int], bool]]] = {
    # key: (label, function, usable(n, m))
    "naive": ("Last value", naive, lambda n, m: n >= 2),
    "seasonal_naive": ("Same period last season", seasonal_naive, lambda n, m: m > 1 and n >= 2 * m),
    "moving_average": ("Recent average", moving_average, lambda n, m: n >= 3),
    "drift": ("Drift (straight line from first to last)", drift, lambda n, m: n >= 3),
    "linear_trend": ("Linear trend", linear_trend, lambda n, m: n >= 4),
    "holt": ("Holt’s exponential smoothing", holt, lambda n, m: n >= 6),
    "holt_winters": ("Holt-Winters (trend + seasonality)", holt_winters, lambda n, m: m > 1 and n >= 3 * m),
}


def _errors(actual: np.ndarray, pred: np.ndarray) -> dict[str, float | None]:
    err = actual - pred
    nonzero = actual != 0
    return {
        "mae": float(np.mean(np.abs(err))),
        "rmse": float(math.sqrt(np.mean(err ** 2))),
        "mape": float(np.mean(np.abs(err[nonzero] / actual[nonzero])) * 100) if nonzero.any() else None,
    }


def forecast(df: pd.DataFrame, date_column: str, value_column: str, horizon: int,
             freq: Freq = "auto", agg: Literal["sum", "mean"] = "sum", folds: int = 3) -> dict[str, Any]:
    if not 1 <= horizon <= 365:
        raise ForecastError("Forecast between 1 and 365 periods ahead.")
    series, f, notes = prepare_series(df, date_column, value_column, freq, agg)
    y = series.to_numpy()
    n = len(y)
    m = SEASON[f]
    # Keep at least two seasons (or 8 points) of history before the first
    # backtest fold, so seasonal methods can take part when the data allows.
    min_train = 2 * m if m > 1 and n >= 2 * m + horizon else 8
    folds = max(1, min(folds, (n - min_train) // horizon))
    if n - folds * horizon < 4:
        raise ForecastError(f"Only {n} {FREQ_LABEL[f]}s of data; forecasting {horizon} ahead needs at least {horizon + 4}. Try a shorter horizon.")

    # Rolling-origin backtest: each fold forecasts the next `horizon` periods
    # using only the data before them.
    board = []
    residuals: dict[str, list[float]] = {}
    for key, (label, fn, usable) in METHODS.items():
        errs, res = [], []
        try:
            for k in range(folds, 0, -1):
                cut = n - k * horizon
                if not usable(cut, m):
                    raise ValueError("not enough history")
                pred = fn(y[:cut], horizon, m)
                actual = y[cut:cut + horizon]
                errs.append(_errors(actual, pred[:len(actual)]))
                res.extend((actual - pred[:len(actual)]).tolist())
        except (ValueError, np.linalg.LinAlgError, FloatingPointError):
            continue
        mape_vals = [e["mape"] for e in errs if e["mape"] is not None]
        board.append({
            "method": key, "label": label,
            "mae": round(float(np.mean([e["mae"] for e in errs])), 4),
            "rmse": round(float(np.mean([e["rmse"] for e in errs])), 4),
            "mape": round(float(np.mean(mape_vals)), 2) if mape_vals else None,
        })
        residuals[key] = res
    if not board:
        raise ForecastError("Not enough history to backtest any method.")
    board.sort(key=lambda r: r["mae"])
    best = board[0]["method"]
    point = METHODS[best][1](y, horizon, m)
    res = np.array(residuals[best])
    q = {k: float(np.quantile(res, v)) for k, v in [("lo80", 0.1), ("hi80", 0.9), ("lo95", 0.025), ("hi95", 0.975)]}
    future = pd.date_range(series.index[-1], periods=horizon + 1, freq=f)[1:]
    out = [{"date": d.strftime("%Y-%m-%d"), "value": round(float(v), 4),
            **{k: round(float(v + q[k]), 4) for k in q}} for d, v in zip(future, point)]
    history = [{"date": d.strftime("%Y-%m-%d"), "value": round(float(v), 4)} for d, v in series.iloc[-300:].items()]
    if len(res) < 20:
        notes.append(f"The intervals come from only {len(res)} backtest errors, so treat them as rough.")
    return {
        "frequency": FREQ_LABEL[f], "seasonLength": m, "points": n, "horizon": horizon, "folds": folds,
        "aggregation": agg, "best": best, "bestLabel": METHODS[best][0],
        "leaderboard": board, "history": history, "forecast": out, "notes": notes,
        "intervalMethod": "Empirical quantiles of the best method’s backtest errors.",
    }
