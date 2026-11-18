"""Shared pieces: errors, JSON-safe conversion, versions and the run manifest."""
from __future__ import annotations

import hashlib
import json
import math
import platform
import re
import time
from datetime import UTC, date, datetime
from functools import lru_cache
from importlib import metadata
from typing import Any

import numpy as np
import pandas as pd

from . import ENGINE_VERSION

# Libraries whose versions decide the numbers; recorded on every result.
KEY_LIBRARIES = [
    "numpy", "pandas", "scipy", "scikit-learn", "statsmodels", "xgboost", "lightgbm", "catboost",
    "optuna", "shap", "duckdb", "pyarrow", "lifelines", "umap-learn",
]


class EngineError(Exception):
    """An error the caller can act on. `status` is the HTTP status to return."""

    def __init__(self, message: str, status: int = 400, code: str = "bad_request"):
        super().__init__(message)
        self.message = message
        self.status = status
        self.code = code


class Cancelled(EngineError):
    def __init__(self) -> None:
        super().__init__("The job was cancelled.", status=409, code="cancelled")


@lru_cache(maxsize=1)
def library_versions() -> dict[str, str]:
    out: dict[str, str] = {}
    for name in KEY_LIBRARIES:
        # Some libraries ship under another distribution name (the CPU-only XGBoost is "xgboost-cpu").
        for dist in (name, f"{name}-cpu"):
            try:
                out[name] = metadata.version(dist)
                break
            except metadata.PackageNotFoundError:
                continue
    return out


def stamp() -> str:
    """A sortable UTC timestamp to the microsecond, for ids listed newest-first."""
    return datetime.now(UTC).strftime("%Y%m%d%H%M%S%f")


def now_iso() -> str:
    return datetime.now(UTC).isoformat(timespec="milliseconds")


def jsonable(value: Any) -> Any:
    """Converts numpy/pandas values to plain JSON: NaN and infinity become None."""
    if value is None or isinstance(value, (str, bool)):
        return value
    if isinstance(value, (int, np.integer)):
        return int(value)
    if isinstance(value, (float, np.floating)):
        v = float(value)
        return v if math.isfinite(v) else None
    if isinstance(value, np.bool_):
        return bool(value)
    if isinstance(value, (datetime, date, pd.Timestamp)):
        return None if pd.isna(value) else value.isoformat()
    if isinstance(value, pd.Timedelta):
        return value.total_seconds()
    if isinstance(value, dict):
        return {str(k): jsonable(v) for k, v in value.items()}
    if isinstance(value, (list, tuple, set)):
        return [jsonable(v) for v in value]
    if isinstance(value, np.ndarray):
        return [jsonable(v) for v in value.tolist()]
    if isinstance(value, pd.Series):
        return [jsonable(v) for v in value.tolist()]
    if isinstance(value, pd.DataFrame):
        return records(value)
    try:
        if pd.isna(value):
            return None
    except (TypeError, ValueError):
        pass
    return str(value)


def records(df: pd.DataFrame, limit: int | None = None) -> list[dict[str, Any]]:
    frame = df if limit is None else df.head(limit)
    cols = [str(c) for c in frame.columns]
    return [{c: jsonable(v) for c, v in zip(cols, row)} for row in frame.itertuples(index=False, name=None)]


def fingerprint(obj: Any) -> str:
    """A stable SHA-256 of any JSON-able object (key order doesn't matter)."""
    blob = json.dumps(jsonable(obj), sort_keys=True, separators=(",", ":"), default=str).encode()
    return hashlib.sha256(blob).hexdigest()


_SECRET_KEY = re.compile(r"pass(word)?|secret|token|credential|api_?key|private_?key|salt", re.IGNORECASE)


def redact(value: Any) -> Any:
    """Hides secrets (passwords, tokens, keys, passwords inside URLs) before anything is stored."""
    if isinstance(value, dict):
        return {k: ("•••" if _SECRET_KEY.search(str(k)) and v not in (None, "") else redact(v)) for k, v in value.items()}
    if isinstance(value, list):
        return [redact(v) for v in value]
    if isinstance(value, str):
        return re.sub(r"(://[^:/@\s]+:)[^@\s]+@", r"\1•••@", value)
    return value


def manifest(capability: str, params: dict[str, Any], dataset: dict[str, Any] | None, seed: int, started: float) -> dict[str, Any]:
    """What it takes to reproduce a result exactly (secrets are never included)."""
    params = redact(params)
    return {
        "engineVersion": ENGINE_VERSION,
        "python": platform.python_version(),
        "libraries": library_versions(),
        "capability": capability,
        "params": jsonable(params),
        "paramsFingerprint": fingerprint(params),
        "dataset": None if dataset is None else {
            "id": dataset["id"], "name": dataset.get("name"), "rows": dataset.get("rows"),
            "columns": len(dataset.get("columns", [])), "fingerprint": dataset.get("fingerprint", dataset["id"]),
        },
        "seed": seed,
        "finishedAt": now_iso(),
        "durationMs": round((time.perf_counter() - started) * 1000, 1),
    }
