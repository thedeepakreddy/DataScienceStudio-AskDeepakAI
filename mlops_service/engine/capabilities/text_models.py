"""Text analytics with pretrained transformer models: embeddings, semantic search,
sentiment, zero-shot labelling, named entities and semantic topics."""
from __future__ import annotations

import io
from collections import Counter
from typing import Any, Literal

import numpy as np
import pandas as pd
from pydantic import BaseModel, Field

from .. import text_models as tm
from ..core import fingerprint
from ..registry import capability
from ._util import need

EMBED_MODELS = Literal["minilm-en", "minilm-multilingual"]


def _texts(ctx, column: str, max_rows: int, extra: list[str] | None = None, keep_all: bool = False) -> pd.DataFrame:
    """The text column (and any extra columns); every column when the result will be saved as a dataset."""
    if keep_all:
        extra = [c for c in ctx.column_names() if c != column]
    ctx.require(column, *(extra or []))
    df = ctx.frame([column, *[c for c in (extra or []) if c and c != column]], max_rows=max_rows)
    df[column] = df[column].fillna("").astype(str)
    need((df[column].str.strip() != "").sum() >= 2, "Need at least two non-empty texts.")
    return df


def embeddings(ctx, texts: list[str], model: str, cache_parts: dict[str, Any] | None = None) -> np.ndarray:
    """Embeds texts, reusing vectors already computed for the same data, column and model."""
    m = tm.get_model(model, "embedding")
    key = None
    store = getattr(ctx.models, "storage", None)
    if cache_parts is not None and store is not None:
        key = f"embeddings/{fingerprint({**cache_parts, 'model': m.key, 'revision': m.revision, 'n': len(texts)})}.npy"
        try:
            return np.load(io.BytesIO(store.get(key)))
        except FileNotFoundError:
            pass
    vec = tm.runtime(m).embed(texts, progress=lambda s: ctx.progress(0.05 + 0.6 * s, "Embedding texts"))
    if key:
        buf = io.BytesIO()
        np.save(buf, vec)
        store.put(key, buf.getvalue())
    return vec


def _cache(ctx, column: str, max_rows: int) -> dict[str, Any] | None:
    return {"dataset": ctx.dataset.get("fingerprint", ctx.dataset["id"]), "column": column, "maxRows": max_rows, "seed": ctx.seed} if ctx.dataset else None


def _map2d(vec: np.ndarray, seed: int, points: int, rng) -> tuple[np.ndarray, np.ndarray]:
    take = rng.choice(len(vec), min(len(vec), points), replace=False)
    if len(vec) < 15:
        from sklearn.decomposition import PCA

        return PCA(2, random_state=seed).fit_transform(vec)[take], take
    import umap

    return umap.UMAP(n_components=2, metric="cosine", random_state=seed, n_jobs=1, n_neighbors=min(15, len(vec) - 1)).fit_transform(vec)[take], take


def _model_info(m: tm.TextModel) -> dict[str, Any]:
    return {"key": m.key, "title": m.title, "source": f"https://huggingface.co/{m.source}", "revision": m.revision, "license": m.license,
            **({"attribution": m.attribution} if m.attribution else {})}


# ---------------------------------------------------------------- embeddings and search
class EmbedParams(BaseModel):
    column: str
    model: EMBED_MODELS = "minilm-en"
    max_rows: int = Field(50_000, ge=2, le=500_000)
    map_points: int = Field(2000, ge=0, le=20_000, description="Points for a 2-D semantic map (0 = none).")
    color_by: str | None = None
    save: bool = Field(False, description="Save a dataset with the text and its embedding vector columns (emb_0 …).")


@capability("text.embed", "text", "Text embeddings (transformer)",
            "Turns each text into a meaning vector with a pretrained sentence-transformer, for semantic maps, search, clustering and as model features; optionally saves the vectors as a dataset.",
            EmbedParams, heavy=True, tags=["nlp", "embeddings", "deep learning"])
