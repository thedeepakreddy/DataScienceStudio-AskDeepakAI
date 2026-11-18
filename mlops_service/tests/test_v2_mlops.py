"""Engine v2 phase 6: registry, serving, monitoring, tracking, pipelines, schedules, audit."""
import random
import time

import numpy as np
import pytest
from conftest import run, upload_rows, wait_job


def churn_rows(n=400, seed=42, tenure_shift=0, flip=False):
    rnd = random.Random(seed)
    rows = []
    for _ in range(n):
        tenure = rnd.randint(0, 72) + tenure_shift
        contract = rnd.choice(["Month-to-month", "One year", "Two year"])
        p = 0.8 if (contract == "Month-to-month" and tenure < 12 + tenure_shift) else 0.07
        churn = rnd.random() < p
        if flip:
            churn = not churn
        rows.append({"tenure": tenure, "charges": round(rnd.uniform(20, 120), 2), "contract": contract, "churn": "Yes" if churn else "No"})
    return rows


@pytest.fixture(scope="module")
def trained(client):
    ds = upload_rows(client, churn_rows(), "churn train")
    ids = []
    for _ in range(2):
        r = run(client, "ml.automl", ds, target="churn", models=["linear"], time_budget_s=15, max_trials_per_model=2, cv_folds=3, name="mlops-churn")
        ids.append(r["model"]["id"])
    return ds, ids


def test_registry_versions_stages_and_resolution(client, trained):
    _, (v1, v2) = trained
    meta1, meta2 = client.get(f"/v2/models/{v1}").json(), client.get(f"/v2/models/{v2}").json()
    assert (meta1["version"], meta2["version"]) == (1, 2) and "reference" not in meta1
    assert client.get("/v2/models/mlops-churn").json()["id"] == v2  # latest when nothing is in production
    assert client.patch(f"/v2/models/{v1}", json={"stage": "production"}).json()["stage"] == "production"
    assert client.get("/v2/models/mlops-churn").json()["id"] == v1  # production wins
    client.patch(f"/v2/models/{v2}", json={"stage": "production", "description": "Better one"})
    assert client.get(f"/v2/models/{v1}").json()["stage"] == "archived"
    assert client.get("/v2/models/mlops-churn@production").json()["id"] == v2
    assert client.get("/v2/models/mlops-churn@v1").json()["id"] == v1
    assert client.get("/v2/models/mlops-churn@staging").status_code == 404
    assert [m["id"] for m in client.get("/v2/models", params={"stage": "production"}).json()] == [v2]
    assert client.delete(f"/v2/models/{v2}").status_code == 409


def test_card_and_download(client, trained):
    _, (_, v2) = trained
    card = client.get("/v2/models/mlops-churn@production/card").json()["markdown"]
    assert card.startswith("# Model card: mlops-churn v2") and "Better one" in card and "scikit-learn==" in card
    d = client.get(f"/v2/models/{v2}/download")
    assert d.status_code == 200 and len(d.content) > 500
    assert 'filename="mlops-churn-v2.joblib"' in d.headers["content-disposition"]


def test_online_predict_and_log(client, trained):
    r = client.post("/v2/models/mlops-churn@production/predict", json={"rows": [
        {"tenure": 2, "charges": 90, "contract": "Month-to-month"}, {"tenure": 70, "charges": 30, "contract": "Two year", "extra": 1}]}).json()
    a, b = r["predictions"]
    assert a["probability_Yes"] > 0.5 > b["probability_Yes"]
    assert a["prediction"] == "Yes" and b["prediction"] == "No"
    assert set(a["prediction_set"]) <= {"Yes", "No"}
    bad = client.post("/v2/models/mlops-churn@production/predict", json={"rows": [{"tenure": 3}]})
    assert bad.status_code == 422 and "contract" in bad.json()["detail"]
    client.post("/v2/models/mlops-churn@production/predict", json={"rows": churn_rows(200, seed=9)})
    m = run(client, "mlops.monitor", None, model="mlops-churn@production", source="prediction_log", save=False)
    assert m["source"]["rows"] >= 200 and m["summary"]["featuresChecked"] == 3
    few = run(client, "mlops.monitor", None, model="mlops-churn@production", source="prediction_log", save=False, max_rows=50, min_rows=100)
    assert few["summary"]["status"] == "insufficient_data" and few["summary"]["rows"] == 50


