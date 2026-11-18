"""Engine v2 phase 5: time series, unsupervised learning, text and optimisation.
Each test plants a known structure and checks the engine finds it."""
import math

import numpy as np
import pandas as pd
from conftest import run, upload_rows


def _monthly(n=96, seed=1, shift_at=None, spikes=()):
    rng = np.random.default_rng(seed)
    t = np.arange(n)
    y = 100 + 0.5 * t + 15 * np.sin(2 * np.pi * t / 12) + rng.normal(0, 2, n)
    if shift_at is not None:
        y[shift_at:] += 40
    for i in spikes:
        y[i] += 60
    dates = pd.date_range("2015-01-01", periods=n, freq="MS")
    return [{"month": d.strftime("%Y-%m-%d"), "sales": float(v)} for d, v in zip(dates, y)]


def test_forecast_beats_naive_with_intervals(client):
    ds = upload_rows(client, _monthly(), "seasonal")
    r = run(client, "ts.forecast", ds, date="month", value="sales", horizon=12, models=["naive", "seasonal_naive", "ets", "theta", "arima"])
    assert r["frequency"] == "MS" and r["seasonLength"] == 12
    board = {row["model"]: row for row in r["leaderboard"]}
    assert board[r["best"]]["mase"] < board["naive"]["mase"]
    assert len(r["forecast"]) == 12
    f = r["forecast"][0]
    assert f["lower"] is not None and f["lower"] < f["value"] < f["upper"]
    # True next value is about 100 + 0.5*96 + 15*sin(0) = 148.
    assert abs(f["value"] - 148) < 12


def test_decompose_finds_strong_seasonality(client):
    ds = upload_rows(client, _monthly(seed=2), "seasonal2")
    r = run(client, "ts.decompose", ds, date="month", value="sales")
    assert r["strength"]["seasonal"] > 0.8 and r["strength"]["trend"] > 0.8
    assert r["acf"][12] > 0.3
    assert not r["stationarity"]["stationary"]


def test_anomalies_found(client):
    ds = upload_rows(client, _monthly(seed=3, spikes=(30, 70)), "spiky")
    r = run(client, "ts.anomalies", ds, date="month", value="sales")
    flagged = [i for i, p in enumerate(r["series"]) if p["anomaly"]]
    assert 30 in flagged and 70 in flagged
    assert len(flagged) <= 3


def test_changepoint_located():
    from engine.capabilities.timeseries import pelt

    rng = np.random.default_rng(0)
    y = np.concatenate([rng.normal(0, 1, 60), rng.normal(5, 1, 40)])
    cps = pelt(y, 2 * np.log(len(y)) * 2, 3)
    assert len(cps) == 1 and abs(cps[0] - 60) <= 2


def test_changepoints_capability(client):
    rng = np.random.default_rng(4)
    y = np.concatenate([rng.normal(10, 1, 50), rng.normal(20, 1, 50)])
    dates = pd.date_range("2024-01-01", periods=100, freq="D")
    ds = upload_rows(client, [{"day": d.strftime("%Y-%m-%d"), "v": float(v)} for d, v in zip(dates, y)], "level shift")
    r = run(client, "ts.changepoints", ds, date="day", value="v")
    assert len(r["changePoints"]) == 1
    cp = r["changePoints"][0]
    assert cp["date"].startswith("2024-02-19") or cp["date"].startswith("2024-02-20") or cp["date"].startswith("2024-02-18")
    assert abs(cp["from"] - 10) < 1 and abs(cp["to"] - 20) < 1 and cp["p"] < 1e-10


def test_hierarchical_is_coherent(client):
    rng = np.random.default_rng(5)
    rows = []
    for region, stores in {"North": ["N1", "N2"], "South": ["S1", "S2", "S3"]}.items():
        for k, store in enumerate(stores):
            for i, d in enumerate(pd.date_range("2020-01-01", periods=48, freq="MS")):
                rows.append({"month": d.strftime("%Y-%m-%d"), "region": region, "store": store,
                             "sales": float(50 + 10 * k + 5 * math.sin(2 * math.pi * i / 12) + rng.normal(0, 1))})
    ds = upload_rows(client, rows, "stores")
    r = run(client, "ts.hierarchical", ds, date="month", value="sales", levels=["region", "store"], horizon=6)
    by = {tuple(s["node"]): [f["reconciled"] for f in s["forecast"]] for s in r["series"]}
    assert r["bottomSeries"] == 5 and r["nodes"] == 8
    total = np.array(by[("Total",)])
    bottoms = sum(np.array(v) for k, v in by.items() if len(k) == 2)
    north = np.array(by[("North",)])
    assert np.allclose(total, bottoms, atol=1e-6)
    assert np.allclose(north, np.array(by[("North", "N1")]) + np.array(by[("North", "N2")]), atol=1e-6)


