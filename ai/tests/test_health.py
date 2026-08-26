"""Inference server: health, predict, and recommend.

Skipped cleanly unless the FastAPI server extras are installed. In Phase 2 the
app loads the active model at import, so ``model_loaded`` may be True or False
depending on whether a serving backend (onnxruntime / LightGBM) is present — the
tests assert the *contract*, and only exercise predict/recommend when a model is
actually loaded.
"""

from __future__ import annotations

import pytest

pytest.importorskip("fastapi")

from fastapi.testclient import TestClient  # noqa: E402

from aaroh_ai.inference.app import app  # noqa: E402

client = TestClient(app)


def _reading() -> dict:
    return {
        "N": 100, "P": 4, "K": 50, "ph": 8.1, "ec": 420, "moisture": 22,
        "temperature": 24, "humidity": 55, "rainfall": 60,
        "soil_type": "Black", "season": "Rabi",
    }


def test_health_ok() -> None:
    res = client.get("/health")
    assert res.status_code == 200
    body = res.json()
    assert body["status"] == "ok"
    assert body["service"] == "aaroh-ai"
    assert isinstance(body["model_loaded"], bool)
    assert "backend" in body["model"]


def _model_loaded() -> bool:
    return bool(client.get("/health").json()["model_loaded"])


def test_predict_ranks_all_crops_or_503() -> None:
    res = client.post("/predict", json={"features": _reading(), "region_code": "chambal"})
    if not _model_loaded():
        assert res.status_code == 503
        return
    assert res.status_code == 200
    body = res.json()
    assert len(body["ranked"]) == 20
    assert body["model_version"]
    scores = [r["score"] for r in body["ranked"]]
    assert scores == sorted(scores, reverse=True)


def test_recommend_returns_full_result_or_503() -> None:
    res = client.post(
        "/recommend",
        json={"features": _reading(), "region_code": "chambal", "area_ha": 1.2},
    )
    if not _model_loaded():
        assert res.status_code == 503
        return
    assert res.status_code == 200
    body = res.json()
    assert body["region_code"] == "chambal"
    assert body["area_ha"] == 1.2
    assert body["agronomy_version"]
    # every crop lands in exactly one segment; 20 total
    assert len(body["segment_a"]) + len(body["segment_b"]) == 20
    assert any("npk_proxy_uncalibrated" in w for w in body["warnings"])


def test_recommend_unknown_region_404() -> None:
    if not _model_loaded():
        return
    res = client.post(
        "/recommend",
        json={"features": _reading(), "region_code": "atlantis", "area_ha": 1.0},
    )
    assert res.status_code == 404


def test_recommend_rejects_bad_area_422() -> None:
    res = client.post(
        "/recommend",
        json={"features": _reading(), "region_code": "chambal", "area_ha": 0},
    )
    # pydantic rejects area_ha<=0 before the handler runs
    assert res.status_code == 422
