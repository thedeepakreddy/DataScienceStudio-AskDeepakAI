"""Datasets: uploaded once, stored as Parquet, read with DuckDB.

A dataset's ID is a fingerprint of its content, so the same data always gets
the same ID (and cached results stay valid). Large CSV, JSON and Parquet files
are converted by DuckDB in a streaming way, so they never have to fit in
memory; analyses then read only the columns and rows they need.
"""
from __future__ import annotations

import hashlib
import json
import os
import re
import tempfile
import threading
from typing import Any

import duckdb
import pandas as pd
import pyarrow as pa
import pyarrow.parquet as pq

from .core import EngineError, now_iso
from .storage import Storage

MAX_QUERY_ROWS = 10_000
# Statements a user query may not contain: file access, extensions, writes.
_BLOCKED_SQL = re.compile(
    r"\b(read_\w+|parquet_scan|csv_scan|sniff_csv|glob|attach|detach|copy|install|load|pragma|export|import|"
    r"create|insert|update|delete|drop|alter|set|reset|call|checkpoint|vacuum|use)\b",
    re.IGNORECASE,
)


def _qi(name: str) -> str:
    return '"' + name.replace('"', '""') + '"'


def _lit(path: str) -> str:
    return "'" + path.replace("'", "''") + "'"


def _kind(duck_type: str) -> str:
    t = duck_type.upper()
    if t.startswith(("TINYINT", "SMALLINT", "INTEGER", "BIGINT", "HUGEINT", "UTINYINT", "USMALLINT", "UINTEGER", "UBIGINT")):
        return "integer"
    if t.startswith(("DOUBLE", "FLOAT", "REAL", "DECIMAL")):
        return "number"
    if t.startswith("BOOLEAN"):
        return "boolean"
    if t.startswith("TIMESTAMP") or t.startswith("DATETIME"):
        return "datetime"
    if t.startswith("DATE"):
        return "date"
    if t.startswith(("TIME", "INTERVAL")):
        return "duration"
    return "text"


_TRUE_FALSE = {"true", "false", "t", "f"}


def _csv_text_overrides(con, path: str, delim: str) -> str:
    """DuckDB reads Yes/No (and Y/N, 1/0) columns as BOOLEAN. Keep those as the original text, so a
    "churn: Yes/No" target stays Yes/No; only genuine true/false columns become booleans."""
    cols = con.execute(f"DESCRIBE SELECT * FROM read_csv({_lit(path)}, auto_detect=true, sample_size=20480{delim})").fetchall()
    keep_text = []
    for name, kind, *_ in cols:
        if kind == "BOOLEAN":
            raw = con.execute(f"SELECT DISTINCT lower(trim({_qi(name)})) FROM read_csv({_lit(path)}, all_varchar=true{delim}) "
                              f"WHERE {_qi(name)} IS NOT NULL AND trim({_qi(name)}) <> '' LIMIT 10").fetchall()
            if not {r[0] for r in raw} <= _TRUE_FALSE:
                keep_text.append(name)
    if not keep_text:
        return ""
    return ", types={" + ", ".join(f"{_lit(n)}: 'VARCHAR'" for n in keep_text) + "}"


