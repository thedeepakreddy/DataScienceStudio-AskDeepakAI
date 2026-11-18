/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState, useRef, useEffect } from 'react';
import { motion, AnimatePresence, useMotionValue, animate } from 'motion/react';
import { Send, X } from 'lucide-react';
import type { OrbState } from 'thinking-orbs';
import Orb from './Orb';
import ChatRunCard from './ChatRunCard';
import type { useSwarm } from '../swarm/useSwarm';
import type { SwarmRun } from '../swarm/runtime';
import { ApprovalSwitch } from './swarmBits';
import { CAPABILITIES } from '../swarm/catalog';

type Swarm = ReturnType<typeof useSwarm>;

interface AssistiveTouchBotProps {
  /** The agent team. Every request in the chat goes to its orchestrator. */
  swarm: Swarm;
  /** Returns the data to the version a run started from. */
  onUndoAll: (versionId: string) => void;
  /** Opens the Agents panel with the task map, messages and incidents. */
  onOpenDetails: () => void;
}

interface ChatMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  timestamp: string;
  /** The agent run started for this request, kept up to date while it works. */
  runId?: string;
  run?: SwarmRun;
  /** Why a plan couldn't be used. */
  problems?: string[];
}

// What the assistant is doing right now, shown live in the chat: thinking
// (the orchestrator is planning), acting (agents are working) and writing
// (the reply appearing).
type Activity = { phase: 'thinking' | 'acting' | 'writing' };

const now = () => new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

/** Code mode: a function of the dataset, or statements that change `rows`. */
export function wrapUserCode(code: string) {
  const c = code.trim();
  if (/^(\(?\s*\w*\s*\)?\s*=>|function\b|async\b)/.test(c)) return c;
  return `(dataset) => { let rows = dataset.rows.map(r => ({ ...r })); ${c}\n; return { ...dataset, rows }; }`;
}

/** Width of the visible page, excluding a vertical scrollbar. */
const viewportWidth = () =>
  (typeof document !== 'undefined' && document.documentElement.clientWidth) || window.innerWidth;

const prefersReducedMotion = () =>
  typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;