def embed(ctx, p: EmbedParams):
    df = _texts(ctx, p.column, p.max_rows, [p.color_by] if p.color_by else None, p.save)
    vec = embeddings(ctx, df[p.column].tolist(), p.model, _cache(ctx, p.column, p.max_rows))
    m = tm.get_model(p.model, "embedding")
    out: dict[str, Any] = {"rows": len(vec), "dimensions": int(vec.shape[1]), "model": _model_info(m)}
    if p.map_points:
        ctx.progress(0.7, "Making the semantic map")
        xy, take = _map2d(vec, ctx.seed, p.map_points, ctx.rng)
        out["map"] = [{"x": float(a), "y": float(b), "text": df[p.column].iloc[i][:160],
                       **({"color": str(df[p.color_by].iloc[i])} if p.color_by else {})} for (a, b), i in zip(xy, take)]
    if p.save:
        ctx.progress(0.9, "Saving the vectors")
        emb = pd.DataFrame(vec, columns=[f"emb_{k}" for k in range(vec.shape[1])])
        out["dataset"] = ctx.save_frame(pd.concat([df.reset_index(drop=True), emb], axis=1), f"{ctx.dataset['name']} – embeddings")
    return out


class SearchParams(BaseModel):
    column: str
    query: str | list[str] | None = Field(None, description="One or more questions or phrases; leave empty to find near-duplicates instead.")
    model: EMBED_MODELS = "minilm-en"
    top: int = Field(10, ge=1, le=500)
    duplicate_threshold: float = Field(0.9, gt=0.5, lt=1)
    max_rows: int = Field(100_000, ge=2, le=500_000)
    show_columns: list[str] | None = Field(None, description="Other columns to return with each match.")


@capability("text.semantic_search", "text", "Semantic search and duplicates",
            "Finds the texts closest in meaning to a query (not just shared words), or pairs of texts that say the same thing, using transformer embeddings and cosine similarity.",
            SearchParams, heavy=True, tags=["nlp", "search", "deep learning"])
def semantic_search(ctx, p: SearchParams):
    df = _texts(ctx, p.column, p.max_rows, p.show_columns)
    texts = df[p.column].tolist()
    vec = embeddings(ctx, texts, p.model, _cache(ctx, p.column, p.max_rows))
    extra = [c for c in (p.show_columns or []) if c in df]

    def row(i: int, score: float) -> dict[str, Any]:
        return {"row": int(i), "text": texts[i], "similarity": float(score), **{c: df[c].iloc[i] for c in extra}}

    if p.query:
        queries = [p.query] if isinstance(p.query, str) else p.query
        qv = tm.runtime(tm.get_model(p.model, "embedding")).embed(queries)
        sims = qv @ vec.T
        # Identical texts are one match (with how many rows share it), so repeats don't crowd out the rest.
        counts = Counter(texts)

        def matches(s: np.ndarray) -> list[dict[str, Any]]:
            seen, out = set(), []
            for i in np.argsort(-s):
                if texts[i] in seen:
                    continue
                seen.add(texts[i])
                out.append({**row(int(i), s[i]), "count": counts[texts[i]]})
                if len(out) >= p.top:
                    break
            return out

        return {"model": _model_info(tm.get_model(p.model, "embedding")),
                "results": [{"query": q, "matches": matches(s)} for q, s in zip(queries, sims)]}
    need(len(vec) <= 50_000, "Near-duplicate search is limited to 50,000 rows.")
    pairs = []
    for start in range(0, len(vec), 2048):
        S = vec[start:start + 2048] @ vec.T
        for a, b in zip(*np.where(S >= p.duplicate_threshold)):
            i = start + int(a)
            if i < b:
                pairs.append({"a": row(i, 1.0), "b": row(int(b), 1.0), "similarity": float(S[a, b])})
    pairs.sort(key=lambda r: -r["similarity"])
    groups = _groups([(r["a"]["row"], r["b"]["row"]) for r in pairs])
    return {"model": _model_info(tm.get_model(p.model, "embedding")), "duplicatePairs": pairs[: p.top * 10], "pairCount": len(pairs),
            "duplicateGroups": [{"rows": g, "texts": [texts[i][:200] for i in g[:5]]} for g in groups[: p.top]], "groupCount": len(groups)}


def _groups(pairs: list[tuple[int, int]]) -> list[list[int]]:
    parent: dict[int, int] = {}

    def find(x: int) -> int:
        while parent.setdefault(x, x) != x:
            parent[x] = parent[parent[x]]
            x = parent[x]
        return x

    for a, b in pairs:
        parent[find(a)] = find(b)
    out: dict[int, list[int]] = {}
    for x in parent:
        out.setdefault(find(x), []).append(x)
    return sorted((sorted(g) for g in out.values()), key=len, reverse=True)


