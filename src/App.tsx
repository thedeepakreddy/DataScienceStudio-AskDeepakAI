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
  History,
  Users,
  Linkedin,
  Mail,
  MapPin,
  KeyRound,
  Moon,
  Sparkles,
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
import EngineStatus from './components/EngineStatus';
import AppIcon from './components/AppIcon';
import Orb from './components/Orb';
import AboutCreator from './components/AboutCreator';
import AiKeySheet from './components/AiKeySheet';
import AiModelUpdate, { type AiModelInfo } from './components/AiModelUpdate';
import { aiKeyHeaders, getUserGeminiKey, AI_KEY_CHANGED_EVENT } from './utils/aiKey';
import { buildAdvisoryFallback } from './utils/advisoryFallback';
import LoadingScreen from './components/LoadingScreen';
import { usePipelineContext, PipelineStage } from './contexts/PipelineContext';
import { STAGES, STAGE_ORDER } from './stages';
import { apiFetch, API_SETTLED_EVENT } from './utils/api';
import StatisticsStage from './components/StatisticsStage';
import HistorySheet from './components/HistorySheet';
import JobsButton from './components/JobsButton';
import ExperimentsPanel from './components/ExperimentsPanel';
import ModelStage from './components/model/ModelStage';
import StageKeep from './components/StageKeep';
import PinnedResults from './components/pins/PinnedResults';
import { PinTargetContext } from './components/pins/PinButton';
import { StudioDataContext } from './components/engine/UseEngineDataset';
import DeployPanel from './components/DeployPanel';
import SwarmPanel from './components/SwarmPanel';
import MoreMenu from './components/MoreMenu';
import AgentCursorLayer from './components/AgentCursorLayer';
import SwarmTakeover from './components/SwarmTakeover';
import WelcomeSwarm from './components/WelcomeSwarm';
import { useSwarm } from './swarm/useSwarm';
import { RUN_LOGGED_EVENT } from './swarm/interaction';
import { runSandboxedDatasetJs } from './utils/sandbox';
import { datasetFromRecords } from './utils/csvParser';
import type { RuntimePort } from './swarm/runtime';
import { WorkspaceContext, RunInput } from './contexts/WorkspaceContext';
import { describeChange } from './utils/describeChange';
import type { AppliedOperation } from './operations/registry';
import {
  DatasetVersion, clearWorkspace, exportWorkspace, getVersion, importWorkspace, listVersions, loadSession, recordRun, saveModelFile, saveSession, saveVersion,
} from './utils/workspaceStore';

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
  // The agents' welcome, every time the studio opens (after the loading screen).
  const [showWelcome, setShowWelcome] = useState(true);
  const closeWelcome = useCallback(() => setShowWelcome(false), []);
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
    // Scroll only the step bar itself. scrollIntoView would also scroll the
    // page sideways on phones, which pushed whole steps off the left edge.
    const bar = stageBarRef.current;
    const cur = bar?.querySelector<HTMLElement>('[aria-current="step"]');
    if (bar && cur) {
      const b = bar.getBoundingClientRect(), c = cur.getBoundingClientRect();
      bar.scrollTo({ left: bar.scrollLeft + (c.left - b.left) - (b.width - c.width) / 2, behavior: 'smooth' });
    }
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

  // Why AI answers are (or aren't) coming from Gemini. The server records the
  // outcome of each real call; this just reads it - on load, and again after
  // any API call settles - so a silent fallback to template answers is visible.
  const [aiStatus, setAiStatus] = useState<{
    state: string; reason: string | null; message: string; detail: string | null;
    visitorKey?: boolean; visitorKeyOk?: boolean | null; visitorKeyMessage?: string | null; models?: AiModelInfo;
  } | null>(null);
  const [aiKeySheetOpen, setAiKeySheetOpen] = useState(false);
  const [hasOwnKey, setHasOwnKey] = useState<boolean>(() => !!getUserGeminiKey());
  useEffect(() => {
    const onChange = () => setHasOwnKey(!!getUserGeminiKey());
    window.addEventListener(AI_KEY_CHANGED_EVENT, onChange);
    return () => window.removeEventListener(AI_KEY_CHANGED_EVENT, onChange);
  }, []);
  const [aiChecking, setAiChecking] = useState(false);
  const [aiNoticeDismissedFor, setAiNoticeDismissedFor] = useState<string | null>(null);
  const refreshAiStatus = useCallback(async (probe = false) => {
    try {
      const res = await fetch(`/api/ai/status${probe ? '?probe=1' : ''}`, { cache: 'no-store', headers: aiKeyHeaders() });
      if (res.ok) setAiStatus(await res.json());
    } catch { /* status is best-effort */ }
  }, []);
  // "Check Again" makes one small live call to Gemini rather than reading the last result.
  const recheckAi = async () => {
    setAiChecking(true);
    await refreshAiStatus(true);
    setAiChecking(false);
  };
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const onSettled = () => { clearTimeout(timer); timer = setTimeout(() => refreshAiStatus(), 300); };
    onSettled(); // initial read
    window.addEventListener(API_SETTLED_EVENT, onSettled);
    return () => { clearTimeout(timer); window.removeEventListener(API_SETTLED_EVENT, onSettled); };
  }, [refreshAiStatus]);
  // The studio's own key is unavailable. With a working key of their own the
  // visitor's AI features still work, so only say so when their key fails too.
  const ownKeyFailed = hasOwnKey && aiStatus?.visitorKeyOk === false;
  const showAiNotice =
    aiStatus?.state === 'unavailable' &&
    (!hasOwnKey || ownKeyFailed) &&
    aiNoticeDismissedFor !== `${aiStatus.reason}:${ownKeyFailed}`;

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

  // ---- Saved work (IndexedDB) -------------------------------------------
  // Every dataset change becomes a version linked to its parent; runs are
  // recorded against the version they used; the session is restored on reload.
  const [datasetId, setDatasetId] = useState<string | null>(null);
  const [activeVersionId, setActiveVersionId] = useState<string | null>(null);
  const [originalVersionId, setOriginalVersionId] = useState<string | null>(null);
  const [activeParentId, setActiveParentId] = useState<string | null>(null);
  const [storageError, setStorageError] = useState<string | null>(null);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [restoredFrom, setRestoredFrom] = useState<string | null>(null);
  const [restoreDone, setRestoreDone] = useState(false);
  const [statsRunCount, setStatsRunCount] = useState(0);
  const activeDatasetRef = useRef<Dataset | null>(null);
  const activeVersionRef = useRef<string | null>(null);
  const originalVersionRef = useRef<string | null>(null);
  const saveQueue = useRef<Promise<void>>(Promise.resolve());

  const storageFailed = (err: any) => {
    console.warn('Saving work failed', err);
    setStorageError(`Your work couldn’t be saved in this browser: ${err?.message || err}. It still works, but won’t survive a reload.`);
  };

  const applyVersionIds = (version: { id: string; datasetId: string; parentId?: string | null } | null, original?: string | null) => {
    activeVersionRef.current = version?.id ?? null;
    setActiveVersionId(version?.id ?? null);
    setActiveParentId(version?.parentId ?? null);
    setDatasetId(version?.datasetId ?? null);
    if (original !== undefined) {
      originalVersionRef.current = original;
      setOriginalVersionId(original);
    }
  };

  // Saves run one after another so each new version links to the one before.
  const persistVersion = (dataset: Dataset, label: string, isImport: boolean, operation?: AppliedOperation) => {
    saveQueue.current = saveQueue.current
      .then(async () => {
        const v = await saveVersion(dataset, {
          parentId: isImport ? null : activeVersionRef.current,
          label,
          operation,
          keep: originalVersionRef.current ? [originalVersionRef.current] : [],
        });
        applyVersionIds(v, isImport ? v.id : undefined);
        setStorageError(null);
      })
      .catch(storageFailed);
  };

  // Copies the trained model file into the browser, so it can still be
  // downloaded after the ML service restarts. Runs in the background.
  const keepModelFile = (result: MLResult, target: string) => {
    const versionId = activeVersionRef.current;
    fetch(`/api/ml/download/${encodeURIComponent(result.modelId!)}`)
      .then(async res => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        await saveModelFile({
          modelId: result.modelId!,
          filename: `${target}_${(result.modelAlgorithm || 'model').replace(/\s+/g, '')}.joblib`,
          bytes: await res.arrayBuffer(),
          versionId,
          target,
          algorithm: result.modelAlgorithm,
        });
      })
      .catch(err => console.warn('Could not keep a copy of the model file', err));
  };

  const logRun = useCallback((run: RunInput) => {
    if (run.kind === 'hypothesis-test' || run.kind === 'ab-test') setStatsRunCount(n => n + 1);
    recordRun({ ...run, versionId: activeVersionRef.current }).catch(storageFailed);
    // Agents operating the page read the results of the buttons they press here.
    window.dispatchEvent(new CustomEvent(RUN_LOGGED_EVENT, { detail: { ...run, versionId: activeVersionRef.current } }));
  }, []);

  const handleDatasetLoaded = (dataset: Dataset) => {
    activeDatasetRef.current = dataset;
    setOriginalDataset(dataset);
    setActiveDataset(dataset);
    setAiAnalysis(null);
    setMlResult(null);
    setErrorLine(null);
    setRestoredFrom(null);
    persistVersion(dataset, 'Imported', true);
  };

  const handleUpdateDataset = (updated: Dataset, operation?: AppliedOperation, summary?: string) => {
    const changed = describeChange(activeDatasetRef.current, updated);
    // The operation's own description is clearer than a diff when there is one.
    const label = changed === 'No changes' ? changed : summary?.replace(/\.$/, '') || changed;
    activeDatasetRef.current = updated;
    setActiveDataset(updated);
    // Reset AI analysis since data changed
    setAiAnalysis(null);
    setMlResult(null);
    if (label !== 'No changes') persistVersion(updated, label, false, operation);
  };

  const handleResetOriginal = (): Dataset | null => {
    if (!originalDataset) return null;
    {
      activeDatasetRef.current = originalDataset;
      setActiveDataset(originalDataset);
      setAiAnalysis(null);
      setMlResult(null);
      saveQueue.current = saveQueue.current.then(() => {
        activeVersionRef.current = originalVersionRef.current;
        setActiveVersionId(originalVersionRef.current);
        setActiveParentId(null);
      });
    }
    return originalDataset;
  };

  const handleUseVersion = (version: DatasetVersion) => {
    activeDatasetRef.current = version.dataset;
    setActiveDataset(version.dataset);
    setAiAnalysis(null);
    setMlResult(null);
    applyVersionIds(version);
    setHistoryOpen(false);
  };

  // Undo = go back to the version this one was made from.
  const handleUndo = async () => {
    try {
      await saveQueue.current;
      const current = activeVersionRef.current ? await getVersion(activeVersionRef.current) : undefined;
      const parent = current?.parentId ? await getVersion(current.parentId) : undefined;
      if (!parent) {
        setStorageError('The previous version is no longer saved, so this change can’t be undone.');
        return;
      }
      handleUseVersion(parent);
    } catch (err) {
      storageFailed(err);
    }
  };

  const handleClearSavedWork = async () => {
    try {
      await saveQueue.current;
      await clearWorkspace();
      applyVersionIds(null, null);
      activeDatasetRef.current = null;
      setOriginalDataset(null);
      setActiveDataset(null);
      setAiAnalysis(null);
      setMlResult(null);
      setRestoredFrom(null);
      setActiveTab('ingest');
    } catch (err) {
      storageFailed(err);
    }
  };

  // Loads the saved session (on start-up, and after importing a workspace).
  const restoreSaved = async (isCancelled: () => boolean = () => false): Promise<boolean> => {
    const session = await loadSession();
    if (!session?.activeVersionId) return false;
    const active = await getVersion(session.activeVersionId);
    if (!active || isCancelled()) return false;
    const original = session.originalVersionId ? await getVersion(session.originalVersionId) : undefined;
    if (isCancelled()) return false;
    activeDatasetRef.current = active.dataset;
    setActiveDataset(active.dataset);
    setOriginalDataset(original?.dataset ?? active.dataset);
    applyVersionIds(active, original?.id ?? active.id);
    setMlResult((session.mlResult as MLResult) ?? null);
    setAiAnalysis(session.aiAnalysis ?? null);
    if (session.aiAnalysis) setHasRunEda(true);
    const tab = STAGE_ORDER.includes(session.activeTab as PipelineStage) ? (session.activeTab as PipelineStage) : 'ingest';
    setVisited(new Set(STAGE_ORDER.slice(0, STAGE_ORDER.indexOf(tab) + 1)));
    setActiveTabState(tab);
    setRestoredFrom(active.filename);
    return true;
  };

  // Restore the last session once, on load.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        await restoreSaved(() => cancelled);
      } catch (err) {
        if (!cancelled) storageFailed(err);
      } finally {
        if (!cancelled) setRestoreDone(true);
      }
    })();
    return () => { cancelled = true; };
    // Runs once on mount by design.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleExportWorkspace = async () => {
    await saveQueue.current;
    const text = await exportWorkspace();
    const url = URL.createObjectURL(new Blob([text], { type: 'application/json' }));
    const link = document.createElement('a');
    link.href = url;
    link.download = `data-science-studio-workspace-${new Date().toISOString().slice(0, 10)}.json`;
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
  };

  const handleImportWorkspace = async (file: File) => {
    await saveQueue.current;
    const counts = await importWorkspace(await file.text());
    const restored = await restoreSaved();
    if (!restored) {
      applyVersionIds(null, null);
      activeDatasetRef.current = null;
      setOriginalDataset(null);
      setActiveDataset(null);
      setMlResult(null);
      setAiAnalysis(null);
      setActiveTab('ingest');
    }
    return counts;
  };

  // Keep the session saved as you work (after the restore attempt).
  useEffect(() => {
    if (!restoreDone) return;
    const timer = setTimeout(() => {
      saveSession({ activeVersionId, originalVersionId, activeTab, mlResult, aiAnalysis }).catch(storageFailed);
    }, 400);
    return () => clearTimeout(timer);
  }, [restoreDone, activeVersionId, originalVersionId, activeTab, mlResult, aiAnalysis]);

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
        parsed = buildAdvisoryFallback(activeDataset.filename, payloadCols, activeDataset.rowCount);
      }

      setAiAnalysis(parsed);
      setHasRunEda(true);
      logRun({
        kind: 'ai-advisory',
        title: parsed?.source === 'rules' ? 'Dataset advisory (automatic, AI unavailable)' : 'Dataset advisory (AI)',
        summary: `Suggested target: ${parsed?.recommendedTarget ?? 'none'} (${parsed?.modelType ?? 'unknown'})`,
        status: 'succeeded',
        result: parsed,
      });
    } catch (err: any) {
      console.error(err);
      logRun({ kind: 'ai-advisory', title: 'Dataset advisory', summary: 'Failed', status: 'failed', error: err.message || String(err) });
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
      mlResultRef.current = parsed; // agents read it straight after the run is logged
      // The studio's own write-up comes with the model; an AI one replaces it later if AI is available.
      if (parsed.narrativeKey) {
        apiFetch('/api/model-narrative', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ narrativeKey: parsed.narrativeKey }) })
          .then(r => (r.ok ? r.json() : null))
          .then(ai => {
            if (!ai || mlResultRef.current?.modelId !== parsed.modelId) return;
            const next = { ...mlResultRef.current, ...ai };
            mlResultRef.current = next;
            setMlResult(next);
          })
          .catch(() => {});
      }
      if (parsed.modelId) keepModelFile(parsed, targetCol);
      const m = parsed.metrics || {};
      const isClf = parsed.modelType === 'classification';
      const score = isClf ? m.accuracy : m.r2Score;
      logRun({
        kind: 'model-training',
        title: `${parsed.modelAlgorithm || 'Model'} predicting ${targetCol}`,
        summary: typeof score === 'number'
          ? (isClf ? `Accuracy ${(score * 100).toFixed(1)}%` : `R² ${score.toFixed(3)}`)
          : 'Trained',
        status: 'succeeded',
        params: { target: targetCol, features, modelType: modelClass, hyperparameters },
        result: {
          modelId: parsed.modelId, algorithm: parsed.modelAlgorithm, metrics: parsed.metrics, cv: parsed.cv,
          split: parsed.split, tuning: parsed.tuning, leakageWarnings: parsed.leakageWarnings,
          featureImportance: (parsed.featureImportance || []).slice(0, 10),
        },
      });
      return parsed;
    } catch (err: any) {
      console.error(err);
      logRun({
        kind: 'model-training',
        title: `Model predicting ${targetCol}`,
        summary: 'Failed',
        status: 'failed',
        params: { target: targetCol, features, modelType: modelClass, hyperparameters },
        error: err.message || String(err),
      });
      setErrorLine('Model training failed: ' + (err.message || 'The engine may be offline.'));
      throw err;
    } finally {
      setLoadingML(false);
    }
  };

  const workspaceValue = React.useMemo(() => ({ logRun }), [logRun]);
  // Steps opened since this dataset was loaded stay mounted (see StageKeep).
  const [visitedTabs, setVisitedTabs] = useState<Set<string>>(() => new Set());
  useEffect(() => { setVisitedTabs(v => (v.has(activeTab) ? v : new Set([...v, activeTab]))); }, [activeTab]);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { setVisitedTabs(new Set([activeTab])); }, [datasetId]);
  // Charts and maps that were hidden measure themselves again when their step is shown.
  useEffect(() => { const t = requestAnimationFrame(() => window.dispatchEvent(new Event('resize'))); return () => cancelAnimationFrame(t); }, [activeTab]);
  // Engine-made data (imports, masked copies, recipes) reaching the studio.
  const studioData = {
    open: (ds: Dataset) => handleDatasetLoaded(ds),
    replace: (ds: Dataset, summary: string) => handleUpdateDataset(ds, undefined, summary),
  };
  const pinTarget = React.useMemo(() => ({ datasetId, versionId: activeVersionId }), [datasetId, activeVersionId]);

  // ---- Agent swarm --------------------------------------------------------
  // The studio lends the agents the same functions its own buttons use.
  const [swarmOpen, setSwarmOpen] = useState(false);
  const mlResultRef = useRef<MLResult | null>(null);
  useEffect(() => { mlResultRef.current = mlResult; }, [mlResult]);
  const aiAnalysisRef = useRef<any>(null);
  useEffect(() => { aiAnalysisRef.current = aiAnalysis; }, [aiAnalysis]);
  const swarmPort: RuntimePort = {
    getDataset: () => activeDatasetRef.current,
    commitDataset: (ds, op, summary) => handleUpdateDataset(ds, op, summary),
    openStep: step => setActiveTab(step),
    train: (target, features, modelType, hyperparameters) => triggerPrediction(target, features, modelType, hyperparameters),
    getModel: () => mlResultRef.current,
    api: async (url, body, signal) => {
      const res = await apiFetch(url, { method: 'POST', body: JSON.stringify(body), signal });
      const json = await res.json().catch(() => null);
      if (!res.ok || !json) throw new Error(`${json?.error || 'Request failed'}${res.status >= 500 ? ` (HTTP ${res.status})` : ''}`);
      return json;
    },
    resetOriginal: () => handleResetOriginal(),
    runCode: async (code, ds) => {
      const out = await runSandboxedDatasetJs(code, ds);
      if (!out || !Array.isArray(out.rows)) throw new Error('The code didn’t return data with rows.');
      const cols = Object.keys(out.rows[0] ?? {});
      return datasetFromRecords(cols, out.rows.map((r: Record<string, unknown>) => ({ ...r })), ds.filename);
    },
    runAdvisory: async () => { await triggerAIScan(); return aiAnalysisRef.current; },
    logRun,
    getPinTarget: () => ({ datasetId, versionId: activeVersionRef.current }),
    settle: async () => { await saveQueue.current; return activeVersionRef.current; },
    findAppliedVersion: async (parentId, capability, params) => {
      if (!capability.startsWith('data.') || !datasetId) return null;
      const op = capability.slice(5);
      const versions = await listVersions(datasetId);
      return versions.find(v => v.parentId === parentId && v.operation?.op === op && JSON.stringify(v.operation.params) === JSON.stringify(params))?.id ?? null;
    },
  };
  const swarm = useSwarm(swarmPort, { datasetId, activeVersionId }, activeDataset);
  const undoSwarmRun = async (versionId: string) => {
    await saveQueue.current;
    const v = await getVersion(versionId);
    if (v) handleUseVersion(v);
  };

  // A stage counts as complete once its key action has been done. Completion
  // drives the checkmarks and the emphasis of "Continue" — it never locks a step.
  const stageComplete: Record<PipelineStage, boolean> = {
    ingest: !!activeDataset,
    clean: hasRunAudit,
    eda: hasRunEda,
    stats: statsRunCount > 0,
    ml: !!mlResult,
    dashboard: !!activeDataset && visited.has('dashboard'),
    reports: !!activeDataset && visited.has('reports'),
  };

  return (
    <WorkspaceContext.Provider value={workspaceValue}>
    <PinTargetContext.Provider value={pinTarget}>
    <StudioDataContext.Provider value={studioData}>
    <div className="min-h-screen flex flex-col bg-canvas text-label" id="workstation_app">
      <AnimatePresence>
        {showLoading && <LoadingScreen onComplete={handleLoadingComplete} />}
      </AnimatePresence>

      {/* Toolbar: identity on the left, global controls on the right. */}
      <header className="bg-canvas">
        <div className="mx-auto max-w-[1400px] h-14 px-3 min-[380px]:px-4 sm:px-6 flex items-center justify-between gap-2 sm:gap-3">
          <button
            type="button"
            onClick={() => setActiveTab('ingest')}
            className="flex items-center gap-2.5 min-w-0 rounded-lg -ml-1 px-1 py-1"
            id="brand_logo"
            aria-label="Data Science Studio — go to Import"
          >
            <span className="shrink-0"><AppIcon size={36} /></span>
            <span className="hidden sm:inline text-[17px] font-semibold tracking-tight text-label truncate">
              Data Science Studio
            </span>
          </button>

          <div className="flex items-center gap-1 min-[380px]:gap-1.5 sm:gap-2 shrink-0">
            {activeDataset && (
              <span className="tag hidden lg:inline-flex max-w-[220px] mr-1" title={activeDataset.filename}>
                <FileSpreadsheet className="w-3.5 h-3.5 shrink-0" />
                <span className="truncate">{activeDataset.filename}</span>
              </span>
            )}

            <div className="segmented segmented-compact hidden min-[380px]:inline-flex" role="group" aria-label="Experience level">
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

            <EngineStatus />

            <JobsButton />

            <button
              type="button"
              onClick={() => setSwarmOpen(true)}
              data-swarm-ui
              className="btn btn-icon relative"
              aria-label="Agents"
              title="Agents"
            >
              {swarm.run && ['running', 'cancelling'].includes(swarm.run.status)
                ? <Orb state="working" label="Agents working" />
                : <Users className="w-[18px] h-[18px]" />}
              {swarm.run?.status === 'awaiting_approval' && <span className="absolute top-1.5 right-1.5 w-2 h-2 rounded-full bg-orange ring-2 ring-canvas" aria-hidden="true" />}
            </button>

            <button
              type="button"
              onClick={() => setHistoryOpen(true)}
              className="btn btn-icon hidden sm:inline-flex"
              aria-label="History of versions and runs"
              title="History"
            >
              <History className="w-[18px] h-[18px]" />
            </button>

            <button
              type="button"
              onClick={() => setAiKeySheetOpen(true)}
              className="btn btn-icon relative hidden sm:inline-flex"
              aria-label={hasOwnKey ? 'Your Gemini API key (added)' : 'Use your own Gemini API key'}
              title={hasOwnKey ? 'Your Gemini API key is added' : 'Use your own Gemini API key'}
            >
              <KeyRound className="w-[18px] h-[18px]" />
              {hasOwnKey && <span className="absolute top-1.5 right-1.5 w-2 h-2 rounded-full bg-green ring-2 ring-canvas" aria-hidden="true" />}
            </button>

            <button
              type="button"
              onClick={toggleTheme}
              className="btn btn-icon hidden sm:inline-flex"
              aria-label={theme === 'dark' ? 'Switch to light appearance' : 'Switch to dark appearance'}
              title={theme === 'dark' ? 'Light appearance' : 'Dark appearance'}
            >
              {theme === 'dark' ? <Sun className="w-[18px] h-[18px]" /> : <Moon className="w-[18px] h-[18px]" />}
            </button>

            <button
              type="button"
              onClick={() => setIsAboutModalOpen(true)}
              className="btn btn-icon hidden sm:inline-flex"
              aria-label="About the creator"
              title="About the creator"
            >
              <CircleUser className="w-[18px] h-[18px]" />
            </button>

            {/* Phones: the less-used controls live in one menu so the toolbar fits. */}
            <MoreMenu
              items={[
                { label: expertMode ? 'Switch to Beginner' : 'Switch to Expert', icon: <Users className="w-4 h-4" />, onSelect: () => setExpertMode(!expertMode), className: 'min-[380px]:hidden' },
                { label: 'History', icon: <History className="w-4 h-4" />, onSelect: () => setHistoryOpen(true) },
                { label: hasOwnKey ? 'Your Gemini key (added)' : 'Use your own Gemini key', icon: <KeyRound className="w-4 h-4" />, onSelect: () => setAiKeySheetOpen(true) },
                { label: theme === 'dark' ? 'Light appearance' : 'Dark appearance', icon: theme === 'dark' ? <Sun className="w-4 h-4" /> : <Moon className="w-4 h-4" />, onSelect: toggleTheme },
                { label: 'About the creator', icon: <CircleUser className="w-4 h-4" />, onSelect: () => setIsAboutModalOpen(true) },
              ]}
            />
          </div>
        </div>
      </header>

      {/* Stage bar: the seven-step workflow. Stays in view while the page scrolls. */}
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
                  data-agent={`nav-${id}`}
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

        {storageError && (
          <div role="status" className="mb-6 flex items-start gap-3 rounded-2xl bg-orange/10 px-4 py-3 text-sm">
            <AlertTriangle className="w-[18px] h-[18px] text-orange shrink-0 mt-0.5" />
            <p className="flex-1 min-w-0 text-label">{storageError}</p>
            <button
              type="button"
              onClick={() => setStorageError(null)}
              className="shrink-0 -m-1 p-1 rounded-full text-label-2 hover:bg-fill"
              aria-label="Hide saving notice"
            >
              <X className="w-4 h-4" />
            </button>
          </div>
        )}

        {restoredFrom && (
          <div role="status" className="mb-6 flex flex-wrap items-center gap-3 rounded-2xl bg-blue/10 px-4 py-3 text-sm">
            <History className="w-[18px] h-[18px] text-blue shrink-0" />
            <p className="flex-1 min-w-[200px] text-label">
              <span className="font-semibold">Picked up where you left off</span> with {restoredFrom}.
            </p>
            <button type="button" onClick={() => setHistoryOpen(true)} className="btn btn-sm btn-secondary shrink-0">
              View History
            </button>
            <button
              type="button"
              onClick={() => setRestoredFrom(null)}
              className="shrink-0 -m-1 p-1 rounded-full text-label-2 hover:bg-fill"
              aria-label="Hide notice"
            >
              <X className="w-4 h-4" />
            </button>
          </div>
        )}

        {showAiNotice && aiStatus && (
          <div role="status" className="mb-6 flex flex-wrap items-start gap-3 rounded-2xl bg-orange/10 px-4 py-3 text-sm">
            <Sparkles className="w-[18px] h-[18px] text-orange shrink-0 mt-0.5" />
            <div className="flex-1 min-w-[200px]">
              <p className="text-label">
                <span className="font-semibold">AI answers are unavailable right now.</span>{' '}
                {ownKeyFailed
                  ? 'Your own Gemini key didn’t work either, so AI features are using built-in answers.'
                  : 'AI features are using built-in answers. You can add your own free Gemini key to keep them working.'}
              </p>
              <details className="mt-1 text-xs text-label-2">
                <summary className="cursor-pointer w-max">Why?</summary>
                <p className="mt-1 leading-relaxed">{aiStatus.message}</p>
                {aiStatus.detail && <p className="mt-1 text-label-3 break-words">Google said: “{aiStatus.detail}”</p>}
                {ownKeyFailed && aiStatus.visitorKeyMessage && (
                  <p className="mt-1 leading-relaxed">Your key: {aiStatus.visitorKeyMessage}</p>
                )}
              </details>
            </div>
            <button
              type="button"
              onClick={() => setAiKeySheetOpen(true)}
              className="btn btn-sm btn-primary shrink-0"
            >
              {ownKeyFailed ? 'Check Your Key' : 'Use Your Own Key'}
            </button>
            <AiModelUpdate compact models={aiStatus.models} onUpdated={() => refreshAiStatus()} />
            <button
              type="button"
              onClick={recheckAi}
              disabled={aiChecking}
              className="btn btn-sm btn-secondary shrink-0"
            >
              {aiChecking ? <><Orb state="listening" label="Checking Gemini" /> Checking…</> : 'Check Again'}
            </button>
            <button
              type="button"
              onClick={() => setAiNoticeDismissedFor(`${aiStatus.reason}:${ownKeyFailed}`)}
              className="shrink-0 -m-1 p-1 rounded-full text-label-2 hover:bg-fill"
              aria-label="Hide AI notice"
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
          </motion.div>
        </AnimatePresence>

        {/* Each step stays mounted once opened (hidden while you're elsewhere), so its
            results are still there when you come back. A new dataset starts them afresh. */}
        <StageKeep tab="ingest" active={activeTab} visited={visitedTabs}>
          <DataUploader
            onDatasetLoaded={handleDatasetLoaded}
            currentDataset={activeDataset}
            onProceed={() => setActiveTab('clean')}
          />
        </StageKeep>
        <div key={datasetId ?? 'none'}>

            {activeDataset && (
            <StageKeep tab="clean" active={activeTab} visited={visitedTabs}>
              <DataCleaning
                dataset={activeDataset}
                onUpdateDataset={handleUpdateDataset}
                onResetOriginal={handleResetOriginal}
                datasetId={datasetId}
                activeVersionId={activeVersionId}
                onUndo={handleUndo}
                canUndo={!!activeParentId}
              />
            </StageKeep>
            )}

            {activeDataset && (
            <StageKeep tab="eda" active={activeTab} visited={visitedTabs}>
              <EDAReport
                dataset={activeDataset}
                aiAnalysis={aiAnalysis}
                loadingAI={loadingAI}
                onTriggerAI={triggerAIScan}
                onUseQueryResult={(ds, summary) => handleUpdateDataset(ds, undefined, summary)}
              />
            </StageKeep>
            )}

            {activeDataset && (
            <StageKeep tab="stats" active={activeTab} visited={visitedTabs}>
              <StatisticsStage dataset={activeDataset} />
            </StageKeep>
            )}

            {activeDataset && (
            <StageKeep tab="ml" active={activeTab} visited={visitedTabs}>
              <ModelStage
                dataset={activeDataset}
                onUseDataset={(ds, summary) => handleUpdateDataset(ds, undefined, summary)}
                train={
                  <div className="space-y-10">
                    <MLPipeline
                      dataset={activeDataset}
                      aiSuggestedTarget={aiAnalysis?.recommendedTarget}
                      aiSuggestedType={aiAnalysis?.modelType}
                      aiSuggestedFeatures={aiAnalysis?.suggestedFeatures}
                      onTriggerPrediction={triggerPrediction}
                      mlResult={mlResult}
                      loadingML={loadingML}
                    />
                    <div className="space-y-8">
                      <ExperimentsPanel
                        datasetId={datasetId}
                        activeVersionId={activeVersionId}
                        refreshKey={mlResult}
                        onRerun={p => { triggerPrediction(p.target, p.features, p.modelType, p.hyperparameters).catch(() => {}); }}
                        onOpenVersion={handleUseVersion}
                      />
                      <DeployPanel dataset={activeDataset} datasetId={datasetId} activeVersionId={activeVersionId} mlResult={mlResult} />
                    </div>
                  </div>
                }
              />
            </StageKeep>
            )}

            {activeTab === 'dashboard' && activeDataset && loadingML && (
              <div role="status" className="card mb-6 p-4 sm:p-4 flex items-center gap-4 animate-fade-in">
                <Orb state="solving" size={64} label="Training a model" />
                <div className="min-w-0">
                  <p className="card-title">Training a model…</p>
                  <p className="mt-0.5 text-sm text-label-2">
                    Model results on this dashboard will update as soon as training finishes.
                  </p>
                </div>
              </div>
            )}

            {activeDataset && (
            <StageKeep tab="dashboard" active={activeTab} visited={visitedTabs}>
              <PinnedResults dataset={activeDataset} datasetId={datasetId} versionId={activeVersionId} />
              <StakeholderDashboard
                dataset={activeDataset}
                strategicSlicer={aiAnalysis?.strategicSlicer}
                mlResult={mlResult}
                aiAnalysis={aiAnalysis}
                datasetId={datasetId}
              />
            </StageKeep>
            )}

            {activeDataset && (
            <StageKeep tab="reports" active={activeTab} visited={visitedTabs}>
              <ReportsHub
                dataset={activeDataset}
                mlResult={mlResult}
                aiAnalysis={aiAnalysis}
                datasetId={datasetId}
                activeVersionId={activeVersionId}
              />
            </StageKeep>
            )}
        </div>

            <StageNavigation
              activeTab={activeTab}
              setActiveTab={setActiveTab}
              canContinue={!!activeDataset}
              stageComplete={stageComplete[activeTab]}
            />
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
      {/* The agents at work on this page, and the user's way to take over. */}
      <AgentCursorLayer />
      {!showLoading && showWelcome && <WelcomeSwarm onClose={closeWelcome} />}
      <SwarmTakeover status={swarm.run?.status ?? null} onPause={swarm.pause} onResume={swarm.resume} onCancel={swarm.cancel} />

      <AssistiveTouchBot
        swarm={swarm}
        onUndoAll={undoSwarmRun}
        onOpenDetails={() => setSwarmOpen(true)}
      />

      <AnimatePresence>
        {swarmOpen && (
          <SwarmPanel
            onClose={() => setSwarmOpen(false)}
            run={swarm.run}
            history={swarm.history}
            onApproveAndRun={swarm.approveAndRun}
            onApproveTask={swarm.approveTask}
            onPause={swarm.pause}
            onResume={swarm.resume}
            onCancel={swarm.cancel}
            onCancelTask={swarm.cancelTask}
            onDiscard={swarm.discard}
            onUndoAll={undoSwarmRun}
            approvalMode={swarm.approvalMode}
            onApprovalMode={swarm.setApprovalMode}
          />
        )}
      </AnimatePresence>

      <AnimatePresence>
        {historyOpen && (
          <HistorySheet
            onClose={() => setHistoryOpen(false)}
            datasetId={datasetId}
            activeVersionId={activeVersionId}
            onUseVersion={handleUseVersion}
            onClear={handleClearSavedWork}
            onExport={handleExportWorkspace}
            onImport={handleImportWorkspace}
            storageError={storageError}
          />
        )}
      </AnimatePresence>

      <AnimatePresence>
        {aiKeySheetOpen && (
          <AiKeySheet onClose={() => setAiKeySheetOpen(false)} onChanged={() => refreshAiStatus()} models={aiStatus?.models} />
        )}
      </AnimatePresence>

      {/* About the creator — presented as a sheet. */}
      <AnimatePresence>
        {isAboutModalOpen && <AboutCreator onClose={() => setIsAboutModalOpen(false)} />}
      </AnimatePresence>
    </div>
    </StudioDataContext.Provider>
    </PinTargetContext.Provider>
    </WorkspaceContext.Provider>
  );
}
