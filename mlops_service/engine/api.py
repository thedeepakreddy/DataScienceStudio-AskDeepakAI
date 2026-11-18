"""The /v2 API: datasets, capabilities, runs and jobs."""
from __future__ import annotations

import hmac
import importlib
import logging
import os
import pkgutil
import tempfile
from typing import Any, Literal

from fastapi import APIRouter, File, Form, Request, UploadFile
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field
from starlette.middleware.base import BaseHTTPMiddleware

from . import ENGINE_VERSION
from .core import EngineError, library_versions
from .datasets import Datasets
from .jobs import Jobs
from .models import ModelStore
from .registry import REGISTRY, Context, cache_key, execute, get, parse_params
from .storage import make_storage

log = logging.getLogger("engine")


class EngineState:
    def __init__(self, storage_uri: str | None = None) -> None:
        self.storage = make_storage(storage_uri)
        self.datasets = Datasets(self.storage)
        self.jobs = Jobs(self.storage)
        self.models = ModelStore(self.storage)


state = EngineState()


def configure(storage_uri: str | None = None) -> EngineState:
    """Points the engine at a storage location (tests use a temporary folder)."""
    global state
    state = EngineState(storage_uri)
    return state


def load_capabilities() -> None:
    """Imports every module in engine/capabilities so they register themselves."""
    from . import capabilities

    for mod in pkgutil.iter_modules(capabilities.__path__):
        importlib.import_module(f"{capabilities.__name__}.{mod.name}")


MAX_UPLOAD_BYTES = int(float(os.environ.get("ENGINE_MAX_UPLOAD_MB", "2048")) * 1024 * 1024)
OPEN_PATHS = {"/", "/health"}


class TokenMiddleware(BaseHTTPMiddleware):
    """When ENGINE_TOKEN is set, every request except the health check must carry it.

    The studio's server sends it in `X-Engine-Token`; browsers never see it.
    """

    async def dispatch(self, request: Request, call_next):
        token = os.environ.get("ENGINE_TOKEN")
        if token and request.url.path not in OPEN_PATHS and request.method != "OPTIONS":
            sent = request.headers.get("x-engine-token", "")
            if not hmac.compare_digest(sent.encode(), token.encode()):
                return JSONResponse({"detail": "Missing or wrong engine token.", "code": "unauthorized"}, status_code=401)
        return await call_next(request)


def engine_error_response(_: Request, err: EngineError) -> JSONResponse:
    return JSONResponse({"detail": err.message, "code": err.code}, status_code=err.status)


router = APIRouter(prefix="/v2", tags=["engine v2"])


@router.get("/info")
def info() -> dict[str, Any]:
    return {
        "engineVersion": ENGINE_VERSION, "libraries": library_versions(), "storage": state.storage.kind,
        "capabilities": len(REGISTRY), "areas": sorted({c.area for c in REGISTRY.values()}),
        "maxUploadMb": round(MAX_UPLOAD_BYTES / 1024 / 1024),
    }


@router.get("/capabilities")
def capabilities(area: str | None = None) -> list[dict[str, Any]]:
    caps = [c for c in REGISTRY.values() if not area or c.area == area]
    return [c.describe() for c in sorted(caps, key=lambda c: (c.area, c.name))]


# ---- datasets ----
class RowsUpload(BaseModel):
    name: str = Field("dataset", max_length=200)
    rows: list[dict[str, Any]]


@router.post("/datasets/upload")
async def upload_dataset(file: UploadFile = File(...), name: str | None = Form(None)) -> dict[str, Any]:
    suffix = os.path.splitext(file.filename or "")[1] or ".csv"
    tmp = tempfile.NamedTemporaryFile(suffix=suffix, delete=False)
    size = 0
    try:
        while chunk := await file.read(1 << 20):
            size += len(chunk)
            if size > MAX_UPLOAD_BYTES:
                raise EngineError(f"The file is larger than the {MAX_UPLOAD_BYTES // (1024 * 1024)} MB limit.", 413, "too_large")
            tmp.write(chunk)
        tmp.close()
        return state.datasets.ingest_file(tmp.name, file.filename or f"upload{suffix}", name)
    finally:
        tmp.close()
        if os.path.exists(tmp.name):
            os.unlink(tmp.name)


