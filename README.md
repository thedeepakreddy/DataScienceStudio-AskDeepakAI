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
  - They plan your request, then carry it out on your own screen: you watch their cursors click, type and select real controls.
  - Results are checked, risky ones are reviewed independently, and the whole run can be undone in one click.
- **Real numbers only:**
  - Statistics, models, forecasts and drift come from a Python service (scikit-learn, XGBoost, SHAP, SciPy, pandas, NumPy).
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
2. **Approve what matters.** Your approval depends on the kind of task:
   - Read-only tasks start at once.
   - Data changes wait for **Approve and Run**.
   - Critical actions, such as custom code or registering a model, need their own approval.
   - Fixes the Data Quality Agent finds while working are added as new tasks, and they wait for approval too.
3. **Watch them work on your page.**
   - Each agent's cursor moves like a hand: curved paths, natural acceleration, a slight overshoot.
   - Every agent works as a pair of cursors. Its partner drags a selection box open, corner to corner, round the area and round each control; then the worker moves into the open box and does the real click, choice or typing there, while the partner holds the box open until that work is finished.
   - Only one agent holds the page at a time. A tap or key press of your own pauses the team ("Agents paused — you're in control"), and you can Resume or Stop.
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

**Welcome.** Each time the studio opens, the team introduces itself in about fourteen seconds:
1. Cursors stream in from every edge.
2. The Orchestrator types *Welcome to*, while three agents drag selection boxes that reveal **Data Science *Studio***.
3. Nine agents each build a card for one thing the team can do.
4. A line draws to the Ask AI button and the swarm flies into it.

The × in the top-left (with a ring showing the time left), Esc or a tap skips it. It adapts to desktops, tablets and phones, and has a still version for reduced motion.

> Agents can operate every feature that changes data or produces a result. A test (`src/swarm/coverage.test.ts`) fails if a new feature isn't registered for them. A few things are deliberately left to you, such as picking files from your computer or deleting all saved work. Details: [`docs/SWARM.md`](docs/SWARM.md).

---

## The seven steps

### 1. Import
- **File formats:** CSV/TSV (delimiter detected), Excel `.xlsx` (with a sheet picker), JSON / JSON Lines (nested objects flattened) and Parquet. Everything is parsed in the browser, up to 100 MB / 200,000 rows.
- **Type detection:** numbers, categories, booleans, dates and ID-like columns.
- **Sample datasets** to try things out.
- **PostgreSQL:** a one-time copy of up to 2,000 rows from a table.

### 2. Clean
- **Fixes:**
  - Fill missing values (mean, median, mode, zero).
  - Remove or add columns and rows, calculated columns, one-hot encoding.
  - Remove duplicates, filter rows.
- **More tools**, each with a preview before applying: tidy text, change type (understands `$1,200`, `(300)`, `1.234,5`), replace values, join or append a second file, group-and-summarise, pivot.
- **Quality rules** (not empty, unique, range, allowed values, pattern), re-checked after every change, with "remove the rows that break it".
- **Quality audit** with fixes, **Undo**, **Reset to original**, and **Workflows**: save the steps and replay them on a new file.

### 3. Explore
- Overview, distributions, categories, outliers and correlations.
- Deep analysis on the full data with pandas: skew, IQR outliers, missing-value report, correlation matrix.
- **SQL editor** (Expert): write SQL or have AI write it. Every query passes a strict read-only check and runs in a fresh in-browser database. Any result can become the working data.
- **AI advisory:** suggested target, risks and next steps, with a data-derived fallback when AI is unavailable.

