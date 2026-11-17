# Agent team v3: plan

Goal: the agents operate every feature in all seven steps, plan long multi-step jobs, design dashboards from what the user asks for, and know their craft. All of this must stay true to the studio's rules:
- every number comes from a real engine,
- as few AI calls as possible,
- the user approves data changes,
- everything can be undone.

This document is the plan. Implementation follows it; where the code differs, the code comments say why.

---

## 1. What's wrong today

| Problem | Cause |
|---|---|
| Agents can't build dashboards the way the user describes | Chart choices live inside the dashboard component; no capability can reach them. Agents can only add a KPI and save. |
| Work is "limited" | About 25 capabilities. Several features have none: sample datasets, deep (pandas) analysis, "what drives X", clustering, tuning, explainability, dashboard design and filters, group/pivot. |
| Plans are short | The rule planner builds at most ~6 tasks; limits are 20 tasks and 8 added while running. |
| Agents feel generic | A role is a name and a colour. There's no written expertise, and the AI planner isn't told what each specialist knows. |
| Not every agent has enough to do | 9 roles; several steps are covered by one generalist. |

---

## 2. Principles (unchanged, and why)

1. **Real or nothing.** An agent may only use a capability that calls a real engine: a registry operation, the Python service, or a tested browser computation. *Why:* the studio's promise. A specialist with no real capability would be theatre, so none is added.
2. **Rules first, one AI call at most.** New capabilities are deterministic or backend-computed. AI is used only to plan unusual requests or answer questions. *Why:* free hosting, speed and reproducibility.
3. **Approve what changes data.** Read-only work runs at once. Data changes need **Approve and Run**. Anything critical, or anything that replaces the dataset, needs its own approval. *Why:* the user stays in charge, and Undo All stays meaningful.
4. **Checked, not trusted.** Every capability has a self-check; risky results get an independent review. *Why:* long autonomous runs multiply the cost of a silent mistake.
5. **Bounded autonomy.** More room for long jobs, but still with hard limits. *Why:* a runaway plan on a free ML service would hang the studio.

---

## 3. The team: 9 → 23 agents

Each agent has a **skill sheet** (`src/swarm/skills.ts`) with:
- **mission:** one line,
- **knows:** domain knowledge,
- **playbook:** the decisions it makes and how,
- **quality bar:** when it stops or asks,
- **owns:** its capabilities,
- **hands off to:** who usually takes its output next.

The same sheet drives three things:
- the AI planner prompt (better plans),
- the new **Team** view in the Agents panel (users can see who knows what),
- tests (every capability has exactly one owner; every agent owns at least one real capability).

### Kept (9)

| Agent | Mission | Owns |
|---|---|---|
| Orchestrator | Turns a request into the smallest correct plan, delegates, writes the final report | nav.open_step |
| Data Engineer | Gets the data into shape without losing information | data.* fixes, data.reset, data.group_aggregate, data.pivot, import.sample (custom code moved to the Code Specialist) |
| Data Quality Agent | Finds what's wrong before anyone analyses it | quality.check |
| Data Scientist | Understands the data: profile, deep analysis, advisory | explore.profile, explore.deep_eda, explore.ai_advisory |
| Statistician | Decides what's real vs noise | stats.compare, stats.screen, stats.regression |
| ML Engineer | Trains models that generalise | models.train (incl. tuning) |
| BI Analyst | Business metrics people act on | dashboard.add_kpi, dashboard.filter |
| Research Analyst | Evidence, findings and the written report | report.build, report.pdf, report.package |
| Verification Agent | Re-checks risky results by a different method | verify.review |

### New (9) and why each exists