class Datasets:
    def __init__(self, storage: Storage) -> None:
        self.storage = storage
        self._lock = threading.Lock()

    # ---- keys ----
    @staticmethod
    def _data_key(ds_id: str) -> str:
        return f"datasets/{ds_id}/data.parquet"

    @staticmethod
    def _meta_key(ds_id: str) -> str:
        return f"datasets/{ds_id}/meta.json"

    # ---- ingest ----
    def ingest_file(self, path: str, filename: str, name: str | None = None, source: dict[str, Any] | None = None) -> dict[str, Any]:
        ext = os.path.splitext(filename.lower())[1]
        out = tempfile.NamedTemporaryFile(suffix=".parquet", delete=False).name
        try:
            con = duckdb.connect()
            con.execute("SET preserve_insertion_order = true")
            if ext in (".csv", ".tsv", ".txt"):
                delim = ", delim='\\t'" if ext == ".tsv" else ""
                types = _csv_text_overrides(con, path, delim)
                con.execute(f"COPY (SELECT * FROM read_csv({_lit(path)}, auto_detect=true, sample_size=20480{delim}{types})) "
                            f"TO {_lit(out)} (FORMAT parquet, COMPRESSION zstd)")
            elif ext in (".json", ".jsonl", ".ndjson"):
                con.execute(f"COPY (SELECT * FROM read_json_auto({_lit(path)})) TO {_lit(out)} (FORMAT parquet, COMPRESSION zstd)")
            elif ext == ".parquet":
                con.execute(f"COPY (SELECT * FROM read_parquet({_lit(path)})) TO {_lit(out)} (FORMAT parquet, COMPRESSION zstd)")
            elif ext in (".xlsx", ".xls"):
                con.close()
                return self.ingest_frame(pd.read_excel(path), name or filename, source or {"kind": "upload", "file": filename})
            else:
                raise EngineError(f"Unsupported file type “{ext or filename}”. Use CSV, TSV, JSON, Parquet or Excel.")
            con.close()
        except duckdb.Error as err:
            raise EngineError(f"Couldn't read {filename}: {err}") from err
        return self._register(out, name or filename, source or {"kind": "upload", "file": filename})

    def ingest_frame(self, df: pd.DataFrame, name: str, source: dict[str, Any] | None = None) -> dict[str, Any]:
        out = tempfile.NamedTemporaryFile(suffix=".parquet", delete=False).name
        frame = df.copy()
        frame.columns = [str(c) for c in frame.columns]
        # Object columns that mix types become text, so Parquet can store them.
        for c in frame.columns:
            if frame[c].dtype == object:
                kinds = {type(v) for v in frame[c].dropna().head(1000)}
                if len(kinds) > 1:
                    frame[c] = frame[c].map(lambda v: None if v is None or (isinstance(v, float) and pd.isna(v)) else str(v))
        pq.write_table(pa.Table.from_pandas(frame, preserve_index=False), out, compression="zstd")
        return self._register(out, name, source or {"kind": "rows"})

    def ingest_rows(self, rows: list[dict[str, Any]], name: str) -> dict[str, Any]:
        if not rows:
            raise EngineError("No rows were sent.")
        return self.ingest_frame(pd.DataFrame(rows), name, {"kind": "rows"})

    def ingest_query(self, ds_id: str, query: str, name: str, source: dict[str, Any], extra: list[str]) -> dict[str, Any]:
        """Writes engine-written SQL over `data` (and other datasets as views `d1`, `d2`, …) to a new dataset."""
        out = tempfile.NamedTemporaryFile(suffix=".parquet", delete=False).name
        con = self.connect(ds_id)
        try:
            for i, other in enumerate(extra, start=1):
                con.execute(f"CREATE VIEW d{i} AS SELECT * FROM read_parquet({_lit(self.path(other))})")
            con.execute("SET preserve_insertion_order = true")
            con.execute(f"COPY ({query}) TO {_lit(out)} (FORMAT parquet, COMPRESSION zstd)")
        except duckdb.Error as err:
            os.unlink(out)
            raise EngineError(f"Couldn't build the new dataset: {err}") from err
        finally:
            con.close()
        return self._register(out, name, source)

    def ingest_parquet(self, parquet_path: str, name: str, source: dict[str, Any]) -> dict[str, Any]:
        """Registers a Parquet file the engine has just written (it is moved into storage)."""
        return self._register(parquet_path, name, source)

    def _register(self, parquet_path: str, name: str, source: dict[str, Any]) -> dict[str, Any]:
        try:
            digest = hashlib.sha256()
            with open(parquet_path, "rb") as f:
                while chunk := f.read(1 << 20):
                    digest.update(chunk)
            ds_id = "ds_" + digest.hexdigest()[:24]
            with self._lock:
                if not self.storage.exists(self._meta_key(ds_id)):
                    self.storage.put_file(self._data_key(ds_id), parquet_path)
                    con = duckdb.connect()
                    schema = con.execute(f"DESCRIBE SELECT * FROM read_parquet({_lit(parquet_path)})").fetchall()
                    rows = con.execute(f"SELECT count(*) FROM read_parquet({_lit(parquet_path)})").fetchone()[0]
                    con.close()
                    meta = {
                        "id": ds_id, "fingerprint": digest.hexdigest(), "name": name, "rows": int(rows),
                        "columns": [{"name": c[0], "type": _kind(str(c[1])), "storageType": str(c[1])} for c in schema],
                        "bytes": os.path.getsize(parquet_path), "createdAt": now_iso(), "source": source,
                    }
                    self.storage.put(self._meta_key(ds_id), json.dumps(meta).encode())
            return self.meta(ds_id)
        finally:
            if os.path.exists(parquet_path):
                os.unlink(parquet_path)

    # ---- read ----
    def meta(self, ds_id: str) -> dict[str, Any]:
        if not re.fullmatch(r"ds_[0-9a-f]{24}", ds_id or ""):
            raise EngineError("That isn't a dataset ID.", 404, "not_found")
        try:
            return json.loads(self.storage.get(self._meta_key(ds_id)))
        except FileNotFoundError as err:
            raise EngineError(f"Dataset {ds_id} wasn't found. Upload it again.", 404, "not_found") from err

    def list(self) -> list[dict[str, Any]]:
        out = []
        for key in self.storage.list("datasets"):
            if key.endswith("/meta.json"):
                try:
                    out.append(json.loads(self.storage.get(key)))
                except (FileNotFoundError, ValueError):
                    continue
        return sorted(out, key=lambda m: m.get("createdAt", ""), reverse=True)

    def delete(self, ds_id: str) -> None:
        self.meta(ds_id)
        self.storage.delete(self._data_key(ds_id))
        self.storage.delete(self._meta_key(ds_id))

    def path(self, ds_id: str) -> str:
        self.meta(ds_id)
        return self.storage.local_path(self._data_key(ds_id))

    def connect(self, ds_id: str) -> duckdb.DuckDBPyConnection:
        """A DuckDB connection with the dataset as the view `data`."""
        con = duckdb.connect()
        con.execute(f"CREATE VIEW data AS SELECT * FROM read_parquet({_lit(self.path(ds_id))})")
        return con

    def frame(self, ds_id: str, columns: list[str] | None = None, limit: int | None = None,
              sample: int | None = None, seed: int = 0, where: str | None = None) -> pd.DataFrame:
        meta = self.meta(ds_id)
        known = {c["name"] for c in meta["columns"]}
        if columns:
            missing = [c for c in columns if c not in known]
            if missing:
                raise EngineError(f"Column(s) not in the dataset: {', '.join(missing)}.")
        cols = ", ".join('"' + c.replace('"', '""') + '"' for c in columns) if columns else "*"
        sql = f"SELECT {cols} FROM data"
        if where:
            if _BLOCKED_SQL.search(where) or ";" in where:
                raise EngineError("That filter isn't allowed.")
            sql += f" WHERE {where}"
        if sample and sample < meta["rows"]:
            sql += f" USING SAMPLE reservoir({int(sample)} ROWS) REPEATABLE ({int(seed)})"
        if limit:
            sql += f" LIMIT {int(limit)}"
        con = self.connect(ds_id)
        try:
            return con.execute(sql).df()
        except duckdb.Error as err:
            raise EngineError(f"Couldn't read the data: {err}") from err
        finally:
            con.close()

    def query(self, ds_id: str, sql: str, limit: int = 1000) -> dict[str, Any]:
        """A read-only SQL query over the dataset (the table is called `data`)."""
        text = (sql or "").strip().rstrip(";")
        if not text:
            raise EngineError("Write a query, for example: SELECT * FROM data LIMIT 10")
        if ";" in text or _BLOCKED_SQL.search(text):
            raise EngineError("Only a single read-only SELECT query is allowed.")
        try:
            stmts = duckdb.extract_statements(text)
        except duckdb.Error as err:
            raise EngineError(f"The query has an error: {err}") from err
        if len(stmts) != 1 or stmts[0].type != duckdb.StatementType.SELECT:
            raise EngineError("Only a single read-only SELECT query is allowed.")
        con = self.connect(ds_id)
        try:
            cap = max(1, min(int(limit), MAX_QUERY_ROWS))
            df = con.execute(f"SELECT * FROM ({text}) AS q LIMIT {cap + 1}").df()
        except duckdb.Error as err:
            raise EngineError(f"The query has an error: {err}") from err
        finally:
            con.close()
        from .core import records
        return {"columns": [str(c) for c in df.columns], "rows": records(df, cap), "truncated": len(df) > cap}
