"""Generates the front end's view of the engine from the engine itself:

- src/engine/contract.generated.ts: a TypeScript type for every capability's
  parameters, the capability catalogue, and every /v2 route;
- docs/ENGINE_CAPABILITIES.md: the same catalogue for people.

Run `python scripts/gen_contract.py` after changing a capability or route;
`--check` exits non-zero if the committed files are out of date (CI runs it
through tests/test_v2_contract.py).
"""
from __future__ import annotations

import hashlib
import json
import os
import re
import sys
from pathlib import Path
from typing import Any

HERE = Path(__file__).resolve().parent
SERVICE = HERE.parent
ROOT = SERVICE.parent
TS_OUT = ROOT / "src" / "engine" / "contract.generated.ts"
MD_OUT = ROOT / "docs" / "ENGINE_CAPABILITIES.md"
sys.path.insert(0, str(SERVICE))
os.environ.setdefault("ENGINE_SCHEDULER", "0")

HIDDEN = {"test.echo"}


def pascal(name: str) -> str:
    return "".join(p[:1].upper() + p[1:] for p in re.split(r"[^A-Za-z0-9]+", name) if p)


def lit(v: Any) -> str:
    return json.dumps(v, ensure_ascii=False)


class TsWriter:
    def __init__(self, prefix: str, defs: dict[str, Any]) -> None:
        self.prefix, self.defs, self.emitted, self.out = prefix, defs, set(), []

    def ref_name(self, ref: str) -> str:
        return self.prefix + pascal(ref.rsplit("/", 1)[-1])

    def type_of(self, s: dict[str, Any]) -> str:
        if "$ref" in s:
            name = ref = s["$ref"]
            name = self.ref_name(ref)
            if name not in self.emitted:
                self.emitted.add(name)
                self.interface(name, self.defs[ref.rsplit("/", 1)[-1]])
            return name
        for key in ("anyOf", "oneOf"):
            if key in s:
                parts = list(dict.fromkeys(self.type_of(x) for x in s[key]))
                return " | ".join(parts)
        if "const" in s:
            return lit(s["const"])
        if "enum" in s:
            return " | ".join(lit(v) for v in s["enum"])
        t = s.get("type")
        if isinstance(t, list):
            return " | ".join(self.type_of({**s, "type": x}) for x in t)
        if t == "string":
            return "string"
        if t in ("integer", "number"):
            return "number"
        if t == "boolean":
            return "boolean"
        if t == "null":
            return "null"
        if t == "array":
            inner = self.type_of(s.get("items", {}))
            return f"Array<{inner}>"
        if t == "object":
            if s.get("properties"):
                return "{ " + "; ".join(f"{lit(k)}{'' if k in s.get('required', []) else '?'}: {self.type_of(v)}" for k, v in s["properties"].items()) + " }"
            ap = s.get("additionalProperties")
            return f"Record<string, {self.type_of(ap) if isinstance(ap, dict) and ap else 'unknown'}>"
        return "unknown"

    def interface(self, name: str, schema: dict[str, Any], doc: str | None = None) -> None:
        lines = []
        if doc:
            lines.append(f"/** {doc} */")
        lines.append(f"export interface {name} {{")
        req = set(schema.get("required", []))
        for prop, ps in (schema.get("properties") or {}).items():
            notes = [ps["description"]] if ps.get("description") else []
            if "default" in ps:
                notes.append(f"Default: {json.dumps(ps['default'], ensure_ascii=False)}.")
            bounds = [f"{k} {ps[k]}" for k in ("minimum", "maximum", "exclusiveMinimum", "exclusiveMaximum", "minLength", "maxLength", "minItems", "maxItems") if k in ps]
            if bounds:
                notes.append("(" + ", ".join(bounds) + ")")
            if notes:
                lines.append(f"  /** {' '.join(notes).replace('*/', '* /')} */")
            lines.append(f"  {lit(prop) if not prop.isidentifier() else prop}{'' if prop in req else '?'}: {self.type_of(ps)};")
        lines.append("}")
        self.out.append("\n".join(lines))


