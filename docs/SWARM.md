# Agent swarm — implementation notes

Based on *Multi-Agent Swarm Architecture & Implementation Blueprint*. Delivered in two pull requests.

## Decisions for this repository

| Topic | Decision |
|---|---|
| Where the swarm runs | In the browser. Free Render hosting has no durable disk, so runs, tasks, messages and the plan cache are saved in IndexedDB (like the rest of the studio). Servers stay stateless: the Node server handles AI planning; the Python service does calculations. Moving to server storage later keeps the same runtime. |
| Cursors | On the user’s own page (user decision; the blueprint suggested separate workspaces). Agents take turns on a step, pause when the user acts, and every cursor maps to a real event. **PR 2.** |
| AI calls | Rules first, then a verified cached plan, then one AI call. Specialists never call AI for having a role. |
| Gaps in the PDF | The addendum starts at 18.3; sections 17–18.2 were not in the file. |

## PR 1 — engine

- `src/swarm/catalog.ts`: capability catalog — each studio action with its studio, usual specialist, approval class (autonomous / batch / separate / prohibited), side effect, backend flag, idempotency, timeout, input check and self-check. Data capabilities wrap the existing operation registry; statistics, regression, training and forecasting call the same API routes as the UI.
- `src/swarm/agents.ts`: the specialist roles (expertise, not permissions).
- `src/swarm/plan.ts`: task contracts, plan validation (known capabilities, valid inputs, existing and acyclic dependencies, size limits) and a rule planner for common requests.
- `src/swarm/gateway.ts` + `POST /api/swarm/plan`: rules → cache → one Gemini call (token usage recorded). Plans are validated in the browser whatever produced them; only valid plans are cached.
- `src/swarm/runtime.ts`: durable runtime — task lifecycle (pending, awaiting approval, running, verifying, completed, failed, blocked, cancelled), dependency scheduling, one data change at a time, up to 2 backend jobs in parallel, timeouts, retries with backoff for temporary failures, pause/resume/cancel for the run and for single tasks (requested vs confirmed cancellation), bounded dynamic tasks (the Data Quality Agent’s fixes, up to 8, which need approval), recovery after reload that never repeats an applied change, message bus (assignment, finding, handoff, approval request, failure, recovery), telemetry (AI calls, tokens, cache hits, studio operations, retries, failures) and a completion report built only from results and self-checks.
- Agents panel (toolbar → Agents): request, plan, approval, live task status, team messages, report, Undo All. (PR 2 moves requests to the Ask AI chat.)

## PR 2 — what you see

**Talk to the orchestrator in Ask AI.** The floating Ask AI chat is now the
orchestrator. Every message goes through the swarm planner: commands (“drop
the X column”, “fill missing values with median”, “open the dashboard”, a
SELECT, “reset the data”) and analyses are planned by rules with no AI call;
anything else goes to one AI call, which either plans tasks or answers the
question from the data’s facts and the conversation. Without AI, simple
questions (row count, columns, missing values, a column’s average, median,
min, max or most common values) are answered from the column profile. SQL
mode runs `sql.query` (results shown as a table); Code mode runs
`data.custom_code` in the sandbox and always needs its own approval. Each
request gets a run card in the chat: the plan, live steps coloured by agent,
Approve / Pause / Resume / Stop, the report (reviews, contradictions,
incidents) and Undo All. Details opens the Agents panel. The old command
system (`src/agent/tools.ts`, `/api/chat-bot`) is removed.

**Agents work on your page.** Agents operate the studio’s real controls —
they open the step, choose options, type and click buttons marked with
`data-agent="…"` (`src/swarm/interaction.ts`, `src/swarm/uiScripts.ts`).
Every action emits an event (agent, task, run, pointer), which
`AgentCursorLayer` draws with two cursors per running task, both from the
same agent:
- the **partner** (a lighter twin with a small name tag) flies to the spot,
  presses at the top-left corner and drags a selection box open to the
  bottom-right, round the area being worked on and round every control the
  agent reaches, chooses, types into or clicks; it then holds the box open
  until the worker has finished there, and lets go only when the agent moves
  on to another control, starts waiting for a result, or finishes;
- the **worker** sets off as the drag starts, arrives as the box finishes
  opening, and does the real action inside it (labelled with the action),
  with a ripple on clicks.

