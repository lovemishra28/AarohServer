"""Inference model service: registry -> backend -> ranked crops.

Skips cleanly when no serving backend can be assembled (no onnxruntime and no
LightGBM), so the suite still passes on a bare install. When a backend *is*
available it exercises the real active model end-to-end.
"""

from __future__ import annotations

from aaroh_ai.inference.model_service import ModelService


def _reading() -> dict:
    return {
        "N": 100, "P": 4, "K": 50, "ph": 8.1, "ec": 420, "moisture": 22,
        "temperature": 24, "humidity": 55, "rainfall": 60,
        "soil_type": "Black", "season": "Rabi",
    }


def test_service_loads_active_or_reports_why():
    """Loading never raises; it either succeeds or records a readable error."""
    svc = ModelService()
    status = svc.status()
    assert "loaded" in status and "backend" in status
    if not svc.loaded:
        assert svc.load_error  # must explain itself


def test_rank_returns_full_distribution_when_loaded():
    svc = ModelService()
    if not svc.loaded:
        return  # no backend in this environment — nothing to assert
    ranked = svc.rank(_reading())
    assert len(ranked) == len(svc.classes) == 20
    # sorted descending by score
    scores = [s for _, s in ranked]
    assert scores == sorted(scores, reverse=True)
    # a proper distribution
    assert abs(sum(scores) - 1.0) < 1e-3
    assert set(c for c, _ in ranked) == set(svc.classes)


def test_predict_proba_raises_when_not_loaded():
    """A service pointed at a nonexistent registry must refuse to predict."""
    svc = ModelService(registry_path="/nonexistent/registry.json")
    assert not svc.loaded
    try:
        svc.predict_proba(_reading())
        raise AssertionError("expected RuntimeError when model not loaded")
    except RuntimeError as e:
        assert "not loaded" in str(e)
