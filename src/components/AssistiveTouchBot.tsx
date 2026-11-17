/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState, useRef, useEffect } from 'react';
import { motion, AnimatePresence, useMotionValue, animate } from 'motion/react';
import { Send, X, Check, Code, AlertTriangle } from 'lucide-react';
import type { OrbState } from 'thinking-orbs';
import { Dataset } from '../types';
import { apiFetch } from '../utils/api';
import Orb from './Orb';
import { STAGES } from '../stages';
import type { PipelineStage } from '../contexts/PipelineContext';

interface AssistiveTouchBotProps {
  activeDataset: Dataset | null;
  onUpdateDataset: (updated: Dataset) => void;
  onResetOriginal: () => void;
  activeTab: string;
  setActiveTab: (tab: any) => void;
  triggerAIScan: () => Promise<void>;
  triggerPrediction: (
    targetCol: string,
    features: string[],
    modelClass: 'classification' | 'regression' | 'timeseries',
    hyperparameters: Record<string, any>
  ) => Promise<any>;
}

interface ChatMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  timestamp: string;
  executedCommands?: string[];
}

// What the assistant is doing right now, shown live in the chat so the user can
// follow along: thinking (waiting for the AI to decide), acting (carrying out each
// action it chose, one line per action) and writing (the reply appearing).
type ActivityStep = { label: string; orb: OrbState; status: 'running' | 'done' | 'failed' };
type Activity = { phase: 'thinking' | 'acting' | 'writing'; steps: ActivityStep[] };

const FAILED_ACTION = /not found|couldn’t|could not|error|invalid|already exists|incomplete|failed/i;

/** A present-tense label and matching orb for an action the assistant is about to run. */
function describeAction(cmd: any): { label: string; orb: OrbState } {
  switch (cmd?.type) {
    case 'SELECT_TAB': return { label: `Opening the ${STAGES[cmd.tab as PipelineStage]?.label ?? cmd.tab ?? 'requested'} step`, orb: 'connecting' };
    case 'RESET_DATASET': return { label: 'Restoring the original dataset', orb: 'working' };
    case 'DROP_COLUMN': return { label: `Removing column “${cmd.column}”`, orb: 'working' };
    case 'FILL_MISSING': return { label: `Filling missing values in “${cmd.column}”`, orb: 'weaving' };
    case 'RUN_EDA_SCAN': return { label: 'Analyzing the dataset', orb: 'searching' };
    case 'RUN_ML': return { label: `Training a model to predict “${cmd.targetColumn}”`, orb: 'solving' };
    case 'FILTER_ROWS': return { label: `Filtering rows by “${cmd.column}”`, orb: 'searching' };
    case 'ADD_COLUMN': return { label: `Adding column “${cmd.columnName || cmd.column || 'new'}”`, orb: 'shaping' };
    case 'ADD_ROW': return { label: 'Adding a row', orb: 'shaping' };
    case 'DELETE_ROW': return { label: `Deleting row ${cmd.rowIndex ?? cmd.index ?? ''}`.trim(), orb: 'working' };
    case 'EXECUTE_DATASET_JS': return { label: 'Running your query on the data', orb: 'solving' };
    default: return { label: 'Working on your request', orb: 'working' };
  }
}

/** Width of the visible page, excluding a vertical scrollbar. */
const viewportWidth = () =>
  (typeof document !== 'undefined' && document.documentElement.clientWidth) || window.innerWidth;

const prefersReducedMotion = () =>
  typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;

