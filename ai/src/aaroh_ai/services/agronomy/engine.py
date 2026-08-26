"""The deterministic fertiliser engine — nutrient status → product bags → cost.

This is the auditable half of Aaroh's advice (ADR-0004): **no machine learning**
lives here. Given a soil reading, a crop, and a field area, it produces the exact
list of purchasable fertiliser bags and their rupee cost, by a fixed procedure a
farmer or agronomist can check by hand. The ML ranker decides *which crops* to
consider; this engine decides *what to buy* for each, and why.

The v1 procedure (``dose_model.type == "class_adjusted_rdf"``):

1. **Classify** the soil into Low/Medium/High per nutrient (:mod:`classify`).
2. **Dose** each nutrient = crop RDF × the class multiplier for that nutrient's
   class (High → 0, i.e. "enough already, add nothing"). Legumes carry an
   RDF-N of 0 (biological N fixation) so they are never dosed nitrogen.
3. **Scale to the field**: dose (kg/ha) × area (ha) = kg to apply on this field.
4. **Allocate products** in a fixed order that respects the oxide grades:
   DAP first (meets P₂O₅, and its 18 % N is *credited*), Urea next (meets the
   N still outstanding), MOP last (meets K₂O). Each product is rounded to whole
   50 kg bags (round-half-up) because that is how it is sold.
5. **Cost** = Σ bags × price per bag.
6. **Segment** the crop: A ("grow now, no fertiliser needed") if the rounded
   plan is empty, else B ("viable with this stated cost").

Everything the engine reads — factors, grades, prices, thresholds, RDF — comes
from the versioned :class:`RegionConfig`, so the numbers are reproducible and
the whole engine is golden-testable without a database.
"""

from __future__ import annotations

import math
from dataclasses import asdict, dataclass, field

from aaroh_ai.services.agronomy.classify import SoilRating, classify_soil
from aaroh_ai.services.agronomy.config import RegionConfig

# pH outside this range materially changes nutrient availability; we don't
# refuse advice but we surface it. Chambal soils are typically alkaline.
PH_ACIDIC_BELOW = 5.5
PH_ALKALINE_ABOVE = 8.5

# Standing warning: probe N/P/K are proxy values until per-device calibration.
WARN_NPK_UNCALIBRATED = (
    "npk_proxy_uncalibrated: probe N/P/K are uncalibrated proxy values; "
    "treat fertiliser quantities as indicative until the device is calibrated."
)
WARN_CONFIG_PROVISIONAL = (
    "agronomy_config_provisional: dose table and thresholds are seeded defaults "
    "pending agronomist sign-off."
)


# --------------------------------------------------------------------------- #
# Result types (mirror the frozen RecommendationResult contract, §6.4)
# --------------------------------------------------------------------------- #
@dataclass(frozen=True)
class ProductLine:
    """One product to buy: whole 50 kg bags, total kg, and oxide nutrients supplied."""

    name: str
    bags_50kg: int
    kg: float
    supplies: dict[str, float]  # e.g. {"P2O5": 23.0, "N": 9.0}


@dataclass(frozen=True)
class Fertiliser:
    """The full plan for one crop on this field."""

    products: list[ProductLine]
    nutrient_gap_kgha: dict[str, float]  # recommended dose, per ha: n_kgha/p2o5_kgha/k2o_kgha
    cost_inr: float


@dataclass(frozen=True)
class CropRecommendation:
    """One ranked crop, its segment, and (for Segment B) its fertiliser plan."""

    crop: str
    crop_hi: str
    score: float
    segment: str            # "A" or "B"
    rationale_code: str
    fertiliser: Fertiliser | None = None  # None for Segment A


@dataclass(frozen=True)
class RecommendationResult:
    """The end-to-end payload returned to the API / CLI (§6.4)."""

    model_version: str
    agronomy_version: str
    region_code: str
    area_ha: float
    segment_a: list[dict]
    segment_b: list[dict]
    warnings: list[str] = field(default_factory=list)

    def to_dict(self) -> dict:
        return asdict(self)


# --------------------------------------------------------------------------- #
# Dosing
# --------------------------------------------------------------------------- #
@dataclass(frozen=True)
class Dose:
    """Class-adjusted recommended dose for one crop, in oxide kg/ha."""

    n_kgha: float
    p2o5_kgha: float
    k2o_kgha: float


