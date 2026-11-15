/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { FolderOpen, Sparkles, Compass, Cpu, LayoutGrid, FileText, type LucideIcon } from 'lucide-react';
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
export const STAGE_ORDER: PipelineStage[] = ['ingest', 'clean', 'eda', 'ml', 'dashboard', 'reports'];

export const STAGES: Record<PipelineStage, StageMeta> = {
  ingest: {
    label: 'Import',
    title: 'Import your data',
    description: 'Upload a CSV or start with a sample. Add a goal and the studio will tailor every step to it.',
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
  ml: {
    label: 'Model',
    title: 'Train a model',
    description: 'Pick what to predict and train real scikit-learn and XGBoost models on your data.',
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