export default function AssistiveTouchBot({
  activeDataset,
  onUpdateDataset,
  onResetOriginal,
  activeTab,
  setActiveTab,
  triggerAIScan,
  triggerPrediction
}: AssistiveTouchBotProps) {
  const [isChatOpen, setIsChatOpen] = useState(false);
  const isChatOpenRef = useRef(false);
  useEffect(() => { isChatOpenRef.current = isChatOpen; }, [isChatOpen]);
  const [messages, setMessages] = useState<ChatMessage[]>([
    {
      id: 'welcome-msg',
      role: 'assistant',
      content: `Hi, I'm your data assistant. I can read your dataset, make changes to it, and move between steps for you.

Ask in plain English, or switch to **SQL** or **Code** below. For example:
- Analyze this dataset
- Drop the PaymentMethod column
- SELECT * FROM dataset WHERE Age > 30`,
      timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    }
  ]);
  const [inputText, setInputText] = useState('');
  const [inputMode, setInputMode] = useState<'english' | 'sql' | 'python'>('english');
  const [isGenerating, setIsGenerating] = useState(false);
  const [activity, setActivity] = useState<Activity | null>(null);
  // The reply currently being written out on screen, and how much of it shows.
  const [reveal, setReveal] = useState<{ id: string; shown: number } | null>(null);
  const [lastExecutedTaskMsg, setLastExecutedTaskMsg] = useState<string | null>(null);

  const messagesEndRef = useRef<HTMLDivElement | null>(null);
  const dragContainerRef = useRef<HTMLDivElement | null>(null);
  const isDragging = useRef(false);

  // Responsive state for absolute coordinate snapping representation
  // Starts safely at a guaranteed visible status, then snaps instantly relative to true client viewport on mount
  const mx = useMotionValue(100);
  const my = useMotionValue(100);

  // 1. Force position to the absolute right side of the actual browser screen on mount
  useEffect(() => {
    const w = viewportWidth();
    const h = window.innerHeight;
    if (w > 50 && h > 50) {
      const buttonSize = 64;
      mx.set(w - buttonSize); // force right edge on initial mount
      my.set(Math.max(0, Math.min(h - buttonSize, h - 185))); // safe bottom right
    }
  }, []);

  // 2. Continuous smart clamping to keep the button fully visible and snapped to the nearest edge
  useEffect(() => {
    const clampToVisibleScreen = () => {
      // Snapping applies to the closed button only - never pull an open chat
      // panel to the edge (that pushed it off-screen on load or resize).
      if (isChatOpenRef.current) return;
      const w = viewportWidth();
      const h = window.innerHeight;
      
      if (w > 50 && h > 50) {
        const buttonSize = 64;

        const cx = mx.get();
        const cy = my.get();

        const dLeft = cx;
        const dRight = w - buttonSize - cx;
        const dTop = cy;
        const dBottom = h - buttonSize - cy;

        const minDist = Math.min(dLeft, dRight, dTop, dBottom);

        let targetX = cx;
        let targetY = cy;

        if (minDist === dLeft) {
          targetX = 0;
          targetY = Math.max(0, Math.min(h - buttonSize, cy));
        } else if (minDist === dRight) {
          targetX = w - buttonSize;
          targetY = Math.max(0, Math.min(h - buttonSize, cy));
        } else if (minDist === dTop) {
          targetY = 0;
          targetX = Math.max(0, Math.min(w - buttonSize, cx));
        } else {
          targetY = h - buttonSize;
          targetX = Math.max(0, Math.min(w - buttonSize, cx));
        }

        if (targetX !== cx || targetY !== cy) {
          mx.set(targetX);
          my.set(targetY);
        }
      }
    };

    // Listen to resize events
    window.addEventListener('resize', clampToVisibleScreen);

    // Progressive checking intervals to compensate for slow loads, sub-iframes, and dynamic viewports on Render
    const checks = [100, 300, 600, 1200, 2500, 4500];
    const timers = checks.map(t => setTimeout(clampToVisibleScreen, t));

    return () => {
      window.removeEventListener('resize', clampToVisibleScreen);
      timers.forEach(clearTimeout);
    };
  }, []);

  const [isDraggingState, setIsDraggingState] = useState(false);
  const dragStartOffset = useRef({ x: 0, y: 0 });
  const startPointerCoords = useRef({ x: 0, y: 0 });

  const [isChatDragging, setIsChatDragging] = useState(false);
  const chatDragStart = useRef({ x: 0, y: 0 });

  const handleDragEnd = (e: any, info: any) => {
    setIsDraggingState(false);
    
    // Snapping logic (Always snap to left or right edges like native iOS AssistiveTouch)
    const w = viewportWidth();
    const h = window.innerHeight;
    const buttonSize = 64;
    const margin = 16;
    
    // Header spacing and footer spacing limits
    const topLimit = margin + 64; 
    const bottomLimit = h - buttonSize - margin - 50;

    let targetX = mx.get();
    let targetY = my.get();

    // Snap to nearest horizontal edge
    if (targetX < w / 2) {
      targetX = margin; // Left
    } else {
      targetX = w - buttonSize - margin; // Right
    }

    // Clamp vertical position strictly within view bounds
    targetY = Math.max(topLimit, Math.min(bottomLimit, targetY));

    animate(mx, targetX, { type: 'spring', stiffness: 450, damping: 25 });
    animate(my, targetY, { type: 'spring', stiffness: 450, damping: 25 });
  };

  const handleChatDragEnd = (e: any, info: any) => {
    setIsChatDragging(false);

    const chatWidth = 360;
    const chatHeight = 520;
    const pad = 12;
    const footerLimit = 100;

    const targetX = mx.get();
    const targetY = my.get();

    // Boundary constraints matching the UI viewport bounds perfectly
    const finalX = Math.max(pad, Math.min(viewportWidth() - chatWidth - pad, targetX));
    const finalY = Math.max(80, Math.min(window.innerHeight - footerLimit - chatHeight, targetY));

    animate(mx, finalX, { type: 'spring', stiffness: 350, damping: 25 });
    animate(my, finalY, { type: 'spring', stiffness: 350, damping: 25 });
  };

  // Auto scroll to bottom of chat
  const scrollToBottom = () => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  };

  useEffect(() => {
    if (isChatOpen) {
      setTimeout(scrollToBottom, 60);
    }
    // Also follow the live status as it changes, so the current step stays in view.
  }, [messages, isChatOpen, activity, reveal?.shown]);

  // Execute API commands returned from Gemini in real-time
  const executeCommandsList = async (commands: any[]): Promise<string[]> => {
    const executedLogs: string[] = [];
    if (!commands || commands.length === 0) return executedLogs;

    for (const cmd of commands) {
      const { label, orb } = describeAction(cmd);
      setActivity(prev => ({
        phase: 'acting',
        steps: [...(prev?.steps ?? []), { label, orb, status: 'running' }],
      }));
      const logsBefore = executedLogs.length;
      try {
        switch (cmd.type) {
          case 'SELECT_TAB':
            if (cmd.tab) {
              setActiveTab(cmd.tab);
              executedLogs.push(`Opened the ${STAGES[cmd.tab as PipelineStage]?.label ?? cmd.tab} step`);
            }
            break;

          case 'RESET_DATASET':
            onResetOriginal();
            executedLogs.push('Restored the original dataset');
            break;

          case 'DROP_COLUMN':
            if (activeDataset && cmd.column) {
              const targetColName = activeDataset.columns.find(
                c => c.name.toLowerCase() === cmd.column.toLowerCase()
              )?.name;

              if (targetColName) {
                const refreshedCols = activeDataset.columns.filter(c => c.name !== targetColName);
                const refreshedRows = activeDataset.rows.map(row => {
                  const copy = { ...row };
                  delete copy[targetColName];
                  return copy;
                });

                onUpdateDataset({
                  ...activeDataset,
                  columns: refreshedCols,
                  rows: refreshedRows,
                  rowCount: refreshedRows.length
                });
                executedLogs.push(`Removed column "${targetColName}"`);
              } else {
                executedLogs.push(`Column "${cmd.column}" not found`);
              }
            }
            break;

          case 'FILL_MISSING':
            if (activeDataset && cmd.column) {
              const targetCol = activeDataset.columns.find(
                c => c.name.toLowerCase() === cmd.column.toLowerCase()
              );

              if (targetCol) {
                const strategy = cmd.strategy || 'mean';
                let fillVal: any = 0;

                if (targetCol.type === 'numeric') {
                  if (strategy === 'mean') fillVal = targetCol.statistics.mean || 0;
                  else if (strategy === 'median') fillVal = targetCol.statistics.median || 0;
                  else fillVal = 0;
                } else {
                  fillVal = targetCol.statistics.mostCommon?.[0]?.value || 'Unknown';
                }

                const cleanedRows = activeDataset.rows.map(row => {
                  const val = row[targetCol.name];
                  if (val === null || val === undefined || val === '') {
                    return { ...row, [targetCol.name]: fillVal };
                  }
                  return row;
                });

                const updatedCols = activeDataset.columns.map(col => {
                  if (col.name === targetCol.name) {
                    return { ...col, missingCount: 0 };
                  }
                  return col;
                });

                onUpdateDataset({
                  ...activeDataset,
                  columns: updatedCols,
                  rows: cleanedRows
                });
                executedLogs.push(`Imputed missing values in "${targetCol.name}" using strategy "${strategy}" (${fillVal})`);
              } else {
                executedLogs.push(`Column "${cmd.column}" not found to perform imputation`);
              }
            }
            break;

          case 'RUN_EDA_SCAN':
            // Wait for the analysis, so the chat shows it running until it is done.
            await triggerAIScan();
            executedLogs.push('Analyzed the dataset');
            break;

          case 'RUN_ML':
            if (activeDataset && cmd.targetColumn) {
              const foundTarget = activeDataset.columns.find(
                c => c.name.toLowerCase() === cmd.targetColumn.toLowerCase()
              )?.name || activeDataset.columns[activeDataset.columns.length - 1]?.name;

              const featCols = Array.isArray(cmd.featureColumns) 
                ? cmd.featureColumns.map(fc => activeDataset.columns.find(c => c.name.toLowerCase() === fc.toLowerCase())?.name).filter(Boolean) as string[]
                : activeDataset.columns.filter(c => c.name !== foundTarget).map(c => c.name).slice(0, 4);

              const modelType = cmd.modelType || (foundTarget.toLowerCase().includes('churn') ? 'classification' : 'regression');
              const hParams = cmd.hyperparameters || { n_estimators: 100, max_depth: 8 };

              // Wait for the real training run; report it only once it has finished.
              await triggerPrediction(foundTarget, featCols, modelType, hParams);
              executedLogs.push(`Trained a model to predict "${foundTarget}" using ${featCols.join(', ')}`);
            }
            break;

          case 'FILTER_ROWS':
            if (activeDataset && cmd.column && cmd.operator) {
              const targetColName = activeDataset.columns.find(
                c => c.name.toLowerCase() === cmd.column.toLowerCase()
              )?.name;

              if (targetColName) {
                const operator = cmd.operator;
                const filterVal = cmd.value;

                const filteredRows = activeDataset.rows.filter(row => {
                  const val = row[targetColName];
                  if (val === null || val === undefined) return false;

                  if (operator === '==') return String(val).toLowerCase() === String(filterVal).toLowerCase();
                  if (operator === '!=') return String(val).toLowerCase() !== String(filterVal).toLowerCase();
                  if (operator === '>') return Number(val) > Number(filterVal);
                  if (operator === '<') return Number(val) < Number(filterVal);
                  return true;
                });

                onUpdateDataset({
                  ...activeDataset,
                  rows: filteredRows,
                  rowCount: filteredRows.length
                });

                executedLogs.push(`Filtered dataset: Kept rows where "${targetColName}" ${operator} "${filterVal}" (${filteredRows.length} left)`);
              }
            }
            break;

          case 'ADD_COLUMN':
            if (activeDataset && cmd.column) {
              const newColName = cmd.column;
              const newColType = cmd.columnType || 'categorical';
              const defaultVal = cmd.value !== undefined ? cmd.value : '';

              if (!activeDataset.columns.some(c => c.name.toLowerCase() === newColName.toLowerCase())) {
                const newColMeta = {
                  name: newColName,
                  type: newColType as any,
                  missingCount: 0,
                  distinctCount: 1,
                  statistics: {
                    min: newColType === 'numeric' ? Number(defaultVal) || 0 : undefined,
                    max: newColType === 'numeric' ? Number(defaultVal) || 0 : undefined,
                    mean: newColType === 'numeric' ? Number(defaultVal) || 0 : undefined,
                    median: newColType === 'numeric' ? Number(defaultVal) || 0 : undefined,
                    mostCommon: [{ value: String(defaultVal), count: activeDataset.rows.length }]
                  }
                };

                const updatedRows = activeDataset.rows.map(row => ({
                  ...row,
                  [newColName]: defaultVal
                }));

                onUpdateDataset({
                  ...activeDataset,
                  columns: [...activeDataset.columns, newColMeta],
                  rows: updatedRows
                });
                executedLogs.push(`Added column "${newColName}" of type "${newColType}" filled with "${defaultVal}"`);
              } else {
                executedLogs.push(`Column "${newColName}" already exists`);
              }
            }
            break;

          case 'ADD_ROW':
            if (activeDataset) {
              const newRow: Record<string, any> = {};
              activeDataset.columns.forEach(col => {
                if (col.type === 'numeric') {
                  newRow[col.name] = 0;
                } else if (col.type === 'boolean') {
                  newRow[col.name] = false;
                } else {
                  newRow[col.name] = '';
                }
              });

              // Optional support for custom values filled by AI
              if (cmd.values && typeof cmd.values === 'object') {
                Object.keys(cmd.values).forEach(k => {
                  const matchCol = activeDataset.columns.find(col => col.name.toLowerCase() === k.toLowerCase());
                  if (matchCol) {
                    newRow[matchCol.name] = cmd.values[k];
                  }
                });
              }

              const updatedRows = [...activeDataset.rows, newRow];
              onUpdateDataset({
                ...activeDataset,
                rows: updatedRows,
                rowCount: updatedRows.length
              });
              executedLogs.push(`Added an empty row`);
            }
            break;

          case 'DELETE_ROW':
            if (activeDataset && cmd.index !== undefined) {
              const idxToDelete = Number(cmd.index);
              if (idxToDelete >= 0 && idxToDelete < activeDataset.rows.length) {
                const refreshedRows = activeDataset.rows.filter((_, idx) => idx !== idxToDelete);
                onUpdateDataset({
                  ...activeDataset,
                  rows: refreshedRows,
                  rowCount: refreshedRows.length
                });
                executedLogs.push(`Deleted row ${idxToDelete}`);
              } else {
                executedLogs.push(`Invalid row index ${idxToDelete} specified`);
              }
            }
            break;

          case 'EXECUTE_DATASET_JS':
            if (activeDataset && cmd.jsCode) {
              try {
                // Run this LLM/user-generated code inside an isolated,
                // opaque-origin sandboxed iframe rather than this page's own
                // privileged context. A dataset cell can carry a prompt-
                // injection payload that tricks the chat model into emitting
                // jsCode here, so it must never get direct access to this
                // page's cookies, localStorage, or DOM.
                const updated = await runSandboxedDatasetJs(cmd.jsCode, activeDataset);
                if (updated && Array.isArray(updated.rows)) {
                  onUpdateDataset({
                    ...activeDataset,
                    ...updated,
                    rowCount: updated.rows.length
                  });
                  let logMsg = `SQL Action Applied`;
                  if (cmd.sqlQuery) logMsg += ` [Query: "${cmd.sqlQuery}"]`;
                  if (cmd.explanation) logMsg += `: ${cmd.explanation}`;
                  executedLogs.push(logMsg);
                } else {
                  executedLogs.push(`The action ran but returned incomplete data`);
                }
              } catch (evalErr: any) {
                console.error("Evaluation error:", evalErr);
                executedLogs.push(`Couldn’t run that: ${evalErr.message || String(evalErr)}`);
              }
            }
            break;

          default:
            break;
        }
      } catch (err: any) {
        executedLogs.push(`Error executing command [${cmd.type}]: ${err.message || String(err)}`);
      }
      const newLogs = executedLogs.slice(logsBefore);
      const failed = newLogs.some(l => FAILED_ACTION.test(l));
      setActivity(prev => prev && ({
        ...prev,
        steps: prev.steps.map((st, i) => i === prev.steps.length - 1 ? { ...st, status: failed ? 'failed' : 'done' } : st),
      }));
    }

    return executedLogs;
  };

  const handleSendMessage = async (customText?: string) => {
    const textToSendRaw = customText ? customText.trim() : inputText.trim();
    if (!textToSendRaw || isGenerating) return;

    if (!customText) {
      setInputText('');
    }

    let textToSend = textToSendRaw;
    if (!customText) {
      if (inputMode === 'sql') {
         textToSend = `[SQL COMMAND]\n${textToSendRaw}`;
      } else if (inputMode === 'python') {
         textToSend = `[PYTHON/JS SCRIPT]\n${textToSendRaw}`;
      }
    }

    const newMsg: ChatMessage = {
      id: crypto.randomUUID(),
      role: 'user',
      content: textToSend,
      timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    };

    setMessages(prev => [...prev, newMsg]);
    setIsGenerating(true);
    setActivity({ phase: 'thinking', steps: [] });

    try {
      // Build dataset context schema to share with the Gemini Bot
      const datasetContext = activeDataset ? {
        filename: activeDataset.filename,
        rowCount: activeDataset.rowCount,
        columns: activeDataset.columns.map(c => ({
          name: c.name,
          type: c.type,
          missingCount: c.missingCount,
          distinctCount: c.distinctCount,
          statistics: {
            mean: c.statistics.mean,
            median: c.statistics.median,
            mostCommon: c.statistics.mostCommon?.slice(0, 3)
          }
        })),
        sampleRows: activeDataset.rows.slice(0, 3)
      } : null;

      // Extract brief history of latest 8 messages to keep token counts tight
      const messageHistory = messages.slice(-8).map(m => ({
        role: m.role,
        content: m.content
      }));

      let data;
      try {
        const res = await apiFetch('/api/chat-bot', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            message: textToSend,
            history: messageHistory,
            datasetContext,
            activeTab
          })
        });

        const resText = await res.text();
        if (resText.trim().startsWith('<!doctype html') || resText.trim().startsWith('<html') || !res.ok) {
          throw new Error('Fallback to local analyzer');
        }
        data = JSON.parse(resText);
      } catch (e) {
        console.warn('Backend server returned invalid or HTML response. running local copilot fallback...', e);
        data = getClientSideChatFallback(textToSend, activeDataset, activeTab);
      }
      
      // Execute any commands returned by the model
      const executedLogs = await executeCommandsList(data.commands || []);

      const botMsg: ChatMessage = {
        id: crypto.randomUUID(),
        role: 'assistant',
        content: data.message || `Processed your instruction successfully.`,
        timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
        executedCommands: executedLogs
      };

      // Write the reply out on screen (skipped for reduced motion).
      if (!prefersReducedMotion()) {
        setActivity(prev => ({ phase: 'writing', steps: prev?.steps ?? [] }));
        setReveal({ id: botMsg.id, shown: 0 });
      }
      setMessages(prev => [...prev, botMsg]);

      // Trigger temporary glowing system overlay notification on screen
      if (executedLogs.length > 0) {
        setLastExecutedTaskMsg(executedLogs.join(' | '));
        setTimeout(() => setLastExecutedTaskMsg(null), 5000);
      }

    } catch (err: any) {
      console.error(err);
      const errorMsg: ChatMessage = {
        id: crypto.randomUUID(),
        role: 'assistant',
        content: `That didn’t work: ${err.message || 'connection timed out'}. Check that the server is running and try again.`,
        timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
      };
      setMessages(prev => [...prev, errorMsg]);
    } finally {
      setIsGenerating(false);
      setActivity(prev => (prev?.phase === 'writing' ? prev : null));
    }
  };

  // Writes the newest reply out a few characters at a time (about a second in
  // total, whatever its length), then clears the activity status.
  useEffect(() => {
    if (!reveal) return;
    const msg = messages.find(m => m.id === reveal.id);
    if (!msg) return;
    const finished = reveal.shown >= msg.content.length;
    const step = Math.max(2, Math.ceil(msg.content.length / 45));
    const timer = setTimeout(() => {
      if (finished) {
        setReveal(null);
        setActivity(null);
      } else {
        setReveal(r => r && { ...r, shown: r.shown + step });
      }
    }, 22);
    return () => clearTimeout(timer);
  }, [reveal, messages]);

  const currentStep = activity?.steps.find(st => st.status === 'running');
  const activityOrb: OrbState =
    activity?.phase === 'thinking' ? 'breathing'
    : activity?.phase === 'writing' ? 'composing'
    : currentStep?.orb ?? 'working';
  const activityLabel =
    activity?.phase === 'thinking' ? 'Thinking…'
    : activity?.phase === 'writing' ? 'Writing…'
    : currentStep ? `${currentStep.label}…` : 'Working…';

  const handleSuggestedPromptClick = (promptStr: string) => {
    handleSendMessage(promptStr);
  };

  // Drag container Ref bounding calculations
  useEffect(() => {
    // Generate simple boundary constraints handler
  }, []);

  return (
    <>
      {/* Dynamic Screen Overlay for Executed Tasks */}
      <AnimatePresence>
        {lastExecutedTaskMsg && (
          <motion.div
            initial={{ opacity: 0, y: -25, scale: 0.95 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: -25, scale: 0.95 }}
            className="fixed top-20 left-1/2 -translate-x-1/2 z-50 bg-green/15 backdrop-blur-md border border-green/30 text-green tabular-nums text-xs px-5 py-3 rounded-full flex items-center gap-2 shadow-xl tracking-tight leading-relaxed font-semibold select-none max-w-lg text-center"
          >
            <div className="w-2 h-2 rounded-full bg-green animate-ping" />
            <span>{lastExecutedTaskMsg}</span>
          </motion.div>
        )}
      </AnimatePresence>

      {/* AssistiveTouch Floating Base Area */}
      <div 
        ref={dragContainerRef}
        className="fixed inset-0 pointer-events-none z-[9999] select-none overflow-hidden" 
        id="assistive_draggable_universe"
      >
        <AnimatePresence mode="wait">
          {!isChatOpen ? (
            /* AssistiveTouch Button Mode - Visible only when Chatbox is closed */
            <motion.div
              key="assistive-icon"
              style={{ x: mx, y: my, touchAction: 'none' }}
              initial={{ scale: 1, opacity: 1 }}
              exit={{ scale: 1, opacity: 0 }}
              className="fixed top-0 left-0 pointer-events-auto cursor-grab active:cursor-grabbing z-50 flex flex-col items-center justify-center p-1"
              drag
              dragMomentum={false}
              dragElastic={0.1}
              onDragStart={() => setIsDraggingState(true)}
              onDragEnd={handleDragEnd}
              onTap={() => {
                const chatWidth = 360;
                const chatHeight = 520;
                const pad = 12;

                let cx = mx.get();
                let cy = my.get();

                if (cx + chatWidth > viewportWidth()) {
                  cx = viewportWidth() - chatWidth - pad;
                }
                if (cx < pad) cx = pad;

                if (cy + chatHeight > window.innerHeight) {
                  cy = window.innerHeight - chatHeight - pad;
                }
                if (cy < pad) cy = pad;

                animate(mx, cx, { type: 'spring', stiffness: 400, damping: 30 });
                animate(my, cy, { type: 'spring', stiffness: 400, damping: 30 });
                setIsChatOpen(true);
              }}
              whileHover={{ scale: 1.05 }}
              whileTap={{ scale: 0.95 }}
            >
              {/* Floating assistant button */}
              <div
                className="material w-16 h-16 rounded-full shadow-xl flex items-center justify-center select-none"
                role="button"
                aria-label="Open the AI assistant"
                title="Ask AI"
              >
                {/* The assistant's face: calm while idle. */}
                <Orb state="breathing" size={64} label="AI assistant" />
              </div>
            </motion.div>
          ) : (
            /* Chat Box Mode (65% Scaler Size applied, Draggable across coordinates) */
            <motion.div
              key="assistive-chat"
              style={{ x: mx, y: my, touchAction: 'none' }}
              animate={{ scale: 1, opacity: 1 }}
              initial={{ scale: 0.8, opacity: 0 }}
              exit={{ scale: 0.8, opacity: 0 }}
              transition={{
                type: 'spring',
                damping: 25,
                stiffness: 220
              }}
              className="fixed top-0 left-0 w-[360px] max-w-[calc(100vw-24px)] h-[520px] max-h-[calc(100vh-24px)] bg-raised rounded-3xl shadow-xl flex flex-col z-50 pointer-events-auto overflow-hidden select-text"
              id="assistive_chat_panel"
              drag
              dragMomentum={false}
              dragElastic={0}
              onDragStart={(e) => {
                // Only drag from the header element dragging target, exclude close buttons etc
                const target = e.target as HTMLElement;
                if (target.closest('button') || target.closest('svg')) {
                  e.preventDefault();
                  return;
                }
                setIsChatDragging(true);
              }}
              onDragEnd={handleChatDragEnd}
            >
              {/* Header — also the drag handle */}
              <div className="px-4 py-3 border-b border-separator flex items-center justify-between shrink-0 cursor-move select-none">
                <div className="flex items-center gap-2.5">
                  <span className="w-8 h-8 rounded-full bg-fill flex items-center justify-center shrink-0">
                    {/* Breathes while idle; otherwise shows what it is doing right now. */}
                    <Orb state={activity ? activityOrb : 'breathing'} label={activity ? activityLabel : 'AI assistant'} />
                  </span>
                  <div>
                    <h4 className="text-sm font-semibold text-label leading-tight">Ask AI</h4>
                    <p className="text-xs text-label-2 leading-tight truncate max-w-[220px]" aria-live="polite">
                      {activity ? activityLabel : 'Works on your data and every step'}
                    </p>
                  </div>
                </div>
                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    // Close the chat and snap the AssistiveTouch button back to nearest screen edge
                    setIsChatOpen(false);
                    setTimeout(() => {
                      const midX = viewportWidth() / 2;
                      const paddingX = 16;
                      const buttonSize = 64;
                      const snapX = mx.get() < midX ? paddingX : viewportWidth() - buttonSize - paddingX;
                      animate(mx, snapX, { type: 'spring', stiffness: 400, damping: 30 });
                    }, 50);
                  }}
                  className="btn btn-icon w-8 h-8 bg-fill"
                  aria-label="Close assistant"
                >
                  <X className="w-4 h-4" />
                </button>
              </div>

              {/* Chat Thread Messages Stream (65% Scaled Height & Text) */}
              <div className="flex-1 px-3 py-4 overflow-y-auto space-y-3 select-text" style={{ WebkitOverflowScrolling: 'touch' }}>
                {messages.map((m) => {
                  const isUser = m.role === 'user';
                  return (
                    <div 
                      key={m.id} 
                      className={`flex ${isUser ? 'justify-end' : 'justify-start'} items-end gap-1.5`}
                    >
                      
                      <div className="space-y-1 max-w-[85%]">
                        <div 
                          className={`rounded-2xl px-3 py-2 text-xs inline-block leading-relaxed ${
                            isUser
                              ? 'bg-blue text-white rounded-br-md'
                              : 'bg-fill text-label rounded-bl-md space-y-1'
                          }`}
                        >
                          <div className="whitespace-pre-wrap font-sans">
                            {(reveal?.id === m.id ? m.content.slice(0, reveal.shown) : m.content).split('\n').map((line, idx) => {
                              const formatted = line;
                              
                              // Translate markdowns bold text **abc** inside scaled thread
                              const boldRegex = /\*\*(.*?)\*\*/g;
                              const matches = [...formatted.matchAll(boldRegex)];
                              
                              if (matches.length > 0) {
                                return (
                                  <div key={idx} className="mb-0.5 leading-relaxed">
                                    {formatted.split(/\*\*.*?\*\*/g).map((part, pIdx) => {
                                      const boldText = matches[pIdx]?.[1];
                                      return (
                                        <React.Fragment key={pIdx}>
                                          {part}
                                          {boldText && <strong className="text-label font-semibold">{boldText}</strong>}
                                        </React.Fragment>
                                      );
                                    })}
                                  </div>
                                );
                              }

                              if (formatted.trim().startsWith('-')) {
                                return (
                                  <li key={idx} className="list-disc ml-3.5 mt-0.5 leading-normal">
                                    {formatted.replace('-', '').trim()}
                                  </li>
                                );
                              }

                              if (formatted.includes('`')) {
                                return (
                                  <div key={idx} className="mb-0.5 inline-block">
                                    {formatted.split('`').map((cPart, cIdx) => (
                                      cIdx % 2 === 1 
                                        ? <code key={cIdx} className="bg-well px-1 py-0.5 rounded text-[11px]">{cPart}</code>
                                        : <span key={cIdx}>{cPart}</span>
                                    ))}
                                  </div>
                                );
                              }

                              return <p key={idx} className="mb-0.5">{formatted}</p>;
                            })}
                          </div>

                          {m.executedCommands && m.executedCommands.length > 0 && (
                            <div className="mt-1.5 pt-1.5 border-t border-separator text-[11px] space-y-0.5">
                              <span className="block font-medium text-label-2">Actions applied</span>
                              {m.executedCommands.map((log, lIdx) => (
                                <div key={lIdx} className="flex items-start gap-1 text-label">
                                  {FAILED_ACTION.test(log)
                                    ? <AlertTriangle className="w-3 h-3 text-orange shrink-0 mt-0.5" />
                                    : <Check className="w-3 h-3 text-green shrink-0 mt-0.5" />}
                                  <span>{log}</span>
                                </div>
                              ))}
                            </div>
                          )}
                        </div>
                        <span className="text-[11px] text-label-3 tabular-nums block px-1 leading-none">
                          {m.timestamp}
                        </span>
                      </div>
                    </div>
                  );
                })}

                {activity && activity.phase !== 'writing' && (
                  <div className="flex justify-start" aria-live="polite">
                    <div className="bg-fill rounded-2xl rounded-bl-md px-3 py-2 text-xs text-label-2 space-y-1.5 max-w-[85%]">
                      {activity.phase === 'thinking' ? (
                        <div className="flex items-center gap-2">
                          <Orb state="breathing" label="Thinking" />
                          Thinking…
                        </div>
                      ) : (
                        activity.steps.map((st, i) => (
                          <div key={i} className="flex items-center gap-2">
                            {st.status === 'running' ? (
                              <Orb state={st.orb} label={st.label} />
                            ) : (
                              <span className="w-5 h-5 flex items-center justify-center shrink-0">
                                {st.status === 'done'
                                  ? <Check className="w-3.5 h-3.5 text-green" />
                                  : <AlertTriangle className="w-3.5 h-3.5 text-orange" />}
                              </span>
                            )}
                            <span className={st.status === 'running' ? 'text-label' : ''}>
                              {st.label}{st.status === 'running' ? '…' : ''}
                            </span>
                          </div>
                        ))
                      )}
                    </div>
                  </div>
                )}
                {activity?.phase === 'writing' && (
                  <div className="flex items-center gap-2 text-xs text-label-3 pl-1" aria-hidden="true">
                    <Orb state="composing" label="Writing" />
                    Writing…
                  </div>
                )}
                <div ref={messagesEndRef} />
              </div>

              {/* Suggested prompts */}
              <div className="px-3 py-2 flex gap-1.5 overflow-x-auto scrollbar-none shrink-0 select-none" id="chat_suggestions">
                {[
                  { label: 'Analyze dataset', prompt: 'Analyze this dataset with an EDA scan' },
                  { label: 'Fill missing values', prompt: 'Fill missing values with mean' },
                  { label: 'Open dashboard', prompt: 'Show the stakeholder dashboard' },
                  { label: 'Run SQL', prompt: 'SELECT * FROM dataset WHERE tenure > 35' },
                  { label: 'Reset data', prompt: 'Reset dataset' }
                ].map((s, idx) => (
                  <button
                    key={idx}
                    type="button"
                    onClick={(e) => { e.stopPropagation(); handleSuggestedPromptClick(s.prompt); }}
                    className="tag bg-blue/10 text-blue hover:bg-blue/15 py-1 shrink-0"
                  >
                    {s.label}
                  </button>
                ))}
              </div>

              {/* Composer */}
              <form
                onSubmit={(e) => { e.preventDefault(); e.stopPropagation(); handleSendMessage(); }}
                className="p-3 pt-1 border-t border-separator flex flex-col gap-2 shrink-0 select-none"
              >
                <div className="segmented w-full mt-2" role="group" aria-label="Input mode">
                  <button type="button" className="flex-1" aria-pressed={inputMode === 'english'} onClick={(e) => { e.stopPropagation(); setInputMode('english'); }}>
                    Ask
                  </button>
                  <button type="button" className="flex-1" aria-pressed={inputMode === 'sql'} onClick={(e) => { e.stopPropagation(); setInputMode('sql'); }}>
                    SQL
                  </button>
                  <button type="button" className="flex-1" aria-pressed={inputMode === 'python'} onClick={(e) => { e.stopPropagation(); setInputMode('python'); }}>
                    Code
                  </button>
                </div>
                <div className="flex items-center gap-2">
                  <input
                    type="text"
                    value={inputText}
                    onChange={(e) => setInputText(e.target.value)}
                    placeholder={inputMode === 'english' ? 'Ask anything about your data' : inputMode === 'sql' ? 'SELECT … FROM dataset' : 'Write a transform in Python or JS'}
                    aria-label="Message"
                    disabled={isGenerating}
                    className={`input flex-1 rounded-full px-3.5 ${inputMode === 'english' ? '' : 'font-code text-xs'}`}
                  />
                  <button
                    type="submit"
                    disabled={!inputText.trim() || isGenerating}
                    aria-label="Send"
                    className="btn btn-primary w-9 h-9 min-h-0 p-0 rounded-full shrink-0"
                  >
                    <Send className="w-4 h-4" />
                  </button>
                </div>
              </form>
            </motion.div>
          )}
        </AnimatePresence>
      </div>
    </>
  );
}

