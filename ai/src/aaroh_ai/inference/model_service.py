"""Load the active ranker and serve crop rankings — the ML half of a recommendation.

This is the serving counterpart to the training package. It reads the file
registry (ADR-0003) to find the **active** model, loads the exact
``feature_spec.json`` that model was trained with (so serving features are
byte-identical to training — the whole point of the shared pipeline), and picks
a backend to run it:

* **ONNX** (preferred for LightGBM/XGBoost): a frozen ``model.onnx`` runs under
  ``onnxruntime`` with no Python ML framework installed. This is the path that
  works in the minimal sandbox and mirrors what the mobile/edge target will do.
* **native** framework (LightGBM/XGBoost ``Booster``): used when ONNX is absent
  but the framework is installed.
* **dummy** (pure numpy): the registered smoke model, always loadable.

Deliberately free of FastAPI/pydantic so the CLI and tests can import it without
the server extras. If no backend can be assembled (e.g. a LightGBM-only artifact
on a box with neither ``onnxruntime`` nor ``lightgbm``), :attr:`ModelService.loaded`
is ``False`` and :meth:`predict_proba` raises — the caller surfaces a 503 rather
than guessing.
"""

from __future__ import annotations

import json
import os
from pathlib import Path

import numpy as np
import pandas as pd

from aaroh_ai.features.feature_pipeline import FeaturePipeline
from aaroh_ai.training.registry import FileRegistry, ModelRecord

_ENV_REGISTRY = "AAROH_MODEL_REGISTRY"


def default_registry_path() -> Path:
    """``ai/models/registry/registry.json``, or ``$AAROH_MODEL_REGISTRY`` if set."""
    override = os.environ.get(_ENV_REGISTRY)
    if override:
        return Path(override)
    # src/aaroh_ai/inference/model_service.py -> parents[3] == ai/
    ai_root = Path(__file__).resolve().parents[3]
    return ai_root / "models" / "registry" / "registry.json"


def _artifact_dir(registry: FileRegistry, record: ModelRecord) -> Path:
    """Resolve a record's artifact dir, normalising Windows backslashes."""
    rel = record.artifact_uri.replace("\\", "/")
    return (registry.models_dir / rel).resolve()


def _load_classes(artifact_dir: Path, algo: str) -> tuple[str, ...]:
    """Classes live in ``meta.json`` (lightgbm/xgboost) or ``model.json`` (dummy)."""
    for fname in ("meta.json", "model.json", "metadata.json"):
        f = artifact_dir / fname
        if f.is_file():
            data = json.loads(f.read_text(encoding="utf-8"))
            classes = data.get("classes")
            if classes:
                return tuple(classes)
    raise FileNotFoundError(f"could not find class list in {artifact_dir}")


class _OnnxBackend:
    """Runs a frozen ``model.onnx`` and returns the 2-D probability tensor."""

    kind = "onnx"

    def __init__(self, onnx_path: Path):
        import onnxruntime as ort

        from aaroh_ai.export.onnx_export import to_float_matrix

        self._to_matrix = to_float_matrix
        self._sess = ort.InferenceSession(str(onnx_path), providers=["CPUExecutionProvider"])
        self._input = self._sess.get_inputs()[0].name

    def predict_proba(self, X: pd.DataFrame) -> np.ndarray:
        matrix = self._to_matrix(X)
        outputs = self._sess.run(None, {self._input: matrix})
        for arr in outputs:
            a = np.asarray(arr)
            if a.ndim == 2:
                return a.astype(np.float64)
        raise RuntimeError("ONNX model produced no 2-D probability output")


class _NativeBackend:
    """Wraps a native BaseRanker (dummy numpy, or LightGBM/XGBoost booster)."""

    def __init__(self, ranker):
        self._ranker = ranker
        self.kind = ranker.framework

    def predict_proba(self, X: pd.DataFrame) -> np.ndarray:
        return np.asarray(self._ranker.predict_proba(X), dtype=np.float64)


