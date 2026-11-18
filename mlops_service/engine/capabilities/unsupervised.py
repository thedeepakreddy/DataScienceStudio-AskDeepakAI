"""Unsupervised learning: clustering with profiles, embeddings, and association rules."""
from __future__ import annotations

import itertools
from typing import Literal

import numpy as np
import pandas as pd
from pydantic import BaseModel, Field
from sklearn.cluster import DBSCAN, HDBSCAN, AgglomerativeClustering, KMeans
from sklearn.decomposition import PCA
from sklearn.manifold import TSNE
from sklearn.metrics import calinski_harabasz_score, davies_bouldin_score, silhouette_score
from sklearn.mixture import GaussianMixture
from sklearn.preprocessing import StandardScaler

from ..registry import capability
from ._util import NUMERIC, need


def _matrix(ctx, columns: list[str] | None, max_rows: int):
    types = {c["name"]: c["type"] for c in ctx.columns()}
    cols = columns or [c for c, t in types.items() if t in NUMERIC]
    need(bool(cols), "Choose columns to use (numeric columns, or categories that will be one-hot encoded).")
    ctx.require(*cols)
    df = ctx.frame(cols, max_rows=max_rows)
    num = [c for c in cols if types[c] in NUMERIC]
    cat = [c for c in cols if c not in num]
    parts = []
    if num:
        parts.append(df[num].apply(pd.to_numeric, errors="coerce"))
    if cat:
        parts.append(pd.get_dummies(df[cat].astype(str), dtype=float))
    X = pd.concat(parts, axis=1)
    X = X.fillna(X.median(numeric_only=True))
    keep = X.std() > 0
    X = X.loc[:, keep]
    need(X.shape[1] >= 1, "The chosen columns don't vary.")
    return df, X, StandardScaler().fit_transform(X), num, cat


class ClusterParams(BaseModel):
    columns: list[str] | None = None
    method: Literal["kmeans", "gmm", "hdbscan", "agglomerative", "dbscan"] = "kmeans"
    k: int | None = Field(None, ge=2, le=50, description="Number of clusters (chosen automatically when empty).")
    k_range: list[int] = Field(default_factory=lambda: [2, 10])
    min_cluster_size: int = Field(15, ge=2, le=100_000)
    eps: float = Field(0.8, gt=0)
    max_rows: int = Field(200_000, ge=100, le=2_000_000)
    save_labels: bool = False


@capability("unsup.cluster", "unsupervised", "Find segments (clustering)",
            "Segments rows with k-means (k chosen by silhouette), Gaussian mixtures (by BIC), HDBSCAN, agglomerative (Ward) or DBSCAN, reports quality (silhouette, Davies–Bouldin, Calinski–Harabasz), profiles each cluster by what sets it apart, and can save the labels.",
            ClusterParams, heavy=True, tags=["segmentation", "clustering"])
