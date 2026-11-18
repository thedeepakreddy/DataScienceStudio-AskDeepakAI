"""AskDeepakAI data science engine, version 2.

A capability-based engine: every analysis is a registered, typed function
(`engine.registry`) that runs on an uploaded dataset (stored as Parquet and
queried with DuckDB), either straight away or as a background job, and every
result carries a reproducibility manifest. See docs/ENGINE_PLAN.md.
"""

ENGINE_VERSION = "2.0.0"
