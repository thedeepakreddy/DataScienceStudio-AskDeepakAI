"""Engine v2, phase 4: AutoML v2, batch prediction, explanations, fairness, feature selection."""
import numpy as np
import pandas as pd
import pytest
from conftest import run, upload_rows


@pytest.fixture(scope="module")
def churn(client):
    rng = np.random.default_rng(11)
    rows = []
    for i in range(1200):
        tenure = int(rng.integers(0, 72))
        contract = ["Monthly", "Yearly", "Two year"][i % 3]
        charges = float(rng.uniform(20, 120))
        gender = "F" if rng.random() < 0.5 else "M"
        city = f"city{int(rng.integers(0, 60))}"
        logit = -1.0 + (1.8 if contract == "Monthly" else -0.8) - 0.05 * tenure + 0.01 * charges
        churn = "Yes" if rng.random() < 1 / (1 + np.exp(-logit)) else "No"
        rows.append({"customer_id": f"C{i:05d}", "tenure": tenure, "contract": contract, "charges": charges, "gender": gender,
                     "city": city, "signup": f"2023-{int(rng.integers(1, 13)):02d}-15", "churn": churn})
    return upload_rows(client, rows, "churn")


@pytest.fixture(scope="module")
def trained(client, churn):
    r = run(client, "ml.automl", churn, target="churn", models=["linear", "random_forest", "lightgbm", "catboost"],
            time_budget_s=20, max_trials_per_model=3, cv_folds=3, sensitive_features=["gender"], name="churn-model")
    return r


def test_automl_classification(trained):
    r = trained
    assert r["task"] == "classification" and r["classes"] == ["No", "Yes"]
    assert "customer_id" in r["features"]["dropped"]  # IDs are left out automatically
    assert "city" in r["features"]["high_card"] and "signup" in r["features"]["date"]
    fams = [b["family"] for b in r["leaderboard"] if "cvMean" in b]
    assert {"linear", "random_forest", "lightgbm", "catboost"} <= set(fams) and "stacked" in fams
    assert r["test"]["rocAuc"] > 0.75 and r["test"]["rocAuc"] > r["baseline"]["test"].get("rocAuc", 0.5)
    lo, hi = r["champion"]["cvCi"]
    assert lo <= r["champion"]["cvMean"] <= hi
    assert len(r["roc"]) > 5 and len(r["lift"]) == 10 and r["calibration"]["bins"]
    assert r["importance"][0]["feature"] in ("contract", "tenure")
    assert 0.8 <= r["conformal"]["testCoverage"] <= 1.0
    assert r["fairness"][0]["feature"] == "gender" and "disparateImpactRatio" in r["fairness"][0]["summary"]
    assert r["model"]["id"].startswith("mdl_") and r["model"]["version"] == 1


def test_automl_regression_with_intervals(client):
    rng = np.random.default_rng(12)
    rows = [{"x1": float(a), "x2": float(b), "cat": ["a", "b", "c"][i % 3], "y": float(3 * a - 2 * b + (5 if i % 3 == 0 else 0) + rng.normal(0, 1))}
            for i, (a, b) in enumerate(rng.normal(size=(600, 2)))]
    ds = upload_rows(client, rows, "reg")
    r = run(client, "ml.automl", ds, target="y", models=["linear", "hist_gradient_boosting", "xgboost"], time_budget_s=15, max_trials_per_model=2, cv_folds=3, ensemble=False)
    assert r["task"] == "regression" and r["test"]["r2"] > 0.9
    assert r["conformal"]["testCoverage"] >= 0.8 and r["residuals"]["points"]
    assert r["comparison"] is not None and "p" in r["comparison"]


def test_predict_batch_with_sets(client, churn, trained):
    r = run(client, "ml.predict", churn, model_id=trained["model"]["id"], keep_columns=["customer_id"], batch_rows=1000)
    ds = r["dataset"]
    assert ds["rows"] == 1200
    cols = {c["name"] for c in ds["columns"]}
    assert {"customer_id", "prediction", "probability_Yes", "probability_No", "prediction_set"} <= cols
    # Batch scoring applies the model's chosen cut-off, exactly as the single-row endpoint does.
    meta = client.get(f"/v2/models/{trained['model']['id']}").json()
    assert meta["threshold"] is not None and "decision" in cols
    rows = client.get(f"/v2/datasets/{ds['id']}/preview?limit=200").json()["rows"]
    assert all(row["decision"] == ("Yes" if row["probability_Yes"] >= meta["threshold"] else "No") for row in rows)


