/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { FolderOpen, Sparkles, Compass, Sigma, Cpu, LayoutGrid, FileText, type LucideIcon } from 'lucide-react';
import type { PipelineStage } from './contexts/PipelineContext';

export interface StageMeta {
  /** Short name used in navigation. */
  label: string;
  /** Large page title. */
  title: string;
  description: string;
  icon: LucideIcon;
  /** Shown when the stage's key action hasn't been done yet. Never blocks. */
  hint?: string;
}

/** The workflow, in order. Single source of truth for navigation and headers. */
export const STAGE_ORDER: PipelineStage[] = ['ingest', 'clean', 'eda', 'stats', 'ml', 'dashboard', 'reports'];

export const STAGES: Record<PipelineStage, StageMeta> = {
  ingest: {
    label: 'Import',
    title: 'Import your data',
    description: 'Upload a CSV, Excel, JSON or Parquet file, or start with a sample. Add a goal and the studio will tailor every step to it.',
    icon: FolderOpen,
    hint: 'Choose a dataset to get started.',
  },
  clean: {
    label: 'Clean',
    title: 'Clean and prepare',
    description: 'Fill gaps, drop what you don’t need, and run a quality audit before you analyze.',
    icon: Sparkles,
    hint: 'Tip: run the quality audit to catch hidden issues.',
  },
  eda: {
    label: 'Explore',
    title: 'Explore your data',
    description: 'See distributions, correlations and data quality at a glance, then ask AI for strategic insights.',
    icon: Compass,
    hint: 'Tip: run the AI advisory for a recommended target and features.',
  },
  stats: {
    label: 'Statistics',
    title: 'Test with statistics',
    description: 'Check whether a difference or relationship in your data is real or could be chance, with proper statistical tests.',
    icon: Sigma,
    hint: 'Tip: test a hypothesis before you rely on a pattern.',
  },
  ml: {
    label: 'Model',
    title: 'Model and decide',
    description: 'Predict an outcome with real machine-learning models, see why they predict what they do, put them to work, and forecast or optimise decisions.',
    icon: Cpu,
    hint: 'Modeling is optional — you can continue without training.',
  },
  dashboard: {
    label: 'Dashboard',
    title: 'Dashboard',
    description: 'An interactive summary of your data. Filter and slice to see it from different angles.',
    icon: LayoutGrid,
  },
  reports: {
    label: 'Report',
    title: 'Report',
    description: 'A stakeholder-ready summary of findings, model results and recommendations. Export it as a PDF.',
    icon: FileText,
  },
};
