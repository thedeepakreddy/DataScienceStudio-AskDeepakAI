# Data Science Studio — Phase 0 audit and implementation proposal

This is the first deliverable required by the product plan ("Data Science Studio —
Product redesign and feature implementation plan", plus its Agentic Assistant
Revision 1). It maps the plan to the code as it actually is, marks what is real,
partial, fake or missing, and sets the order of work.

Audited: `main` at `fcfa2ba` (17 Nov 2026). The README predates most of this code
and is not used as evidence here; everything below was checked in the source.

## Decisions agreed with the product owner

| Topic | Decision |
|---|---|
| Hosting | Stay on Render's free tier. |
| Navigation | At most 7 stages with plain, easy names (see below). |
| Fake content | Remove all simulated, canned or invented content. |
| Look and feel | Keep the current UI design. |
| Compute | Simple work may stay in the browser; anything that needs a real engine runs on the backend. Everything must be real. |

### Navigation (7 stages)

**Import · Clean · Explore · Statistics · Model · Dashboard · Report**

The plan's six studios map onto these without inventing new jargon:

| Plan studio | Stage(s) here | What lives there |
|---|---|---|
| Data | Import, Clean | Upload/connect, profile, quality rules, cleaning, transforms, dataset versions |
| Explore | Explore, Dashboard | EDA, SQL, metrics (Explore); saved dashboards and KPIs (Dashboard) |
| Statistics | **Statistics** (new) | Hypothesis tests, A/B tests, regression, power analysis |
| Models | Model | AutoML, model comparison, tuning, clustering, forecasting |
| Deploy | Model → "Deploy & monitor" section | Validation, registry, predictions, drift, rollback |
| Research | Report | History, reports, exports, notebooks, workflows |

