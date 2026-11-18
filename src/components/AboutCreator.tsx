/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React from 'react';
import { motion } from 'motion/react';
import { ArrowUpRight, Github, Linkedin, Mail, MapPin } from 'lucide-react';
import { CAPABILITIES } from '../engine/client';
import { AGENTS } from '../swarm/agents';

const gh = (repo: string) => `https://github.com/thedeepakreddy/${repo}`;

const SYSTEMS: { name: string; full?: string; text: string; repo: string; live?: string; tag?: string }[] = [
  { name: 'Echo', full: 'Executive Computer Heuristic Operator', tag: 'Flagship', repo: gh('E.C.H.O-Mac'),
    text: 'A local-first autonomous agent runtime for macOS: it sees the screen, acts, talks, verifies each step, recovers and replays. Switches between Claude, Gemini and local Ollama brains. Ecosystem: Echo Phone, Echo Online (Chrome + MCP) and DLLM, a Qwen2.5-VL local brain fine-tuned with GRPO on verified trajectories.' },
  { name: 'SYNTRA', full: 'Synchronized Intelligence for Autonomous Software Engineering', repo: gh('SYNTRA'),
    text: 'Governed multi-agent software engineering: PostgreSQL as the source of truth, hashed handoffs, no agent verifies its own output, and a human delivery gate.' },
  { name: 'Pluto → Mini-Live', repo: gh('Pluto-LLM'),
    text: 'A language model built from scratch in PyTorch, from a 6M-parameter TinyStories model to a 30M speech-and-text model, with a 400M model in preparation.' },
  { name: 'CosmOS', repo: gh('CosmOS'), live: 'https://cosmos-website-8vir.onrender.com',
    text: 'An operating layer for AI work: ToolOS, AgentOS, ResearchOS and EvalOS today; MemoryOS and ModelOS planned.' },
  { name: 'Aira.AI', repo: gh('Aira.AI'), text: 'A full-stack AI workspace for web, macOS and Windows.' },
  { name: 'ATLAS', tag: 'Research', repo: gh('ATLAS-spatial-intelligence'), text: 'Spatial-intelligence research; the architecture is proposed and still being validated.' },
];

const PRODUCTS: { name: string; text: string; href: string }[] = [
  { name: 'Talktual', text: 'Real-time P2P voice translation', href: 'https://talktual.onrender.com/' },
  { name: 'Tata Dransfer', text: 'Encrypted P2P files, calls and chat', href: 'https://tata-dransfer-by-askdeepakai-1.onrender.com/' },
  { name: 'Gita.AI', text: 'Retrieval over all 701 verses, donated to ISKCON', href: gh('Gita.AI') },
  { name: 'HelpIn', text: 'Hyperlocal mutual help in Budapest', href: 'https://helpin-ybt3.onrender.com/welcome' },
  { name: 'Risk Intelligence Analyst', text: 'Automated risk analysis', href: 'https://automated-risk-intelligence-analyst-main.onrender.com' },
  { name: 'Market Intelligence Analyst', text: 'Automated market analysis', href: 'https://market-intelligence-frontend.onrender.com/' },
];

const TOOLKIT: [string, string[]][] = [
  ['Languages', ['Python', 'TypeScript', 'JavaScript', 'SQL', 'Swift', 'Rust']],
  ['Agents', ['Claude Agent SDK', 'Gemini', 'Ollama', 'MCP', 'LangGraph', 'Tool calling', 'Structured outputs', 'Multi-agent orchestration']],
  ['AI / ML', ['PyTorch', 'Transformers', 'Qwen 2.5-VL', 'GRPO', 'scikit-learn', 'XGBoost', 'SHAP', 'Prophet', 'SARIMAX']],
  ['Backend & data', ['FastAPI', 'Node.js', 'PostgreSQL', 'Redis', 'Pandas', 'NumPy', 'WebSockets']],
  ['Apps & systems', ['React', 'Electron', 'Tauri', 'Chrome MV3', 'WebRTC', 'macOS automation', 'Docker', 'Google Cloud', 'Power BI', 'Tableau']],
];

