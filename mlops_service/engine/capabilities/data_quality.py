"""Data quality: validation rules, outlier detection, and personal data (PII)."""
from __future__ import annotations

import re
from typing import Any, Literal

import pandas as pd
from pydantic import BaseModel, Field
from sklearn.ensemble import IsolationForest
from sklearn.neighbors import LocalOutlierFactor
from sklearn.preprocessing import RobustScaler

from ..core import EngineError, records
from ..registry import capability
from ._util import NUMERIC, lit, need, numeric_columns, q


# ---------------------------------------------------------------- rules
class Rule(BaseModel):
    kind: Literal["not_null", "unique", "between", "in_set", "regex", "max_missing_share", "row_count_between",
                  "column_exists", "type_is", "expression", "min_distinct", "max_length"]
    column: str | None = None
    min: float | None = None
    max: float | None = None
    values: list[Any] | None = None
    pattern: str | None = None
    share: float | None = Field(None, ge=0, le=1)
    type: str | None = None
    expression: str | None = Field(None, description="A SQL condition every row must meet, e.g. price >= cost.")
    count: int | None = None
    label: str | None = None


class RulesParams(BaseModel):
    rules: list[Rule] = Field(..., min_length=1, max_length=200)
    sample_failures: int = Field(5, ge=0, le=100)


@capability("data.validate", "data", "Check data rules",
            "Checks rules (expectations) over the whole dataset — not null, unique, ranges, allowed values, patterns, row counts, types, custom conditions — and reports what fails with examples.",
            RulesParams, tags=["quality", "expectations"])
