import React from 'react';
import { PipelineStage } from '../contexts/PipelineContext';
import { STAGES, STAGE_ORDER } from '../stages';

interface StageHeaderProps {
  activeTab: PipelineStage;
}

/** Large-title header for the current stage: where you are, and what it's for. */
export default function StageHeader({ activeTab }: StageHeaderProps) {
  const stage = STAGES[activeTab];
  if (!stage) return null;

  return (
    <header className="mb-8 sm:mb-10">
      <p className="text-sm font-medium text-label-2">
        Step {STAGE_ORDER.indexOf(activeTab) + 1} of {STAGE_ORDER.length}
      </p>
      <h1 className="mt-1 text-[32px] sm:text-[40px] leading-[1.1] font-semibold tracking-tight text-label">
        {stage.title}
      </h1>
      <p className="mt-3 text-base sm:text-[19px] sm:leading-[1.42] text-label-2 max-w-2xl">
        {stage.description}
      </p>
    </header>
  );
}
