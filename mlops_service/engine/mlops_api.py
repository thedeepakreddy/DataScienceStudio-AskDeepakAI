"""MLOps endpoints: the model registry, online predictions, monitoring history,
experiment runs, multi-step pipelines, schedules and the audit log."""
from __future__ import annotations

import json
import os
import re
import threading
import time
import uuid
from typing import Any, Literal

import numpy as np
import pandas as pd
from fastapi import APIRouter, Request
from fastapi.responses import Response
from pydantic import BaseModel, Field

from .core import EngineError, jsonable, library_versions, now_iso, records, stamp
from .models import STAGES, ModelStore
from .registry import Context, execute, get, parse_params

router = APIRouter(prefix="/v2", tags=["engine v2 · mlops"])
NUMERIC_TYPES = {"integer", "number", "boolean"}
_REF = re.compile(r"^(?P<name>[^@]+?)(?:@(?P<sel>production|staging|latest|v\d+))?$")


def _state():
    from . import api

    return api.state


def resolve_model(store: ModelStore, ref: str) -> str:
    """mdl_… ids pass through; `name`, `name@production`, `name@staging`, `name@latest` or `name@v3` are looked up."""
    if ref.startswith("mdl_"):
        store.meta(ref)
        return ref
    m = _REF.match(ref)
    if not m:
        raise EngineError(f"“{ref}” isn't a model id or name@stage.", 404, "not_found")
    name, sel = m["name"], m["sel"]
    versions = sorted((r for r in store.list() if r.get("name") == name), key=lambda r: r.get("version") or 0, reverse=True)
    if not versions:
        raise EngineError(f"No model is registered as “{name}”.", 404, "not_found")
    if sel in ("production", "staging"):
        hit = [r for r in versions if r.get("stage") == sel]
        if not hit:
            raise EngineError(f"“{name}” has no {sel} version.", 404, "not_found")
        return hit[0]["id"]
    if sel and sel.startswith("v"):
        hit = [r for r in versions if r.get("version") == int(sel[1:])]
        if not hit:
            raise EngineError(f"“{name}” has no version {sel[1:]}.", 404, "not_found")
        return hit[0]["id"]
    if sel is None:
        prod = [r for r in versions if r.get("stage") == "production"]
        if prod:
            return prod[0]["id"]
    return versions[0]["id"]


def _public(meta: dict[str, Any]) -> dict[str, Any]:
    return {k: v for k, v in meta.items() if k not in ("reference", "predictionReference")}


# ---------------------------------------------------------------- registry
@router.get("/models")
def list_models(name: str | None = None, stage: str | None = None) -> list[dict[str, Any]]:
    return [_public(m) for m in _state().models.list() if (not name or m.get("name") == name) and (not stage or m.get("stage") == stage)]


@router.get("/models/{ref}")
def model(ref: str) -> dict[str, Any]:
    store = _state().models
    return _public(store.meta(resolve_model(store, ref)))


class ModelPatch(BaseModel):
    stage: Literal[STAGES] | None = None  # type: ignore[valid-type]
    name: str | None = Field(None, min_length=1, max_length=120, pattern=r"^[^@/]+$")
    description: str | None = Field(None, max_length=5000)
    tags: list[str] | None = Field(None, max_length=30)
    approved_by: str | None = Field(None, max_length=200, description="Who approved a promotion to production.")
    note: str | None = Field(None, max_length=2000, description="Why the change was made (kept in the history).")


@router.patch("/models/{model_id}")
def update_model(model_id: str, body: ModelPatch, request: Request) -> dict[str, Any]:
    changes = body.model_dump(exclude_none=True)
    approver = changes.pop("approved_by", None) or request.headers.get("x-engine-user")
    note = changes.pop("note", None)
    if not changes:
        raise EngineError("Nothing to change.")
    if changes.get("stage") in ("staging", "production") and not (changes.get("name") or _state().models.meta(model_id).get("name")):
        raise EngineError("Give the model a registry name before promoting it.")
    if changes.get("stage") == "production":
        if os.environ.get("ENGINE_REQUIRE_APPROVAL") == "1" and not approver:
            raise EngineError("Promotion to production needs an approver (approved_by).", 403, "approval_required")
        if approver:
            changes.update(approvedBy=approver, approvedAt=now_iso())
    if note:
        changes["note"] = note
    return _public(_state().models.update(model_id, **changes))


