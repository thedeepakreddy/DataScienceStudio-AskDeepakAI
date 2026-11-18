"""Text analytics (sentiment, keywords, topics, similarity) and optimisation
(Monte Carlo simulation, linear/integer programming, what-if scenarios)."""
from __future__ import annotations

import ast
import math
import operator
from typing import Any, Literal

import numpy as np
import pandas as pd
from pydantic import BaseModel, Field
from scipy import optimize, stats
from sklearn.decomposition import NMF
from sklearn.feature_extraction.text import TfidfVectorizer
from sklearn.metrics.pairwise import cosine_similarity

from ..core import EngineError
from ..registry import capability
from ._util import need


# ---------------------------------------------------------------- text
class TextParams(BaseModel):
    column: str
    group: str | None = None
    topics: int = Field(6, ge=2, le=30)
    keywords: int = Field(20, ge=5, le=100)
    max_rows: int = Field(100_000, ge=10, le=1_000_000)
    save: bool = Field(False, description="Save a dataset with a sentiment score and topic per row.")


@capability("text.analyze", "text", "Analyse text",
            "For a text column: sentiment per row (VADER) and overall, keywords (TF-IDF), topics (NMF) with their top words and shares, text length statistics, duplicates, and comparisons by group.",
            TextParams, heavy=True, tags=["nlp", "text"])
def analyze(ctx, p: TextParams):
    from vaderSentiment.vaderSentiment import SentimentIntensityAnalyzer

    ctx.require(p.column, p.group)
    df = ctx.frame([p.column] + ([p.group] if p.group else []), max_rows=p.max_rows)
    text = df[p.column].fillna("").astype(str)
    need((text.str.len() > 0).sum() >= 5, "Need at least 5 non-empty texts.")
    ctx.progress(0.1, "Sentiment")
    sia = SentimentIntensityAnalyzer()
    sent = np.array([sia.polarity_scores(t)["compound"] if t else np.nan for t in text])
    label = np.where(sent >= 0.05, "positive", np.where(sent <= -0.05, "negative", "neutral"))
    ctx.progress(0.4, "Keywords and topics")
    vec = TfidfVectorizer(max_features=20_000, stop_words="english", min_df=2 if len(text) > 50 else 1, ngram_range=(1, 2), sublinear_tf=True)
    M = vec.fit_transform(text)
    terms = np.array(vec.get_feature_names_out())
    weight = np.asarray(M.mean(axis=0)).ravel()
    keywords = [{"term": terms[i], "weight": float(weight[i])} for i in np.argsort(-weight)[: p.keywords]]
    k = min(p.topics, max(2, M.shape[1] - 1), M.shape[0] - 1)
    nmf = NMF(k, random_state=ctx.seed, init="nndsvda", max_iter=400).fit(M)
    W = nmf.transform(M)
    topic = W.argmax(axis=1)
    topics = [{"topic": t + 1, "words": [terms[i] for i in np.argsort(-nmf.components_[t])[:10]], "share": float((topic == t).mean()),
               "sentiment": float(np.nanmean(sent[topic == t])) if (topic == t).any() else None} for t in range(k)]
    lengths = text.str.split().str.len()
    out: dict[str, Any] = {"rows": len(text), "sentiment": {"mean": float(np.nanmean(sent)), "positive": float((label == "positive").mean()),
                           "neutral": float((label == "neutral").mean()), "negative": float((label == "negative").mean()),
                           "histogram": np.histogram(sent[~np.isnan(sent)], bins=20, range=(-1, 1))[0].tolist()},
                           "keywords": keywords, "topics": topics, "length": {"meanWords": float(lengths.mean()), "medianWords": float(lengths.median()), "maxWords": int(lengths.max())},
                           "duplicates": int(text.duplicated().sum()),
                           "examples": {"mostPositive": text.iloc[np.argsort(-np.nan_to_num(sent, nan=0))[:3]].tolist(),
                                        "mostNegative": text.iloc[np.argsort(np.nan_to_num(sent, nan=0))[:3]].tolist()}}
    if p.group:
        g = pd.DataFrame({"g": df[p.group].astype(str), "s": sent, "neg": label == "negative"})
        out["byGroup"] = [{"group": k_, "n": len(v), "meanSentiment": float(v["s"].mean()), "negativeShare": float(v["neg"].mean())} for k_, v in g.groupby("g")]
    if p.save:
        out["dataset"] = ctx.save_frame(df.assign(sentiment=sent, sentiment_label=label, topic=topic + 1), f"{ctx.dataset['name']} – text analysis")
    return out


