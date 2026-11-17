/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState, useEffect } from 'react';
import {
  Play,
  LineChart,
  BarChart2,
  CheckCircle,
  CheckCircle2,
  Sparkles,
  Download,
  Table,
  ChevronRight,
  Info,
  Workflow,
  GitBranch,
  Database,
  ShieldCheck,
  ShieldAlert,
  Trophy,
} from 'lucide-react';
import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  ScatterChart,
  Scatter,
  Cell,
  Legend,
  Line,
  LineChart as RechartsLineChart
} from 'recharts';
import { Dataset, MLResult } from '../types';
import { isIdentifierColumn } from '../utils/csvParser';
import {
  evaluateTargetSuitability,
  auditModelLeakage,
  runKMeans,
  runPCAReduction,
  computeClusterQuality,
  UnsupervisedResult
} from '../utils/mlEngine';
import ModelExplainer from './ModelExplainer';
import AgentAnalysis from './AgentAnalysis';
import { usePipelineContext } from '../contexts/PipelineContext';
import Orb from './Orb';
import { getModelFile } from '../utils/workspaceStore';

interface MLPipelineProps {
  dataset: Dataset;
  aiSuggestedTarget?: string;
  aiSuggestedType?: string;
  aiSuggestedFeatures?: string[];
  onTriggerPrediction: (
    target: string,
    features: string[],
    modelType: 'classification' | 'regression' | 'timeseries',
    hyperparameters: Record<string, any>
  ) => Promise<MLResult>;
  mlResult: MLResult | null;
  loadingML: boolean;
}

const REAL_ALGORITHM_OPTIONS = ['auto', 'linear', 'random_forest', 'xgboost', 'mlp'];