@router.delete("/models/{model_id}")
def delete_model(model_id: str) -> dict[str, Any]:
    store = _state().models
    if store.meta(model_id).get("stage") == "production":
        raise EngineError("Archive the production model before deleting it.", 409, "in_production")
    store.delete(model_id)
    return {"deleted": model_id}


@router.get("/models/{ref}/download")
def download_model(ref: str) -> Response:
    store = _state().models
    model_id = resolve_model(store, ref)
    meta = store.meta(model_id)
    filename = f"{meta.get('name') or model_id}-v{meta.get('version') or 1}.joblib".replace(" ", "_")
    return Response(store.bytes(model_id), media_type="application/octet-stream",
                    headers={"Content-Disposition": f'attachment; filename="{filename}"'})


def model_card(meta: dict[str, Any]) -> str:
    def fmt(v):
        return f"{v:.4g}" if isinstance(v, float) else str(v)

    lines = [f"# Model card: {meta.get('name') or meta['id']}" + (f" v{meta['version']}" if meta.get("version") else ""), "",
             meta.get("description") or "_No description yet._", "",
             "## Details", "",
             f"- **Model id:** `{meta['id']}` · **stage:** {meta.get('stage')} · **created:** {meta.get('createdAt')}",
             *([f"- **Approved for production** by {meta['approvedBy']} on {meta.get('approvedAt')}"] if meta.get("approvedBy") else []),
             f"- **Task:** {meta['task']} of `{meta['target']}`" + (f" (positive class: {meta['positiveClass']})" if meta.get("positiveClass") else ""),
             f"- **Algorithm:** {meta.get('label')} (`{meta.get('family')}`), tuned hyperparameters: `{json.dumps(meta.get('params'), default=str)}`",
             f"- **Features ({len(meta['features'])}):** " + ", ".join(f"`{f}`" for f in meta["features"]),
             f"- **Training data:** dataset `{meta['trainedOn']['dataset']}` (fingerprint `{meta['trainedOn']['fingerprint'][:16]}…`), "
             f"{meta['trainedOn']['rows']:,} rows; refit on all rows: {meta['trainedOn']['refitOnAllRows']}; seed {meta.get('seed')}",
             "", "## Performance (held-out test set)", "", "| Metric | Value |", "|---|---|"]
    lines += [f"| {k} | {fmt(v)} |" for k, v in (meta.get("testMetrics") or {}).items()]
    lines += ["", f"Cross-validated {meta.get('scoring')}: {fmt(meta.get('cvMean'))}."]
    conf = meta.get("conformal") or {}
    if conf:
        lines += ["", "## Uncertainty", ""]
        if "halfWidth" in conf:
            lines.append(f"Conformal prediction intervals of ±{fmt(conf['halfWidth'])} target {1 - conf['alpha']:.0%} coverage (test coverage {conf['testCoverage']:.1%}).")
        else:
            lines.append(f"Conformal prediction sets target {1 - conf['alpha']:.0%} coverage (test coverage {conf['testCoverage']:.1%}, average set size {conf['averageSetSize']:.2f}).")
    if meta.get("fairness"):
        lines += ["", "## Fairness", ""]
        for f in meta["fairness"]:
            lines.append(f"- `{f['feature']}`: " + ", ".join(f"{k} {fmt(v)}" for k, v in f["summary"].items()))
    lines += ["", "## Intended use and limits", "",
              "- Valid for data like the training data; check drift with **Monitor a model** before relying on it after the data changes.",
              "- Predictions are associations learned from the data, not causal effects.",
              "- Loading the exported file needs the same library versions:",
              "", "```", *[f"{k}=={v}" for k, v in library_versions().items()], "```", ""]
    hist = meta.get("history") or []
    if hist:
        lines += ["## History", ""] + [f"- {h['at']}: " + ", ".join(f"{k} → {v}" for k, v in h.items() if k != "at") for h in hist]
    return "\n".join(lines)


@router.get("/models/{ref}/card")
def card(ref: str) -> dict[str, Any]:
    store = _state().models
    meta = store.meta(resolve_model(store, ref))
    return {"id": meta["id"], "markdown": model_card(meta)}


@router.get("/models/{ref}/monitoring")
def monitoring_history(ref: str, limit: int = 100) -> list[dict[str, Any]]:
    st = _state()
    model_id = resolve_model(st.models, ref)
    keys = st.storage.list(f"monitoring/{model_id}")[-max(1, min(limit, 1000)):]
    return [json.loads(st.storage.get(k)) | {"reportId": k.rsplit("/", 1)[-1][:-5]} for k in reversed(keys)]