// Executes an LLM/user-generated dataset-transform function inside a fresh,
// sandboxed iframe (allow-scripts only, no allow-same-origin) instead of this
// page's own realm. Because the iframe gets an opaque origin, code running
// inside it cannot reach this page's document, cookies, or localStorage, and
// cannot navigate or deface the real page - it can only see the exact
// `dataset` value it is handed and return a replacement. This does not stop
// that code from exfiltrating the dataset slice it was given (it must see
// that data to transform it), but it removes the far larger blast radius of
// running attacker-influenced code with full access to the live session.
function runSandboxedDatasetJs(jsCode: string, dataset: any): Promise<any> {
  return new Promise((resolve, reject) => {
    const sandboxHtml = [
      '<!DOCTYPE html><html><body><script>',
      'window.addEventListener("message", function(event) {',
      '  try {',
      '    var fn = new Function("dataset", "return (" + event.data.jsCode + ")(dataset);");',
      '    var result = fn(event.data.dataset);',
      '    parent.postMessage({ __sandboxResult: true, ok: true, result: result }, "*");',
      '  } catch (e) {',
      '    parent.postMessage({ __sandboxResult: true, ok: false, error: (e && e.message) ? e.message : String(e) }, "*");',
      '  }',
      '});',
      '</' + 'script></body></html>'
    ].join('\n');

    const iframe = document.createElement('iframe');
    iframe.setAttribute('sandbox', 'allow-scripts');
    iframe.style.display = 'none';
    iframe.srcdoc = sandboxHtml;

    let settled = false;
    const cleanup = () => {
      window.removeEventListener('message', onMessage);
      clearTimeout(timer);
      iframe.parentNode?.removeChild(iframe);
    };

    const onMessage = (event: MessageEvent) => {
      if (event.source !== iframe.contentWindow || !event.data || !event.data.__sandboxResult) return;
      if (settled) return;
      settled = true;
      cleanup();
      if (event.data.ok) resolve(event.data.result);
      else reject(new Error(event.data.error || 'Sandboxed execution failed'));
    };

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(new Error('Sandboxed script execution timed out after 5s'));
    }, 5000);

    window.addEventListener('message', onMessage);

    iframe.onload = () => {
      iframe.contentWindow?.postMessage({ jsCode, dataset }, '*');
    };

    document.body.appendChild(iframe);
  });
}

