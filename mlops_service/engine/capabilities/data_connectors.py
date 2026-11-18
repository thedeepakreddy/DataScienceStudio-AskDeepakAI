"""Bringing data in: from a URL, Cloud Storage, BigQuery, PostgreSQL or MySQL.

Each connector streams the data into a new Parquet dataset in batches, so a
large table never has to fit in memory. Passwords are never stored (the
manifest redacts them). Private and internal network addresses are refused
unless ENGINE_ALLOW_PRIVATE_NETWORK=1 (to stop the engine being used to reach
its own infrastructure).
"""
from __future__ import annotations

import ipaddress
import os
import socket
import tempfile
import urllib.parse
from typing import Any, Literal

import pandas as pd
import pyarrow as pa
import pyarrow.parquet as pq
import requests
from pydantic import BaseModel, Field

from ..core import EngineError
from ..registry import capability

MAX_DOWNLOAD_BYTES = int(float(os.environ.get("ENGINE_MAX_UPLOAD_MB", "2048")) * 1024 * 1024)
BATCH_ROWS = 100_000


def _public_host(host: str) -> None:
    if os.environ.get("ENGINE_ALLOW_PRIVATE_NETWORK") == "1":
        return
    if not host:
        raise EngineError("The address has no host.")
    try:
        infos = socket.getaddrinfo(host, None)
    except socket.gaierror as err:
        raise EngineError(f"Couldn't find the host “{host}”.") from err
    for info in infos:
        ip = ipaddress.ip_address(info[4][0])
        if ip.is_private or ip.is_loopback or ip.is_link_local or ip.is_reserved or ip.is_multicast or ip.is_unspecified:
            raise EngineError(f"“{host}” is a private or internal address, which the engine doesn't connect to.")


class UrlParams(BaseModel):
    url: str = Field(..., max_length=2000)
    format: Literal["auto", "csv", "tsv", "json", "parquet", "xlsx"] = "auto"
    name: str | None = None


@capability("connect.url", "connect", "Import from a web address",
            "Downloads a CSV, TSV, JSON, Parquet or Excel file from a public https URL into a new dataset.",
            UrlParams, needs_dataset=False, heavy=True, cacheable=False, tags=["import"])
def from_url(ctx, p: UrlParams):
    parsed = urllib.parse.urlparse(p.url)
    if parsed.scheme not in ("https", "http"):
        raise EngineError("Use an http(s) address.")
    _public_host(parsed.hostname or "")
    ext = "." + p.format if p.format != "auto" else os.path.splitext(parsed.path)[1].lower() or ".csv"
    tmp = tempfile.NamedTemporaryFile(suffix=ext, delete=False)
    size = 0
    try:
        with requests.get(p.url, stream=True, timeout=(10, 120), allow_redirects=False) as r:
            if r.is_redirect:
                raise EngineError("The address redirects elsewhere; use the final address.")
            if r.status_code != 200:
                raise EngineError(f"The download failed (HTTP {r.status_code}).")
            for chunk in r.iter_content(1 << 20):
                size += len(chunk)
                if size > MAX_DOWNLOAD_BYTES:
                    raise EngineError("The file is larger than the upload limit.", 413, "too_large")
                tmp.write(chunk)
                ctx.check()
        tmp.close()
        meta = ctx.datasets.ingest_file(tmp.name, os.path.basename(parsed.path) or f"download{ext}", p.name or os.path.basename(parsed.path) or "download",
                                        {"kind": "url", "url": f"{parsed.scheme}://{parsed.netloc}{parsed.path}"})
    except requests.RequestException as err:
        raise EngineError(f"Couldn't download: {err}") from err
    finally:
        tmp.close()
        if os.path.exists(tmp.name):
            os.unlink(tmp.name)
    return {"dataset": meta, "bytes": size}