class SimilarParams(BaseModel):
    column: str
    query: str | None = Field(None, description="Find rows most similar to this text; leave empty to find near-duplicates.")
    top: int = Field(10, ge=1, le=200)
    duplicate_threshold: float = Field(0.9, gt=0.5, le=1)
    max_rows: int = Field(50_000, ge=10, le=200_000)


@capability("text.similarity", "text", "Similar and duplicate text",
            "Finds the rows whose text is most similar to a query, or pairs of near-duplicate texts, by TF-IDF cosine similarity.",
            SimilarParams, tags=["nlp", "search"])
def similarity(ctx, p: SimilarParams):
    ctx.require(p.column)
    text = ctx.frame([p.column], max_rows=p.max_rows)[p.column].fillna("").astype(str)
    vec = TfidfVectorizer(ngram_range=(1, 2), sublinear_tf=True)
    M = vec.fit_transform(text)
    if p.query:
        sims = cosine_similarity(vec.transform([p.query]), M).ravel()
        idx = np.argsort(-sims)[: p.top]
        return {"query": p.query, "matches": [{"row": int(i), "text": text.iloc[i], "similarity": float(sims[i])} for i in idx]}
    need(len(text) <= 20_000, "Near-duplicate search is limited to 20,000 rows.")
    pairs = []
    for start in range(0, M.shape[0], 2000):
        S = cosine_similarity(M[start:start + 2000], M)
        for a, b in zip(*np.where(S >= p.duplicate_threshold)):
            i, j = start + a, b
            if i < j:
                pairs.append({"a": int(i), "b": int(j), "similarity": float(S[a, b]), "textA": text.iloc[i][:200], "textB": text.iloc[j][:200]})
    pairs.sort(key=lambda r: -r["similarity"])
    return {"duplicatePairs": pairs[: p.top * 10], "count": len(pairs)}


# ---------------------------------------------------------------- optimisation
_OPS = {ast.Add: operator.add, ast.Sub: operator.sub, ast.Mult: operator.mul, ast.Div: operator.truediv, ast.Pow: operator.pow,
        ast.USub: operator.neg, ast.UAdd: operator.pos, ast.Mod: operator.mod,
        ast.Lt: operator.lt, ast.LtE: operator.le, ast.Gt: operator.gt, ast.GtE: operator.ge}
_FUNCS = {"min": np.minimum, "max": np.maximum, "abs": np.abs, "sqrt": np.sqrt, "log": np.log, "exp": np.exp, "round": np.round,
          "where": np.where, "floor": np.floor, "ceil": np.ceil}


def safe_eval(expr: str, env: dict[str, Any]) -> Any:
    """Evaluates arithmetic over named arrays without Python's eval (no attribute access, no imports)."""
    try:
        tree = ast.parse(expr, mode="eval")
    except SyntaxError as err:
        raise EngineError(f"The formula has a syntax error: {err.msg}.") from err

    def ev(n):
        if isinstance(n, ast.Expression):
            return ev(n.body)
        if isinstance(n, ast.Constant) and isinstance(n.value, (int, float)):
            return n.value
        if isinstance(n, ast.Name):
            if n.id not in env:
                raise EngineError(f"Unknown name “{n.id}” in the formula.")
            return env[n.id]
        if isinstance(n, ast.BinOp) and type(n.op) in _OPS:
            return _OPS[type(n.op)](ev(n.left), ev(n.right))
        if isinstance(n, ast.UnaryOp) and type(n.op) in _OPS:
            return _OPS[type(n.op)](ev(n.operand))
        if isinstance(n, ast.Compare) and len(n.ops) == 1 and type(n.ops[0]) in _OPS:
            return _OPS[type(n.ops[0])](ev(n.left), ev(n.comparators[0])).astype(float)
        if isinstance(n, ast.Call) and isinstance(n.func, ast.Name) and n.func.id in _FUNCS and not n.keywords:
            return _FUNCS[n.func.id](*[ev(a) for a in n.args])
        raise EngineError("The formula may only use numbers, variable names, + − × ÷ ^, comparisons and min, max, abs, sqrt, log, exp, round, floor, ceil, where.")

    return ev(tree)


class Variable(BaseModel):
    name: str = Field(..., pattern=r"^[A-Za-z_][A-Za-z0-9_]*$")
    distribution: Literal["normal", "uniform", "triangular", "lognormal", "beta", "poisson", "constant", "discrete"]
    a: float | None = None
    b: float | None = None
    c: float | None = None
    values: list[float] | None = None
    weights: list[float] | None = None


class MonteCarloParams(BaseModel):
    variables: list[Variable] = Field(..., min_length=1, max_length=50)
    formula: str = Field(..., max_length=2000, description="e.g. price * volume - fixed_cost")
    simulations: int = Field(100_000, ge=1000, le=2_000_000)
    threshold: float | None = Field(None, description="Report the probability that the result is above this.")


