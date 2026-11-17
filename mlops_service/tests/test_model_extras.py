"""Leakage-safe splits, tuning, leakage warnings, seeding and forecasting."""

import math
import random

import pandas as pd
import pytest

import forecasting as fc


def dated_rows(n=120):
    random.seed(1)
    start = pd.Timestamp("2024-01-01")
    rows = []
    for i in range(n):
        x = random.uniform(0, 10)
        rows.append({"date": (start + pd.Timedelta(days=i)).strftime("%Y-%m-%d"), "customer": f"C{i % 30}",
                     "x": round(x, 3), "y": round(2 * x + random.uniform(-1, 1), 3)})
    return rows


def test_time_split_tests_only_on_the_most_recent_rows(client):
    body = client.post("/train", json={"data": dated_rows(), "target": "y", "models": ["linear"],
                                        "split_strategy": "time", "time_column": "date"}).json()
    s = body["split"]
    assert s["strategy"] == "time"
    assert s["trainUntil"] < s["testFrom"]
    assert "date" not in body["features"]
    assert s["testRows"] == 24


def test_group_split_keeps_groups_apart(client):
    body = client.post("/train", json={"data": dated_rows(), "target": "y", "models": ["linear"],
                                        "split_strategy": "group", "group_column": "customer"}).json()
    s = body["split"]
    assert s["trainGroups"] + s["testGroups"] == 30
    assert "customer" not in body["features"]


def test_split_errors_are_plain(client):
    r = client.post("/train", json={"data": dated_rows(), "target": "y", "split_strategy": "time"})
    assert r.status_code == 400 and "date/time column" in r.json()["detail"]


def test_same_seed_gives_identical_results(client, classification_rows):
    req = {"data": classification_rows, "target": "Churn", "models": ["random_forest"], "random_state": 7}
    a = client.post("/train", json=req).json()["champion"]
    b = client.post("/train", json=req).json()["champion"]
    assert a["metrics"] == b["metrics"] and a["cv"] == b["cv"]
    c = client.post("/train", json={**req, "random_state": 8}).json()["champion"]
    assert c["cv"]["scores"] != a["cv"]["scores"]


def test_tuning_reports_best_params(client, classification_rows):
    body = client.post("/train", json={"data": classification_rows, "target": "Churn", "models": ["random_forest"],
                                        "tune": True, "tune_iterations": 4}).json()
    t = body["tuning"]
    assert t["tuned"] is True and len(t["trials"]) == 4
    assert set(t["bestParams"]) == {"n_estimators", "max_depth", "min_samples_leaf", "max_features"}
    assert t["bestCvScore"] == max(x["mean"] for x in t["trials"])


def test_tuning_needs_one_model(client, classification_rows):
    r = client.post("/train", json={"data": classification_rows, "target": "Churn", "tune": True})
    assert r.status_code == 400


def test_leakage_warning_for_a_copy_of_the_target(client, classification_rows):
    rows = [{**r, "churn_flag": r["Churn"]} for r in classification_rows]
    body = client.post("/train", json={"data": rows, "target": "Churn", "models": ["linear"]}).json()
    cols = [w["column"] for w in body["leakageWarnings"]]
    assert cols == ["churn_flag"]


def test_no_leakage_warning_on_clean_data(client, classification_rows):
    body = client.post("/train", json={"data": classification_rows, "target": "Churn", "models": ["linear"]}).json()
    assert body["leakageWarnings"] == []


# --- Forecasting -------------------------------------------------------------------

def monthly(values, start="2019-01-01"):
    dates = pd.date_range(start, periods=len(values), freq="MS")
    return pd.DataFrame({"month": dates.strftime("%Y-%m-%d"), "sales": values})


def test_naive_backtest_error_matches_hand_calculation():
    # Series 1..12 by month, horizon 2, 1 fold: naive predicts 10, 10 for 11, 12 -> MAE 1.5
    r = fc.forecast(monthly(list(range(1, 13))), "month", "sales", horizon=2, folds=1)
    naive = next(x for x in r["leaderboard"] if x["method"] == "naive")
    assert naive["mae"] == pytest.approx(1.5)
    assert r["frequency"] == "month"


def test_trend_is_forecast_by_a_trend_method():
    r = fc.forecast(monthly([10 + 3 * i for i in range(36)]), "month", "sales", horizon=6)
    assert r["best"] in {"drift", "linear_trend", "holt"}
    assert r["forecast"][0]["value"] == pytest.approx(10 + 3 * 36, abs=0.5)
    assert r["forecast"][0]["date"] == "2022-01-01"


def test_seasonal_pattern_is_forecast_by_a_seasonal_method():
    pattern = [5, 6, 9, 14, 20, 25, 27, 24, 18, 12, 8, 6]
    values = [p + 0.1 * i for i, p in enumerate(pattern * 4)]
    r = fc.forecast(monthly(values), "month", "sales", horizon=12)
    assert r["best"] in {"seasonal_naive", "holt_winters"}
    assert r["forecast"][6]["value"] == pytest.approx(27 + 0.1 * 54, abs=2)
    # Intervals are the method's real backtest errors added to the forecast, so
    # they can sit off-centre when the method has been consistently low or high.
    assert all(x["lo95"] <= x["lo80"] <= x["hi80"] <= x["hi95"] for x in r["forecast"])


def test_aggregates_daily_rows_to_the_inferred_frequency():
    days = pd.date_range("2024-01-01", periods=60, freq="D")
    df = pd.DataFrame({"d": list(days.strftime("%Y-%m-%d")) * 2, "v": [1.0] * 120})
    r = fc.forecast(df, "d", "v", horizon=7)
    assert r["frequency"] == "day" and r["points"] == 60
    assert all(h["value"] == 2 for h in r["history"])


def test_several_rows_per_date_still_infer_the_right_period():
    months = pd.date_range("2021-01-01", periods=24, freq="MS").strftime("%Y-%m-%d")
    df = pd.DataFrame({"d": list(months) * 2, "v": [5.0] * 48})
    r = fc.forecast(df, "d", "v", horizon=3)
    assert r["frequency"] == "month" and r["points"] == 24
    assert r["history"][0]["value"] == 10


def test_too_short_history_is_explained():
    with pytest.raises(fc.ForecastError, match="shorter horizon"):
        fc.forecast(monthly(list(range(10))), "month", "sales", horizon=12)


def test_forecast_endpoint(client):
    rows = monthly([math.sin(i / 2) * 10 + 50 for i in range(30)]).to_dict("records")
    r = client.post("/forecast", json={"data": rows, "date_column": "month", "value_column": "sales", "horizon": 3})
    assert r.status_code == 200 and len(r.json()["forecast"]) == 3
    bad = client.post("/forecast", json={"data": rows, "date_column": "nope", "value_column": "sales"})
    assert bad.status_code == 400
