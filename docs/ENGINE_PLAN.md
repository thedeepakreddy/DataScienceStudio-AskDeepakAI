# Engine v2 plan

The Python engine (`mlops_service/`) becomes a research-grade, production-grade
data science engine that can do what the leading platforms do, hosted on
Google Cloud Run (the studio itself stays on Render). This document compares
the engine with the market, lists every capability to add, and sets the order
of work. The front end is planned separately once the engine is done.

## Principles

1. **Real numbers only.** Every result comes from a tested library or our own
   tested code. AI writes words, never numbers.
2. **Reproducible.** Pinned libraries, an engine version, a seed and a data
   fingerprint on every result; the same inputs give the same outputs.
3. **Large data.** Data is uploaded once and stored as Parquet; work runs on
   DuckDB/Polars so it doesn't all have to fit in memory; huge data is
   summarised in BigQuery.
4. **Production grade.** Authenticated, validated, observable, versioned API,
   background jobs with progress, clear errors, tests against reference results.
5. **Agents can use everything.** Every capability is registered for the agent
   team (the existing coverage test enforces it).
6. **Free tier aware.** Runs on a Cloud Run instance with 2–4 vCPU and 4–8 GB;
   long work runs as jobs; heavy work samples, with the error stated.

## The market, compared

Leaders studied: DataRobot and H2O Driverless AI (AutoML), Dataiku (data
preparation, governance), Databricks (lakehouse, MLflow, serving), SAS Viya
(statistics, econometrics, forecasting, optimisation), Hex / Deepnote / Julius
(AI-assisted analysis and notebooks).

| Capability | Market leaders | Engine today | Engine v2 |
|---|---|---|---|
| Data size | Lakehouse / distributed (Databricks), in-database (SAS) | Whole dataset in one JSON request, in memory | Parquet uploads, DuckDB/Polars streaming, BigQuery push-down |
| Data sources | Dozens of connectors (Dataiku, Databricks) | File upload only | Files (CSV, Excel, JSON, Parquet), PostgreSQL, MySQL, BigQuery, Google Cloud Storage, URLs |
| Data preparation | 100+ visual recipes (Dataiku) | Cleaning in the browser | Server-side recipes at scale: join, union, pivot, unpivot, window, group, filter, dedupe, impute, encode, scale, bin, date parts, text cleaning, type casting, SQL |
| Profiling and quality | Automated profiling, rules, drift (Dataiku, Databricks) | EDA summary | Full profiling at scale, validation rules (expectations), outliers (Isolation Forest), PII detection and masking |
| AutoML | 100+ models, time-budgeted search, leaderboards (DataRobot, H2O) | 5 models, random-search tuning | 12+ model families incl. LightGBM, CatBoost; Optuna Bayesian search on a time budget; stacked ensembles; leaderboard |
| Feature engineering | Automatic transformations and interactions (H2O, DataRobot) | One-hot and impute | Date and cyclical features, lags, text (TF-IDF), target encoding (cross-fitted), interactions, automatic feature selection |
| Validation | Nested/repeated CV, holdout, backtests | Single CV, random/time/group split | Repeated and nested CV with confidence intervals, statistical model comparison, baselines |
| Metrics and calibration | Full metric suites, calibration (DataRobot) | Core metrics | ROC/PR curves, calibration curve, Brier, log-loss, lift/gain, cost-sensitive thresholds, probability calibration |
| Imbalance | Built in | None | Class weights, threshold tuning, resampling inside CV |
| Uncertainty | Prediction intervals | None | Conformal prediction intervals and sets with guaranteed coverage |
| Explainability | SHAP, K-LIME, surrogate trees, reason codes (H2O, DataRobot) | SHAP importance | SHAP global/local, partial dependence and ICE, permutation importance with CIs, surrogate tree, reason codes per prediction |
| Fairness | Bias testing and monitoring (DataRobot, Dataiku) | None | Group metrics, disparate impact, equalised odds, bias report |
| Statistics | Broad (SAS) | t/U/χ²/ANOVA/correlation, OLS/logit, power | + GLMs (Poisson, negative binomial, gamma, binomial), ANOVA/ANCOVA, mixed-effects models, robust regression, quantile regression, bootstrap CIs, nonparametric tests, multiple-testing corrections, assumption checks |
| Bayesian | SAS (procedures), PyMC in notebooks | None | Bayesian A/B, Bayesian regression (conjugate), Bayes factors, credible intervals |
| Survival | SAS | None | Kaplan–Meier, log-rank, Cox proportional hazards, AFT models |
| Econometrics and causal | SAS Econometrics, EconML in notebooks | None | Propensity matching and weighting, difference-in-differences, synthetic control, instrumental variables (2SLS), regression discontinuity, uplift, sensitivity analysis |
| Experimentation | Built into product analytics tools | A/B maths in browser | Sequential tests, CUPED, Bayesian A/B, SRM check, multi-armed bandits |
| Time series | AutoTS (DataRobot), SAS forecasting at scale | 6 classic forecasters | + ARIMA/SARIMA, ETS, Theta, ML forecasters with lags, hierarchical reconciliation, rolling backtests, prediction intervals, anomaly and change-point detection, decomposition |
| Unsupervised | Common | k-means, PCA (browser) | k-means, HDBSCAN, Gaussian mixtures, agglomerative; PCA, UMAP; association rules; cluster profiling |
| Text | LLM-heavy (Dataiku, Databricks) | None | Sentiment, keywords, topics (NMF), TF-IDF similarity, language-agnostic cleaning |
| Simulation and optimisation | SAS Optimization | None | Monte Carlo, what-if and scenario analysis, linear and integer programming |
| Experiment tracking | MLflow (Databricks) | Runs logged in browser | Every run tracked with manifest, params, metrics, artefacts |
| Model registry | MLflow, Dataiku | Model kept in memory | Versioned registry in storage, stages, approval, model cards |
| Serving | Model Serving (Databricks), MOJO (H2O) | Predict endpoint, in-memory model | Online predictions by model version, batch scoring jobs, export as a portable file |
| Monitoring | Lakehouse Monitoring, DataRobot MLOps | Drift check | Data drift, prediction drift, performance decay, alerts, scheduled checks |
| Governance and lineage | Unity Catalog, Dataiku Flow | Partial (browser provenance) | Data fingerprints, lineage of every result, audit log |
| Reproducibility | MLflow environments | Seeded, unpinned | Pinned lockfile, engine version, run manifest, re-run and verify |
| Reports | Notebooks, apps (Hex) | PDF from browser | Methods section, notebook export, run report |
| Security | Enterprise auth | Open endpoint | Shared secret between studio and engine, request limits, validation, PII masking |
| Background jobs | Clusters and job schedulers | Synchronous requests | Job queue with progress, cancel, results persisted, schedules |