def validate(ctx, p: RulesParams):
    n = ctx.dataset["rows"]
    types = {c["name"]: c["type"] for c in ctx.columns()}
    results = []
    for i, r in enumerate(p.rules):
        ctx.progress(i / len(p.rules), f"Rule {i + 1}")
        col = r.column
        if r.kind not in ("row_count_between", "expression") and col is None:
            raise EngineError(f"Rule {i + 1} ({r.kind}) needs a column.")
        if col is not None and r.kind != "column_exists" and col not in types:
            results.append({"rule": r.model_dump(exclude_none=True), "passed": False, "failing": None, "detail": f"Column “{col}” doesn't exist."})
            continue
        c = q(col) if col else ""
        bad_where, detail = None, ""
        if r.kind == "not_null":
            bad_where = f"{c} IS NULL"
        elif r.kind == "unique":
            dups = int(ctx.sql(f"SELECT coalesce(sum(n - 1), 0) d FROM (SELECT count(*) n FROM data WHERE {c} IS NOT NULL GROUP BY {c} HAVING count(*) > 1)").iloc[0]["d"])
            results.append({"rule": r.model_dump(exclude_none=True), "passed": dups == 0, "failing": dups, "detail": f"{dups:,} duplicate value(s)."})
            continue
        elif r.kind == "between":
            parts = []
            if r.min is not None:
                parts.append(f"CAST({c} AS DOUBLE) < {lit(r.min)}")
            if r.max is not None:
                parts.append(f"CAST({c} AS DOUBLE) > {lit(r.max)}")
            need(bool(parts), f"Rule {i + 1} (between) needs min and/or max.")
            bad_where = " OR ".join(parts)
        elif r.kind == "in_set":
            need(bool(r.values), f"Rule {i + 1} (in_set) needs values.")
            bad_where = f"{c} IS NOT NULL AND CAST({c} AS VARCHAR) NOT IN ({', '.join(lit(str(v)) for v in r.values)})"
        elif r.kind == "regex":
            need(bool(r.pattern), f"Rule {i + 1} (regex) needs a pattern.")
            try:
                re.compile(r.pattern)
            except re.error as err:
                raise EngineError(f"Rule {i + 1}: invalid pattern ({err}).") from err
            bad_where = f"{c} IS NOT NULL AND NOT regexp_full_match(CAST({c} AS VARCHAR), {lit(r.pattern)})"
        elif r.kind == "max_length":
            bad_where = f"length(CAST({c} AS VARCHAR)) > {int(r.count or 0)}"
        elif r.kind == "max_missing_share":
            share = float(ctx.sql(f"SELECT avg(CASE WHEN {c} IS NULL THEN 1.0 ELSE 0.0 END) s FROM data").iloc[0]["s"] or 0)
            limit = r.share if r.share is not None else 0.0
            results.append({"rule": r.model_dump(exclude_none=True), "passed": share <= limit, "failing": None, "detail": f"{share:.1%} missing (limit {limit:.1%})."})
            continue
        elif r.kind == "min_distinct":
            d = int(ctx.sql(f"SELECT count(DISTINCT {c}) d FROM data").iloc[0]["d"])
            results.append({"rule": r.model_dump(exclude_none=True), "passed": d >= int(r.count or 0), "failing": None, "detail": f"{d:,} distinct value(s)."})
            continue
        elif r.kind == "row_count_between":
            ok = (r.min is None or n >= r.min) and (r.max is None or n <= r.max)
            results.append({"rule": r.model_dump(exclude_none=True), "passed": ok, "failing": None, "detail": f"{n:,} rows."})
            continue
        elif r.kind == "column_exists":
            results.append({"rule": r.model_dump(exclude_none=True), "passed": col in types, "failing": None, "detail": ""})
            continue
        elif r.kind == "type_is":
            ok = types.get(col) == r.type or (r.type == "number" and types.get(col) in NUMERIC)
            results.append({"rule": r.model_dump(exclude_none=True), "passed": ok, "failing": None, "detail": f"Type is {types.get(col)}."})
            continue
        elif r.kind == "expression":
            need(bool(r.expression), f"Rule {i + 1} (expression) needs a condition.")
            if re.search(r";|\b(read_\w+|copy|attach|install|load|pragma|create|drop|insert|update|delete)\b", r.expression, re.I):
                raise EngineError(f"Rule {i + 1}: that condition isn't allowed.")
            bad_where = f"NOT coalesce(({r.expression}), FALSE)"
        try:
            failing = int(ctx.sql(f"SELECT count(*) c FROM data WHERE {bad_where}").iloc[0]["c"])
            examples = records(ctx.sql(f"SELECT * FROM data WHERE {bad_where} LIMIT {p.sample_failures}")) if failing and p.sample_failures else []
        except Exception as err:  # noqa: BLE001 - a bad user expression is reported per rule
            results.append({"rule": r.model_dump(exclude_none=True), "passed": False, "failing": None, "detail": f"Couldn't check: {err}"})
            continue
        results.append({"rule": r.model_dump(exclude_none=True), "passed": failing == 0, "failing": failing,
                        "failingShare": failing / n if n else 0, "examples": examples, "detail": detail or f"{failing:,} row(s) fail."})
    passed = sum(1 for r in results if r["passed"])
    return {"passed": passed, "failed": len(results) - passed, "rows": n, "results": results}


# ---------------------------------------------------------------- outliers
class OutlierParams(BaseModel):
    columns: list[str] | None = None
    method: Literal["iqr", "zscore", "mad", "isolation_forest", "lof"] = "iqr"
    threshold: float | None = Field(None, gt=0, description="IQR multiplier (1.5), z or MAD score (3), or expected share for forests (0.01–0.5).")
    max_rows: int = Field(500_000, ge=1000, le=5_000_000)
    save_flagged: bool = False
    examples: int = Field(10, ge=0, le=200)


@capability("data.outliers", "data", "Find outliers",
            "Unusual values per column (IQR, z-score, robust MAD) or unusual rows across columns (Isolation Forest, Local Outlier Factor), with counts, examples and an optional dataset of flagged rows.",
            OutlierParams, heavy=True, tags=["quality", "anomaly"])