# ---------------------------------------------------------------- online predictions
class PredictBody(BaseModel):
    rows: list[dict[str, Any]] = Field(..., min_length=1, max_length=10_000)
    log: bool = True
    explain: bool = Field(False, description="Add the top reasons for each prediction (up to 200 rows).")
    reasons: int = Field(3, ge=1, le=20)


def _typical(ref: dict[str, Any]) -> Any:
    if ref.get("kind") == "numeric":
        return ref["quantiles"][5]
    shares = ref.get("shares") or {}
    return max(shares, key=shares.get) if shares else None


def reason_codes(pipeline: Any, meta: dict[str, Any], X: pd.DataFrame, top: int) -> list[list[dict[str, Any]]]:
    """Baseline-substitution reason codes: for each feature, how much the prediction moves when that
    feature alone is set to its typical training value (median, or most common category)."""
    ref = meta.get("reference") or {}
    feats = [f for f in meta["features"] if f in ref and _typical(ref[f]) is not None]
    task, classes = meta["task"], meta.get("classes")

    def score_of(frame: pd.DataFrame, cls_idx: np.ndarray | None = None) -> np.ndarray:
        if task == "regression":
            return np.asarray(pipeline.predict(frame), float)
        proba = pipeline.predict_proba(frame)
        return proba[np.arange(len(frame)), cls_idx]

    cls_idx = None
    if task == "classification":
        if len(classes) == 2:
            pos = meta.get("positiveClass") if meta.get("positiveClass") in classes else classes[1]
            cls_idx = np.full(len(X), classes.index(pos))
        else:
            cls_idx = pipeline.predict_proba(X).argmax(axis=1)
    base = score_of(X, cls_idx)
    blocks = []
    for f in feats:
        Xb = X.copy()
        Xb[f] = _typical(ref[f])
        blocks.append(Xb)
    if not blocks:
        return [[] for _ in range(len(X))]
    big = pd.concat(blocks, ignore_index=True)
    moved = score_of(big, None if cls_idx is None else np.tile(cls_idx, len(feats))).reshape(len(feats), len(X))
    effect = base[None, :] - moved
    out = []
    for i in range(len(X)):
        order = np.argsort(-np.abs(effect[:, i]))[:top]
        out.append([{"feature": feats[k], "value": jsonable(X.iloc[i][feats[k]]), "typical": jsonable(_typical(ref[feats[k]])),
                     "effect": float(effect[k, i])} for k in order if abs(effect[k, i]) > 1e-12])
    return out


def score(pipeline: Any, meta: dict[str, Any], frame: pd.DataFrame) -> pd.DataFrame:
    missing = [f for f in meta["features"] if f not in frame]
    if missing:
        raise EngineError(f"Rows are missing feature(s): {', '.join(missing)}.", 422, "missing_features")
    X = frame[meta["features"]].copy()
    for f, kind in (meta.get("featureTypes") or {}).items():
        if kind in NUMERIC_TYPES:
            X[f] = pd.to_numeric(X[f], errors="coerce")
    pred = pipeline.predict(X)
    out = pd.DataFrame({"prediction": pred})
    conf = meta.get("conformal") or {}
    if meta["task"] == "classification" and hasattr(pipeline, "predict_proba"):
        proba = pipeline.predict_proba(X)
        for k, c in enumerate(meta["classes"]):
            out[f"probability_{c}"] = proba[:, k]
        if meta.get("threshold") is not None and meta.get("positiveClass") is not None:
            k = meta["classes"].index(meta["positiveClass"])
            other = next(c for c in meta["classes"] if c != meta["positiveClass"])
            out["decision"] = np.where(proba[:, k] >= meta["threshold"], meta["positiveClass"], other)
        if "threshold" in conf:
            out["prediction_set"] = [[c for c, keep in zip(meta["classes"], row) if keep] for row in (1 - proba) <= conf["threshold"]]
    elif "halfWidth" in conf:
        out["lower"] = np.asarray(pred, float) - conf["halfWidth"]
        out["upper"] = np.asarray(pred, float) + conf["halfWidth"]
    return out


