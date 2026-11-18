import os
import random
import sys

import pytest
from fastapi.testclient import TestClient

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
os.environ.setdefault("ENGINE_SCHEDULER", "0")  # tests drive schedules through /v2/schedules/tick

import main as ml_service_main  # noqa: E402


@pytest.fixture(scope="session")
def client():
    return TestClient(ml_service_main.app)


@pytest.fixture(scope="session", autouse=True)
def _engine_storage(tmp_path_factory):
    # Engine v2 keeps datasets, jobs and results in a throwaway folder during tests.
    from engine import api as engine_api

    engine_api.configure(str(tmp_path_factory.mktemp("engine-storage")))
    yield


def upload_rows(client, rows, name="test"):
    r = client.post("/v2/datasets", json={"name": name, "rows": rows})
    assert r.status_code == 200, r.text
    return r.json()["id"]


def wait_job(client, job_id, timeout=120):
    import time

    deadline = time.time() + timeout
    while time.time() < deadline:
        job = client.get(f"/v2/jobs/{job_id}").json()
        if job["status"] in ("done", "failed", "cancelled"):
            return job
        time.sleep(0.2)
    raise AssertionError(f"job {job_id} did not finish")


def run(client, cap, dataset_id=None, mode="sync", **params):
    r = client.post(f"/v2/run/{cap}", json={"dataset_id": dataset_id, "params": params, "mode": mode, "use_cache": False})
    assert r.status_code == 200, r.text
    body = r.json()
    return body["result"] if mode == "sync" else body


@pytest.fixture
def classification_rows():
    """Deterministic synthetic churn-style dataset with a real, learnable
    signal (Month-to-month + low tenure customers churn much more often),
    so trained models should land in a predictable, sane accuracy range —
    this is what lets the tests assert on real thresholds, not just shapes."""
    random.seed(42)
    rows = []
    for _ in range(300):
        tenure = random.randint(0, 72)
        charges = round(random.uniform(20, 120), 2)
        contract = random.choice(["Month-to-month", "One year", "Two year"])
        churn_prob = 0.75 if (contract == "Month-to-month" and tenure < 12) else 0.08
        churn = "Yes" if random.random() < churn_prob else "No"
        rows.append({
            "tenure": tenure,
            "MonthlyCharges": charges,
            "ContractType": contract,
            "Churn": churn,
        })
    return rows


@pytest.fixture
def regression_rows():
    """Deterministic dataset with a strong, almost-linear signal
    (y = 3*x1 + 2*x2 + noise) so a real fit should reliably score a high R^2."""
    random.seed(7)
    rows = []
    for _ in range(300):
        x1 = random.uniform(0, 50)
        x2 = random.uniform(0, 20)
        noise = random.uniform(-5, 5)
        y = 3 * x1 + 2 * x2 + 10 + noise
        rows.append({"x1": round(x1, 3), "x2": round(x2, 3), "target": round(y, 3)})
    return rows


@pytest.fixture
def eda_rows():
    """Small dataset with known-injected missing values and known-injected
    outliers, so /eda's real numbers can be checked against expectations
    that don't depend on re-implementing pandas in the test."""
    random.seed(3)
    rows = []
    for _ in range(100):
        val = random.uniform(10, 20)
        rows.append({"normal_col": round(val, 3), "category": random.choice(["A", "B"])})
    for extreme in [500, 520, 540]:
        rows.append({"normal_col": extreme, "category": "A"})
    for i in range(5):
        rows[i]["normal_col"] = None
    return rows
