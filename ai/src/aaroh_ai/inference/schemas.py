"""Request/response contracts for the private Node↔Python inference API (§6.3).

These pydantic models are the wire contract between the Node API and this
service. They are intentionally the *only* place that imports pydantic in the
inference package, so the engine, model loader, and CLI stay importable without
the server extras installed.

Nutrient field names carry their unit (``n_kgha``, ``p2o5_kgha``) — the same
discipline as the feature pipeline — so an oxide value can never be silently
read as elemental. ``Features`` mirrors the raw sensor/weather columns the shared
feature pipeline expects (``RAW_TO_INTERNAL``); ``temperature`` (root-zone soil
temp) is the one field optional at inference, matching the firmware gap.
"""

from __future__ import annotations

from pydantic import BaseModel, ConfigDict, Field


class Features(BaseModel):
    """Raw sensor + weather inputs, using the pipeline's raw column names."""

    model_config = ConfigDict(extra="allow")

    N: float = Field(..., description="Probe elemental nitrogen, mg/kg")
    P: float = Field(..., description="Probe elemental phosphorus, mg/kg")
    K: float = Field(..., description="Probe elemental potassium, mg/kg")
    ph: float = Field(..., ge=0, le=14, description="Soil pH (1:2.5 suspension)")
    ec: float = Field(..., ge=0, description="Bulk EC, µS/cm")
    moisture: float = Field(..., description="Volumetric water content, %")
    humidity: float = Field(..., description="Relative humidity, % (weather)")
    rainfall: float = Field(..., description="Accumulated seasonal rainfall, mm (weather)")
    soil_type: str = Field(..., description="Soil class (categorical)")
    season: str = Field(..., description="Season, e.g. Kharif/Rabi (categorical)")
    temperature: float | None = Field(
        default=None, description="Root-zone soil temp, °C — optional at inference"
    )

    def to_reading(self) -> dict:
        """Plain dict of raw columns for the feature pipeline (drops None temp)."""
        return self.model_dump(exclude_none=True)


class PredictRequest(BaseModel):
    features: Features
    region_code: str = "chambal"


class RankedCrop(BaseModel):
    crop: str
    score: float


class PredictResponse(BaseModel):
    ranked: list[RankedCrop]
    model_version: str


class RecommendRequest(BaseModel):
    features: Features
    region_code: str = "chambal"
    area_ha: float = Field(..., gt=0, description="Field size in hectares (post-prediction filter)")
    budget_hint: float | None = Field(default=None, ge=0, description="Optional rupee budget hint")
    npk_is_calibrated: bool = Field(
        default=False, description="True only once the probe has per-device NPK calibration"
    )


# ---- RecommendationResult mirror (§6.4) ------------------------------------
class NutrientGap(BaseModel):
    n_kgha: float
    p2o5_kgha: float
    k2o_kgha: float


class ProductLineOut(BaseModel):
    name: str
    bags_50kg: int
    kg: float
    supplies: dict[str, float]


class FertiliserOut(BaseModel):
    products: list[ProductLineOut]
    nutrient_gap_kgha: NutrientGap
    cost_inr: float


class SegmentAItem(BaseModel):
    crop: str
    crop_hi: str
    score: float
    rationale_code: str


class SegmentBItem(BaseModel):
    crop: str
    crop_hi: str
    score: float
    fertiliser: FertiliserOut
    rationale_code: str


class RecommendationResponse(BaseModel):
    model_version: str
    agronomy_version: str
    region_code: str
    area_ha: float
    segment_a: list[SegmentAItem]
    segment_b: list[SegmentBItem]
    warnings: list[str] = Field(default_factory=list)


class HealthResponse(BaseModel):
    status: str
    service: str
    version: str
    model_loaded: bool
    model: dict | None = None