# ---------------------------------------------------------------- sentiment
class SentimentParams(BaseModel):
    column: str
    group: str | None = None
    max_rows: int = Field(50_000, ge=2, le=500_000)
    save: bool = Field(False, description="Save a dataset with the label and probabilities per row.")


@capability("text.sentiment", "text", "Sentiment (transformer)",
            "Classifies each text as negative, neutral or positive with a pretrained RoBERTa model (more accurate than word lists on real reviews and messages), with probabilities, overall shares, the strongest examples and a comparison by group.",
            SentimentParams, heavy=True, tags=["nlp", "sentiment", "deep learning"])
def sentiment(ctx, p: SentimentParams):
    df = _texts(ctx, p.column, p.max_rows, [p.group] if p.group else None, p.save)
    m = tm.get_model(None, "sentiment")
    rt = tm.runtime(m)
    probs = rt.classify(df[p.column].tolist(), progress=lambda s: ctx.progress(0.05 + 0.85 * s, "Scoring sentiment"))
    labels = [rt.id2label[i] for i in range(probs.shape[1])]
    pred = np.array(labels)[probs.argmax(axis=1)]
    pos, neg = labels.index("positive"), labels.index("negative")
    score = probs[:, pos] - probs[:, neg]
    out: dict[str, Any] = {"model": _model_info(m), "rows": len(df), "labels": labels,
                           "shares": {lab: float((pred == lab).mean()) for lab in labels}, "meanScore": float(score.mean()),
                           "scoreMeaning": "P(positive) − P(negative), from −1 to 1",
                           "histogram": np.histogram(score, bins=20, range=(-1, 1))[0].tolist(),
                           "examples": {lab: [{"text": df[p.column].iloc[i][:300], "probability": float(probs[i, k])}
                                              for i in np.argsort(-probs[:, k])[:3]] for k, lab in enumerate(labels)}}
    if p.group:
        g = pd.DataFrame({"g": df[p.group].astype(str).to_numpy(), "s": score, "label": pred})
        out["byGroup"] = [{"group": k, "n": len(v), "meanScore": float(v["s"].mean()), **{f"{lab}Share": float((v["label"] == lab).mean()) for lab in labels}}
                          for k, v in g.groupby("g")]
    if p.save:
        extra = {f"sentiment_{lab}": probs[:, k] for k, lab in enumerate(labels)}
        out["dataset"] = ctx.save_frame(df.reset_index(drop=True).assign(sentiment=pred, sentiment_score=score, **extra), f"{ctx.dataset['name']} – sentiment")
    return out


# ---------------------------------------------------------------- zero-shot labels
class ZeroShotParams(BaseModel):
    column: str
    labels: list[str] = Field(..., min_length=2, max_length=20, description="Your categories, in plain words, e.g. [shipping, price, product quality].")
    multi_label: bool = Field(False, description="True when a text can belong to several categories at once.")
    hypothesis_template: str = Field("This text is about {}.", max_length=200, pattern=r"\{\}")
    threshold: float = Field(0.5, gt=0, lt=1, description="With multi_label, the score above which a label applies.")
    max_rows: int = Field(5_000, ge=1, le=50_000)
    save: bool = False


@capability("text.zero_shot", "text", "Label texts with your own categories (zero-shot)",
            "Sorts texts into categories you name, with no training data, using a natural-language-inference transformer: the best label (or several) per text with scores, the share of each category and examples.",
            ZeroShotParams, heavy=True, tags=["nlp", "classification", "deep learning"])