@router.post("/models/{ref}/predict")
def predict_online(ref: str, body: PredictBody) -> dict[str, Any]:
    st = _state()
    model_id = resolve_model(st.models, ref)
    pipeline, meta = st.models.load(model_id)
    started = time.perf_counter()
    frame = pd.DataFrame(body.rows)
    out = score(pipeline, meta, frame)
    if body.explain:
        if len(frame) > 200:
            raise EngineError("Reasons are given for up to 200 rows per request.", 422, "too_many_rows")
        X = frame[meta["features"]].copy()
        for f, kind in (meta.get("featureTypes") or {}).items():
            if kind in NUMERIC_TYPES:
                X[f] = pd.to_numeric(X[f], errors="coerce")
        out["reasons"] = reason_codes(pipeline, meta, X, body.reasons)
    if body.log and os.environ.get("ENGINE_PREDICTION_LOG", "1") != "0":
        logged = frame[meta["features"]].head(1000).copy()
        logged["prediction"] = out["prediction"].head(1000).to_numpy()
        st.storage.put(f"predlog/{model_id}/{stamp()[:8]}/{stamp()}_{uuid.uuid4().hex[:6]}.json",
                       json.dumps({"at": now_iso(), "rows": records(logged)}, default=str).encode())
    return {"model": {"id": model_id, "name": meta.get("name"), "version": meta.get("version"), "stage": meta.get("stage")},
            "predictions": jsonable(records(out)), "milliseconds": round((time.perf_counter() - started) * 1000, 1)}


# ---------------------------------------------------------------- runs and experiments
class CompareBody(BaseModel):
    ids: list[str] = Field(..., min_length=2, max_length=20)


@router.get("/runs")
def runs(experiment: str | None = None, capability: str | None = None, limit: int = 100) -> list[dict[str, Any]]:
    return _state().runs.list(experiment, capability, max(1, min(limit, 1000)))


@router.get("/runs/{run_id}")
def run_detail(run_id: str) -> dict[str, Any]:
    st = _state()
    run = st.runs.get(run_id)
    result = st.runs.result(run_id)
    if result is None and run.get("jobId"):
        job = st.jobs.get(run["jobId"])
        run["job"] = job
        if job.get("status") == "done":
            result = st.jobs.result(run["jobId"])
    return {**run, "result": result}


@router.post("/runs/compare")
def compare(body: CompareBody) -> dict[str, Any]:
    return _state().runs.compare(body.ids)


@router.get("/experiments")
def experiments() -> list[dict[str, Any]]:
    return _state().runs.experiments()


# ---------------------------------------------------------------- pipelines
class Step(BaseModel):
    capability: str
    dataset_id: str | None = Field(None, description="A dataset id, or $prev for the dataset the previous step produced.")
    params: dict[str, Any] = Field(default_factory=dict)


class PipelineBody(BaseModel):
    steps: list[Step] = Field(..., min_length=1, max_length=20)
    seed: int = Field(42, ge=0, le=2**31 - 1)
    experiment: str | None = None
    name: str | None = Field(None, max_length=120)


def _substitute(value: Any, prev: dict[str, Any]) -> Any:
    if isinstance(value, str) and value in ("$prev", "$prev_dataset"):
        return prev.get("dataset")
    if isinstance(value, str) and value == "$prev_model":
        return prev.get("model")
    if isinstance(value, dict):
        return {k: _substitute(v, prev) for k, v in value.items()}
    if isinstance(value, list):
        return [_substitute(v, prev) for v in value]
    return value


def validate_steps(steps: list[Step]) -> None:
    for i, s in enumerate(steps):
        cap = get(s.capability)
        if "$prev" not in json.dumps(s.params) and s.dataset_id != "$prev":
            parse_params(cap, s.params)
        if i == 0 and (s.dataset_id == "$prev" or "$prev" in json.dumps(s.params)):
            raise EngineError("The first step has no previous step to take a dataset or model from.")


