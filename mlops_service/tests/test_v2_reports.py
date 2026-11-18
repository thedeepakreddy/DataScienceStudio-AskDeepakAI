"""Engine v2 phase 7: methods sections, notebook export, OpenAPI contract, logging."""
import json
import logging

from conftest import upload_rows


def _run(client, ds):
    r = client.post("/v2/run/stats.compare", json={"dataset_id": ds, "params": {"a": "y", "b": "g"}, "mode": "sync", "use_cache": False}).json()
    return r["runId"]


def test_methods_section(client):
    ds = upload_rows(client, [{"g": "a" if i % 2 else "b", "y": float(i % 5 + (i % 2) * 2)} for i in range(60)], "methods")
    m = client.get(f"/v2/runs/{_run(client, ds)}/methods").json()
    assert m["capability"] == "stats.compare"
    assert "“methods” (60 rows" in m["text"] and "random seed 42" in m["text"] and "scikit-learn" in m["text"]
    assert "The test applied was the" in m["text"]
    assert m["markdown"].startswith("## Methods") and "### References" in m["markdown"] and m["references"]


def test_every_capability_has_methods_text():
    from engine.registry import REGISTRY
    from engine.reports import METHODS

    missing = sorted(set(REGISTRY) - set(METHODS) - {"connect.url", "connect.api", "connect.gcs", "connect.bigquery", "connect.sql", "test.echo"})
    assert missing == []


def test_notebook_export_is_valid_and_runnable_shape(client):
    ds = upload_rows(client, [{"g": "a" if i % 2 else "b", "y": float(i % 3)} for i in range(40)], "nb")
    run_id = _run(client, ds)
    r = client.get(f"/v2/runs/{run_id}/notebook")
    assert r.status_code == 200 and r.headers["content-type"].startswith("application/x-ipynb+json")
    nb = json.loads(r.content)
    assert nb["nbformat"] == 4 and nb["metadata"]["askdeepakai"]["runId"] == run_id
    code = "\n".join("".join(c["source"]) for c in nb["cells"] if c["cell_type"] == "code")
    compile(code, "notebook", "exec")  # every cell is valid Python
    assert ds in code and "/v2/run/stats.compare" in code and "'seed': 42" in code


def test_openapi_contract_lists_v2(client):
    spec = client.get("/openapi.json").json()
    paths = spec["paths"]
    for p in ["/v2/run/{name}", "/v2/datasets/upload", "/v2/models/{ref}/predict", "/v2/runs/{run_id}/notebook", "/v2/schedules/tick", "/v2/audit"]:
        assert p in paths, p
    assert spec["info"]["title"]


def test_json_logs():
    from engine.api import JsonLogFormatter

    rec = logging.LogRecord("engine.jobs", logging.INFO, __file__, 1, "job %s done", ("job_1",), None)
    out = json.loads(JsonLogFormatter().format(rec))
    assert out["severity"] == "INFO" and out["message"] == "job job_1 done" and out["logger"] == "engine.jobs"