def _blobs():
    rng = np.random.default_rng(6)
    centers = [(0, 0), (8, 8), (0, 10)]
    rows = []
    for c, (a, b) in enumerate(centers):
        for _ in range(80):
            rows.append({"x": float(rng.normal(a, 1)), "y": float(rng.normal(b, 1)), "truth": c})
    return rows


def test_kmeans_picks_three_clusters(client):
    rows = _blobs()
    ds = upload_rows(client, rows, "blobs")
    r = run(client, "unsup.cluster", ds, columns=["x", "y"], save_labels=True)
    assert r["k"] == 3
    assert r["quality"]["silhouette"] > 0.6
    assert sorted(p["size"] for p in r["profiles"]) == [80, 80, 80]
    assert r["dataset"]["id"].startswith("ds_")


def test_gmm_and_hdbscan(client):
    ds = upload_rows(client, _blobs(), "blobs2")
    g = run(client, "unsup.cluster", ds, columns=["x", "y"], method="gmm")
    assert g["k"] == 3
    h = run(client, "unsup.cluster", ds, columns=["x", "y"], method="hdbscan", min_cluster_size=20)
    assert h["k"] == 3


def test_pca_embed(client):
    rng = np.random.default_rng(7)
    z = rng.normal(size=300)
    rows = [{"a": float(v), "b": float(2 * v + rng.normal(0, 0.05)), "c": float(-v + rng.normal(0, 0.05)), "d": float(rng.normal())} for v in z]
    ds = upload_rows(client, rows, "pca")
    r = run(client, "unsup.embed", ds, method="pca")
    assert r["explainedVariance"][0] > 0.7
    assert {t["feature"] for t in r["loadings"][0]["top"][:3]} == {"a", "b", "c"}
    assert len(r["points"]) == 300


def test_association_rules(client):
    rng = np.random.default_rng(8)
    rows = []
    for t in range(400):
        items = set(rng.choice(["milk", "eggs", "apples", "soap", "rice"], size=2, replace=False))
        if rng.random() < 0.5:
            items |= {"bread", "butter"}
        rows += [{"basket": t, "item": i} for i in items]
    ds = upload_rows(client, rows, "baskets")
    r = run(client, "unsup.association_rules", ds, transaction="basket", item="item", min_support=0.05, min_confidence=0.5)
    top = r["rules"][0]
    assert {tuple(top["if"]), tuple(top["then"])} <= {("bread",), ("butter",)}
    assert top["lift"] > 1.6 and top["confidence"] > 0.9


def test_text_analyze(client):
    good = ["I love this product, it is excellent and wonderful", "Great service, very happy and delighted",
            "Fantastic quality, love it, amazing"]
    bad = ["Terrible delivery, awful and broken", "I hate it, worst purchase, very bad", "Horrible support, angry and disappointed"]
    rows = [{"review": good[i % 3] if i % 2 else bad[i % 3], "channel": "web" if i % 2 else "store"} for i in range(60)]
    ds = upload_rows(client, rows, "reviews")
    r = run(client, "text.analyze", ds, column="review", group="channel", topics=2, save=True)
    groups = {g["group"]: g for g in r["byGroup"]}
    assert groups["web"]["meanSentiment"] > 0.5 and groups["store"]["meanSentiment"] < -0.5
    assert 0.45 < r["sentiment"]["positive"] < 0.55
    assert len(r["topics"]) == 2 and r["dataset"]["id"].startswith("ds_")