def _build_backend(record: ModelRecord, artifact_dir: Path):
    """Choose a runnable backend for this artifact, or return ``(None, reason)``.

    Preference: ONNX for framework models (portable, no ML dep), native
    otherwise. The dummy model has no ONNX graph and loads natively (pure numpy).
    """
    algo = record.algo
    onnx_path = artifact_dir / "model.onnx"

    # 1) ONNX first for real frameworks.
    if algo in ("lightgbm", "xgboost") and onnx_path.is_file():
        try:
            return _OnnxBackend(onnx_path), "onnx"
        except Exception as exc:  # onnxruntime missing or graph unreadable
            onnx_reason = f"onnx unavailable ({exc})"
    else:
        onnx_reason = "no model.onnx" if algo in ("lightgbm", "xgboost") else "n/a"

    # 2) Native framework load.
    try:
        from aaroh_ai.training.models import build_ranker

        config = {"framework": algo, "objective": record.objective, "seed": 42}
        ranker = build_ranker(config, _load_classes(artifact_dir, algo))
        ranker = type(ranker).load(artifact_dir)
        return _NativeBackend(ranker), "native"
    except Exception as exc:
        return None, f"native load failed ({exc}); {onnx_reason}"


class ModelService:
    """Holds the active model and turns a raw reading into ranked crops."""

    def __init__(self, registry_path: str | Path | None = None):
        self.registry_path = Path(registry_path) if registry_path else default_registry_path()
        self.loaded: bool = False
        self.load_error: str = ""
        self.model_version: str = ""
        self.algo: str = ""
        self.objective: str = ""
        self.backend: str = "none"
        self.classes: tuple[str, ...] = ()
        self._pipeline: FeaturePipeline | None = None
        self._backend = None
        self.reload()

    def reload(self) -> None:
        """(Re)load the active model from the registry. Never raises — records error."""
        self.loaded = False
        self.load_error = ""
        try:
            registry = FileRegistry(self.registry_path)
            record = registry.active()
            if record is None:
                self.load_error = "no active model in registry"
                return
            artifact_dir = _artifact_dir(registry, record)
            if not artifact_dir.is_dir():
                self.load_error = f"artifact dir missing: {artifact_dir}"
                return

            pipeline = FeaturePipeline.load(artifact_dir / "feature_spec.json")
            classes = _load_classes(artifact_dir, record.algo)
            backend, how = _build_backend(record, artifact_dir)
            if backend is None:
                self.load_error = how
                return

            self._pipeline = pipeline
            self._backend = backend
            self.classes = classes
            self.model_version = record.version
            self.algo = record.algo
            self.objective = record.objective
            self.backend = backend.kind
            self.loaded = True
        except Exception as exc:  # registry unreadable, spec mismatch, etc.
            self.load_error = f"{type(exc).__name__}: {exc}"

    # ---- inference ----------------------------------------------------------
    def predict_proba(self, reading: dict) -> np.ndarray:
        """Probability vector over :attr:`classes` for one raw reading dict."""
        if not self.loaded or self._pipeline is None or self._backend is None:
            raise RuntimeError(f"model not loaded: {self.load_error or 'unknown'}")
        X = self._pipeline.transform_record(reading)
        proba = self._backend.predict_proba(X)
        return proba[0]

    def rank(self, reading: dict) -> list[tuple[str, float]]:
        """All crops as ``(crop, score)`` sorted by descending probability."""
        proba = self.predict_proba(reading)
        order = np.argsort(-proba)
        return [(self.classes[i], float(proba[i])) for i in order]

    def status(self) -> dict:
        """Small dict for the ``/health`` and CLI banners."""
        return {
            "loaded": self.loaded,
            "model_version": self.model_version or None,
            "algo": self.algo or None,
            "objective": self.objective or None,
            "backend": self.backend,
            "n_classes": len(self.classes),
            "error": self.load_error or None,
        }
