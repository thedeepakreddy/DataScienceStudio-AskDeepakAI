"""Data preparation recipes, compiled to DuckDB SQL.

A recipe is an ordered list of steps (filter, join, pivot, window, impute,
encode, …). Each step becomes one SQL stage, and the whole recipe runs as a
single streaming query, so it works on data larger than memory. A recipe can
be previewed (first rows and the resulting columns) or saved as a new dataset.
"""
from __future__ import annotations

import re
from typing import Any, Literal

import duckdb
from pydantic import BaseModel, Field

from ..core import EngineError, records
from ..registry import capability
from ._util import lit, need, q

_UNSAFE = re.compile(r";|\b(read_\w+|parquet_scan|csv_scan|glob|copy|attach|detach|install|load|pragma|export|import|create|insert|update|delete|drop|alter|set|call)\b", re.I)
TYPES = {"integer": "BIGINT", "number": "DOUBLE", "text": "VARCHAR", "date": "DATE", "datetime": "TIMESTAMP", "boolean": "BOOLEAN"}
AGGS = {"count": "count({})", "sum": "sum({})", "avg": "avg({})", "mean": "avg({})", "min": "min({})", "max": "max({})",
        "median": "median({})", "std": "stddev_samp({})", "var": "var_samp({})", "count_distinct": "count(DISTINCT {})",
        "first": "first({})", "last": "last({})", "mode": "mode({})"}
TEXT_OPS = {
    "trim": "trim({})", "lower": "lower({})", "upper": "upper({})",
    "collapse_spaces": "regexp_replace({}, '\\s+', ' ', 'g')",
    "strip_punctuation": "regexp_replace({}, '[^\\w\\s]', '', 'g')",
    "remove_digits": "regexp_replace({}, '\\d', '', 'g')",
    "strip_accents": "strip_accents({})", "empty_to_null": "nullif(trim({}), '')",
}
OPS = {"eq": "=", "ne": "<>", "gt": ">", "ge": ">=", "lt": "<", "le": "<="}


def _expr_ok(expr: str | None, what: str) -> str:
    need(bool(expr and expr.strip()), f"{what} is empty.")
    if _UNSAFE.search(expr):
        raise EngineError(f"{what} contains something that isn't allowed.")
    return expr


class Agg(BaseModel):
    column: str | None = None
    fn: Literal["count", "sum", "avg", "mean", "min", "max", "median", "std", "var", "count_distinct", "first", "last", "mode"] = "count"
    as_: str | None = Field(None, alias="as")


class Step(BaseModel):
    op: Literal["select", "drop", "rename", "filter", "cast", "fill_missing", "drop_missing", "dedupe", "sort", "limit", "sample",
                "derive", "bin", "date_parts", "text_clean", "replace", "split", "one_hot", "label_encode", "scale", "log", "clip", "group",
                "pivot", "unpivot", "window", "join", "union", "sql"]
    columns: list[str] | None = None
    column: str | None = None
    mapping: dict[str, str] | None = None
    condition: str | None = None
    operator: Literal["eq", "ne", "gt", "ge", "lt", "le", "in", "not_in", "contains", "is_null", "not_null"] | None = None
    value: Any = None
    to: Literal["integer", "number", "text", "date", "datetime", "boolean"] | None = None
    strategy: Literal["constant", "mean", "median", "mode", "ffill", "bfill", "zero"] | None = None
    descending: list[bool] | None = None
    n: int | None = Field(None, ge=1)
    share: float | None = Field(None, gt=0, le=1)
    name: str | None = None
    expression: str | None = None
    method: str | None = None
    bins: int | None = Field(None, ge=2, le=1000)
    edges: list[float] | None = None
    labels: list[str] | None = None
    parts: list[str] | None = None
    ops: list[str] | None = None
    pattern: str | None = None
    regex: bool = False
    delimiter: str | None = None
    into: list[str] | None = None
    max_categories: int = Field(20, ge=1, le=200)
    lower: float | None = None
    upper: float | None = None
    by: list[str] | None = None
    aggregations: list[Agg] | None = None
    index: list[str] | None = None
    values: str | None = None
    agg: str = "sum"
    name_to: str = "variable"
    value_to: str = "value"
    kind: str | None = None
    partition_by: list[str] | None = None
    order_by: list[str] | None = None
    periods: int = 1
    window: int | None = Field(None, ge=1, le=100_000)
    dataset_id: str | None = None
    dataset_ids: list[str] | None = None
    how: Literal["inner", "left", "right", "full", "semi", "anti"] = "inner"
    on: list[str] | None = None
    right_on: list[str] | None = None
    suffix: str = "_right"
    by_name: bool = True
    keep: Literal["first", "last"] = "first"
    sql: str | None = None


