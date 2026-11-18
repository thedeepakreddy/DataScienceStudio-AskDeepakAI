"""Engine v2, phase 4: AutoML v2, batch prediction, explanations, fairness, feature selection."""
import numpy as np
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


def test_explain_fairness_and_selection(client, churn, trained):
    e = run(client, "ml.explain", churn, model_id=trained["model"]["id"], sample=200)
    assert e["partialDependence"] and e["surrogate"]["fidelity"] > 0.6
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