class ApiParams(BaseModel):
    url: str = Field(..., max_length=2000, description="The API address that returns JSON (https://…).")
    auth: Literal["none", "bearer", "header", "query", "basic"] = Field("none", description="How the key is sent.")
    api_key: str | None = Field(None, description="The key or token (never stored).")
    key_name: str | None = Field(None, max_length=100, description="Header or query parameter name for the key (X-API-Key / api_key when empty).")
    username: str | None = Field(None, max_length=200, description="For basic sign-in.")
    password: str | None = Field(None, description="For basic sign-in (never stored).")
    records_path: str | None = Field(None, max_length=200, description="Where the list of records is, e.g. data.items (found automatically when empty).")
    pagination: Literal["none", "page", "offset", "next_link", "cursor"] = "none"
    page_param: str | None = Field(None, max_length=100, description="page / offset / cursor parameter name (page, offset, cursor when empty).")
    page_size: int = Field(100, ge=1, le=10_000, description="Rows asked for per page (offset paging).")
    size_param: str | None = Field(None, max_length=100, description="Page-size parameter name (limit when empty).")
    next_path: str | None = Field(None, max_length=200, description="Where the next link or cursor is in the response, e.g. next or meta.next_cursor.")
    max_pages: int = Field(50, ge=1, le=1000)
    name: str | None = None


def _dig(obj: Any, path: str | None) -> Any:
    for part in [p for p in (path or "").split(".") if p]:
        if isinstance(obj, list) and part.isdigit():
            obj = obj[int(part)] if int(part) < len(obj) else None
        elif isinstance(obj, dict):
            obj = obj.get(part)
        else:
            return None
    return obj


def _records(body: Any, path: str | None) -> list[dict[str, Any]]:
    """The list of records in a JSON response: at `path`, or the response itself, or its first list."""
    found = _dig(body, path) if path else body
    if isinstance(found, dict) and not path:
        found = next((v for v in found.values() if isinstance(v, list) and (not v or isinstance(v[0], dict))), [found])
    if isinstance(found, dict):
        found = [found]
    if not isinstance(found, list):
        raise EngineError(f"No list of records at “{path or 'the top'}” in the response.")
    return [r if isinstance(r, dict) else {"value": r} for r in found]


@capability("connect.api", "connect", "Import from an API",
            "Reads records from a JSON API: with a key or token (header, query or bearer) or basic sign-in, following page numbers, offsets, next links or cursors, and flattening nested fields into columns. Keys are used for this request only and never stored.",
            ApiParams, needs_dataset=False, heavy=True, cacheable=False, tags=["import", "api"])
