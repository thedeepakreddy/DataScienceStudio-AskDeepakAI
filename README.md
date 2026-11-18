# AskDeepakAI · Data Science Studio

[![CI](https://github.com/thedeepakreddy/DataScienceStudio-AskDeepakAI/actions/workflows/ci.yml/badge.svg)](https://github.com/thedeepakreddy/DataScienceStudio-AskDeepakAI/actions/workflows/ci.yml)

> An end-to-end data science studio with a team of AI agents that works right on your page. Import, clean, explore, test, model, dashboard and report. Every number comes from a real engine, never from an AI's imagination.

---

## Contents

- [At a glance](#at-a-glance)
- [Why it exists](#why-it-exists)
- [Your agent team](#your-agent-team)
- [The seven steps](#the-seven-steps)
- [Your work is saved, versioned and reproducible](#your-work-is-saved-versioned-and-reproducible)
- [Beginner and Expert modes](#beginner-and-expert-modes)
- [AI: Gemini, your own key, and working without AI](#ai-gemini-your-own-key-and-working-without-ai)
- [Architecture](#architecture)
- [Technology](#technology)
- [Tests and CI](#tests-and-ci)
- [Run it locally](#run-it-locally)
- [Deploy on Render (free tier)](#deploy-on-render-free-tier)
- [Project structure](#project-structure)
- [Known limits](#known-limits)
- [Further reading](#further-reading)

---

## At a glance

- **What it is:** a full-stack data science workstation in the browser. It covers seven steps: **Import, Clean, Explore, Statistics, Model, Dashboard and Report**.
- **The agent team:** 23 specialist AI agents, led by an Orchestrator you talk to in the floating **Ask AI** chat.
  - They plan your request, then carry it out on your own screen, in workflow order: you watch their cursors open lists, type and press the real controls.
  - By default they start at once and you watch (**Watch them work**); switch to **Ask me first** to approve changes before they happen.
  - Results are checked, risky ones are reviewed independently, and the whole run can be undone in one click.
- **Real numbers only:**
  - Statistics, models, forecasts and drift come from a Python engine with **65 analyses** (scikit-learn, XGBoost, LightGBM, CatBoost, statsmodels, SciPy, SHAP, DuckDB, pandas, NumPy). Every one has a form in the studio.
  - Simple data work runs in the browser.
  - Gemini writes words, plans and code. It is never the source of a metric.
- **Few AI calls:** common requests are planned by built-in rules with **zero** AI calls. Anything else takes one call.
- **Free to host:** your work lives in your browser (IndexedDB) and the servers are stateless, so it runs on Render's free tier.
- **Stack:** React 19 + TypeScript + Vite + Tailwind v4 · Node/Express · Python FastAPI · Google Gemini.

---

## Why it exists

Most "AutoML" side projects fall into one of two traps:
- an LLM narrates plausible-sounding metrics instead of computing them, or
- the "platform" is a thin wrapper around one hard-coded `sklearn` call.

This studio is built to survive the question *"where does that number come from?"*:

- **Metrics come from real engines.** Accuracy, R², cross-validation, SHAP importances, p-values, effect sizes, forecasts and drift statistics are all computed by real code on your actual data.
- **Gemini can't invent numbers.** It is confined to narration, planning and code generation. Its response schemas leave out numeric result fields, so it cannot be the source of a number.
- **Nothing is faked.** Simulated, canned or invented content was removed in a full audit (see [`docs/STUDIO_AUDIT.md`](docs/STUDIO_AUDIT.md)). Where an AI is unavailable, the studio falls back to text built from the same real numbers.

---

## Your agent team

Tap the floating **Ask AI** button and tell the team what you need in plain English. Examples:
- *"Clean the data, test if contract relates to churn, train a model and write a report."*
- *"Drop the customer_id column."*
- *"What's the average tenure?"*

The Orchestrator plans the work and hands each task to the right specialist:

| Step | Agents |
|---|---|
| Lead | **Orchestrator** plans, delegates, reviews the finished run and redoes what went wrong · **Verification Agent** re-checks risky results by a different method |
| Import & Clean | **Data Engineer** (fixes, samples, reshaping) · **Data Quality Agent** (finds problems) · **Feature Engineer** (log transforms, encodings, types) · **Data Steward** (quality rules) · **Automation Engineer** (repeatable workflows) · **Code Specialist** (sandboxed custom code) |
| Explore | **Data Scientist** (profile, deep pandas analysis) · **Insights Strategist** (AI advisory) · **SQL Analyst** (read-only queries) |
| Statistics | **Statistician** (tests, "what drives X" with Holm correction) · **Regression Analyst** (combined effects) · **Experimentation Scientist** (A/B tests, sample size) |
| Model | **ML Engineer** (training, tuning) · **Explainability Analyst** (what the model learned, leakage alarms) · **Time-Series Analyst** (forecasts) · **Segmentation Analyst** (clusters, k by silhouette) · **MLOps Engineer** (registry, predictions) |
| Dashboard | **Dashboard Designer** (charts from your words and the data) · **BI Analyst** (KPIs, filters) |
| Report | **Research Analyst** (findings) · **Publishing Agent** (PDF, reproducibility package) |

Each agent has a written skill sheet (what it knows, how it decides, its quality bar), shown in the Agents panel under **Team** and given to the AI planner. See [`docs/AGENTS_PLAN.md`](docs/AGENTS_PLAN.md).

**How a request runs**

1. **Plan with as few AI calls as possible.** The request goes through three levels:
   - Built-in rules come first. They handle commands ("drop the X column", "fill missing values with median", "open the dashboard", a `SELECT …`, "reset the data") and common analyses, with no AI call.
   - A verified, cached plan for the same request and columns comes next.
   - Only then is one AI call made. That call either returns a task plan or answers your question from the data's facts.

   Every plan, whatever produced it, is validated before it runs. The checks cover known capabilities, valid inputs, real columns, dependencies, no loops and size limits.
2. **Approve, or just watch.** A switch in the chat and the Agents panel sets how:
   - **Watch them work** (the default): every allowed task starts at once. Each change is still a saved version you can undo, and you can pause or stop the team at any time.
   - **Ask me first**: read-only tasks start at once, data changes wait for **Approve and Run**, and critical actions (custom code, registering or retraining a model) need their own approval.
   - Actions only you may take (picking files, deleting all saved work) never run, in either mode.
3. **Watch them work on your page, in order.**
   - **Strict step order:** a task starts only when every task of an earlier step (collect → clean → explore → statistics → model → dashboard → report) has finished, whatever links the plan gave it. Tasks of the same step may run together; waiting tasks say which step they wait for.
   - **Real actions, not mimes.** An agent choosing from a list opens it and runs down to the choice; typing goes in key by key and replaces the old text; buttons visibly press and the cursor then points at what appeared. If a value is already set, the agent glides past with *Already set: …* instead of pretending to act.
   - Each agent's cursor moves like a hand: curved paths, natural acceleration, a slight overshoot. A partner cursor lights up each panel the agent works in, and a thin branch grows from the **Orchestrator** node in the step bar to it, so a run reads like a tree.
   - Two agents never use the same control at once: the second waits nearby (*Waiting for …*). A tap or key press of your own pauses the team, and you can Resume or Stop.
   - **Speed:** Natural, Fast or Instant (Agents panel). Reduced motion always means Instant.
4. **Checked, not trusted.** Every task self-checks its own result (for example, no missing values left, or every kept row matches the filter). Risky results then get an **independent review** using a different method:
   - a permutation test for statistical tests,
   - the validation gate for models,
   - a recount for large row removals.

   Disagreements are reported as contradictions, never hidden.
5. **Self-healing.** If a task fails after retries, the team diagnoses it and tries one safe repair:
   - wake the ML service,
   - run the operation directly instead of through the page, or
   - try once more with more time.

   The incident only closes if the re-run succeeds. Anything else is escalated to you, and no AI call is involved.
6. **The Orchestrator reviews before reporting.** When the work ends it audits the run and redoes what went wrong:
   - leakage → retrain without the leaky columns;
   - a model that fails the validation gate → a tuned model;
   - a dashboard that didn't render → a redesign;
   - blocked work → rerun after the fix.

   With a Gemini key, one more AI call checks that the results answer your request. One round, at most six fixes, normal approvals.
7. **A truthful report.** At the end you get a summary in the chat:
   - what was done, and each task's check,
   - reviews, contradictions and incidents,
   - limitations,
   - AI calls and tokens used,
   - **Undo All**, which returns your data to how it was before the run.

The **SQL** and **Code** tabs in the chat run a read-only query (results shown as a table) or your own JavaScript transform in a sandbox (always with its own approval). The **Agents** panel in the toolbar shows the details: task map, each task's check, messages between agents, incidents, telemetry and recent runs.

**Welcome.** Each time the studio opens, the team shows what it can do in about seventeen seconds. Beside four lines about how they work, five agents do real work on a 20-row sample, one after another:
1. The **Data Engineer** fills two blank cells with each column's median.
2. The **Statistician** drags across two columns and their correlation appears.
3. The **ML Engineer** presses Train: a one-rule model is fitted on 14 rows and scored on the 6 it never saw.
4. The **Dashboard Designer** drags a chart into a mini dashboard and widens it by its curved corner.
5. The **Verification Agent** recomputes each result and ticks it off.

Every number shown is computed from the sample. Then the team flies into the Ask AI button. The × (with a ring showing the time left), Esc or a tap skips it; with reduced motion it shows the finished picture.

> Agents can operate every feature that changes data or produces a result. A test (`src/swarm/coverage.test.ts`) fails if a new feature isn't registered for them. A few things are deliberately left to you, such as picking files from your computer or deleting all saved work. Details: [`docs/SWARM.md`](docs/SWARM.md).

---

## The seven steps

### 1. Import
The page puts the most-used actions first: add a file, try a sample, set a goal, then other sources.
- **Files:** CSV/TSV (delimiter detected), Excel `.xlsx` (with a sheet picker), JSON / JSON Lines (nested objects flattened) and Parquet, parsed in the browser up to 100 MB. Larger files (several GB) go straight to the engine.
- **Other sources, through the engine:** a web address; a **JSON API** (bearer token, key in a header or the address, or username and password; page numbers, offsets, *next* links or cursors; nested fields become columns; the key is never stored); PostgreSQL or MySQL (read-only `SELECT`); BigQuery; Google Cloud Storage. Every address is checked against private networks.
- **Type detection** (numbers, categories, booleans, dates, ID-like columns) and **sample datasets**.

### 2. Clean
- **Fixes:** fill missing values, remove or add columns and rows, calculated columns, **one-hot** and **label encoding** (one number per category, most common first or alphabetical), remove duplicates, filter rows.
- **More tools**, each previewed before applying: tidy text, change type (understands `$1,200`, `(300)`, `1.234,5`), replace values, join or append a second file, group-and-summarise, pivot.
- **On the full data, in the engine:** profile, data rules, outliers (IQR, isolation forest, LOF), personal-data scan and masking, and **recipes** — repeatable preparation steps (filter, derive, bin, date parts, label/one-hot encode, scale, clip, group, pivot, window, join, SQL) saved as a new dataset.
- **Quality rules** re-checked after every change, the **quality audit** with fixes, **Undo**, **Reset to original**, and **Workflows** to replay the steps on a new file.

### 3. Explore
- Overview, distributions, categories, outliers and correlations; deep analysis on the full data with pandas.
- **Engine analyses:** segments (k-means, GMM, HDBSCAN), maps of the data (PCA, UMAP, t-SNE), market basket rules, time series (decompose, anomalies, change points), text (overview, sentiment, entities, topics by meaning, duplicates, zero-shot labels, semantic search), correlation with p-values, normality.
- **SQL editor** (Expert): read-only, in a fresh in-browser database; any result can become the working data.

### 4. Statistics
- **Compare & relate:** the right test from the column types (Welch t-test, Welch ANOVA + Tukey, Pearson, paired t, chi-squared), with effect sizes, confidence intervals, assumption checks and the matching non-parametric test; multiple-test correction.
- **Models:** linear and logistic regression, GLMs, mixed-effects, robust and quantile regression, ANOVA/ANCOVA, bootstrap intervals.
- **Causal inference:** matching/weighting, difference-in-differences, instrumental variables, regression discontinuity, synthetic control, uplift.
- **Experiments:** A/B tests, sample size and power, sequential boundaries, bandits, sample-ratio-mismatch checks; **Bayesian** A/B tests, t-tests and regression; **survival** curves and Cox/AFT models.

### 5. Model
- **AutoML in the engine:** every suitable family (linear, random forest, extra trees, gradient boosting, XGBoost, LightGBM, CatBoost and more) tuned with Optuna under cross-validation, a stacked ensemble, a fair baseline, corrected confidence intervals and a significance test against the runner-up, leakage and fairness checks, calibration, cost-based thresholds and conformal prediction intervals.
- **Split the rows** with one choice: train/test 80/20 (default) or train/validation/test 70/15/15 or 60/20/20. The model is still chosen by cross-validation; validation and test scores are shown side by side, with a warning when they differ.
- **Explain** (SHAP, permutation importance, partial dependence), **predict** (a form, a file, or the whole dataset), **registry** with versions and stages (staging/production, approver, model card, download).
- **Monitor** drift (PSI, KS/chi-squared, new categories) and accuracy decay, and **retrain when drift is found**: pick the model, the new data (this data, or a fresh re-import), when to retrain and where the new version goes; check now or on a schedule. Production only changes when the new version beats the current one on the new data.
- **Forecast** (with backtesting and intervals, hierarchical), **decide** (optimisation, Monte Carlo, what-if scenarios), **checks** (fairness, feature selection) and **automate** (re-run past analyses as pipelines or on schedules).
- The quick model in the browser-backed service is still there for a fast first look.

### 6. Dashboard
- Designed by the studio's chart rules from your columns (no AI call), the same designer the agents use. Click a bar or slice to filter every chart.
- **Arrange it like a desktop:** every panel sits on a 12-column grid. Drag a panel's **curved bottom-left corner** to resize it (its right edge stays put), or the **three dots** on top to move it; the other panels slide out of the way and close up gaps. **Clean up** lines everything into tidy rows (KPIs, then charts, then wide panels and tables), **Keep arranged** tidies after every change, with **Undo** and **Reset**. The layout is saved per dataset; on phones panels stack.
- **Pinned results:** pin any result from Statistics, Explore or Model and it appears here, ready to refresh when the data changes. **KPI formulas** (e.g. `SUM(revenue) / COUNT()`), saved dashboards per dataset.

### 7. Report
- A structured, editable report: executive summary, the data, quality, preparation (with the pandas code), exploration, statistics, models, forecasts, dashboard and KPIs, reproducibility and methods. Hide, reorder, rename sections and add your own commentary.
- **PDF** with the charts and result panels as sharp pictures (as shown on screen), captions kept with their figures and the numbers behind them in an appendix; **HTML** (charts included), **Markdown**, print.
- **Reproducibility package (.zip):** current and original data, lineage, workflows, saved analyses, a **Jupyter notebook** that reproduces the studio's numbers, the pandas script, the PDF and the model card.

---

## Your work is saved, versioned and reproducible

- **Data versions with lineage:** every change makes a new version that records its parent and the operation that made it. You can switch versions or undo at any time.
- **Run history:** every test, model, forecast and analysis is logged with the data version it used.
- **Workspace export/import:** move or back up all your work as one file.
- **Trained models are kept in the browser.** If the ML service restarts, a registered model is rebuilt from its recipe (the same data, columns, settings and seed), which reproduces the same score.
- **Jobs panel:** long requests are listed with their elapsed time and can be stopped.
- **Session restore:** reload the page and you're where you left off. An unfinished agent run is recovered without repeating changes that were already applied.

---

## Beginner and Expert modes

A switch in the toolbar:
- **Beginner** keeps things simple: plain-English results, sensible defaults, fewer controls.
- **Expert** unlocks the SQL editor, hypothesis lab, A/B testing, tuning, custom splits, detailed drift statistics and developer exports.

The agents work in both.

---

## AI: Gemini, your own key, and working without AI

- **Server key:** the server uses `GEMINI_API_KEY` when it's set.
- **Your own key:** visitors can add their own free key from [Google AI Studio](https://aistudio.google.com/) (toolbar → key icon). It is kept only in your browser, sent only with your own requests and never stored on the server.
- **The model keeps itself current.** Google retires models regularly, so the server asks Google which models exist (ListModels) instead of relying on a fixed list:
  - **Free tier (the default):** it tests the newest models with one tiny request each and keeps the newest ones that answer on the key **without billing**.
  - **Latest:** the newest models, paid or free.
  - It refreshes at start-up, daily, and on its own when a model stops working (then retries the call). **Update to latest free model** and **Update to latest model** buttons in the AI notice and the key sheet do it on demand; the sheet shows the model in use and which ones need billing.
- **Without any key:** built-in rules still plan commands and analyses, simple questions are answered from the data, and narrations fall back to templates built from the real numbers. Engine results never depend on AI.

---

## Architecture

```text
┌──────────────────────────────── Browser ────────────────────────────────┐
│ React 19 + TypeScript                                                   │
│  • 7 steps (Import → Report), Ask AI chat, Agents panel, cursor layer   │
│  • Agent swarm runtime: planner, task graph, approvals, page lock,      │
│    reviews, self-healing, telemetry                                     │
│  • In-browser engines: parsing, cleaning operations, SQL (read-only),   │
│    KPI formulas, A/B maths                                              │
│  • IndexedDB: datasets & versions, run history, dashboards, models,     │
│    agent runs, plan cache                                               │
└───────────────┬─────────────────────────────────────▲───────────────────┘
                │ JSON requests (data or references)   │ results
                ▼                                      │
┌──────────────────────── Node / Express (stateless) ─┴───────────────────┐
│  • Serves the app; proxies compute to the ML service (wakes it if idle) │
│  • AI gateway: /api/swarm/plan and narration endpoints (Gemini,         │
│    owner key or the visitor's own key)                                  │
│  • Background jobs for long requests                                    │
└───────────────┬─────────────────────────────────────────────────────────┘
                │
                ▼
┌──────────────────────── Python FastAPI (stateless) ─────────────────────┐
│  Engine v2: /v2/run/{capability} (65 analyses), datasets, jobs, runs,   │
│  models (registry, serving, monitoring), pipelines and schedules        │
│  Classic: /train /predict /eda /forecast /stats/* /monitor/drift        │
│  scikit-learn · XGBoost · LightGBM · CatBoost · statsmodels · SciPy ·   │
│  SHAP · Optuna · DuckDB · pandas · NumPy · sentence-transformers        │
└─────────────────────────────────────────────────────────────────────────┘
```

**Why the browser stores the work:** Render's free services lose their disk on restart and sleep when idle, so nothing is kept on the servers. The same entities can move to a server database later without changing the UI.

---

## Technology

| Area | Technology |
|---|---|
| UI | React 19, TypeScript, Vite 6, Tailwind CSS v4, Motion, Recharts, Lucide |
| Type | SF Pro / Inter for the studio; Source Serif 4 for the welcome |
| In-browser data | AlaSQL (read-only SQL), read-excel-file, hyparquet, mathjs |
| Storage | IndexedDB |
| Server | Node.js, Express, esbuild bundle |
| AI | Google Gemini via `@google/genai` (planning, narration, structured function-calling) |
| Compute service | Python 3.13, FastAPI, scikit-learn, XGBoost, LightGBM, CatBoost, statsmodels, SciPy, SHAP, Optuna, DuckDB, pandas, NumPy; deployed on Google Cloud Run |
| Reports | jsPDF, html-to-image (charts in the PDF), generated Jupyter notebooks |
| Testing | Vitest (frontend), pytest (ML service) |
| CI | GitHub Actions: typecheck, unit tests, ESLint, build, ruff, pytest |
| Containers | Docker, docker-compose |

---

## Tests and CI

| Suite | What it covers |
|---|---|
| **Vitest (~210 tests)** | Operations registry, parsers, SQL safety, KPI parser, statistics helpers, provenance notebook, and the agent swarm (described below) |
| **pytest (~190 tests)** | Real metric ranges, EDA cross-checked against independent pandas computation, statistics against reference values (Cohen's tables, SciPy, scikit-learn, pingouin), forecast backtests, same-seed reproducibility, agent functions |

The Vitest suite checks the agent swarm in detail:
- the planner, runtime, approvals, reviews and self-healing,
- the blueprint's acceptance tests A01–A25,
- **coverage** (agents can operate every feature),
- human-motion maths and Gemini key handling.

Every push and pull request runs both suites, the typecheck and the build ([`.github/workflows/ci.yml`](.github/workflows/ci.yml)).

```bash
npm run lint      # TypeScript typecheck
npm test          # Vitest
npm run build     # production build
cd mlops_service && pytest tests && ruff check .
```

---

## Run it locally

**Requirements:** Node.js 18–22+, Python 3.11, and optionally a Gemini API key.

```bash
git clone https://github.com/thedeepakreddy/DataScienceStudio-AskDeepakAI.git
cd DataScienceStudio-AskDeepakAI
npm install
```

Create `.env` (optional, since visitors can also add their own key in the app):

```env
GEMINI_API_KEY=your_gemini_api_key
```

Start the ML service in one terminal:

```bash
cd mlops_service
pip install -r requirements.txt
uvicorn main:app --reload --port 8000
```

Start the studio in another:

```bash
npm run dev        # http://localhost:3000
```

The server finds the ML service in this order:
1. `ML_SERVICE_URL`, if set.
2. Otherwise a service on `127.0.0.1:8000`.
3. Otherwise the hosted free-tier ML service.

### One command with Docker

```bash
GEMINI_API_KEY=your_gemini_api_key docker compose up --build
```

The studio is at `http://localhost:3000` and the ML service at `http://localhost:8000`. The containers talk to each other through `ML_SERVICE_URL=http://ml-service:8000`.

---

## Deploy

The studio runs on Render and the engine on Google Cloud Run. To redeploy the engine from Cloud Shell:

```bash
git clone https://github.com/thedeepakreddy/DataScienceStudio-AskDeepakAI.git && cd DataScienceStudio-AskDeepakAI
SKIP_RENDER=1 PROJECT_ID=<your-project> bash scripts/deploy_engine_cloudrun.sh
```

Details: [`docs/DEPLOY_ENGINE.md`](docs/DEPLOY_ENGINE.md). Both can also run on Render's free tier:

**1. ML service.** A **Web Service** from this repo:
- Root directory: `mlops_service`
- Runtime: Docker (uses `mlops_service/Dockerfile`)

**2. Studio.** A **Web Service** from this repo:
- Runtime: Node
- Build: `npm install && npm run build`
- Start: `npm start`
- Environment:
  - `ML_SERVICE_URL` = the ML service's URL
  - `GEMINI_API_KEY` = your key (optional)
  - `NODE_ENV=production`

Free services sleep when idle. The studio wakes the ML service for you ("Wake ML Engine" in the toolbar, and automatically when an agent needs it). The first request after a sleep can take about a minute.

---

## Project structure

```text
├── server.ts                 Express server: app, API, AI gateway, ML proxy, jobs
├── src/
│   ├── App.tsx               Steps, toolbar, workspace state, agent wiring
│   ├── components/           Steps and panels (Clean, Statistics, Model, Deploy, …),
│   │                         Ask AI chat, Agents panel, cursor layer, welcome
│   ├── engine/               Engine client, generated contract (65 analyses), dataset sync
│   ├── report/               Report builder, layout editor, PDF/HTML/Markdown exporters
│   ├── swarm/                Agent team: catalog, planner, runtime, UI scripts,
│   │                         interaction engine, review, recovery, human motion
│   ├── operations/           Data operations registry (shared by UI and agents)
│   ├── utils/                Parsers, SQL safety, statistics helpers, storage, AI key
│   └── index.css             Tailwind v4 theme, agent colours, animations
├── mlops_service/            Python FastAPI engine (engine/capabilities/*) + pytest suite
├── docs/
│   ├── SWARM.md              How the agent team works; how to add a feature for agents
│   ├── ENGINE_CAPABILITIES.md  Every engine analysis and its parameters (generated)
│   ├── ENGINE_API.md, DEPLOY_ENGINE.md
│   ├── STUDIO_AUDIT.md       Feature audit (real / partial / fake) and phase log
│   └── screenshots/
├── Dockerfile, docker-compose.yml
└── .github/workflows/ci.yml
```

Tailwind CSS v4 is configured in `src/index.css`. There is no `tailwind.config.js`.

---

## Known limits

- **Your work is stored in your browser.** It isn't synced across devices (use workspace export/import), and browser storage quotas apply.
- **Free hosting:** the ML service sleeps when idle and has little memory, so very large datasets or training many models at once can be slow.
- **Database and API imports** are copies taken when you import; to refresh them, re-import (Model → Automate can re-import on a schedule for public sources).
- **AI features need a Gemini key** (the owner's or your own). Everything else works without one.

---

## Further reading

- [`docs/SWARM.md`](docs/SWARM.md): the agent team in depth, and how to make a new feature usable by agents.
- [`docs/ENGINE_CAPABILITIES.md`](docs/ENGINE_CAPABILITIES.md): all 65 engine analyses with their parameters.
- [`docs/STUDIO_AUDIT.md`](docs/STUDIO_AUDIT.md): what was audited, removed and rebuilt, phase by phase.
- [`CASE_STUDY.md`](CASE_STUDY.md): what was hard to build.

<details>
<summary>Screenshots from an earlier version</summary>

Real server-side EDA, multi-model AutoML comparison and SHAP explainability. The interface has been redesigned since; the engines are the same.

![Demo](docs/screenshots/demo.gif)

</details>

---

*Built by Deepak Reddy.*
