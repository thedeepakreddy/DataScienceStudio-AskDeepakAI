import React from 'react';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { PipelineStage } from '../contexts/PipelineContext';
import { STAGES, STAGE_ORDER } from '../stages';

interface StageNavigationProps {
  activeTab: PipelineStage;
  setActiveTab: (tab: PipelineStage) => void;
  /** False until a dataset is loaded — the only hard requirement to move on. */
  canContinue: boolean;
  /** Whether the current stage's key action has been done. */
  stageComplete: boolean;
}

/**
 * Back / Continue footer. Moving forward is never blocked once data is loaded;
 * if the stage's key action hasn't been run, a quiet hint says what's worth
 * doing first.
 */
export default function StageNavigation({ activeTab, setActiveTab, canContinue, stageComplete }: StageNavigationProps) {
  const index = STAGE_ORDER.indexOf(activeTab);
  const prev = index > 0 ? STAGE_ORDER[index - 1] : null;
  const next = index < STAGE_ORDER.length - 1 ? STAGE_ORDER[index + 1] : null;
  const hint = !stageComplete ? STAGES[activeTab].hint : undefined;

  return (
    <nav
      aria-label="Step navigation"
      className="mt-12 pt-6 border-t border-separator flex flex-wrap items-center justify-between gap-x-4 gap-y-3"
    >
      {prev ? (
        <button type="button" onClick={() => setActiveTab(prev)} className="btn btn-plain -ml-2">
          <ChevronLeft className="w-4 h-4" />
          {STAGES[prev].label}
        </button>
      ) : (
        <span />
      )}

      <div className="flex items-center gap-4 ml-auto">
        {hint && next && <p className="hidden sm:block text-sm text-label-2 text-right">{hint}</p>}
        {next && (
          <button
            type="button"
            onClick={() => setActiveTab(next)}
            disabled={!canContinue}
            className={`btn btn-lg ${stageComplete ? 'btn-primary' : 'btn-secondary'}`}
          >
            Continue to {STAGES[next].label}
            <ChevronRight className="w-4 h-4" />
          </button>
        )}
      </div>
    </nav>
  );
}