def compute_dose(crop: str, rating: SoilRating, cfg: RegionConfig) -> Dose:
    """RDF × class multiplier, per nutrient, using each nutrient's own soil class.

    Legumes already carry ``rdf_n = 0`` in the config, so multiplying by any
    N-class multiplier keeps their nitrogen dose at zero.
    """
    spec = cfg.crop(crop)
    mult = cfg.class_multiplier
    return Dose(
        n_kgha=spec.rdf_n_kgha * mult[rating.n.soil_class],
        p2o5_kgha=spec.rdf_p2o5_kgha * mult[rating.p.soil_class],
        k2o_kgha=spec.rdf_k2o_kgha * mult[rating.k.soil_class],
    )


# --------------------------------------------------------------------------- #
# Product allocation
# --------------------------------------------------------------------------- #
def _bags(kg_needed: float, cfg: RegionConfig) -> int:
    """Whole 50 kg bags for a required product mass.

    Round-half-up (``floor(x + 0.5)``): Python's built-in ``round`` is
    banker's rounding, which would send 2.5 → 2; a farmer buying bags wants
    2.5 → 3. Never returns a negative count.
    """
    if kg_needed <= 0:
        return 0
    bags_exact = kg_needed / cfg.bag_kg
    if cfg.rounding == "up":
        return math.ceil(bags_exact)
    return int(math.floor(bags_exact + 0.5))


def allocate_products(
    field_n_kg: float,
    field_p2o5_kg: float,
    field_k2o_kg: float,
    cfg: RegionConfig,
) -> tuple[list[ProductLine], float]:
    """Turn a whole-field oxide requirement into bags of DAP/Urea/MOP + cost.

    Fixed order so the result is deterministic and the N double-count is
    avoided: **DAP** supplies P₂O₅ (and we credit its N), **Urea** supplies the
    N still outstanding after that credit, **MOP** supplies K₂O.
    """
    urea, dap, mop = cfg.products["Urea"], cfg.products["DAP"], cfg.products["MOP"]
    lines: list[ProductLine] = []

    # 1) DAP for phosphorus; credit the nitrogen it also carries.
    dap_n_credit = 0.0
    if field_p2o5_kg > 0:
        dap_kg_needed = field_p2o5_kg / (dap.p2o5_pct / 100.0)
        dap_bags = _bags(dap_kg_needed, cfg)
        if dap_bags > 0:
            dap_kg = dap_bags * cfg.bag_kg
            supplies = {
                "P2O5": dap_kg * dap.p2o5_pct / 100.0,
                "N": dap_kg * dap.n_pct / 100.0,
            }
            dap_n_credit = supplies["N"]
            lines.append(ProductLine("DAP", dap_bags, dap_kg, supplies))

    # 2) Urea for the nitrogen still needed after DAP's contribution.
    residual_n = field_n_kg - dap_n_credit
    if residual_n > 0:
        urea_kg_needed = residual_n / (urea.n_pct / 100.0)
        urea_bags = _bags(urea_kg_needed, cfg)
        if urea_bags > 0:
            urea_kg = urea_bags * cfg.bag_kg
            lines.append(
                ProductLine("Urea", urea_bags, urea_kg, {"N": urea_kg * urea.n_pct / 100.0})
            )

    # 3) MOP for potassium.
    if field_k2o_kg > 0:
        mop_kg_needed = field_k2o_kg / (mop.k2o_pct / 100.0)
        mop_bags = _bags(mop_kg_needed, cfg)
        if mop_bags > 0:
            mop_kg = mop_bags * cfg.bag_kg
            lines.append(
                ProductLine("MOP", mop_bags, mop_kg, {"K2O": mop_kg * mop.k2o_pct / 100.0})
            )

    cost = sum(line.bags_50kg * cfg.products[line.name].inr_per_bag for line in lines)
    return lines, round(cost, 2)


# --------------------------------------------------------------------------- #
# Rationale
# --------------------------------------------------------------------------- #
def _segment_b_rationale(dose: Dose) -> str:
    """Compact, stable token naming which nutrients drove the plan (N, P, K order)."""
    parts: list[str] = []
    if dose.n_kgha > 0:
        parts.append("N_ADD_UREA")
    if dose.p2o5_kgha > 0:
        parts.append("P_ADD_DAP")
    if dose.k2o_kgha > 0:
        parts.append("K_ADD_MOP")
    return "+".join(parts) if parts else "SOIL_SUFFICIENT"


def _segment_a_rationale(crop: str, cfg: RegionConfig) -> str:
    return "LEGUME_FIXES_N" if cfg.is_legume(crop) else "SOIL_SUFFICIENT"


