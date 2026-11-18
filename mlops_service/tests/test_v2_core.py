"""Engine v2 foundation: datasets, queries, runs, jobs, cache and the token."""
import io
import time

import pandas as pd
import pytest
from pydantic import BaseModel

from conftest import upload_rows
from engine.registry import REGISTRY, capability


class _Echo(BaseModel):
    column: str
    wait_steps: int = 0


@pytest.fixture(scope="module", autouse=True)
def _echo_capability():
    if "test.echo" not in REGISTRY:
        @capability("test.echo", "test", "Echo", "Sums a column.", _Echo)
        def _echo(ctx, p):
            for i in range(p.wait_steps):
                time.sleep(0.05)
                ctx.progress(i / max(1, p.wait_steps), "working")
            df = ctx.frame([p.column])
            return {"sum": df[p.column].sum(), "rows": len(df)}
    yield
    REGISTRY.pop("test.echo", None)


def test_upload_rows_and_meta(client):
    ds = upload_rows(client, [{"a": i, "b": "x" if i % 2 else "y"} for i in range(10)])
    meta = client.get(f"/v2/datasets/{ds}").json()
    assert meta["rows"] == 10
    assert [c["type"] for c in meta["columns"]] == ["integer", "text"]
    # Same content, same ID.
    assert upload_rows(client, [{"a": i, "b": "x" if i % 2 else "y"} for i in range(10)]) == ds


def test_upload_csv_file(client):
    csv = "x,y,when\n1,a,2024-01-01\n2,b,2024-01-02\n3,,2024-01-03\n"
    r = client.post("/v2/datasets/upload", files={"file": ("data.csv", io.BytesIO(csv.encode()), "text/csv")})
    assert r.status_code == 200, r.text
    types = {c["name"]: c["type"] for c in r.json()["columns"]}
    assert types == {"x": "integer", "y": "text", "when": "date"}


def test_upload_excel(client, tmp_path):
    path = tmp_path / "d.xlsx"
    pd.DataFrame({"k": [1, 2], "v": ["a", "b"]}).to_excel(path, index=False)
    r = client.post("/v2/datasets/upload", files={"file": ("d.xlsx", path.read_bytes())})
    assert r.status_code == 200, r.text
    assert r.json()["rows"] == 2


def test_rejects_unknown_file_type(client):
    r = client.post("/v2/datasets/upload", files={"file": ("x.exe", b"MZ")})
    assert r.status_code == 400


def test_query_is_read_only(client):
    ds = upload_rows(client, [{"a": 1}, {"a": 2}])
    ok = client.post(f"/v2/datasets/{ds}/query", json={"sql": "SELECT sum(a) AS s FROM data"}).json()
    assert ok["rows"] == [{"s": 3}]
    for bad in ["DROP VIEW data", "SELECT * FROM read_csv('/etc/passwd')", "SELECT 1; SELECT 2", "COPY data TO 'x.csv'", "ATTACH 'x.db'"]:
        r = client.post(f"/v2/datasets/{ds}/query", json={"sql": bad})
        assert r.status_code == 400, bad


def test_run_sync_has_manifest_and_cache(client):
    ds = upload_rows(client, [{"v": i} for i in range(100)])
    body = {"dataset_id": ds, "params": {"column": "v"}}
    first = client.post("/v2/run/test.echo", json=body).json()
    assert first["cached"] is False and first["result"]["sum"] == 4950
    m = first["result"]["manifest"]
    assert m["engineVersion"] and m["dataset"]["id"] == ds and m["seed"] == 42 and "numpy" in m["libraries"]
    second = client.post("/v2/run/test.echo", json=body).json()
    assert second["cached"] is True and second["result"]["sum"] == 4950


def test_bad_params_and_unknown_capability(client):
    ds = upload_rows(client, [{"v": 1}])
    assert client.post("/v2/run/test.echo", json={"dataset_id": ds, "params": {}}).status_code == 400
    assert client.post("/v2/run/nope.nothing", json={"dataset_id": ds}).status_code == 404
    assert client.post("/v2/run/test.echo", json={"dataset_id": ds, "params": {"column": "missing"}, "use_cache": False}).status_code == 400


def test_job_progress_result_and_cancel(client):
    ds = upload_rows(client, [{"v": i} for i in range(20)])
    job = client.post("/v2/run/test.echo", json={"dataset_id": ds, "params": {"column": "v", "wait_steps": 4}, "mode": "job", "use_cache": False}).json()["job"]
    for _ in range(100):
        state = client.get(f"/v2/jobs/{job['id']}").json()
        if state["status"] in ("done", "failed"):
            break
        time.sleep(0.05)
    assert state["status"] == "done", state
    assert client.get(f"/v2/jobs/{job['id']}/result").json()["sum"] == 190
    slow = client.post("/v2/run/test.echo", json={"dataset_id": ds, "params": {"column": "v", "wait_steps": 60}, "mode": "job", "use_cache": False}).json()["job"]
    time.sleep(0.2)
    client.post(f"/v2/jobs/{slow['id']}/cancel")
    for _ in range(100):
        s = client.get(f"/v2/jobs/{slow['id']}").json()
        if s["status"] in ("cancelled", "done", "failed"):
            break
        time.sleep(0.05)
    assert s["status"] == "cancelled"


def test_token_required_when_set(client, monkeypatch):
    monkeypatch.setenv("ENGINE_TOKEN", "s3cret")
    assert client.get("/v2/info").status_code == 401
    assert client.get("/v2/info", headers={"X-Engine-Token": "wrong"}).status_code == 401
    assert client.get("/v2/info", headers={"X-Engine-Token": "s3cret"}).status_code == 200
    assert client.get("/health").status_code == 200
    assert client.post("/train", json={}).status_code == 401


def test_capabilities_listing(client):
    caps = client.get("/v2/capabilities").json()
    names = {c["name"] for c in caps}
    assert "test.echo" in names
    echo = next(c for c in caps if c["name"] == "test.echo")
    assert "column" in echo["params"]["properties"]
