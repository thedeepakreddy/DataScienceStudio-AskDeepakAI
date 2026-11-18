# Engine capabilities

Generated from engine 2.0.0 by `mlops_service/scripts/gen_contract.py`; do not edit by hand.
65 capabilities. Run one with `POST /v2/run/{name}` (through the studio: `POST /api/engine/run/{name}`), or from the front end with `engine.run(name, params)` in `src/engine/client.ts`.

## bayes

### `bayes.ab_test` — Bayesian A/B test

For conversion rates (Beta–Binomial) or averages (Normal): each variant's posterior, the probability each is best, expected loss of choosing it, and the credible interval for lift over the baseline. Works from a dataset or from summary numbers.

Dataset: not needed · quick

| Parameter | Type | Required | Default | Description |
|---|---|---|---|---|
| `variant` | `string \| null` |  | null | With a dataset: the column naming each row's variant. |
| `metric` | `string \| null` |  | null | With a dataset: the outcome (0/1 for conversion, or a number). |
| `groups` | `Array<Group> \| null` |  | null | Without a dataset: summary numbers per variant. |
| `kind` | `"auto" \| "conversion" \| "continuous"` |  | "auto" |  |
| `prior_alpha` | `number` |  | 1.0 |  |
| `prior_beta` | `number` |  | 1.0 |  |
| `credible` | `number` |  | 0.95 |  |
| `baseline` | `string \| null` |  | null |  |

### `bayes.regression` — Bayesian linear regression

Linear regression with the reference (Jeffreys) prior: posterior means, credible intervals, the probability each effect is positive, and Bayes factors for each predictor and the whole model (BIC approximation).

Dataset: required · quick

| Parameter | Type | Required | Default | Description |
|---|---|---|---|---|
| `outcome` | `string` | yes |  |  |
| `predictors` | `Array<string>` | yes |  |  |
| `credible` | `number` |  | 0.95 |  |

### `bayes.ttest` — Bayes factor t-test

How strongly the data favour a difference versus no difference (Bayes factor BF₁₀ with the JZS prior), for one or two groups, with the effect size's posterior and an evidence label.

Dataset: required · quick

| Parameter | Type | Required | Default | Description |
|---|---|---|---|---|
| `value` | `string` | yes |  |  |
| `group` | `string \| null` |  | null | Group column with two groups (two-sample); leave empty for a one-sample test against mu. |
| `mu` | `number` |  | 0.0 |  |
| `prior_scale` | `number` |  | 0.7071 | Cauchy prior scale on the effect size (√2/2 is the default 'medium'). |

## causal

### `causal.did` — Difference-in-differences

The effect of a change that hit one group and not another, comparing before and after — with clustered standard errors, unit and time fixed effects when available, and an event-study check of parallel pre-trends.

Dataset: required · quick

| Parameter | Type | Required | Default | Description |
|---|---|---|---|---|
| `outcome` | `string` | yes |  |  |
| `treated` | `string` | yes |  | 1 for units that get the treatment, 0 for comparison units. |
| `post` | `string \| null` |  | null | 1 for periods after the treatment started. Or give time + start. |
| `time` | `string \| null` |  | null |  |
| `start` | `number \| string \| null` |  | null | First treated period (with time). |
| `unit` | `string \| null` |  | null | Unit ID, for clustered standard errors and unit fixed effects. |
| `covariates` | `Array<string> \| null` |  | null |  |

### `causal.iv` — Instrumental variables (2SLS)

Two-stage least squares with robust standard errors, the first-stage F statistic (weak-instrument check), a Wu–Hausman endogeneity test and, with several instruments, a Sargan over-identification test.

Dataset: required · quick

| Parameter | Type | Required | Default | Description |
|---|---|---|---|---|
| `outcome` | `string` | yes |  |  |
| `treatment` | `string` | yes |  | The endogenous variable. |
| `instruments` | `Array<string>` | yes |  |  |
| `covariates` | `Array<string> \| null` |  | null |  |

### `causal.propensity` — Treatment effect (matching / weighting)

Estimates the effect of a treatment from observational data by propensity-score matching, inverse probability weighting, or doubly robust AIPW — with covariate balance before and after, overlap, a bootstrap confidence interval and an E-value for unmeasured confounding.

Dataset: required · long-running (job by default)

| Parameter | Type | Required | Default | Description |
|---|---|---|---|---|
| `treatment` | `string` | yes |  |  |
| `outcome` | `string` | yes |  |  |
| `covariates` | `Array<string>` | yes |  |  |
| `method` | `"matching" \| "ipw" \| "aipw"` |  | "aipw" |  |
| `estimand` | `"ATE" \| "ATT"` |  | "ATE" |  |
| `treated_value` | `string \| null` |  | null |  |
| `caliper` | `number` |  | 0.2 | Matching caliper in SDs of the propensity logit. |
| `trim` | `number` |  | 0.01 | Drop units with propensity below trim or above 1 − trim. |
| `bootstrap` | `number` |  | 300 |  |

### `causal.rdd` — Regression discontinuity

The jump in an outcome at a cutoff in a score (e.g. a grade or threshold), by local linear regression on each side, with robustness at half and double the bandwidth and a density check for manipulation of the score.

Dataset: required · quick

| Parameter | Type | Required | Default | Description |
|---|---|---|---|---|
| `outcome` | `string` | yes |  |  |
| `running` | `string` | yes |  | The score that decides treatment at the cutoff. |
| `cutoff` | `number` | yes |  |  |
| `bandwidth` | `number \| null` |  | null |  |
| `kernel` | `"triangular" \| "uniform"` |  | "triangular" |  |

### `causal.synthetic_control` — Synthetic control

The effect of an intervention on one unit (a country, store or region), estimated by building a weighted 'synthetic twin' from untreated units, with pre-period fit and a placebo (permutation) test.

Dataset: required · long-running (job by default)

| Parameter | Type | Required | Default | Description |
|---|---|---|---|---|
| `unit` | `string` | yes |  |  |
| `time` | `string` | yes |  |  |
| `outcome` | `string` | yes |  |  |
| `treated_unit` | `string` | yes |  |  |
| `start` | `number \| string` | yes |  | First period of the intervention. |
| `placebos` | `number` |  | 20 |  |

### `causal.uplift` — Uplift modelling

Who responds to a treatment (e.g. a campaign): per-person uplift from a two-model learner, uplift by decile and a Qini curve on held-out data, so you can target the people it actually changes.

Dataset: required · long-running (job by default)