def outliers(ctx, p: OutlierParams):
    cols = p.columns or numeric_columns(ctx)
    ctx.require(*cols)
    need(bool(cols), "There are no numeric columns to check.")
    df = ctx.frame(cols, max_rows=p.max_rows)
    X = df.apply(pd.to_numeric, errors="coerce")
    per_column = []
    if p.method in ("iqr", "zscore", "mad"):
        flags = pd.DataFrame(False, index=X.index, columns=cols)
        for c in cols:
            v = X[c]
            if p.method == "iqr":
                k = p.threshold or 1.5
                q1, q3 = v.quantile(0.25), v.quantile(0.75)
                lo, hi = q1 - k * (q3 - q1), q3 + k * (q3 - q1)
            elif p.method == "zscore":
                k = p.threshold or 3.0
                lo, hi = v.mean() - k * v.std(), v.mean() + k * v.std()
            else:
                k = p.threshold or 3.5
                med = v.median()
                mad = (v - med).abs().median() * 1.4826
                lo, hi = (med - k * mad, med + k * mad) if mad > 0 else (med, med)
            f = (v < lo) | (v > hi)
            flags[c] = f.fillna(False)
            per_column.append({"column": c, "lower": lo, "upper": hi, "count": int(f.sum()), "share": float(f.mean())})
        row_flag = flags.any(axis=1)
        score = flags.sum(axis=1).astype(float)
    else:
        filled = X.fillna(X.median())
        Z = RobustScaler().fit_transform(filled)
        share = min(0.5, p.threshold) if p.threshold and p.threshold < 1 else None
        if p.method == "isolation_forest":
            model = IsolationForest(n_estimators=200, contamination=share or "auto", random_state=ctx.seed)
            pred = model.fit_predict(Z)
            score = pd.Series(-model.score_samples(Z), index=X.index)
        else:
            model = LocalOutlierFactor(n_neighbors=min(35, max(5, len(Z) // 20)), contamination=share or "auto")
            pred = model.fit_predict(Z)
            score = pd.Series(-model.negative_outlier_factor_, index=X.index)
        if share:
            row_flag = pd.Series(pred == -1, index=X.index)
        else:
            # Without an expected share, a row is unusual only when its score is "far out" among the
            # scores (Tukey: above Q3 + 3 × IQR). scikit-learn's "auto" cut-off flags a third of ordinary data.
            q1, q3 = float(score.quantile(0.25)), float(score.quantile(0.75))
            row_flag = score > q3 + 3 * max(q3 - q1, 1e-12)
    flagged = df[row_flag]
    examples = flagged.assign(_outlier_score=score[row_flag]).sort_values("_outlier_score", ascending=False).head(p.examples)
    out: dict[str, Any] = {"method": p.method, "rowsChecked": len(df), "flaggedRows": int(row_flag.sum()),
                           "flaggedShare": float(row_flag.mean()), "perColumn": per_column, "examples": records(examples)}
    if p.save_flagged and len(flagged):
        out["dataset"] = ctx.save_frame(flagged.reset_index(drop=True), f"{ctx.dataset['name']} – outliers")
    return out


# ---------------------------------------------------------------- PII
PII_PATTERNS: dict[str, str] = {
    "email": r"[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}",
    "phone": r"(?:\+?\d{1,3}[\s.-]?)?(?:\(\d{2,4}\)[\s.-]?)?\d{3,4}[\s.-]?\d{3,4}(?:[\s.-]?\d{2,4})?",
    "credit_card": r"(?:\d[ -]?){13,19}",
    "ip_address": r"\b(?:\d{1,3}\.){3}\d{1,3}\b",
    "us_ssn": r"\b\d{3}-\d{2}-\d{4}\b",
    "iban": r"\b[A-Z]{2}\d{2}[A-Z0-9]{11,30}\b",
    "postcode_uk": r"\b[A-Z]{1,2}\d[A-Z\d]? ?\d[A-Z]{2}\b",
}
NAME_HINTS = re.compile(r"(^|_)(first|last|full)?_?name$|email|phone|mobile|address|street|zip|postcode|ssn|passport|dob|birth|national_id|aadhaar|pan_?no|iban|card", re.I)


def _luhn(digits: str) -> bool:
    d = [int(x) for x in digits if x.isdigit()]
    if not 13 <= len(d) <= 19:
        return False
    total = 0
    for i, x in enumerate(reversed(d)):
        if i % 2:
            x *= 2
            if x > 9:
                x -= 9
        total += x
    return total % 10 == 0


class PiiScanParams(BaseModel):
    columns: list[str] | None = None
    sample_rows: int = Field(20_000, ge=100, le=1_000_000)
    min_share: float = Field(0.05, ge=0, le=1, description="Share of values matching for a column to be flagged.")


@capability("data.pii_scan", "data", "Find personal data",
            "Scans text columns for personal data (emails, phone numbers, card numbers with a Luhn check, IP addresses, national IDs, IBANs, postcodes) and suspicious column names.",
            PiiScanParams, tags=["privacy", "governance"])
def pii_scan(ctx, p: PiiScanParams):
    cols = p.columns or [c["name"] for c in ctx.columns()]
    ctx.require(*cols)
    df = ctx.frame(cols, max_rows=p.sample_rows)
    findings = []
    for c in cols:
        vals = df[c].dropna().astype(str)
        hits = {}
        if len(vals):
            for kind, rx in PII_PATTERNS.items():
                m = vals.str.fullmatch(rx) if kind not in ("ip_address", "us_ssn", "iban", "postcode_uk") else vals.str.contains(rx, regex=True)
                if kind == "credit_card":
                    m = m & vals.map(_luhn)
                if kind == "phone":
                    m = m & vals.str.count(r"\d").between(7, 15) & ~vals.str.fullmatch(r"-?\d+(\.\d+)?")
                share = float(m.mean())
                if share >= p.min_share:
                    hits[kind] = share
        hint = bool(NAME_HINTS.search(c))
        if hits or hint:
            findings.append({"column": c, "detected": hits, "nameSuggestsPii": hint,
                             "risk": "high" if any(k in hits for k in ("credit_card", "us_ssn", "iban")) else "medium" if hits else "low"})
    return {"columnsScanned": len(cols), "rowsScanned": len(df), "findings": findings}


class PiiMaskParams(BaseModel):
    columns: list[str] = Field(..., min_length=1)
    method: Literal["hash", "redact", "partial", "drop", "generalize"] = "hash"
    salt: str = Field("", max_length=200, description="Secret added before hashing so hashes can't be reversed by lookup.")


@capability("data.pii_mask", "data", "Mask personal data",
            "Creates a new dataset with chosen columns hashed (SHA-256, salted), redacted, partially masked, generalised (e.g. dates to month) or dropped.",
            PiiMaskParams, tags=["privacy", "governance"])
def pii_mask(ctx, p: PiiMaskParams):
    ctx.require(*p.columns)
    types = {c["name"]: c["type"] for c in ctx.columns()}
    exprs = []
    for c in ctx.column_names():
        if c not in p.columns:
            exprs.append(q(c))
            continue
        if p.method == "drop":
            continue
        v = f"CAST({q(c)} AS VARCHAR)"
        if p.method == "hash":
            e = f"CASE WHEN {q(c)} IS NULL THEN NULL ELSE sha256({lit(p.salt)} || {v}) END"
        elif p.method == "redact":
            e = f"CASE WHEN {q(c)} IS NULL THEN NULL ELSE '[redacted]' END"
        elif p.method == "partial":
            e = f"CASE WHEN {q(c)} IS NULL THEN NULL WHEN length({v}) <= 4 THEN repeat('•', length({v})) ELSE repeat('•', length({v}) - 4) || right({v}, 4) END"
        else:
            if types[c] in ("date", "datetime"):
                e = f"strftime(date_trunc('month', {q(c)}), '%Y-%m')"
            elif types[c] in NUMERIC:
                e = f"round(CAST({q(c)} AS DOUBLE), -1)"
            else:
                e = f"left({v}, 1) || '…'"
        exprs.append(f"{e} AS {q(c)}")
    meta = ctx.save_query(f"SELECT {', '.join(exprs)} FROM data", f"{ctx.dataset['name']} – masked")
    if p.salt:
        ctx.note("Hashes depend on the salt; keep it secret and the same to join masked datasets.")
    return {"method": p.method, "columns": p.columns, "dataset": meta}