class RecipeParams(BaseModel):
    steps: list[Step] = Field(..., min_length=1, max_length=100)
    preview: bool = Field(False, description="Return the first rows and columns without saving.")
    preview_rows: int = Field(50, ge=1, le=1000)
    name: str | None = Field(None, max_length=200)


class _Compiler:
    def __init__(self, ctx, con: duckdb.DuckDBPyConnection) -> None:
        self.ctx, self.con = ctx, con
        self.stages: list[str] = ["SELECT *, row_number() OVER () AS __row FROM data"]
        self.has_row = True
        self.extra: list[str] = []

    @property
    def prev(self) -> str:
        return f"s{len(self.stages) - 1}"

    def sql_so_far(self) -> str:
        ctes = ", ".join(f"s{i} AS ({s})" for i, s in enumerate(self.stages))
        return f"WITH {ctes} SELECT * FROM {self.prev}"

    def columns(self) -> list[str]:
        cols = [d[0] for d in self.con.execute(f"SELECT * FROM ({self.sql_so_far()}) LIMIT 0").description]
        return [c for c in cols if c != "__row"]

    def add(self, sql: str, keeps_row: bool | None = None) -> None:
        self.stages.append(sql)
        if keeps_row is not None:
            self.has_row = keeps_row

    def other(self, ds_id: str) -> tuple[str, dict[str, Any]]:
        """Another dataset, available to this recipe as d1, d2, …"""
        meta = self.ctx.datasets.meta(ds_id)
        if ds_id not in self.extra:
            self.extra.append(ds_id)
            alias = f"d{len(self.extra)}"
            self.con.execute(f"CREATE VIEW {alias} AS SELECT * FROM read_parquet({lit(self.ctx.datasets.path(ds_id))})")
        return f"d{self.extra.index(ds_id) + 1}", meta

    def final(self) -> str:
        ctes = ", ".join(f"s{i} AS ({s})" for i, s in enumerate(self.stages))
        if self.has_row:
            return f"WITH {ctes} SELECT * EXCLUDE (__row) FROM {self.prev} ORDER BY __row"
        return f"WITH {ctes} SELECT * FROM {self.prev}"


def _cols(s: Step, cols: list[str], what: str) -> list[str]:
    chosen = s.columns or ([s.column] if s.column else None)
    need(bool(chosen), f"The {what} step needs column(s).")
    missing = [c for c in chosen if c not in cols]
    need(not missing, f"The {what} step names column(s) that don't exist at that point: {', '.join(missing)}.")
    return chosen


