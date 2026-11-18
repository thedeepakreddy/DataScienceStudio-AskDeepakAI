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
   DuckDB so it doesn't all have to fit in memory; huge data is
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
| Data size | Lakehouse / distributed (Databricks), in-database (SAS) | Whole dataset in one JSON request, in memory | Parquet uploads, DuckDB streaming, BigQuery push-down |
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
`docs/DEPLOY_ENGINE.md`.

## Status (November 2026): engine v2 built

All seven phases are built and tested: 63 capabilities across 13 areas, behind
`/v2`, with every v1 endpoint unchanged. The suite has 170+ tests, which run
in the pinned Python 3.13 environment, and checks results three ways:

- planted effects (a signal the test puts in the data that the engine must find);
- library cross-checks (SciPy, statsmodels);
- published references:
  - R's Dobson Poisson GLM;
  - Kaplan–Meier, log-rank and Cox on the Gehan leukaemia data;
  - the JZS Bayes factor;
  - O'Brien–Fleming boundaries;
  - a textbook LP with shadow prices.

**Big data benchmark** (4 vCPU container, 5,000,000 rows, a 265 MB CSV):

| Step | Seconds |
|---|---|
| Ingest CSV → Parquet (26 MB) | 1.0 |
| Profile all columns | 3.5 |
| Recipe: filter + derive + group-by, saved | 0.1 |
| Validate 3 rules | 0.2 |
| SQL group-by with a 90th percentile | 0.1 |
| Sample estimate vs exact mean | 0.2 |
| Compare a column across two groups (auto test) | 3.3 |
| Outliers (IQR, 2 columns) | 0.9 |

Peak memory was about 1 GB. The benchmark exposed a bootstrap that tried to
allocate 21 GB. Bootstraps now resample in memory-bounded chunks, and very
large mean differences use the Welch normal interval.

**Deliberate choices:**

- **Imbalanced classes** are handled with class weights and with decision
  thresholds tuned on out-of-fold predictions, optionally cost-sensitive.
  Resampling (SMOTE, undersampling) is left out because it distorts predicted
  probabilities.
- **Polars** isn't used, since DuckDB covers the data layer.
- **Reason codes** for each prediction use baseline substitution (each feature
  set to its typical training value), which is fast enough to serve online.
  Full SHAP explanations are in `ml.explain`.

**Not yet verified:**

- The PostgreSQL, MySQL, BigQuery and Cloud Storage connectors, and the
  signed-upload URL, need real cloud credentials. Only their safety checks are
  tested.
- The container image builds and runs. The apt step that installs `libgomp1`
  couldn't run in the build sandbox, because its network policy blocks the
  Debian mirrors.

**Pretrained text models (deep learning on CPU).** Six capabilities run
transformer models with ONNX Runtime (no PyTorch). Each model is pinned to a
Hugging Face commit and baked into the image:

- sentence embeddings, English and multilingual: `text.embed`, `text.semantic_search`, `text.semantic_topics`;
- RoBERTa sentiment: `text.sentiment`;
- DeBERTa zero-shot labelling: `text.zero_shot`;
- BERT named entities: `text.entities`.

AutoML can also use embeddings as text features (`text_encoder`). They were
checked against the published sentence-transformers similarity for the
reference sentence pair (0.755), and run at about 1,000 texts a second on
4 vCPU.

**Front-end contract.** `src/engine/client.ts` has a typed method for every
engine route, with parameter types generated from the engine
(`src/engine/contract.generated.ts`). Tests on both sides fail if they drift
apart. See `docs/ENGINE_API.md`.

**Next:** the studio front end. That means new panels for the v2 capabilities,
and registering them for the agent team; the agent coverage test will then
enforce that registration.

## After the engine

The front end is planned next: new panels for datasets and connectors,
recipes, the statistics and causal suites, AutoML v2 leaderboards and
explanations, forecasting v2, model registry and monitoring, and job progress,
plus agent capabilities for each.