def from_api(ctx, p: ApiParams):
    if urllib.parse.urlparse(p.url).scheme not in ("https", "http"):
        raise EngineError("Use an http(s) address.")
    headers = {"Accept": "application/json", "User-Agent": "AskDeepakAI-engine"}
    query: dict[str, Any] = {}
    auth = None
    if p.auth != "none" and p.auth != "basic" and not p.api_key:
        raise EngineError("Enter the key or token.")
    if p.auth == "bearer":
        headers["Authorization"] = f"Bearer {p.api_key}"
    elif p.auth == "header":
        headers[p.key_name or "X-API-Key"] = str(p.api_key)
    elif p.auth == "query":
        query[p.key_name or "api_key"] = p.api_key
    elif p.auth == "basic":
        auth = (p.username or "", p.password or "")

    rows: list[dict[str, Any]] = []
    url: str | None = p.url
    page_param = p.page_param or {"page": "page", "offset": "offset", "cursor": "cursor"}.get(p.pagination, "page")
    page, offset, cursor, pages = 1, 0, None, 0
    while url and pages < p.max_pages:
        _public_host(urllib.parse.urlparse(url).hostname or "")
        params = dict(query)
        if p.pagination == "page":
            params[page_param] = page
        elif p.pagination == "offset":
            params[page_param] = offset
            params[p.size_param or "limit"] = p.page_size
        elif p.pagination == "cursor" and cursor:
            params[page_param] = cursor
        try:
            r = requests.get(url, headers=headers, params=params, auth=auth, timeout=(10, 60), allow_redirects=False)
        except requests.RequestException as err:
            raise EngineError(f"Couldn't reach the API: {err}") from err
        if r.status_code in (401, 403):
            raise EngineError(f"The API refused the request (HTTP {r.status_code}): check the key and how it's sent.")
        if r.status_code != 200:
            raise EngineError(f"The API answered HTTP {r.status_code}.")
        try:
            body = r.json()
        except ValueError as err:
            raise EngineError("The API didn't return JSON.") from err
        batch = _records(body, p.records_path)
        rows.extend(batch)
        pages += 1
        ctx.progress(min(0.95, pages / p.max_pages), f"Read {len(rows):,} records from {pages} page(s)")
        ctx.check()
        if len(rows) > 2_000_000:
            raise EngineError("More than 2 million records; narrow the request.", 413, "too_large")
        if p.pagination == "none" or not batch:
            break
        if p.pagination == "page":
            page += 1
        elif p.pagination == "offset":
            offset += len(batch)
            if len(batch) < p.page_size:
                break
        elif p.pagination == "next_link":
            nxt = _dig(body, p.next_path or "next") or r.links.get("next", {}).get("url")
            url = urllib.parse.urljoin(url, nxt) if isinstance(nxt, str) and nxt else None
            query = {k: v for k, v in query.items() if p.auth == "query" and k == (p.key_name or "api_key")}
        elif p.pagination == "cursor":
            cursor = _dig(body, p.next_path or "next_cursor")
            if not cursor:
                break
    if not rows:
        raise EngineError("The API returned no records.")
    df = pd.json_normalize(rows, sep=".")
    parsed = urllib.parse.urlparse(p.url)
    meta = ctx.datasets.ingest_frame(df, p.name or (parsed.netloc + parsed.path).strip("/").replace("/", " ") or "api",
                                     {"kind": "api", "url": f"{parsed.scheme}://{parsed.netloc}{parsed.path}", "pages": pages})
    return {"dataset": meta, "records": len(rows), "pages": pages, "columns": list(df.columns)[:200]}


class GcsParams(BaseModel):
    uri: str = Field(..., pattern=r"^gs://[^/]+/.+", description="gs://bucket/path/file.csv")
    name: str | None = None


@capability("connect.gcs", "connect", "Import from Cloud Storage",
            "Reads a CSV, JSON, Parquet or Excel file from Google Cloud Storage (the engine's service account needs read access).",
            GcsParams, needs_dataset=False, heavy=True, cacheable=False, tags=["import"])
def from_gcs(ctx, p: GcsParams):  # pragma: no cover - needs Google Cloud credentials
    from google.cloud import storage as gcs

    bucket, _, path = p.uri[5:].partition("/")
    tmp = tempfile.NamedTemporaryFile(suffix=os.path.splitext(path)[1] or ".csv", delete=False).name
    try:
        blob = gcs.Client().bucket(bucket).blob(path)
        if not blob.exists():
            raise EngineError(f"{p.uri} wasn't found or isn't readable.")
        blob.reload()
        if (blob.size or 0) > MAX_DOWNLOAD_BYTES:
            raise EngineError("The file is larger than the upload limit.", 413, "too_large")
        blob.download_to_filename(tmp)
        return {"dataset": ctx.datasets.ingest_file(tmp, os.path.basename(path), p.name or os.path.basename(path), {"kind": "gcs", "uri": p.uri})}
    finally:
        if os.path.exists(tmp):
            os.unlink(tmp)


class BigQueryParams(BaseModel):
    query: str = Field(..., max_length=100_000, description="A BigQuery Standard SQL SELECT. Summarise in BigQuery to bring back only what's needed.")
    project: str | None = None
    max_rows: int = Field(5_000_000, ge=1, le=50_000_000)
    name: str = "bigquery"