function getClientSideChatFallback(userMsg: string, ds: any, activeTab: string) {
  const msgLower = userMsg.toLowerCase();
  let reply = "";
  const commands: any[] = [];

  const colNames = ds && Array.isArray(ds.columns) ? ds.columns.map((c: any) => c.name) : [];
  const colNamesList = colNames.join(', ');
  const rowCount = ds ? ds.rowCount : 0;

  // Prioritized SQL Command parser fallback
  if (msgLower.includes('select') || msgLower.includes('update') || msgLower.includes('delete') || msgLower.includes('insert') || msgLower.includes('alter') || msgLower.includes('multiply') || msgLower.includes('double') || msgLower.includes('calculate')) {
    let isQueryProcessed = false;
    let jsCode = "";
    const sqlQuery = userMsg;
    let explanation = "";

    // 1. SELECT query parsing (e.g., SELECT * FROM dataset WHERE Age > 30)
    if (msgLower.includes('select') && msgLower.includes('where')) {
      const match = msgLower.match(/where\s+(\w+)\s*(=|>|<|!=)\s*(['"]?[\w\s.-]+['"]?)/i);
      if (match) {
        const col = colNames.find((c: string) => c.toLowerCase() === match[1].toLowerCase()) || match[1];
        const op = match[2] === '=' ? '===' : match[2];
        const val = match[3].replace(/['"]/g, '').trim();
        const isNum = !isNaN(Number(val));
        const compareVal = isNum ? Number(val) : `'${val}'`;

        jsCode = `(dataset) => {
          const filteredRows = dataset.rows.filter(row => {
            const rowVal = row['${col}'];
            if (rowVal === undefined || rowVal === null) return false;
            return ${isNum ? 'Number(rowVal)' : 'String(rowVal).toLowerCase()'} ${op} ${isNum ? compareVal : `'${val.toLowerCase()}'`};
          });
          return {
            ...dataset,
            rows: filteredRows,
            rowCount: filteredRows.length
          };
        }`;
        explanation = `Filtered rows where "${col}" ${match[2]} "${val}"`;
        isQueryProcessed = true;
      }
    }

    // 2. UPDATE query parsing (e.g., UPDATE dataset SET churn = 1 WHERE tenure < 5)
    if (msgLower.includes('update') && msgLower.includes('set')) {
      const matchSet = msgLower.match(/set\s+(\w+)\s*=\s*([^where]+)/i);
      if (matchSet) {
        const colToUpdate = colNames.find((c: string) => c.toLowerCase() === matchSet[1].toLowerCase()) || matchSet[1];
        const expr = matchSet[2].trim();
        
        let whereCol: string | null = null;
        let whereOp = "===";
        let whereVal = "";
        let whereIsNum = false;

        const whereIndex = msgLower.indexOf('where');
        if (whereIndex !== -1) {
          const wherePart = userMsg.slice(whereIndex + 5).trim();
          const whereMatch = wherePart.match(/(\w+)\s*(=|>|<|!=)\s*(['"]?[\w\s.-]+['"]?)/i);
          if (whereMatch) {
            whereCol = colNames.find((c: string) => c.toLowerCase() === whereMatch[1].toLowerCase()) || whereMatch[1];
            whereOp = whereMatch[2] === '=' ? '===' : whereMatch[2];
            whereVal = whereMatch[3].replace(/['"]/g, '').trim();
            whereIsNum = !isNaN(Number(whereVal));
          }
        }

        jsCode = `(dataset) => {
          const updatedRows = dataset.rows.map(row => {
            const copy = { ...row };
            let shouldUpdate = true;
            if ('${whereCol || ''}') {
              const rowWhereVal = row['${whereCol || ''}'];
              if (rowWhereVal === undefined || rowWhereVal === null) {
                shouldUpdate = false;
              } else {
                const compVal = ${whereIsNum ? 'Number' : 'String'}(rowWhereVal);
                const targetComp = ${whereIsNum ? whereVal : `'${whereVal}'.toLowerCase()`};
                shouldUpdate = ${whereIsNum ? 'compVal' : 'compVal.toLowerCase()'} ${whereOp} targetComp;
              }
            }

            if (shouldUpdate) {
              let newVal = copy['${colToUpdate}'];
              const rawExpr = '${expr}';
              if (rawExpr.includes('+')) {
                const parts = rawExpr.split('+');
                const addVal = Number(parts[1].trim());
                newVal = isNaN(addVal) ? rawExpr.replace(/['"]/g, '') : Number(copy['${colToUpdate}']) + addVal;
              } else if (rawExpr.includes('-')) {
                const parts = rawExpr.split('-');
                const subVal = Number(parts[1].trim());
                newVal = isNaN(subVal) ? rawExpr.replace(/['"]/g, '') : Number(copy['${colToUpdate}']) - subVal;
              } else if (rawExpr.includes('*')) {
                const parts = rawExpr.split('*');
                const multVal = Number(parts[1].trim());
                newVal = isNaN(multVal) ? copy['${colToUpdate}'] : Number(copy['${colToUpdate}']) * multVal;
              } else if (!isNaN(Number(rawExpr))) {
                newVal = Number(rawExpr);
              } else {
                newVal = rawExpr.replace(/['"]/g, '');
              }
              copy['${colToUpdate}'] = newVal;
            }
            return copy;
          });

          return {
            ...dataset,
            rows: updatedRows
          };
        }`;
        explanation = `Updated values of "${colToUpdate}" matching query criteria`;
        isQueryProcessed = true;
      }
    }

    // 3. DELETE query parsing (e.g., DELETE FROM dataset WHERE age < 18)
    if (msgLower.includes('delete') && msgLower.includes('where')) {
      const match = msgLower.match(/where\s+(\w+)\s*(=|>|<|!=)\s*(['"]?[\w\s.-]+['"]?)/i);
      if (match) {
        const col = colNames.find((c: string) => c.toLowerCase() === match[1].toLowerCase()) || match[1];
        const op = match[2] === '=' ? '===' : match[2];
        const val = match[3].replace(/['"]/g, '').trim();
        const isNum = !isNaN(Number(val));
        const compareVal = isNum ? Number(val) : `'${val}'`;

        jsCode = `(dataset) => {
          const filteredRows = dataset.rows.filter(row => {
            const rowVal = row['${col}'];
            if (rowVal === undefined || rowVal === null) return true;
            const matchesCondition = ${isNum ? 'Number(rowVal)' : 'String(rowVal).toLowerCase()'} ${op} ${isNum ? compareVal : `'${val.toLowerCase()}'`};
            return !matchesCondition;
          });
          return {
            ...dataset,
            rows: filteredRows,
            rowCount: filteredRows.length
          };
        }`;
        explanation = `Deleted rows where "${col}" ${match[2]} "${val}"`;
        isQueryProcessed = true;
      }
    }

    if (!isQueryProcessed) {
      // Fallback custom mutator for general commands e.g. "double MonthlyCharges" or "multiply tenure by 10"
      const foundCol = colNames.find((c: string) => msgLower.includes(c.toLowerCase()));
      if (foundCol) {
        let scale = 1;
        if (msgLower.includes('double')) scale = 2;
        else if (msgLower.includes('triple')) scale = 3;
        else {
          const numMatch = msgLower.match(/\d+/);
          if (numMatch) scale = Number(numMatch[0]);
        }

        jsCode = `(dataset) => {
          const updatedRows = dataset.rows.map(row => {
            const copy = { ...row };
            if (copy['${foundCol}'] !== undefined) {
              copy['${foundCol}'] = Number(copy['${foundCol}']) * ${scale};
            }
            return copy;
          });
          return {
            ...dataset,
            rows: updatedRows
          };
        }`;
        explanation = `Scaled column "${foundCol}" by factor ${scale}`;
        isQueryProcessed = true;
      }
    }

    if (isQueryProcessed) {
      reply = `I have decoded your action request! Running dataset operations pipeline.\n- **Transformed query**: \`${sqlQuery}\`\n- **Database Action**: Executes dynamic row-set corrections seamlessly.`;
      commands.push({
        type: 'EXECUTE_DATASET_JS',
        jsCode,
        sqlQuery,
        explanation
      });
      commands.push({ type: 'SELECT_TAB', tab: 'clean' });
      return { message: reply, commands };
    }
  }

  if (msgLower.includes('drop') || msgLower.includes('remove column')) {
    // Find which column to drop
    const foundCol = colNames.find((c: string) => msgLower.includes(c.toLowerCase()));
    if (foundCol) {
      reply = `I have successfully analyzed your command to drop column. Dropping **"${foundCol}"** and updating active pipelines.`;
      commands.push({ type: 'DROP_COLUMN', column: foundCol });
      commands.push({ type: 'SELECT_TAB', tab: 'clean' });
    } else {
      reply = `I can drop columns for you, but I couldn't identify which column you wanted to drop. Available columns: ${colNamesList || 'No dataset loaded'}.`;
    }
  } else if (msgLower.includes('fill') || msgLower.includes('impute') || msgLower.includes('missing')) {
    const foundCol = colNames.find((c: string) => msgLower.includes(c.toLowerCase())) || colNames[0];
    let strategy = 'mean';
    if (msgLower.includes('median')) strategy = 'median';
    else if (msgLower.includes('zero') || msgLower.includes('0')) strategy = 'zero';
    else if (msgLower.includes('mode') || msgLower.includes('common')) strategy = 'mode';

    if (foundCol) {
      reply = `I am executing an data imputation task on column **"${foundCol}"** using the **"${strategy}"** strategy to clean the dataset.`;
      commands.push({ type: 'FILL_MISSING', column: foundCol, strategy });
      commands.push({ type: 'SELECT_TAB', tab: 'clean' });
    } else {
      reply = `Imputation can only be executed when a column is specified. Available columns: ${colNamesList || 'N/A'}`;
    }
  } else if (/hypothes|a\/b|\bab test|significan|t-test|chi-square|anova/.test(msgLower)) {
    reply = "Opening the **Statistics** step, where you can test a hypothesis on your data or check an A/B test result.";
    commands.push({ type: 'SELECT_TAB', tab: 'stats' });
  } else if (msgLower.includes('eda') || msgLower.includes('scan') || msgLower.includes('analyze') || msgLower.includes('exploratory')) {
    reply = "Starting Exploratory Data Scan and Statistical Analysis on active datasets using our intelligent analytics engine!";
    commands.push({ type: 'SELECT_TAB', tab: 'eda' });
    commands.push({ type: 'RUN_EDA_SCAN' });
  } else if (msgLower.includes('model') || msgLower.includes('predict') || msgLower.includes('ml') || msgLower.includes('train')) {
    // Intelligently infer target and features
    const targetCol = colNames.find((c: string) => msgLower.includes(c.toLowerCase()) && (c.toLowerCase().includes('target') || c.toLowerCase().includes('churn') || c.toLowerCase().includes('probability'))) || colNames[colNames.length - 1] || 'target';
    const features = colNames.filter((c: string) => c !== targetCol).slice(0, 4);
    const mType = msgLower.includes('class') || targetCol.toLowerCase().includes('churn') ? 'classification' : 'regression';
    
    reply = `I've configured and triggered an automated Machine Learning pipeline for you!\n- **Stage**: ML Modeling\n- **Target Column**: \`${targetCol}\`\n- **Features**: ${JSON.stringify(features)}\n- **Model Type**: \`${mType}\`\n\nTraining starting now...`;
    commands.push({ type: 'SELECT_TAB', tab: 'ml' });
    commands.push({ type: 'RUN_ML', targetColumn: targetCol, featureColumns: features, modelType: mType });
  } else if (msgLower.includes('dashboard') || msgLower.includes('chart') || msgLower.includes('metric') || msgLower.includes('slicer')) {
    reply = "Right away! Moving you to the **Stakeholder Dashboard** stage where you can filter columns and monitor business outcomes.";
    commands.push({ type: 'SELECT_TAB', tab: 'dashboard' });
  } else if (msgLower.includes('report') || msgLower.includes('brief') || msgLower.includes('pdf') || msgLower.includes('hub')) {
    reply = "Transitioning to **Strategic Reports Hub** stage. You can compile, view, and export executive analysis briefs here.";
    commands.push({ type: 'SELECT_TAB', tab: 'reports' });
  } else if (msgLower.includes('ingest') || msgLower.includes('upload') || msgLower.includes('csv')) {
    reply = "Opening **Data Ingestion** panel so you can upload or template a dataset.";
    commands.push({ type: 'SELECT_TAB', tab: 'ingest' });
  } else if (msgLower.includes('add column') || msgLower.includes('create column')) {
    let label = 'NewDimension';
    const parts = userMsg.split(/add column|create column/i);
    if (parts[1]) {
      const potentialName = parts[1].trim().split(' ')[0].replace(/[^a-zA-Z0-9_]/g, '');
      if (potentialName) label = potentialName;
    }
    reply = `I am executing a pipeline task to add a new column named **"${label}"** with default values. Checking structures...`;
    commands.push({ type: 'ADD_COLUMN', column: label, columnType: 'categorical', value: 'DefaultVal' });
    commands.push({ type: 'SELECT_TAB', tab: 'clean' });
  } else if (msgLower.includes('add row') || msgLower.includes('insert row')) {
    reply = `Instructing the pipeline studio to append a new default row with placeholder entries!`;
    commands.push({ type: 'ADD_ROW' });
    commands.push({ type: 'SELECT_TAB', tab: 'clean' });
  } else if (msgLower.includes('delete row') || msgLower.includes('remove row')) {
    const match = userMsg.match(/\d+/);
    const index = match ? parseInt(match[0]) : 0;
    reply = `Applying dataset correction: Deleting active row at index **#${index}**.`;
    commands.push({ type: 'DELETE_ROW', index });
    commands.push({ type: 'SELECT_TAB', tab: 'clean' });
  } else if (msgLower.includes('group by') || msgLower.includes('groupby')) {
    const foundCol = colNames.find((c: string) => msgLower.includes(c.toLowerCase())) || colNames[0];
    if (foundCol) {
      reply = `I am executing a group-by operation. Grouping the active dataset by **"${foundCol}"** and displaying aggregation breakdown in the Cleaning Studio.`;
      commands.push({ type: 'SELECT_TAB', tab: 'clean' });
    } else {
      reply = `I can group your columns for aggregate summaries, but please specify one from: ${colNamesList || 'N/A'}`;
    }
  } else if (msgLower.includes('reset') || msgLower.includes('restore') || msgLower.includes('original')) {
    reply = "I've reset the active worksheet back to its original raw state. All values restored successfully!";
    commands.push({ type: 'RESET_DATASET' });
    commands.push({ type: 'SELECT_TAB', tab: 'clean' });
  } else if (msgLower.includes('hello') || msgLower.includes('hi') || msgLower.includes('who are you') || msgLower.includes('creater') || msgLower.includes('deepak')) {
    reply = `Hello! I am **AskAI**, acting as your interactive **AskDeepakAI** co-pilot built by **Gorisi Deepak Reddy**. 
    
I can analyze your dataset, clean missing cells, add or delete rows and columns, compute group-by metrics, run ML prediction models, and manage tabs. Try prompts like:
- *"Add column PremiumCustomer"*
- *"Insert a blank row"*
- *"Delete row 3"*
- *"Group by Country"*
- *"Drop column PaymentMethod"*
- *"Impute missing Age with median"*
- *"Run classification models for target Churn"*
- *"Reset dataset"*`;
  } else {
    reply = `I have received your message: "${userMsg}". 
    
As your AI code copilot, I can read and write the active dataset! I can add/delete rows & columns, perform group values, and execute smart operations. Current dataset has **${rowCount}** rows with columns: ${colNamesList || 'None'}.`;
  }

  return { message: reply, commands };
}
