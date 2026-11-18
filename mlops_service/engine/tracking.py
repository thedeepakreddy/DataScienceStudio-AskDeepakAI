"""Experiment tracking (every run is recorded) and the audit log (every request)."""
from __future__ import annotations

import json
import threading
import time
import uuid
from typing import Any

from .core import fingerprint, now_iso, stamp
from .storage import Storage


def headline(result: dict[str, Any] | None, limit: int = 30) -> dict[str, Any]:
    """The comparable numbers of a result: its top-level scalars and test metrics."""
    out: dict[str, Any] = {}
    if not isinstance(result, dict):
        return out
    for k, v in result.items():
        if k in ("manifest", "notes"):
            continue
        if isinstance(v, bool) or (isinstance(v, (int, float)) and v is not None):
            out[k] = v
        elif isinstance(v, str) and len(v) <= 80:
            out[k] = v
        if len(out) >= limit:
            break
    for block in ("testMetrics", "metrics", "quality", "strength"):
        if isinstance(result.get(block), dict):
            for k, v in result[block].items():
                if isinstance(v, (int, float)) and not isinstance(v, bool):
                    out[f"{block}.{k}"] = v
    return out


def _flatten(d: Any, prefix: str = "") -> dict[str, Any]:
    if isinstance(d, dict):
        out: dict[str, Any] = {}
        for k, v in d.items():
            out.update(_flatten(v, f"{prefix}{k}."))
        return out
    return {prefix[:-1]: d}


class Runs:
    def __init__(self, storage: Storage) -> None:
        self.storage = storage

    def start(self, capability: str, dataset: dict[str, Any] | None, params: dict[str, Any], seed: int,
              experiment: str | None, tags: list[str], source: str = "api") -> dict[str, Any]:
        run = {"id": "run_" + stamp() + uuid.uuid4().hex[:6], "capability": capability, "experiment": experiment,
               "tags": tags, "source": source, "status": "running", "startedAt": now_iso(), "dataset": dataset and {
                   "id": dataset["id"], "name": dataset.get("name"), "fingerprint": dataset.get("fingerprint")},
               "params": params, "paramsFingerprint": fingerprint(params), "seed": seed}
        self.save(run)
        return run

    def finish(self, run: dict[str, Any], result: dict[str, Any] | None = None, error: str | None = None,
               job_id: str | None = None, cached: bool = False) -> dict[str, Any]:
        run.update(status="error" if error else ("queued" if job_id and result is None else "done"), finishedAt=now_iso(), cached=cached)
        if job_id:
            run["jobId"] = job_id
        if error:
            run["error"] = error
        if result is not None:
            run["metrics"] = headline(result)
            for key in ("model", "dataset"):
                if isinstance(result.get(key), dict) and result[key].get("id"):
                    run[f"{key}Id"] = result[key]["id"]
            if "manifest" in result:
                run["durationSeconds"] = result["manifest"].get("durationSeconds")
            self.storage.put(f"runs/{run['id']}/result.json", json.dumps(result).encode())
        self.save(run)
        return run

    def save(self, run: dict[str, Any]) -> None:
        self.storage.put(f"runs/{run['id']}/run.json", json.dumps(run).encode())

    def get(self, run_id: str) -> dict[str, Any]:
        from .core import EngineError

        try:
            return json.loads(self.storage.get(f"runs/{run_id}/run.json"))
        except FileNotFoundError as err:
            raise EngineError(f"Run {run_id} wasn't found.", 404, "not_found") from err

    def result(self, run_id: str) -> dict[str, Any] | None:
        try:
            return json.loads(self.storage.get(f"runs/{run_id}/result.json"))
        except FileNotFoundError:
            return None

    def list(self, experiment: str | None = None, capability: str | None = None, limit: int = 100) -> list[dict[str, Any]]:
        keys = [k for k in self.storage.list("runs") if k.endswith("/run.json")]
        out = []
        for key in reversed(keys):  # ids start with a timestamp, so this is newest first
            try:
                run = json.loads(self.storage.get(key))
            except (FileNotFoundError, ValueError):
                continue
            if (experiment and run.get("experiment") != experiment) or (capability and run.get("capability") != capability):
                continue
            out.append(run)
            if len(out) >= limit:
                break
        return out

    def experiments(self) -> list[dict[str, Any]]:
        groups: dict[str, dict[str, Any]] = {}
        for run in self.list(limit=5000):
            name = run.get("experiment")
            if not name:
                continue
            g = groups.setdefault(name, {"experiment": name, "runs": 0, "capabilities": set(), "lastRunAt": run["startedAt"]})
            g["runs"] += 1
            g["capabilities"].add(run["capability"])
        return [{**g, "capabilities": sorted(g["capabilities"])} for g in groups.values()]

    def compare(self, ids: list[str]) -> dict[str, Any]:
        runs = [self.get(i) for i in ids]
        params = [_flatten(r["params"]) for r in runs]
        keys = sorted(set().union(*params))
        metric_keys = sorted(set().union(*[r.get("metrics", {}).keys() for r in runs]))
        return {"runs": [{"id": r["id"], "capability": r["capability"], "experiment": r.get("experiment"), "startedAt": r["startedAt"],
                          "dataset": r.get("dataset"), "seed": r["seed"], "status": r["status"]} for r in runs],
                "params": [{"param": k, "values": [p.get(k) for p in params], "differs": len({json.dumps(p.get(k), default=str) for p in params}) > 1} for k in keys],
                "metrics": [{"metric": k, "values": [r.get("metrics", {}).get(k) for r in runs]} for k in metric_keys]}


class AuditLog:
    """Buffered request log, written to storage in small batches (one file per batch)."""

    def __init__(self, storage: Storage, batch: int = 50, max_age_s: float = 60) -> None:
        self.storage = storage
        self.batch, self.max_age = batch, max_age_s
        self._buf: list[dict[str, Any]] = []
        self._first = time.monotonic()
        self._lock = threading.Lock()

    def record(self, event: dict[str, Any]) -> None:
        with self._lock:
            if not self._buf:
                self._first = time.monotonic()
            self._buf.append({"at": now_iso(), **event})
            due = len(self._buf) >= self.batch or time.monotonic() - self._first > self.max_age
        if due:
            self.flush()

    def flush(self) -> None:
        with self._lock:
            events, self._buf = self._buf, []
        if events:
            day = events[0]["at"][:10]
            body = "\n".join(json.dumps(e) for e in events).encode()
            self.storage.put(f"audit/{day}/{stamp()}_{uuid.uuid4().hex[:6]}.jsonl", body)

    def recent(self, limit: int = 200) -> list[dict[str, Any]]:
        self.flush()
        out: list[dict[str, Any]] = []
        for key in reversed(self.storage.list("audit")):
            lines = self.storage.get(key).decode().splitlines()
            out.extend(json.loads(line) for line in reversed(lines) if line)
            if len(out) >= limit:
                break
        return out[:limit]
