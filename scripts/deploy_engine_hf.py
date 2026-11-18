"""Deploys the engine to a free Hugging Face Docker Space (2 vCPU, 16 GB, no card needed).

    HF_TOKEN=<write token> python scripts/deploy_engine_hf.py [--space askdeepakai-engine]

What it does:
- creates (or reuses) the public Docker Space <user>/<space>;
- sets the Space secret ENGINE_TOKEN: taken from the ENGINE_TOKEN environment
  variable, or generated and written to .engine-token (chmod 600, git-ignored),
  never printed;
- uploads mlops_service/ plus a Space README, mirroring the Space to it;
- waits until the Space is running and checks /health, and that /v2 refuses
  requests without the token.

The engine URL is https://<user>-<space>.hf.space. Free Spaces sleep after two
days without traffic and wake on the next request; their disk is not
persistent, so datasets and models saved in the engine last until a restart
(the studio keeps its own work in the browser).
"""
from __future__ import annotations

import argparse
import os
import secrets
import shutil
import sys
import tempfile
import time
import urllib.error
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SERVICE = ROOT / "mlops_service"
FILES = ["Dockerfile", "requirements.txt", "main.py", "stats_engine.py", "model_extras.py", "forecasting.py", "monitoring.py"]

README = """---
title: AskDeepakAI Engine
emoji: 📊
colorFrom: indigo
colorTo: purple
sdk: docker
app_port: 8000
pinned: false
short_description: Data science engine behind the AskDeepakAI studio
---

# AskDeepakAI Engine

The compute engine behind [AskDeepakAI Data Science Studio](https://github.com/{repo}):
statistics, causal inference, experiments, AutoML, forecasting, clustering,
optimisation, MLOps and pretrained text models, as a JSON API.

Every endpoint except `/` and `/health` needs the studio's secret token, so
this Space is only usable through the studio.
"""


def check(url: str, token: str | None = None) -> int:
    req = urllib.request.Request(url, headers={"X-Engine-Token": token} if token else {})
    try:
        with urllib.request.urlopen(req, timeout=60) as r:
            return r.status
    except urllib.error.HTTPError as e:
        return e.code


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--space", default="askdeepakai-engine")
    ap.add_argument("--repo", default="thedeepakreddy/DataScienceStudio-AskDeepakAI")
    ap.add_argument("--no-wait", action="store_true")
    args = ap.parse_args()

    from huggingface_hub import HfApi

    api = HfApi(token=os.environ.get("HF_TOKEN"))
    user = api.whoami()["name"]
    repo_id = f"{user}/{args.space}"
    host = f"https://{user}-{args.space}.hf.space".lower().replace("_", "-")

    token = os.environ.get("ENGINE_TOKEN")
    if not token:
        path = ROOT / ".engine-token"
        if path.exists():
            token = path.read_text().strip()
        else:
            token = secrets.token_hex(32)
            path.write_text(token)
            path.chmod(0o600)
            print(f"Generated a new engine token in {path.name} (not shown).")

    print(f"Space {repo_id} → {host}")
    api.create_repo(repo_id, repo_type="space", space_sdk="docker", exist_ok=True, private=False)
    api.add_space_secret(repo_id, "ENGINE_TOKEN", token)
    for key, value in {"ENGINE_LOG_FORMAT": "json", "ENGINE_JOB_WORKERS": "2"}.items():
        api.add_space_variable(repo_id, key, value)

    with tempfile.TemporaryDirectory() as tmp:
        stage = Path(tmp)
        for f in FILES:
            shutil.copy2(SERVICE / f, stage / f)
        shutil.copytree(SERVICE / "engine", stage / "engine", ignore=shutil.ignore_patterns("__pycache__", "*.pyc"))
        (stage / "README.md").write_text(README.replace("{repo}", args.repo))
        commit = api.upload_folder(repo_id=repo_id, repo_type="space", folder_path=str(stage), delete_patterns="*",
                                   commit_message="Deploy the engine from the studio repository")
        print("Uploaded:", getattr(commit, "commit_url", commit))

    if args.no_wait:
        return 0
    print("Building (the first build takes about 10 minutes)…")
    last = None
    deadline = time.time() + 45 * 60
    while time.time() < deadline:
        stage_now = api.get_space_runtime(repo_id).stage
        if stage_now != last:
            print(" ", stage_now)
            last = stage_now
        if stage_now == "RUNNING":
            break
        if stage_now in ("BUILD_ERROR", "RUNTIME_ERROR", "CONFIG_ERROR", "NO_APP_FILE"):
            print(f"The Space failed ({stage_now}); see its logs at https://huggingface.co/spaces/{repo_id}?logs=build")
            return 1
        time.sleep(15)
    else:
        print("Timed out waiting for the Space.")
        return 1
    for _ in range(20):
        if check(f"{host}/health") == 200:
            break
        time.sleep(6)
    health, guarded, info = check(f"{host}/health"), check(f"{host}/v2/info"), check(f"{host}/v2/info", token)
    print(f"health {health} · /v2 without token {guarded} · with token {info}")
    ok = health == 200 and guarded == 401 and info == 200
    print("Engine is live ✓" if ok else "Something's off; check the Space logs.")
    print(f"Set on Render: ML_SERVICE_URL={host} and ENGINE_TOKEN=(the value in .engine-token)")
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