export default function MLPipeline({
  dataset,
  aiSuggestedTarget = '',
  aiSuggestedType = 'classification',
  aiSuggestedFeatures = [],
  onTriggerPrediction,
  mlResult,
  loadingML
}: MLPipelineProps) {
  const { expertMode } = usePipelineContext();
  const [target, setTarget] = useState(aiSuggestedTarget || dataset.columns[dataset.columns.length - 1]?.name || '');
  const [selectedFeatures, setSelectedFeatures] = useState<string[]>([]);
  const [modelType, setModelType] = useState<'classification' | 'regression' | 'timeseries'>('classification');

  // Real model selector — trimmed to algorithms this app can genuinely train
  // (scikit-learn Linear/Logistic Regression, Random Forest, XGBoost, MLP).
  const [selectedAlgorithmId, setSelectedAlgorithmId] = useState<string>('auto');

  // Pipeline Tuning regulators — every one of these is sent to and actually
  // used by the real scikit-learn/XGBoost training call.
  const [estimators, setEstimators] = useState<number>(100);
  const [maxDepth, setMaxDepth] = useState<number>(8);
  const [learningRate, setLearningRate] = useState<number>(0.1);
  const [splitRatio, setSplitRatio] = useState<number>(0.8);
  const [clusterK, setClusterK] = useState<number>(3);
  const [mlpMaxIterations, setMlpMaxIterations] = useState<number>(200);
  // Reproducibility and honest evaluation: the seed fixes every random step;
  // the split can follow time or keep related rows (one customer) together.
  const [seed, setSeed] = useState<number>(42);
  const [splitStrategy, setSplitStrategy] = useState<'random' | 'time' | 'group'>('random');
  const dateColumns = dataset.columns.filter(c => c.type === 'datetime').map(c => c.name);
  const [timeColumn, setTimeColumn] = useState<string>(dateColumns[0] ?? '');
  const [groupColumn, setGroupColumn] = useState<string>(dataset.columns.find(c => /id$/i.test(c.name))?.name ?? dataset.columns[0]?.name ?? '');
  const [tune, setTune] = useState<boolean>(false);
  const [tuneIterations, setTuneIterations] = useState<number>(12);

  const [progressLog, setProgressLog] = useState<string[]>([]);
  const [unsupervisedRes, setUnsupervisedRes] = useState<UnsupervisedResult | null>(null);
  const [downloadingModel, setDownloadingModel] = useState<boolean>(false);

  // Tabs management
  const [activeRealm, setActiveRealm] = useState<'supervised' | 'unsupervised' | 'ensemble' | 'deep_learning' | 'comparison' | 'agent'>('supervised');
  const [selectedEstimatorIdx, setSelectedEstimatorIdx] = useState<number>(0);
  const [selectedRawPredPage, setSelectedRawPredPage] = useState<number>(1);

  // Memoize targets suitability list so we don't restart on minor movements
  const targetRecommendations = React.useMemo(() => evaluateTargetSuitability(dataset), [dataset]);

  // Real-time frontend-side model leakage monitor to protect the modeling stage
  const leakageAuditResult = React.useMemo(() => {
    if (!target) return { leakageRisk: 'None' as const, passed: true, issues: [] };
    return auditModelLeakage(dataset, target, selectedFeatures);
  }, [dataset, target, selectedFeatures]);

  // Sync suggestion weights when analysis loads
  const aiSuggestedFeaturesStr = JSON.stringify(aiSuggestedFeatures || []);
  const datasetColumnsStr = dataset.columns.map(c => c.name).join(',');

  useEffect(() => {
    // ID columns (CustomerID, order_id, ...) only let a model memorise rows, so they are not pre-selected.
    const usableFeatureNames = new Set(
      dataset.columns.filter(c => !isIdentifierColumn(c, dataset.rowCount)).map(c => c.name)
    );
    if (aiSuggestedTarget) {
      setTarget(aiSuggestedTarget);
    }
    if (aiSuggestedType) {
      setModelType(aiSuggestedType as any);
    }
    if (aiSuggestedFeatures && aiSuggestedFeatures.length > 0) {
      setSelectedFeatures(aiSuggestedFeatures.filter(f => usableFeatureNames.has(f)));
    } else {
      // Default to the first few non-identifier columns, excluding the target
      const t = aiSuggestedTarget || dataset.columns[dataset.columns.length - 1]?.name;
      const initial = dataset.columns.map(c => c.name).filter(n => n !== t && usableFeatureNames.has(n)).slice(0, 5);
      setSelectedFeatures(initial);
    }
  }, [aiSuggestedTarget, aiSuggestedType, aiSuggestedFeaturesStr, datasetColumnsStr]);

  // Handle changing target - ensure target is removed from feature lists
  const handleTargetChange = (val: string) => {
    setTarget(val);
    const colMeta = dataset.columns.find(c => c.name === val);
    if (colMeta) {
      const isClass = colMeta.type === 'categorical' || colMeta.type === 'boolean' || colMeta.distinctCount < 10;
      setModelType(isClass ? 'classification' : 'regression');
    }
    setSelectedFeatures(current => current.filter(f => f !== val));
  };

  const handleSetTargetFromAdvisor = (targetName: string, suggestedType: 'classification' | 'regression' | 'timeseries', suggestedFeats: string[]) => {
    setTarget(targetName);
    setModelType(suggestedType);
    setSelectedFeatures(suggestedFeats.filter(f => f !== targetName && dataset.columns.some(col => col.name === f)));
    setProgressLog(prev => [...prev, `Automatically configured target context to "${targetName}" (${suggestedType.toUpperCase()}) with advised input dimensions.`]);
  };

  const toggleFeature = (name: string) => {
    if (selectedFeatures.includes(name)) {
      setSelectedFeatures(selectedFeatures.filter(f => f !== name));
    } else {
      setSelectedFeatures([...selectedFeatures, name]);
    }
  };

  const handleLaunchPipeline = async () => {
    setProgressLog([`Sending ${dataset.rowCount.toLocaleString()} rows to the Python ML compute service for real training...`]);

    // Real unsupervised analysis (K-Means + PCA + genuine cluster-quality metrics)
    // runs instantly client-side on the actual active dataset.
    const clusterCols = selectedFeatures.filter(f => {
      const meta = dataset.columns.find(c => c.name === f);
      return meta && meta.type === 'numeric';
    });
    const effectiveClusterCols = clusterCols.length > 1 ? clusterCols : selectedFeatures.slice(0, 3);
    const kMeansRes = runKMeans(dataset.rows, effectiveClusterCols, clusterK);
    const pcaRes = runPCAReduction(dataset.rows, effectiveClusterCols, kMeansRes.clusterAssignments);
    const quality = computeClusterQuality(dataset.rows, effectiveClusterCols, kMeansRes.clusterAssignments);
    setUnsupervisedRes({
      clusterAssignments: kMeansRes.clusterAssignments,
      centroids: kMeansRes.centroids,
      pcaComponents: pcaRes.pcaComponents,
      explainedVarianceRatios: pcaRes.explainedVarianceRatios,
      silhouetteScore: quality.silhouetteScore,
      daviesBouldinIndex: quality.daviesBouldinIndex
    });

    const params = {
      n_estimators: estimators,
      max_depth: maxDepth,
      learning_rate: learningRate,
      train_ratio: splitRatio,
      k: clusterK,
      epochs: mlpMaxIterations,
      selectedAlgorithmId,
      seed,
      split_strategy: splitStrategy,
      time_column: splitStrategy === 'time' ? timeColumn : undefined,
      group_column: splitStrategy === 'group' ? groupColumn : undefined,
      tune: tune && selectedAlgorithmId !== 'auto',
      tune_iterations: tuneIterations,
    };

    setProgressLog(prev => [...prev, `Training real scikit-learn/XGBoost model(s) on a genuine ${Math.round(splitRatio * 100)}/${Math.round((1 - splitRatio) * 100)} train/test split — this can take several seconds depending on dataset size...`]);

    try {
      await onTriggerPrediction(target, selectedFeatures, modelType, params);
      setProgressLog(prev => [...prev, `Training complete. All metrics below were measured on held-out test data — nothing here is estimated.`]);
      setSelectedRawPredPage(1);
      setSelectedEstimatorIdx(0);
      setActiveRealm('supervised');
    } catch (err: any) {
      setProgressLog(prev => [...prev, `${err.message || 'Training failed — the ML compute service may be offline.'}`]);
    }
  };

  // Downloads the real, genuinely-fitted joblib artifact from the Python service.
  const downloadModelFile = async () => {
    if (!mlResult?.modelId) return;
    setDownloadingModel(true);
    try {
      let blob: Blob;
      let filename = `${target}_${(mlResult.modelAlgorithm || 'model').replace(/\s+/g, '')}.joblib`;
      const res = await fetch(`/api/ml/download/${encodeURIComponent(mlResult.modelId)}`).catch(() => null);
      if (res?.ok) {
        blob = await res.blob();
      } else {
        // The ML service may have restarted and forgotten the model; use the
        // copy saved in this browser after training.
        const saved = await getModelFile(mlResult.modelId).catch(() => undefined);
        if (!saved) {
          const body = res ? await res.json().catch(() => ({})) : {};
          throw new Error(body.error || 'The model is no longer on the ML service and no saved copy was found. Train again.');
        }
        blob = new Blob([saved.bytes], { type: 'application/octet-stream' });
        filename = saved.filename;
        setProgressLog(prev => [...prev, 'Downloaded the copy of this model saved in your browser.']);
      }
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = filename;
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      URL.revokeObjectURL(url);
    } catch (err: any) {
      setProgressLog(prev => [...prev, `Model download failed: ${err.message}`]);
    } finally {
      setDownloadingModel(false);
    }
  };

  // Pre-training: a column-structure heuristic (clearly labeled as such).
  // Post-training: the REAL champion model and its REAL measured metric.
  const getEDAModelFit = () => {
    if (mlResult) {
      const m = mlResult.metrics || {};
      const isClass = mlResult.modelType === 'classification';
      const primaryValue = isClass ? m.accuracy : m.r2Score;
      const comparedCount = mlResult.comparison?.length || 1;
      return {
        modelName: mlResult.modelAlgorithm,
        // The real, explainable AutoML selection rule from the server — CV
        // mean score with a stated tie-break — shown verbatim, never hidden.
        reasoning: mlResult.selectionReason || (comparedCount > 1
          ? `Selected as the top performer out of ${comparedCount} real models trained and evaluated on your held-out test split.`
          : `Trained and evaluated on your held-out test split using scikit-learn/XGBoost.`),
        primaryLabel: isClass ? 'Accuracy' : 'R² Score',
        primaryValue: primaryValue !== undefined ? primaryValue : null,
        isReal: true
      };
    }

    const totalCols = dataset.columns.length;
    let modelName = 'Random Forest Classifier';
    let reasoning = 'A high concentration of categorical variables recommends Random Forest to avoid scaling issues.';
    const isClass = modelType === 'classification';
    if (!isClass) {
      modelName = 'XGBoost Regressor';
      reasoning = 'Continuous distribution curves benefit from sequence-based gradient boosting.';
    } else if (totalCols > 15) {
      modelName = 'Multi-Layer Perceptron (Neural Network)';
      reasoning = 'High-dimensional feature spaces benefit from a learned layered representation.';
    }
    return { modelName, reasoning, primaryLabel: null as string | null, primaryValue: null as number | null, isReal: false };
  };

  const edaFit = getEDAModelFit();

  const isBinaryConfusion = (cm: any): cm is { tp: number; tn: number; fp: number; fn: number; positiveLabel?: string } =>
    !!cm && typeof cm.tp === 'number';

  // Real SHAP values are the more rigorous explainability signal when
  // available; fall back to the model's own built-in importance otherwise.
  // Both are real — this only decides which one is more trustworthy to lead with.
  const hasShap = !!(mlResult?.shapImportance && mlResult.shapImportance.length > 0);
  const importanceData = hasShap ? mlResult!.shapImportance! : (mlResult?.featureImportance || []);
  const importanceLabel = hasShap ? 'Feature importance (SHAP)' : 'Feature importance';

  return (
    <div className="space-y-12 animate-fade-in" id="ml_module">

      {/* Recommendation before training; the measured champion after. */}
      <section className="card p-5 sm:p-6 flex flex-col md:flex-row md:items-center gap-5" aria-label="Model recommendation">
        <div className="w-12 h-12 rounded-xl bg-blue/12 text-blue flex items-center justify-center shrink-0">
          <Sparkles className="w-6 h-6" />
        </div>
        <div className="flex-1 min-w-0">
          <p className="text-xs font-medium text-label-2">
            {edaFit.isReal ? 'Best trained model' : 'Suggested starting point'}
          </p>
          <h2 className="mt-0.5 text-xl font-semibold tracking-tight text-label">{edaFit.modelName}</h2>
          <p className="mt-1 text-sm text-label-2 max-w-3xl leading-relaxed">{edaFit.reasoning}</p>
        </div>

        {edaFit.isReal && edaFit.primaryValue !== null && edaFit.primaryValue !== undefined ? (
          <div className="rounded-xl bg-well px-5 py-3 shrink-0">
            <p className="text-xs text-label-2">{edaFit.primaryLabel} on test data</p>
            <p className="mt-0.5 text-[28px] leading-none font-semibold tracking-tight tabular-nums text-label">
              {edaFit.primaryLabel === 'Accuracy' ? `${(edaFit.primaryValue * 100).toFixed(1)}%` : edaFit.primaryValue.toFixed(3)}
            </p>
          </div>
        ) : (
          <p className="text-xs text-label-3 md:max-w-[200px] shrink-0">
            Train a model below to see measured performance.
          </p>
        )}
      </section>

      {/* Step 1 — what to predict */}
      <section aria-labelledby="target-heading">
        <h2 id="target-heading" className="section-title">Choose what to predict</h2>
        <p className="mt-1 text-sm text-label-2">
          The {Math.min(6, targetRecommendations.length)} most suitable of {dataset.columns.length} columns, ranked by how well each works as a prediction target.
        </p>

        <div className="mt-5 grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
          {targetRecommendations.slice(0, 6).map((item) => {
            const isSelected = target === item.name;
            const gradeTone =
              item.grade === 'Excellent' ? 'bg-green/12 text-green' :
              item.grade === 'Good' ? 'bg-blue/12 text-blue' :
              item.grade === 'Fair' ? 'bg-orange/12 text-orange' : '';

            return (
              <button
                key={item.name}
                type="button"
                aria-pressed={isSelected}
                onClick={() => handleSetTargetFromAdvisor(item.name, item.type, item.suggestedFeatures)}
                className={`card p-4 text-left flex flex-col gap-2 hover:shadow-md ${isSelected ? 'ring-2 ring-blue' : ''}`}
              >
                <span className="flex items-center justify-between gap-2">
                  <span className="text-base font-semibold tracking-tight text-label truncate" title={item.name}>
                    {item.name}
                  </span>
                  {isSelected ? (
                    <CheckCircle2 className="w-5 h-5 text-blue shrink-0" />
                  ) : (
                    <span className="w-5 h-5 rounded-full border-[1.5px] border-separator-strong shrink-0" />
                  )}
                </span>
                <span className="flex flex-wrap items-center gap-1.5">
                  <span className="tag capitalize">{String(item.type).toLowerCase()}</span>
                  <span className={`tag ${gradeTone}`} title={`Suitability score ${item.score}/100`}>
                    {item.grade} fit
                  </span>
                </span>
                <span className="text-xs text-label-2 leading-relaxed">{item.reason}</span>
              </button>
            );
          })}
        </div>
      </section>

      {/* Step 2 — configure and train */}
      <section aria-labelledby="train-heading">
        <h2 id="train-heading" className="section-title">Train</h2>
        <p className="mt-1 text-sm text-label-2">
          Trains real scikit-learn and XGBoost models on your data and reports performance on held-out rows.
        </p>

        <div className={`mt-5 grid grid-cols-1 gap-5 ${expertMode ? 'lg:grid-cols-3' : 'lg:grid-cols-2'}`}>
          {/* Target + features */}
          <div className="card p-5 sm:p-6 space-y-5">
            <div>
              <label className="field-label" htmlFor="ml-target">Predict</label>
              <select
                id="ml-target" data-agent="ml-target"
                value={target}
                onChange={(e) => handleTargetChange(e.target.value)}
                className="input"
              >
                {dataset.columns.map(c => (
                  <option key={c.name} value={c.name}>
                    {c.name} ({c.type})
                  </option>
                ))}
              </select>
            </div>

            <div>
              <div className="flex items-baseline justify-between">
                <span className="field-label">Using these columns</span>
                <span className="text-xs text-label-3 tabular-nums">{selectedFeatures.length} selected</span>
              </div>
              <div className="max-h-[232px] overflow-y-auto rounded-xl bg-well divide-y divide-separator">
                {dataset.columns
                  .filter(c => c.name !== target)
                  .map(col => {
                    const isSuggested = aiSuggestedFeatures.includes(col.name);
                    return (
                      <label key={col.name} className="flex items-center gap-3 px-3 py-2 text-sm cursor-pointer">
                        <input
                          type="checkbox"
                          checked={selectedFeatures.includes(col.name)}
                          onChange={() => toggleFeature(col.name)}
                          className="w-4 h-4 shrink-0"
                        />
                        <span className="text-label flex-1 truncate">{col.name}</span>
                        {isSuggested && <span className="tag bg-blue/12 text-blue">Suggested</span>}
                      </label>
                    );
                  })}
              </div>
            </div>

            {/* Leakage check (Expert) */}
            {expertMode && (
              <div className={`rounded-xl p-3.5 ${
                leakageAuditResult.leakageRisk === 'High' ? 'bg-red/10' :
                leakageAuditResult.leakageRisk === 'Medium' ? 'bg-orange/10' : 'bg-green/10'
              }`}>
                <div className="flex items-center gap-2">
                  {leakageAuditResult.leakageRisk === 'High' ? (
                    <ShieldAlert className="w-4 h-4 text-red shrink-0" />
                  ) : (
                    <ShieldCheck className={`w-4 h-4 shrink-0 ${leakageAuditResult.leakageRisk === 'Medium' ? 'text-orange' : 'text-green'}`} />
                  )}
                  <span className="text-sm font-medium text-label">Leakage check</span>
                  <span className={`ml-auto tag ${
                    leakageAuditResult.leakageRisk === 'High' ? 'bg-red/12 text-red' :
                    leakageAuditResult.leakageRisk === 'Medium' ? 'bg-orange/12 text-orange' : 'bg-green/12 text-green'
                  }`}>
                    {leakageAuditResult.leakageRisk} risk
                  </span>
                </div>
                <p className="mt-1.5 text-xs leading-relaxed text-label-2">
                  {leakageAuditResult.passed
                    ? 'No risky columns selected. Columns that reveal the answer make a model look better than it is.'
                    : 'Some selected columns may reveal the answer. Remove them so the model doesn’t simply memorize.'}
                </p>
                {leakageAuditResult.issues.length > 0 && (
                  <ul className="mt-2 space-y-1 max-h-[100px] overflow-y-auto">
                    {leakageAuditResult.issues.map((issue, idx) => (
                      <li key={idx} className="text-xs text-label-2 leading-normal">
                        <span className="font-medium text-label">{issue.feature}</span> — {issue.message}
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            )}
          </div>

          {/* Algorithm + hyperparameters (Expert) */}
          {expertMode && (
            <div className="card p-5 sm:p-6 space-y-5">
              <div>
                <span className="field-label">Problem type</span>
                <div className="segmented w-full" role="group" aria-label="Problem type">
                  {(['classification', 'regression', 'timeseries'] as const).map((type) => (
                    <button
                      key={type}
                      type="button"
                      aria-pressed={modelType === type}
                      onClick={() => setModelType(type)}
                      className="flex-1"
                    >
                      {type === 'classification' ? 'Classification' : type === 'regression' ? 'Regression' : 'Time Series'}
                    </button>
                  ))}
                </div>
              </div>

              <div>
                <label className="field-label" htmlFor="ml-algorithm">Algorithm</label>
                <select
                  id="ml-algorithm" data-agent="ml-algorithm"
                  value={selectedAlgorithmId}
                  onChange={(e) => setSelectedAlgorithmId(e.target.value)}
                  className="input"
                >
                  <option value="auto">Automatic — train and compare all 5</option>
                  <optgroup label="Tree ensembles">
                    <option value="random_forest">Random Forest</option>
                    <option value="gradient_boosting">Gradient Boosting</option>
                    <option value="xgboost">XGBoost</option>
                  </optgroup>
                  <optgroup label="Linear">
                    <option value="linear">Linear / Logistic Regression</option>
                  </optgroup>
                  <optgroup label="Neural network">
                    <option value="mlp">Multi-Layer Perceptron</option>
                  </optgroup>
                </select>
                <p className="mt-1.5 text-xs text-label-2 leading-relaxed">
                  {selectedAlgorithmId === 'auto'
                    ? 'Trains five models on the same split and keeps the best scorer on held-out data. Most thorough; a single algorithm is faster on large datasets.'
                    : 'Trains only the selected algorithm.'}
                </p>
              </div>

              <div className="pt-5 border-t border-separator">
                <p className="text-sm font-semibold text-label">Hyperparameters</p>
                <div className="mt-3 grid grid-cols-2 gap-3">
                  <div>
                    <label className="field-label" htmlFor="hp-estimators">Trees</label>
                    <select id="hp-estimators" value={estimators} onChange={(e) => setEstimators(Number(e.target.value))} className="input">
                      <option value={50}>50</option>
                      <option value={100}>100</option>
                      <option value={150}>150</option>
                    </select>
                  </div>
                  <div>
                    <label className="field-label" htmlFor="hp-depth">Max depth</label>
                    <select id="hp-depth" value={maxDepth} onChange={(e) => setMaxDepth(Number(e.target.value))} className="input">
                      <option value={5}>5</option>
                      <option value={8}>8</option>
                      <option value={12}>12</option>
                    </select>
                  </div>
                  <div>
                    <label className="field-label" htmlFor="hp-clusters">Clusters (k)</label>
                    <select id="hp-clusters" value={clusterK} onChange={(e) => setClusterK(Number(e.target.value))} className="input">
                      <option value={2}>2</option>
                      <option value={3}>3</option>
                      <option value={4}>4</option>
                      <option value={5}>5</option>
                    </select>
                  </div>
                  <div>
                    <label className="field-label" htmlFor="hp-iterations">MLP iterations</label>
                    <select id="hp-iterations" value={mlpMaxIterations} onChange={(e) => setMlpMaxIterations(Number(e.target.value))} className="input">
                      <option value={100}>100</option>
                      <option value={200}>200</option>
                      <option value={300}>300</option>
                    </select>
                  </div>
                  <div className="col-span-2">
                    <label className="field-label flex justify-between" htmlFor="hp-split">
                      <span>Train / test split</span>
                      <span className="text-label tabular-nums">
                        {Math.round(splitRatio * 100)}% / {Math.round((1 - splitRatio) * 100)}%
                      </span>
                    </label>
                    <input
                      id="hp-split"
                      type="range"
                      min="0.5"
                      max="0.9"
                      step="0.1"
                      value={splitRatio}
                      onChange={(e) => setSplitRatio(parseFloat(e.target.value))}
                      className="w-full"
                    />
                  </div>
                  <div className="col-span-2">
                    <label className="field-label" htmlFor="hp-split-strategy">How to pick the test rows</label>
                    <select id="hp-split-strategy" className="input" value={splitStrategy} onChange={e => setSplitStrategy(e.target.value as typeof splitStrategy)}>
                      <option value="random">At random{modelType === 'classification' ? ' (keeping class balance)' : ''}</option>
                      <option value="time" disabled={dateColumns.length === 0}>The most recent rows{dateColumns.length === 0 ? ' (needs a date column)' : ''}</option>
                      <option value="group">Whole groups (e.g. all rows of a customer)</option>
                    </select>
                    {splitStrategy === 'time' && (
                      <select aria-label="Date column" className="input mt-2" value={timeColumn} onChange={e => setTimeColumn(e.target.value)}>
                        {dateColumns.map(c => <option key={c} value={c}>{c}</option>)}
                      </select>
                    )}
                    {splitStrategy === 'group' && (
                      <select aria-label="Group column" className="input mt-2" value={groupColumn} onChange={e => setGroupColumn(e.target.value)}>
                        {dataset.columns.filter(c => c.name !== target).map(c => <option key={c.name} value={c.name}>{c.name}</option>)}
                      </select>
                    )}
                    <p className="mt-1.5 text-xs text-label-2 leading-relaxed">
                      {splitStrategy === 'time'
                        ? 'Trains on the past and tests on the latest rows, like using the model for real.'
                        : splitStrategy === 'group'
                        ? 'A group is never in both training and testing, so the score reflects new groups.'
                        : 'Use “most recent” for data over time, and “whole groups” when several rows describe the same customer.'}
                    </p>
                  </div>
                  <div>
                    <label className="field-label" htmlFor="hp-seed">Random seed</label>
                    <input id="hp-seed" type="number" className="input" value={seed} onChange={e => setSeed(Math.max(0, Math.floor(Number(e.target.value) || 0)))} />
                  </div>
                  <div>
                    <label className="field-label" htmlFor="hp-tune-iter">Tuning trials</label>
                    <select id="hp-tune-iter" className="input" value={tuneIterations} disabled={!tune} onChange={e => setTuneIterations(Number(e.target.value))}>
                      <option value={8}>8</option>
                      <option value={12}>12</option>
                      <option value={20}>20</option>
                    </select>
                  </div>
                  <label className="col-span-2 flex items-start gap-2 text-sm text-label">
                    <input type="checkbox" data-agent="ml-tune" className="mt-1" checked={tune} disabled={selectedAlgorithmId === 'auto'} onChange={e => setTune(e.target.checked)} />
                    <span>
                      Tune the settings automatically
                      <span className="block text-xs text-label-2">
                        {selectedAlgorithmId === 'auto'
                          ? 'Choose one algorithm to tune it.'
                          : 'Tries different settings with cross-validation on the training rows and keeps the best. Slower.'}
                      </span>
                    </span>
                  </label>
                </div>
              </div>
            </div>
          )}

          {/* Run */}
          <div className="card p-5 sm:p-6 flex flex-col">
            <p className="text-sm font-semibold text-label">Training log</p>
            <div
              className="mt-3 flex-1 min-h-[168px] max-h-[280px] overflow-y-auto rounded-xl bg-well p-3.5 font-code text-xs leading-relaxed text-label space-y-1"
              aria-live="polite"
            >
              {progressLog.length === 0 ? (
                <p className="font-sans text-sm text-label-3">
                  Progress appears here once training starts.
                </p>
              ) : (
                progressLog.map((log, i) => (
                  <div key={i} className="flex items-start gap-1.5">
                    <span className="text-label-3">›</span>
                    <span>{log}</span>
                  </div>
                ))
              )}
              {loadingML && (
                <div className="flex items-center gap-2 text-label-2 font-sans">
                  <Orb state="listening" label="Waiting for the ML engine" />
                  <span>Waiting for the ML engine…</span>
                </div>
              )}
            </div>

            <button
              type="button"
              data-agent="ml-train"
              onClick={handleLaunchPipeline}
              disabled={loadingML || selectedFeatures.length === 0}
              aria-busy={loadingML}
              className="btn btn-primary btn-lg w-full mt-5"
            >
              {loadingML ? (
                <>
                  <Orb state="solving" onAccent label="Training" />
                  Training…
                </>
              ) : (
                <>
                  <Play className="w-4 h-4 fill-current shrink-0" /> Train Model
                </>
              )}
            </button>
            {selectedFeatures.length === 0 && (
              <p className="mt-2 text-xs text-label-3 text-center">Select at least one column to train on.</p>
            )}
          </div>
        </div>
      </section>

      {/* RESULTS PORTFOLIO — everything below is sourced from mlResult (real Python training response) */}
      {mlResult && (
        <div className="space-y-8 animate-fade-in">
          <RunDetails result={mlResult} />

          {/* SYSTEM-WIDE MODEL COMPARISON & SERIALIZATION ROW */}
          <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">

            {/* COMPARISON BENCHMARK DATAFRAME */}
            <div className="bg-surface p-6 rounded-2xl border border-separator shadow-sm col-span-2 space-y-4">
              <div className="flex items-center justify-between border-b border-separator pb-3">
                <div>
                  <h3 className="font-semibold text-label text-sm">Model comparison</h3>
                  <p className="text-[11px] text-label-2 tabular-nums mt-0.5">Every candidate model is shown — ranked by cross-validation, not just the winner</p>
                </div>
                <Table className="w-4.5 h-4.5 text-blue shrink-0" />
              </div>

              <div className="overflow-x-auto text-xs">
                <table className="w-full text-left border-collapse tabular-nums">
                  <thead>
                    <tr className="border-b border-separator text-label-2 text-[11px] font-semibold">
                      <th className="pb-2.5 font-semibold">Trained Model</th>
                      <th className="pb-2.5 font-semibold text-center">Test Score</th>
                      <th className="pb-2.5 font-semibold text-center">CV Mean (±std)</th>
                      <th className="pb-2.5 text-center font-semibold">Train Time</th>
                      <th className="pb-2.5 text-right font-semibold">Status</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-separator">
                    {(mlResult.comparison || []).map((row, idx) => (
                      <tr key={idx} className="hover:bg-surface transition-colors">
                        <td className="py-3 font-semibold text-label flex items-center gap-1.5">
                          {idx === 0 ? (
                            <span className="w-1.5 h-1.5 rounded-full bg-green animate-ping inline-block" />
                          ) : (
                            <span className="w-1.5 h-1.5 rounded-full bg-label-3 inline-block" />
                          )}
                          {row.modelName}
                        </td>
                        <td className="font-semibold text-label text-center">
                          {row.primaryMetric.toLowerCase().includes('accuracy')
                            ? `${(row.metricValue * 100).toFixed(1)}%`
                            : row.metricValue.toFixed(3)}
                          <span className="block text-[11px] text-label-3 font-normal normal-case">{row.primaryMetric}</span>
                        </td>
                        <td className="text-center text-blue font-semibold">
                          {row.cv && !row.cv.error
                            ? (row.cv.metric === 'accuracy' ? `${(row.cv.mean * 100).toFixed(1)}%` : row.cv.mean.toFixed(3)) + ` (±${row.cv.std.toFixed(3)})`
                            : '—'}
                        </td>
                        <td className="text-label-2 text-center">{row.executionTimeMs.toLocaleString()} ms</td>
                        <td className="text-right py-3 pr-1">
                          <span className={`px-2 py-0.5 rounded-md tabular-nums text-[11px] font-semibold ${
                            idx === 0
                              ? 'bg-green/15 text-green border border-green/20 shadow-sm'
                              : 'bg-well text-label-2 border border-separator'
                          }`}>
                            {idx === 0 ? 'Best model' : `#${idx + 1}`}
                          </span>
                        </td>
                      </tr>
                    ))}
                    {(!mlResult.comparison || mlResult.comparison.length === 0) && (
                      <tr>
                        <td colSpan={5} className="py-4 text-center text-label-3 text-[11px]">
                          Only one model was trained this run — pick "AUTO" to compare multiple algorithms.
                        </td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </div>
            </div>

            {/* REAL MODEL ARTIFACT DOWNLOAD */}
            <div className="bg-gradient-to-br from-surface to-surface p-6 rounded-2xl border border-separator shadow-sm flex flex-col justify-between">
              <div className="space-y-3">
                <h3 className="font-semibold text-label text-sm mt-2 flex items-center gap-2">
                  <Database className="w-4.5 h-4.5 text-green" /> Trained model
                </h3>
                <p className="text-xs text-label-2 leading-relaxed mt-1">
                  Downloads the genuine fitted scikit-learn Pipeline (preprocessing + model) as a real <code>.joblib</code> file, ready to load in Python.
                </p>

                <div className="p-3.5 bg-well rounded-xl border border-separator space-y-1.5 text-[11px] tabular-nums text-label-2">
                  <div className="flex justify-between">
                    <span>Algorithm:</span>
                    <strong className="text-blue font-semibold">{mlResult.modelAlgorithm}</strong>
                  </div>
                  <div className="flex justify-between">
                    <span>Train / Test Rows:</span>
                    <strong className="text-label">{mlResult.trainRows ?? '-'} / {mlResult.testRows ?? '-'}</strong>
                  </div>
                  {mlResult.seed !== undefined && (
                    <div className="flex justify-between">
                      <span>Random seed:</span>
                      <strong className="text-label">{mlResult.seed}</strong>
                    </div>
                  )}
                  <div className="flex justify-between border-t border-separator pt-1.5 mt-1 text-[11px]">
                    <span>Model ID:</span>
                    <span className="text-label-3 truncate max-w-[140px]" title={mlResult.modelId}>{mlResult.modelId?.slice(0, 12) || 'n/a'}…</span>
                  </div>
                </div>
              </div>

              <button
                onClick={downloadModelFile}
                disabled={!mlResult.modelId || downloadingModel}
                className="w-full bg-fill hover:bg-fill bg-surface border border-separator hover:border-separator-strong text-label font-semibold text-xs py-3 rounded-xl flex items-center justify-center gap-2 cursor-pointer mt-5 transition-all disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {downloadingModel ? (
                  <Orb state="working" label="Downloading model" />
                ) : (
                  <Download className="w-4 h-4 text-green shrink-0" />
                )}
                {downloadingModel ? 'Downloading…' : 'Download Model (.joblib)'}
              </button>
            </div>
          </div>

          {/* TRAINING DISPLAY TABS SELECTOR */}
          <div className="space-y-4">
            <div className="overflow-x-auto scrollbar-none">
              <div className="segmented w-max" role="tablist" aria-label="Result views">
                {([
                  ['supervised', 'Results'],
                  ['unsupervised', 'Clustering'],
                  ['ensemble', 'Ensembles'],
                  ['deep_learning', 'Neural Network'],
                  ['comparison', 'Comparison'],
                  ['agent', 'AI Agent'],
                ] as const).map(([id, label]) => (
                  <button
                    key={id}
                    type="button"
                    role="tab"
                    aria-selected={activeRealm === id}
                    onClick={() => setActiveRealm(id)}
                  >
                    {label}
                  </button>
                ))}
              </div>
            </div>

            {/* REALM A: SUPERVISED LEARNING PORTFOLIO */}
            {activeRealm === 'supervised' && (
              <div className="grid grid-cols-1 lg:grid-cols-3 gap-6 animate-fade-in">

                {/* 1. Supervised Evaluation Metrics Card */}
                <div className="bg-surface border border-separator p-6 rounded-2xl flex flex-col justify-between hover:border-separator-strong transition">
                  <div className="space-y-4">
                    <h4 className="font-medium text-label text-xs tabular-nums text-blue">Performance on test data</h4>
                    <div className="grid grid-cols-2 gap-3.5">
                      {mlResult.modelType === 'classification' ? (
                        <>
                          <div className="bg-blue/5 p-4 rounded-xl border border-blue/10 text-center">
                            <p className="text-[11px] text-label-2 tabular-nums font-medium">Test Accuracy</p>
                            <p className="text-2xl font-semibold text-blue tabular-nums mt-0.5">
                              {((mlResult.metrics.accuracy ?? 0) * 100).toFixed(1)}%
                            </p>
                          </div>
                          <div className="bg-green/5 p-4 rounded-xl border border-green/10 text-center">
                            <p className="text-[11px] text-label-2 tabular-nums font-medium">F1-Score</p>
                            <p className="text-2xl font-semibold text-green tabular-nums mt-0.5">
                              {((mlResult.metrics.f1Score ?? 0) * 100).toFixed(1)}%
                            </p>
                          </div>
                          <div className="col-span-2 bg-well p-3.5 rounded-xl border border-separator tabular-nums text-[11px] text-label space-y-1 my-1 text-center">
                            <div>Precision: <strong className="text-label">{(mlResult.metrics.precision ?? 0).toFixed(3)}</strong> · Recall: <strong className="text-label">{(mlResult.metrics.recall ?? 0).toFixed(3)}</strong></div>
                            {mlResult.metrics.rocAuc !== undefined && (
                              <div>ROC-AUC: <strong className="text-label">{mlResult.metrics.rocAuc.toFixed(3)}</strong></div>
                            )}
                          </div>
                        </>
                      ) : (
                        <>
                          <div className="bg-blue/5 p-4 rounded-xl border border-blue/10 text-center col-span-2">
                            <p className="text-[11px] text-label-2 tabular-nums font-medium">R² Explained Variance</p>
                            <p className="text-2xl font-semibold text-blue tabular-nums mt-0.5">
                              {(mlResult.metrics.r2Score ?? 0).toFixed(3)}
                            </p>
                            <span className="text-[11px] text-label-3 mt-1 block">Accountability of total feature info</span>
                          </div>
                          <div className="col-span-2 bg-well p-3.5 rounded-xl border border-separator tabular-nums text-[11px] text-label flex justify-between px-5 font-semibold">
                            <span>MAE: <strong className="text-label">{(mlResult.metrics.mae ?? 0).toFixed(2)}</strong></span>
                            <span>RMSE: <strong className="text-label">{(mlResult.metrics.rmse ?? 0).toFixed(2)}</strong></span>
                          </div>
                        </>
                      )}
                    </div>

                    {mlResult.cv && !mlResult.cv.error && (
                      <div className="bg-well p-3 rounded-xl border border-separator tabular-nums text-[11px] text-label-2 flex justify-between items-center">
                        <span>{mlResult.cv.folds}-Fold Cross-Validation ({mlResult.cv.metric}):</span>
                        <strong className="text-blue">
                          {mlResult.cv.metric === 'accuracy' ? `${(mlResult.cv.mean * 100).toFixed(1)}%` : mlResult.cv.mean.toFixed(3)} (±{mlResult.cv.std.toFixed(3)})
                        </strong>
                      </div>
                    )}
                  </div>

                  {mlResult.confusionMatrix && isBinaryConfusion(mlResult.confusionMatrix) && (
                    <div className="mt-5 border-t border-separator pt-4">
                      <p className="text-[11px] text-label-2 tabular-nums font-medium mb-2.5">
                        Confusion Matrix {mlResult.confusionMatrix.positiveLabel ? `(positive = "${mlResult.confusionMatrix.positiveLabel}")` : ''}
                      </p>
                      <div className="grid grid-cols-2 gap-1.5 tabular-nums text-center text-xs">
                        <div className="bg-green/10 p-2.5 rounded-lg border border-green/30">
                          <p className="text-[11px] text-green font-medium">True Positives</p>
                          <p className="text-lg font-semibold text-green mt-0.5">{mlResult.confusionMatrix.tp}</p>
                        </div>
                        <div className="bg-well p-2.5 rounded-lg border border-separator">
                          <p className="text-[11px] text-label-3 font-medium">False Positives</p>
                          <p className="text-lg font-semibold text-label mt-0.5">{mlResult.confusionMatrix.fp}</p>
                        </div>
                        <div className="bg-well p-2.5 rounded-lg border border-separator">
                          <p className="text-[11px] text-label-3 font-medium">False Negatives</p>
                          <p className="text-lg font-semibold text-label mt-0.5">{mlResult.confusionMatrix.fn}</p>
                        </div>
                        <div className="bg-green/10 p-2.5 rounded-lg border border-green/30">
                          <p className="text-[11px] text-green font-medium">True Negatives</p>
                          <p className="text-lg font-semibold text-green mt-0.5">{mlResult.confusionMatrix.tn}</p>
                        </div>
                      </div>
                    </div>
                  )}

                  {mlResult.confusionMatrix && !isBinaryConfusion(mlResult.confusionMatrix) && (mlResult.confusionMatrix as any).matrix && (
                    <div className="mt-5 border-t border-separator pt-4">
                      <p className="text-[11px] text-label-2 tabular-nums font-medium mb-2.5">Multiclass Confusion Matrix</p>
                      <div className="overflow-x-auto">
                        <table className="text-[11px] tabular-nums border-collapse">
                          <thead>
                            <tr>
                              <th className="p-1 text-label-3"></th>
                              {(mlResult.confusionMatrix as any).labels.map((l: string) => (
                                <th key={l} className="p-1 text-label-2 font-semibold">{l}</th>
                              ))}
                            </tr>
                          </thead>
                          <tbody>
                            {(mlResult.confusionMatrix as any).matrix.map((rowArr: number[], rIdx: number) => (
                              <tr key={rIdx}>
                                <td className="p-1 text-label-2 font-semibold">{(mlResult.confusionMatrix as any).labels[rIdx]}</td>
                                {rowArr.map((val, cIdx) => (
                                  <td key={cIdx} className={`p-1.5 text-center rounded ${rIdx === cIdx ? 'bg-green/15 text-green font-semibold' : 'bg-well text-label-2'}`}>{val}</td>
                                ))}
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    </div>
                  )}
                </div>

                {/* 2. REALTIME PREDICTION ARRAY TABLE GRID */}
                <div className="bg-surface border border-separator p-6 rounded-2xl col-span-2 space-y-4 shadow-sm">
                  <div className="flex items-center justify-between border-b border-separator pb-2.5">
                    <div>
                      <h4 className="font-semibold text-label text-sm">Predictions on test data</h4>
                      <p className="text-[11px] text-label-2 tabular-nums mt-0.5">Actual vs. predicted values on held-out rows the model never trained on</p>
                    </div>
                    <span className="text-[11px] tabular-nums bg-blue bg-blue/10 border border-blue/25 px-2.5 py-0.5 rounded text-blue font-semibold">
                      {mlResult.predictions.length} rows evaluated
                    </span>
                  </div>

                  <div className="overflow-x-auto text-xs">
                    <table className="w-full text-left border-collapse tabular-nums">
                      <thead>
                        <tr className="border-b border-separator text-label-2 text-[11px] font-semibold">
                          <th className="pb-2">Row ID</th>
                          <th className="pb-2">Actual</th>
                          <th className="pb-2">Predicted</th>
                          <th className="pb-2 text-right">Confidence</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-separator">
                        {mlResult.predictions
                          .slice((selectedRawPredPage - 1) * 6, selectedRawPredPage * 6)
                          .map((pred, i) => {
                            const isCorrect = String(pred.actual).toLowerCase() === String(pred.predicted).toLowerCase();
                            return (
                              <tr key={i} className="hover:bg-surface">
                                <td className="py-2.5 text-label-3 font-semibold">#{pred.id}</td>
                                <td className="py-2.5 font-semibold text-label">{String(pred.actual)}</td>
                                <td className="py-2.5 font-semibold text-label">
                                  {mlResult.modelType === 'classification' ? (
                                    <span className={isCorrect ? 'text-green' : 'text-red'}>{String(pred.predicted)}</span>
                                  ) : (
                                    String(pred.predicted)
                                  )}
                                </td>
                                <td className="py-2.5 text-right font-semibold text-blue">
                                  {pred.confidence !== undefined && pred.confidence !== null ? `${pred.confidence}%` : '—'}
                                </td>
                              </tr>
                            );
                          })}
                      </tbody>
                    </table>
                  </div>

                  <div className="flex justify-between items-center pt-2 tabular-nums text-[11px]">
                    <button
                      disabled={selectedRawPredPage === 1}
                      onClick={() => setSelectedRawPredPage(p => Math.max(1, p - 1))}
                      className="px-3 py-1 bg-surface border border-separator rounded hover:text-label cursor-pointer hover:border-separator-strong disabled:opacity-40"
                    >
                      Previous Index
                    </button>
                    <span className="text-label-2 font-semibold">Page {selectedRawPredPage} of {Math.max(1, Math.ceil(mlResult.predictions.length / 6))}</span>
                    <button
                      disabled={selectedRawPredPage >= Math.ceil(mlResult.predictions.length / 6)}
                      onClick={() => setSelectedRawPredPage(p => p + 1)}
                      className="px-3 py-1 bg-surface border border-separator rounded hover:text-label cursor-pointer hover:border-separator-strong disabled:opacity-40"
                    >
                      Next Index
                    </button>
                  </div>
                </div>

              </div>
            )}

            {/* REALM B: UNSUPERVISED LEARNING & DIMENSIONALITY REDUCTION (real K-Means + PCA on the active dataset) */}
            {activeRealm === 'unsupervised' && unsupervisedRes && (
              <div className="grid grid-cols-1 lg:grid-cols-3 gap-6 animate-fade-in text-xs">

                {/* 1. Clustering and PCA plots */}
                <div className="bg-surface border border-separator p-6 rounded-2xl col-span-2 space-y-4">
                  <div className="flex items-center justify-between border-b border-separator pb-2">
                    <div>
                      <h4 className="font-semibold text-label text-sm">PCA projection</h4>
                      <p className="text-[11px] text-label-2 tabular-nums mt-0.5">Real features projected into PC1 & PC2 eigenvectors, colored by real K-Means cluster</p>
                    </div>
                    <LineChart className="w-4.5 h-4.5 text-blue shrink-0" />
                  </div>

                  <div className="h-[220px]">
                    <ResponsiveContainer width="100%" height="100%">
                      <ScatterChart margin={{ top: 8, right: 10, left: -20, bottom: 5 }}>
                        <CartesianGrid stroke="var(--chart-grid)" strokeDasharray="3 3" />
                        <XAxis type="number" dataKey="pc1" name="PC1 Component" stroke="var(--chart-axis)" fontSize={9} />
                        <YAxis type="number" dataKey="pc2" name="PC2 Component" stroke="var(--chart-axis)" fontSize={9} />
                        <Tooltip
                          cursor={{ strokeDasharray: '3 3' }}
                          formatter={(value, name) => [value, name === 'clusterId' ? 'Cluster ID' : String(name).toUpperCase()]}
                        />
                        <Scatter name="PCA Project" data={unsupervisedRes.pcaComponents} fill="var(--chart-1)">
                          {unsupervisedRes.pcaComponents.map((pt, index) => {
                            const colors = ['var(--chart-1)', 'var(--chart-5)', 'var(--chart-2)', 'var(--chart-3)', 'var(--chart-4)'];
                            const dotColor = colors[pt.clusterId % colors.length];
                            return <Cell key={`cell-${index}`} fill={dotColor} />;
                          })}
                        </Scatter>
                      </ScatterChart>
                    </ResponsiveContainer>
                  </div>

                  {/* Variance explanations */}
                  <div className="bg-well rounded-xl p-4.5 border border-separator space-y-3">
                    <p className="text-[11px] font-medium text-label-2 tabular-nums">Principal Components Explained Variance Ratios</p>
                    <div className="grid grid-cols-2 gap-4">
                      {unsupervisedRes.explainedVarianceRatios.map((item, idx) => (
                        <div key={idx} className="space-y-1 tabular-nums text-[11px]">
                          <div className="flex justify-between font-semibold text-label">
                            <span>{item.component} Info Retained:</span>
                            <span className="text-label">{(item.ratio * 100).toFixed(1)}%</span>
                          </div>
                          <div className="w-full bg-surface rounded-full h-1.5 overflow-hidden">
                            <div className="bg-blue h-full rounded-full" style={{ width: `${item.ratio * 100}%` }} />
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                </div>

                {/* 2. Density metrics + Centroids map */}
                <div className="bg-surface border border-separator p-6 rounded-2xl flex flex-col justify-between space-y-4">
                  <div className="space-y-4">
                    <h4 className="font-medium text-label text-xs tabular-nums text-blue">Cluster diagnostics</h4>
                    <div className="grid grid-cols-2 gap-3 tabular-nums text-center">
                      <div className="bg-blue/5 border border-blue/10 p-3.5 rounded-xl">
                        <p className="text-[11px] text-label-2 font-medium">Silhouette Score</p>
                        <p className="text-xl font-semibold text-blue mt-1">{unsupervisedRes.silhouetteScore.toFixed(3)}</p>
                      </div>
                      <div className="bg-green/5 border border-green/10 p-3.5 rounded-xl">
                        <p className="text-[11px] text-label-2 font-medium">Davies-Bouldin Index</p>
                        <p className="text-xl font-semibold text-green mt-1">{unsupervisedRes.daviesBouldinIndex.toFixed(3)}</p>
                      </div>
                    </div>

                    <div className="space-y-2 mt-4">
                      <p className="text-[11px] text-label-2 tabular-nums font-medium">Cluster Mathematical Centroids</p>
                      <div className="space-y-2 max-h-[170px] overflow-y-auto pr-1">
                        {unsupervisedRes.centroids.map((cent, idx) => (
                          <div key={idx} className="bg-well p-2.5 rounded-xl border border-separator tabular-nums text-[11px] space-y-1 hover:border-separator-strong transition">
                            <div className="flex justify-between border-b border-separator pb-1 mb-1">
                              <span className="font-semibold text-label">Cluster #{cent.clusterId} (n={cent.size})</span>
                              <span className="text-blue font-semibold">Center point</span>
                            </div>
                            {Object.entries(cent.coordinates).slice(0, 3).map(([key, val]) => (
                              <div key={key} className="flex justify-between text-label-2">
                                <span className="truncate max-w-[120px]">{key}:</span>
                                <span className="font-semibold text-label">{val}</span>
                              </div>
                            ))}
                          </div>
                        ))}
                      </div>
                    </div>
                  </div>

                  <p className="text-[11px] text-label-2 italic tabular-nums leading-tight pt-2 border-t border-separator">
                    *K-Means partitioned the records by optimizing Euclidean distance parameters globally across all coordinates. Silhouette/Davies-Bouldin computed directly from these real assignments.
                  </p>
                </div>

              </div>
            )}

            {/* REALM C: ENSEMBLE METHODS (real Random Forest tree splits, when available) */}
            {activeRealm === 'ensemble' && (
              <div className="grid grid-cols-1 lg:grid-cols-3 gap-6 animate-fade-in text-xs">

                {/* 1. Feature Importance Rankings (real, from the trained model — any algorithm) */}
                <div className="bg-surface border border-separator p-6 rounded-2xl space-y-4">
                  <div className="flex items-center justify-between border-b border-separator pb-2">
                    <h4 className="font-medium text-label text-xs tabular-nums text-blue">{importanceLabel}</h4>
                    <BarChart2 className="w-4 h-4 text-blue shrink-0" />
                  </div>

                  <div className="h-[210px] mt-2">
                    <ResponsiveContainer width="100%" height="100%">
                      <BarChart
                        data={importanceData}
                        layout="vertical"
                        margin={{ top: 5, right: 10, left: -20, bottom: 5 }}
                      >
                        <CartesianGrid strokeDasharray="3 3" horizontal={false} stroke="var(--chart-grid)" />
                        <XAxis type="number" stroke="var(--chart-axis)" tickFormatter={(v) => `${(v * 100).toFixed(0)}%`} fontSize={9} />
                        <YAxis type="category" dataKey="feature" stroke="var(--chart-axis)" fontSize={9} tickLine={false} />
                        <Tooltip
                          formatter={(val: any) => [`${(val * 100).toFixed(1)}%`, hasShap ? 'Mean |SHAP value| (normalized)' : 'Real Importance Weight']}
                        />
                        <Bar dataKey="score" fill="var(--chart-1)" radius={[0, 4, 4, 0]} />
                      </BarChart>
                    </ResponsiveContainer>
                  </div>
                  {hasShap && (
                    <p className="text-[11px] text-label-3 leading-tight tabular-nums">
                      Computed via SHAP on a real held-out test sample — the model-agnostic, game-theoretic gold standard for feature attribution.
                    </p>
                  )}

                  {mlResult.oobScore !== undefined && mlResult.oobScore !== null && (
                    <div className="bg-well p-3 rounded-xl border border-separator flex justify-between items-center tabular-nums">
                      <span className="text-label-2 font-semibold">Real Out-Of-Bag (OOB) Score:</span>
                      <span className="px-2.5 py-1 bg-blue/10 border border-blue/20 text-blue font-semibold rounded text-[11px]">
                        {(mlResult.oobScore * 100).toFixed(2)}%
                      </span>
                    </div>
                  )}
                </div>

                {/* 2. Estimators Individual Tree Explorer — real Random Forest trees only */}
                <div className="bg-surface border border-separator p-6 rounded-2xl col-span-2 space-y-4 shadow-sm">
                  <div className="flex items-center justify-between border-b border-separator pb-2.5">
                    <div>
                      <h4 className="font-semibold text-label text-sm">Decision tree explorer</h4>
                      <p className="text-[11px] text-label-2 tabular-nums mt-0.5">Real root-split data read directly from fitted Random Forest trees</p>
                    </div>
                    <GitBranch className="w-4.5 h-4.5 text-blue shrink-0" />
                  </div>

                  {mlResult.estimators && mlResult.estimators.length > 0 ? (
                    <div className="grid grid-cols-1 md:grid-cols-3 gap-4.5">
                      {/* List element column */}
                      <div className="space-y-1.5 md:col-span-1 max-h-[220px] overflow-y-auto pr-1">
                        {mlResult.estimators.map((estim, idx) => (
                          <button
                            key={estim.id}
                            onClick={() => setSelectedEstimatorIdx(idx)}
                            className={`w-full text-left tabular-nums text-[11px] p-2.5 rounded-lg border cursor-pointer transition flex items-center justify-between ${
                              selectedEstimatorIdx === idx
                                ? 'bg-blue border-blue text-white font-semibold shadow'
                                : 'bg-well border-separator text-label-2 hover:text-label hover:border-separator-strong'
                            }`}
                          >
                            <span>{estim.name}</span>
                            <ChevronRight className="w-3.5 h-3.5 shrink-0" />
                          </button>
                        ))}
                      </div>

                      {/* Estimator details block */}
                      {mlResult.estimators[selectedEstimatorIdx] && (
                        <div className="md:col-span-2 bg-well rounded-xl p-4.5 border border-separator space-y-4 tabular-nums">
                          <div className="flex justify-between items-center border-b border-separator pb-2">
                            <span className="font-semibold text-blue text-xs">
                              {mlResult.estimators[selectedEstimatorIdx].name} Root Split
                            </span>
                            <span className="text-[11px] text-label-3">
                              Impurity: {mlResult.estimators[selectedEstimatorIdx].impurity}
                            </span>
                          </div>

                          <div className="p-2.5 bg-blue bg-blue/10 border border-blue/25 rounded-lg flex flex-col items-center justify-center text-center">
                            <span className="text-[11px] text-label-2 font-medium text-blue">Real Root Decision Split</span>
                            <span className="font-semibold text-label mt-1">If [{mlResult.estimators[selectedEstimatorIdx].splitFeature}] &le; {mlResult.estimators[selectedEstimatorIdx].splitValue}</span>
                          </div>

                          <div className="grid grid-cols-2 gap-4 text-center">
                            <div className="p-2.5 bg-surface border border-separator rounded-lg">
                              <span className="text-[11px] text-label-2 font-medium block">Tree Depth</span>
                              <span className="font-semibold text-label text-sm mt-0.5 block">{mlResult.estimators[selectedEstimatorIdx].treeDepth}</span>
                            </div>
                            <div className="p-2.5 bg-surface border border-separator rounded-lg">
                              <span className="text-[11px] text-label-2 font-medium block">Leaf Count</span>
                              <span className="font-semibold text-label text-sm mt-0.5 block">{mlResult.estimators[selectedEstimatorIdx].leafCount}</span>
                            </div>
                          </div>

                          <div className="pt-2 border-t border-separator text-[11px] text-label-3 flex justify-between">
                            <span>Root Node Samples: {mlResult.estimators[selectedEstimatorIdx].sampleCount} rows</span>
                          </div>
                        </div>
                      )}
                    </div>
                  ) : (
                    <div className="p-6 text-center bg-well border border-separator rounded-xl text-xs text-label-2 flex flex-col items-center gap-2">
                      <Info className="w-5 h-5 text-label-3" />
                      Individual tree exploration is available for Random Forest models. Current champion: <strong className="text-label">{mlResult.modelAlgorithm}</strong>. Select "Random Forest" from the algorithm dropdown and retrain to explore real trees.
                    </div>
                  )}
                </div>

              </div>
            )}

            {/* REALM D: DEEP LEARNING — real MLP loss curve, only when an MLP was trained */}
            {activeRealm === 'deep_learning' && (
              <div className="grid grid-cols-1 lg:grid-cols-3 gap-6 animate-fade-in text-xs">
                {mlResult.deepLearning ? (
                  <>
                    {/* 1. Training Epoch Loss curve (real loss_curve_ + real validation_scores_) */}
                    <div className="bg-surface border border-separator p-6 rounded-2xl col-span-1 space-y-4">
                      <div className="flex items-center justify-between border-b border-separator pb-2">
                        <h4 className="font-medium text-label text-xs tabular-nums text-blue">Training loss</h4>
                        <LineChart className="w-4 h-4 text-blue shrink-0" />
                      </div>

                      <div className="h-[170px]">
                        <ResponsiveContainer width="100%" height="100%">
                          <RechartsLineChart data={mlResult.deepLearning.trainingLogs}>
                            <CartesianGrid stroke="var(--chart-grid)" strokeDasharray="3 3" />
                            <XAxis dataKey="epoch" stroke="var(--chart-axis)" fontSize={9} />
                            <YAxis stroke="var(--chart-axis)" fontSize={9} />
                            <Tooltip />
                            <Legend wrapperStyle={{ fontSize: '9px' }} />
                            <Line type="monotone" dataKey="trainingLoss" stroke="var(--chart-1)" activeDot={{ r: 6 }} strokeWidth={2} name="Training loss" />
                          </RechartsLineChart>
                        </ResponsiveContainer>
                      </div>

                      <div className="bg-well p-3 rounded-xl border border-separator space-y-1 tabular-nums text-[11px]">
                        <div className="flex justify-between text-label-3">
                          <span>Iterations Run:</span>
                          <span className="text-label font-semibold">{mlResult.deepLearning.nIterations}</span>
                        </div>
                        <div className="flex justify-between text-label-3">
                          <span>Initial Training Loss:</span>
                          <span>{mlResult.deepLearning.trainingLogs[0]?.trainingLoss.toFixed(4)}</span>
                        </div>
                        <div className="flex justify-between text-label-3">
                          <span>Final Training Loss:</span>
                          <span className="text-label font-semibold">{mlResult.deepLearning.trainingLogs[mlResult.deepLearning.trainingLogs.length - 1]?.trainingLoss.toFixed(4)}</span>
                        </div>
                        {mlResult.deepLearning.finalValidationScore !== undefined && mlResult.deepLearning.finalValidationScore !== null && (
                          <div className="flex justify-between text-green pt-1 border-t border-separator">
                            <span>Final Validation {mlResult.deepLearning.validationMetric === 'accuracy' ? 'Accuracy' : 'R²'}:</span>
                            <span className="font-semibold">
                              {mlResult.deepLearning.validationMetric === 'accuracy'
                                ? `${(mlResult.deepLearning.finalValidationScore * 100).toFixed(1)}%`
                                : mlResult.deepLearning.finalValidationScore.toFixed(3)}
                            </span>
                          </div>
                        )}
                      </div>
                    </div>

                    {/* 2. Real network architecture summary */}
                    <div className="bg-surface border border-separator p-6 rounded-2xl col-span-2 space-y-4 shadow-sm">
                      <div className="flex items-center justify-between border-b border-separator pb-2">
                        <div>
                          <h4 className="font-semibold text-label text-sm">Network architecture</h4>
                          <p className="text-[11px] text-label-2 tabular-nums mt-0.5 font-semibold">Actual scikit-learn MLP hidden layer sizes and trainable parameter count</p>
                        </div>
                        <Workflow className="w-4.5 h-4.5 text-blue shrink-0" />
                      </div>

                      <div className="grid grid-cols-1 md:grid-cols-3 gap-4 tabular-nums text-[11px]">
                        <div className="bg-well p-4 rounded-xl border border-separator space-y-1.5 text-center">
                          <span className="text-[11px] text-label-2 font-medium block">Input → Hidden Layers</span>
                          <span className="font-semibold text-blue text-sm">{mlResult.deepLearning.hiddenLayerSizes.join(' → ')}</span>
                        </div>
                        <div className="bg-well p-4 rounded-xl border border-separator space-y-1.5 text-center">
                          <span className="text-[11px] text-label-2 font-medium block">Total Layers</span>
                          <span className="font-semibold text-label text-sm">{mlResult.deepLearning.nLayers}</span>
                        </div>
                        <div className="bg-well p-4 rounded-xl border border-separator space-y-1.5 text-center">
                          <span className="text-[11px] text-label-2 font-medium block">Trainable Parameters</span>
                          <span className="font-semibold text-label text-sm">{mlResult.deepLearning.totalTrainableParams.toLocaleString()}</span>
                        </div>
                      </div>

                      <p className="text-[11px] text-label-3 leading-relaxed pt-2 border-t border-separator">
                        Trained with early stopping enabled — a real 10% internal validation split is used to halt training once performance plateaus, rather than always running the full iteration budget.
                      </p>
                    </div>
                  </>
                ) : (
                  <div className="col-span-3 p-6 text-center bg-well border border-separator rounded-xl text-xs text-label-2 flex flex-col items-center gap-2">
                    <Info className="w-5 h-5 text-label-3" />
                    Real training-loss curves are shown when a Multi-Layer Perceptron is trained. Current champion: <strong className="text-label">{mlResult.modelAlgorithm}</strong>. Select "Multi-Layer Perceptron" from the algorithm dropdown and retrain.
                  </div>
                )}
              </div>
            )}

            {/* REALM E: COMPARISON DASHBOARD */}
            {activeRealm === 'comparison' && (
              <div className="grid grid-cols-1 lg:grid-cols-3 gap-6 animate-fade-in text-xs">
                {/* Winner Card */}
                <div className="lg:col-span-1 space-y-6">
                  <div className="bg-green/10 border border-green/30 p-6 rounded-2xl relative overflow-hidden flex flex-col hover:border-green/50 transition-colors">
                    <div className="absolute top-0 right-0 p-4 opacity-10 filter blur-[2px]">
                      <Trophy className="w-32 h-32 text-green" />
                    </div>
                    <div className="relative z-10 space-y-4 flex-1">
                      <div className="inline-flex items-center gap-1.5 px-3 py-1 bg-green/20 text-green font-semibold tabular-nums text-[11px] rounded-full border border-green/30 shadow-sm">
                        <CheckCircle className="w-3.5 h-3.5" /> REAL CHAMPION MODEL
                      </div>
                      <div className="space-y-1 mt-6">
                        <h3 className="text-xl font-semibold text-label">{mlResult.modelAlgorithm}</h3>
                        <p className="text-green text-xs tabular-nums tracking-tight">Evaluated on held-out test data</p>
                      </div>

                      {mlResult.comparison && mlResult.comparison[0] && (
                        <div className="pt-6 mt-8 border-t border-green/20">
                          <p className="text-[11px] text-green font-medium mb-1">Winning {mlResult.comparison[0].primaryMetric}</p>
                          <p className="text-3xl font-semibold text-green tabular-nums tracking-tighter">
                            {mlResult.comparison[0].primaryMetric.toLowerCase().includes('accuracy')
                              ? `${(mlResult.comparison[0].metricValue * 100).toFixed(2)}%`
                              : mlResult.comparison[0].metricValue.toFixed(3)}
                          </p>
                        </div>
                      )}
                    </div>
                  </div>
                </div>

                {/* Score comparison grid */}
                <div className="lg:col-span-2 bg-surface border border-separator p-6 rounded-2xl flex flex-col shadow-sm overflow-hidden">
                  <h4 className="text-xs font-medium text-label tabular-nums mb-6 flex justify-between items-center bg-well p-3 rounded-xl border border-separator">
                    <span className="flex items-center gap-2"><Sparkles className="w-4 h-4 text-blue" /> Real Side-by-Side Algorithm Comparison</span>
                    <span className="text-blue bg-blue/10 px-3 py-1 rounded-md border border-blue/20 text-[11px]">
                      EVAL MATRIX
                    </span>
                  </h4>

                  <div className="flex-1 overflow-x-auto pb-4 scrollbar-thin scrollbar-thumb-slate-800 scrollbar-track-transparent">
                    <div className="flex gap-4 h-full min-w-max">
                      {(mlResult.comparison || []).map((c, idx) => {
                        const isWinner = idx === 0;
                        return (
                          <div key={c.modelKey} className={`w-[260px] rounded-xl border p-5 flex flex-col justify-between shrink-0 relative overflow-hidden transition-all duration-300 ${isWinner ? 'bg-green/10 border-green/30' : 'bg-well border-separator hover:border-blue/30'}`}>

                            <div>
                              <div className="flex items-center justify-between mb-4">
                                <span className={`text-[11px] font-semibold tabular-nums px-2.5 py-1 rounded-full border ${isWinner ? 'bg-green/10 text-green border-green/20' : 'bg-fill text-label-2 border-separator-strong'}`}>
                                  RANK #{idx + 1}
                                </span>
                                {isWinner && <CheckCircle className="w-4 h-4 text-green animate-pulse" />}
                              </div>

                              <h3 className={`text-base font-semibold leading-tight mb-1 ${isWinner ? 'text-label' : 'text-label'}`}>
                                {c.modelName}
                              </h3>
                              <p className="text-xs text-label-3 tabular-nums tracking-tight mb-6">
                                Real held-out evaluation
                              </p>

                              <div className="space-y-4">
                                <div>
                                  <p className="text-[11px] text-label-3 font-medium mb-1">{c.primaryMetric}</p>
                                  <p className={`text-2xl font-semibold tabular-nums tracking-tighter ${isWinner ? 'text-green' : 'text-blue'}`}>
                                    {c.primaryMetric.toLowerCase().includes('accuracy') ? `${(c.metricValue * 100).toFixed(2)}%` : c.metricValue.toFixed(3)}
                                  </p>
                                </div>

                                <div className="h-px w-full bg-fill" />

                                <div className="flex items-center justify-between">
                                  <span className="text-[11px] text-label-3 font-medium">Execution Time</span>
                                  <span className="text-xs tabular-nums text-label">{c.executionTimeMs.toLocaleString()} ms</span>
                                </div>
                              </div>
                            </div>

                            <div className={`mt-6 pt-4 border-t ${isWinner ? 'border-green/20' : 'border-separator'}`}>
                              <p className={`text-[11px] leading-relaxed font-medium ${isWinner ? 'text-green' : 'text-label-3'}`}>
                                {isWinner ? 'Highest real test-set score among the models trained this run.' : 'Also trained and evaluated on the identical held-out split.'}
                              </p>
                            </div>
                          </div>
                        );
                      })}
                      {(!mlResult.comparison || mlResult.comparison.length <= 1) && (
                        <div className="text-label-3 text-xs p-6">Only one model was trained. Pick "AUTO" from the algorithm dropdown to compare multiple real models side by side.</div>
                      )}
                    </div>
                  </div>
                </div>
              </div>
            )}

            {/* REALM F: AGENTIC ANALYSIS — reason -> act -> observe loop against real ml-service functions */}
            {activeRealm === 'agent' && (
              mlResult.comparison && mlResult.comparison[0] ? (
                <AgentAnalysis
                  dataset={dataset}
                  target={target}
                  features={selectedFeatures}
                  championModelKey={mlResult.comparison[0].modelKey}
                  primaryMetric={mlResult.comparison[0].primaryMetric}
                  primaryMetricValue={mlResult.comparison[0].metricValue}
                />
              ) : (
                <div className="p-6 text-center bg-well border border-separator rounded-xl text-xs text-label-2">
                  Train a model first to unlock agentic analysis.
                </div>
              )
            )}

            {/* MODEL EXPLAINER MODULE — narrates the real feature importances above */}
            <ModelExplainer result={mlResult} />


          </div>

        </div>
      )}

    </div>
  );
}

/** How this model was evaluated: the split, tuning, and any columns that look like leaks. */
function RunDetails({ result }: { result: MLResult }) {
  const split = result.split;
  const leaks = result.leakageWarnings ?? [];
  const tuning = result.tuning;
  if (!split && !leaks.length && !tuning) return null;
  return (
    <div className="space-y-3">
      {leaks.length > 0 && (
        <div role="alert" className="rounded-2xl bg-orange/10 px-4 py-3 text-sm">
          <p className="font-semibold text-label">Possible data leakage</p>
          <ul className="mt-1 space-y-0.5 text-label-2">
            {leaks.map(l => <li key={l.column}><span className="font-medium text-label">{l.column}</span>: {l.reason}</li>)}
          </ul>
          <p className="mt-1 text-xs text-label-2">A column that already contains the answer makes the score look better than it will be on new data. Untick it under the features and train again.</p>
        </div>
      )}
      {split && (
        <p className="text-sm text-label-2">
          <span className="font-medium text-label">Evaluation:</span>{' '}
          {split.strategy === 'time'
            ? `trained on rows up to ${split.trainUntil}, tested on ${split.testFrom} – ${split.testTo} (${split.testRows} rows); cross-validation only trains on earlier rows.`
            : split.strategy === 'group'
            ? `${split.trainGroups} “${split.groupColumn}” groups for training, ${split.testGroups} different groups for testing (${split.testRows} rows).`
            : `${split.trainRows} rows for training and ${split.testRows} randomly chosen rows for testing.`}
          {' '}Seed {split.seed}; the same settings give the same result.
        </p>
      )}
      {tuning?.tuned && (
        <div className="rounded-2xl bg-well px-4 py-3 text-sm">
          <p className="text-label">
            <span className="font-medium">Tuned over {tuning.iterations} trials</span> — best cross-validated {tuning.metric}: {tuning.bestCvScore}
          </p>
          <p className="mt-1 text-xs text-label-2 font-code break-words">
            {Object.entries(tuning.bestParams ?? {}).map(([k, v]) => `${k} = ${Array.isArray(v) ? `(${v.join(', ')})` : String(v)}`).join(' · ')}
          </p>
        </div>
      )}
      {tuning && !tuning.tuned && tuning.reason && <p className="text-xs text-label-2">{tuning.reason}</p>}
    </div>
  );
}
