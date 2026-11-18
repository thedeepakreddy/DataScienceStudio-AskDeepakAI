/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React from 'react';
import { motion } from 'motion/react';
import { BarChart3, Bot, BrainCircuit, Database, FileText, FlaskConical, Github, Linkedin, Mail, MapPin, ShieldCheck, Sparkles } from 'lucide-react';
import { CAPABILITIES } from '../engine/client';
import { AGENTS } from '../swarm/agents';

const SKILLS = ['Python', 'SQL', 'Machine learning', 'Statistics', 'Data visualization', 'Dashboards & reporting', 'FastAPI', 'React & TypeScript', 'Google Cloud'];

const LINKS = [
  { href: 'https://github.com/thedeepakreddy', label: 'GitHub', sub: 'thedeepakreddy', icon: Github },
  { href: 'https://www.linkedin.com/in/deepak-reddy-038582223', label: 'LinkedIn', sub: 'Deepak Reddy', icon: Linkedin },
  { href: 'mailto:thedeepakreddy1@gmail.com', label: 'Email', sub: 'Get in touch', icon: Mail },
];

/** The creator and the studio, as a sheet. */
export default function AboutCreator({ onClose }: { onClose: () => void }) {
  const engineCount = Object.keys(CAPABILITIES).length;
  const agentCount = Object.keys(AGENTS).length;
  const BUILT = [
    { icon: Database, title: 'Data in, cleaned', text: 'Files, web addresses, APIs, databases, BigQuery and Cloud Storage; profiling, quality rules, PII masking and reusable cleaning recipes.' },
    { icon: FlaskConical, title: 'Statistics that hold up', text: 'Tests with assumptions checked, effect sizes and intervals; causal inference, experiments, survival and Bayesian methods.' },
    { icon: BrainCircuit, title: 'Models end to end', text: 'AutoML across model families with cross-validation, validation and test splits, explanations, fairness, a registry, monitoring and retraining on drift.' },
    { icon: BarChart3, title: 'Dashboards and forecasts', text: 'KPIs, charts and pinned results; time-series forecasts, anomalies and optimisation.' },
    { icon: Bot, title: `${agentCount} AI agents`, text: 'A team that plans and works through the studio for you, in plain view, with every change saved and undoable.' },
    { icon: FileText, title: 'Reports you can hand over', text: 'An editable, structured report with charts, model results and the Python and SQL behind them, as PDF, HTML or Markdown.' },
  ];

  return (
    <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center sm:p-4">
      <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={{ duration: 0.2 }} onClick={onClose} className="absolute inset-0 bg-[var(--scrim)]" />
      <motion.div
        role="dialog" aria-modal="true" aria-labelledby="about-title"
        initial={{ opacity: 0, y: 24, scale: 0.98 }} animate={{ opacity: 1, y: 0, scale: 1 }} exit={{ opacity: 0, y: 24, scale: 0.98 }}
        transition={{ duration: 0.3, ease: [0.28, 0.11, 0.32, 1] }}
        className="relative z-10 w-full sm:max-w-2xl bg-raised rounded-t-3xl sm:rounded-3xl shadow-xl max-h-[92vh] overflow-y-auto"
      >
        {/* Header */}
        <div className="relative px-6 sm:px-8 pt-6 pb-6 bg-gradient-to-b from-blue/10 to-transparent rounded-t-3xl">
          <div className="flex justify-end -mr-2">
            <button type="button" onClick={onClose} className="btn btn-plain font-semibold" autoFocus>Done</button>
          </div>
          <div className="flex flex-col sm:flex-row items-center sm:items-end gap-4 sm:gap-5 text-center sm:text-left">
            <div className="w-24 h-24 rounded-3xl bg-blue flex items-center justify-center shadow-lg shrink-0">
              <span className="text-white text-[34px] font-semibold tracking-tight">DR</span>
            </div>
            <div className="min-w-0">
              <h2 id="about-title" className="text-[26px] sm:text-[28px] font-semibold tracking-tight text-label leading-tight">Gorisi Deepak Reddy</h2>
              <p className="mt-1 text-[15px] text-label-2">Data Analyst &amp; Analytics Engineer</p>
              <div className="mt-2 flex flex-wrap justify-center sm:justify-start items-center gap-2 text-xs">
                <span className="inline-flex items-center gap-1 text-label-3"><MapPin className="w-3.5 h-3.5" /> Budapest, Hungary</span>
                <span className="inline-flex items-center gap-1.5 rounded-full bg-green/12 text-green px-2.5 py-0.5 font-medium">
                  <span className="w-1.5 h-1.5 rounded-full bg-green" /> Open to Data Analyst &amp; BI roles
                </span>
              </div>
            </div>
          </div>
        </div>

        <div className="px-6 sm:px-8 pb-8 space-y-7">
          {/* About */}
          <section aria-labelledby="about-me" className="space-y-2.5">
            <h3 id="about-me" className="section-title">About me</h3>
            <p className="text-[15px] text-label leading-relaxed">
              I build end-to-end data pipelines that connect technical insight to business decisions. With an MSc in IT for Business Data
              Analytics, my work spans Python, SQL, predictive machine learning and data visualization — from raw data to a result a team can act on.
            </p>
          </section>

          {/* The studio */}
          <section aria-labelledby="about-studio" className="space-y-3">
            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <h3 id="about-studio" className="section-title">AskDeepakAI Data Science Studio</h3>
              <span className="text-xs text-label-3">Designed and engineered by me</span>
            </div>
            <p className="text-sm text-label-2 leading-relaxed">
              One place for the whole data science workflow, from collecting data to deploying and monitoring models. It runs on a
              Python engine with {engineCount} analyses, and every number comes from your data — not from an AI guess.
            </p>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5">
              {BUILT.map(b => (
                <div key={b.title} className="rounded-2xl bg-well p-3.5 flex gap-3">
                  <span className="w-8 h-8 rounded-xl bg-blue/12 text-blue flex items-center justify-center shrink-0"><b.icon className="w-4 h-4" /></span>
                  <div className="min-w-0">
                    <p className="text-sm font-semibold text-label">{b.title}</p>
                    <p className="mt-0.5 text-xs text-label-2 leading-relaxed">{b.text}</p>
                  </div>
                </div>
              ))}
            </div>
            <div className="grid grid-cols-3 gap-2 text-center">
              {[[String(engineCount), 'engine analyses'], [String(agentCount), 'AI agents'], ['10', 'workflow steps']].map(([n, l]) => (
                <div key={l} className="rounded-2xl border border-separator py-3">
                  <p className="text-xl font-semibold text-label tabular-nums">{n}</p>
                  <p className="text-[11px] text-label-3">{l}</p>
                </div>
              ))}
            </div>
            <p className="flex items-start gap-2 text-xs text-label-3 leading-relaxed">
              <ShieldCheck className="w-3.5 h-3.5 shrink-0 mt-0.5" />
              Results say how they were made: engine statistics are labelled as such, and AI-written summaries are marked as AI.
            </p>
          </section>

          {/* Skills */}
          <section aria-labelledby="about-skills" className="space-y-2.5">
            <h3 id="about-skills" className="section-title flex items-center gap-1.5"><Sparkles className="w-3.5 h-3.5" /> Skills</h3>
            <div className="flex flex-wrap gap-1.5">
              {SKILLS.map(s => <span key={s} className="rounded-full bg-fill px-3 py-1 text-xs font-medium text-label">{s}</span>)}
            </div>
          </section>

          {/* Contact */}
          <section aria-labelledby="about-contact" className="space-y-2.5">
            <h3 id="about-contact" className="section-title">Contact</h3>
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
              {LINKS.map(l => (
                <a key={l.label} href={l.href} target={l.href.startsWith('http') ? '_blank' : undefined} rel="noopener noreferrer"
                  className="rounded-2xl border border-separator hover:bg-fill transition-colors px-3.5 py-3 flex items-center gap-3">
                  <l.icon className="w-5 h-5 text-label shrink-0" />
                  <span className="min-w-0">
                    <span className="block text-sm font-semibold text-label">{l.label}</span>
                    <span className="block text-xs text-label-3 truncate">{l.sub}</span>
                  </span>
                </a>
              ))}
            </div>
          </section>
        </div>
      </motion.div>
    </div>
  );
}