## Architecture

```
studio (Render) ──HTTPS + secret──▶ engine (Cloud Run)
                                    ├─ /v1 … (today's endpoints, kept working)
                                    └─ /v2 …
                                        ├─ datasets   upload, register, profile, sample, query (DuckDB)
                                        ├─ jobs       submit, progress, cancel, result
                                        ├─ prep       recipes
                                        ├─ quality    rules, outliers, PII
                                        ├─ stats      tests, GLMs, mixed, survival, bayes, multiple testing
                                        ├─ causal     matching, DiD, synthetic control, IV, RDD, uplift
                                        ├─ experiments A/B, sequential, CUPED, bandits
                                        ├─ ml         automl v2, explain, fairness, conformal
                                        ├─ ts         forecast v2, backtest, anomalies, change points
                                        ├─ unsupervised clustering, embeddings, rules
                                        ├─ text       sentiment, keywords, topics
                                        ├─ optimize   Monte Carlo, LP/MIP
                                        ├─ models     registry, predict, batch score, monitor
                                        └─ reports    manifest, methods section, notebook
storage: local disk (dev) or Google Cloud Storage (prod) — datasets as Parquet,
         models, job results, run manifests
```

- **Package layout:** `mlops_service/engine/` with one module per area; the
  existing `main.py` mounts the v2 router and keeps every v1 endpoint unchanged,
  so the studio keeps working throughout.
- **Datasets** are identified by a content fingerprint (SHA-256 of the Parquet
  bytes), so the same data always has the same ID and results can be cached.
- **Jobs** run in a worker pool inside the engine, with state saved to storage
  so results survive restarts; anything over a few seconds is a job.
- **Every result** carries a manifest: engine version, library versions, dataset
  fingerprint, parameters, seed, timings.
- **Auth:** if `ENGINE_TOKEN` is set, every request except health must send it
  (`X-Engine-Token`); the studio's server holds it, browsers never see it.

## Phases

Each phase is tested end to end before the next starts.

| Phase | Scope |
|---|---|
| 0. Foundation | Pinned lockfile, Python 3.13, Cloud Run-ready container, auth, engine version, manifest, v2 router, storage layer (local/GCS), dataset upload as Parquet with fingerprints, DuckDB queries, jobs with progress, result cache, structured logs |
| 1. Data | Connectors (PostgreSQL, MySQL, BigQuery, GCS, URL), profiling at scale, quality rules, outliers, PII detection/masking, preparation recipes, sampling with error bounds |
| 2. Statistics | GLMs, ANOVA/ANCOVA, mixed models, robust and quantile regression, nonparametric suite, bootstrap, multiple testing, assumption checks, Bayesian (A/B, regression, Bayes factors), survival |
| 3. Causal and experiments | Matching/weighting, DiD, synthetic control, IV, RDD, uplift, sensitivity; sequential tests, CUPED, Bayesian A/B, SRM, bandits |
| 4. Machine learning | AutoML v2 (12+ families, Optuna, time budget, stacking), automatic feature engineering, repeated/nested CV with CIs, full metrics, calibration, imbalance, conformal, explainability suite, fairness |
| 5. Time series, unsupervised, text, optimisation | Forecast v2 with backtests and intervals, hierarchical, anomalies, change points; clustering and embeddings, association rules; text analytics; Monte Carlo and LP/MIP |
| 6. MLOps | Registry with versions and stages, model cards, online and batch prediction, monitoring with alerts, scheduled jobs, audit log |
| 7. Assurance and reports | Reference tests against statsmodels/scipy/lifelines published results, benchmarks, methods-section writer, notebook export, OpenAPI contract |

Hosting set-up (Cloud Run, budget alert, secrets) is documented in
`docs/DEPLOY_ENGINE.md` as part of Phase 0.

## After the engine

The front end is planned next: new panels for datasets and connectors,
recipes, the statistics and causal suites, AutoML v2 leaderboards and
explanations, forecasting v2, model registry and monitoring, and job progress,
plus agent capabilities for each.
