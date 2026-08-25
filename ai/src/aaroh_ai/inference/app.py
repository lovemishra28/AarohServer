"""Aaroh AI service — FastAPI application.

Phase 0: only a /health endpoint exists. The /predict and /recommend
endpoints arrive in Phase 2, once the crop-ranker (Phase 1) is trained
and the deterministic agronomy engine is in place.
"""

from __future__ import annotations

from fastapi import FastAPI
from pydantic import BaseModel

from aaroh_ai import __version__

app = FastAPI(title="Aaroh AI Service", version=__version__)


class HealthReport(BaseModel):
    status: str = "ok"
    service: str = "aaroh-ai"
    version: str = __version__
    model_loaded: bool = False  # no model is loaded until Phase 1/2


@app.get("/health", response_model=HealthReport)
def health() -> HealthReport:
    """Liveness/readiness probe. Reports whether a model is currently loaded."""
    return HealthReport()
