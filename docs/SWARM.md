# Agent swarm — implementation notes

Based on *Multi-Agent Swarm Architecture & Implementation Blueprint*. Delivered in two pull requests.

## Decisions for this repository

| Topic | Decision |
|---|---|
| Where the swarm runs | In the browser. Free Render hosting has no durable disk, so runs, tasks, messages and the plan cache are saved in IndexedDB (like the rest of the studio). Servers stay stateless: the Node server handles AI planning; the Python service does calculations. Moving to server storage later keeps the same runtime. |
| Cursors | On the user’s own page (user decision; the blueprint suggested separate workspaces). Agents take turns on a step, pause when the user acts, and every cursor maps to a real event. **PR 2.** |
| AI calls | Rules first, then a verified cached plan, then one AI call. Specialists never call AI for having a role. |
| Gaps in the PDF | The addendum starts at 18.3; sections 17–18.2 were not in the file. |

## PR 1 — engine (this PR)

- `src/swarm/catalog.ts`: capability catalog — each studio action with its studio, usual specialist, approval class (autonomous / batch / separate / prohibited), side effect, backend flag, idempotency, timeout, input check and self-check. Data capabilities wrap the existing operation registry; statistics, regression, training and forecasting call the same API routes as the UI.
- `src/swarm/agents.ts`: the specialist roles (expertise, not permissions).
- `src/swarm/plan.ts`: task contracts, plan validation (known capabilities, valid inputs, existing and acyclic dependencies, size limits) and a rule planner for common requests.
- `src/swarm/gateway.ts` + `POST /api/swarm/plan`: rules → cache → one Gemini call (token usage recorded). Plans are validated in the browser whatever produced them; only valid plans are cached.
- `src/swarm/runtime.ts`: durable runtime — task lifecycle (pending, awaiting approval, running, verifying, completed, failed, blocked, cancelled), dependency scheduling, one data change at a time, up to 2 backend jobs in parallel, timeouts, retries with backoff for temporary failures, pause/resume/cancel for the run and for single tasks (requested vs confirmed cancellation), bounded dynamic tasks (the Data Quality Agent’s fixes, up to 8, which need approval), recovery after reload that never repeats an applied change, message bus (assignment, finding, handoff, approval request, failure, recovery), telemetry (AI calls, tokens, cache hits, studio operations, retries, failures) and a completion report built only from results and self-checks.
- Agents panel (toolbar → Agents): request, plan, approval, live task status, team messages, report, Undo All.

## PR 2 — what you see (next)

Multi-cursor agents acting on the user’s page with selection boxes, the activity panel and task map, user-takeover pause, the approval centre, the independent Verification Agent, the self-healing recovery service, and the blueprint’s acceptance tests.