export default function AssistiveTouchBot({ swarm, onUndoAll, onOpenDetails }: AssistiveTouchBotProps) {
  const [isChatOpen, setIsChatOpen] = useState(false);
  const isChatOpenRef = useRef(false);
  useEffect(() => { isChatOpenRef.current = isChatOpen; }, [isChatOpen]);
  const [messages, setMessages] = useState<ChatMessage[]>([
    {
      id: 'welcome-msg',
      role: 'assistant',
      content: `Hi, I lead a team of specialist agents. Tell me what you need and they'll do it on this page, step by step, so you can watch.

Ask in plain English, or switch to **SQL** or **Code** below. For example:
- Clean the data and train a model
- Drop the PaymentMethod column
- Which columns have missing values?`,
      timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    }
  ]);
  const [inputText, setInputText] = useState('');
  const [inputMode, setInputMode] = useState<'english' | 'sql' | 'python'>('english');
  const [isGenerating, setIsGenerating] = useState(false);
  const [activity, setActivity] = useState<Activity | null>(null);
  const run = swarm.run;
  const working = !!run && ['running', 'paused', 'cancelling'].includes(run.status);
  // The reply currently being written out on screen, and how much of it shows.
  const [reveal, setReveal] = useState<{ id: string; shown: number } | null>(null);

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

  // Keep each request's run card up to date with the agents' progress
  // (adjusting state while rendering, as React recommends, not in an effect).
  const [seenRun, setSeenRun] = useState(run);
  if (seenRun !== run) {
    setSeenRun(run);
    if (run && messages.some(m => m.runId === run.id)) setMessages(prev => prev.map(m => (m.runId === run.id ? { ...m, run } : m)));
  }
  // While agents work, the header shows what they are doing.
  const shownActivity: Activity | null = activity ?? (run && ['running', 'cancelling'].includes(run.status) ? { phase: 'acting' } : null);

  const say = (content: string, extra: Partial<ChatMessage> = {}) => {
    const msg: ChatMessage = { id: crypto.randomUUID(), role: 'assistant', content, timestamp: now(), ...extra };
    if (!prefersReducedMotion()) {
      setActivity({ phase: 'writing' });
      setReveal({ id: msg.id, shown: 0 });
    }
    setMessages(prev => [...prev, msg]);
  };

  const handleSendMessage = async (customText?: string) => {
    const raw = (customText ?? inputText).trim();
    if (!raw || isGenerating) return;
    if (!customText) setInputText('');
    const mode = customText ? 'english' : inputMode;

    setMessages(prev => [...prev, { id: crypto.randomUUID(), role: 'user', content: mode === 'english' ? raw : `[${mode === 'sql' ? 'SQL' : 'Code'}]\n${raw}`, timestamp: now() }]);

    if (working) {
      say('The team is still working on your last request. Pause or stop it first, or wait for it to finish.');
      return;
    }

    setIsGenerating(true);
    setActivity({ phase: 'thinking' });
    try {
      const history = messages.filter(m => m.id !== 'welcome-msg').slice(-8).map(m => ({ role: m.role, content: m.content }));
      const outcome = mode === 'sql'
        ? await swarm.planFromTasks(raw, [{ id: 't1', capability: 'sql.query', params: { sql: raw }, role: 'data_scientist', dependsOn: [], why: 'Run your SQL query.' }], 'I’ll run your query (read-only).')
        : mode === 'python'
          ? await swarm.planFromTasks(raw, [{ id: 't1', capability: 'data.custom_code', params: { code: wrapUserCode(raw), explanation: 'your code' }, role: 'data_engineer', dependsOn: [], why: 'Run your code in a sandbox.' }], swarm.approvalMode === 'ask' ? 'I’ll run your code in a sandbox once you approve it.' : 'I’ll run your code in a sandbox.')
          : await swarm.plan(raw, history);

      if (outcome.tasks.length && !outcome.problems.length) {
        // The plan is attached to the reply; approve it there.
        const r = swarm.latestRun();
        const autoRun = r && r.tasks.every(t => t.approved);
        say(outcome.reply || 'Here’s the plan.', { runId: r?.id, run: r ?? undefined });
        // Plans that change nothing without your say-so start at once.
        if (autoRun) swarm.approveAndRun();
      } else if (outcome.tasks.length) {
        say(outcome.reply ? `${outcome.reply} But the plan can’t run:` : 'I couldn’t make a plan that would work:', { problems: outcome.problems.map(p => p.message) });
      } else {
        say(outcome.reply || 'I’m not sure what to do with that. Try describing the result you want.');
      }
    } catch (err: any) {
      say(`That didn’t work: ${err?.message || 'the connection failed'}. Check that the server is running and try again.`);
    } finally {
      setIsGenerating(false);
      setActivity(prev => (prev?.phase === 'thinking' ? null : prev));
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

  const runningTask = run?.tasks.find(t => t.status === 'running' || t.status === 'verifying');
  const activityOrb: OrbState =
    shownActivity?.phase === 'thinking' ? 'breathing'
    : shownActivity?.phase === 'writing' ? 'composing'
    : 'working';
  const activityLabel =
    shownActivity?.phase === 'thinking' ? 'Planning…'
    : shownActivity?.phase === 'writing' ? 'Writing…'
    : run?.status === 'paused' ? 'Paused'
    : runningTask ? `${CAPABILITIES[runningTask.capability]?.label(runningTask.params) ?? 'Working'}…` : 'Working…';

  const handleSuggestedPromptClick = (promptStr: string) => {
    handleSendMessage(promptStr);
  };

  // Drag container Ref bounding calculations
  useEffect(() => {
    // Generate simple boundary constraints handler
  }, []);

  return (
    <>
      {/* AssistiveTouch Floating Base Area */}
      <div 
        ref={dragContainerRef}
        className="fixed inset-0 pointer-events-none z-[9999] select-none overflow-hidden" 
        id="assistive_draggable_universe"
        data-swarm-ui
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
                    <Orb state={shownActivity ? activityOrb : 'breathing'} label={shownActivity ? activityLabel : 'AI assistant'} />
                  </span>
                  <div>
                    <h4 className="text-sm font-semibold text-label leading-tight">Ask AI</h4>
                    <p className="text-xs text-label-2 leading-tight truncate max-w-[220px]" aria-live="polite">
                      {shownActivity ? activityLabel : 'Your agent team for every step'}
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

                          {m.problems && (
                            <ul className="mt-1 text-[11px] text-orange list-disc ml-3.5 space-y-0.5">
                              {m.problems.map((p, i) => <li key={i}>{p}</li>)}
                            </ul>
                          )}

                          {m.run && (
                            <ChatRunCard
                              run={m.run}
                              live={run?.id === m.run.id}
                              onRun={swarm.approveAndRun}
                              onApproveTask={swarm.approveTask}
                              onPause={swarm.pause}
                              onResume={swarm.resume}
                              onCancel={swarm.cancel}
                              onDiscard={swarm.discard}
                              onUndo={onUndoAll}
                              onDetails={onOpenDetails}
                            />
                          )}
                        </div>
                        <span className="text-[11px] text-label-3 tabular-nums block px-1 leading-none">
                          {m.timestamp}
                        </span>
                      </div>
                    </div>
                  );
                })}

                {activity?.phase === 'thinking' && (
                  <div className="flex justify-start" aria-live="polite">
                    <div className="bg-fill rounded-2xl rounded-bl-md px-3 py-2 text-xs text-label-2 max-w-[85%] flex items-center gap-2">
                      <Orb state="breathing" label="Planning" />
                      Planning…
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
                  { label: 'Full analysis', prompt: 'Do a full analysis and write a report' },
                  { label: 'Clean data', prompt: 'Clean the data' },
                  { label: 'Fill missing values', prompt: 'Fill missing values with median' },
                  { label: 'Train a model', prompt: 'Train a model' },
                  { label: 'Run SQL', prompt: 'SELECT * FROM dataset LIMIT 10' },
                  { label: 'Reset data', prompt: 'Reset the data' },
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
                <div className="mt-2"><ApprovalSwitch compact mode={swarm.approvalMode} onChange={swarm.setApprovalMode} /></div>
                <div className="segmented w-full" role="group" aria-label="Input mode">
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
                    placeholder={inputMode === 'english' ? 'Ask or tell the team what to do' : inputMode === 'sql' ? 'SELECT … FROM dataset' : 'JS, e.g. rows = rows.filter(r => r.Age > 30)'}
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