def zero_shot(ctx, p: ZeroShotParams):
    df = _texts(ctx, p.column, p.max_rows, keep_all=p.save)
    labels = list(dict.fromkeys(lab.strip() for lab in p.labels if lab.strip()))
    need(len(labels) >= 2, "Give at least two different labels.")
    m = tm.get_model(None, "zero_shot")
    scores = tm.runtime(m).entailment(df[p.column].tolist(), labels, p.hypothesis_template, p.multi_label,
                                       progress=lambda s: ctx.progress(0.05 + 0.85 * s, "Reading the texts"))
    best = np.array(labels)[scores.argmax(axis=1)]
    out: dict[str, Any] = {"model": _model_info(m), "rows": len(df), "labels": labels, "multiLabel": p.multi_label}
    if p.multi_label:
        applies = scores >= p.threshold
        out["shares"] = {lab: float(applies[:, k].mean()) for k, lab in enumerate(labels)}
        out["noLabelShare"] = float((~applies.any(axis=1)).mean())
    else:
        out["shares"] = {lab: float((best == lab).mean()) for lab in labels}
        out["meanConfidence"] = float(scores.max(axis=1).mean())
    out["examples"] = {lab: [{"text": df[p.column].iloc[i][:300], "score": float(scores[i, k])} for i in np.argsort(-scores[:, k])[:3]]
                       for k, lab in enumerate(labels)}
    out["sample"] = [{"text": df[p.column].iloc[i][:200], "label": best[i], "scores": dict(zip(labels, map(float, scores[i])))} for i in range(min(20, len(df)))]
    if p.save:
        cols = {f"score_{lab}": scores[:, k] for k, lab in enumerate(labels)}
        out["dataset"] = ctx.save_frame(df.reset_index(drop=True).assign(label=best, **cols), f"{ctx.dataset['name']} – labelled")
    return out


# ---------------------------------------------------------------- entities
class EntityParams(BaseModel):
    column: str
    types: list[Literal["PER", "ORG", "LOC", "MISC"]] | None = None
    min_score: float = Field(0.6, gt=0, lt=1)
    top: int = Field(20, ge=1, le=500)
    max_rows: int = Field(20_000, ge=1, le=200_000)
    save: bool = Field(False, description="Save a dataset with the entities found in each row.")


@capability("text.entities", "text", "Find people, organisations and places (NER)",
            "Extracts named entities — people, organisations, locations and other names — from text with a pretrained BERT model, with the most mentioned ones per type and the exact spans.",
            EntityParams, heavy=True, tags=["nlp", "entities", "deep learning"])
def entities(ctx, p: EntityParams):
    df = _texts(ctx, p.column, p.max_rows, keep_all=p.save)
    m = tm.get_model(None, "entities")
    found = tm.runtime(m).entities(df[p.column].tolist(), p.min_score, progress=lambda s: ctx.progress(0.05 + 0.85 * s, "Reading the texts"))
    if p.types:
        found = [[e for e in row if e["type"] in p.types] for row in found]
    names = {"PER": "people", "ORG": "organisations", "LOC": "locations", "MISC": "other names"}
    counts: dict[str, Counter] = {}
    for row in found:
        for e in row:
            counts.setdefault(e["type"], Counter())[e["text"]] += 1
    out: dict[str, Any] = {"model": _model_info(m), "rows": len(df), "rowsWithEntities": int(sum(bool(r) for r in found)),
                           "byType": [{"type": t, "label": names.get(t, t), "mentions": int(sum(c.values())), "distinct": len(c),
                                       "top": [{"text": k, "count": v} for k, v in c.most_common(p.top)]} for t, c in sorted(counts.items())],
                           "sample": [{"text": df[p.column].iloc[i][:300], "entities": found[i]} for i in range(min(20, len(df)))]}
    if p.save:
        frame = df.reset_index(drop=True).copy()
        for t in sorted({e["type"] for r in found for e in r}):
            frame[f"entities_{t}"] = [" | ".join(dict.fromkeys(e["text"] for e in r if e["type"] == t)) for r in found]
        out["dataset"] = ctx.save_frame(frame, f"{ctx.dataset['name']} – entities")
    return out


# ---------------------------------------------------------------- semantic topics
class TopicParams(BaseModel):
    column: str
    model: EMBED_MODELS = "minilm-en"
    min_topic_size: int = Field(10, ge=2, le=5000)
    n_topics: int | None = Field(None, ge=2, le=100, description="Ask for exactly this many topics (k-means on the embeddings) instead of discovering them.")
    keywords: int = Field(8, ge=3, le=30)
    max_rows: int = Field(50_000, ge=20, le=200_000)
    save: bool = False


@capability("text.semantic_topics", "text", "Topics by meaning (embeddings + clustering)",
            "Discovers topics from what texts mean rather than shared words: transformer embeddings, reduced with UMAP and clustered with HDBSCAN, each topic described by its distinctive words (class-based TF-IDF), size and most typical texts.",
            TopicParams, heavy=True, tags=["nlp", "topics", "deep learning"])
