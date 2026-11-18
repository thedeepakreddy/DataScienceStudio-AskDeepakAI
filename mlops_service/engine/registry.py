"""The capability registry: every analysis the engine can run.

A capability is a typed function `fn(ctx, params) -> dict`. It is registered
with a name (e.g. "stats.glm"), an area, a short description and a Pydantic
model for its parameters, so the API, the job runner, the docs and the agent
team can all discover it (`GET /v2/capabilities`).
"""
from __future__ import annotations

import time
from collections.abc import Callable
from dataclasses import dataclass, field
from typing import Any

import numpy as np
import pandas as pd
from pydantic import BaseModel, ValidationError

from .core import Cancelled, EngineError, fingerprint, jsonable, manifest
from .datasets import Datasets


class Context:
    """What a capability gets: its dataset, the seed, progress and cancellation."""

    def __init__(self, datasets: Datasets, dataset: dict[str, Any] | None, seed: int,
                 progress: Callable[[float, str], None] | None = None, cancelled: Callable[[], bool] | None = None,
                 models: Any = None) -> None:
        self.datasets = datasets
        self.models = models
        self.dataset = dataset
        self.seed = seed
        self._progress = progress
        self._cancelled = cancelled
        self.rng = np.random.default_rng(seed)
        self.notes: list[str] = []

    # ---- data ----
    @property
    def dataset_id(self) -> str:
        if not self.dataset:
            raise EngineError("This analysis needs a dataset.")
        return self.dataset["id"]

    def columns(self) -> list[dict[str, Any]]:
        return self.dataset["columns"] if self.dataset else []

    def column_names(self) -> list[str]:
        return [c["name"] for c in self.columns()]

    def require(self, *names: str | None) -> None:
        known = set(self.column_names())
        missing = [n for n in names if n and n not in known]
        if missing:
            raise EngineError(f"Column(s) not in the dataset: {', '.join(missing)}.")

    def frame(self, columns: list[str] | None = None, max_rows: int | None = None, where: str | None = None) -> pd.DataFrame:
        """The data (or chosen columns). Above `max_rows` a seeded random sample is used, and noted."""
        rows = self.dataset["rows"] if self.dataset else 0
        sample = max_rows if max_rows and rows > max_rows else None
        if sample:
            self.note(f"Used a random sample of {sample:,} of {rows:,} rows (seed {self.seed}).")
        return self.datasets.frame(self.dataset_id, columns=columns, sample=sample, seed=self.seed, where=where)

    def sql(self, query: str) -> pd.DataFrame:
        """Runs engine-written SQL over the dataset (view `data`)."""
        con = self.datasets.connect(self.dataset_id)
        try:
            return con.execute(query).df()
        finally:
            con.close()

    def save_query(self, query: str, name: str, extra: list[str] | None = None) -> dict[str, Any]:
        """Stores the result of engine-written SQL as a new dataset, streaming (never all in memory)."""
        source = {"kind": "derived", "from": self.dataset["id"] if self.dataset else None}
        return self.datasets.ingest_query(self.dataset_id, query, name, source, extra or [])

    def save_frame(self, df: pd.DataFrame, name: str) -> dict[str, Any]:
        """Stores a derived dataset (e.g. the output of a recipe) and returns its details."""
        source = {"kind": "derived", "from": self.dataset["id"] if self.dataset else None}
        return self.datasets.ingest_frame(df, name, source)

    # ---- running ----
    def progress(self, share: float, message: str = "") -> None:
        self.check()
        if self._progress:
            self._progress(max(0.0, min(1.0, share)), message)

    def check(self) -> None:
        if self._cancelled and self._cancelled():
            raise Cancelled()

    def note(self, text: str) -> None:
        if text not in self.notes:
            self.notes.append(text)


@dataclass
class Capability:
    name: str
    area: str
    title: str
    summary: str
    params: type[BaseModel]
    fn: Callable[[Context, Any], dict[str, Any]]
    needs_dataset: bool = True
    heavy: bool = False
    tags: list[str] = field(default_factory=list)
    # Results that depend on something outside the dataset (a database, a URL) are never cached.
    cacheable: bool = True

    def describe(self) -> dict[str, Any]:
        return {
            "name": self.name, "area": self.area, "title": self.title, "summary": self.summary,
            "needsDataset": self.needs_dataset, "heavy": self.heavy, "tags": self.tags, "cacheable": self.cacheable,
            "params": self.params.model_json_schema(),
        }


REGISTRY: dict[str, Capability] = {}


def capability(name: str, area: str, title: str, summary: str, params: type[BaseModel],
               needs_dataset: bool = True, heavy: bool = False, tags: list[str] | None = None, cacheable: bool = True):
    """Registers a capability function."""
    def wrap(fn: Callable[[Context, Any], dict[str, Any]]):
        if name in REGISTRY:
            raise RuntimeError(f"Capability {name} is registered twice.")
        REGISTRY[name] = Capability(name, area, title, summary, params, fn, needs_dataset, heavy, tags or [], cacheable)
        return fn
    return wrap


def get(name: str) -> Capability:
    cap = REGISTRY.get(name)
    if not cap:
        raise EngineError(f"Unknown capability “{name}”. See GET /v2/capabilities.", 404, "not_found")
    return cap


def parse_params(cap: Capability, params: dict[str, Any] | None) -> BaseModel:
    try:
        return cap.params.model_validate(params or {})
    except ValidationError as err:
        problems = "; ".join(f"{'.'.join(str(p) for p in e['loc']) or 'params'}: {e['msg']}" for e in err.errors())
        raise EngineError(f"Invalid parameters for {cap.name}: {problems}") from err


def cache_key(cap: Capability, dataset: dict[str, Any] | None, params: BaseModel, seed: int) -> str:
    return fingerprint({"cap": cap.name, "ds": dataset["fingerprint"] if dataset else None, "p": params.model_dump(), "seed": seed})


def execute(cap: Capability, ctx: Context, params: BaseModel) -> dict[str, Any]:
    """Runs a capability and wraps its output with notes and the manifest."""
    started = time.perf_counter()
    ctx.progress(0.0, "Starting")
    try:
        result = cap.fn(ctx, params)
    except (ValueError, KeyError, np.linalg.LinAlgError) as err:
        if isinstance(err, EngineError):
            raise
        raise EngineError(f"{cap.title} couldn't run on this data: {err}") from err
    out = jsonable(result)
    if ctx.notes:
        out["notes"] = list(dict.fromkeys(out.get("notes", []) + ctx.notes))
    out["manifest"] = manifest(cap.name, params.model_dump(), ctx.dataset, ctx.seed, started)
    return out
