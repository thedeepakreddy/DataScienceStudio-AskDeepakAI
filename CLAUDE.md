# Working on this repository

- **Keep README.md current.** Whenever a pull request adds a major feature or changes how something works (a new step, analysis, agent behaviour, export, AI behaviour, deployment), update `README.md` in the same pull request, and say in the PR description what changed there.
- Engine capabilities: after changing `mlops_service/engine/capabilities/*`, regenerate the contract and docs with `python mlops_service/scripts/gen_contract.py` (CI runs it with `--check`).
- Every feature that changes data or produces a result must be usable by the agents (`src/swarm/coverage.test.ts`) and have a place in the studio (`src/engine/featureCoverage.test.ts`).
- Numbers come from real engines only; AI writes words, plans and code, never metrics.