def cluster(ctx, p: ClusterParams):  # noqa: C901
    df, X, Z, num, cat = _matrix(ctx, p.columns, p.max_rows)
    n = len(Z)
    need(n >= 10, "Need at least 10 rows.")
    sil_sample = min(n, 10_000)
    search = []
    if p.method in ("kmeans", "gmm", "agglomerative") and p.k is None:
        lo, hi = max(2, p.k_range[0]), min(p.k_range[-1], n - 1)
        for k in range(lo, hi + 1):
            ctx.progress((k - lo) / max(1, hi - lo + 1) * 0.6, f"Trying k = {k}")
            if p.method == "gmm":
                gm = GaussianMixture(k, random_state=ctx.seed, n_init=2).fit(Z)
                search.append({"k": k, "bic": float(gm.bic(Z))})
            else:
                lab = (KMeans(k, n_init=10, random_state=ctx.seed).fit_predict(Z) if p.method == "kmeans"
                       else AgglomerativeClustering(k).fit_predict(Z[:20000]))
                zz = Z if p.method == "kmeans" else Z[:20000]
                search.append({"k": k, "silhouette": float(silhouette_score(zz, lab, sample_size=min(len(zz), sil_sample), random_state=ctx.seed))})
        best_k = min(search, key=lambda r: r["bic"])["k"] if p.method == "gmm" else max(search, key=lambda r: r["silhouette"])["k"]
    else:
        best_k = p.k
    if p.method == "kmeans":
        model = KMeans(best_k, n_init=10, random_state=ctx.seed).fit(Z)
        labels = model.labels_
    elif p.method == "gmm":
        gm = GaussianMixture(best_k, random_state=ctx.seed, n_init=3).fit(Z)
        labels = gm.predict(Z)
    elif p.method == "agglomerative":
        need(n <= 30_000, "Agglomerative clustering is limited to 30,000 rows; use k-means or HDBSCAN.")
        labels = AgglomerativeClustering(best_k).fit_predict(Z)
    elif p.method == "hdbscan":
        labels = HDBSCAN(min_cluster_size=p.min_cluster_size).fit_predict(Z)
    else:
        labels = DBSCAN(eps=p.eps, min_samples=max(2, p.min_cluster_size // 3)).fit_predict(Z)
    ids = sorted(set(labels))
    real = [c for c in ids if c != -1]
    need(len(real) >= 1, "No clusters were found; try other settings.")
    quality = {}
    mask = labels != -1
    if len(real) >= 2 and mask.sum() > len(real):
        quality = {"silhouette": float(silhouette_score(Z[mask], labels[mask], sample_size=min(int(mask.sum()), sil_sample), random_state=ctx.seed)),
                   "daviesBouldin": float(davies_bouldin_score(Z[mask], labels[mask])), "calinskiHarabasz": float(calinski_harabasz_score(Z[mask], labels[mask]))}
    profiles = []
    overall_mean, overall_sd = X.mean(), X.std().replace(0, 1)
    for c in ids:
        m = labels == c
        prof = {"cluster": int(c), "label": "noise" if c == -1 else f"Cluster {c + 1}", "size": int(m.sum()), "share": float(m.mean())}
        if num:
            prof["means"] = {k: float(v) for k, v in df.loc[m, num].apply(pd.to_numeric, errors="coerce").mean().items()}
        z = ((X[m].mean() - overall_mean) / overall_sd).sort_values(key=lambda v: -v.abs())
        prof["distinctive"] = [{"feature": k, "z": float(v), "direction": "higher" if v > 0 else "lower"} for k, v in z.head(5).items()]
        if cat:
            prof["topCategories"] = {c2: df.loc[m, c2].astype(str).value_counts(normalize=True).head(3).to_dict() for c2 in cat}
        profiles.append(prof)
    emb = PCA(2, random_state=ctx.seed).fit_transform(Z)
    take = ctx.rng.choice(n, min(n, 2000), replace=False)
    out = {"method": p.method, "k": len(real), "noisePoints": int((labels == -1).sum()), "search": search, "quality": quality,
           "profiles": profiles, "map": [{"x": float(emb[i, 0]), "y": float(emb[i, 1]), "cluster": int(labels[i])} for i in take]}
    if p.save_labels:
        out["dataset"] = ctx.save_frame(df.assign(cluster=labels), f"{ctx.dataset['name']} – clusters")
    return out


class EmbedParams(BaseModel):
    columns: list[str] | None = None
    method: Literal["pca", "umap", "tsne"] = "pca"
    dimensions: int = Field(2, ge=2, le=50)
    color_by: str | None = None
    max_rows: int = Field(50_000, ge=50, le=500_000)
    plot_points: int = Field(3000, ge=100, le=20_000)


@capability("unsup.embed", "unsupervised", "Map the data (PCA, UMAP, t-SNE)",
            "Projects many columns into 2+ dimensions: PCA (with explained variance and loadings), UMAP or t-SNE, with points to plot, optionally coloured by a column.",
            EmbedParams, heavy=True, tags=["dimensionality reduction", "eda"])
def embed(ctx, p: EmbedParams):
    df, X, Z, _, _ = _matrix(ctx, p.columns, p.max_rows)
    out = {"method": p.method}
    if p.method == "pca":
        k = min(p.dimensions, Z.shape[1])
        pca = PCA(min(Z.shape[1], max(k, 10)), random_state=ctx.seed).fit(Z)
        coords = pca.transform(Z)[:, :k]
        out.update(explainedVariance=pca.explained_variance_ratio_.tolist(), cumulative=np.cumsum(pca.explained_variance_ratio_).tolist(),
                   loadings=[{"component": i + 1, "top": sorted([{"feature": f, "loading": float(v)} for f, v in zip(X.columns, pca.components_[i])], key=lambda r: -abs(r["loading"]))[:8]}
                             for i in range(min(k, 5))])
    elif p.method == "umap":
        import umap

        coords = umap.UMAP(n_components=p.dimensions, random_state=ctx.seed, n_jobs=1).fit_transform(Z[: min(len(Z), 50_000)])
    else:
        need(p.dimensions <= 3, "t-SNE gives 2 or 3 dimensions.")
        coords = TSNE(p.dimensions, random_state=ctx.seed, init="pca").fit_transform(Z[: min(len(Z), 15_000)])
    take = ctx.rng.choice(len(coords), min(len(coords), p.plot_points), replace=False)
    color = df[p.color_by].astype(str).to_numpy() if p.color_by and p.color_by in df else None
    if p.color_by and color is None:
        ctx.require(p.color_by)
        color = ctx.frame([p.color_by], max_rows=p.max_rows)[p.color_by].astype(str).to_numpy()
    out["points"] = [{"x": float(coords[i, 0]), "y": float(coords[i, 1]), **({"color": color[i]} if color is not None else {})} for i in take]
    return out


class RulesParams(BaseModel):
    transaction: str | None = Field(None, description="Transaction/basket ID column (long format, with item).")
    item: str | None = None
    item_columns: list[str] | None = Field(None, description="Or: one 0/1 column per item (wide format).")
    min_support: float = Field(0.01, gt=0, lt=1)
    min_confidence: float = Field(0.3, gt=0, le=1)
    max_items: int = Field(3, ge=2, le=4)
    max_rules: int = Field(200, ge=1, le=5000)


@capability("unsup.association_rules", "unsupervised", "Market basket (association rules)",
            "Finds items bought together (Apriori): frequent itemsets and rules 'if A then B' with support, confidence, lift and conviction.",
            RulesParams, heavy=True, tags=["marketing", "basket"])
def association_rules(ctx, p: RulesParams):
    if p.item_columns:
        ctx.require(*p.item_columns)
        df = ctx.frame(p.item_columns)
        B = (df.apply(pd.to_numeric, errors="coerce").fillna(0) > 0)
    else:
        need(p.transaction and p.item, "Give transaction and item columns, or item_columns.")
        ctx.require(p.transaction, p.item)
        df = ctx.frame([p.transaction, p.item]).dropna()
        B = pd.crosstab(df[p.transaction], df[p.item].astype(str)).astype(bool)
    n = len(B)
    need(n >= 10, "Need at least 10 baskets.")
    M = B.to_numpy()
    items = list(B.columns.astype(str))
    support = M.mean(axis=0)
    frequent: dict[tuple, float] = {(i,): float(s) for i, s in enumerate(support) if s >= p.min_support}
    need(bool(frequent), "No item reaches the minimum support; lower it.")
    level = list(frequent)
    for size in range(2, p.max_items + 1):
        singles = sorted({i for t in level for i in t})
        cands = {tuple(sorted(set(a) | set(b))) for a, b in itertools.combinations(level, 2) if len(set(a) | set(b)) == size}
        nxt = []
        for c in cands:
            if all(tuple(sorted(sub)) in frequent for sub in itertools.combinations(c, size - 1)):
                s = float(M[:, list(c)].all(axis=1).mean())
                if s >= p.min_support:
                    frequent[c] = s
                    nxt.append(c)
        level = nxt
        if not level or len(singles) < size:
            break
    rules = []
    for itemset, s in frequent.items():
        if len(itemset) < 2:
            continue
        for r in range(1, len(itemset)):
            for ante in itertools.combinations(itemset, r):
                cons = tuple(i for i in itemset if i not in ante)
                conf = s / frequent[tuple(sorted(ante))]
                if conf >= p.min_confidence:
                    cs = frequent.get(tuple(sorted(cons))) or float(M[:, list(cons)].all(axis=1).mean())
                    lift = conf / cs if cs else None
                    rules.append({"if": [items[i] for i in ante], "then": [items[i] for i in cons], "support": s, "confidence": conf, "lift": lift,
                                  "conviction": (1 - cs) / (1 - conf) if conf < 1 else None})
    rules.sort(key=lambda r: (-(r["lift"] or 0), -r["confidence"]))
    top_sets = sorted(((list(map(items.__getitem__, k)), v) for k, v in frequent.items()), key=lambda r: -r[1])[:50]
    return {"baskets": n, "items": len(items), "frequentItemsets": [{"items": a, "support": b} for a, b in top_sets], "rules": rules[: p.max_rules],
            "ruleCount": len(rules)}