@capability("opt.monte_carlo", "optimize", "Monte Carlo simulation",
            "Simulates an outcome from uncertain inputs (normal, uniform, triangular, log-normal, beta, Poisson, discrete): its distribution, percentiles, probability of beating a threshold, and which inputs drive it most (tornado).",
            MonteCarloParams, needs_dataset=False, tags=["risk", "simulation", "what-if"])
def monte_carlo(ctx, p: MonteCarloParams):
    rng, n = ctx.rng, p.simulations
    env: dict[str, Any] = {}
    for v in p.variables:
        d = v.distribution
        try:
            if d == "normal":
                env[v.name] = rng.normal(v.a, v.b, n)
            elif d == "uniform":
                env[v.name] = rng.uniform(v.a, v.b, n)
            elif d == "triangular":
                env[v.name] = rng.triangular(v.a, v.c, v.b, n)
            elif d == "lognormal":
                env[v.name] = rng.lognormal(v.a, v.b, n)
            elif d == "beta":
                env[v.name] = rng.beta(v.a, v.b, n)
            elif d == "poisson":
                env[v.name] = rng.poisson(v.a, n).astype(float)
            elif d == "constant":
                env[v.name] = np.full(n, float(v.a))
            else:
                need(bool(v.values), f"{v.name}: a discrete variable needs values.")
                w = np.array(v.weights or [1] * len(v.values), float)
                env[v.name] = rng.choice(np.array(v.values, float), n, p=w / w.sum())
        except (TypeError, ValueError) as err:
            raise EngineError(f"{v.name}: check the {d} parameters (a, b, c) — {err}") from err
    y = np.asarray(safe_eval(p.formula, env), float) * np.ones(n)
    y = y[np.isfinite(y)]
    need(len(y) > 0, "The formula produced no finite results.")
    q = [1, 5, 10, 25, 50, 75, 90, 95, 99]
    sens = []
    for v in p.variables:
        x = env[v.name]
        if np.std(x) > 0:
            r = stats.spearmanr(x[: len(y)], y).statistic
            lo, hi = np.quantile(x, 0.1), np.quantile(x, 0.9)
            sens.append({"variable": v.name, "rankCorrelation": float(r), "outputAtLow": float(np.mean(y[x[: len(y)] <= lo])), "outputAtHigh": float(np.mean(y[x[: len(y)] >= hi]))})
    sens.sort(key=lambda s: -abs(s["rankCorrelation"]))
    hist, edges = np.histogram(y, bins=50)
    return {"simulations": len(y), "mean": float(y.mean()), "sd": float(y.std(ddof=1)), "percentiles": {f"p{k}": float(np.percentile(y, k)) for k in q},
            "probabilityAbove": float((y > p.threshold).mean()) if p.threshold is not None else None,
            "histogram": [{"from": float(a), "to": float(b), "count": int(c)} for a, b, c in zip(edges[:-1], edges[1:], hist)], "sensitivity": sens}


class Constraint(BaseModel):
    coefficients: list[float]
    sense: Literal["<=", ">=", "="]
    rhs: float
    name: str | None = None


class LpParams(BaseModel):
    variables: list[str] = Field(..., min_length=1, max_length=2000)
    objective: list[float]
    sense: Literal["minimize", "maximize"] = "maximize"
    constraints: list[Constraint] = Field(default_factory=list, max_length=5000)
    lower: list[float | None] | None = None
    upper: list[float | None] | None = None
    integer: list[str] | None = Field(None, description="Variables that must be whole numbers.")
    binary: list[str] | None = None


@capability("opt.linear_program", "optimize", "Optimise (linear / integer programming)",
            "Finds the best decision under constraints — budgets, capacities, mixes, schedules — with the HiGHS solver: the optimal values, objective, which constraints bind, and shadow prices (what one more unit of each constraint is worth) for continuous problems.",
            LpParams, needs_dataset=False, tags=["optimisation", "operations research"])