| Agent | Mission | Owns | Why a separate specialist |
|---|---|---|---|
| **Dashboard Designer** | Chooses the right charts for the question and the data | dashboard.design, dashboard.save | The user's main ask. Chart choice is its own discipline (chart grammar), distinct from defining KPIs. |
| **Feature Engineer** | Creates the inputs models learn from | data.derive_column, data.one_hot_encode, data.convert_type | Feature work is the biggest lever on model quality and has its own leakage rules; it differs from cleaning. |
| **Time-Series Analyst** | Forecasts honestly | models.forecast | Time needs different validation (no random splits, backtests); one place to enforce it. |
| **Segmentation Analyst** | Finds natural groups | models.cluster *(new)* | A common business ask that no agent could do. |
| **Explainability Analyst** | Explains what a model learned, and spots when it learned the wrong thing | models.explain *(new)* | Separating producer (ML Engineer) and explainer reduces self-confirmation; explanations are what stakeholders trust. |
| **Experimentation Scientist** | Designs and reads experiments | stats.ab_test, stats.power | "How many users do I need?" and "did the test win?" are experiment-design questions, not observational analysis. |
| **MLOps Engineer** | Ships models safely | deploy.register, deploy.predict | Deployment has its own approval class and risks (validation gate, versions, rollback). |
| **Data Steward** | Keeps data trustworthy over time | quality.add_rule, workflow.save, workflow.apply | Guarding (rules, repeatable workflows, lineage) is a different job from fixing. |
| **SQL Analyst** | Answers questions with read-only queries | sql.query | SQL mode and data questions get an owner who knows the read-only rules. |

### Five more (added on request), each with a real job

| Agent | Owns | Why separate |
|---|---|---|
| **Regression Analyst** | stats.regression | Combined effects with confidence intervals and collinearity are their own craft. It takes the drivers the Statistician found. |
| **Insights Strategist** | explore.ai_advisory | Turning a dataset into business questions and a first target is a different job from computing statistics. |
| **Publishing Agent** | report.pdf, report.package | Producing evidence (PDF, notebook, lineage) is separate from writing findings. |
| **Automation Engineer** | workflow.save, workflow.apply | Repeatable cleaning is automation, not governance. |
| **Code Specialist** | data.custom_code | Sandboxed custom code has its own safety rules and always its own approval. |

### Why not more (considered and rejected)

| Rejected | Reason |
|---|---|
| NLP / text-mining | The studio has no text features. It would be fake. |
| Geo analyst | The dashboard lists "Geographic Map", but the studio doesn't draw it yet. |
| Causal-inference agent | The studio has no causal methods. Claiming causality from tests would mislead. |
| Separate "Profiler" | The Data Scientist already profiles. Splitting adds hand-offs without new capability. |

**Colours:** the 9 new agents get rich, muted tones, distinct in hue or lightness from the existing nine, with dark-mode variants. Name tags carry identity, so colour never has to.

---

## 4. Skills (summary; full text lives in `skills.ts`)

- **Orchestrator.**
  - Order the work: clean before analysing; analyse before dashboards and reports.
  - Keep the plan as small as the request needs; a full analysis is the exception.
  - Data changes go through approval.
  - If there's no clear target, don't guess: say how to name one.
- **Data Quality.**
  - Check missingness per column (over 40% means consider dropping), duplicates, constant columns, ID-like columns, IQR outliers, mixed types.
  - Propose fixes; never apply silently.
- **Data Engineer.**
  - Median for skewed numbers, mean for symmetric ones, mode for categories.
  - Every change is a new version.
  - Prefer the smallest change that fixes the problem.
- **Feature Engineer.**
  - log1p for strongly right-skewed positive columns (skew > 2).
  - One-hot only for low-cardinality categories (≤ 10).
  - Never derive from the target (leakage).
  - Convert numbers stored as text.
- **Data Scientist.**
  - Profile first, deep analysis on the full data.
  - Report skew, outliers and strong correlations (|r| ≥ 0.7, collinearity warning).
- **Statistician.**
  - Choose the test from the column types; check assumptions; prefer non-parametric when they fail.
  - Report effect sizes and confidence intervals, not just p-values.
  - Correct for multiple tests (Holm).
  - p within ±0.01 of α is borderline.
  - Association isn't causation.
- **Experimentation Scientist.**
  - Two-proportion z-test for conversions; report lift and the minimum detectable effect.
  - Sample size from effect, α and power.
  - Never peek and stop early.
- **ML Engineer.**
  - Beat the baseline; never evaluate on training rows; exclude ID and leaky columns.
  - With imbalanced classes, look at F1, precision and recall, not accuracy.
  - Seed everything; tune only after a baseline, and only one named algorithm.
- **Explainability Analyst.**
  - SHAP importances.
  - An ID or a near-copy of the target at the top means leakage: raise the alarm.
  - Importance isn't causation.
- **Time-Series Analyst.**
  - Needs a date and a number with enough history.
  - Rolling-origin backtests; horizon ≤ about ⅓ of the history.
  - Report the 80%/95% ranges.