const ROLES = ['AI Software Engineer', 'Agentic AI Engineer', 'Applied AI Engineer', 'Multimodal AI Engineer', 'AI Product Engineer', 'Computer-Use Agent Engineer',
  'LLM / Agent Platform Engineer', 'AI Automation Engineer', 'Research Engineer (Agent Systems)', 'Data Scientist / ML Engineer', 'BI & Decision Science'];

const LINKS = [
  { href: 'mailto:thedeepakreddy1@gmail.com', label: 'Email', sub: 'thedeepakreddy1@gmail.com', icon: Mail },
  { href: 'https://www.linkedin.com/in/deepak-reddy-038582223/', label: 'LinkedIn', sub: 'Deepak Reddy', icon: Linkedin },
  { href: 'https://github.com/thedeepakreddy?tab=repositories', label: 'GitHub', sub: 'thedeepakreddy', icon: Github },
];

const Section = ({ id, title, children, aside }: { id: string; title: string; children: React.ReactNode; aside?: React.ReactNode }) => (
  <section aria-labelledby={id} className="space-y-3">
    <div className="flex flex-wrap items-baseline justify-between gap-2">
      <h3 id={id} className="section-title">{title}</h3>
      {aside}
    </div>
    {children}
  </section>
);

/** The creator and their work, as a sheet. */
export default function AboutCreator({ onClose }: { onClose: () => void }) {
  const engineCount = Object.keys(CAPABILITIES).length;
  const agentCount = Object.keys(AGENTS).length;

  return (
    <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center sm:p-4">
      <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={{ duration: 0.2 }} onClick={onClose} className="absolute inset-0 bg-[var(--scrim)]" />
      <motion.div
        role="dialog" aria-modal="true" aria-labelledby="about-title"
        initial={{ opacity: 0, y: 24, scale: 0.98 }} animate={{ opacity: 1, y: 0, scale: 1 }} exit={{ opacity: 0, y: 24, scale: 0.98 }}
        transition={{ duration: 0.3, ease: [0.28, 0.11, 0.32, 1] }}
        className="relative z-10 w-full sm:max-w-3xl bg-raised rounded-t-3xl sm:rounded-3xl shadow-xl max-h-[94vh] overflow-y-auto"
      >
        {/* Header */}
        <div className="px-6 sm:px-8 pt-6 pb-6 bg-gradient-to-b from-blue/10 to-transparent rounded-t-3xl">
          <div className="flex justify-end -mr-2">
            <button type="button" onClick={onClose} className="btn btn-plain font-semibold" autoFocus>Done</button>
          </div>
          <div className="flex flex-col sm:flex-row items-center sm:items-end gap-4 sm:gap-5 text-center sm:text-left">
            <div className="w-24 h-24 rounded-3xl bg-blue flex items-center justify-center shadow-lg shrink-0">
              <span className="text-white text-[34px] font-semibold tracking-tight">DR</span>
            </div>
            <div className="min-w-0">
              <h2 id="about-title" className="text-[26px] sm:text-[30px] font-semibold tracking-tight text-label leading-tight">Gorisi Deepak Reddy</h2>
              <p className="mt-1 text-[15px] text-label-2">Forward Deployed AI Engineer</p>
              <div className="mt-2 flex flex-wrap justify-center sm:justify-start items-center gap-2 text-xs">
                <span className="inline-flex items-center gap-1 text-label-3"><MapPin className="w-3.5 h-3.5" /> Budapest, Hungary</span>
                <span className="inline-flex items-center gap-1.5 rounded-full bg-green/12 text-green px-2.5 py-0.5 font-medium">
                  <span className="w-1.5 h-1.5 rounded-full bg-green" /> Open to roles
                </span>
              </div>
            </div>
          </div>
          <p className="mt-5 text-[19px] sm:text-[21px] font-semibold tracking-tight text-label text-center sm:text-left">I build AI systems that act, then prove they did.</p>
        </div>

        <div className="px-6 sm:px-8 pb-8 space-y-8">
          <Section id="about-me" title="Principle">
            <p className="text-[15px] text-label leading-relaxed">
              The model interprets intent, retrieves evidence and picks tools. Everything after is deterministic: systems compute,
              typed tools enforce boundaries, safety policy gates actions, and verification decides success.
            </p>
            <p className="text-sm text-label-2 leading-relaxed">
              BTech in Computer Science Engineering and MSc in Business Data Analytics. I care about the full path from problem framing to deployment and adoption.
            </p>
          </Section>

          <Section id="about-systems" title="Systems">
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5">
              {SYSTEMS.map(s => (
                <a key={s.name} href={s.live ?? s.repo} target="_blank" rel="noopener noreferrer"
                  className={`group rounded-2xl p-4 transition-colors ${s.tag === 'Flagship' ? 'sm:col-span-2 bg-blue/8 hover:bg-blue/12' : 'bg-well hover:bg-fill'}`}>
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <p className="text-sm font-semibold text-label flex flex-wrap items-center gap-2">
                        {s.name}
                        {s.tag && <span className={`rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide ${s.tag === 'Flagship' ? 'bg-blue text-white' : 'bg-fill text-label-2'}`}>{s.tag}</span>}
                      </p>
                      {s.full && <p className="text-[11px] text-label-3">{s.full}</p>}
                    </div>
                    <ArrowUpRight className="w-4 h-4 text-label-3 group-hover:text-blue shrink-0" />
                  </div>
                  <p className="mt-1.5 text-xs text-label-2 leading-relaxed">{s.text}</p>
                </a>
              ))}
            </div>
          </Section>

          <Section id="about-studio" title="This studio" aside={<span className="text-xs text-label-3">{engineCount} engine analyses · {agentCount} agents</span>}>
            <p className="text-sm text-label-2 leading-relaxed">
              The same principle applied to data science: a Python engine computes every number (scikit-learn, XGBoost, statsmodels and more),
              agents work through the studio in plain view with every change undoable, and Gemini only writes the narration.
            </p>
          </Section>

          <Section id="about-products" title="More products">
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-1.5">
              {PRODUCTS.map(p => (
                <a key={p.name} href={p.href} target="_blank" rel="noopener noreferrer" className="group flex items-center justify-between gap-3 rounded-xl px-3 py-2 hover:bg-fill">
                  <span className="min-w-0">
                    <span className="block text-sm font-medium text-label">{p.name}</span>
                    <span className="block text-xs text-label-3 truncate">{p.text}</span>
                  </span>
                  <ArrowUpRight className="w-3.5 h-3.5 text-label-3 group-hover:text-blue shrink-0" />
                </a>
              ))}
            </div>
          </Section>

          <Section id="about-toolkit" title="Toolkit">
            <div className="space-y-2.5">
              {TOOLKIT.map(([group, items]) => (
                <div key={group} className="flex flex-col sm:flex-row sm:items-baseline gap-1.5 sm:gap-3">
                  <span className="text-xs font-medium text-label-3 sm:w-28 shrink-0">{group}</span>
                  <div className="flex flex-wrap gap-1.5">{items.map(x => <span key={x} className="rounded-full bg-fill px-2.5 py-0.5 text-xs text-label">{x}</span>)}</div>
                </div>
              ))}
            </div>
          </Section>

          <Section id="about-roles" title="Roles I'm focusing on">
            <p className="inline-flex rounded-full bg-blue text-white px-3 py-1 text-sm font-medium">Forward Deployed AI Engineer</p>
            <div className="flex flex-wrap gap-1.5">{ROLES.map(r => <span key={r} className="rounded-full border border-separator px-2.5 py-0.5 text-xs text-label-2">{r}</span>)}</div>
          </Section>

          <Section id="about-contact" title="Building agents that have to be right? Let's connect.">
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
          </Section>
        </div>
      </motion.div>
    </div>
  );
}