@router.post("/datasets")
def upload_rows(body: RowsUpload) -> dict[str, Any]:
    return state.datasets.ingest_rows(body.rows, body.name)


@router.get("/datasets")
def list_datasets() -> list[dict[str, Any]]:
    return state.datasets.list()


@router.get("/datasets/{ds_id}")
def dataset_meta(ds_id: str) -> dict[str, Any]:
    return state.datasets.meta(ds_id)


@router.delete("/datasets/{ds_id}")
def delete_dataset(ds_id: str) -> dict[str, Any]:
    state.datasets.delete(ds_id)
    return {"deleted": ds_id}


@router.get("/datasets/{ds_id}/preview")
def preview(ds_id: str, limit: int = 50) -> dict[str, Any]:
    from .core import records

    df = state.datasets.frame(ds_id, limit=max(1, min(limit, 1000)))
    return {"columns": [str(c) for c in df.columns], "rows": records(df)}


class QueryBody(BaseModel):
    sql: str = Field(..., max_length=20000)
    limit: int = Field(1000, ge=1, le=10000)


@router.post("/datasets/{ds_id}/query")
def query(ds_id: str, body: QueryBody) -> dict[str, Any]:
    return state.datasets.query(ds_id, body.sql, body.limit)


# ---- runs ----
class RunBody(BaseModel):
    dataset_id: str | None = None
    params: dict[str, Any] = Field(default_factory=dict)
    seed: int = Field(42, ge=0, le=2**31 - 1)
    mode: Literal["auto", "sync", "job"] = "auto"
    use_cache: bool = True


@router.post("/run/{name}")
def run(name: str, body: RunBody) -> dict[str, Any]:
    cap = get(name)
    params = parse_params(cap, body.params)
    dataset = state.datasets.meta(body.dataset_id) if body.dataset_id else None
    if cap.needs_dataset and not dataset:
        raise EngineError(f"{cap.title} needs a dataset: send dataset_id.")
    key = cache_key(cap, dataset, params, body.seed)
    use_cache = body.use_cache and cap.cacheable
    if use_cache:
        hit = state.jobs.cached(key)
        if hit is not None:
            return {"status": "done", "cached": True, "result": hit}
    as_job = body.mode == "job" or (body.mode == "auto" and cap.heavy)

    def work(progress=None, cancelled=None) -> dict[str, Any]:
        ctx = Context(state.datasets, dataset, body.seed, progress, cancelled, models=state.models)
        return execute(cap, ctx, params)

    if as_job:
        return {"status": "queued", "job": state.jobs.submit(cap.name, cap.title, work, key if cap.cacheable else None)}
    result = work()
    if cap.cacheable:
        state.jobs.remember(key, result)
    return {"status": "done", "cached": False, "result": result}


# ---- jobs ----
@router.get("/jobs")
def list_jobs(limit: int = 50) -> list[dict[str, Any]]:
    return state.jobs.list(max(1, min(limit, 200)))


@router.get("/jobs/{job_id}")
def job(job_id: str) -> dict[str, Any]:
    return state.jobs.get(job_id)


@router.get("/jobs/{job_id}/result")
def job_result(job_id: str) -> dict[str, Any]:
    return state.jobs.result(job_id)


@router.post("/jobs/{job_id}/cancel")
def cancel_job(job_id: str) -> dict[str, Any]:
    return state.jobs.cancel(job_id)


def mount(app) -> None:
    """Adds the v2 API, the token check and error handling to the FastAPI app."""
    load_capabilities()
    app.add_middleware(TokenMiddleware)
    app.add_exception_handler(EngineError, engine_error_response)
    app.include_router(router)

