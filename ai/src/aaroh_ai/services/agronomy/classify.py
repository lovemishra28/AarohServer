"""Classify a soil reading into Low / Medium / High per nutrient.

The 7-in-1 probe reports **elemental** N, P, K in mg/kg. Indian soil-test
ratings are quoted in **elemental kg/ha**, so classification is two steps and
*only* two steps:

1. mg/kg → kg/ha  (× ``mgkg_to_kgha``; the bulk-density/depth assumption).
2. compare to the region's ``RatingBand`` limits → ``Low`` / ``Medium`` / ``High``.

There is deliberately **no** elemental→oxide conversion here. In the class-based
v1, the crop RDF is already stated in oxide (N–P₂O₅–K₂O) and fertilisers are
graded in oxide, so the dose→product math never leaves oxide units. The
elemental Olsen-P threshold (``<10``) would be *misclassified* if we multiplied
by 2.291 first. The oxide constants are reserved for the future STCR equation
(see the region config's ``factors._note``).

``npk_is_calibrated=False`` is the normal case today: the probe value is a proxy
until per-device calibration exists. Classification still runs — the resulting
``uncalibrated`` flag drives a standing warning rather than blocking advice.
"""

from __future__ import annotations

from dataclasses import dataclass

from aaroh_ai.services.agronomy.config import RatingBand, RegionConfig


@dataclass(frozen=True)
class NutrientRating:
    """One nutrient's converted value (elemental kg/ha) and its Low/Med/High class."""

    value_mgkg: float
    value_kgha: float
    soil_class: str


@dataclass(frozen=True)
class SoilRating:
    """Per-nutrient soil-test classes for a single reading."""

    n: NutrientRating
    p: NutrientRating
    k: NutrientRating
    npk_is_calibrated: bool

    @property
    def classes(self) -> dict[str, str]:
        return {"n": self.n.soil_class, "p": self.p.soil_class, "k": self.k.soil_class}


def _classify_value(value_kgha: float, band: RatingBand) -> str:
    """Half-open bands: ``< low_max`` → Low, ``< med_max`` → Medium, else High."""
    if value_kgha < band.low_max:
        return "Low"
    if value_kgha < band.med_max:
        return "Medium"
    return "High"


def _rate(value_mgkg: float, cfg: RegionConfig, band: RatingBand) -> NutrientRating:
    value_kgha = value_mgkg * cfg.mgkg_to_kgha
    return NutrientRating(
        value_mgkg=float(value_mgkg),
        value_kgha=value_kgha,
        soil_class=_classify_value(value_kgha, band),
    )


def classify_soil(
    n_mgkg: float,
    p_mgkg: float,
    k_mgkg: float,
    cfg: RegionConfig,
    npk_is_calibrated: bool = False,
) -> SoilRating:
    """Rate a probe reading's N, P, K against the region's thresholds.

    ``n_mgkg / p_mgkg / k_mgkg`` are the probe's **elemental** values. Returns a
    :class:`SoilRating` carrying both the converted kg/ha value (for
    transparency in the output) and the Low/Medium/High class per nutrient.
    """
    return SoilRating(
        n=_rate(n_mgkg, cfg, cfg.rating_n),
        p=_rate(p_mgkg, cfg, cfg.rating_p),
        k=_rate(k_mgkg, cfg, cfg.rating_k),
        npk_is_calibrated=npk_is_calibrated,
    )