def _compile_step(c: _Compiler, s: Step, i: int) -> None:  # noqa: C901 - one branch per operation
    p, cols, op = c.prev, c.columns(), s.op
    row = ", __row" if c.has_row else ""
    if op == "select":
        chosen = _cols(s, cols, op)
        c.add(f"SELECT {', '.join(q(x) for x in chosen)}{row} FROM {p}")
    elif op == "drop":
        chosen = _cols(s, cols, op)
        c.add(f"SELECT * EXCLUDE ({', '.join(q(x) for x in chosen)}) FROM {p}")
    elif op == "rename":
        need(bool(s.mapping), "The rename step needs a mapping.")
        for k in s.mapping:
            need(k in cols, f"Rename: “{k}” doesn't exist.")
        c.add(f"SELECT * RENAME ({', '.join(f'{q(k)} AS {q(v)}' for k, v in s.mapping.items())}) FROM {p}")
    elif op == "filter":
        if s.condition:
            cond = _expr_ok(s.condition, "The filter condition")
        else:
            col = _cols(s, cols, op)[0]
            need(s.operator is not None, "The filter step needs a condition or an operator.")
            if s.operator in OPS:
                cond = f"{q(col)} {OPS[s.operator]} {lit(s.value)}"
            elif s.operator in ("in", "not_in"):
                vals = s.value if isinstance(s.value, list) else [s.value]
                cond = f"CAST({q(col)} AS VARCHAR) {'NOT ' if s.operator == 'not_in' else ''}IN ({', '.join(lit(str(v)) for v in vals)})"
            elif s.operator == "contains":
                cond = f"contains(lower(CAST({q(col)} AS VARCHAR)), lower({lit(str(s.value))}))"
            else:
                cond = f"{q(col)} IS {'NOT ' if s.operator == 'not_null' else ''}NULL"
        c.add(f"SELECT * FROM {p} WHERE {cond}")
    elif op == "cast":
        chosen = _cols(s, cols, op)
        need(s.to is not None, "The cast step needs a type (to).")
        c.add(f"SELECT * REPLACE ({', '.join(f'TRY_CAST({q(x)} AS {TYPES[s.to]}) AS {q(x)}' for x in chosen)}) FROM {p}")
    elif op == "fill_missing":
        chosen = _cols(s, cols, op)
        strat = s.strategy or "constant"
        need(strat not in ("ffill", "bfill") or c.has_row, "Forward/back fill needs the original row order (use it before grouping).")
        order = ", ".join(q(x) for x in s.order_by) if s.order_by else "__row"
        reps = []
        for x in chosen:
            if strat == "constant":
                e = f"coalesce({q(x)}, {lit(s.value)})"
            elif strat == "zero":
                e = f"coalesce({q(x)}, 0)"
            elif strat in ("mean", "median", "mode"):
                fn = {"mean": "avg", "median": "median", "mode": "mode"}[strat]
                e = f"coalesce({q(x)}, (SELECT {fn}({q(x)}) FROM {p}))"
            else:
                frame = "ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW" if strat == "ffill" else "ROWS BETWEEN CURRENT ROW AND UNBOUNDED FOLLOWING"
                fn = "last_value" if strat == "ffill" else "first_value"
                part = f"PARTITION BY {', '.join(q(b) for b in s.partition_by)} " if s.partition_by else ""
                e = f"coalesce({q(x)}, {fn}({q(x)} IGNORE NULLS) OVER ({part}ORDER BY {order} {frame}))"
            reps.append(f"{e} AS {q(x)}")
        c.add(f"SELECT * REPLACE ({', '.join(reps)}) FROM {p}")
    elif op == "drop_missing":
        chosen = s.columns or cols
        c.add(f"SELECT * FROM {p} WHERE {' AND '.join(f'{q(x)} IS NOT NULL' for x in chosen)}")
    elif op == "dedupe":
        chosen = s.columns or cols
        order = "__row" if c.has_row else "1"
        direction = "DESC" if s.keep == "last" else "ASC"
        c.add(f"SELECT * FROM {p} QUALIFY row_number() OVER (PARTITION BY {', '.join(q(x) for x in chosen)} ORDER BY {order} {direction}) = 1")
    elif op == "sort":
        chosen = s.by or _cols(s, cols, op)
        desc = s.descending or [False] * len(chosen)
        c.add(f"SELECT * FROM {p} ORDER BY {', '.join(f'{q(x)} {'DESC' if d else 'ASC'}' for x, d in zip(chosen, desc))}", keeps_row=False)
    elif op == "limit":
        need(s.n is not None, "The limit step needs n.")
        c.add(f"SELECT * FROM {p} LIMIT {int(s.n)}")
    elif op == "sample":
        if s.n:
            c.add(f"SELECT * FROM {p} USING SAMPLE reservoir({int(s.n)} ROWS) REPEATABLE ({c.ctx.seed})")
        else:
            need(s.share is not None, "The sample step needs n or share.")
            c.add(f"SELECT * FROM {p} USING SAMPLE {s.share * 100:.6f} PERCENT (bernoulli, {c.ctx.seed})")
    elif op == "derive":
        need(bool(s.name), "The derive step needs a name for the new column.")
        c.add(f"SELECT *, ({_expr_ok(s.expression, 'The expression')}) AS {q(s.name)} FROM {p}")
    elif op == "bin":
        col = _cols(s, cols, op)[0]
        new = q(s.name or f"{col}_bin")
        x = f"CAST({q(col)} AS DOUBLE)"
        if s.edges:
            edges = sorted(s.edges)
            labels = s.labels or [f"{a:g}–{b:g}" for a, b in zip(edges[:-1], edges[1:])]
            need(len(labels) == len(edges) - 1, "Bin labels must be one fewer than the edges.")
            cases = " ".join(f"WHEN {x} >= {lit(a)} AND {x} {'<=' if k == len(labels) - 1 else '<'} {lit(b)} THEN {lit(lab)}" for k, (a, b, lab) in enumerate(zip(edges[:-1], edges[1:], labels)))
            e = f"CASE {cases} ELSE NULL END"
        elif (s.method or "equal_width") == "quantile":
            e = f"CASE WHEN {q(col)} IS NULL THEN NULL ELSE ntile({s.bins or 4}) OVER (ORDER BY {x}) END"
        else:
            b = s.bins or 10
            e = f"least(floor(({x} - (SELECT min({x}) FROM {p})) / nullif(((SELECT max({x}) FROM {p}) - (SELECT min({x}) FROM {p})) / {b}, 0)), {b - 1}) + 1"
        c.add(f"SELECT *, {e} AS {new} FROM {p}")
    elif op == "date_parts":
        col = _cols(s, cols, op)[0]
        x = f"TRY_CAST({q(col)} AS TIMESTAMP)"
        parts = s.parts or ["year", "quarter", "month", "day", "weekday", "is_weekend"]
        exprs = {
            "year": f"year({x})", "quarter": f"quarter({x})", "month": f"month({x})", "week": f"weekofyear({x})",
            "day": f"day({x})", "weekday": f"isodow({x})", "dayofyear": f"dayofyear({x})", "hour": f"hour({x})", "minute": f"minute({x})",
            "is_weekend": f"isodow({x}) >= 6", "is_month_start": f"day({x}) = 1", "is_month_end": f"day({x} + INTERVAL 1 DAY) = 1",
            "month_sin": f"sin(2 * pi() * (month({x}) - 1) / 12)", "month_cos": f"cos(2 * pi() * (month({x}) - 1) / 12)",
            "weekday_sin": f"sin(2 * pi() * (isodow({x}) - 1) / 7)", "weekday_cos": f"cos(2 * pi() * (isodow({x}) - 1) / 7)",
            "hour_sin": f"sin(2 * pi() * hour({x}) / 24)", "hour_cos": f"cos(2 * pi() * hour({x}) / 24)",
            "epoch_days": f"date_diff('day', DATE '1970-01-01', CAST({x} AS DATE))",
        }
        bad = [x_ for x_ in parts if x_ not in exprs]
        need(not bad, f"Unknown date part(s): {', '.join(bad)}. Use: {', '.join(exprs)}.")
        c.add(f"SELECT *, {', '.join(f'{exprs[x_]} AS {q(col + '_' + x_)}' for x_ in parts)} FROM {p}")
    elif op == "text_clean":
        chosen = _cols(s, cols, op)
        reps = []
        for x in chosen:
            e = f"CAST({q(x)} AS VARCHAR)"
            for o in s.ops or ["trim", "collapse_spaces"]:
                template = TEXT_OPS.get(o)
                need(template is not None, f"Unknown text operation “{o}”. Use: {', '.join(TEXT_OPS)}.")
                e = template.format(e)
            reps.append(f"{e} AS {q(x)}")
        c.add(f"SELECT * REPLACE ({', '.join(reps)}) FROM {p}")
    elif op == "replace":
        col = _cols(s, cols, op)[0]
        need(s.pattern is not None, "The replace step needs a pattern (what to replace).")
        v = f"CAST({q(col)} AS VARCHAR)"
        to = lit("" if s.value is None else str(s.value))
        e = f"regexp_replace({v}, {lit(s.pattern)}, {to}, 'g')" if s.regex else f"CASE WHEN {v} = {lit(s.pattern)} THEN {to} ELSE {v} END"
        c.add(f"SELECT * REPLACE ({e} AS {q(col)}) FROM {p}")
    elif op == "split":
        col = _cols(s, cols, op)[0]
        need(bool(s.delimiter) and bool(s.into), "The split step needs a delimiter and names (into).")
        c.add(f"SELECT *, {', '.join(f'nullif(split_part(CAST({q(col)} AS VARCHAR), {lit(s.delimiter)}, {k + 1}), {lit("")}) AS {q(n)}' for k, n in enumerate(s.into))} FROM {p}")
    elif op == "one_hot":
        col = _cols(s, cols, op)[0]
        cats = [r[0] for r in c.con.execute(f"SELECT CAST({q(col)} AS VARCHAR) v, count(*) n FROM ({c.sql_so_far()}) WHERE {q(col)} IS NOT NULL GROUP BY 1 ORDER BY n DESC, v LIMIT {s.max_categories}").fetchall()]
        need(bool(cats), f"“{col}” has no values to encode.")
        flags = ", ".join(f"CAST(CAST({q(col)} AS VARCHAR) = {lit(v)} AS INTEGER) AS {q(f'{col}_{v}'[:120])}" for v in cats)
        c.add(f"SELECT *, {flags} FROM {p}")
    elif op == "label_encode":
        # Each category becomes a whole number (0, 1, 2 …): by how often it appears (most common = 0) or alphabetically.
        reps = []
        for x in _cols(s, cols, op):
            order = "v" if (s.method or "frequency") == "alphabetical" else "n DESC, v"
            cats = [r[0] for r in c.con.execute(f"SELECT CAST({q(x)} AS VARCHAR) v, count(*) n FROM ({c.sql_so_far()}) WHERE {q(x)} IS NOT NULL GROUP BY 1 ORDER BY {order} LIMIT 5001").fetchall()]
            need(bool(cats), f"“{x}” has no values to encode.")
            need(len(cats) <= 5000, f"“{x}” has more than 5,000 different values; label encoding suits categories, not free text or ids.")
            whens = " ".join(f"WHEN {lit(v)} THEN {k}" for k, v in enumerate(cats))
            reps.append(f"CAST(CASE CAST({q(x)} AS VARCHAR) {whens} END AS INTEGER) AS {q(x)}")
        c.add(f"SELECT * REPLACE ({', '.join(reps)}) FROM {p}")
    elif op == "scale":
        chosen = _cols(s, cols, op)
        m = s.method or "standard"
        reps = []
        for x in chosen:
            v = f"CAST({q(x)} AS DOUBLE)"
            e = {"standard": f"({v} - avg({v}) OVER ()) / nullif(stddev_samp({v}) OVER (), 0)",
                 "minmax": f"({v} - min({v}) OVER ()) / nullif(max({v}) OVER () - min({v}) OVER (), 0)",
                 "robust": f"({v} - (SELECT median({v}) FROM {p})) / nullif((SELECT quantile_cont({v}, 0.75) - quantile_cont({v}, 0.25) FROM {p}), 0)"}.get(m)
            need(e is not None, "Scale method must be standard, minmax or robust.")
            reps.append(f"{e} AS {q(x)}")
        c.add(f"SELECT * REPLACE ({', '.join(reps)}) FROM {p}")
    elif op == "log":
        chosen = _cols(s, cols, op)
        c.add(f"SELECT * REPLACE ({', '.join(f'CASE WHEN {q(x)} >= 0 THEN ln(1 + CAST({q(x)} AS DOUBLE)) ELSE NULL END AS {q(x)}' for x in chosen)}) FROM {p}")
    elif op == "clip":
        chosen = _cols(s, cols, op)
        reps = []
        for x in chosen:
            v = f"CAST({q(x)} AS DOUBLE)"
            lo = f"(SELECT quantile_cont({v}, {lit(s.lower if s.lower is not None else 0.01)}) FROM {p})" if (s.method or "quantile") == "quantile" else lit(s.lower)
            hi = f"(SELECT quantile_cont({v}, {lit(s.upper if s.upper is not None else 0.99)}) FROM {p})" if (s.method or "quantile") == "quantile" else lit(s.upper)
            reps.append(f"least(greatest({v}, {lo}), {hi}) AS {q(x)}")
        c.add(f"SELECT * REPLACE ({', '.join(reps)}) FROM {p}")
    elif op == "group":
        need(bool(s.by), "The group step needs columns to group by (by).")
        aggs = s.aggregations or [Agg(fn="count")]
        sel = []
        for a in aggs:
            arg = "*" if a.column is None and a.fn == "count" else q(a.column or "")
            need(a.column is not None or a.fn == "count", f"The {a.fn} aggregation needs a column.")
            sel.append(f"{AGGS[a.fn].format(arg)} AS {q(a.as_ or (f'{a.fn}_{a.column}' if a.column else 'rows'))}")
        c.add(f"SELECT {', '.join(q(b) for b in s.by)}, {', '.join(sel)} FROM {p} GROUP BY ALL ORDER BY ALL", keeps_row=False)
    elif op == "pivot":
        need(bool(s.column) and bool(s.values), "The pivot step needs a column (whose values become new columns) and values.")
        need(s.column in cols and s.values in cols, "The pivot column and values must exist.")
        cats = [r[0] for r in c.con.execute(f"SELECT DISTINCT CAST({q(s.column)} AS VARCHAR) v FROM ({c.sql_so_far()}) WHERE {q(s.column)} IS NOT NULL ORDER BY v LIMIT 501").fetchall()]
        need(0 < len(cats) <= 500, f"Pivot: “{s.column}” must have between 1 and 500 distinct values.")
        tmpl = AGGS.get(s.agg, AGGS["sum"])
        sel = ", ".join(f"{tmpl.format(f'CASE WHEN CAST({q(s.column)} AS VARCHAR) = {lit(v)} THEN {q(s.values)} END')} AS {q(v)}" for v in cats)
        if s.index:
            c.add(f"SELECT {', '.join(q(x) for x in s.index)}, {sel} FROM {p} GROUP BY ALL ORDER BY ALL", keeps_row=False)
        else:
            c.add(f"SELECT {sel} FROM {p}", keeps_row=False)
    elif op == "unpivot":
        chosen = _cols(s, cols, op)
        types = dict(c.con.execute(f"SELECT column_name, column_type FROM (DESCRIBE SELECT * FROM ({c.sql_so_far()}))").fetchall())
        numeric = all(any(t in types.get(x, "").upper() for t in ("INT", "DOUBLE", "FLOAT", "DECIMAL", "REAL")) for x in chosen)
        cast = "DOUBLE" if numeric else "VARCHAR"
        keep = [x for x in cols if x not in chosen]
        names = ", ".join(lit(x) for x in chosen)
        vals = ", ".join(f"CAST({q(x)} AS {cast})" for x in chosen)
        c.add(f"SELECT {''.join(q(x) + ', ' for x in keep)}unnest([{names}]) AS {q(s.name_to)}, unnest([{vals}]) AS {q(s.value_to)} FROM {p}", keeps_row=False)
    elif op == "window":
        kind = s.kind or "lag"
        part = f"PARTITION BY {', '.join(q(b) for b in s.partition_by)}" if s.partition_by else ""
        order = f"ORDER BY {', '.join(q(o) for o in s.order_by)}" if s.order_by else ("ORDER BY __row" if c.has_row else "")
        col = q(s.column) if s.column else None
        over = f"OVER ({part} {order})"
        w = (s.window or 3) - 1
        frame = f"OVER ({part} {order} ROWS BETWEEN {w} PRECEDING AND CURRENT ROW)"
        exprs = {"lag": f"lag({col}, {s.periods}) {over}", "lead": f"lead({col}, {s.periods}) {over}", "rank": f"rank() {over}",
                 "dense_rank": f"dense_rank() {over}", "row_number": f"row_number() {over}", "cumsum": f"sum({col}) {over}",
                 "cummax": f"max({col}) {over}", "cummin": f"min({col}) {over}", "rolling_mean": f"avg({col}) {frame}",
                 "rolling_sum": f"sum({col}) {frame}", "rolling_std": f"stddev_samp({col}) {frame}", "rolling_max": f"max({col}) {frame}",
                 "rolling_min": f"min({col}) {frame}", "diff": f"{col} - lag({col}, {s.periods}) {over}",
                 "pct_change": f"({col} - lag({col}, {s.periods}) {over}) / nullif(lag({col}, {s.periods}) {over}, 0)",
                 "share_of_group": f"{col} / nullif(sum({col}) OVER ({part}), 0)", "group_mean": f"avg({col}) OVER ({part})",
                 "ntile": f"ntile({s.bins or 4}) {over}"}
        need(kind in exprs, f"Unknown window kind “{kind}”. Use: {', '.join(exprs)}.")
        need(col is not None or kind in ("rank", "dense_rank", "row_number", "ntile"), f"The {kind} window needs a column.")
        c.add(f"SELECT *, {exprs[kind]} AS {q(s.name or f'{s.column or kind}_{kind}')} FROM {p}")
    elif op == "join":
        need(bool(s.dataset_id) and bool(s.on), "The join step needs dataset_id and the key column(s) (on).")
        alias, meta = c.other(s.dataset_id)
        right_keys = s.right_on or s.on
        need(len(right_keys) == len(s.on), "Join: on and right_on must have the same length.")
        other_cols = [x["name"] for x in meta["columns"]]
        for k in s.on:
            need(k in cols, f"Join: “{k}” isn't in this data.")
        for k in right_keys:
            need(k in other_cols, f"Join: “{k}” isn't in the other dataset.")
        cond = " AND ".join(f"l.{q(a)} = r.{q(b)}" for a, b in zip(s.on, right_keys))
        if s.how in ("semi", "anti"):
            c.add(f"SELECT l.* FROM {p} l {s.how.upper()} JOIN {alias} r ON {cond}")
        else:
            extra = [x for x in other_cols if x not in right_keys or s.right_on]
            sel = ", ".join(f"r.{q(x)} AS {q(x + s.suffix if x in cols else x)}" for x in extra)
            c.add(f"SELECT l.*{', ' + sel if sel else ''} FROM {p} l {s.how.upper()} JOIN {alias} r ON {cond}")
    elif op == "union":
        need(bool(s.dataset_ids), "The union step needs dataset_ids.")
        src = f"(SELECT * EXCLUDE (__row) FROM {p})" if c.has_row else f"(SELECT * FROM {p})"
        parts = [src] + [f"(SELECT * FROM {c.other(d)[0]})" for d in s.dataset_ids]
        joiner = " UNION ALL BY NAME " if s.by_name else " UNION ALL "
        c.add(joiner.join(f"SELECT * FROM {x}" for x in parts), keeps_row=False)
    elif op == "sql":
        text = _expr_ok(s.sql, "The SQL")
        try:
            stmts = duckdb.extract_statements(text.replace("prev", "data"))
        except duckdb.Error as err:
            raise EngineError(f"Step {i + 1}: the SQL has an error: {err}") from err
        need(len(stmts) == 1 and stmts[0].type == duckdb.StatementType.SELECT, "The SQL step must be one SELECT over `prev`.")
        src = f"(SELECT * EXCLUDE (__row) FROM {p})" if c.has_row else p
        c.add(f"SELECT * FROM (WITH prev AS {src} {text})", keeps_row=False)


