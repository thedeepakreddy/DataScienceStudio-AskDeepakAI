"""The model store: trained pipelines and their metadata, kept in storage.

Each model is saved as a joblib file plus a JSON record (task, features,
metrics, the dataset fingerprint it was trained on, the manifest, its
registry name, version and stage). Loaded models are kept in a small memory
cache so predictions are fast.

Security: joblib (pickle) can run code when loading, so the store only ever
loads files the engine itself wrote to its own storage. There is no endpoint
that accepts a model file from outside, and none must be added; exported
models are for download only.
"""
from __future__ import annotations

import io
import json
import threading
import uuid
from collections import OrderedDict
from typing import Any

import joblib

from .core import EngineError, now_iso
from .storage import Storage

STAGES = ("none", "staging", "production", "archived")


class ModelStore:
    def __init__(self, storage: Storage, cache_size: int = 8) -> None:
        self.storage = storage
        self._cache: OrderedDict[str, Any] = OrderedDict()
        self._size = cache_size
        self._lock = threading.Lock()

    def save(self, pipeline: Any, meta: dict[str, Any]) -> dict[str, Any]:
        model_id = "mdl_" + uuid.uuid4().hex[:20]
        buf = io.BytesIO()
        joblib.dump(pipeline, buf, compress=3)
        self.storage.put(f"models/{model_id}/model.joblib", buf.getvalue())
        record = {"id": model_id, "createdAt": now_iso(), "stage": "none", "name": meta.get("name"), "version": None,
                  "bytes": buf.tell(), **meta}
        if record.get("name"):
            record["version"] = 1 + max((m.get("version") or 0 for m in self.list() if m.get("name") == record["name"]), default=0)
        self._write(record)
        with self._lock:
            self._remember(model_id, pipeline)
        return record

    def _write(self, record: dict[str, Any]) -> None:
        self.storage.put(f"models/{record['id']}/meta.json", json.dumps(record).encode())

    def _remember(self, model_id: str, pipeline: Any) -> None:
        self._cache[model_id] = pipeline
        self._cache.move_to_end(model_id)
        while len(self._cache) > self._size:
            self._cache.popitem(last=False)

    def meta(self, model_id: str) -> dict[str, Any]:
        try:
            return json.loads(self.storage.get(f"models/{model_id}/meta.json"))
        except FileNotFoundError as err:
            raise EngineError(f"Model {model_id} wasn't found.", 404, "not_found") from err

    def load(self, model_id: str) -> tuple[Any, dict[str, Any]]:
        meta = self.meta(model_id)
        with self._lock:
            if model_id in self._cache:
                self._cache.move_to_end(model_id)
                return self._cache[model_id], meta
        pipeline = joblib.load(io.BytesIO(self.storage.get(f"models/{model_id}/model.joblib")))
        with self._lock:
            self._remember(model_id, pipeline)
        return pipeline, meta

    def bytes(self, model_id: str) -> bytes:
        self.meta(model_id)
        return self.storage.get(f"models/{model_id}/model.joblib")

    def list(self) -> list[dict[str, Any]]:
        out = []
        for key in self.storage.list("models"):
            if key.endswith("/meta.json"):
                try:
                    out.append(json.loads(self.storage.get(key)))
                except (FileNotFoundError, ValueError):
                    continue
        return sorted(out, key=lambda m: m["createdAt"], reverse=True)

    def update(self, model_id: str, **changes: Any) -> dict[str, Any]:
        record = self.meta(model_id)
        if "stage" in changes:
            if changes["stage"] not in STAGES:
                raise EngineError(f"Stage must be one of {', '.join(STAGES)}.")
            if changes["stage"] == "production" and record.get("name"):
                # One production version per registered name: the previous one is archived.
                for other in self.list():
                    if other["id"] != model_id and other.get("name") == record["name"] and other.get("stage") == "production":
                        other["stage"] = "archived"
                        other.setdefault("history", []).append({"at": now_iso(), "stage": "archived", "reason": f"{model_id} promoted"})
                        self._write(other)
        if "name" in changes and changes["name"] and changes["name"] != record.get("name"):
            changes["version"] = 1 + max((m.get("version") or 0 for m in self.list() if m.get("name") == changes["name"]), default=0)
        record.setdefault("history", []).append({"at": now_iso(), **{k: v for k, v in changes.items() if k in ("stage", "name", "version", "description")}})
        record.update(changes)
        self._write(record)
        return record

    def delete(self, model_id: str) -> None:
        self.meta(model_id)
        self.storage.delete(f"models/{model_id}/model.joblib")
        self.storage.delete(f"models/{model_id}/meta.json")
        with self._lock:
            self._cache.pop(model_id, None)
