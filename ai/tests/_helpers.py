"""Shared, cached loaders for the test suite.

Not collected by pytest (no ``test_`` prefix). Kept fixture-free so every test is
a plain zero-argument function — it runs identically under pytest and under the
minimal in-sandbox harness that has no pytest installed.
"""

from __future__ import annotations

from functools import lru_cache

import numpy as np


@lru_cache(maxsize=1)
def raw():
    from aaroh_ai.data.loading import load_raw
    return load_raw()


@lru_cache(maxsize=1)
def fitted_pipeline():
    from aaroh_ai.features.feature_pipeline import FeaturePipeline
    r = raw()
    return FeaturePipeline.fit(
        r.features, source_hashes={"features": r.features_sha256, "soft": r.soft_sha256}
    )


def dummy_config(version: str = "0.0.1-dummy") -> dict:
    return {
        "name": "crop-ranker", "version": version, "seed": 42,
        "split": {"ratios": [0.70, 0.15, 0.15]},
        "model": {"framework": "dummy", "objective": "softprob", "params": {"tilt": 0.5}},
        "tuning": {"enabled": False},
        "gates": {"max_ece": 0.15, "ndcg3_not_worse_than_baseline": True,
                  "require_golden_pass": True},
        "onnx": {"enabled": True, "atol": 1e-4},
        "registry": {"activate": True},
        "notes": "test smoke",
    }


def rand_proba(n: int, c: int, seed: int = 0) -> np.ndarray:
    rng = np.random.default_rng(seed)
    z = rng.normal(size=(n, c))
    e = np.exp(z - z.max(axis=1, keepdims=True))
    return e / e.sum(axis=1, keepdims=True)