def build() -> tuple[str, str]:
    import main
    from engine import ENGINE_VERSION
    from engine.registry import REGISTRY

    caps = [c for name, c in sorted(REGISTRY.items()) if name not in HIDDEN]
    blocks, catalogue, param_map = [], [], []
    for c in caps:
        schema = c.params.model_json_schema()
        w = TsWriter(pascal(c.name), schema.get("$defs", {}))
        name = pascal(c.name) + "Params"
        w.interface(name, schema, f"Parameters of `{c.name}` — {c.title}.")
        blocks.extend(w.out[1:] + w.out[:1])  # nested types first, then the params
        param_map.append(f"  {lit(c.name)}: {name};")
        catalogue.append({"name": c.name, "area": c.area, "title": c.title, "summary": c.summary, "needsDataset": c.needs_dataset,
                          "heavy": c.heavy, "cacheable": c.cacheable, "tags": c.tags})
    spec = main.app.openapi()
    routes = sorted({(m.upper(), path) for path, ops in spec["paths"].items() if path.startswith("/v2") for m in ops}, key=lambda x: (x[1], x[0]))
    areas = sorted({c.area for c in caps})
    body = "\n\n".join([
        f"export const ENGINE_VERSION = {lit(ENGINE_VERSION)};",
        "export type CapabilityName =\n" + "\n".join(f"  | {lit(c.name)}" for c in caps) + ";",
        "export type CapabilityArea = " + " | ".join(lit(a) for a in areas) + ";",
        *blocks,
        "/** The parameters each capability takes. */\nexport interface CapabilityParams {\n" + "\n".join(param_map) + "\n}",
        "export interface CapabilityInfo {\n  name: CapabilityName;\n  area: CapabilityArea;\n  title: string;\n  summary: string;\n"
        "  needsDataset: boolean;\n  heavy: boolean;\n  cacheable: boolean;\n  tags: string[];\n}",
        "export const CAPABILITIES: Record<CapabilityName, CapabilityInfo> = " + json.dumps({c["name"]: c for c in catalogue}, indent=2, ensure_ascii=False) + ";",
        "/** Every engine route (method, path); the client must cover each one (see client.test.ts). */\n"
        "export const ENGINE_ROUTES = " + json.dumps([f"{m} {p}" for m, p in routes], indent=2) + " as const;\n"
        "export type EngineRoute = (typeof ENGINE_ROUTES)[number];",
    ])
    digest = hashlib.sha256(body.encode()).hexdigest()[:16]
    ts = ("// GENERATED by mlops_service/scripts/gen_contract.py from the engine itself. Do not edit by hand:\n"
          "// change the engine, then run `python mlops_service/scripts/gen_contract.py`.\n"
          "/* eslint-disable */\n\n"
          f"export const CONTRACT_HASH = {lit(digest)};\n\n" + body + "\n")
    md = ["# Engine capabilities", "",
          f"Generated from engine {ENGINE_VERSION} by `mlops_service/scripts/gen_contract.py`; do not edit by hand.",
          f"{len(caps)} capabilities. Run one with `POST /v2/run/{{name}}` (through the studio: `POST /api/engine/run/{{name}}`), "
          "or from the front end with `engine.run(name, params)` in `src/engine/client.ts`.", ""]
    for area in areas:
        md += [f"## {area}", ""]
        for c in [c for c in caps if c.area == area]:
            schema = c.params.model_json_schema()
            md += [f"### `{c.name}` — {c.title}", "", c.summary, "",
                   f"Dataset: {'required' if c.needs_dataset else 'not needed'} · {'long-running (job by default)' if c.heavy else 'quick'}"
                   f"{' · not cached' if not c.cacheable else ''}", "", "| Parameter | Type | Required | Default | Description |", "|---|---|---|---|---|"]
            w = TsWriter("", schema.get("$defs", {}))
            for prop, ps in (schema.get("properties") or {}).items():
                t = w.type_of(ps).replace("|", "\\|")
                default = json.dumps(ps["default"], ensure_ascii=False) if "default" in ps else ""
                md.append(f"| `{prop}` | `{t}` | {'yes' if prop in schema.get('required', []) else ''} | {default.replace('|', chr(92) + '|')} | "
                          f"{(ps.get('description') or '').replace('|', chr(92) + '|')} |")
            md.append("")
    return ts, "\n".join(md)


def main_() -> int:
    ts, md = build()
    if "--check" in sys.argv:
        stale = [p for p, txt in ((TS_OUT, ts), (MD_OUT, md)) if not p.exists() or p.read_text() != txt]
        if stale:
            print("Out of date (run python mlops_service/scripts/gen_contract.py):", *map(str, stale))
            return 1
        return 0
    TS_OUT.parent.mkdir(parents=True, exist_ok=True)
    TS_OUT.write_text(ts)
    MD_OUT.write_text(md)
    print("wrote", TS_OUT.relative_to(ROOT), "and", MD_OUT.relative_to(ROOT))
    return 0


if __name__ == "__main__":
    raise SystemExit(main_())
