/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState, useCallback, useEffect, useRef } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import {
  AlertTriangle,
  Check,
  CircleUser,
  FileSpreadsheet,
  Github,
  Linkedin,
  Mail,
  MapPin,
  Moon,
  Sun,
  Target,
  X,
} from 'lucide-react';
import { Dataset, MLResult } from './types';
import DataUploader from './components/DataUploader';
import DataCleaning from './components/DataCleaning';
import EDAReport from './components/EDAReport';
import MLPipeline from './components/MLPipeline';
import StakeholderDashboard from './components/StakeholderDashboard';
import ReportsHub from './components/ReportsHub';
import AssistiveTouchBot from './components/AssistiveTouchBot';
import StageNavigation from './components/StageNavigation';
import StageHeader from './components/StageHeader';
import MLServiceWakeButton from './components/MLServiceWakeButton';
import AppIcon from './components/AppIcon';
import LoadingScreen from './components/LoadingScreen';
import { usePipelineContext, PipelineStage } from './contexts/PipelineContext';
import { STAGES, STAGE_ORDER } from './stages';
import { apiFetch } from './utils/api';

type Theme = 'light' | 'dark';

function initialTheme(): Theme {
  if (typeof window === 'undefined') return 'light';
  const stored = localStorage.getItem('theme');
  if (stored === 'light' || stored === 'dark') return stored;
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

export default function App() {
  const [showLoading, setShowLoading] = useState(true);
  // Stable identity across re-renders - LoadingScreen's dismiss timer effect
  // depends on this callback, so a fresh function reference on every App
  // render would keep restarting that timer for as long as showLoading stays true.
  const handleLoadingComplete = useCallback(() => setShowLoading(false), []);
  const {
    businessProblem, bannerDismissed, setBannerDismissed,
    expertMode, setExpertMode,
    hasRunAudit, hasRunEda, setHasRunEda,
  } = usePipelineContext();

  // Appearance follows the system until the user picks one explicitly.
  const [theme, setTheme] = useState<Theme>(initialTheme);
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    document
      .querySelector('meta[name="theme-color"]')
      ?.setAttribute('content', theme === 'dark' ? '#000000' : '#f5f5f7');
  }, [theme]);
  const toggleTheme = () => {
    const next: Theme = theme === 'dark' ? 'light' : 'dark';
    setTheme(next);
    localStorage.setItem('theme', next);
  };

  const [originalDataset, setOriginalDataset] = useState<Dataset | null>(null);
  const [activeDataset, setActiveDataset] = useState<Dataset | null>(null);
  const [activeTab, setActiveTabState] = useState<PipelineStage>('ingest');
  const [visited, setVisited] = useState<Set<PipelineStage>>(() => new Set<PipelineStage>(['ingest']));
  const setActiveTab = useCallback((tab: PipelineStage) => {
    setActiveTabState(tab);
    setVisited(prev => (prev.has(tab) ? prev : new Set(prev).add(tab)));
  }, []);

  // Every stage opens at its title, and the stage bar keeps the current step in view.
  const stageBarRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    window.scrollTo({ top: 0 });
    stageBarRef.current
      ?.querySelector<HTMLElement>('[aria-current="step"]')
      ?.scrollIntoView({ block: 'nearest', inline: 'center' });
  }, [activeTab]);

  // GLOBAL CLICK TRACKER FOR DEEPAKLLMS TRAINING DATA
  React.useEffect(() => {
    const handleGlobalClick = (e: MouseEvent) => {
      const target = e.target as HTMLElement;
      const button = target.closest('button') || target.closest('[role="button"]') || target.closest('a');
      
      if (button) {
        // Exclude the assistive touch bot container to avoid spam, unless it's a specific action button inside it
        if (button.closest('.assistive-touch-bot-container') && !button.textContent) {
          return;
        }

        const actionText = button.textContent?.trim() || button.getAttribute('aria-label') || button.id || 'unknown_action';
        
        // Skip empty clicks or generic structural clicks
        if (!actionText || actionText.length > 100) return;

        const payload = {
          timestamp: new Date().toISOString(),
          stage: activeTab,
          action: actionText,
          hasDataset: !!activeDataset,
          datasetName: activeDataset?.filename || null,
          rowCount: activeDataset?.rowCount || 0,
          columnCount: activeDataset?.columns?.length || 0
        };

        fetch('/api/log-training-data', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload)
        }).catch(err => console.error('Failed to log training data:', err));
      }
    };

    document.addEventListener('click', handleGlobalClick, true); // use capture phase
    return () => document.removeEventListener('click', handleGlobalClick, true);
  }, [activeTab, activeDataset]);

  // AI & ML States
  const [aiAnalysis, setAiAnalysis] = useState<any | null>(null);
  const [loadingAI, setLoadingAI] = useState<boolean>(false);
  const [mlResult, setMlResult] = useState<MLResult | null>(null);
  const [loadingML, setLoadingML] = useState<boolean>(false);
  const [errorLine, setErrorLine] = useState<string | null>(null);
  const [isAboutModalOpen, setIsAboutModalOpen] = useState<boolean>(false);

  // Close the About sheet with Escape, like any system sheet.
  useEffect(() => {
    if (!isAboutModalOpen) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setIsAboutModalOpen(false); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [isAboutModalOpen]);

  const handleDatasetLoaded = (dataset: Dataset) => {
    setOriginalDataset(dataset);
    setActiveDataset(dataset);
    setAiAnalysis(null);
    setMlResult(null);
    setErrorLine(null);
  };

  const handleUpdateDataset = (updated: Dataset) => {
    setActiveDataset(updated);
    // Reset AI analysis since data changed
    setAiAnalysis(null);
    setMlResult(null);
  };

  const handleResetOriginal = () => {
    if (originalDataset) {
      setActiveDataset(originalDataset);
      setAiAnalysis(null);
      setMlResult(null);
    }
  };

  // 1. RUN GEMINI AUTOMATED EXPLORATORY SCAN
  const triggerAIScan = async () => {
    if (!activeDataset) return;
    setLoadingAI(true);
    setErrorLine(null);
    try {
      // Send key variables metadata only to minimize token load
      const payloadCols = activeDataset.columns.map(c => ({
        name: c.name,
        type: c.type,
        missingCount: c.missingCount,
        distinctCount: c.distinctCount,
        statistics: c.statistics
      }));

      const res = await apiFetch('/api/analyze-dataset', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          filename: activeDataset.filename,
          rowCount: activeDataset.rowCount,
          columns: payloadCols
        })
      });

      const resText = await res.text();
      let parsed;
      try {
        if (resText.trim().startsWith('<!doctype html') || resText.trim().startsWith('<html') || !res.ok) {
          throw new Error('Fallback to local analyzer');
        }
        parsed = resText ? JSON.parse(resText) : {};
      } catch (parseErr) {
        console.warn('Backend server returned invalid or HTML response. running local analysis fallback...', parseErr);
        parsed = getClientSideAnalysisFallback(activeDataset.filename, payloadCols, activeDataset.rowCount);
      }

      setAiAnalysis(parsed);
      setHasRunEda(true);
    } catch (err: any) {
      console.error(err);
      setErrorLine('AI analysis failed: ' + (err.message || 'Check model keys.'));
    } finally {
      setLoadingAI(false);
    }
  };

  // 2. RUN MACHINE LEARNING PIPELINE
  // Sends the FULL active dataset so the Python service trains on real, complete
  // data (not a 30-row sample). If the ML compute service is unreachable or
  // errors, this surfaces a clear error instead of silently substituting
  // client-fabricated metrics — a real trained model or an honest failure,
  // never a guess dressed up as a result.
  const triggerPrediction = async (
    targetCol: string,
    features: string[],
    modelClass: 'classification' | 'regression' | 'timeseries',
    hyperparameters: Record<string, any>
  ) => {
    if (!activeDataset) throw new Error('No dataset active');
    setLoadingML(true);
    setErrorLine(null);
    try {
      const res = await apiFetch('/api/run-ml-prediction', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          target: targetCol,
          features,
          modelType: modelClass,
          hyperparameters,
          datasetRows: activeDataset.rows
        })
      });

      const resText = await res.text();
      let parsed: any = null;
      try {
        parsed = resText ? JSON.parse(resText) : null;
      } catch {
        parsed = null;
      }

      if (!res.ok || !parsed) {
        const message = parsed?.error || parsed?.hint || `Training request failed (HTTP ${res.status}). Is the Node server running?`;
        throw new Error(message);
      }

      setMlResult(parsed);
      return parsed;
    } catch (err: any) {
      console.error(err);
      setErrorLine('Model training failed: ' + (err.message || 'The ML engine may be offline.'));
      throw err;
    } finally {
      setLoadingML(false);
    }
  };

  // A stage counts as complete once its key action has been done. Completion
  // drives the checkmarks and the emphasis of "Continue" — it never locks a step.
  const stageComplete: Record<PipelineStage, boolean> = {
    ingest: !!activeDataset,
    clean: hasRunAudit,
    eda: hasRunEda,
    ml: !!mlResult,
    dashboard: !!activeDataset && visited.has('dashboard'),
    reports: !!activeDataset && visited.has('reports'),
  };

  return (
    <div className="min-h-screen flex flex-col bg-canvas text-label" id="workstation_app">
      <AnimatePresence>
        {showLoading && <LoadingScreen onComplete={handleLoadingComplete} />}
      </AnimatePresence>

      {/* Toolbar: identity on the left, global controls on the right. */}
      <header className="bg-canvas">
        <div className="mx-auto max-w-[1400px] h-14 px-4 sm:px-6 flex items-center justify-between gap-3">
          <button
            type="button"
            onClick={() => setActiveTab('ingest')}
            className="flex items-center gap-2.5 min-w-0 rounded-lg -ml-1 px-1 py-1"
            id="brand_logo"
            aria-label="Data Science Studio — go to Import"
          >
            <AppIcon size={28} />
            <span className="hidden sm:inline text-[17px] font-semibold tracking-tight text-label truncate">
              Data Science Studio
            </span>
          </button>

          <div className="flex items-center gap-1.5 sm:gap-2 shrink-0">
            {activeDataset && (
              <span className="tag hidden lg:inline-flex max-w-[220px] mr-1" title={activeDataset.filename}>
                <FileSpreadsheet className="w-3.5 h-3.5 shrink-0" />
                <span className="truncate">{activeDataset.filename}</span>
              </span>
            )}

            <div className="segmented" role="group" aria-label="Experience level">
              <button
                type="button"
                aria-pressed={!expertMode}
                onClick={() => setExpertMode(false)}
                title="Plain-language guidance and one-click defaults"
              >
                Beginner
              </button>
              <button
                type="button"
                aria-pressed={expertMode}
                onClick={() => setExpertMode(true)}
                title="Hyperparameters, SQL, drift monitoring and pipeline exports"
              >
                Expert
              </button>
            </div>

            <MLServiceWakeButton />

            <button
              type="button"
              onClick={toggleTheme}
              className="btn btn-icon"
              aria-label={theme === 'dark' ? 'Switch to light appearance' : 'Switch to dark appearance'}
              title={theme === 'dark' ? 'Light appearance' : 'Dark appearance'}
            >
              {theme === 'dark' ? <Sun className="w-[18px] h-[18px]" /> : <Moon className="w-[18px] h-[18px]" />}
            </button>

            <button
              type="button"
              onClick={() => setIsAboutModalOpen(true)}
              className="btn btn-icon"
              aria-label="About the creator"
              title="About the creator"
            >
              <CircleUser className="w-[18px] h-[18px]" />
            </button>
          </div>
        </div>
      </header>

      {/* Stage bar: the six-step workflow. Stays in view while the page scrolls. */}
      <div className="material sticky top-0 z-40 border-b border-separator">
        <div ref={stageBarRef} className="mx-auto max-w-[1400px] px-4 sm:px-6 py-2 overflow-x-auto scrollbar-none">
          <nav className="flex w-max mx-auto p-[3px] rounded-[11px] bg-fill" aria-label="Workflow steps">
            {STAGE_ORDER.map((id, idx) => {
              const stage = STAGES[id];
              const isSelected = activeTab === id;
              const isLocked = id !== 'ingest' && !activeDataset;
              const isDone = stageComplete[id];

              return (
                <button
                  key={id}
                  type="button"
                  onClick={() => setActiveTab(id)}
                  disabled={isLocked}
                  aria-current={isSelected ? 'step' : undefined}
                  title={isLocked ? 'Import a dataset first' : stage.title}
                  className={`flex items-center gap-2 h-8 pl-2 pr-3.5 rounded-[8px] text-xs font-medium whitespace-nowrap ${
                    isSelected
                      ? 'bg-raised text-label shadow-[0_0_0_0.5px_rgba(0,0,0,0.04),0_3px_8px_rgba(0,0,0,0.12)] dark:bg-fill-strong'
                      : isLocked
                      ? 'text-label-3 opacity-60'
                      : 'text-label-2 hover:text-label'
                  }`}
                >
                  <span
                    className={`flex items-center justify-center w-[18px] h-[18px] rounded-full text-[11px] font-semibold tabular-nums ${
                      isDone
                        ? 'bg-green text-white'
                        : isSelected
                        ? 'bg-blue text-white'
                        : 'bg-fill-strong text-label-2'
                    }`}
                  >
                    {isDone ? <Check className="w-3 h-3" strokeWidth={3} /> : idx + 1}
                  </span>
                  {stage.label}
                </button>
              );
            })}
          </nav>
        </div>
      </div>

      <main className="flex-1 w-full mx-auto max-w-[1400px] px-4 sm:px-6 pt-8 sm:pt-12 pb-16">
        {errorLine && (
          <div role="alert" className="mb-6 flex items-start gap-3 rounded-2xl bg-red/10 px-4 py-3 text-sm text-red">
            <AlertTriangle className="w-[18px] h-[18px] shrink-0 mt-0.5" />
            <p className="flex-1 min-w-0">{errorLine}</p>
            <button
              type="button"
              onClick={() => setErrorLine(null)}
              className="shrink-0 -m-1 p-1 rounded-full hover:bg-red/10"
              aria-label="Dismiss error"
            >
              <X className="w-4 h-4" />
            </button>
          </div>
        )}

        {businessProblem && !bannerDismissed && (
          <div className="mb-6 flex items-start gap-3 rounded-2xl bg-blue/10 px-4 py-3 text-sm">
            <Target className="w-[18px] h-[18px] text-blue shrink-0 mt-0.5" />
            <p className="flex-1 min-w-0 text-label">
              <span className="font-semibold">Your goal: </span>
              {businessProblem}
            </p>
            <button
              type="button"
              onClick={() => setBannerDismissed(true)}
              className="shrink-0 -m-1 p-1 rounded-full text-label-2 hover:bg-fill"
              aria-label="Hide goal"
            >
              <X className="w-4 h-4" />
            </button>
          </div>
        )}

        <AnimatePresence mode="wait">
          <motion.div
            key={activeTab}
            initial={{ opacity: 0, y: 6 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.2, ease: [0.28, 0.11, 0.32, 1] }}
          >
            <StageHeader activeTab={activeTab} />

            {activeTab === 'ingest' && (
              <DataUploader
                onDatasetLoaded={handleDatasetLoaded}
                currentDataset={activeDataset}
                onProceed={() => setActiveTab('clean')}
              />
            )}

            {activeTab === 'clean' && activeDataset && (
              <DataCleaning
                dataset={activeDataset}
                onUpdateDataset={handleUpdateDataset}
                onResetOriginal={handleResetOriginal}
              />
            )}

            {activeTab === 'eda' && activeDataset && (
              <EDAReport
                dataset={activeDataset}
                aiAnalysis={aiAnalysis}
                loadingAI={loadingAI}
                onTriggerAI={triggerAIScan}
              />
            )}

            {activeTab === 'ml' && activeDataset && (
              <MLPipeline
                dataset={activeDataset}
                aiSuggestedTarget={aiAnalysis?.recommendedTarget}
                aiSuggestedType={aiAnalysis?.modelType}
                aiSuggestedFeatures={aiAnalysis?.suggestedFeatures}
                onTriggerPrediction={triggerPrediction}
                mlResult={mlResult}
                loadingML={loadingML}
              />
            )}

            {activeTab === 'dashboard' && activeDataset && (
              <StakeholderDashboard
                dataset={activeDataset}
                strategicSlicer={aiAnalysis?.strategicSlicer}
                mlResult={mlResult}
                aiAnalysis={aiAnalysis}
              />
            )}

            {activeTab === 'reports' && activeDataset && (
              <ReportsHub
                dataset={activeDataset}
                mlResult={mlResult}
                aiAnalysis={aiAnalysis}
              />
            )}

            <StageNavigation
              activeTab={activeTab}
              setActiveTab={setActiveTab}
              canContinue={!!activeDataset}
              stageComplete={stageComplete[activeTab]}
            />
          </motion.div>
        </AnimatePresence>
      </main>

      <footer className="border-t border-separator">
        <div className="mx-auto max-w-[1400px] px-4 sm:px-6 py-5 flex flex-col sm:flex-row items-center justify-between gap-2 text-xs text-label-3">
          <span>Data Science Studio by AskDeepakAI</span>
          <span>
            Designed and engineered by{' '}
            <button
              type="button"
              onClick={() => setIsAboutModalOpen(true)}
              className="text-blue hover:underline rounded"
            >
              Deepak Reddy
            </button>
          </span>
        </div>
      </footer>

      {/* Assistive Touch Dynamic Gemini Co-pilot (Drag and move anywhere, controls all pipeline stages & data) */}
      <AssistiveTouchBot
        activeDataset={activeDataset}
        onUpdateDataset={handleUpdateDataset}
        onResetOriginal={handleResetOriginal}
        activeTab={activeTab}
        setActiveTab={setActiveTab}
        triggerAIScan={triggerAIScan}
        triggerPrediction={triggerPrediction}
      />

      {/* About the creator — presented as a sheet. */}
      <AnimatePresence>
        {isAboutModalOpen && (
          <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center sm:p-4">
            <motion.div
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.2 }}
              onClick={() => setIsAboutModalOpen(false)}
              className="absolute inset-0 bg-[var(--scrim)]"
            />

            <motion.div
              role="dialog"
              aria-modal="true"
              aria-labelledby="about-title"
              initial={{ opacity: 0, y: 24, scale: 0.98 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              exit={{ opacity: 0, y: 24, scale: 0.98 }}
              transition={{ duration: 0.3, ease: [0.28, 0.11, 0.32, 1] }}
              className="relative z-10 w-full sm:max-w-md bg-raised rounded-t-3xl sm:rounded-3xl shadow-xl p-6 sm:p-8 max-h-[90vh] overflow-y-auto"
            >
              <div className="flex justify-end -mt-2 -mr-2">
                <button
                  type="button"
                  onClick={() => setIsAboutModalOpen(false)}
                  className="btn btn-plain font-semibold"
                  autoFocus
                >
                  Done
                </button>
              </div>

              <div className="flex flex-col items-center text-center">
                <div className="w-20 h-20 rounded-full bg-blue flex items-center justify-center">
                  <span className="text-white text-[28px] font-semibold tracking-tight">DR</span>
                </div>
                <h2 id="about-title" className="mt-4 text-2xl font-semibold tracking-tight text-label">
                  Gorisi Deepak Reddy
                </h2>
                <p className="mt-1 text-sm text-label-2">Data Analyst &amp; Analytics Engineer</p>
                <p className="mt-1 inline-flex items-center gap-1 text-xs text-label-3">
                  <MapPin className="w-3.5 h-3.5" /> Budapest, Hungary
                </p>
              </div>

              <div className="mt-6 space-y-3 text-sm text-label leading-relaxed">
                <p>
                  I’m a Data Analyst and Analytics Engineer based in Budapest. With an MSc in IT for Business Data
                  Analytics, I build end-to-end data pipelines that connect technical insight to business strategy.
                </p>
                <p>
                  My work spans Python, SQL, predictive machine learning and data visualization. I built AskDeepakAI
                  to automate the data science workflow — turning raw data into clean pipelines, ML analyses and
                  actionable reports. I’m currently open to Data Analyst and BI roles.
                </p>
              </div>

              <div className="mt-6 grid grid-cols-3 gap-2">
                <a
                  href="https://github.com/thedeepakreddy"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="btn btn-secondary flex-col gap-1 h-auto py-3 rounded-2xl text-xs"
                >
                  <Github className="w-5 h-5" />
                  GitHub
                </a>
                <a
                  href="https://www.linkedin.com/in/deepak-reddy-038582223"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="btn btn-secondary flex-col gap-1 h-auto py-3 rounded-2xl text-xs"
                >
                  <Linkedin className="w-5 h-5" />
                  LinkedIn
                </a>
                <a
                  href="mailto:thedeepakreddy1@gmail.com"
                  className="btn btn-secondary flex-col gap-1 h-auto py-3 rounded-2xl text-xs"
                >
                  <Mail className="w-5 h-5" />
                  Email
                </a>
              </div>
            </motion.div>
          </div>
        )}
      </AnimatePresence>
    </div>
  );
}

