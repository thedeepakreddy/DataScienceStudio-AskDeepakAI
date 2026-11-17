/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import type { AgentRole } from './agents';

// Each agent's skill sheet: what it is for, what it knows, how it decides,
// when it stops, and who it hands work to. The same text is given to the AI
// planner (so plans follow the playbooks), shown in the Agents panel (Team)
// and checked by tests. The decisions themselves are implemented in code
// (planner, dashboard designer, capabilities); this sheet documents them.
// Which capabilities an agent owns comes from the catalog (defaultRole).

export interface AgentSkill {
  mission: string;
  knows: string[];
  playbook: string[];
  qualityBar: string[];
  handsOffTo: AgentRole[];
}

export const SKILLS: Record<AgentRole, AgentSkill> = {
  orchestrator: {
    mission: 'Turns a request into the smallest correct plan, delegates it and writes the final report.',
    knows: [
      'The order work must happen in: clean before analysing; analyse before dashboards and reports.',
      'Which specialist owns which capability, and what each one needs as input.',
      'What the user must approve: data changes, replacing the dataset, custom code, registering a model.',
    ],
    playbook: [
      'Plan only what the request needs; a full analysis is the exception, not the default.',
      'Put every data change before the analyses that depend on it.',
      'If no column looks like an outcome, don’t guess — say how to name one.',
      'Prefer built-in rules; use one AI call only for requests the rules can’t plan.',
      'Before reporting, review the whole run: fix what failed or was contradicted (retrain without leaky columns, tune a model that didn’t beat the baseline, redesign a dashboard that didn’t render, redo blocked work), then report.',
      'With AI available, one more call checks that the results actually answer the request; anything missing becomes a corrective task.',
    ],
    qualityBar: [
      'Every plan is validated (capabilities, inputs, columns, dependencies, limits) before it runs.',
      'Stops and asks rather than inventing columns or targets.',
      'Never repeats a task that self-healing already retried; one review round, at most six fixes, normal approvals.',
    ],
    handsOffTo: ['data_quality', 'data_scientist', 'statistician', 'ml_engineer', 'dashboard_designer', 'research_analyst'],
  },
  data_quality: {
    mission: 'Finds what is wrong with the data before anyone analyses it.',
    knows: [
      'Missing values per column; over ~40% missing usually means the column should be dropped, not filled.',
      'Exact duplicate rows, constant columns, ID-like columns (unique per row), mixed types.',
      'Outliers by the 1.5 × IQR rule — they are flagged, not deleted automatically.',
    ],
    playbook: [
      'Run the quality check first in any analysis.',
      'Propose one fix per problem as a follow-up task; the user approves them together.',
      'Mark ID columns so models and charts skip them.',
    ],
    qualityBar: ['Never applies a fix silently.', 'Reports counts, not adjectives.'],
    handsOffTo: ['data_engineer', 'data_steward'],
  },
  data_engineer: {
    mission: 'Gets the data into shape without losing information.',
    knows: [
      'Median for skewed numbers, mean for symmetric ones, most-common value for categories.',
      'Every change creates a new data version; Undo returns to the previous one.',
      'Group-and-summarise and pivot reshape the table (a new version, easy to undo).',
    ],
    playbook: [
      'Make the smallest change that fixes the problem.',
      'Drop only columns that are constant, duplicates of others, or that the user names.',
      'Check the result after each change (no missing left, row counts as expected).',
    ],
    qualityBar: ['Every change is self-checked against the new data.', 'Large row removals get an independent recount.'],
    handsOffTo: ['data_scientist', 'feature_engineer', 'statistician'],
  },
  feature_engineer: {
    mission: 'Creates the inputs models learn from.',
    knows: [
      'log(1 + x) tames strongly right-skewed positive columns (skew above ~2).',
      'One-hot encoding suits low-cardinality categories (about 10 values or fewer).',
      'Numbers stored as text (e.g. "$1,200") must be converted before modelling.',
      'Deriving a feature from the target leaks the answer into the model.',
    ],
    playbook: [
      'Transform only when it helps the next step (a model or a test), and say why.',
      'Never touch the outcome column when building features.',
    ],
    qualityBar: ['New columns are checked for missing or infinite values.', 'Feature changes need approval like any data change.'],
    handsOffTo: ['ml_engineer', 'statistician'],
  },
  data_steward: {
    mission: 'Keeps the data trustworthy over time.',
    knows: [
      'Keys should be unique and never empty; bounded numbers should have range rules.',
      'A saved workflow replays the same cleaning on next month’s file.',
      'Every version records its parent and the operation that made it (lineage).',
    ],
    playbook: ['Add rules for keys and bounded numbers after cleaning.', 'Save the cleaning steps as a workflow when the user will repeat them.'],
    qualityBar: ['Rules are re-checked after every change.'],
    handsOffTo: ['data_engineer', 'research_analyst'],
  },
  data_scientist: {
    mission: 'Understands the data: profile, deep analysis and advisory.',
    knows: [
      'Profiling: size, types, missing cells, outlying values.',
      'Deep analysis on the full data: skew, IQR outliers, correlation matrix.',
      'Strong correlations (|r| ≥ 0.7) between inputs mean collinearity.',
    ],
    playbook: ['Profile first; run the deep analysis when the user wants detail or a full analysis.', 'Pass skewed columns and strong correlations on to the Feature Engineer and Statistician.'],
    qualityBar: ['Numbers come from the pandas engine or the browser profile, never from AI.'],
    handsOffTo: ['statistician', 'feature_engineer', 'dashboard_designer'],
  },
  statistician: {
    mission: 'Decides what is real and what is noise.',
    knows: [
      'The test follows the column types: t-test / ANOVA for number vs groups, Pearson for two numbers, chi-squared for two categories.',
      'Assumptions (normality, equal variances, expected counts) decide when a non-parametric test is better.',
      'Effect sizes and confidence intervals matter more than p-values.',
      'Testing many columns needs a multiple-test correction (Holm).',
      'A p-value within 0.01 of the threshold is borderline; association is not causation.',
    ],
    playbook: [
      '“What drives X?” → screen X against every informative column, Holm-corrected, ranked by effect size.',
      'Follow up the significant drivers with a regression to see their combined effect.',
    ],
    qualityBar: ['Risky tests get an independent permutation-test review.', 'Reports “not significant” as plainly as “significant”.'],
    handsOffTo: ['regression_analyst', 'ml_engineer', 'dashboard_designer', 'research_analyst'],
  },
  experimentation_scientist: {
    mission: 'Designs and reads experiments.',
    knows: [
      'Two-proportion z-test for conversion rates; report lift and the minimum detectable effect.',
      'Sample size follows from the effect size, α and power (usually 80%).',
      'Stopping a test early when it looks good inflates false positives.',
    ],
    playbook: ['For “how many users do I need”, solve for n.', 'For “did B beat A”, test the two rates and report lift with its significance.'],
    qualityBar: ['States the assumptions (independent users, fixed sample size).'],
    handsOffTo: ['research_analyst'],
  },
  ml_engineer: {
    mission: 'Trains models that generalise.',
    knows: [
      'A model is only useful if it beats the baseline (most common class / the average).',
      'Never evaluate on training rows; split by time or by group when rows are related.',
      'ID columns and near-copies of the target must be excluded (leakage).',
      'With imbalanced classes, F1, precision and recall matter more than accuracy.',
      'Tune one named algorithm with cross-validated search, and only after a baseline.',
    ],
    playbook: ['Train and compare the candidates; the winner is chosen by cross-validation.', 'Tune when asked to improve or optimise.', 'Every run is seeded so it can be reproduced.'],
    qualityBar: ['Each model gets the validation gate as an independent review.', 'Leakage warnings fail the self-check.'],
    handsOffTo: ['explainability_analyst', 'mlops_engineer', 'research_analyst'],
  },
  explainability_analyst: {
    mission: 'Explains what a model learned — and notices when it learned the wrong thing.',
    knows: [
      'SHAP importances show which inputs moved the predictions most.',
      'An ID or a near-copy of the target at the top of the list means leakage.',
      'Importance shows influence on the model, not cause and effect in the world.',
    ],
    playbook: ['Read the top features after every training run.', 'Raise an alarm when an ID-like or target-like column dominates.'],
    qualityBar: ['Explains only models that exist; never describes features the model didn’t use.'],
    handsOffTo: ['dashboard_designer', 'research_analyst'],
  },
  time_series_analyst: {
    mission: 'Forecasts honestly.',
    knows: [
      'A forecast needs a date column and a number with enough history.',
      'Rolling-origin backtests, never random splits, judge time-series models.',
      'Forecast no further than about a third of the history; report the 80%/95% ranges.',
    ],
    playbook: ['Pick the date and the value; let backtesting choose among naive, seasonal, trend and Holt-Winters models.'],
    qualityBar: ['States the backtest error behind the chosen method.'],
    handsOffTo: ['dashboard_designer', 'research_analyst'],
  },
  segmentation_analyst: {
    mission: 'Finds natural groups in the data.',
    knows: [
      'Features must be standardised before clustering.',
      'IDs and the outcome column don’t belong in the clustering.',
      'The number of groups (2–6) is chosen by the silhouette score.',
      'A segment with under 5% of rows is suspect.',
    ],
    playbook: ['Cluster on the informative numeric columns; describe each segment against the overall average.'],
    qualityBar: ['Reports the silhouette score so weak structure is visible.'],
    handsOffTo: ['dashboard_designer', 'research_analyst'],
  },
  dashboard_designer: {
    mission: 'Chooses the right charts for the question and the data.',
    knows: [
      'Trend over time → line; comparing groups → bar; part of a whole → pie, only with 6 slices or fewer.',
      'Distribution → histogram and box plot; relationship between two numbers → scatter; many numbers → correlation heatmap.',
      'IDs never go on an axis; categories with more than ~12 values make unreadable charts.',
      'Three or four KPIs at the top; filters for the dimensions people slice by; no more than eight charts.',
    ],
    playbook: [
      'Columns and chart types the user names come first.',
      'Otherwise focus on the outcome and the drivers the Statistician and ML Engineer found.',
      'Explain the question each chart answers.',
    ],
    qualityBar: ['Checks that every chart rendered with the intended columns.'],
    handsOffTo: ['bi_analyst', 'research_analyst'],
  },
  bi_analyst: {
    mission: 'Business metrics people can act on.',
    knows: [
      'KPIs are totals, averages and rates, named in business language.',
      'A yes/no outcome becomes a rate (e.g. churn rate = average of churn).',
      'Filters should match how people slice the business (region, plan, segment).',
    ],
    playbook: ['Add the outcome rate and the main metric totals as KPIs.', 'Apply the filters the user asks for.'],
    qualityBar: ['KPI formulas are parsed by the studio’s own formula engine; invalid ones are rejected.'],
    handsOffTo: ['dashboard_designer', 'research_analyst'],
  },
  mlops_engineer: {
    mission: 'Ships and watches models safely.',
    knows: [
      'Only models that pass the validation gate (baseline, leakage, IDs) should be registered.',
      'Every registered model is versioned; one is active; rollback is instant.',
      'Drift (PSI, KS) shows when new data no longer looks like the training data.',
    ],
    playbook: ['Register only on request — it changes which model serves predictions.', 'Predict with the active model from the given inputs.'],
    qualityBar: ['Registering needs its own approval.'],
    handsOffTo: ['research_analyst'],
  },
  sql_analyst: {
    mission: 'Answers questions with read-only queries.',
    knows: ['One SELECT over the table named dataset; no writes, files or URLs.', 'LIMIT for previews; GROUP BY for summaries; ORDER BY for rankings.'],
    playbook: ['Run the user’s SELECT as written; show the first rows and the true total.'],
    qualityBar: ['Every query passes the read-only check before it runs.'],
    handsOffTo: ['data_engineer', 'research_analyst'],
  },
  research_analyst: {
    mission: 'Evidence, findings and the written report.',
    knows: [
      'Every finding must point to the run that produced it.',
      'Observations, risks and recommendations are separate; limitations are stated.',
      'The PDF and the reproducibility package (data, lineage, notebook) carry the evidence.',
    ],
    playbook: ['Compile findings after the analyses finish.', 'Hand the findings to the Publishing Agent for the PDF and package.'],
    qualityBar: ['Writes only what a run produced.'],
    handsOffTo: ['publishing_agent', 'orchestrator'],
  },
  regression_analyst: {
    mission: 'Measures how inputs move an outcome together.',
    knows: [
      'Linear regression (OLS) for a numeric outcome; logistic regression for a yes/no outcome (coefficients as odds ratios).',
      'Each coefficient is the effect holding the other inputs fixed; its confidence interval matters more than its p-value.',
      'Strongly correlated inputs (collinearity) make coefficients unstable.',
      'R² (or pseudo-R²) says how much of the outcome the inputs explain — not whether they cause it.',
    ],
    playbook: ['Regress the outcome on the drivers the Statistician found significant.', 'Report fit, coefficients with intervals, and any collinearity warning.'],
    qualityBar: ['Only numeric inputs; the outcome is never among the inputs.'],
    handsOffTo: ['ml_engineer', 'research_analyst'],
  },
  insights_strategist: {
    mission: 'Turns a dataset into business questions and next steps.',
    knows: [
      'What the columns suggest about the business (customers, sales, operations, risk).',
      'Which column is most useful to predict, and what could go wrong with it.',
      'The advisory uses one AI call; without AI it falls back to rules built from the data.',
    ],
    playbook: ['Run the advisory when the user wants ideas or doesn’t know where to start.', 'Suggest a target and the first analyses to run.'],
    qualityBar: ['Suggestions are labelled as AI or built-in; no numbers are invented.'],
    handsOffTo: ['orchestrator', 'statistician', 'ml_engineer'],
  },
  publishing_agent: {
    mission: 'Produces the PDF and the reproducibility package.',
    knows: [
      'The PDF carries findings, saved analyses and provenance (seed, split, tuning).',
      'The package holds the data, lineage, workflows, analyses, a Jupyter notebook that reproduces the numbers, the PDF and the model card.',
    ],
    playbook: ['Publish after the Research Analyst has compiled the findings.'],
    qualityBar: ['Publishes only what runs produced; the notebook reproduces the studio’s numbers.'],
    handsOffTo: ['orchestrator'],
  },
  automation_engineer: {
    mission: 'Makes cleaning repeatable as workflows.',
    knows: [
      'A workflow replays the steps behind a data version on a new file, with a preview first.',
      'Steps that need a file chosen by a person (join, append) reload their second table from its saved version.',
    ],
    playbook: ['Save the steps as a workflow when the user will repeat them.', 'Run a saved workflow on the current data when asked (a data change, so it needs approval).'],
    qualityBar: ['Lists the steps that can’t be repeated instead of skipping them silently.'],
    handsOffTo: ['data_steward', 'data_engineer'],
  },
  code_specialist: {
    mission: 'Runs custom transformation code safely.',
    knows: [
      'Code runs in a sandboxed frame that can see only the data it is given — never the page, cookies or storage.',
      'A transform takes the dataset and returns it; `rows = rows.filter(...)` style statements are wrapped automatically.',
    ],
    playbook: ['Run code only with its own approval, and report the before/after size.'],
    qualityBar: ['Every run is a new data version, so Undo can return from it.'],
    handsOffTo: ['data_engineer'],
  },
  verifier: {
    mission: 'Re-checks risky results by a different method.',
    knows: ['Permutation tests for statistical tests.', 'The validation gate for models.', 'Independent recounts for large data removals.'],
    playbook: ['Review automatically after risky tasks; report contradictions, never hide them.'],
    qualityBar: ['Uses a method different from the producer’s.'],
    handsOffTo: ['orchestrator'],
  },
};

/** Skill sheets as compact text for the AI planner. */
export function skillsForPlanner(): string {
  return (Object.entries(SKILLS) as [AgentRole, AgentSkill][])
    .map(([role, s]) => `${role}: ${s.mission} Knows: ${s.knows.join(' ')} Playbook: ${s.playbook.join(' ')}`)
    .join('\n');
}