### 4. Statistics
- **Compare & relate:** the test is chosen from the column types.
  - The tests: Welch's t-test, Welch's ANOVA with Tukey HSD, Pearson, paired t-test or chi-squared.
  - With each: an effect size (Hedges' g, η²/ω², r, dz, Cramér's V), a confidence interval and assumption checks (Shapiro–Wilk, Levene, expected counts).
  - The matching non-parametric test (Mann–Whitney, Kruskal–Wallis, Spearman, Wilcoxon, Fisher's exact), recommended when an assumption fails.
  - One- or two-sided tests, at levels 0.01/0.05/0.10.
- **Multiple-test correction:** Holm, Bonferroni, Benjamini–Hochberg.
- **Regression:** linear (OLS) and logistic, with coefficients, CIs, p-values, odds ratios, R² / pseudo-R² and collinearity detection.
- **Sample size & power:** two-group, paired, ANOVA, correlation and two-proportion designs.
- **A/B test interpreter:** z-test on conversion rates with lift and minimum detectable effect.
- **Hypothesis lab:** AI proposes testable hypotheses on your real columns; the real engine tests them.

### 5. Model
- **AutoML:** five candidate models (Logistic/Linear Regression, Random Forest, Gradient Boosting, XGBoost, MLP), ranked by k-fold cross-validation, every one shown, with the reason the winner was chosen.
- **Real preprocessing pipelines:** imputation, scaling and encoding, fitted on training rows only.
- **Leakage-safe evaluation:** seeded runs (the same settings give identical scores), splits by time or by group, and leakage warnings.
- **Hyperparameter tuning:** randomized search with cross-validation, showing every trial.
- **Explainability:** SHAP feature importance (TreeExplainer / LinearExplainer).
- **Experiments:** every run with its score, split, seed and data version. Re-run any one exactly.
- **Forecasting:** naive, seasonal naive, moving average, drift, linear trend, Holt and Holt-Winters, scored by rolling-origin backtesting, with 80%/95% ranges from real backtest errors.
- **Clustering** (k-means).
- **Agentic analysis:** Gemini function-calling drives a reason → act → observe loop. It is limited to a fixed set of real ML-service functions (retrain with a transform, drop a feature, check multicollinearity via VIF), capped at 5 steps, with an explicit stop reason.
- **Deploy & monitor:**
  - A validation gate before registering: the model must beat the baseline, show no leakage and not rely on an ID column.
  - A model registry with versions and instant rollback.
  - Predictions from a form or a whole file.
  - Drift monitoring: PSI, KS / chi-squared, out-of-range values and unseen categories.
  - A model card.

### 6. Dashboard
- Charts built from your data. Click a bar or slice to filter every chart; active filters show as removable chips.
- **KPI formulas** (e.g. `SUM(revenue) / COUNT()`), computed by a small dedicated parser. No code is executed.
- Save, reopen, update and delete named dashboards per dataset.

### 7. Report
- **Executive PDF:** built from the real dataset profile, tests and model metrics. Includes saved analyses and provenance (model seed, split and tuning).
- **Reproducibility package (.zip):**
  - the current and original data as CSV,
  - lineage, workflows and saved analyses,
  - a **Jupyter notebook** that reproduces the studio's exact accuracy and p-value (tested),
  - the PDF and the model card.
- **Data dictionary** and **ETL code** export.

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
- **Your own key:** visitors can add their own free key from [Google AI Studio](https://aistudio.google.com/) (toolbar → key icon).
  - Both classic keys (`AIza…`) and newer keys (`AQ.…`) are accepted. Spaces, quotes or a `GEMINI_API_KEY=` prefix picked up when pasting are removed automatically.
  - The key is kept only in your browser and is sent only with your own requests. The server never stores it.
- **Without any key:**
  - Built-in rules still plan commands and analyses.
  - Simple questions are answered from the data (row and column counts, missing values, a column's average, median, min, max or most common values).
  - Narrations fall back to templates built from the real numbers.

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
│  /train /predict /eda /forecast /stats/{compare,regression,power}       │
│  /monitor/drift /hypothesis-test /agent/* /download/{id} /health        │
│  scikit-learn · XGBoost · SHAP · SciPy · pandas · NumPy                 │
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
| Compute service | Python, FastAPI, scikit-learn, XGBoost, SHAP, SciPy, pandas, NumPy |
| Reports | jsPDF, html2canvas, generated Jupyter notebooks |
| Testing | Vitest (frontend), pytest (ML service) |
| CI | GitHub Actions: typecheck, unit tests, ESLint, build, ruff, pytest |
| Containers | Docker, docker-compose |

---

## Tests and CI

| Suite | What it covers |
|---|---|
| **Vitest (~130 tests)** | Operations registry, parsers, SQL safety, KPI parser, statistics helpers, provenance notebook, and the agent swarm (described below) |
| **pytest (81 tests)** | Real metric ranges, EDA cross-checked against independent pandas computation, statistics against reference values (Cohen's tables, SciPy, scikit-learn, pingouin), forecast backtests, same-seed reproducibility, agent functions |

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

## Deploy on Render (free tier)

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
│   ├── swarm/                Agent team: catalog, planner, runtime, UI scripts,
│   │                         interaction engine, review, recovery, human motion
│   ├── operations/           Data operations registry (shared by UI and agents)
│   ├── utils/                Parsers, SQL safety, statistics helpers, storage, AI key
│   └── index.css             Tailwind v4 theme, agent colours, animations
├── mlops_service/            Python FastAPI compute service + pytest suite
├── docs/
│   ├── SWARM.md              How the agent team works; how to add a feature for agents
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
- **PostgreSQL import** is a one-time copy of up to 2,000 rows. Scheduled sync isn't offered.
- **AI features need a Gemini key** (the owner's or your own). Everything else works without one.

---

## Further reading

- [`docs/SWARM.md`](docs/SWARM.md): the agent team in depth, and how to make a new feature usable by agents.
- [`docs/STUDIO_AUDIT.md`](docs/STUDIO_AUDIT.md): what was audited, removed and rebuilt, phase by phase.
- [`CASE_STUDY.md`](CASE_STUDY.md): what was hard to build.

<details>
<summary>Screenshots from an earlier version</summary>

Real server-side EDA, multi-model AutoML comparison and SHAP explainability. The interface has been redesigned since; the engines are the same.

![Demo](docs/screenshots/demo.gif)

</details>

---

*Built by Deepak Reddy.*
