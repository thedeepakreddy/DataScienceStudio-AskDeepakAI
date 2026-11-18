"""Engine v2, phase 1: profiling, estimates, rules, outliers, PII, recipes, connectors."""
import numpy as np
import pytest
from conftest import run, upload_rows


@pytest.fixture(scope="module")
def sales(client):
    rng = np.random.default_rng(0)
    rows = []
    for i in range(400):
        region = ["North", "South", "East", "West"][i % 4]
        amount = float(round(rng.gamma(2, 50), 2)) if i % 50 else 5000.0
        rows.append({"id": i, "region": region, "amount": None if i % 37 == 0 else amount,
                     "date": f"2024-{(i % 12) + 1:02d}-{(i % 27) + 1:02d}", "email": f"user{i}@example.com",
                     "note": "  Hello   World  " if i % 3 == 0 else "ok"})
    return upload_rows(client, rows, "sales")


def test_profile(client, sales):
    r = run(client, "data.profile", sales)
    cols = {c["name"]: c for c in r["columns"]}
    assert r["rows"] == 400 and r["duplicateRows"] == 0
    assert cols["amount"]["missing"] == 11 and cols["amount"]["outliersIqr"] >= 7
    assert cols["region"]["topValues"][0]["count"] == 100
    assert cols["email"]["patterns"]["email"] == pytest.approx(1.0)
    assert "id_like" in cols["email"]["flags"] and "extra_spaces" in cols["note"]["flags"]
    assert sum(b["count"] for b in cols["amount"]["histogram"]) == 389


def test_estimate_contains_exact(client, sales):
    r = run(client, "data.estimate", sales, column="amount", sample_size=200)
    assert r["sampleRows"] == 200 and r["ci"][0] < r["estimate"] < r["ci"][1]
    p = run(client, "data.estimate", sales, column="region", statistic="proportion", value="North", sample_size=300)
    assert p["exact"] == pytest.approx(0.25)


def test_validate_rules(client, sales):
    r = run(client, "data.validate", sales, rules=[
        {"kind": "not_null", "column": "amount"},
        {"kind": "unique", "column": "id"},
        {"kind": "between", "column": "amount", "min": 0, "max": 1000},
        {"kind": "in_set", "column": "region", "values": ["North", "South", "East", "West"]},
        {"kind": "regex", "column": "email", "pattern": r"[^@]+@[^@]+\.com"},
        {"kind": "row_count_between", "min": 100},
        {"kind": "expression", "expression": "id >= 0"},
        {"kind": "not_null", "column": "missing_col"},
    ])
    by = [x["passed"] for x in r["results"]]
    assert by == [False, True, False, True, True, True, True, False]
    assert r["results"][0]["failing"] == 11 and r["results"][2]["failing"] == 7  # one planted value sits on a missing row
    assert r["results"][0]["examples"]


@pytest.mark.parametrize("method", ["iqr", "zscore", "mad", "isolation_forest", "lof"])
def test_outliers_find_the_planted_values(client, sales, method):
    r = run(client, "data.outliers", sales, columns=["amount"], method=method, threshold=0.03 if method in ("isolation_forest", "lof") else None)
    big = [e for e in r["examples"] if e["amount"] == 5000.0]
    assert r["flaggedRows"] >= 1 and big, method


@pytest.mark.parametrize("method", ["isolation_forest", "lof"])
def test_forest_outliers_default_flags_only_clear_outliers(client, method):
    # Ordinary data plus one far-off row: without an expected share only that row stands out.
    rng = np.random.default_rng(3)
    rows = [{"a": float(x), "b": float(y)} for x, y in rng.normal(size=(400, 2))] + [{"a": 40.0, "b": -40.0}]
    ds = upload_rows(client, rows, "plain")
    r = run(client, "data.outliers", ds, method=method)
    assert r["flaggedShare"] < 0.05, r["flaggedShare"]  # was 35% with scikit-learn's "auto" cut-off
    assert any(e["a"] == 40.0 for e in r["examples"])