def test_text_similarity(client):
    rows = [{"t": s} for s in ["refund for broken phone", "my phone arrived broken, need refund", "shipping to canada", "how long is shipping",
                               "refund for broken phone"]]
    ds = upload_rows(client, rows, "tickets")
    r = run(client, "text.similarity", ds, column="t", query="broken phone refund", top=2)
    assert {m["row"] for m in r["matches"]} <= {0, 1, 4}
    d = run(client, "text.similarity", ds, column="t")
    assert any(p["a"] == 0 and p["b"] == 4 and p["similarity"] > 0.99 for p in d["duplicatePairs"])


def test_monte_carlo_matches_theory(client):
    r = run(client, "opt.monte_carlo", None, formula="price * volume - fixed", threshold=0, simulations=200_000,
            variables=[{"name": "price", "distribution": "normal", "a": 10, "b": 1},
                       {"name": "volume", "distribution": "constant", "a": 100},
                       {"name": "fixed", "distribution": "uniform", "a": 800, "b": 1000}])
    assert abs(r["mean"] - 100) < 1.5
    # sd = sqrt(100^2 * 1 + 200^2 / 12) = 115.47
    assert abs(r["sd"] - 115.47) < 2
    assert r["sensitivity"][0]["variable"] == "price"
    assert 0.75 < r["probabilityAbove"] < 0.85


def test_safe_eval_blocks_code():
    import pytest

    from engine.capabilities.text_optimize import safe_eval
    from engine.core import EngineError

    assert safe_eval("max(a, 2) * 3", {"a": np.array([1.0, 5.0])}).tolist() == [6.0, 15.0]
    for bad in ["__import__('os')", "a.__class__", "(lambda: 1)()", "[1,2]"]:
        with pytest.raises(EngineError):
            safe_eval(bad, {"a": np.array([1.0])})


def test_linear_program_with_shadow_prices(client):
    # Classic: max 3x + 5y s.t. x <= 4, 2y <= 12, 3x + 2y <= 18  →  x=2, y=6, z=36; duals 0, 1.5, 1.
    r = run(client, "opt.linear_program", None, variables=["x", "y"], objective=[3, 5],
            constraints=[{"coefficients": [1, 0], "sense": "<=", "rhs": 4, "name": "plant1"},
                         {"coefficients": [0, 2], "sense": "<=", "rhs": 12, "name": "plant2"},
                         {"coefficients": [3, 2], "sense": "<=", "rhs": 18, "name": "plant3"}])
    assert r["feasible"] and abs(r["objective"] - 36) < 1e-6
    assert abs(r["solution"]["x"] - 2) < 1e-6 and abs(r["solution"]["y"] - 6) < 1e-6
    sp = [c["shadowPrice"] for c in r["constraints"]]
    assert np.allclose(sp, [0, 1.5, 1], atol=1e-6)
    ip = run(client, "opt.linear_program", None, variables=["a", "b"], objective=[1, 1], integer=["a", "b"],
             constraints=[{"coefficients": [2, 2], "sense": "<=", "rhs": 7}])
    assert abs(ip["objective"] - 3) < 1e-6


def test_scenarios_with_saved_model(client, regression_rows):
    ds = upload_rows(client, regression_rows, "reg for scenarios")
    m = run(client, "ml.automl", ds, target="target", models=["linear"], time_budget_s=20, max_trials_per_model=2, cv_folds=3)
    model_id = m["model"]["id"]
    r = run(client, "opt.scenarios", None, model_id=model_id, base={"x1": 10, "x2": 5}, vary={"x1": [0, 10, 20]})
    preds = [s["prediction"] for s in r["scenarios"]]
    assert preds[0] < preds[1] < preds[2]
    assert abs((preds[2] - preds[0]) - 60) < 6


def test_shadow_prices_for_min_and_ge(client):
    # min 2x + 3y s.t. x + y >= 10, x <= 6  →  x=6, y=4, cost 24; one more unit of demand costs 3.
    r = run(client, "opt.linear_program", None, variables=["x", "y"], objective=[2, 3], sense="minimize",
            constraints=[{"coefficients": [1, 1], "sense": ">=", "rhs": 10}, {"coefficients": [1, 0], "sense": "<=", "rhs": 6}])
    assert abs(r["objective"] - 24) < 1e-6
    sp = [c["shadowPrice"] for c in r["constraints"]]
    assert np.allclose(sp, [3, -1], atol=1e-6)