Deploy starts as a section of Model because it is small today; it can become its
own stage later without breaking the 7-stage limit only if Dashboard and Explore
merge. Statistics becomes a stage because it is a distinct job ("is this
difference real?") that is currently hidden in Expert-only Explore tabs.

### Where data is stored (free Render)

Render's free web services lose their disk on every restart and sleep when idle,
so the server cannot be the place where work is kept. The plan's persistence is
delivered in the **browser's IndexedDB** instead:

- Workspaces, dataset versions (with parent/child lineage), run history,
  saved dashboards, reports and trained-model files are stored on the user's
  device. Nothing is lost on server restarts; nothing personal is held server-side.
- The Node server and the Python ML service stay **stateless**: every request
  carries the data or a reference it needs.
- Trained models: after training, the model file (`joblib`) is downloaded into
  IndexedDB. Predictions send it back if the ML service has restarted.
- Limits, stated honestly in the app: data lives in that browser only (no sync
  across devices), and browser storage quotas apply. Export/import of a whole
  workspace covers backup and moving devices.

If the project later moves to paid hosting, the same entities can move to a
server database without changing the UI.

### Where computation runs

| Runs in the browser (fast, small, deterministic) | Runs on the backend (Python ML service) |
|---|---|
| CSV, Excel (.xlsx), JSON and Parquet parsing, schema/type detection | — |
| Counts, missing values, duplicates, basic profile | Deep EDA (distributions, skew, IQR outliers) on full data |
| Cleaning transforms: fill, drop, filter, add/remove columns, rename | Statistical tests, effect sizes, confidence intervals |
| Group-by aggregations, KPI formulas, chart data | Regression, model training, cross-validation, tuning |
| SQL over the in-browser dataset (AlaSQL, read-only `SELECT`) | Forecasting, clustering on large data, drift tests |

Rule: **one implementation per operation**. If an operation exists on the
backend, the browser does not keep a second, differing copy. Browser operations
get unit tests like backend ones.

## Baseline: checks run on `fcfa2ba`

| Command | Result |
|---|---|
| `npm run lint` (TypeScript) | Pass |
| `npm run lint:eslint` | 89 problems (25 errors, 64 warnings); informational in CI |
| `npm run build` | Pass |
| `pytest mlops_service/tests` | 42 passed |
| `ruff check mlops_service` | Pass |
| Frontend / Node server tests | **None exist** |

## Feature inventory

Status: **Real** = works and computes from the data. **Partial** = real but
incomplete or untested. **Fake** = simulated, canned or misleading. **Missing**
= not built.

### Import (plan: Data)

| Feature | Status | Where |
|---|---|---|
| CSV upload, parsing, type detection | Real (browser), untested | `src/utils/csvParser.ts`, `DataUploader.tsx` |
| Sample datasets | Real | `csvParser.ts` |
| PostgreSQL connection | Partial — loads one table; "scheduled sync" is not real | `server.ts` `/api/db-connections`, `PipelineBuilder.tsx` |
| Snowflake connection | **Fake** — reports success without connecting | same |
| Excel / JSON / Parquet | Missing | — |
| Dataset catalogue, versions, lineage | Missing — data lives in React state only | `App.tsx` |

### Clean (plan: Data)

| Feature | Status | Where |
|---|---|---|
| Fill missing (mean/median/zero/mode), drop/add columns and rows | Real (browser), untested | `DataCleaning.tsx`, `utils/cleaningOperations.ts` |
| Group-by, feature engineering transforms | Real (browser), untested | `DataCleaning.tsx` |
| Quality audit | Partial — real counts; AI writes the fix text (template fallback is data-derived) | `DeepQualityAudit.tsx`, `/api/deep-quality-audit` |
| Undo/history, preview before commit, versions | Missing (only "Reset to original") | — |
| Quality rules, standardisation, joins, pivots | Missing | — |

### Explore (plan: Explore)

| Feature | Status | Where |
|---|---|---|
| Overview, summary stats, data quality views | Real (browser) | `EDAReport.tsx`, `utils/edaEngine.ts` |
| Deep analysis (pandas, full data) | Real (backend), tested | `/api/eda` → ML `/eda` |
| Outliers, correlation, distributions, categories | Real (browser) | `EDAReport.tsx` |
| SQL assistant | Partial — AI writes SQL, run in browser | `SQLAssistant.tsx`, `/api/sql-assistant` |
| AI advisory | Partial — AI text; offline fallback is **fake** (canned insights) | `/api/analyze-dataset`, `App.tsx` |

### Statistics (new stage; currently Expert tabs in Explore)

| Feature | Status | Where |
|---|---|---|
| Pearson, Welch t-test, one-way ANOVA, chi-squared | Real (SciPy), tested | ML `/hypothesis-test`, `HypothesisLab.tsx` |
| AI-generated hypotheses | Partial — AI proposes, backend tests | `/api/hypothesis-lab/*` |
| A/B test calculator | Partial — p-value uses a rough approximation; **"MDE 2.5%" is hard-coded** | `ABTestInterpreter.tsx` |
| Effect sizes, CIs, non-parametric tests, corrections, regression, power | Missing | — |

### Model (plan: Models)

| Feature | Status | Where |
|---|---|---|
| Train/compare 5 algorithms, CV, test metrics, confusion matrix | Real (scikit-learn/XGBoost), tested | ML `/train`, `MLPipeline.tsx` |
| Feature importance, SHAP (when installed) | Real | ML `/train` |
| Leakage check | Partial — heuristic in browser | `utils/mlEngine.ts` |
| Clustering, PCA | Real (browser), random initialisation not seeded | `utils/mlEngine.ts` |
| AI agent (retrain, drop feature, multicollinearity) | Real tool calls to backend | `AgentAnalysis.tsx`, ML `/agent/*` |
| Tuning, forecasting, experiment records | Missing | — |

### Deploy & monitor (plan: Deploy)

| Feature | Status | Where |
|---|---|---|
| Model download (`.joblib`) | Real — but models live in ML-service memory (max 25, lost on restart) | ML `/download` |
| Predictions endpoint | Real, not exposed in the UI | ML `/predict` |
| "1-Click Deploy" | **Fake label** — trains a model, then says "Live Deployment Online" | `MLOpsDashboard.tsx` |
| Drift (KS test) | Real — but compares two halves of the same dataset | ML `/drift-metrics` |
| Registry, validation gates, rollback, model cards | Missing | — |

### Dashboard (plan: Explore)

| Feature | Status | Where |
|---|---|---|
| KPI cards, bar/histogram/correlation, data table, filters | Real (browser) | `IntelligentDashboardLayer.tsx`, `Smart*.tsx` |
| AI layout + insights banner | Partial — AI choice; fallback is data-derived | `/api/dashboard/*` |
| World map | **Fake when no location column** — invents countries and coordinates | `StakeholderDashboard.tsx` |
| "Python sandbox" visuals (ROC curve, imputation variance, Seaborn) | **Fake** — static drawings with made-up values | `StakeholderDashboard.tsx` |
| Python script export | Real template code | `StakeholderDashboard.tsx` |
| Save/reopen dashboards, KPI library | Missing | — |

### Report (plan: Research)

| Feature | Status | Where |
|---|---|---|
| On-screen report: data quality, model results | Real | `ReportsHub.tsx` |
| On-screen "Risks and recommendations" | **Fake** — same text for every dataset | `ReportsHub.tsx` |
| PDF export | **Mostly fake** — invented "security"/"certification" signatures, fixed timestamp, "APPROVED" stamp, canned risks and recommendations | `ReportsHub.tsx` |
| AI executive summary PDF, ETL script export | Partial — AI-written text/code | `ExecutivePDFReport.tsx`, `ETLPipelineExport.tsx` |
| History, notebooks, workflows, reproducibility package | Missing | — |

### AI assistant (Agentic Revision 1)

| Feature | Status | Where |
|---|---|---|
| Live timeline (thinking → actions → writing) | Partial — first version shipped | `AssistiveTouchBot.tsx` |
| Actions on data | Partial — preset actions are real; **SQL/custom requests run AI-written JavaScript on the data**, which the plan forbids | `EXECUTE_DATASET_JS` |
| Offline fallback | Rule-based parser; no invented numbers | `server.ts` chat fallback |
| Typed tool registry, confirmations, completion report, cancel | Missing | — |
| Visitor's own Gemini key, AI status | Real | `/api/ai/*`, `AiKeySheet.tsx` |

### Platform

| Feature | Status |
|---|---|
| Background jobs for slow requests (survive the 60-second Safari limit) | Real, in-memory (lost on restart) |
| ML engine wake/keep-warm | Real |
| Workspace, dataset versioning, artifact store, operation registry, provenance | Missing |
| Frontend/server tests | Missing |

## Fake content removed in this change

1. Report "Risks and recommendations" (screen and PDF): replaced with findings
   computed from the dataset and model results.
2. PDF "security brief", "verification signature", "certified compliant",
   fixed timestamp and "APPROVED" stamp: removed; real generation time shown.
3. Canned AI-advisory fallbacks (e.g. "Month-to-month customers have 4x the
   attrition risk", "variables are distributed normally"): replaced with a
   summary computed from the column statistics, labelled as not AI.
4. Dashboard world map: no longer invents locations; it only shows data that
   has a real country column.
5. Dashboard "Python sandbox" static charts (ROC, imputation variance,
   Seaborn): removed.
6. A/B test: exact normal distribution instead of a rough approximation; real
   minimum detectable effect from the sample sizes (was a fixed "2.5%").
7. "1-Click Deploy … Live Deployment Online": relabelled to what it does
   (trains a model the app can predict with); real deployment comes in Phase 6.
8. Snowflake option that pretended to connect: removed. PostgreSQL "sync
   schedule" that never ran: removed.

## Roadmap

Each phase ships as complete, tested workflows (plan §12). Estimates are in
pull requests of about the size of the recent ones.

| Phase | Scope | Exit condition | Size |
|---|---|---|---|
| 0. Audit | This document; fake content removed | Inventory agreed | 1 PR (this) |
| 1. Foundation | IndexedDB workspace store, dataset catalogue + immutable versions + lineage, run history with provenance, operation registry, job centre UI, frontend test setup (Vitest) | Upload once, reuse across stages, every change is a version, reload keeps work | 3–4 PRs |
| 2. Import & Clean | Excel/JSON/Parquet, preview-before-commit, undo/history, quality rules, standardisation, joins, pivots | Clean dataset version with full lineage | 3 PRs |
| 3. Explore & Dashboard | Safe SQL editor (read-only, limits, history), KPI library with formulas, save/reopen dashboards, cross-filtering | Query → dashboard → save → reopen works | 2–3 PRs |
| 4. Statistics stage | Move tests into the new stage; effect sizes, CIs, assumption checks, non-parametric tests, corrections, regression, power analysis; reference tests | Reproducible tests with assumptions shown | 3 PRs |
| 5. Model | Seeded runs, saved experiments, model leaderboard history, tuning, leakage-safe splits, baseline forecasting with backtesting | Reproducible comparison from a saved config | 3 PRs |
| 6. Deploy & monitor | Model registry in IndexedDB, validation gate, prediction UI with input checks, drift vs. training baseline, rollback, model cards | Registered model predicted, monitored, rolled back | 2–3 PRs |
| 7. Report | History browser, report from saved results with provenance, notebook export, reproducibility package, workflows | Saved workflow reruns into a provenance-backed report | 3 PRs |
| 8. Agentic assistant | Typed tool registry over the same operations, plan/confirm/run/verify loop, completion report, cancel, AI-off parity | Multi-step chat task end to end with a truthful report | 3 PRs |

**Phase 1 status: done.**
- IndexedDB store: dataset versions with parent links and the operation that made each one, run history with the version each run used, session restore on reload.
- History sheet: switch versions, export/import the whole workspace as one file, clear saved work.
- Trained-model files are copied into the browser after training (last 10 kept), so they can still be downloaded after the ML service restarts.
- Operation registry (`src/operations/registry.ts`): every data change (remove/rename columns, fill missing, add column/row, delete/filter rows, remove duplicates, calculated columns, one-hot) is one pure, tested function used by both the Clean step and the assistant. Fixed on the way: median fill used the wrong middle value, min–max scaling assumed a max of 100, and uncomputable values became 0 instead of empty.
- Jobs panel: every long request is listed with its elapsed time and can be stopped.
- Vitest: 28 tests.

**Phase 2 status: done.**
- Import reads CSV/TSV (comma, semicolon or tab detected), Excel .xlsx (with a sheet picker), JSON / JSON Lines (nested objects flattened) and Parquet, all in the browser; up to 100 MB / 200,000 rows, with a note when rows are dropped.
- Clean → More tools, each with a preview (summary, before/after size, first rows) before applying: tidy text, change type (understands "$1,200", "(300)", "1.234,5"), replace values, filter rows, remove duplicates, join or append a second file, group-and-summarise, pivot.
- Quality rules (not empty, unique, range, allowed values, pattern), saved per dataset, re-checked after every change, with "remove the rows that break it".
- Undo steps back to the previous version; versions are labelled with the operation's own description.
- Vitest: 44 tests.

**Phase 3 status: done.**
- SQL editor in Explore (Expert): write SQL or have AI write it; every query passes a read-only check (one SELECT over `dataset`; no INTO, file/URL functions, writes, `->`, backticks or parameters) and runs in a fresh in-browser database. Shows the first 1,000 rows with the true total, keeps recent queries in History, and can make a result the working data (as a new version). Previously AI-written SQL ran unchecked.
- Dashboard: click a bar or pie slice to filter every chart; filters in effect are shown as removable chips with the row count.
- KPI formulas (e.g. `SUM(revenue) / COUNT()`), parsed by a small dedicated parser (no code execution), computed on the filtered rows.
- Save, reopen, update and delete named dashboards per dataset (charts, layout, filters, KPIs); the latest one reopens automatically instead of asking AI again.
- Fixed: pie chart dropped every category after the 8th, so its percentages were wrong (now an "Other" slice); built-in insights now follow the filters, and AI insights say when they were written for a different number of rows.
- Vitest: 61 tests.

**Phase 4 status: done.**
- Statistics → Compare & relate: the test is chosen from the column types (Welch’s t-test, Welch’s ANOVA with Tukey HSD post-hoc, Pearson correlation, paired t-test, chi-squared), each with an effect size (Hedges’ g, η²/ω², r, dz, Cramér’s V), a confidence interval, assumption checks (Shapiro–Wilk, Levene, expected counts) and the matching non-parametric test (Mann–Whitney, Kruskal–Wallis, Spearman, Wilcoxon, Fisher’s exact), recommended when an assumption fails. One-sided tests and 0.01/0.05/0.10 levels.
- Multiple-test correction (Holm, Bonferroni, Benjamini–Hochberg) across the tests run in a visit.
- Regression: linear (OLS) and logistic (maximum likelihood) with coefficients, CIs, p-values, odds ratios, R² / pseudo-R², model tests and collinearity detection.
- Sample size and power for two-group, paired, ANOVA, correlation and two-proportion designs.
- Reference tests (`mlops_service/tests/test_stats_engine.py`): Cohen’s sample-size tables, SciPy, scikit-learn and pingouin’s Welch ANOVA. Python: 60 tests; Vitest: 65 tests.

**Phase 5 status: done.**
- Every training run is seeded (shown with the results; same settings give identical scores — verified by re-running).
- Leakage-safe evaluation: test on the most recent rows (cross-validation only trains on the past) or on whole unseen groups (e.g. customers); the split column is never used as a feature. Preprocessing is fitted on training rows only, as before.
- Leakage warnings when a column contains the target’s name or predicts it almost perfectly (checked on training rows).
- Hyperparameter tuning: randomized search with cross-validation on the training rows, showing the best settings and every trial.
- Experiments: every model trained on the dataset with its score, cross-validation, split, seed and data version; re-run any of them exactly, or open the data version it used.
- Forecasting: naive, seasonal naive, moving average, drift, linear trend, Holt and Holt-Winters, each scored by rolling-origin backtesting; the best forecasts, with 80%/95% ranges from its real backtest errors.
- Python: 75 tests (including a hand-calculated backtest error and same-seed reproducibility).

The plan's advanced items (MANOVA, causal inference, Bayesian analysis, UMAP,
deep learning, canary deployment, scheduled connectors) are deferred until the
foundation is stable, as the plan itself recommends.

## Known risks on free hosting

- **Cold starts**: the ML service sleeps after 15 minutes; first requests take up
  to a minute (the wake button and background jobs handle this).
- **Memory**: free instances have little RAM; large datasets or "train all 5
  models" can restart the ML service. Training on large data should default to
  one algorithm or a sample, disclosed in the UI.
- **Browser storage**: quotas vary by browser; the app must show usage and offer
  export before data is at risk.