def test_pii_scan_and_mask(client, sales):
    r = run(client, "data.pii_scan", sales)
    found = {f["column"]: f for f in r["findings"]}
    assert "email" in found["email"]["detected"]
    m = run(client, "data.pii_mask", sales, columns=["email"], method="hash", salt="pepper")
    ds = m["dataset"]["id"]
    sample = client.get(f"/v2/datasets/{ds}/preview?limit=3").json()["rows"]
    assert all(len(row["email"]) == 64 and "@" not in row["email"] for row in sample)
    assert m["manifest"]["params"]["salt"] == "•••"


def test_recipe_steps_and_save(client, sales):
    regions = upload_rows(client, [{"region": "North", "manager": "Ana"}, {"region": "South", "manager": "Ben"}], "regions")
    steps = [
        {"op": "fill_missing", "columns": ["amount"], "strategy": "median"},
        {"op": "text_clean", "columns": ["note"], "ops": ["trim", "collapse_spaces", "lower"]},
        {"op": "date_parts", "column": "date", "parts": ["year", "month", "is_weekend"]},
        {"op": "join", "dataset_id": regions, "on": ["region"], "how": "left"},
        {"op": "derive", "name": "big", "expression": "amount > 200"},
        {"op": "window", "kind": "cumsum", "column": "amount", "partition_by": ["region"], "order_by": ["id"], "name": "running"},
        {"op": "filter", "column": "region", "operator": "in", "value": ["North", "South"]},
    ]
    prev = run(client, "data.recipe", sales, steps=steps, preview=True, preview_rows=5)
    assert prev["rows"] == 200
    assert {"date_year", "date_month", "manager", "big", "running"} <= set(prev["columns"])
    assert prev["sample"][0]["note"] in ("hello world", "ok")
    saved = run(client, "data.recipe", sales, steps=steps, name="prepared")
    meta = saved["dataset"]
    assert meta["rows"] == 200 and meta["source"]["kind"] == "derived"
    q = client.post(f"/v2/datasets/{meta['id']}/query", json={"sql": "SELECT count(*) n FROM data WHERE amount IS NULL OR manager IS NULL"}).json()
    assert q["rows"][0]["n"] == 0


def test_recipe_group_pivot_unpivot_onehot_scale(client, sales):
    g = run(client, "data.recipe", sales, preview=True, steps=[
        {"op": "group", "by": ["region"], "aggregations": [{"column": "amount", "fn": "sum", "as": "total"}, {"fn": "count", "as": "n"}]}])
    assert g["rows"] == 4 and {r["n"] for r in g["sample"]} == {100}
    pv = run(client, "data.recipe", sales, preview=True, steps=[
        {"op": "date_parts", "column": "date", "parts": ["month"]},
        {"op": "pivot", "column": "region", "values": "amount", "agg": "sum", "index": ["date_month"]}])
    assert pv["rows"] == 12 and {"North", "South", "East", "West"} <= set(pv["columns"])
    up = run(client, "data.recipe", sales, preview=True, steps=[{"op": "select", "columns": ["id", "amount", "id"]}, {"op": "unpivot", "columns": ["amount"]}])
    assert set(up["columns"]) >= {"variable", "value"}
    oh = run(client, "data.recipe", sales, preview=True, steps=[{"op": "one_hot", "column": "region"}, {"op": "scale", "columns": ["amount"], "method": "standard"}])
    assert {"region_North", "region_West"} <= set(oh["columns"])
    dd = run(client, "data.recipe", sales, preview=True, steps=[{"op": "dedupe", "columns": ["region"]}, {"op": "sample", "n": 2}])
    assert dd["rows"] == 2


def test_recipe_rejects_unsafe_and_bad_columns(client, sales):
    for steps in ([{"op": "derive", "name": "x", "expression": "(SELECT * FROM read_csv('/etc/passwd'))"}],
                  [{"op": "filter", "condition": "1=1; DROP VIEW data"}],
                  [{"op": "select", "columns": ["nope"]}]):
        r = client.post("/v2/run/data.recipe", json={"dataset_id": sales, "params": {"steps": steps, "preview": True}, "mode": "sync"})
        assert r.status_code == 400, steps