| Parameter | Type | Required | Default | Description |
|---|---|---|---|---|
| `treatment` | `string` | yes |  |  |
| `outcome` | `string` | yes |  |  |
| `features` | `Array<string>` | yes |  |  |
| `treated_value` | `string \| null` |  | null |  |
| `test_size` | `number` |  | 0.3 |  |

## connect

### `connect.api` — Import from an API

Reads records from a JSON API: with a key or token (header, query or bearer) or basic sign-in, following page numbers, offsets, next links or cursors, and flattening nested fields into columns. Keys are used for this request only and never stored.

Dataset: not needed · long-running (job by default) · not cached

| Parameter | Type | Required | Default | Description |
|---|---|---|---|---|
| `url` | `string` | yes |  | The API address that returns JSON (https://…). |
| `auth` | `"none" \| "bearer" \| "header" \| "query" \| "basic"` |  | "none" | How the key is sent. |
| `api_key` | `string \| null` |  | null | The key or token (never stored). |
| `key_name` | `string \| null` |  | null | Header or query parameter name for the key (X-API-Key / api_key when empty). |
| `username` | `string \| null` |  | null | For basic sign-in. |
| `password` | `string \| null` |  | null | For basic sign-in (never stored). |
| `records_path` | `string \| null` |  | null | Where the list of records is, e.g. data.items (found automatically when empty). |
| `pagination` | `"none" \| "page" \| "offset" \| "next_link" \| "cursor"` |  | "none" |  |
| `page_param` | `string \| null` |  | null | page / offset / cursor parameter name (page, offset, cursor when empty). |
| `page_size` | `number` |  | 100 | Rows asked for per page (offset paging). |
| `size_param` | `string \| null` |  | null | Page-size parameter name (limit when empty). |
| `next_path` | `string \| null` |  | null | Where the next link or cursor is in the response, e.g. next or meta.next_cursor. |
| `max_pages` | `number` |  | 50 |  |
| `name` | `string \| null` |  | null |  |

### `connect.bigquery` — Import from BigQuery

Runs a SELECT in BigQuery (where billions of rows can be summarised for free up to the monthly quota) and streams the result into a new dataset.

Dataset: not needed · long-running (job by default) · not cached

| Parameter | Type | Required | Default | Description |
|---|---|---|---|---|
| `query` | `string` | yes |  | A BigQuery Standard SQL SELECT. Summarise in BigQuery to bring back only what's needed. |
| `project` | `string \| null` |  | null |  |
| `max_rows` | `number` |  | 5000000 |  |
| `name` | `string` |  | "bigquery" |  |

### `connect.gcs` — Import from Cloud Storage

Reads a CSV, JSON, Parquet or Excel file from Google Cloud Storage (the engine's service account needs read access).

Dataset: not needed · long-running (job by default) · not cached

| Parameter | Type | Required | Default | Description |
|---|---|---|---|---|
| `uri` | `string` | yes |  | gs://bucket/path/file.csv |
| `name` | `string \| null` |  | null |  |

### `connect.sql` — Import from a database

Runs a read-only SELECT on PostgreSQL or MySQL and streams the result into a new dataset in batches.

Dataset: not needed · long-running (job by default) · not cached

| Parameter | Type | Required | Default | Description |
|---|---|---|---|---|
| `engine` | `"postgresql" \| "mysql"` | yes |  |  |
| `host` | `string` | yes |  |  |
| `port` | `number \| null` |  | null |  |
| `database` | `string` | yes |  |  |
| `user` | `string` | yes |  |  |
| `password` | `string` |  | "" |  |
| `query` | `string` | yes |  |  |
| `max_rows` | `number` |  | 5000000 |  |
| `ssl` | `boolean` |  | true |  |
| `name` | `string` |  | "database" |  |

### `connect.url` — Import from a web address

Downloads a CSV, TSV, JSON, Parquet or Excel file from a public https URL into a new dataset.

Dataset: not needed · long-running (job by default) · not cached

| Parameter | Type | Required | Default | Description |
|---|---|---|---|---|
| `url` | `string` | yes |  |  |
| `format` | `"auto" \| "csv" \| "tsv" \| "json" \| "parquet" \| "xlsx"` |  | "auto" |  |
| `name` | `string \| null` |  | null |  |

## data

### `data.estimate` — Estimate from a sample

A fast estimate of a mean, proportion or total from a random sample, with a confidence interval (finite-population corrected), and the exact value for comparison.

Dataset: required · quick

| Parameter | Type | Required | Default | Description |
|---|---|---|---|---|
| `column` | `string` | yes |  |  |
| `statistic` | `"mean" \| "proportion" \| "total"` |  | "mean" |  |
| `sample_size` | `number` |  | 10000 |  |
| `confidence` | `number` |  | 0.95 |  |
| `value` | `string \| null` |  | null | For a proportion: the value whose share is estimated. |
| `compare_exact` | `boolean` |  | true |  |

### `data.outliers` — Find outliers

Unusual values per column (IQR, z-score, robust MAD) or unusual rows across columns (Isolation Forest, Local Outlier Factor), with counts, examples and an optional dataset of flagged rows.

Dataset: required · long-running (job by default)

| Parameter | Type | Required | Default | Description |
|---|---|---|---|---|
| `columns` | `Array<string> \| null` |  | null |  |
| `method` | `"iqr" \| "zscore" \| "mad" \| "isolation_forest" \| "lof"` |  | "iqr" |  |
| `threshold` | `number \| null` |  | null | IQR multiplier (1.5), z or MAD score (3), or expected share for forests (0.01–0.5). |
| `max_rows` | `number` |  | 500000 |  |
| `save_flagged` | `boolean` |  | false |  |
| `examples` | `number` |  | 10 |  |

### `data.pii_mask` — Mask personal data

Creates a new dataset with chosen columns hashed (SHA-256, salted), redacted, partially masked, generalised (e.g. dates to month) or dropped.

Dataset: required · quick

| Parameter | Type | Required | Default | Description |
|---|---|---|---|---|
| `columns` | `Array<string>` | yes |  |  |
| `method` | `"hash" \| "redact" \| "partial" \| "drop" \| "generalize"` |  | "hash" |  |
| `salt` | `string` |  | "" | Secret added before hashing so hashes can't be reversed by lookup. |

### `data.pii_scan` — Find personal data

Scans text columns for personal data (emails, phone numbers, card numbers with a Luhn check, IP addresses, national IDs, IBANs, postcodes) and suspicious column names.

Dataset: required · quick

| Parameter | Type | Required | Default | Description |
|---|---|---|---|---|
| `columns` | `Array<string> \| null` |  | null |  |
| `sample_rows` | `number` |  | 20000 |  |
| `min_share` | `number` |  | 0.05 | Share of values matching for a column to be flagged. |

### `data.profile` — Profile the data

Every column's type, missing values, distinct count, statistics, histogram, top values and patterns, plus duplicates and correlations — computed over the whole dataset.

Dataset: required · long-running (job by default)

| Parameter | Type | Required | Default | Description |
|---|---|---|---|---|
| `columns` | `Array<string> \| null` |  | null | Columns to profile (all when empty). |
| `top_values` | `number` |  | 10 |  |
| `histogram_bins` | `number` |  | 20 |  |
| `correlation_sample` | `number` |  | 200000 |  |

### `data.recipe` — Prepare data (recipe)

Runs a recipe of preparation steps — select, filter, cast, impute, dedupe, sort, sample, derive, bin, date parts, text cleaning, replace, split, one-hot, scale, log, clip, group, pivot, unpivot, window functions, joins, unions and SQL — as one streaming query; preview it or save a new dataset.

Dataset: required · long-running (job by default)

| Parameter | Type | Required | Default | Description |
|---|---|---|---|---|
| `steps` | `Array<Step>` | yes |  |  |
| `preview` | `boolean` |  | false | Return the first rows and columns without saving. |
| `preview_rows` | `number` |  | 50 |  |
| `name` | `string \| null` |  | null |  |

### `data.validate` — Check data rules

Checks rules (expectations) over the whole dataset — not null, unique, ranges, allowed values, patterns, row counts, types, custom conditions — and reports what fails with examples.

Dataset: required · quick

| Parameter | Type | Required | Default | Description |
|---|---|---|---|---|
| `rules` | `Array<Rule>` | yes |  |  |
| `sample_failures` | `number` |  | 5 |  |

## experiments

### `exp.ab_test` — A/B test

Compares variants on a conversion or continuous metric: lift with confidence intervals (absolute and relative), z or Welch tests, Holm adjustment for several variants, CUPED variance reduction using a pre-period covariate, and a sample-ratio-mismatch check.

Dataset: required · quick

| Parameter | Type | Required | Default | Description |
|---|---|---|---|---|
| `variant` | `string` | yes |  |  |
| `metric` | `string` | yes |  |  |
| `control` | `string \| null` |  | null |  |
| `covariate` | `string \| null` |  | null | A pre-experiment measure of the metric, for CUPED variance reduction. |
| `expected_split` | `Array<number> \| null` |  | null | Intended traffic shares, for the sample-ratio check (equal by default). |
| `alpha` | `number` |  | 0.05 |  |
| `kind` | `"auto" \| "conversion" \| "continuous"` |  | "auto" |  |

### `exp.bandit` — Multi-armed bandit allocation

Recommends how to split the next traffic between options from results so far: Thompson sampling (probability each arm is best) or UCB1 scores.

Dataset: not needed · quick

| Parameter | Type | Required | Default | Description |
|---|---|---|---|---|
| `arms` | `Array<Record<string, unknown>>` | yes |  | [{name, successes, trials}] |
| `method` | `"thompson" \| "ucb1"` |  | "thompson" |  |
| `draws` | `number` |  | 100000 |  |

### `exp.sample_size` — A/B test sample size

How many users each variant needs to detect a given lift (with Bonferroni correction for several variants), and how many days that takes at your traffic.

Dataset: not needed · quick

| Parameter | Type | Required | Default | Description |
|---|---|---|---|---|
| `metric` | `"conversion" \| "continuous"` |  | "conversion" |  |
| `baseline` | `number` | yes |  | Baseline conversion rate (0–1), or baseline mean. |
| `mde` | `number` | yes |  | Smallest effect worth detecting, relative (0.05 = 5% lift). |
| `sd` | `number \| null` |  | null | Standard deviation (continuous metrics). |
| `alpha` | `number` |  | 0.05 |  |
| `power` | `number` |  | 0.8 |  |
| `variants` | `number` |  | 2 |  |
| `daily_traffic` | `number \| null` |  | null |  |

### `exp.sequential` — Sequential test boundaries

Plans a group-sequential test you can check several times without inflating false positives: efficacy boundaries from Lan–DeMets alpha spending (O'Brien–Fleming or Pocock), found by seeded simulation, and whether to stop given the z statistics so far.

Dataset: not needed · quick

| Parameter | Type | Required | Default | Description |
|---|---|---|---|---|
| `looks` | `number` |  | 5 | Planned number of analyses (interim + final). |
| `information` | `Array<number> \| null` |  | null | Information fraction at each look (equal by default). |
| `spending` | `"obrien_fleming" \| "pocock"` |  | "obrien_fleming" |  |
| `alpha` | `number` |  | 0.05 |  |
| `observed_z` | `Array<number> \| null` |  | null | Z statistics observed so far, to decide whether to stop. |
| `simulations` | `number` |  | 200000 |  |

### `exp.srm` — Sample ratio mismatch check

Checks whether traffic split between variants as intended (chi-square); a mismatch usually means broken assignment or logging.

Dataset: not needed · quick

| Parameter | Type | Required | Default | Description |
|---|---|---|---|---|
| `observed` | `Array<number>` | yes |  |  |
| `expected_share` | `Array<number> \| null` |  | null |  |

## ml

### `ml.automl` — AutoML (train and compare models)

Trains and tunes many model families (linear, elastic net, k-NN, SVM, naive Bayes, random forest, extra trees, histogram GB, XGBoost, LightGBM, CatBoost, neural net) with Optuna on a time budget, adds a stacked ensemble, and picks a champion by cross-validation with confidence intervals and a significance test against the runner-up. Reports full metrics and curves, calibration, conformal prediction intervals, permutation importance, leakage warnings and fairness, and saves the model.

Dataset: required · long-running (job by default)

| Parameter | Type | Required | Default | Description |
|---|---|---|---|---|
| `target` | `string` | yes |  |  |
| `features` | `Array<string> \| null` |  | null | Leave empty to use every other column (IDs and constants are left out automatically). |
| `task` | `"auto" \| "classification" \| "regression"` |  | "auto" |  |
| `models` | `Array<string> \| null` |  | null | Model families to try (all suitable ones when empty). |
| `metric` | `"auto" \| "roc_auc" \| "f1_macro" \| "accuracy" \| "balanced_accuracy" \| "neg_log_loss" \| "average_precision" \| "r2" \| "neg_root_mean_squared_error" \| "neg_mean_absolute_error"` |  | "auto" |  |
| `time_budget_s` | `number` |  | 120 | Total tuning time across models. |
| `max_trials_per_model` | `number` |  | 25 |  |
| `cv_folds` | `number` |  | 5 |  |
| `cv_repeats` | `number` |  | 1 |  |
| `split` | `"auto" \| "random" \| "time" \| "group"` |  | "auto" |  |
| `time_column` | `string \| null` |  | null |  |
| `group_column` | `string \| null` |  | null |  |
| `test_size` | `number` |  | 0.2 |  |
| `validation_size` | `number` |  | 0.0 | Share of all rows held out as a validation set (0 = none; cross-validation on the training rows still chooses the model). |
| `balanced` | `"auto" \| "on" \| "off"` |  | "auto" |  |
| `calibrate` | `"none" \| "sigmoid" \| "isotonic"` |  | "none" |  |
| `ensemble` | `boolean` |  | true |  |
| `conformal_alpha` | `number` |  | 0.1 | Prediction intervals/sets cover the truth (1 − alpha) of the time. |
| `sensitive_features` | `Array<string> \| null` |  | null | Columns to check fairness across (not used as features unless listed). |
| `positive_class` | `string \| null` |  | null |  |
| `text_columns` | `Array<string> \| null` |  | null | Columns to treat as free text (detected automatically when empty). |
| `text_encoder` | `"tfidf" \| "minilm-en" \| "minilm-multilingual"` |  | "tfidf" | How free-text columns become features: TF-IDF word statistics, or pretrained transformer embeddings (meaning). |
| `interactions` | `boolean` |  | false | Add pairwise products of numeric features (up to 15 of them) for interaction effects. |
| `nested_cv` | `boolean` |  | false | Also estimate the whole tuning procedure's performance with nested cross-validation (slower, unbiased). |
| `cost_false_positive` | `number \| null` |  | null | Binary tasks: cost of a false alarm, to choose the decision threshold. |
| `cost_false_negative` | `number \| null` |  | null | Binary tasks: cost of a missed positive. |
| `refit_full` | `boolean` |  | true | Refit the champion on all rows for deployment after it's been evaluated. |
| `max_rows` | `number` |  | 300000 |  |
| `name` | `string \| null` |  | null | Register the model under this name (versions are numbered). |

### `ml.explain` — Explain a model

Why a model predicts what it does: SHAP importance (global) and per-row reasons (local), partial dependence and ICE curves, and a small decision-tree surrogate with its fidelity.

Dataset: required · long-running (job by default)

| Parameter | Type | Required | Default | Description |
|---|---|---|---|---|
| `model_id` | `string` | yes |  |  |
| `rows` | `Array<number> \| null` |  | null | Row positions to explain individually (the first 5 when empty). |
| `sample` | `number` |  | 500 |  |
| `pdp_features` | `Array<string> \| null` |  | null | Features for partial dependence (top 4 by importance when empty). |
| `surrogate_depth` | `number` |  | 3 |  |

### `ml.fairness` — Fairness audit

Compares a model's accuracy, selection rate, true- and false-positive rates (or error, for regression) across groups, with demographic parity, equalised odds, the disparate-impact ratio and the four-fifths rule.

Dataset: required · quick

| Parameter | Type | Required | Default | Description |
|---|---|---|---|---|
| `model_id` | `string` | yes |  |  |
| `target` | `string` | yes |  |  |
| `sensitive_features` | `Array<string>` | yes |  |  |

### `ml.feature_selection` — Feature selection

Ranks features by mutual information, univariate tests and random-forest importance, runs a Boruta-style test against shuffled 'shadow' copies, flags redundant (highly correlated) pairs, and recommends a set.

Dataset: required · long-running (job by default)

| Parameter | Type | Required | Default | Description |
|---|---|---|---|---|
| `target` | `string` | yes |  |  |
| `features` | `Array<string> \| null` |  | null |  |
| `max_rows` | `number` |  | 100000 |  |
| `shadow_rounds` | `number` |  | 10 |  |
| `redundancy` | `number` |  | 0.9 |  |

### `ml.predict` — Score data with a model (batch)

Scores a whole dataset with a saved model in batches — predictions, class probabilities, and conformal prediction intervals or sets — and saves the scored dataset.

Dataset: required · long-running (job by default)

| Parameter | Type | Required | Default | Description |
|---|---|---|---|---|
| `model_id` | `string` | yes |  |  |
| `keep_columns` | `Array<string> \| null` |  | null | Columns to carry into the output (all when empty). |
| `intervals` | `boolean` |  | true |  |
| `batch_rows` | `number` |  | 100000 |  |
| `name` | `string \| null` |  | null |  |

## mlops

### `mlops.monitor` — Monitor a model

Checks a saved model against new data or its live prediction log: data drift per feature (PSI, KS / chi-square, mean shift, missing values, new categories), prediction drift, and — when outcomes are known — performance decay versus its test metrics, with an overall status and alerts.

Dataset: not needed · quick · not cached

| Parameter | Type | Required | Default | Description |
|---|---|---|---|---|
| `model` | `string` | yes |  | Model id, or name@production / name@staging / name@v3. |
| `source` | `"dataset" \| "prediction_log"` |  | "dataset" |  |
| `target` | `string \| null` |  | null | Column with the true outcome, to measure performance decay. |
| `psi_warning` | `number` |  | 0.1 |  |
| `psi_alert` | `number` |  | 0.25 |  |
| `max_performance_drop` | `number` |  | 0.1 | Relative drop in the primary metric that raises an alert. |
| `max_rows` | `number` |  | 200000 |  |
| `min_rows` | `number` |  | 100 | Fewer rows than this are too few to judge drift reliably. |
| `save` | `boolean` |  | true | Keep the report in the model's monitoring history. |

### `mlops.retrain_if_drift` — Retrain when drift is found

Checks a model against new data (drift and, with outcomes, performance decay) and, when the status reaches the chosen level, retrains it on that data with the same AutoML settings, registers the new version and, if asked, promotes it — to production only when it beats the current model on the new data.

Dataset: required · long-running (job by default) · not cached

| Parameter | Type | Required | Default | Description |
|---|---|---|---|---|
| `model` | `string` | yes |  | The model to watch: id, or name@production / name@latest. |
| `target` | `string \| null` |  | null | Outcome column in the new data (the model's own target when empty). |
| `retrain_when` | `"warning" \| "alert" \| "always"` |  | "alert" | Retrain when drift or decay reaches this level (always = retrain on every run). |
| `psi_warning` | `number` |  | 0.1 |  |
| `psi_alert` | `number` |  | 0.25 |  |
| `max_performance_drop` | `number` |  | 0.1 |  |
| `time_budget_s` | `number` |  | 120 | Tuning time for the retrain. |
| `promote` | `"none" \| "staging" \| "production_if_better"` |  | "staging" | What happens to the new version: nothing, staging, or production when it beats the current model on the new data. |
| `min_rows` | `number` |  | 100 |  |

## optimize

### `opt.linear_program` — Optimise (linear / integer programming)

Finds the best decision under constraints — budgets, capacities, mixes, schedules — with the HiGHS solver: the optimal values, objective, which constraints bind, and shadow prices (what one more unit of each constraint is worth) for continuous problems.

Dataset: not needed · quick

| Parameter | Type | Required | Default | Description |
|---|---|---|---|---|
| `variables` | `Array<string>` | yes |  |  |
| `objective` | `Array<number>` | yes |  |  |
| `sense` | `"minimize" \| "maximize"` |  | "maximize" |  |
| `constraints` | `Array<Constraint>` |  |  |  |
| `lower` | `Array<number \| null> \| null` |  | null |  |
| `upper` | `Array<number \| null> \| null` |  | null |  |
| `integer` | `Array<string> \| null` |  | null | Variables that must be whole numbers. |
| `binary` | `Array<string> \| null` |  | null |  |

### `opt.monte_carlo` — Monte Carlo simulation

Simulates an outcome from uncertain inputs (normal, uniform, triangular, log-normal, beta, Poisson, discrete): its distribution, percentiles, probability of beating a threshold, and which inputs drive it most (tornado).

Dataset: not needed · quick

| Parameter | Type | Required | Default | Description |
|---|---|---|---|---|
| `variables` | `Array<Variable>` | yes |  |  |
| `formula` | `string` | yes |  | e.g. price * volume - fixed_cost |
| `simulations` | `number` |  | 100000 |  |
| `threshold` | `number \| null` |  | null | Report the probability that the result is above this. |

### `opt.scenarios` — What-if scenarios with a model

Changes chosen inputs of a saved model's row across values you list (all combinations of up to three) and shows how the prediction responds.

Dataset: not needed · quick

| Parameter | Type | Required | Default | Description |
|---|---|---|---|---|
| `model_id` | `string` | yes |  |  |
| `base` | `Record<string, unknown>` | yes |  | A starting row: values for the model's features. |
| `vary` | `Record<string, Array<unknown>>` | yes |  | Feature → values to try (up to 3 features, all combinations). |

## stats

### `stats.anova` — ANOVA / ANCOVA

One-, two- and multi-way ANOVA with interactions and covariates (ANCOVA), type I/II/III sums of squares, eta², partial eta² and omega², assumption checks and Tukey post-hoc tests.

Dataset: required · quick

| Parameter | Type | Required | Default | Description |
|---|---|---|---|---|
| `outcome` | `string` | yes |  |  |
| `factors` | `Array<string>` | yes |  |  |
| `covariates` | `Array<string> \| null` |  | null | Numeric covariates (ANCOVA). |
| `interactions` | `boolean` |  | true |  |
| `type` | `1 \| 2 \| 3` |  | 2 |  |
| `posthoc` | `boolean` |  | true |  |
| `alpha` | `number` |  | 0.05 |  |

### `stats.bootstrap` — Bootstrap confidence interval

A seeded bootstrap confidence interval (BCa, percentile or basic) for a mean, median, standard deviation, quantile, trimmed mean, correlation, ratio, or a difference between two groups.

Dataset: required · long-running (job by default)

| Parameter | Type | Required | Default | Description |
|---|---|---|---|---|
| `statistic` | `"mean" \| "median" \| "std" \| "quantile" \| "trimmed_mean" \| "correlation" \| "mean_difference" \| "median_difference" \| "ratio_of_means"` | yes |  |  |
| `column` | `string` | yes |  |  |
| `other` | `string \| null` |  | null | Second column (correlation, ratio) or group column (differences). |
| `quantile` | `number` |  | 0.5 |  |
| `resamples` | `number` |  | 5000 |  |
| `confidence` | `number` |  | 0.95 |  |
| `method` | `"BCa" \| "percentile" \| "basic"` |  | "BCa" |  |
| `max_rows` | `number` |  | 200000 |  |

### `stats.compare` — Compare two variables (auto test)

Chooses and runs the right test for two columns: t-test / Welch / Mann–Whitney, paired t / Wilcoxon, ANOVA / Welch ANOVA / Kruskal–Wallis with post-hoc tests, chi-square / Fisher, or Pearson / Spearman / Kendall correlation — with assumption checks, effect sizes and confidence intervals.

Dataset: required · quick

| Parameter | Type | Required | Default | Description |
|---|---|---|---|---|
| `a` | `string` | yes |  | Outcome (or first) column. |
| `b` | `string` | yes |  | Group (or second) column. |
| `paired` | `boolean` |  | false | True when a and b are two measurements of the same rows. |
| `alpha` | `number` |  | 0.05 |  |
| `alternative` | `"two-sided" \| "less" \| "greater"` |  | "two-sided" |  |
| `force` | `"auto" \| "parametric" \| "nonparametric"` |  | "auto" |  |
| `max_groups` | `number` |  | 30 |  |

### `stats.correlation_matrix` — Correlation matrix with p-values

Pearson, Spearman or Kendall correlations between numeric columns, with p-values adjusted for multiple testing, confidence intervals, and optional partial correlations controlling for other columns.

Dataset: required · quick

| Parameter | Type | Required | Default | Description |
|---|---|---|---|---|
| `columns` | `Array<string> \| null` |  | null |  |
| `method` | `"pearson" \| "spearman" \| "kendall"` |  | "pearson" |  |
| `partial_on` | `Array<string> \| null` |  | null | Control for these columns (partial correlation). |
| `adjust` | `"holm" \| "fdr_bh" \| "bonferroni" \| "none"` |  | "holm" |  |
| `max_rows` | `number` |  | 500000 |  |

### `stats.glm` — Generalised linear model

Linear, logistic, probit, Poisson, negative binomial, gamma, inverse-Gaussian and Tweedie regression, with categorical predictors, interactions, weights, offsets, robust or clustered standard errors, odds/rate ratios, fit statistics and diagnostics (VIF, influence, heteroskedasticity, autocorrelation).

Dataset: required · long-running (job by default)

| Parameter | Type | Required | Default | Description |
|---|---|---|---|---|
| `outcome` | `string` | yes |  |  |
| `predictors` | `Array<string>` | yes |  |  |
| `family` | `"gaussian" \| "binomial" \| "poisson" \| "negative_binomial" \| "gamma" \| "inverse_gaussian" \| "tweedie"` |  | "gaussian" |  |
| `link` | `"default" \| "identity" \| "log" \| "logit" \| "probit" \| "cloglog" \| "inverse" \| "sqrt"` |  | "default" |  |
| `categorical` | `Array<string> \| null` |  | null | Numeric columns to treat as categories. |
| `interactions` | `Array<Array<string>> \| null` |  | null |  |
| `weights` | `string \| null` |  | null |  |
| `offset` | `string \| null` |  | null | A column of log-exposure (for rates). |
| `robust` | `"none" \| "hc3" \| "cluster"` |  | "none" |  |
| `cluster` | `string \| null` |  | null |  |
| `success` | `string \| null` |  | null | For a binomial outcome that isn't 0/1: the value that counts as success. |
| `alpha` | `number` |  | 0.05 |  |

### `stats.mixed` — Mixed-effects model

Linear mixed model with a random intercept (and optional random slopes) per group — for repeated measures, students within schools, etc. — with the intraclass correlation.

Dataset: required · long-running (job by default)

| Parameter | Type | Required | Default | Description |
|---|---|---|---|---|
| `outcome` | `string` | yes |  |  |
| `predictors` | `Array<string>` |  |  |  |
| `group` | `string` | yes |  | The grouping (random effect) column, e.g. school or patient. |
| `random_slopes` | `Array<string> \| null` |  | null |  |
| `categorical` | `Array<string> \| null` |  | null |  |
| `reml` | `boolean` |  | true |  |
| `alpha` | `number` |  | 0.05 |  |

### `stats.multiple_testing` — Adjust p-values for multiple tests

Bonferroni, Holm, Hochberg, Šidák, Hommel, Benjamini–Hochberg and Benjamini–Yekutieli corrections.

Dataset: not needed · quick

| Parameter | Type | Required | Default | Description |
|---|---|---|---|---|
| `p_values` | `Array<number>` | yes |  |  |
| `labels` | `Array<string> \| null` |  | null |  |
| `method` | `"bonferroni" \| "holm" \| "hochberg" \| "sidak" \| "fdr_bh" \| "fdr_by" \| "hommel"` |  | "holm" |  |
| `alpha` | `number` |  | 0.05 |  |

### `stats.nonparametric` — Nonparametric tests

Mann–Whitney, Wilcoxon, Kruskal–Wallis, Friedman, sign test, Kolmogorov–Smirnov, Anderson–Darling k-sample, Mood's median and a seeded permutation test.

Dataset: required · quick

| Parameter | Type | Required | Default | Description |
|---|---|---|---|---|
| `test` | `"mann_whitney" \| "wilcoxon" \| "kruskal" \| "friedman" \| "sign" \| "ks_2samp" \| "anderson_ksamp" \| "mood_median" \| "permutation"` | yes |  |  |
| `columns` | `Array<string>` | yes |  | Value column(s); for wilcoxon/friedman/sign: the repeated measures. |
| `group` | `string \| null` |  | null | Group column, for tests that compare groups of one value column. |
| `alternative` | `"two-sided" \| "less" \| "greater"` |  | "two-sided" |  |
| `permutations` | `number` |  | 9999 |  |

### `stats.normality` — Normality tests

Shapiro–Wilk, D'Agostino–Pearson, Anderson–Darling and Jarque–Bera tests, skewness and kurtosis, and Q–Q plot points.

Dataset: required · quick

| Parameter | Type | Required | Default | Description |
|---|---|---|---|---|
| `column` | `string` | yes |  |  |
| `max_rows` | `number` |  | 200000 |  |

### `stats.power` — Power and sample size

Solves for whichever of sample size, power or detectable effect size is left blank, for t-tests, proportions, ANOVA, chi-square and correlation, with a power curve.

Dataset: not needed · quick

| Parameter | Type | Required | Default | Description |
|---|---|---|---|---|
| `test` | `"t_two_sample" \| "t_paired" \| "t_one_sample" \| "proportions" \| "anova" \| "chi_square" \| "correlation"` | yes |  |  |
| `effect_size` | `number \| null` |  | null | Cohen's d / h / f / w, or r for correlation. |
| `n` | `number \| null` |  | null | Per group (or total for chi-square, correlation and one-sample). |
| `power` | `number \| null` |  | null |  |
| `alpha` | `number` |  | 0.05 |  |
| `groups` | `number` |  | 3 |  |
| `df` | `number` |  | 1 |  |
| `ratio` | `number` |  | 1.0 |  |
| `alternative` | `"two-sided" \| "larger" \| "smaller"` |  | "two-sided" |  |

### `stats.robust_regression` — Robust and quantile regression

Regression that resists outliers (Huber or Tukey biweight M-estimation) or models chosen quantiles (e.g. median, 10th and 90th percentiles) instead of the mean.

Dataset: required · quick

| Parameter | Type | Required | Default | Description |
|---|---|---|---|---|
| `outcome` | `string` | yes |  |  |
| `predictors` | `Array<string>` | yes |  |  |
| `method` | `"huber" \| "tukey_biweight" \| "quantile"` |  | "huber" |  |
| `quantiles` | `Array<number>` |  |  |  |
| `categorical` | `Array<string> \| null` |  | null |  |
| `alpha` | `number` |  | 0.05 |  |

## survival

### `survival.kaplan_meier` — Survival curves (Kaplan–Meier)

Kaplan–Meier survival curves with confidence bands, median survival, survival at chosen times, numbers at risk, and a log-rank test between groups.

Dataset: required · quick

| Parameter | Type | Required | Default | Description |
|---|---|---|---|---|
| `duration` | `string` | yes |  |  |
| `event` | `string` | yes |  | 1 (or yes/true) when the event happened, 0 when the row was censored. |
| `group` | `string \| null` |  | null |  |
| `at_times` | `Array<number> \| null` |  | null |  |
| `points` | `number` |  | 200 |  |

### `survival.regression` — Survival regression (Cox, AFT)

Cox proportional hazards (hazard ratios, concordance and a proportional-hazards check) or accelerated failure time models (Weibull, log-normal, log-logistic) with acceleration factors.

Dataset: required · long-running (job by default)

| Parameter | Type | Required | Default | Description |
|---|---|---|---|---|
| `duration` | `string` | yes |  |  |
| `event` | `string` | yes |  |  |
| `covariates` | `Array<string>` | yes |  |  |
| `strata` | `Array<string> \| null` |  | null |  |
| `penalizer` | `number` |  | 0.0 |  |
| `model` | `"cox" \| "weibull_aft" \| "lognormal_aft" \| "loglogistic_aft"` |  | "cox" |  |
| `alpha` | `number` |  | 0.05 |  |

## text

### `text.analyze` — Analyse text

For a text column: sentiment per row (VADER) and overall, keywords (TF-IDF), topics (NMF) with their top words and shares, text length statistics, duplicates, and comparisons by group.

Dataset: required · long-running (job by default)

| Parameter | Type | Required | Default | Description |
|---|---|---|---|---|
| `column` | `string` | yes |  |  |
| `group` | `string \| null` |  | null |  |
| `topics` | `number` |  | 6 |  |
| `keywords` | `number` |  | 20 |  |
| `max_rows` | `number` |  | 100000 |  |
| `save` | `boolean` |  | false | Save a dataset with a sentiment score and topic per row. |

### `text.embed` — Text embeddings (transformer)

Turns each text into a meaning vector with a pretrained sentence-transformer, for semantic maps, search, clustering and as model features; optionally saves the vectors as a dataset.

Dataset: required · long-running (job by default)

| Parameter | Type | Required | Default | Description |
|---|---|---|---|---|
| `column` | `string` | yes |  |  |
| `model` | `"minilm-en" \| "minilm-multilingual"` |  | "minilm-en" |  |
| `max_rows` | `number` |  | 50000 |  |
| `map_points` | `number` |  | 2000 | Points for a 2-D semantic map (0 = none). |
| `color_by` | `string \| null` |  | null |  |
| `save` | `boolean` |  | false | Save a dataset with the text and its embedding vector columns (emb_0 …). |

### `text.entities` — Find people, organisations and places (NER)

Extracts named entities — people, organisations, locations and other names — from text with a pretrained BERT model, with the most mentioned ones per type and the exact spans.

Dataset: required · long-running (job by default)

| Parameter | Type | Required | Default | Description |
|---|---|---|---|---|
| `column` | `string` | yes |  |  |
| `types` | `Array<"PER" \| "ORG" \| "LOC" \| "MISC"> \| null` |  | null |  |
| `min_score` | `number` |  | 0.6 |  |
| `top` | `number` |  | 20 |  |
| `max_rows` | `number` |  | 20000 |  |
| `save` | `boolean` |  | false | Save a dataset with the entities found in each row. |

### `text.semantic_search` — Semantic search and duplicates

Finds the texts closest in meaning to a query (not just shared words), or pairs of texts that say the same thing, using transformer embeddings and cosine similarity.

Dataset: required · long-running (job by default)

| Parameter | Type | Required | Default | Description |
|---|---|---|---|---|
| `column` | `string` | yes |  |  |
| `query` | `string \| Array<string> \| null` |  | null | One or more questions or phrases; leave empty to find near-duplicates instead. |
| `model` | `"minilm-en" \| "minilm-multilingual"` |  | "minilm-en" |  |
| `top` | `number` |  | 10 |  |
| `duplicate_threshold` | `number` |  | 0.9 |  |
| `max_rows` | `number` |  | 100000 |  |
| `show_columns` | `Array<string> \| null` |  | null | Other columns to return with each match. |

### `text.semantic_topics` — Topics by meaning (embeddings + clustering)

Discovers topics from what texts mean rather than shared words: transformer embeddings, reduced with UMAP and clustered with HDBSCAN, each topic described by its distinctive words (class-based TF-IDF), size and most typical texts.

Dataset: required · long-running (job by default)

| Parameter | Type | Required | Default | Description |
|---|---|---|---|---|
| `column` | `string` | yes |  |  |
| `model` | `"minilm-en" \| "minilm-multilingual"` |  | "minilm-en" |  |
| `min_topic_size` | `number` |  | 10 |  |
| `n_topics` | `number \| null` |  | null | Ask for exactly this many topics (k-means on the embeddings) instead of discovering them. |
| `keywords` | `number` |  | 8 |  |
| `max_rows` | `number` |  | 50000 |  |
| `save` | `boolean` |  | false |  |

### `text.sentiment` — Sentiment (transformer)

Classifies each text as negative, neutral or positive with a pretrained RoBERTa model (more accurate than word lists on real reviews and messages), with probabilities, overall shares, the strongest examples and a comparison by group.

Dataset: required · long-running (job by default)

| Parameter | Type | Required | Default | Description |
|---|---|---|---|---|
| `column` | `string` | yes |  |  |
| `group` | `string \| null` |  | null |  |
| `max_rows` | `number` |  | 50000 |  |
| `save` | `boolean` |  | false | Save a dataset with the label and probabilities per row. |

### `text.similarity` — Similar and duplicate text

Finds the rows whose text is most similar to a query, or pairs of near-duplicate texts, by TF-IDF cosine similarity.

Dataset: required · quick

| Parameter | Type | Required | Default | Description |
|---|---|---|---|---|
| `column` | `string` | yes |  |  |
| `query` | `string \| null` |  | null | Find rows most similar to this text; leave empty to find near-duplicates. |
| `top` | `number` |  | 10 |  |
| `duplicate_threshold` | `number` |  | 0.9 |  |
| `max_rows` | `number` |  | 50000 |  |

### `text.zero_shot` — Label texts with your own categories (zero-shot)

Sorts texts into categories you name, with no training data, using a natural-language-inference transformer: the best label (or several) per text with scores, the share of each category and examples.

Dataset: required · long-running (job by default)

| Parameter | Type | Required | Default | Description |
|---|---|---|---|---|
| `column` | `string` | yes |  |  |
| `labels` | `Array<string>` | yes |  | Your categories, in plain words, e.g. [shipping, price, product quality]. |
| `multi_label` | `boolean` |  | false | True when a text can belong to several categories at once. |
| `hypothesis_template` | `string` |  | "This text is about {}." |  |
| `threshold` | `number` |  | 0.5 | With multi_label, the score above which a label applies. |
| `max_rows` | `number` |  | 5000 |  |
| `save` | `boolean` |  | false |  |

## timeseries

### `ts.anomalies` — Find anomalies in a series

Flags unusual points after removing trend and seasonality (STL, refitted with anomalies masked), using a robust z-score of what's left, so normal peaks aren't flagged; gives the expected value and normal band for every point.

Dataset: required · quick

| Parameter | Type | Required | Default | Description |
|---|---|---|---|---|
| `date` | `string` | yes |  |  |
| `value` | `string` | yes |  |  |
| `freq` | `string` |  | "auto" |  |
| `agg` | `"sum" \| "mean" \| "last" \| "max" \| "min"` |  | "sum" |  |
| `threshold` | `number` |  | 4.0 | Robust z-score of the remainder above which a point is an anomaly. |
| `season_length` | `number \| null` |  | null |  |

### `ts.changepoints` — Find change points

Finds where a series' level shifts (exact PELT search with a BIC-style penalty), with the mean of each segment and a test of each shift.

Dataset: required · quick

| Parameter | Type | Required | Default | Description |
|---|---|---|---|---|
| `date` | `string` | yes |  |  |
| `value` | `string` | yes |  |  |
| `freq` | `string` |  | "auto" |  |
| `agg` | `"sum" \| "mean" \| "last" \| "max" \| "min"` |  | "sum" |  |
| `penalty` | `number \| null` |  | null | Higher = fewer change points (BIC-style by default). |
| `min_segment` | `number` |  | 3 |  |

### `ts.decompose` — Decompose a series

Splits a series into trend, seasonality and remainder (STL), measures the strength of each, and reports autocorrelation (ACF/PACF) and stationarity tests (ADF, KPSS).

Dataset: required · quick

| Parameter | Type | Required | Default | Description |
|---|---|---|---|---|
| `date` | `string` | yes |  |  |
| `value` | `string` | yes |  |  |
| `freq` | `string` |  | "auto" |  |
| `agg` | `"sum" \| "mean" \| "last" \| "max" \| "min"` |  | "sum" |  |
| `season_length` | `number \| null` |  | null |  |
| `lags` | `number` |  | 36 |  |

### `ts.forecast` — Forecast

Forecasts a series with naive, seasonal naive, drift, ETS (auto by AICc), auto-ARIMA/SARIMA, Theta and a LightGBM lag model, compares them with rolling-origin backtests (MASE, sMAPE, RMSE), adds an ensemble of the best, and gives prediction intervals calibrated on backtest errors.

Dataset: required · long-running (job by default)

| Parameter | Type | Required | Default | Description |
|---|---|---|---|---|
| `date` | `string` | yes |  |  |
| `value` | `string` | yes |  |  |
| `horizon` | `number` |  | 12 |  |
| `freq` | `string` |  | "auto" | auto, h, D, B, W, MS, QS or YS. |
| `agg` | `"sum" \| "mean" \| "last" \| "max" \| "min"` |  | "sum" |  |
| `models` | `Array<"naive" \| "seasonal_naive" \| "drift" \| "ets" \| "arima" \| "theta" \| "ml_lags"> \| null` |  | null |  |
| `season_length` | `number \| null` |  | null |  |
| `backtest_windows` | `number` |  | 3 |  |
| `level` | `number` |  | 0.9 | Prediction-interval coverage. |
| `ensemble` | `boolean` |  | true |  |

### `ts.hierarchical` — Hierarchical forecast

Forecasts every level of a hierarchy (total, e.g. region, store) and reconciles them so the pieces add up to the totals (OLS reconciliation), with the coherence check.

Dataset: required · long-running (job by default)

| Parameter | Type | Required | Default | Description |
|---|---|---|---|---|
| `date` | `string` | yes |  |  |
| `value` | `string` | yes |  |  |
| `levels` | `Array<string>` | yes |  | Hierarchy columns from top to bottom, e.g. [region, store]. |
| `horizon` | `number` |  | 12 |  |
| `freq` | `string` |  | "auto" |  |
| `agg` | `"sum" \| "mean"` |  | "sum" |  |
| `max_series` | `number` |  | 300 |  |

## unsupervised

### `unsup.association_rules` — Market basket (association rules)

Finds items bought together (Apriori): frequent itemsets and rules 'if A then B' with support, confidence, lift and conviction.

Dataset: required · long-running (job by default)

| Parameter | Type | Required | Default | Description |
|---|---|---|---|---|
| `transaction` | `string \| null` |  | null | Transaction/basket ID column (long format, with item). |
| `item` | `string \| null` |  | null |  |
| `item_columns` | `Array<string> \| null` |  | null | Or: one 0/1 column per item (wide format). |
| `min_support` | `number` |  | 0.01 |  |
| `min_confidence` | `number` |  | 0.3 |  |
| `max_items` | `number` |  | 3 |  |
| `max_rules` | `number` |  | 200 |  |

### `unsup.cluster` — Find segments (clustering)

Segments rows with k-means (k chosen by silhouette), Gaussian mixtures (by BIC), HDBSCAN, agglomerative (Ward) or DBSCAN, reports quality (silhouette, Davies–Bouldin, Calinski–Harabasz), profiles each cluster by what sets it apart, and can save the labels.

Dataset: required · long-running (job by default)

| Parameter | Type | Required | Default | Description |
|---|---|---|---|---|
| `columns` | `Array<string> \| null` |  | null |  |
| `method` | `"kmeans" \| "gmm" \| "hdbscan" \| "agglomerative" \| "dbscan"` |  | "kmeans" |  |
| `k` | `number \| null` |  | null | Number of clusters (chosen automatically when empty). |
| `k_range` | `Array<number>` |  |  |  |
| `min_cluster_size` | `number` |  | 15 |  |
| `eps` | `number` |  | 0.8 |  |
| `max_rows` | `number` |  | 200000 |  |
| `save_labels` | `boolean` |  | false |  |

### `unsup.embed` — Map the data (PCA, UMAP, t-SNE)

Projects many columns into 2+ dimensions: PCA (with explained variance and loadings), UMAP or t-SNE, with points to plot, optionally coloured by a column.

Dataset: required · long-running (job by default)

| Parameter | Type | Required | Default | Description |
|---|---|---|---|---|
| `columns` | `Array<string> \| null` |  | null |  |
| `method` | `"pca" \| "umap" \| "tsne"` |  | "pca" |  |
| `dimensions` | `number` |  | 2 |  |
| `color_by` | `string \| null` |  | null |  |
| `max_rows` | `number` |  | 50000 |  |
| `plot_points` | `number` |  | 3000 |  |
