/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

// The swarm's specialists. A role is expertise, not a permission: any role may
// use any capability the task contract allows (blueprint 4.1). Roles share the
// same runtime code; none of them calls AI just for having a role (6.5).

export type AgentRole =
  | 'orchestrator' | 'data_engineer' | 'data_scientist' | 'statistician' | 'ml_engineer'
  | 'bi_analyst' | 'research_analyst' | 'data_quality' | 'verifier'
  // Specialists added in v3 (see docs/AGENTS_PLAN.md for why each exists).
  | 'dashboard_designer' | 'feature_engineer' | 'time_series_analyst' | 'segmentation_analyst'
  | 'explainability_analyst' | 'experimentation_scientist' | 'mlops_engineer' | 'data_steward' | 'sql_analyst'
  | 'regression_analyst' | 'insights_strategist' | 'publishing_agent' | 'automation_engineer' | 'code_specialist';

export interface AgentProfile {
  role: AgentRole;
  name: string;
  /** Short description of what it is responsible for. */
  focus: string;
  /** Cursor / badge colour (CSS variable, a muted rich tone), used by the visual layer. */
  color: string;
}

export const AGENTS: Record<AgentRole, AgentProfile> = {
  orchestrator: { role: 'orchestrator', name: 'Orchestrator', focus: 'Plans the work, delegates it and writes the final report.', color: 'var(--agent-orchestrator)' },
  data_engineer: { role: 'data_engineer', name: 'Data Engineer', focus: 'Cleaning, transformations and data versions.', color: 'var(--agent-data-engineer)' },
  data_scientist: { role: 'data_scientist', name: 'Data Scientist', focus: 'Exploration, profiling and forecasting.', color: 'var(--agent-data-scientist)' },
  statistician: { role: 'statistician', name: 'Statistician', focus: 'Tests, assumptions and uncertainty.', color: 'var(--agent-statistician)' },
  ml_engineer: { role: 'ml_engineer', name: 'ML Engineer', focus: 'Training, evaluation and reproducibility.', color: 'var(--agent-ml-engineer)' },
  bi_analyst: { role: 'bi_analyst', name: 'BI Analyst', focus: 'Dashboards and business-facing views.', color: 'var(--agent-bi-analyst)' },
  research_analyst: { role: 'research_analyst', name: 'Research Analyst', focus: 'Reports and evidence.', color: 'var(--agent-research-analyst)' },
  data_quality: { role: 'data_quality', name: 'Data Quality Agent', focus: 'Missing values, duplicates, leakage and consistency.', color: 'var(--agent-data-quality)' },
  verifier: { role: 'verifier', name: 'Verification Agent', focus: 'Independent checks of risky results.', color: 'var(--agent-verifier)' },
  dashboard_designer: { role: 'dashboard_designer', name: 'Dashboard Designer', focus: 'Chooses the right charts for the question and the data.', color: 'var(--agent-dashboard-designer)' },
  feature_engineer: { role: 'feature_engineer', name: 'Feature Engineer', focus: 'Creates the inputs models learn from.', color: 'var(--agent-feature-engineer)' },
  time_series_analyst: { role: 'time_series_analyst', name: 'Time-Series Analyst', focus: 'Forecasts with honest backtests.', color: 'var(--agent-time-series)' },
  segmentation_analyst: { role: 'segmentation_analyst', name: 'Segmentation Analyst', focus: 'Finds natural groups in the data.', color: 'var(--agent-segmentation)' },
  explainability_analyst: { role: 'explainability_analyst', name: 'Explainability Analyst', focus: 'Explains what a model learned.', color: 'var(--agent-explainability)' },
  experimentation_scientist: { role: 'experimentation_scientist', name: 'Experimentation Scientist', focus: 'Designs and reads experiments.', color: 'var(--agent-experimentation)' },
  mlops_engineer: { role: 'mlops_engineer', name: 'MLOps Engineer', focus: 'Ships and watches models safely.', color: 'var(--agent-mlops)' },
  data_steward: { role: 'data_steward', name: 'Data Steward', focus: 'Rules, repeatable workflows and lineage.', color: 'var(--agent-data-steward)' },
  sql_analyst: { role: 'sql_analyst', name: 'SQL Analyst', focus: 'Answers questions with read-only queries.', color: 'var(--agent-sql)' },
  regression_analyst: { role: 'regression_analyst', name: 'Regression Analyst', focus: 'Measures how inputs move an outcome together.', color: 'var(--agent-regression)' },
  insights_strategist: { role: 'insights_strategist', name: 'Insights Strategist', focus: 'Turns a dataset into business questions and next steps.', color: 'var(--agent-insights)' },
  publishing_agent: { role: 'publishing_agent', name: 'Publishing Agent', focus: 'Produces the PDF and the reproducibility package.', color: 'var(--agent-publishing)' },
  automation_engineer: { role: 'automation_engineer', name: 'Automation Engineer', focus: 'Makes cleaning repeatable as workflows.', color: 'var(--agent-automation)' },
  code_specialist: { role: 'code_specialist', name: 'Code Specialist', focus: 'Runs custom transformation code safely.', color: 'var(--agent-code)' },
};

export const isAgentRole = (v: unknown): v is AgentRole => typeof v === 'string' && v in AGENTS;