def test_monitor_stable_drifted_and_decayed(client, trained):
    same = upload_rows(client, churn_rows(400, seed=7), "churn same")
    ok = run(client, "mlops.monitor", same, model="mlops-churn@production", target="churn")
    assert ok["summary"]["status"] == "ok", ok["alerts"]
    assert all(f["psi"] < 0.1 for f in ok["features"])
    assert ok["performance"]["status"] == "ok"
    shifted = upload_rows(client, churn_rows(400, seed=8, tenure_shift=40, flip=True), "churn shifted")
    bad = run(client, "mlops.monitor", shifted, model="mlops-churn@production", target="churn")
    by = {f["feature"]: f for f in bad["features"]}
    assert by["tenure"]["status"] == "alert" and by["tenure"]["psi"] > 0.25 and by["tenure"]["meanShiftSd"] > 1.5
    assert by["contract"]["status"] == "ok"
    assert bad["performance"]["status"] == "alert" and bad["summary"]["status"] == "alert"
    assert {a["kind"] for a in bad["alerts"]} >= {"data drift", "performance"}
    hist = client.get("/v2/models/mlops-churn@production/monitoring").json()
    assert [h["summary"]["status"] for h in hist[:2]] == ["alert", "ok"]


def test_psi_reference_values():
    from engine.capabilities.mlops import numeric_drift, psi

    assert psi([0.5, 0.5], [0.5, 0.5]) == pytest.approx(0, abs=1e-12)
    # PSI = sum (a-e) ln(a/e): (0.6-0.5)ln(1.2) + (0.4-0.5)ln(0.8)
    assert psi([0.5, 0.5], [0.6, 0.4]) == pytest.approx(0.1 * np.log(1.2) - 0.1 * np.log(0.8))
    rng = np.random.default_rng(0)
    ref = rng.normal(size=20000)
    profile = {"quantiles": np.quantile(ref, np.linspace(0, 1, 11)).tolist(), "mean": 0.0, "sd": 1.0}
    import pandas as pd

    assert numeric_drift(profile, pd.Series(rng.normal(size=5000)))["psi"] < 0.02
    assert numeric_drift(profile, pd.Series(rng.normal(1, 1, 5000)))["psi"] > 0.5


def test_runs_experiments_and_compare(client):
    ds = upload_rows(client, [{"g": "a" if i % 2 else "b", "y": float(i % 7 + (i % 2) * 3)} for i in range(80)], "exp data")
    ids = []
    for alt in ("two-sided", "greater"):
        r = client.post("/v2/run/stats.compare", json={"dataset_id": ds, "params": {"a": "y", "b": "g", "alternative": alt},
                                                       "mode": "sync", "use_cache": False, "experiment": "exp-1", "tags": ["t"]}).json()
        ids.append(r["runId"])
    listed = client.get("/v2/runs", params={"experiment": "exp-1"}).json()
    assert {r["id"] for r in listed} == set(ids) and all(r["status"] == "done" for r in listed)
    detail = client.get(f"/v2/runs/{ids[0]}").json()
    assert detail["result"]["manifest"]["capability"] == "stats.compare" and detail["dataset"]["id"] == ds
    cmp = client.post("/v2/runs/compare", json={"ids": ids}).json()
    diff = {p["param"]: p for p in cmp["params"]}
    assert diff["alternative"]["differs"] and not diff["a"]["differs"]
    assert any(e["experiment"] == "exp-1" and e["runs"] == 2 for e in client.get("/v2/experiments").json())


def test_pipeline_chains_datasets(client):
    ds = upload_rows(client, [{"x": i, "k": "keep" if i % 3 else "drop"} for i in range(60)], "pipe")
    body = {"name": "clean then profile", "experiment": "pipe-exp", "steps": [
        {"capability": "data.recipe", "dataset_id": ds, "params": {"steps": [{"op": "filter", "condition": "k = 'keep'"}], "name": "kept"}},
        {"capability": "data.profile", "dataset_id": "$prev", "params": {}}]}
    r = client.post("/v2/pipelines/run", json=body).json()
    job = wait_job(client, r["job"]["id"])
    assert job["status"] == "done", job
    res = client.get(f"/v2/jobs/{job['id']}/result").json()
    assert res["steps"][1]["dataset"] == res["steps"][0]["dataset"] != ds
    assert res["final"]["rows"] == 40
    assert len(client.get("/v2/runs", params={"experiment": "pipe-exp"}).json()) == 2
    bad = client.post("/v2/pipelines/run", json={"steps": [{"capability": "data.profile", "dataset_id": "$prev"}]})
    assert bad.status_code == 400


def test_schedules_tick(client):
    ds = upload_rows(client, [{"x": i} for i in range(20)], "sched")
    s = client.post("/v2/schedules", json={"name": "nightly profile", "every_minutes": 60, "start_at": time.time() - 5,
                                           "steps": [{"capability": "data.profile", "dataset_id": ds}]}).json()
    started = client.post("/v2/schedules/tick").json()["started"]
    assert [x["schedule"] for x in started] == [s["id"]]
    assert wait_job(client, started[0]["job"])["status"] == "done"
    after = next(x for x in client.get("/v2/schedules").json() if x["id"] == s["id"])
    assert after["nextRunAt"] > time.time() + 3000 and after["lastRun"]["jobId"] == started[0]["job"]
    assert client.post("/v2/schedules/tick").json()["started"] == []
    client.patch(f"/v2/schedules/{s['id']}", json={"enabled": False})
    assert client.delete(f"/v2/schedules/{s['id']}").json() == {"deleted": s["id"]}
    assert client.post("/v2/schedules", json={"every_minutes": 1, "steps": [{"capability": "data.profile"}]}).status_code == 422