def semantic_topics(ctx, p: TopicParams):
    import umap
    from sklearn.cluster import HDBSCAN
    from sklearn.feature_extraction.text import CountVectorizer

    df = _texts(ctx, p.column, p.max_rows, keep_all=p.save)
    texts = df[p.column].tolist()
    need(len(texts) >= max(20, 2 * p.min_topic_size), f"Need at least {max(20, 2 * p.min_topic_size)} texts.")
    vec = embeddings(ctx, texts, p.model, _cache(ctx, p.column, p.max_rows))
    ctx.progress(0.7, "Grouping by meaning")
    # Identical texts are clustered once (repeats distort UMAP's neighbourhoods), then mapped back.
    uniq, first, inv = np.unique(np.array(texts, dtype=object), return_index=True, return_inverse=True)
    U = vec[first]
    n_u = len(U)
    need(n_u >= 10, "Need at least 10 different texts.")
    neighbours = int(min(50, max(10, n_u // 8), n_u - 1))
    red_u = umap.UMAP(n_components=min(5, n_u - 2), n_neighbors=neighbours, min_dist=0.0, metric="cosine", random_state=ctx.seed,
                      n_jobs=1).fit_transform(U)
    if p.n_topics:
        from sklearn.cluster import KMeans

        labels_u = KMeans(min(p.n_topics, n_u), n_init=10, random_state=ctx.seed).fit_predict(U)
    else:
        size_u = max(2, int(round(p.min_topic_size * n_u / len(texts))))
        labels_u = HDBSCAN(min_cluster_size=size_u).fit_predict(red_u)
    labels, red = labels_u[inv], red_u[inv]
    topics = sorted(t for t in set(labels) if t != -1)
    need(bool(topics), "No topics stood out; lower min_topic_size.")
    # Class-based TF-IDF (Grootendorst, 2022): a word scores high for a topic if it's common there and rare across topics.
    # One document per topic. min_df must stay 1: a word that appears in a single topic is exactly what makes
    # that topic distinctive. Rare words are dropped by their count across all texts instead.
    cv = CountVectorizer(stop_words="english", ngram_range=(1, 2), min_df=1)
    docs = [" ".join(t for t, lab in zip(texts, labels) if lab == k) for k in topics]
    C = cv.fit_transform(docs).toarray().astype(float)
    if len(texts) > 100:
        C[:, C.sum(axis=0) < 2] = 0
    tf = C / np.clip(C.sum(axis=1, keepdims=True), 1, None)
    idf = np.log(1 + C.sum(axis=1).mean() / np.clip(C.sum(axis=0), 1, None))
    ctfidf = tf * idf
    vocab = np.array(cv.get_feature_names_out())
    out_topics = []
    for j, k in enumerate(topics):
        idx = np.where(labels == k)[0]
        centre = vec[idx].mean(axis=0)
        typical = list(dict.fromkeys(texts[i] for i in idx[np.argsort(-(vec[idx] @ centre))]))[:3]
        out_topics.append({"topic": int(j + 1), "size": int(len(idx)), "share": float(len(idx) / len(texts)),
                           "keywords": [str(vocab[i]) for i in np.argsort(-ctfidf[j])[: p.keywords * 2] if ctfidf[j, i] > 0][: p.keywords], "typical": [t[:300] for t in typical]})
    out_topics.sort(key=lambda t: -t["size"])
    names = {k: j + 1 for j, k in enumerate(topics)}
    out: dict[str, Any] = {"model": _model_info(tm.get_model(p.model, "embedding")), "rows": len(texts), "topics": out_topics,
                           "outlierShare": float((labels == -1).mean())}
    xy = red[:, :2]
    take = ctx.rng.choice(len(texts), min(len(texts), 2000), replace=False)
    out["map"] = [{"x": float(xy[i, 0]), "y": float(xy[i, 1]), "topic": names.get(int(labels[i]), 0), "text": texts[i][:120]} for i in take]
    if p.save:
        out["dataset"] = ctx.save_frame(df.reset_index(drop=True).assign(topic=[names.get(int(lab), 0) for lab in labels]), f"{ctx.dataset['name']} – topics")
    return out
