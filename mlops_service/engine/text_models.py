"""Pretrained transformer text models, run on CPU with ONNX Runtime (no PyTorch).

Every model is pinned to an exact Hugging Face commit, so results are
reproducible. The Docker image downloads them at build time
(`python -m engine.text_models --download`) and runs offline; elsewhere a
model is downloaded on first use into ENGINE_MODEL_DIR.
"""
from __future__ import annotations

import json
import os
import shutil
import threading
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

import numpy as np

from .core import EngineError


@dataclass(frozen=True)
class TextModel:
    key: str
    task: str  # embedding | sentiment | zero_shot | entities
    repo: str
    revision: str
    file: str
    title: str
    license: str
    source: str
    languages: str
    max_length: int = 256
    dims: int | None = None
    attribution: str | None = None
    notes: list[str] = field(default_factory=list)


MODELS: dict[str, TextModel] = {m.key: m for m in [
    TextModel("minilm-en", "embedding", "sentence-transformers/all-MiniLM-L6-v2", "1110a243fdf4706b3f48f1d95db1a4f5529b4d41", "onnx/model.onnx",
              "MiniLM-L6 sentence embeddings (English)", "Apache-2.0", "sentence-transformers/all-MiniLM-L6-v2", "English", 256, 384),
    TextModel("minilm-multilingual", "embedding", "sentence-transformers/paraphrase-multilingual-MiniLM-L12-v2", "e8f8c211226b894fcb81acc59f3b34ba3efd5f42",
              "onnx/model_quint8_avx2.onnx", "Multilingual MiniLM-L12 sentence embeddings (50+ languages, int8)", "Apache-2.0",
              "sentence-transformers/paraphrase-multilingual-MiniLM-L12-v2", "50+ languages", 128, 384),
    TextModel("roberta-sentiment", "sentiment", "Xenova/twitter-roberta-base-sentiment-latest", "f3ec4d0925f90c3ca7ee7814f52d6ee7cf180445",
              "onnx/model_quantized.onnx", "RoBERTa sentiment: negative / neutral / positive (English, int8)", "CC-BY-4.0",
              "cardiffnlp/twitter-roberta-base-sentiment-latest", "English", 256,
              attribution="Loureiro et al. (2022), TimeLMs: Diachronic Language Models from Twitter. Model by Cardiff NLP, CC BY 4.0."),
    TextModel("deberta-nli", "zero_shot", "Xenova/nli-deberta-v3-xsmall", "2a4f614a701367a02d51389039afc998faeda637", "onnx/model_quantized.onnx",
              "DeBERTa-v3 natural-language inference for zero-shot labels (English, int8)", "Apache-2.0", "cross-encoder/nli-deberta-v3-xsmall",
              "English", 256),
    TextModel("bert-ner", "entities", "Xenova/bert-base-NER", "8e892123e8b7c2c0c2bd1dcb598b7d244c4e53aa", "onnx/model_quantized.onnx",
              "BERT named entities: people, organisations, locations, misc (English, int8)", "MIT", "dslim/bert-base-NER", "English", 256),
]}

DEFAULTS = {"embedding": "minilm-en", "sentiment": "roberta-sentiment", "zero_shot": "deberta-nli", "entities": "bert-ner"}


def model_dir() -> Path:
    return Path(os.environ.get("ENGINE_MODEL_DIR") or Path.home() / ".cache" / "askdeepakai-models")


def local_path(m: TextModel) -> Path:
    return model_dir() / m.key


def downloaded(m: TextModel) -> bool:
    p = local_path(m)
    return all((p / f).exists() for f in (m.file, "tokenizer.json", "config.json"))


