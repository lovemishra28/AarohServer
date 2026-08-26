"""Deterministic agronomy engine: soil reading + crop → fertiliser bags + cost.

No ML here (ADR-0004). Public entrypoints:

* :func:`load_region_config` — load the versioned domain data.
* :func:`classify_soil` — Low/Medium/High per nutrient.
* :func:`recommend` — full :class:`RecommendationResult` from ranked crops.
* :func:`recommend_for_crop` — one crop's plan (used by the CLI's ``--crop`` path).
"""

from __future__ import annotations

from aaroh_ai.services.agronomy.classify import (
    NutrientRating,
    SoilRating,
    classify_soil,
)
from aaroh_ai.services.agronomy.config import (
    CANONICAL_CROPS,
    CropSpec,
    Product,
    RegionConfig,
    load_region_config,
)
from aaroh_ai.services.agronomy.engine import (
    CropRecommendation,
    Dose,
    Fertiliser,
    ProductLine,
    RecommendationResult,
    allocate_products,
    compute_dose,
    recommend,
    recommend_for_crop,
)

__all__ = [
    "CANONICAL_CROPS",
    "CropRecommendation",
    "CropSpec",
    "Dose",
    "Fertiliser",
    "NutrientRating",
    "Product",
    "ProductLine",
    "RecommendationResult",
    "RegionConfig",
    "SoilRating",
    "allocate_products",
    "classify_soil",
    "compute_dose",
    "load_region_config",
    "recommend",
    "recommend_for_crop",
]