def run_pipeline(body: PipelineBody, progress=None, cancelled=None, source: str = "pipeline") -> dict[str, Any]:
    st = _state()
    prev: dict[str, Any] = {}
    done = []
    for i, step in enumerate(body.steps):
        if cancelled and cancelled():
            from .core import Cancelled

            raise Cancelled()
        cap = get(step.capability)
        ds_id = prev.get("dataset") if step.dataset_id == "$prev" else step.dataset_id
        params = parse_params(cap, _substitute(step.params, prev))
        dataset = st.datasets.meta(ds_id) if ds_id else None
        if cap.needs_dataset and not dataset:
            raise EngineError(f"Step {i + 1} ({cap.title}) needs a dataset.")

        def sub_progress(share: float, message: str, i=i) -> None:
            if progress:
                progress((i + share) / len(body.steps), f"Step {i + 1}/{len(body.steps)} · {message}")

        run = st.runs.start(cap.name, dataset, params.model_dump(), body.seed, body.experiment, [f"pipeline:{body.name or 'unnamed'}"], source)
        try:
            result = execute(cap, Context(st.datasets, dataset, body.seed, sub_progress, cancelled, models=st.models), params)
        except EngineError as err:
            st.runs.finish(run, error=err.message)
            raise EngineError(f"Step {i + 1} ({cap.title}) failed: {err.message}", err.status, err.code) from err
        st.runs.finish(run, result)
        prev = {"dataset": (result.get("dataset") or {}).get("id") or ds_id, "model": (result.get("model") or {}).get("id") or prev.get("model")}
        done.append({"step": i + 1, "capability": cap.name, "runId": run["id"], "dataset": prev["dataset"], "model": prev["model"]})
    return {"steps": done, "final": result}


@router.post("/pipelines/run")
def pipeline(body: PipelineBody) -> dict[str, Any]:
    validate_steps(body.steps)
    job = _state().jobs.submit("pipeline", body.name or f"Pipeline of {len(body.steps)} steps",
                               lambda progress, cancelled: run_pipeline(body, progress, cancelled))
    return {"status": "queued", "job": job}


# ---------------------------------------------------------------- schedules
class ScheduleBody(PipelineBody):
    every_minutes: int = Field(..., ge=5, le=60 * 24 * 31)
    enabled: bool = True
    start_at: float | None = Field(None, description="Unix time of the first run (default: one interval from now).")