The agent waits for this before acting (`interactions.addGate`), so what you
see is the order things really happen; the wait is capped at 2 s so drawing
can never stall an agent. The flight and the drag follow the live corners
while the page is still scrolling, so the drawing adds no waiting of its own. Each step is paced
(900 ms per move) so a person can follow the agents as they work.
Results
come from the studio’s own logged runs and data versions, never from the
animation. One agent holds the page at a time and releases it while it waits
for a result. A real click or key press anywhere outside the agents’ own UI
pauses the team (“Agents paused — you’re in control”, Resume / Stop).
Page-only actions (dashboard KPIs, saving a dashboard, quality rules,
workflows, PDF and package export, registering a model, predicting) are done
through the page; everything else falls back to the same operation run
directly.

**Independent review** (`src/swarm/review.ts`). Risky results get a review
task by the Verification Agent using a different method: a seeded 999-shuffle
permutation test for a statistical test, the validation gate (baseline,
leakage, ID columns, stability) for a model, and a recount for large row
removals. Disagreement is a contradiction in the report, never hidden.
Reviews are marked “independent”; everything else is a “self-check”.

**Self-healing** (`src/swarm/recovery.ts`). A failure after retries opens an
incident with a fingerprint. Known causes get one safe repair: wake the ML
service, run the operation directly instead of through the page, or one more
try with twice the time. The task re-runs to validate the repair; the
incident closes only if it succeeds. Unknown failures, failed repairs and
anything past the limits (1 repair per task, 3 per run) are escalated to the
user. No AI calls.

**Welcome swarm** (`src/components/WelcomeSwarm.tsx`). Every time the studio
opens, after the loading screen, about fourteen seconds:
1. The swarm streams in from every edge on curved paths, with short fading trails.
2. The Orchestrator types "Welcome to", while three agents drag selection
   boxes over "Data", "Science" and "Studio", revealing each word.
3. Nine agents each drag out a box that lands as a card.
4. A line draws to the floating Ask AI button, and the swarm flies into it.

It uses 15 cursors on desktop, 12 on tablets and 10 on phones; on short
screens the cards bow out so the closing words clear the button. A dim ×
with a ring showing the time left, Esc, or a tap skips it; with reduced
motion it is a still card. The type is Source Serif 4, Medium-style editorial
type. It touches nothing on the page.

**Cursor motion and look** (`src/swarm/humanMotion.ts`,
`src/components/AgentCursor.tsx`). Cursors move like a hand:
- curved paths,
- a bell-shaped speed curve (minimum jerk),
- a slight overshoot that settles on long moves,
- a faint tremor,
- duration that grows with distance (Fitts's law).

The cursor is a rounded arrow with a soft sheen, a white rim and a shadow,
with a name tag tucked under it. Agent colours are rich, muted tones
(`--agent-*` in `index.css`, slightly lifted in dark mode).

**Agents panel** is the detail view: task map (levels of the dependency
graph), each task’s check and whether it used the page, reviews, incidents,
team messages, telemetry and recent runs.

### Adding a feature (so agents can use it)

1. Register a capability in `src/swarm/catalog.ts` (id, studio, role,
   approval class, side effect, input check, `run` and self-check). If it can
   only be done on the page, set `uiOnly`.
2. Tag its controls with `data-agent="…"` and add a UI script in
   `src/swarm/uiScripts.ts` that opens the step, fills the controls and
   reads the result from the logged run or new data version.
3. If agents should not do it, add it to `NOT_FOR_AGENTS` with the reason.

`src/swarm/coverage.test.ts` fails when a UI script targets a control that
isn’t on the page, a capability has no way to run, or a feature component
(one that changes data or logs a run) has no `data-agent` controls and isn’t
listed in `FEATURES_WITHOUT_PAGE`.

### Acceptance tests

`src/swarm/acceptance.test.ts` runs A01–A25 against the real swarm code with
a fake studio. A17 changed at the user’s request (agents work on the user’s
own page rather than separate workspaces); A17 and A18 are about what the
user sees and were checked in the browser: a full request (quality check →
three approved fixes → test → model → report) ran with each agent’s pointer
on the page, two independent reviews, 0 AI calls, and Undo All; a click on
the page paused the team and Resume finished it; SQL and Code modes worked
from the chat.

## v3 — a bigger, smarter team

See [`AGENTS_PLAN.md`](AGENTS_PLAN.md) for the full plan and the reasons behind it.

- **23 agents,** each with a skill sheet (`src/swarm/skills.ts`).
- **New capabilities:** deep analysis, the drivers screen (Holm), segments, explanation, tuning, dashboard design and filters, sample datasets, group/pivot.
- **The Dashboard Designer** designs from the user's words and the data (`src/swarm/dashboardDesign.ts`).
- **A full analysis** runs through every step.
- **The Orchestrator** reviews each run and redoes what went wrong (`src/swarm/orchestratorReview.ts`).
