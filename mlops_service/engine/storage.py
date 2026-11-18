"""Where datasets, models, job records and results are kept.

`ENGINE_STORAGE` decides: a folder path (default, for local use and tests) or
`gs://bucket/prefix` for Google Cloud Storage (production on Cloud Run, where
the local disk is memory and is lost when an instance stops). Files that DuckDB
must read are cached locally on demand.
"""
from __future__ import annotations

import os
import tempfile
from pathlib import Path
from typing import Protocol


class Storage(Protocol):
    kind: str

    def put(self, key: str, data: bytes) -> None: ...
    def put_file(self, key: str, path: str) -> None: ...
    def get(self, key: str) -> bytes: ...
    def exists(self, key: str) -> bool: ...
    def delete(self, key: str) -> None: ...
    def list(self, prefix: str) -> list[str]: ...
    def local_path(self, key: str) -> str: ...


def _safe(key: str) -> str:
    parts = [p for p in key.replace("\\", "/").split("/") if p not in ("", ".", "..")]
    if not parts:
        raise ValueError("Empty storage key.")
    return "/".join(parts)


class LocalStorage:
    kind = "local"

    def __init__(self, root: str) -> None:
        self.root = Path(root)
        self.root.mkdir(parents=True, exist_ok=True)

    def _p(self, key: str) -> Path:
        return self.root / _safe(key)

    def put(self, key: str, data: bytes) -> None:
        p = self._p(key)
        p.parent.mkdir(parents=True, exist_ok=True)
        tmp = p.with_name(p.name + ".part")
        tmp.write_bytes(data)
        os.replace(tmp, p)

    def put_file(self, key: str, path: str) -> None:
        p = self._p(key)
        p.parent.mkdir(parents=True, exist_ok=True)
        if os.path.abspath(path) != os.path.abspath(p):
            tmp = p.with_name(p.name + ".part")
            with open(path, "rb") as src, open(tmp, "wb") as dst:
                while chunk := src.read(1 << 20):
                    dst.write(chunk)
            os.replace(tmp, p)

    def get(self, key: str) -> bytes:
        p = self._p(key)
        if not p.exists():
            raise FileNotFoundError(key)
        return p.read_bytes()

    def exists(self, key: str) -> bool:
        return self._p(key).exists()

    def delete(self, key: str) -> None:
        p = self._p(key)
        if p.exists():
            p.unlink()

    def list(self, prefix: str) -> list[str]:
        base = self.root / _safe(prefix) if prefix.strip("/") else self.root
        if not base.exists():
            return []
        return sorted(str(p.relative_to(self.root)).replace(os.sep, "/") for p in base.rglob("*") if p.is_file() and not p.name.endswith(".part"))

    def local_path(self, key: str) -> str:
        p = self._p(key)
        if not p.exists():
            raise FileNotFoundError(key)
        return str(p)


class GCSStorage:  # pragma: no cover - needs Google Cloud credentials
    kind = "gcs"

    def __init__(self, bucket: str, prefix: str, cache_dir: str) -> None:
        from google.cloud import storage as gcs

        self.client = gcs.Client()
        self.bucket = self.client.bucket(bucket)
        self.prefix = prefix.strip("/")
        self.cache = Path(cache_dir)
        self.cache.mkdir(parents=True, exist_ok=True)

    def _k(self, key: str) -> str:
        return f"{self.prefix}/{_safe(key)}" if self.prefix else _safe(key)

    def put(self, key: str, data: bytes) -> None:
        self.bucket.blob(self._k(key)).upload_from_string(data)

    def put_file(self, key: str, path: str) -> None:
        self.bucket.blob(self._k(key)).upload_from_filename(path)

    def get(self, key: str) -> bytes:
        blob = self.bucket.blob(self._k(key))
        if not blob.exists():
            raise FileNotFoundError(key)
        return blob.download_as_bytes()

    def exists(self, key: str) -> bool:
        return self.bucket.blob(self._k(key)).exists()

    def delete(self, key: str) -> None:
        blob = self.bucket.blob(self._k(key))
        if blob.exists():
            blob.delete()
        cached = self.cache / _safe(key)
        if cached.exists():
            cached.unlink()

    def list(self, prefix: str) -> list[str]:
        start = len(self.prefix) + 1 if self.prefix else 0
        return sorted(b.name[start:] for b in self.client.list_blobs(self.bucket, prefix=self._k(prefix) if prefix else self.prefix or None))

    def local_path(self, key: str) -> str:
        cached = self.cache / _safe(key)
        if not cached.exists():
            cached.parent.mkdir(parents=True, exist_ok=True)
            blob = self.bucket.blob(self._k(key))
            if not blob.exists():
                raise FileNotFoundError(key)
            tmp = cached.with_name(cached.name + ".part")
            blob.download_to_filename(str(tmp))
            os.replace(tmp, cached)
        return str(cached)


def make_storage(uri: str | None = None) -> Storage:
    uri = uri or os.environ.get("ENGINE_STORAGE") or os.path.join(tempfile.gettempdir(), "askdeepakai-engine")
    if uri.startswith("gs://"):
        bucket, _, prefix = uri[5:].partition("/")
        return GCSStorage(bucket, prefix, os.path.join(tempfile.gettempdir(), "askdeepakai-engine-cache"))
    return LocalStorage(uri)