class Schedules:
    def __init__(self, storage) -> None:
        self.storage = storage
        self._lock = threading.Lock()

    def save(self, sched: dict[str, Any]) -> dict[str, Any]:
        self.storage.put(f"schedules/{sched['id']}.json", json.dumps(sched).encode())
        return sched

    def get(self, sid: str) -> dict[str, Any]:
        try:
            return json.loads(self.storage.get(f"schedules/{sid}.json"))
        except FileNotFoundError as err:
            raise EngineError(f"Schedule {sid} wasn't found.", 404, "not_found") from err

    def list(self) -> list[dict[str, Any]]:
        return [json.loads(self.storage.get(k)) for k in self.storage.list("schedules") if k.endswith(".json")]

    def delete(self, sid: str) -> None:
        self.get(sid)
        self.storage.delete(f"schedules/{sid}.json")

    def tick(self, now: float | None = None) -> list[dict[str, Any]]:
        """Starts every enabled schedule that is due; missed runs are not replayed."""
        now = now or time.time()
        fired = []
        with self._lock:
            for s in self.list():
                if not s.get("enabled") or s["nextRunAt"] > now:
                    continue
                body = PipelineBody(steps=s["steps"], seed=s["seed"], experiment=s.get("experiment"), name=s.get("name"))
                job = _state().jobs.submit("schedule", f"Scheduled: {s.get('name') or s['id']}",
                                           lambda progress, cancelled, body=body: run_pipeline(body, progress, cancelled, source="schedule"))
                period = s["everyMinutes"] * 60
                s["nextRunAt"] = s["nextRunAt"] + period * max(1, int((now - s["nextRunAt"]) // period) + 1)
                s["lastRun"] = {"at": now_iso(), "jobId": job["id"]}
                s.setdefault("runs", []).append(job["id"])
                s["runs"] = s["runs"][-50:]
                self.save(s)
                fired.append({"schedule": s["id"], "job": job["id"]})
        return fired


@router.post("/schedules")
def create_schedule(body: ScheduleBody) -> dict[str, Any]:
    validate_steps(body.steps)
    now = time.time()
    sched = {"id": "sch_" + uuid.uuid4().hex[:12], "name": body.name, "steps": [s.model_dump() for s in body.steps], "seed": body.seed,
             "experiment": body.experiment, "everyMinutes": body.every_minutes, "enabled": body.enabled, "createdAt": now_iso(),
             "nextRunAt": body.start_at or now + body.every_minutes * 60}
    return _state().schedules.save(sched)


@router.get("/schedules")
def list_schedules() -> list[dict[str, Any]]:
    return _state().schedules.list()


class SchedulePatch(BaseModel):
    enabled: bool | None = None
    every_minutes: int | None = Field(None, ge=5, le=60 * 24 * 31)
    name: str | None = Field(None, max_length=120)


@router.patch("/schedules/{sid}")
def update_schedule(sid: str, body: SchedulePatch) -> dict[str, Any]:
    st = _state()
    s = st.schedules.get(sid)
    if body.enabled is not None:
        s["enabled"] = body.enabled
    if body.every_minutes:
        s["everyMinutes"] = body.every_minutes
    if body.name is not None:
        s["name"] = body.name
    return st.schedules.save(s)


@router.delete("/schedules/{sid}")
def delete_schedule(sid: str) -> dict[str, Any]:
    _state().schedules.delete(sid)
    return {"deleted": sid}


@router.post("/schedules/tick")
def tick(wait: bool = False) -> dict[str, Any]:
    """Runs whatever is due. Cloud Scheduler can call this every few minutes, since a
    scaled-to-zero Cloud Run service has no background thread running between requests.
    With wait=true the request stays open until the started runs finish, so Cloud Run keeps
    the CPU allocated to them (it throttles CPU outside requests by default)."""
    st = _state()
    started = st.schedules.tick()
    if wait and started:
        deadline = time.monotonic() + float(os.environ.get("ENGINE_TICK_WAIT_S", "840"))
        pending = {s["job"] for s in started}
        while pending and time.monotonic() < deadline:
            pending = {j for j in pending if st.jobs.get(j)["status"] not in ("done", "failed", "cancelled")}
            if pending:
                time.sleep(0.5)
        for s in started:
            s["status"] = st.jobs.get(s["job"])["status"]
    return {"started": started}


# ---------------------------------------------------------------- direct-to-storage uploads
class UploadUrlBody(BaseModel):
    filename: str = Field(..., max_length=300, pattern=r"^[^/\\]+\.(csv|tsv|txt|json|jsonl|parquet|xlsx|xls)$")
    content_type: str = Field("application/octet-stream", max_length=100)


@router.post("/datasets/upload-url")
def upload_url(body: UploadUrlBody) -> dict[str, Any]:
    """A signed URL the browser can PUT a large file to (Cloud Run caps request bodies at 32 MB);
    afterwards, import it with connect.gcs and the returned gcsUri."""
    from datetime import timedelta

    st = _state()
    if st.storage.kind != "gcs":
        raise EngineError("Direct uploads need Cloud Storage (ENGINE_STORAGE=gs://…); upload to /v2/datasets/upload instead.", 400, "not_supported")
    import google.auth  # pragma: no cover - needs Google Cloud credentials
    from google.auth.transport.requests import Request as AuthRequest

    creds, _ = google.auth.default()
    creds.refresh(AuthRequest())
    key = f"uploads/{stamp()}_{uuid.uuid4().hex[:8]}/{body.filename}"
    blob = st.storage.bucket.blob(st.storage._k(key))
    url = blob.generate_signed_url(version="v4", expiration=timedelta(minutes=30), method="PUT", content_type=body.content_type,
                                   service_account_email=getattr(creds, "service_account_email", None), access_token=creds.token)
    return {"url": url, "method": "PUT", "headers": {"Content-Type": body.content_type},
            "gcsUri": f"gs://{st.storage.bucket.name}/{st.storage._k(key)}", "expiresInSeconds": 1800}


def scheduler_loop(stop: threading.Event, every_s: float = 30) -> None:
    while not stop.wait(every_s):
        try:
            _state().schedules.tick()
        except Exception:  # noqa: BLE001 - the loop must survive a bad schedule
            import logging

            logging.getLogger("engine").exception("Scheduler tick failed")


# ---------------------------------------------------------------- audit
@router.get("/audit")
def audit(limit: int = 200) -> list[dict[str, Any]]:
    return _state().audit.recent(max(1, min(limit, 5000)))


# ---------------------------------------------------------------- reports
@router.get("/runs/{run_id}/methods")
def run_methods(run_id: str) -> dict[str, Any]:
    from .reports import methods

    detail = run_detail(run_id)
    return methods(detail, detail.get("result"))


@router.get("/runs/{run_id}/notebook")
def run_notebook(run_id: str, engine_url: str = "http://localhost:8000") -> Response:
    from .reports import notebook

    detail = run_detail(run_id)
    nb = notebook(detail, detail.get("result"), engine_url)
    return Response(json.dumps(nb, indent=1, ensure_ascii=False), media_type="application/x-ipynb+json",
                    headers={"Content-Disposition": f'attachment; filename="{run_id}.ipynb"'})