- **Segmentation Analyst.**
  - Standardise; exclude IDs and the target.
  - Choose k (2–6) by silhouette.
  - Describe each segment against the overall average.
  - Segments under 5% of rows are suspect.
- **Dashboard Designer.** The chart grammar in §6.
- **BI Analyst.**
  - KPIs in business language: totals, averages, rates.
  - Filters for the dimensions people slice by.
- **MLOps Engineer.**
  - Register only models that pass the validation gate.
  - Version every model; monitor drift (PSI/KS); roll back instantly.
- **Data Steward.**
  - Rules for keys (unique, not empty) and bounded numbers (ranges).
  - Save workflows for repeatable cleaning.
- **SQL Analyst.**
  - One read-only SELECT over `dataset`; LIMIT previews; GROUP BY summaries.
- **Research Analyst.**
  - Every finding cites the run that produced it.
  - Separate observations, risks and recommendations; state the limitations.
- **Verification Agent.** Re-check with a different method; report contradictions.

---

## 5. Capabilities: every step covered

✚ = new. "Page" = done through the real controls with cursors; "direct" = same engine, run directly when the page isn't available.

| Step | Capability | Owner | Approval | How |
|---|---|---|---|---|
| Import | ✚ import.sample {churn, saas, hardware} | Data Engineer | separate (replaces the dataset) | page |
| Clean | data.drop/rename/fill/filter/dedupe/standardize/replace/add/delete | Data Engineer | batch | page or direct |
| Clean | data.derive_column, one_hot_encode, convert_type | Feature Engineer | batch | page or direct |
| Clean | ✚ data.group_aggregate, ✚ data.pivot | Data Engineer | batch | direct (registry) |
| Clean | quality.check | Data Quality | autonomous | direct |
| Clean | quality.add_rule, workflow.save, workflow.apply | Data Steward | auto / auto / batch | page |
| Clean | data.reset, data.custom_code | Data Engineer | batch / separate | direct |
| Explore | explore.profile, explore.ai_advisory | Data Scientist | autonomous | direct / page |
| Explore | ✚ explore.deep_eda (pandas, full data) | Data Scientist | autonomous | page (Deep Analysis tab) or direct |
| Explore | sql.query | SQL Analyst | autonomous | direct |
| Statistics | stats.compare, stats.regression | Statistician | autonomous | page |
| Statistics | ✚ stats.screen ("what drives X": target vs every informative column, Holm-corrected) | Statistician | autonomous | direct (same /stats/compare engine) |
| Statistics | stats.ab_test, stats.power | Experimentation Scientist | autonomous | direct / page |
| Model | models.train (+ ✚ tune for one named algorithm) | ML Engineer | autonomous | page or direct |
| Model | models.forecast | Time-Series Analyst | autonomous | page |
| Model | ✚ models.cluster (k by silhouette) | Segmentation Analyst | autonomous | direct (browser k-means, tested) |
| Model | ✚ models.explain (SHAP + leakage reading) | Explainability Analyst | autonomous | direct |
| Model | deploy.register / deploy.predict | MLOps Engineer | separate / autonomous | page |
| Dashboard | ✚ dashboard.design (from the user's words and the data) | Dashboard Designer | autonomous (view only) | page |
| Dashboard | ✚ dashboard.filter | BI Analyst | autonomous | page |
| Dashboard | dashboard.add_kpi | BI Analyst | autonomous | page |
| Dashboard | dashboard.save | Dashboard Designer | autonomous | page |
| Report | report.build, report.pdf, report.package | Research Analyst | autonomous | direct / page |
| All | nav.open_step | Orchestrator | autonomous | page |
| All | verify.review | Verification Agent | autonomous | direct |

### Deliberately not for agents

| Not offered | Reason |
|---|---|
| Choosing a file (import, join, append, monitoring new data) | Agents can't pick files from your computer. |
| PostgreSQL connect | It needs your credentials. |
| Clear or replace the whole workspace | Destructive; only you. |
| AI-written ETL code (Expert) | Spends AI calls to write code a person should review. |
| Agentic model-improvement loop | Up to ~6 AI calls. The ML Engineer improves models with tuning instead, at no AI cost. You can still run it yourself. |
| Re-running a past experiment | Choosing which past run to repeat is your decision. |

---

## 6. The Dashboard Designer: how dashboards follow your words

**Bridge.** The dashboard listens for an "apply design" message and replies with what it rendered. Agents navigate to the Dashboard (so it is mounted) and send the design. Then the designer's cursor visits every chart it placed, with a box and a label. The reply is the self-check: the charts that actually rendered, with their columns.

**Inputs:**
- the request text (columns mentioned; words like *trend / over time*, *compare / by*, *share / breakdown*, *distribution*, *relationship / vs*),
- the column types,
- ID detection,
- the outcome column,
- the model's top drivers, when a model exists.

**Playbook (deterministic, no AI):**
1. **Sort the columns:**
   - time = date columns;
   - metrics = numeric, not ID;
   - dimensions = categories or booleans with 2–12 values, not ID;
   - everything else is never an axis.
2. **Focus metric:**
   - a mentioned number,
   - else a numeric outcome,
   - else a money-like name (revenue, sales, amount, price, charges, cost, profit, spend),
   - else the most variable number.
3. **Focus dimensions:**
   - mentioned categories,
   - else a categorical outcome (e.g. churn),
   - else the model's top categorical drivers,
   - else the lowest-cardinality informative categories.
4. **Charts:**
   - time present (or "trend" asked) → Line [time, metric];
   - each focus dimension (≤ 2) → Bar [dimension, metric];
   - part-to-whole → Pie only with ≤ 6 categories;
   - distribution → Histogram [metric] and Box [metric, dimension];
   - relationship → Scatter [metric₁, metric₂, coloured by dimension], when there are 2+ metrics;
   - 3+ metrics → correlation heatmap;
   - always: KPI cards (top 4 metrics), Filters (focus dimensions) and a Data table (focus columns).

   Words the user said take priority over defaults. There are at most 8 charts.
5. **Layout:** 2 columns for 4 or fewer charts, else 3.
6. **Explain each chart:** every chart gets "the question it answers" and "why it's relevant".

**Why deterministic and not AI:**
- zero AI calls,
- the same request gives the same dashboard,
- testable chart grammar.

When the AI planner is used, it may *suggest* the columns, but they're validated against the data before use.

**BI Analyst KPIs:**
- totals or averages of the focus metrics as custom KPI formulas,
- the outcome rate when the outcome is yes/no (`AVG(churn)` as a percent),
- filters set from your words ("only Monthly contracts").

---

## 7. Planning: smarter and longer

**Rule planner (no AI)**, new intents:

| Request | Plan |
|---|---|
| "what drives churn", "which factors affect X" | stats.screen, then regression on the significant drivers |
| "segment / cluster customers" | models.cluster |
| "tune the model" | models.train with a named algorithm and tune: true |
| "explain the model" | models.explain |
| "deep analysis / pandas" | explore.deep_eda |
| "build a dashboard of revenue by region over time" | dashboard.design with parsed metrics, dimensions and time, then save |
| "show only X in the dashboard" | dashboard.filter |
| "load the churn sample" | import.sample |
| "average X by Y" | sql.query: a read-only GROUP BY. Reshaping the table needs an explicit request (data.group_aggregate, with approval). |
| Anything else | One AI call, as before |

**Full analysis** ("do everything", "end to end", "full analysis") builds one long plan across all seven steps:

1. quality.check → fixes added while running (approval)
2. explore.profile, explore.deep_eda
3. stats.screen on the outcome → regression follow-up
4. models.train → models.explain (+ independent review of the model)
5. models.forecast *(if there is a date and a number)*
6. models.cluster *(if there are 2+ informative numbers)*
7. dashboard.design (uses the drivers found), dashboard.add_kpi (the outcome rate), dashboard.save
8. report.build → report.pdf

That's about 15–25 tasks, depending on the data.

**No clear outcome?**
- *Today* the planner falls back to the last column.
- *New behaviour:* use it only if it looks like an outcome (yes/no, or a few categories). Otherwise skip modelling and screening, and say how to name one ("…and predict revenue").
- *Why:* a confident model of the wrong target is worse than none.

**Follow-ups while running** (bounded, approvals as usual):

| After | Added |
|---|---|
| quality.check | the fixes (existing) |
| stats.screen | regression on up to 4 significant drivers (read-only) |
| models.train | models.explain (read-only) |
| explore.deep_eda | log transforms for at most 2 severely skewed positive columns (skew > 2), only when the plan also trains a model; they wait for approval |

**AI planner:**
- the prompt includes each agent's skill sheet and owner per capability;
- the limit rises to 30 tasks;
- it must follow the playbooks' ordering.

### 7a. The Orchestrator's final review (added on request)

When the last task ends, the Orchestrator reviews the run before reporting.

**1. Deterministic audit** (`src/swarm/orchestratorReview.ts`), no AI:

| Finding | What the Orchestrator does |
|---|---|
| Leakage in a model's self-check | Retrain without the leaky columns |
| Model rejected by the independent validation gate | Retrain with a tuned model |
| An ID-like column dominating the explanation | Retrain without it |
| A dashboard that didn't render, or an unexplained failure | One fresh attempt |
| Work blocked by a step being fixed | Redo it after the fix |
| Wrong input (missing column, etc.) | Report only; a redo can't fix it |
| Self-healing already tried a repair | Never repeated |

**2. AI check** (one call, `/api/swarm/review`, only with a key): do the results answer the request? Anything missing becomes a corrective task, validated against the data like any plan.

**3. One round, at most 6 fixes, normal approvals.** Redone tasks replace the originals in the status. A fix counts only if its own independent review agrees. Otherwise the review says plainly that the problem remains (for example, the data may not hold enough signal).

**AI calls per request: at most two** (planning + final check), and zero for requests the rules handle when no key is set.

**Limits:**

| Limit | Old | New |
|---|---|---|
| Tasks | 20 | 40 |
| Added while running | 8 | 14 |
| Independent reviews | 6 | 8 |
| Repairs | 1 per task, 3 per run | unchanged |
| Backend jobs at once | 2 | unchanged |

*Why:* enough for a full analysis on any of the samples; small enough that one request can't run for an hour.

---

## 8. Seeing the team

- **Agents panel → Team:** every agent with its colour, mission, what it knows, its playbook and its capabilities.
- **Runs:** each task line already shows the agent. The completion report now also groups work by step ("Clean: 3 tasks · Statistics: 2 · …") so long runs read easily.

---

## 9. Mobile (done as part of this work)

The page shifted left on later steps because the app scrolled the step bar with `scrollIntoView`, which also scrolled the page sideways. The toolbar was also wider than a phone. Fixes:
- only the step bar scrolls;
- the page can't scroll sideways (`overflow-x: clip`);
- the toolbar's less-used controls move into a **More** menu on phones (and the Beginner/Expert switch too, under 380px);
- the dashboard's data-table search field shrinks.

Checked at 320, 390 and 768 px on every step. After the agent work, a full agent run on a phone viewport re-checks every step with its results showing.

---

## 10. Tests

- **Skills:**
  - every capability has one owner with a skill sheet;
  - every agent owns at least one capability;
  - no agent without a real capability.
- **Planner:**
  - a full analysis covers all seven steps;
  - parsing for dashboard, drivers, segments, tuning, sample, filter and summarise requests;
  - no target guessed when nothing looks like an outcome.
- **Dashboard designer (chart grammar):**
  - IDs are never axes;
  - pies have ≤ 6 slices;
  - time → line;
  - ≤ 8 charts;
  - mentioned columns come first;
  - with no wording, the outcome drives the breakdown.
- **stats.screen:** Holm order and ranking, with a fake engine.
- **models.cluster:** finds k = 3 on three clear blobs.
- **Runtime:** a ~20-task full analysis completes with the fake studio; follow-ups stay within limits.
- **Coverage:** the existing test extended to the new page controls.
- **Browser:**
  - a full analysis on desktop through every step, with cursors, the dashboard built from the request, and Undo;
  - a dashboard-only request ("dashboard of charges by contract over time");
  - every step on a phone after the run.

---

## 11. Implementation notes (what changed while building)

- **Clustering:** k-means picked starting points from evenly spaced rows, so sorted data could put every starting point in one group. It now also tries spread-out "farthest point" seeds and keeps the tighter result. This also improves the Model step's own clustering.
- **Outcome detection:** the old pattern treated any name ending in "y" (salary, city) as an outcome; that's fixed.
- **Dashboard:** it now holds several charts of one type (two bar charts by different dimensions). Agent designs are queued until the dashboard's own first load finishes, so a reopened saved dashboard or a slower AI suggestion can't overwrite them.
- **Box plot:** it showed `false` groups as "Unknown"; fixed.
- **Explainability:** a dominant feature is flagged only when 4+ inputs share the weight (with three inputs, one naturally dominates).
