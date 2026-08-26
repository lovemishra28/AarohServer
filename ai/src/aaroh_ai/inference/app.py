"""Aaroh AI service — FastAPI application (Phase 2).

The **private** inference API (never exposed to the mobile app; only the Node
API calls it — §6.3). Four endpoints:

* ``GET  /health``    — liveness + which model is loaded and on what backend.
* ``POST /predict``   — raw features → ranked crops (the ML ranker only).
* ``POST /recommend`` — raw features + area → full costed ``RecommendationResult``
  (ranker + deterministic agronomy engine).
* ``POST /reload``    — re-read the registry and swap in the newly-active model
  without a restart (used after a training run promotes a new version).

The heavy lifting lives in importable, framework-free modules
(:mod:`model_service`, :mod:`aaroh_ai.services.agronomy`); this file is just the
HTTP surface, so the same logic is exercised by the CLI and the golden tests
without FastAPI. The model is loaded once at import into a module-level
:class:`ModelService`; ``/predict`` and ``/recommend`` return 503 while it is
unavailable rather than serving a guess.
"""

from __future__ import annotations

from fastapi import FastAPI, HTTPException

from aaroh_ai import __version__
from aaroh_ai.inference.model_service import ModelService
from aaroh_ai.inference.schemas import (
    HealthResponse,
    PredictRequest,
    PredictResponse,
    RankedCrop,
    RecommendationResponse,
    RecommendRequest,
)
from aaroh_ai.services.agronomy import load_region_config, recommend

app = FastAPI(
    title="Aaroh AI Service",
    version=__version__,
    description="Private crop-ranking + deterministic fertiliser recommendation API.",
)

# Loaded once at process start; swapped by /reload. Never raises on failure —
# see ModelService.reload — so the app always boots and /health can report why.
_model = ModelService()

# Region configs are tiny; cache by code so repeated calls don't re-read disk.
_region_cache: dict[str, object] = {}


def _region(region_code: str):
    cfg = _region_cache.get(region_code)
    if cfg is None:
        try:
            cfg = load_region_config(region_code)
        except (FileNotFoundError, ValueError, KeyError) as exc:
            raise HTTPException(
                status_code=404, detail=f"unknown region '{region_code}': {exc}"
            ) from exc
        _region_cache[region_code] = cfg
    return cfg


def _require_model() -> ModelService:
    if not _model.loaded:
        raise HTTPException(
            status_code=503,
            detail=f"model not loaded: {_model.load_error or 'unknown error'}",
        )
    return _model


@app.get("/health", response_model=HealthResponse)
def health() -> HealthResponse:
    """Liveness/readiness probe; reports the active model and backend."""
    return HealthResponse(
        status="ok",
        service="aaroh-ai",
        version=__version__,
        model_loaded=_model.loaded,
        model=_model.status(),
    )


@app.post("/predict", response_model=PredictResponse)
def predict(req: PredictRequest) -> PredictResponse:
    """Rank all crops for a reading (ML only; no agronomy/costing)."""
    svc = _require_model()
    try:
        ranked = svc.rank(req.features.to_reading())
    except (KeyError, ValueError) as exc:
        raise HTTPException(status_code=422, detail=f"invalid features: {exc}") from exc
    return PredictResponse(
        ranked=[RankedCrop(crop=c, score=s) for c, s in ranked],
        model_version=svc.model_version,
    )


@app.post("/recommend", response_model=RecommendationResponse)
def recommend_endpoint(req: RecommendRequest) -> RecommendationResponse:
    """Full costed recommendation: rank crops, then run the agronomy engine."""
    svc = _require_model()
    cfg = _region(req.region_code)
    reading = req.features.to_reading()
    try:
        ranked = svc.rank(reading)
        result = recommend(
            ranked=ranked,
            reading=reading,
            area_ha=req.area_ha,
            cfg=cfg,
            model_version=svc.model_version,
            npk_is_calibrated=req.npk_is_calibrated,
        )
    except (KeyError, ValueError) as exc:
        raise HTTPException(status_code=422, detail=f"invalid request: {exc}") from exc
    return RecommendationResponse(**result.to_dict())


@app.post("/reload", response_model=HealthResponse)
def reload_model() -> HealthResponse:
    """Re-read the registry and swap in the active model (post-promotion)."""
    _model.reload()
    _region_cache.clear()
    return health()