def test_explain_fairness_and_selection(client, churn, trained):
    e = run(client, "ml.explain", churn, model_id=trained["model"]["id"], sample=200)
    assert e["partialDependence"] and e["surrogate"]["fidelity"] > 0.6
    # Integer columns get partial dependence too (scikit-learn refuses ints), and the surrogate's rules
    # are in the data's own units and categories, not the model's scaled, one-hot space.
    assert "tenure" in {x["feature"] for x in e["partialDependence"]}
    rules = e["surrogate"]["rules"]
    assert "tenure <=" in rules or "charges <=" in rules
    assert not any(t in rules for t in ("num__", "cat__", "<= -"))
    if "shapGlobal" in e:
        assert e["shapGlobal"][0]["feature"] in ("contract", "tenure", "charges") and e["local"][0]["reasons"]
    f = run(client, "ml.fairness", churn, model_id=trained["model"]["id"], target="churn", sensitive_features=["gender"])
    assert len(f["fairness"][0]["groups"]) == 2
    s = run(client, "ml.feature_selection", churn, target="churn", features=["tenure", "contract", "charges", "gender"], shadow_rounds=4)
    assert "tenure" in s["recommended"] and "contract" in s["recommended"]


def test_predict_rejects_missing_features(client, trained):
    other = upload_rows(client, [{"a": 1}, {"a": 2}], "other")
    r = client.post("/v2/run/ml.predict", json={"dataset_id": other, "params": {"model_id": trained["model"]["id"]}, "mode": "sync"})
    assert r.status_code == 400 and "missing feature" in r.json()["detail"]


def test_automl_nested_cv_interactions_and_costs(client):
    import random

    random.seed(3)
    rows = []
    for _ in range(500):
        a, b = random.uniform(-1, 1), random.uniform(-1, 1)
        # The class depends on the interaction a*b, which a linear model only sees through the product feature.
        rows.append({"a": round(a, 4), "b": round(b, 4), "noise": round(random.random(), 4), "y": "pos" if a * b + random.gauss(0, 0.05) > 0 else "neg"})
    ds = upload_rows(client, rows, "interaction")
    plain = run(client, "ml.automl", ds, target="y", models=["linear"], time_budget_s=10, max_trials_per_model=2, cv_folds=3, ensemble=False)
    inter = run(client, "ml.automl", ds, target="y", models=["linear"], time_budget_s=10, max_trials_per_model=2, cv_folds=3, ensemble=False,
                interactions=True, nested_cv=True, cost_false_positive=1, cost_false_negative=5, positive_class="pos")
    assert plain["test"]["rocAuc"] < 0.7 < 0.9 < inter["test"]["rocAuc"]
    nested = inter["nestedCv"]
    assert len(nested["scores"]) == 3 and nested["familiesChosen"] == ["linear"] * 3
    assert abs(nested["mean"] - inter["champion"]["cvMean"]) < 0.05
    cost = inter["costThreshold"]
    assert cost["threshold"] < inter["bestF1Threshold"]  # missed positives cost 5×, so flag more readily
    # Chosen on out-of-fold training predictions, so it's optimal there (the test set is only for reporting).
    assert cost["costPerRowTrain"] <= cost["costPerRowTrainAtHalf"]
    assert cost["costPerRowTest"] < 0.5
    meta = client.get(f"/v2/models/{inter['model']['id']}").json()
    assert meta["threshold"] == cost["threshold"]


def test_numeric_ids_left_out_and_date_rules_readable(client):
    rng = np.random.default_rng(5)
    rows = []
    for i in range(400):
        day = pd.Timestamp("2022-01-01") + pd.Timedelta(days=int(i * 2))
        late = day >= pd.Timestamp("2022-09-01")
        rows.append({"customer_id": 5000 + i, "signup": day.strftime("%Y-%m-%d"), "spend": float(rng.normal(50, 10)),
                     "churn": "Yes" if (late and rng.random() < 0.85) or (not late and rng.random() < 0.1) else "No"})
    ds = upload_rows(client, rows, "ids")
    r = run(client, "ml.automl", ds, target="churn", models=["random_forest"], time_budget_s=10, max_trials_per_model=1, cv_folds=3, ensemble=False)
    assert "customer_id" not in r["features"]["used"] and "signup" in r["features"]["used"]
    e = run(client, "ml.explain", ds, model_id=r["model"]["id"], sample=200)
    rules = e["surrogate"]["rules"]
    assert "signup is before 2022-0" in rules or "signup is on or after 2022-0" in rules
    assert "00:00:00" not in rules and "(date)" not in rules