def download(m: TextModel) -> Path:
    if downloaded(m):
        return local_path(m)
    if os.environ.get("HF_HUB_OFFLINE") == "1":
        raise EngineError(f"The text model “{m.key}” isn't installed on this engine (offline mode).", 503, "model_unavailable")
    from huggingface_hub import hf_hub_download

    dest = local_path(m)
    dest.mkdir(parents=True, exist_ok=True)
    try:
        for f in (m.file, "tokenizer.json", "config.json"):
            src = hf_hub_download(m.repo, f, revision=m.revision, cache_dir=str(model_dir() / ".hub"))
            target = dest / f
            target.parent.mkdir(parents=True, exist_ok=True)
            if not target.exists():
                shutil.copyfile(src, target)
    except EngineError:
        raise
    except Exception as err:  # noqa: BLE001 - network or hub failures become a clear 503
        raise EngineError(f"Couldn't download the text model “{m.key}”: {str(err).splitlines()[0]}", 503, "model_unavailable") from err
    return dest


def describe() -> list[dict[str, Any]]:
    return [{"key": m.key, "task": m.task, "title": m.title, "languages": m.languages, "license": m.license, "source": f"https://huggingface.co/{m.source}",
             "revision": m.revision, "dimensions": m.dims, "maxTokens": m.max_length, "attribution": m.attribution, "installed": downloaded(m),
             "default": DEFAULTS.get(m.task) == m.key} for m in MODELS.values()]


def get_model(key: str | None, task: str) -> TextModel:
    key = key or DEFAULTS[task]
    m = MODELS.get(key)
    if m is None or m.task != task:
        options = ", ".join(k for k, v in MODELS.items() if v.task == task)
        raise EngineError(f"“{key}” isn't a {task.replace('_', '-')} model. Choose one of: {options}.")
    return m


def _softmax(x: np.ndarray, axis: int = -1) -> np.ndarray:
    z = x - x.max(axis=axis, keepdims=True)
    e = np.exp(z)
    return e / e.sum(axis=axis, keepdims=True)


