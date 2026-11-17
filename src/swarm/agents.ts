/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

// The swarm's specialists. A role is expertise, not a permission: any role may
// use any capability the task contract allows (blueprint 4.1). Roles share the
// same runtime code; none of them calls AI just for having a role (6.5).

export type AgentRole =
  | 'orchestrator' | 'data_engineer' | 'data_scientist' | 'statistician' | 'ml_engineer'
  | 'bi_analyst' | 'research_analyst' | 'data_quality' | 'verifier';

export interface AgentProfile {
  role: AgentRole;
  name: string;
  /** Short description of what it is responsible for. */
  focus: string;
  /** Cursor / badge colour (CSS variable), used by the visual layer. */
  color: string;
}

export const AGENTS: Record<AgentRole, AgentProfile> = {
  orchestrator: { role: 'orchestrator', name: 'Orchestrator', focus: 'Plans the work, delegates it and writes the final report.', color: 'var(--blue)' },
  data_engineer: { role: 'data_engineer', name: 'Data Engineer', focus: 'Cleaning, transformations and data versions.', color: 'var(--orange)' },
  data_scientist: { role: 'data_scientist', name: 'Data Scientist', focus: 'Exploration, profiling and forecasting.', color: 'var(--purple)' },
  statistician: { role: 'statistician', name: 'Statistician', focus: 'Tests, assumptions and uncertainty.', color: 'var(--teal)' },
  ml_engineer: { role: 'ml_engineer', name: 'ML Engineer', focus: 'Training, evaluation and reproducibility.', color: 'var(--pink)' },
  bi_analyst: { role: 'bi_analyst', name: 'BI Analyst', focus: 'Dashboards and business-facing views.', color: 'var(--chart-6)' },
  research_analyst: { role: 'research_analyst', name: 'Research Analyst', focus: 'Reports and evidence.', color: 'var(--green)' },
  data_quality: { role: 'data_quality', name: 'Data Quality Agent', focus: 'Missing values, duplicates, leakage and consistency.', color: 'var(--yellow)' },
  verifier: { role: 'verifier', name: 'Verification Agent', focus: 'Independent checks of risky results.', color: 'var(--red)' },
};

export const isAgentRole = (v: unknown): v is AgentRole => typeof v === 'string' && v in AGENTS;