def test_audit_log_records_requests(client, monkeypatch):
    client.get("/v2/info", headers={"X-Engine-User": "tester"})
    monkeypatch.setenv("ENGINE_TOKEN", "s3cret")
    assert client.get("/v2/capabilities").status_code == 401
    monkeypatch.delenv("ENGINE_TOKEN")
    events = client.get("/v2/audit", params={"limit": 50}).json()
    assert any(e["path"] == "/v2/info" and e["actor"] == "tester" and e["status"] == 200 for e in events)
    assert any(e["path"] == "/v2/capabilities" and e["status"] == 401 for e in events)
    assert all("s3cret" not in str(e) for e in events)


def test_reason_codes_explain_predictions(client, trained):
    r = client.post("/v2/models/mlops-churn@production/predict", json={"explain": True, "log": False, "rows": [
        {"tenure": 1, "charges": 70, "contract": "Month-to-month"}, {"tenure": 70, "charges": 70, "contract": "Two year"}]}).json()
    new, loyal = r["reasons"] if "reasons" in r else [p["reasons"] for p in r["predictions"]]
    assert new[0]["feature"] in ("tenure", "contract") and new[0]["effect"] > 0  # raises churn risk vs a typical customer
    assert loyal[0]["feature"] in ("tenure", "contract") and loyal[0]["effect"] < 0
    assert all({"feature", "value", "typical", "effect"} <= set(x) for x in new)


def test_production_approval(client, trained, monkeypatch):
    _, (v1, _) = trained
    monkeypatch.setenv("ENGINE_REQUIRE_APPROVAL", "1")
    denied = client.patch(f"/v2/models/{v1}", json={"stage": "production"})
    assert denied.status_code == 403 and denied.json()["code"] == "approval_required"
    ok = client.patch(f"/v2/models/{v1}", json={"stage": "production", "note": "rollback test"}, headers={"X-Engine-User": "lead@example.com"}).json()
    assert ok["approvedBy"] == "lead@example.com" and ok["history"][-1]["note"] == "rollback test"
    assert "Approved for production** by lead@example.com" in client.get(f"/v2/models/{v1}/card").json()["markdown"]


def test_tick_wait_runs_to_completion(client):
    ds = upload_rows(client, [{"x": i} for i in range(30)], "tick wait")
    s = client.post("/v2/schedules", json={"every_minutes": 30, "start_at": time.time() - 1, "steps": [{"capability": "data.profile", "dataset_id": ds}]}).json()
    r = client.post("/v2/schedules/tick", params={"wait": True}).json()
    mine = [x for x in r["started"] if x["schedule"] == s["id"]]
    assert mine and mine[0]["status"] == "done"
    client.delete(f"/v2/schedules/{s['id']}")


def test_upload_url_needs_cloud_storage(client):
    r = client.post("/v2/datasets/upload-url", json={"filename": "big.csv"})
    assert r.status_code == 400 and r.json()["code"] == "not_supported"
    assert client.post("/v2/datasets/upload-url", json={"filename": "../x.csv"}).status_code == 422


def test_retrain_only_when_drift_is_found(client, trained):
    same = upload_rows(client, churn_rows(400, seed=21), "churn steady")
    calm = run(client, "mlops.retrain_if_drift", same, model="mlops-churn@production", time_budget_s=10)
    assert calm["retrained"] is False and calm["status"] in ("ok", "warning") and "No retrain" in calm["decision"]
    shifted = upload_rows(client, churn_rows(400, seed=22, tenure_shift=40, flip=True), "churn drifted")
    r = run(client, "mlops.retrain_if_drift", shifted, model="mlops-churn@production", time_budget_s=10, promote="production_if_better")
    assert r["retrained"] is True and r["status"] == "alert"
    new = client.get(f"/v2/models/{r['newModel']['id']}").json()
    assert new["name"] == "mlops-churn" and new["trainedOn"]["dataset"] == shifted
    assert r["comparison"]["newIsBetter"] is True and new["stage"] == "production"  # the flipped outcome makes the old model wrong


def test_automl_validation_split(client):
    rows = churn_rows(500, seed=5)
    ds = upload_rows(client, rows, "churn val")
    r = run(client, "ml.automl", ds, target="churn", models=["linear"], time_budget_s=8, max_trials_per_model=2, cv_folds=3, ensemble=False,
            test_size=0.15, validation_size=0.15)
    assert r["rows"]["validation"] == 75 and r["rows"]["test"] == 75 and r["rows"]["train"] == 350
    assert r["validation"]["accuracy"] > 0.6
