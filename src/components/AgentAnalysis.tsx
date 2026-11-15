import React, { useState } from 'react';
import { Bot, Loader2, AlertCircle, CheckCircle2, XCircle, Sparkles, ShieldCheck, ArrowRight } from 'lucide-react';
import { Dataset, AgentRunResult, AgentStep } from '../types';
import { apiFetch } from '../utils/api';

interface AgentAnalysisProps {
  dataset: Dataset;
  target: string;
  features: string[];
  championModelKey: string;
  primaryMetric: string;
  primaryMetricValue: number;
}

const WHITELISTED_FUNCTIONS = ['retrain_with_transform', 'drop_feature', 'check_multicollinearity'];

export default function AgentAnalysis({ dataset, target, features, championModelKey, primaryMetric, primaryMetricValue }: AgentAnalysisProps) {
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<AgentRunResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  const runAgent = async () => {
    setLoading(true);
    setError(null);
    setResult(null);
    try {
      const resp = await apiFetch('/api/agent/run', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ data: dataset.rows, target, features, modelKey: championModelKey, primaryMetric, primaryMetricValue }),
      });
      const data = await resp.json();
      if (!resp.ok) {
        throw new Error(data.error || `Server responded with ${resp.status}`);
      }
      setResult(data);
    } catch (err: any) {
      setError(err.message || 'Agent run failed — is the ML compute service running?');
    } finally {
      setLoading(false);
    }
  };

  const stopReasonLabel = (reason: string, maxSteps: number) => {
    switch (reason) {
      case 'cap_reached': return `Stopped: reached the ${maxSteps}-step cap.`;
      case 'plateau': return 'Stopped: improvement plateaued (latest gain under 1%).';
      case 'agent_declared_done': return 'Stopped: the agent judged further steps unlikely to help.';
      case 'no_action_proposed': return 'Stopped: the model did not propose an action.';
      case 'error': return 'Stopped: a reasoning call failed.';
      default: return reason;
    }
  };

  const pctChange = result && result.startingMetricValue !== 0
    ? ((result.finalPrimaryMetricValue - result.startingMetricValue) / Math.abs(result.startingMetricValue)) * 100
    : 0;

  return (
    <div className="space-y-6 animate-fade-in">
      <div className="bg-surface border border-separator rounded-xl p-6 sm:p-8">
        <div className="flex items-start gap-4 mb-6">
          <div className="w-12 h-12 bg-blue/10 rounded-2xl flex items-center justify-center border border-blue/20 shrink-0">
            <Bot className="w-6 h-6 text-blue" />
          </div>
          <div>
            <h3 className="text-lg font-semibold text-label">AI agent analysis</h3>
            <p className="text-sm text-label-2 mt-1 max-w-2xl">
              Gemini reasons over the champion model's real metrics and a real EDA summary, then executes real
              diagnostic/fix steps against the ML service — a reason → act → observe loop, not a single-shot chat wrapper.
            </p>
          </div>
        </div>

        <div className="bg-well border border-separator rounded-xl p-4 mb-6 text-xs">
          <div className="flex items-center gap-2 text-label-2 font-medium mb-2">
            <ShieldCheck className="w-3.5 h-3.5 text-green" /> Guardrails
          </div>
          <p className="text-label-2 leading-relaxed">
            The agent can only call a fixed, whitelisted set of real functions — <span className="tabular-nums text-blue">{WHITELISTED_FUNCTIONS.join(', ')}</span> — never arbitrary code. It stops after at most 5 steps, or sooner if improvement plateaus or it judges itself done.
          </p>
        </div>

        {!result && !loading && (
          <button
            onClick={runAgent}
            className="bg-blue hover:bg-blue text-white font-semibold text-sm py-3 px-6 rounded-xl flex items-center justify-center gap-2 shadow-sm"
          >
            <Sparkles className="w-4 h-4" /> Run AI agent analysis
          </button>
        )}

        {loading && (
          <div className="py-8 flex flex-col items-center justify-center">
            <Loader2 className="w-8 h-8 text-blue animate-spin mb-4" />
            <p className="text-sm font-semibold text-blue">Agent is reasoning and executing real diagnostic steps...</p>
            <p className="text-xs text-label-3 mt-1">This runs several real retrains — it can take up to a minute.</p>
          </div>
        )}

        {error && (
          <div className="p-4 bg-red/10 border border-red/20 text-red rounded-xl text-xs flex items-start gap-3">
            <AlertCircle className="w-4 h-4 text-red shrink-0 mt-0.5" />
            <p>{error}</p>
          </div>
        )}

        {result && (
          <div className="space-y-5">
            <div className="bg-blue/10 border border-blue/20 rounded-xl p-4 flex flex-wrap items-center gap-4">
              <div>
                <p className="text-[11px] text-label-2 tabular-nums">Starting {primaryMetric}</p>
                <p className="text-lg font-semibold text-label tabular-nums">{result.startingMetricValue.toFixed(4)}</p>
              </div>
              <ArrowRight className="w-5 h-5 text-label-3 shrink-0" />
              <div>
                <p className="text-[11px] text-label-2 tabular-nums">Final {primaryMetric}</p>
                <p className={`text-lg font-semibold tabular-nums ${pctChange > 0 ? 'text-green' : pctChange < 0 ? 'text-red' : 'text-label'}`}>
                  {result.finalPrimaryMetricValue.toFixed(4)}{pctChange !== 0 && <span className="text-xs ml-1">({pctChange > 0 ? '+' : ''}{pctChange.toFixed(1)}%)</span>}
                </p>
              </div>
              <div className="text-xs text-label-2 bg-surface border border-separator rounded-lg px-3 py-2">
                {stopReasonLabel(result.stopReason, result.maxSteps)}
              </div>
              <button onClick={runAgent} className="text-xs font-semibold text-blue hover:text-blue flex items-center gap-1.5 ml-auto">
                <Sparkles className="w-3.5 h-3.5" /> Run Again
              </button>
            </div>

            <div className="space-y-3">
              {result.steps.map((step, idx) => (
                <AgentStepCard key={idx} step={step} primaryMetric={primaryMetric} />
              ))}
              {result.steps.length === 0 && (
                <p className="text-xs text-label-3 text-center py-4">The agent proposed no steps this run.</p>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

interface AgentStepCardProps {
  step: AgentStep;
  primaryMetric: string;
}

const AgentStepCard: React.FC<AgentStepCardProps> = ({ step, primaryMetric }) => {
  if (step.error) {
    return (
      <div className="bg-red/5 border border-red/20 rounded-xl p-4 flex items-start gap-3">
        <XCircle className="w-5 h-5 text-red shrink-0 mt-0.5" />
        <div className="text-xs">
          <p className="font-semibold text-red">Step {step.step}: failed</p>
          <p className="text-label-2 mt-1">{step.error}</p>
        </div>
      </div>
    );
  }

  if (step.tool === 'declare_done') {
    return (
      <div className="bg-well border border-separator rounded-xl p-4 flex items-start gap-3">
        <CheckCircle2 className="w-5 h-5 text-blue shrink-0 mt-0.5" />
        <div className="text-xs">
          <p className="font-semibold text-label">Step {step.step}: agent concluded the analysis</p>
          {step.reasoning && <p className="text-label-2 mt-1 italic">&ldquo;{step.reasoning}&rdquo;</p>}
        </div>
      </div>
    );
  }

  if (step.tool === 'check_multicollinearity') {
    const scores = step.result?.vifScores || [];
    return (
      <div className="bg-well border border-separator rounded-xl p-4">
        <div className="flex items-start gap-3 mb-3">
          <Sparkles className="w-5 h-5 text-orange shrink-0 mt-0.5" />
          <div className="text-xs flex-1">
            <p className="font-semibold text-label">Step {step.step}: checked multicollinearity (real VIF)</p>
            {step.reasoning && <p className="text-label-2 mt-1 italic">&ldquo;{step.reasoning}&rdquo;</p>}
          </div>
        </div>
        {scores.length > 0 ? (
          <div className="flex flex-wrap gap-2 pl-8">
            {scores.map(v => (
              <span key={v.feature} className={`text-[11px] tabular-nums px-2 py-1 rounded-lg border ${v.highRisk ? 'bg-red/10 text-red border-red/20' : 'bg-surface text-label-2 border-separator'}`}>
                {v.feature}: VIF {v.vif === null ? '∞' : v.vif}
              </span>
            ))}
          </div>
        ) : (
          <p className="text-xs text-label-3 pl-8">Fewer than 2 numeric features — not applicable.</p>
        )}
      </div>
    );
  }

  const improved = step.improved;
  const actionLabel = step.tool === 'retrain_with_transform'
    ? `${step.result?.transformApplied?.method} transform on "${step.result?.transformApplied?.column}"`
    : `dropped feature "${step.result?.droppedFeature}"`;

  return (
    <div className={`border rounded-xl p-4 ${improved ? 'bg-green/5 border-green/20' : 'bg-well border-separator'}`}>
      <div className="flex items-start gap-3">
        {improved ? <CheckCircle2 className="w-5 h-5 text-green shrink-0 mt-0.5" /> : <XCircle className="w-5 h-5 text-label-3 shrink-0 mt-0.5" />}
        <div className="text-xs flex-1">
          <p className="font-semibold text-label">Step {step.step}: {actionLabel}</p>
          {step.reasoning && <p className="text-label-2 mt-1 italic">&ldquo;{step.reasoning}&rdquo;</p>}
          {step.metricBefore !== undefined && step.metricAfter !== undefined && (
            <p className="mt-2 tabular-nums text-xs text-label">
              Real {primaryMetric}: {step.metricBefore.toFixed(4)} → <span className={improved ? 'text-green font-semibold' : 'text-red font-semibold'}>{step.metricAfter.toFixed(4)}</span>
              {' '}{improved ? '(kept — improved)' : '(discarded — did not improve)'}
            </p>
          )}
          {step.result?.targetWasTransformed && (
            <p className="mt-1.5 text-[11px] text-orange flex items-center gap-1">
              <AlertCircle className="w-3 h-3" /> This metric is on the transformed target's scale — not a direct apples-to-apples comparison to the raw-scale metric.
            </p>
          )}
        </div>
      </div>
    </div>
  );
};
