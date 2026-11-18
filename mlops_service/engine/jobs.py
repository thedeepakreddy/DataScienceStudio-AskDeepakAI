"""Background jobs with progress, cancellation and saved results.

Anything heavy runs as a job in a small worker pool. A job's record and its
result are saved to storage, so they survive a page refresh (and, with Cloud
Storage, an instance restart). Results are also cached by a key made of the
capability, the dataset fingerprint, the parameters and the seed, so asking
the same question twice returns the saved answer.
"""
from __future__ import annotations

import json
import logging
import os
import threading
import traceback
import uuid
from collections.abc import Callable
from concurrent.futures import ThreadPoolExecutor
from typing import Any

from .core import Cancelled, EngineError, now_iso
from .storage import Storage

log = logging.getLogger("engine.jobs")


class Jobs:
    def __init__(self, storage: Storage, workers: int | None = None) -> None:
        self.storage = storage
        self.pool = ThreadPoolExecutor(max_workers=workers or int(os.environ.get("ENGINE_JOB_WORKERS", "2")), thread_name_prefix="engine-job")
        self._jobs: dict[str, dict[str, Any]] = {}
        self._cancel: dict[str, threading.Event] = {}
        self._lock = threading.Lock()

    # ---- cache ----
    def cached(self, key: str) -> dict[str, Any] | None:
        try:
            return json.loads(self.storage.get(f"cache/{key}.json"))
        except (FileNotFoundError, ValueError):
            return None

    def remember(self, key: str, result: dict[str, Any]) -> None:
        try:
            self.storage.put(f"cache/{key}.json", json.dumps(result).encode())
        except OSError as err:  # a full disk shouldn't fail the analysis
            log.warning("cache write failed: %s", err)

    # ---- jobs ----
    def _save(self, job: dict[str, Any]) -> None:
        self.storage.put(f"jobs/{job['id']}.json", json.dumps(job).encode())

    def submit(self, kind: str, label: str, work: Callable[[Callable[[float, str], None], Callable[[], bool]], dict[str, Any]],
               cache_key: str | None = None) -> dict[str, Any]:
        job_id = "job_" + uuid.uuid4().hex[:16]
        job = {"id": job_id, "kind": kind, "label": label, "status": "queued", "progress": 0.0, "message": "Waiting to start",
               "createdAt": now_iso(), "startedAt": None, "finishedAt": None, "error": None, "cacheKey": cache_key}
        cancel = threading.Event()
        with self._lock:
            self._jobs[job_id] = job
            self._cancel[job_id] = cancel
        self._save(job)

        def progress(share: float, message: str) -> None:
            job["progress"], job["message"] = round(share, 4), message
            if share in (0.0, 1.0) or int(share * 20) != int(job.get("_lastSaved", -1)):
                job["_lastSaved"] = int(share * 20)
                self._save({k: v for k, v in job.items() if not k.startswith("_")})

        def run() -> None:
            if cancel.is_set():
                return
            job.update(status="running", startedAt=now_iso(), message="Running")
            self._save(self.public(job))
            try:
                result = work(progress, cancel.is_set)
                self.storage.put(f"results/{job_id}.json", json.dumps(result).encode())
                if cache_key:
                    self.remember(cache_key, result)
                job.update(status="done", progress=1.0, message="Done")
            except Cancelled:
                job.update(status="cancelled", message="Cancelled")
            except EngineError as err:
                job.update(status="failed", error={"message": err.message, "code": err.code}, message="Failed")
            except Exception as err:  # noqa: BLE001 - a job must always end in a recorded state
                log.error("job %s failed: %s", job_id, traceback.format_exc())
                job.update(status="failed", error={"message": f"Unexpected error: {err}", "code": "internal"}, message="Failed")
            job["finishedAt"] = now_iso()
            self._save(self.public(job))

        self.pool.submit(run)
        return self.public(job)

    @staticmethod
    def public(job: dict[str, Any]) -> dict[str, Any]:
        return {k: v for k, v in job.items() if not k.startswith("_")}

    def get(self, job_id: str) -> dict[str, Any]:
        with self._lock:
            if job_id in self._jobs:
                return self.public(self._jobs[job_id])
        try:
            return json.loads(self.storage.get(f"jobs/{job_id}.json"))
        except FileNotFoundError as err:
            raise EngineError(f"Job {job_id} wasn't found.", 404, "not_found") from err

    def result(self, job_id: str) -> dict[str, Any]:
        job = self.get(job_id)
        if job["status"] != "done":
            raise EngineError(f"The job is {job['status']}; there is no result yet.", 409, "not_ready")
        return json.loads(self.storage.get(f"results/{job_id}.json"))

    def cancel(self, job_id: str) -> dict[str, Any]:
        job = self.get(job_id)
        ev = self._cancel.get(job_id)
        if ev and job["status"] in ("queued", "running"):
            ev.set()
            if job["status"] == "queued":
                with self._lock:
                    self._jobs[job_id].update(status="cancelled", message="Cancelled", finishedAt=now_iso())
                    self._save(self.public(self._jobs[job_id]))
        return self.get(job_id)

    def list(self, limit: int = 50) -> list[dict[str, Any]]:
        out = []
        for key in self.storage.list("jobs")[-limit * 2:]:
            try:
                out.append(json.loads(self.storage.get(key)))
            except (FileNotFoundError, ValueError):
                continue
        with self._lock:
            live = {j["id"]: self.public(j) for j in self._jobs.values()}
        merged = {j["id"]: j for j in out} | live
        return sorted(merged.values(), key=lambda j: j["createdAt"], reverse=True)[:limit]
