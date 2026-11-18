"""Helpers shared by capability modules."""
from __future__ import annotations

from typing import Any

import numpy as np
import pandas as pd

from ..core import EngineError

NUMERIC = ("integer", "number")


def q(name: str) -> str:
    """A safely quoted SQL identifier."""
    return '"' + str(name).replace('"', '""') + '"'


def lit(value: Any) -> str:
    """A safely quoted SQL literal."""
    if value is None:
        return "NULL"
    if isinstance(value, bool):
        return "TRUE" if value else "FALSE"
    if isinstance(value, (int, float, np.integer, np.floating)):
        if not np.isfinite(float(value)):
            raise EngineError("Numbers must be finite.")
        return repr(float(value)) if isinstance(value, (float, np.floating)) else str(int(value))
    return "'" + str(value).replace("'", "''") + "'"


def col_types(ctx) -> dict[str, str]:
    return {c["name"]: c["type"] for c in ctx.columns()}


def numeric_columns(ctx, exclude: list[str] | None = None) -> list[str]:
    ex = set(exclude or [])
    return [c["name"] for c in ctx.columns() if c["type"] in NUMERIC and c["name"] not in ex]


def as_numeric(series: pd.Series, name: str) -> pd.Series:
    out = pd.to_numeric(series, errors="coerce")
    if out.notna().sum() == 0:
        raise EngineError(f"“{name}” has no numeric values.")
    return out


def need(condition: bool, message: str) -> None:
    if not condition:
        raise EngineError(message)


def fmt_p(p: float | None) -> str:
    if p is None or not np.isfinite(p):
        return "p = n/a"
    return "p < 0.001" if p < 0.001 else f"p = {p:.3f}"


def ci(lo: float, hi: float) -> list[float]:
    return [float(lo), float(hi)]