@capability("data.recipe", "data", "Prepare data (recipe)",
            "Runs a recipe of preparation steps — select, filter, cast, impute, dedupe, sort, sample, derive, bin, date parts, text cleaning, replace, split, one-hot, scale, log, clip, group, pivot, unpivot, window functions, joins, unions and SQL — as one streaming query; preview it or save a new dataset.",
            RecipeParams, heavy=True, tags=["prep", "etl", "big data"])
def recipe(ctx, p: RecipeParams):
    con = ctx.datasets.connect(ctx.dataset_id)
    try:
        comp = _Compiler(ctx, con)
        for i, step in enumerate(p.steps):
            ctx.progress(i / len(p.steps) * 0.5, f"Step {i + 1}: {step.op}")
            try:
                _compile_step(comp, step, i)
                comp.columns()  # validates the stage straight away
            except EngineError as err:
                raise EngineError(f"Step {i + 1} ({step.op}): {err.message}") from err
            except duckdb.Error as err:
                raise EngineError(f"Step {i + 1} ({step.op}) has an error: {err}") from err
        final = comp.final()
        if p.preview:
            df = con.execute(f"SELECT * FROM ({final}) LIMIT {p.preview_rows}").df()
            rows = con.execute(f"SELECT count(*) FROM ({final})").fetchone()[0]
            return {"preview": True, "rows": int(rows), "columns": [str(x) for x in df.columns], "sample": records(df), "sql": final}
        extra = list(comp.extra)
    finally:
        con.close()
    ctx.progress(0.6, "Writing the new dataset")
    meta = ctx.save_query(final, p.name or f"{ctx.dataset['name']} – prepared", extra)
    return {"preview": False, "dataset": meta, "steps": len(p.steps), "sql": final}