class Runtime:
    """A loaded model: tokenizer, ONNX session and label map. Thread-safe for inference."""

    def __init__(self, m: TextModel) -> None:
        import onnxruntime as ort
        from tokenizers import Tokenizer

        path = download(m)
        self.model = m
        self.tok = Tokenizer.from_file(str(path / "tokenizer.json"))
        self.tok.enable_truncation(m.max_length)
        pad_id = self.tok.token_to_id("<pad>")
        if pad_id is None:
            pad_id = self.tok.token_to_id("[PAD]") or 0
        self.tok.enable_padding(pad_id=pad_id, pad_token=self.tok.id_to_token(pad_id) or "[PAD]")
        opts = ort.SessionOptions()
        opts.intra_op_num_threads = max(1, int(os.environ.get("ENGINE_TEXT_THREADS", os.cpu_count() or 2)))
        opts.inter_op_num_threads = 1
        self.session = ort.InferenceSession(str(path / m.file), opts, providers=["CPUExecutionProvider"])
        self.inputs = {i.name for i in self.session.get_inputs()}
        config = json.loads((path / "config.json").read_text())
        self.id2label = {int(k): v for k, v in (config.get("id2label") or {}).items()}
        self.label2id = {v.lower(): k for k, v in self.id2label.items()}

    def _feed(self, enc) -> dict[str, np.ndarray]:
        ids = np.array([e.ids for e in enc], dtype=np.int64)
        mask = np.array([e.attention_mask for e in enc], dtype=np.int64)
        feed = {"input_ids": ids, "attention_mask": mask}
        if "token_type_ids" in self.inputs:
            feed["token_type_ids"] = np.array([e.type_ids for e in enc], dtype=np.int64)
        return {k: v for k, v in feed.items() if k in self.inputs}

    def run(self, enc) -> np.ndarray:
        return self.session.run(None, self._feed(enc))[0]

    # ---- tasks ----
    def embed(self, texts: list[str], batch: int = 64, progress=None) -> np.ndarray:
        out = []
        for start in range(0, len(texts), batch):
            if progress:
                progress(start / max(1, len(texts)))
            enc = self.tok.encode_batch([t or "" for t in texts[start:start + batch]])
            hidden = self.run(enc)  # (batch, tokens, dims)
            mask = np.array([e.attention_mask for e in enc], dtype=np.float32)[..., None]
            pooled = (hidden * mask).sum(axis=1) / np.clip(mask.sum(axis=1), 1e-9, None)
            out.append(pooled / np.clip(np.linalg.norm(pooled, axis=1, keepdims=True), 1e-12, None))
        return np.vstack(out).astype(np.float32) if out else np.zeros((0, self.model.dims or 0), np.float32)

    def classify(self, texts: list[str], batch: int = 32, progress=None) -> np.ndarray:
        out = []
        for start in range(0, len(texts), batch):
            if progress:
                progress(start / max(1, len(texts)))
            out.append(_softmax(self.run(self.tok.encode_batch([t or "" for t in texts[start:start + batch]]))))
        return np.vstack(out) if out else np.zeros((0, len(self.id2label)))

    def entailment(self, texts: list[str], labels: list[str], template: str, multi_label: bool, progress=None) -> np.ndarray:
        """Zero-shot scores (rows × labels) by natural-language inference, as in Yin et al. (2019)."""
        ent = self.label2id.get("entailment")
        con = self.label2id.get("contradiction")
        if ent is None or con is None:
            raise EngineError("This model has no entailment/contradiction labels.")
        pairs = [(t or "", template.format(lab)) for t in texts for lab in labels]
        logits = []
        for start in range(0, len(pairs), 32):
            if progress:
                progress(start / max(1, len(pairs)))
            logits.append(self.run(self.tok.encode_batch(pairs[start:start + 32])))
        L = np.vstack(logits).reshape(len(texts), len(labels), -1)
        if multi_label:
            return _softmax(L[..., [con, ent]], axis=-1)[..., 1]
        return _softmax(L[..., ent], axis=-1)

    def entities(self, texts: list[str], min_score: float = 0.5, progress=None) -> list[list[dict[str, Any]]]:
        """Token-level BIO tags merged into entity spans with character offsets."""
        out = []
        for start in range(0, len(texts), 32):
            if progress:
                progress(start / max(1, len(texts)))
            chunk = [t or "" for t in texts[start:start + 32]]
            enc = self.tok.encode_batch(chunk)
            probs = _softmax(self.run(enc))
            for text, e, pr in zip(chunk, enc, probs):
                spans: list[dict[str, Any]] = []
                cur = None
                for k, (a, b) in enumerate(e.offsets):
                    if e.special_tokens_mask[k] or b <= a:
                        continue
                    lab = self.id2label[int(pr[k].argmax())]
                    score = float(pr[k].max())
                    kind = lab.split("-", 1)[-1] if lab != "O" else None
                    word_cont = cur is not None and a == cur["end"] and not lab.startswith("B-")
                    if kind and cur and (word_cont or (lab.startswith("I-") and kind == cur["type"])):
                        cur["end"], cur["_scores"] = b, cur["_scores"] + [score]
                        continue
                    if cur:
                        spans.append(cur)
                        cur = None
                    if kind:
                        cur = {"type": kind, "start": a, "end": b, "_scores": [score]}
                if cur:
                    spans.append(cur)
                ents = []
                for s in spans:
                    sc = float(np.mean(s.pop("_scores")))
                    if sc >= min_score:
                        ents.append({**s, "text": text[s["start"]:s["end"]], "score": sc})
                out.append(ents)
        return out


_loaded: dict[str, Runtime] = {}
_lock = threading.Lock()


def runtime(m: TextModel) -> Runtime:
    with _lock:
        if m.key not in _loaded:
            _loaded[m.key] = Runtime(m)
        return _loaded[m.key]


if __name__ == "__main__":  # pragma: no cover - used by the Dockerfile
    import argparse

    ap = argparse.ArgumentParser(description="Download the pinned text models.")
    ap.add_argument("--download", action="store_true")
    ap.add_argument("--only", nargs="*")
    args = ap.parse_args()
    if args.download:
        for key, m in MODELS.items():
            if not args.only or key in args.only:
                print("downloading", key, "→", download(m))