# --------------------------------------------------------------------------- #
# Per-crop and top-level
# --------------------------------------------------------------------------- #
def recommend_for_crop(
    crop: str,
    score: float,
    rating: SoilRating,
    area_ha: float,
    cfg: RegionConfig,
) -> CropRecommendation:
    """Full deterministic recommendation for one crop on a field of ``area_ha``."""
    spec = cfg.crop(crop)
    dose = compute_dose(crop, rating, cfg)

    field_n = dose.n_kgha * area_ha
    field_p2o5 = dose.p2o5_kgha * area_ha
    field_k2o = dose.k2o_kgha * area_ha
    products, cost = allocate_products(field_n, field_p2o5, field_k2o, cfg)

    if not products:
        return CropRecommendation(
            crop=crop,
            crop_hi=spec.hi,
            score=float(score),
            segment="A",
            rationale_code=_segment_a_rationale(crop, cfg),
            fertiliser=None,
        )

    fert = Fertiliser(
        products=products,
        nutrient_gap_kgha={
            "n_kgha": round(dose.n_kgha, 3),
            "p2o5_kgha": round(dose.p2o5_kgha, 3),
            "k2o_kgha": round(dose.k2o_kgha, 3),
        },
        cost_inr=cost,
    )
    return CropRecommendation(
        crop=crop,
        crop_hi=spec.hi,
        score=float(score),
        segment="B",
        rationale_code=_segment_b_rationale(dose),
        fertiliser=fert,
    )


def build_warnings(reading: dict, rating: SoilRating, cfg: RegionConfig) -> list[str]:
    """Non-fatal advisories to attach to the whole recommendation."""
    warnings: list[str] = []
    if not rating.npk_is_calibrated:
        warnings.append(WARN_NPK_UNCALIBRATED)
    if cfg.provisional:
        warnings.append(WARN_CONFIG_PROVISIONAL)
    ph = reading.get("ph")
    if ph is not None:
        if ph < PH_ACIDIC_BELOW:
            warnings.append(
                f"acidic_soil_ph_{ph}: pH below {PH_ACIDIC_BELOW} limits P/K uptake; "
                "consider liming."
            )
        elif ph > PH_ALKALINE_ABOVE:
            warnings.append(
                f"alkaline_soil_ph_{ph}: pH above {PH_ALKALINE_ABOVE} can lock up P, Fe, Zn."
            )
    return warnings


def recommend(
    ranked: list[tuple[str, float]],
    reading: dict,
    area_ha: float,
    cfg: RegionConfig,
    model_version: str,
    npk_is_calibrated: bool = False,
) -> RecommendationResult:
    """Assemble the full :class:`RecommendationResult` from ranked crops + a reading.

    ``ranked`` is the ML output as ``[(crop, score), ...]`` in descending score;
    ``reading`` is a raw sensor dict with at least ``N``, ``P``, ``K`` (elemental
    mg/kg) and optionally ``ph``. The soil is classified once and every crop is
    scored against it, then split into Segment A / Segment B preserving rank
    order within each segment.
    """
    if area_ha <= 0:
        raise ValueError(f"area_ha must be positive, got {area_ha}")

    rating = classify_soil(
        n_mgkg=float(reading["N"]),
        p_mgkg=float(reading["P"]),
        k_mgkg=float(reading["K"]),
        cfg=cfg,
        npk_is_calibrated=npk_is_calibrated,
    )

    segment_a: list[dict] = []
    segment_b: list[dict] = []
    for crop, score in ranked:
        rec = recommend_for_crop(crop, score, rating, area_ha, cfg)
        if rec.segment == "A":
            segment_a.append(
                {
                    "crop": rec.crop,
                    "crop_hi": rec.crop_hi,
                    "score": rec.score,
                    "rationale_code": rec.rationale_code,
                }
            )
        else:
            segment_b.append(
                {
                    "crop": rec.crop,
                    "crop_hi": rec.crop_hi,
                    "score": rec.score,
                    "fertiliser": asdict(rec.fertiliser),
                    "rationale_code": rec.rationale_code,
                }
            )

    return RecommendationResult(
        model_version=model_version,
        agronomy_version=cfg.agronomy_version,
        region_code=cfg.region_code,
        area_ha=float(area_ha),
        segment_a=segment_a,
        segment_b=segment_b,
        warnings=build_warnings(reading, rating, cfg),
    )