def test_connectors_refuse_private_addresses(client):
    r = client.post("/v2/run/connect.url", json={"params": {"url": "http://127.0.0.1:8000/data.csv"}, "mode": "sync"})
    assert r.status_code == 400 and "private or internal" in r.json()["detail"]
    r = client.post("/v2/run/connect.sql", json={"params": {"engine": "postgresql", "host": "localhost", "database": "x", "user": "u",
                                                             "password": "pw", "query": "select 1"}, "mode": "sync"})
    assert r.status_code == 400
    r = client.post("/v2/run/connect.sql", json={"params": {"engine": "postgresql", "host": "db.example.com", "database": "x", "user": "u",
                                                             "password": "pw", "query": "delete from t"}, "mode": "sync"})
    assert r.status_code == 400 and "SELECT" in r.json()["detail"]


def test_yes_no_columns_stay_text_and_true_false_become_boolean(client):
    csv = "churn,flag,yn,n\nYes,true,Y,1\nNo,false,N,2\nYes,TRUE,y,3\n"
    r = client.post("/v2/datasets/upload", files={"file": ("yn.csv", csv.encode(), "text/csv")})
    kinds = {c["name"]: c["type"] for c in r.json()["columns"]}
    assert kinds == {"churn": "text", "flag": "boolean", "yn": "text", "n": "integer"}
    rows = client.get(f"/v2/datasets/{r.json()['id']}/preview").json()["rows"]
    assert rows[0]["churn"] == "Yes" and rows[0]["flag"] is True


def test_recipe_label_encode(client, sales):
    r = run(client, "data.recipe", sales, preview=True, steps=[{"op": "label_encode", "columns": ["region"], "method": "alphabetical"}])
    codes = {row["id"] % 4: row["region"] for row in r["sample"]}
    assert codes == {0: 1, 1: 2, 2: 0, 3: 3}  # North, South, East, West -> East 0, North 1, South 2, West 3


class _Resp:
    def __init__(self, body, status=200, links=None):
        self.body, self.status_code, self.links = body, status, links or {}

    def json(self):
        return self.body


def test_api_import_auth_and_pagination(client, monkeypatch):
    import engine.capabilities.data_connectors as dc

    calls = []
    pages = {1: [{"id": 1, "user": {"name": "a"}}, {"id": 2, "user": {"name": "b"}}], 2: [{"id": 3, "user": {"name": "c"}}], 3: []}

    def fake_get(url, headers=None, params=None, auth=None, **_):
        calls.append((url, dict(headers or {}), dict(params or {})))
        if headers.get("X-Key") != "s3cret":
            return _Resp({"error": "no"}, 401)
        return _Resp({"data": {"items": pages[params["page"]]}})

    monkeypatch.setattr(dc, "_public_host", lambda host: None)
    monkeypatch.setattr(dc.requests, "get", fake_get)
    r = run(client, "connect.api", url="https://api.example.com/v1/users", auth="header", key_name="X-Key", api_key="s3cret",
            records_path="data.items", pagination="page", name="users")
    assert r["records"] == 3 and r["pages"] == 3 and "user.name" in r["columns"]
    assert r["dataset"]["rows"] == 3 and "s3cret" not in str(r["manifest"])
    bad = client.post("/v2/run/connect.api", json={"params": {"url": "https://api.example.com/x", "auth": "header", "key_name": "X-Key",
                                                               "api_key": "wrong"}, "mode": "sync"})
    assert bad.status_code == 400 and "refused" in bad.json()["detail"]

    # Next links are followed, and each one is checked against private addresses.
    seen = []
    monkeypatch.setattr(dc, "_public_host", lambda host: seen.append(host))
    nxt = {"https://api.example.com/a": _Resp({"results": [{"v": 1}], "next": "/b"}), "https://api.example.com/b": _Resp({"results": [{"v": 2}], "next": None})}
    monkeypatch.setattr(dc.requests, "get", lambda url, **_: nxt[url])
    r2 = run(client, "connect.api", url="https://api.example.com/a", pagination="next_link")
    assert r2["records"] == 2 and seen == ["api.example.com", "api.example.com"]
