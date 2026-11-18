"""The front end's generated contract (src/engine/contract.generated.ts) must match the engine."""
import subprocess
import sys
from pathlib import Path

SCRIPT = Path(__file__).resolve().parent.parent / "scripts" / "gen_contract.py"


def test_generated_contract_is_up_to_date():
    r = subprocess.run([sys.executable, str(SCRIPT), "--check"], capture_output=True, text=True, env={"ENGINE_SCHEDULER": "0", "PATH": ""})
    assert r.returncode == 0, r.stdout + r.stderr


def test_every_capability_and_route_is_in_the_contract():
    import main
    from engine.registry import REGISTRY

    ts = (SCRIPT.parent.parent.parent / "src" / "engine" / "contract.generated.ts").read_text()
    for name in REGISTRY:
        if name != "test.echo":
            assert f'"{name}"' in ts, name
    for path, ops in main.app.openapi()["paths"].items():
        if path.startswith("/v2"):
            for m in ops:
                assert f'"{m.upper()} {path}"' in ts, (m, path)