def linear_program(ctx, p: LpParams):
    n = len(p.variables)
    need(len(p.objective) == n, "The objective needs one coefficient per variable.")
    for c in p.constraints:
        need(len(c.coefficients) == n, f"Constraint {c.name or ''} needs one coefficient per variable.")
    sign = -1 if p.sense == "maximize" else 1
    cvec = sign * np.array(p.objective, float)
    lo = np.array([(-np.inf if v is None else v) for v in (p.lower or [0.0] * n)], float)
    hi = np.array([(np.inf if v is None else v) for v in (p.upper or [None] * n)], float)
    integrality = np.zeros(n)
    for name in (p.integer or []) + (p.binary or []):
        need(name in p.variables, f"Unknown variable {name}.")
        integrality[p.variables.index(name)] = 1
    for name in p.binary or []:
        i = p.variables.index(name)
        lo[i], hi[i] = 0, 1
    A = np.array([c.coefficients for c in p.constraints], float) if p.constraints else np.zeros((0, n))
    lb = np.array([c.rhs if c.sense in (">=", "=") else -np.inf for c in p.constraints], float)
    ub = np.array([c.rhs if c.sense in ("<=", "=") else np.inf for c in p.constraints], float)
    cons = [optimize.LinearConstraint(A, lb, ub)] if len(A) else []
    res = optimize.milp(cvec, constraints=cons, integrality=integrality, bounds=optimize.Bounds(lo, hi))
    if res.x is None:
        return {"status": res.message, "feasible": False}
    x = res.x
    out = {"status": res.message, "feasible": True, "objective": float(sign * res.fun), "solution": {v: float(val) for v, val in zip(p.variables, x)}}
    act = A @ x if len(A) else np.array([])
    out["constraints"] = [{"name": c.name or f"c{i + 1}", "activity": float(a), "rhs": c.rhs, "slack": float(c.rhs - a) if c.sense == "<=" else float(a - c.rhs),
                           "binding": bool(abs(a - c.rhs) < 1e-7)} for i, (c, a) in enumerate(zip(p.constraints, act))]
    if not integrality.any() and len(A):
        ub_rows = [i for i, c in enumerate(p.constraints) if c.sense == "<="]
        lb_rows = [i for i, c in enumerate(p.constraints) if c.sense == ">="]
        eq_rows = [i for i, c in enumerate(p.constraints) if c.sense == "="]
        A_ub = np.vstack([A[ub_rows], -A[lb_rows]]) if ub_rows or lb_rows else None
        b_ub = np.concatenate([[p.constraints[i].rhs for i in ub_rows], [-p.constraints[i].rhs for i in lb_rows]]) if A_ub is not None else None
        lp = optimize.linprog(cvec, A_ub=A_ub, b_ub=b_ub, A_eq=A[eq_rows] if eq_rows else None, b_eq=[p.constraints[i].rhs for i in eq_rows] if eq_rows else None,
                              bounds=list(zip([None if math.isinf(v) else v for v in lo], [None if math.isinf(v) else v for v in hi])), method="highs")
        if lp.status == 0:
            duals = {}
            marg = lp.ineqlin.marginals if A_ub is not None else []
            # HiGHS marginals are d(minimised objective)/d(rhs); undo the max→min flip and the ≥→≤ negation.
            for k, i in enumerate(ub_rows):
                duals[i] = sign * marg[k]
            for k, i in enumerate(lb_rows):
                duals[i] = -sign * marg[len(ub_rows) + k]
            for k, i in enumerate(eq_rows):
                duals[i] = sign * lp.eqlin.marginals[k]
            for i, row in enumerate(out["constraints"]):
                row["shadowPrice"] = float(duals.get(i, 0.0))
    return out


class ScenarioParams(BaseModel):
    model_id: str
    base: dict[str, Any] = Field(..., description="A starting row: values for the model's features.")
    vary: dict[str, list[Any]] = Field(..., min_length=1, max_length=3, description="Feature → values to try (up to 3 features, all combinations).")


@capability("opt.scenarios", "optimize", "What-if scenarios with a model",
            "Changes chosen inputs of a saved model's row across values you list (all combinations of up to three) and shows how the prediction responds.",
            ScenarioParams, needs_dataset=False, tags=["what-if", "ml"])
def scenarios(ctx, p: ScenarioParams):
    import itertools

    pipeline, meta = ctx.models.load(p.model_id)
    missing = [f for f in meta["features"] if f not in p.base and f not in p.vary]
    need(not missing, f"The base row needs values for: {', '.join(missing)}.")
    keys = list(p.vary)
    combos = list(itertools.product(*[p.vary[k] for k in keys]))
    need(len(combos) <= 10_000, "Too many combinations (limit 10,000).")
    rows = [{**p.base, **dict(zip(keys, c))} for c in combos]
    X = pd.DataFrame(rows)[meta["features"]]
    pred = pipeline.predict(X)
    out = []
    proba = pipeline.predict_proba(X) if meta["task"] == "classification" else None
    for i, c in enumerate(combos):
        r = {"inputs": dict(zip(keys, c)), "prediction": pred[i]}
        if proba is not None:
            r["probabilities"] = dict(zip(meta["classes"], proba[i].tolist()))
        out.append(r)
    return {"model": {"id": p.model_id, "label": meta.get("label")}, "scenarios": out}