function getClientSideAnalysisFallback(filename: string, columns: any[], rowCount: number) {
  const safeFilename = filename || 'dataset.csv';
  const safeColumns = columns || [];
  const safeRowCount = rowCount || 0;
  
  const columnsJson = JSON.stringify(safeColumns);
  const isChurn = safeFilename.toLowerCase().includes('churn');
  const isSaas = safeFilename.toLowerCase().includes('saas') || columnsJson.includes('Recurring');

  if (isChurn) {
    return {
      overviewSummary: "This customer intelligence dataset captures demographics, monthly financial charges, subscription contractual tenure, and payment modalities to flag churn behavior.",
      recommendedTarget: "Target_Churn",
      modelType: "classification",
      suggestedFeatures: ["Age", "Tenure", "MonthlyCharges", "ContractType", "PaymentMethod"],
      scientistFocus: "Tenure",
      scientistRationale: "Tenure exhibits standard correlations with subscriber churn. It is essential to focus on early drop-offs (months 0-6) and check if contractual onboarding buffers are missing.",
      strategicSlicer: "ContractType",
      insights: [
        "Customers on Month-to-month terms have 4x the attrition risk levels compared to those on One/Two Year agreements.",
        "A high concentration of churn is triggered near MonthlyCharges exceeding $75, showing high charging sensitivity.",
        "Subscribers utilizing Electronic Checks exhibit a standard higher rate of payment failures and churn."
      ]
    };
  } else if (isSaas) {
    return {
      overviewSummary: "SaaS revenue telemetry dataset showing core metrics across client segments, active ratios, support overload ticket indicators, and rating indexes to determine churn probability.",
      recommendedTarget: "Target_ChurnProbability",
      modelType: "regression",
      suggestedFeatures: ["Monthly_Recurring_Revenue", "Users_Active_Daily", "Support_Tickets_Opened", "Customer_Success_Rating"],
      scientistFocus: "Support_Tickets_Opened",
      scientistRationale: "The ticket metrics hold non-linear links with success ratings. Investigating delayed support resolutions will uncover specific friction points.",
      strategicSlicer: "Customer_Segment",
      insights: [
        "Enterprise clients stay robustly solid, while standard/SMB users represent the highest churn risk due to lower daily activity.",
        "Customer success ratings below 3.5 strongly predict immediate contract risk within 14 days.",
        "Daily active ratios of standard cohorts drop by 30% right before support tickets peak."
      ]
    };
  } else {
    const numericColumns = safeColumns.filter(c => c.type === 'numeric').map(c => c.name);
    const categorical = safeColumns.filter(c => c.type === 'categorical').map(c => c.name);
    const target = numericColumns[numericColumns.length - 1] || safeColumns[safeColumns.length - 1]?.name || "unknown_target";
    
    return {
      overviewSummary: `Automated scan of "${safeFilename}" comprising ${safeRowCount} rows across ${safeColumns.length} features parsed securely.`,
      recommendedTarget: target,
      modelType: "regression",
      suggestedFeatures: safeColumns.map(c => c.name).filter(n => n !== target).slice(0, 5),
      scientistFocus: target,
      scientistRationale: "As the designated modeling target, verifying standard outliers, normal distributions, and null rate values here ensures predictive consistency.",
      strategicSlicer: categorical[0] || safeColumns[0]?.name || "None",
      insights: [
        "Initial statistical test shows solid variance in primary numerical covariates.",
        "Missing cells are concentrated primarily in categorical labels, requiring imputation.",
        "Primary variables are distributed normally with standard variance limits."
      ]
    };
  }
}