@capability("connect.bigquery", "connect", "Import from BigQuery",
            "Runs a SELECT in BigQuery (where billions of rows can be summarised for free up to the monthly quota) and streams the result into a new dataset.",
            BigQueryParams, needs_dataset=False, heavy=True, cacheable=False, tags=["import", "big data"])
def from_bigquery(ctx, p: BigQueryParams):  # pragma: no cover - needs Google Cloud credentials
    from google.cloud import bigquery

    if not p.query.lstrip().lower().startswith(("select", "with")):
        raise EngineError("Only SELECT queries can be imported.")
    client = bigquery.Client(project=p.project)
    job = client.query(p.query)
    ctx.progress(0.1, "Querying BigQuery")
    table = job.result(max_results=p.max_rows).to_arrow()
    ctx.progress(0.7, f"{table.num_rows:,} rows received")
    return {"dataset": _write_batches(ctx, [table], p.name, {"kind": "bigquery"}), "bytesProcessed": job.total_bytes_processed}


class SqlParams(BaseModel):
    engine: Literal["postgresql", "mysql"]
    host: str
    port: int | None = Field(None, ge=1, le=65535)
    database: str
    user: str
    password: str = ""
    query: str = Field(..., max_length=100_000)
    max_rows: int = Field(5_000_000, ge=1, le=50_000_000)
    ssl: bool = True
    name: str = "database"


@capability("connect.sql", "connect", "Import from a database",
            "Runs a read-only SELECT on PostgreSQL or MySQL and streams the result into a new dataset in batches.",
            SqlParams, needs_dataset=False, heavy=True, cacheable=False, tags=["import"])
def from_sql(ctx, p: SqlParams):
    if not p.query.lstrip().lower().startswith(("select", "with")):
        raise EngineError("Only SELECT queries can be imported.")
    _public_host(p.host)
    from sqlalchemy import create_engine, text
    from sqlalchemy.engine import URL

    driver = "postgresql+psycopg" if p.engine == "postgresql" else "mysql+pymysql"
    url = URL.create(driver, username=p.user, password=p.password or None, host=p.host, port=p.port, database=p.database)
    args = {"sslmode": "require"} if (p.engine == "postgresql" and p.ssl) else {}
    try:
        engine = create_engine(url, connect_args={**args, "connect_timeout": 15}, pool_pre_ping=True)
        with engine.connect() as conn:
            if p.engine == "postgresql":
                conn.execute(text("SET TRANSACTION READ ONLY"))
            result = conn.execution_options(stream_results=True).execute(text(p.query))
            cols = list(result.keys())

            def batches():
                seen = 0
                while seen < p.max_rows:
                    chunk = result.fetchmany(min(BATCH_ROWS, p.max_rows - seen))
                    if not chunk:
                        break
                    seen += len(chunk)
                    ctx.progress(min(0.9, seen / p.max_rows), f"{seen:,} rows read")
                    yield pa.Table.from_pylist([dict(zip(cols, r)) for r in chunk])

            meta = _write_batches(ctx, batches(), p.name, {"kind": p.engine, "host": p.host, "database": p.database})
    except EngineError:
        raise
    except Exception as err:  # noqa: BLE001 - driver errors become a readable message
        raise EngineError(f"The database query failed: {str(err).splitlines()[0]}") from err
    return {"dataset": meta}


def _write_batches(ctx, tables, name, source):
    out = tempfile.NamedTemporaryFile(suffix=".parquet", delete=False).name
    writer = None
    try:
        for t in tables:
            if t is None or t.num_rows == 0:
                continue
            if writer is None:
                writer = pq.ParquetWriter(out, t.schema, compression="zstd")
            elif t.schema != writer.schema:
                t = t.cast(writer.schema)
            writer.write_table(t)
            ctx.check()
    finally:
        if writer:
            writer.close()
    if writer is None:
        os.unlink(out)
        raise EngineError("The query returned no rows.")
    return ctx.datasets.ingest_parquet(out, name, source)
