"""Load and validate a region's agronomy configuration.

A *region config* is the single source of truth for every domain number the
deterministic fertiliser engine uses: unit-conversion factors, fertiliser
grades and prices, soil-test rating thresholds, the dose model, and the
per-crop recommended dose (RDF) table with Hindi names. It is **versioned data,
not code** — bundled as JSON under ``regions/<region>/<version>.json`` with a
``manifest.json`` naming the active version.

Why bundle it in the Python package instead of reading it from Postgres? So the
engine, the golden tests, and the CLI all run **without a database or Docker** —
the Phase-2 checkpoint requires exactly that. Node seeds the identical values
into Postgres for the API path; this file is the authority both sides mirror.

Loading is deliberately strict: an unknown crop, a missing product, or a
malformed threshold raises at load time rather than producing a silently wrong
recommendation later. The 20 canonical crops are asserted present and in the
frozen soft-label order.
"""

from __future__ import annotations

import json
import os
from dataclasses import dataclass
from pathlib import Path

# The frozen soft-label crop order (mirrors the ranker's classes). The region
# config must define exactly these, so a dropped/renamed crop fails loudly.
CANONICAL_CROPS: tuple[str, ...] = (
    "Rice", "Wheat", "Maize", "Bajra", "Jowar", "Ragi", "Soybean", "Groundnut",
    "Chickpea", "Arhar", "Moong", "Urad", "Mustard", "Cotton", "Sugarcane",
    "Jute", "Potato", "Tomato", "Onion", "Garlic",
)

_SOIL_CLASSES: tuple[str, ...] = ("Low", "Medium", "High")

# Env override for the regions directory (tests / alternate deployments).
_ENV_CONFIG_DIR = "AAROH_REGION_CONFIG_DIR"


@dataclass(frozen=True)
class Product:
    """A purchasable fertiliser: its guaranteed grade (oxide %) and pack price."""

    name: str
    n_pct: float
    p2o5_pct: float
    k2o_pct: float
    inr_per_bag: float


@dataclass(frozen=True)
class CropSpec:
    """One crop's Hindi name and recommended dose (RDF) in oxide kg/ha."""

    name: str
    hi: str
    rdf_n_kgha: float       # elemental N
    rdf_p2o5_kgha: float    # oxide P2O5
    rdf_k2o_kgha: float     # oxide K2O


@dataclass(frozen=True)
class RatingBand:
    """Soil-test class limits (elemental kg/ha). value<low_max=Low; <med_max=Medium; else High."""

    low_max: float
    med_max: float


@dataclass(frozen=True)
class RegionConfig:
    """Fully-parsed, validated region configuration — immutable once loaded."""

    region_code: str
    version: str
    agronomy_version: str
    provisional: bool

    mgkg_to_kgha: float
    p_to_p2o5: float
    k_to_k2o: float

    bag_kg: float
    rounding: str

    products: dict[str, Product]
    rating_n: RatingBand    # elemental N kg/ha
    rating_p: RatingBand    # elemental P kg/ha (Olsen)
    rating_k: RatingBand    # elemental K kg/ha

    class_multiplier: dict[str, float]
    legumes: frozenset[str]
    crops: dict[str, CropSpec]
    review_required: tuple[str, ...]

    # ---- convenience accessors ---------------------------------------------
    def crop(self, name: str) -> CropSpec:
        try:
            return self.crops[name]
        except KeyError:
            raise KeyError(
                f"crop '{name}' is not defined in region '{self.region_code}' "
                f"config {self.version}"
            ) from None

    def is_legume(self, crop: str) -> bool:
        return crop in self.legumes


# --------------------------------------------------------------------------- #
# Loading
# --------------------------------------------------------------------------- #
def _regions_base_dir() -> Path:
    """Directory that holds the per-region config folders.

    Overridable via ``$AAROH_REGION_CONFIG_DIR`` so tests and alternate
    deployments can point at their own bundle; otherwise resolves relative to
    this file (``.../services/agronomy/regions``).
    """
    override = os.environ.get(_ENV_CONFIG_DIR)
    if override:
        return Path(override)
    return Path(__file__).resolve().parent / "regions"


def _active_version(region_dir: Path) -> str:
    manifest = region_dir / "manifest.json"
    if not manifest.is_file():
        raise FileNotFoundError(f"no manifest.json in {region_dir}")
    data = json.loads(manifest.read_text(encoding="utf-8"))
    version = data.get("active_version")
    if not version:
        raise ValueError(f"manifest.json in {region_dir} has no 'active_version'")
    return str(version)


def _band(raw: dict, key: str) -> RatingBand:
    b = raw[key]
    return RatingBand(low_max=float(b["low_max"]), med_max=float(b["med_max"]))


def load_region_config(
    region_code: str = "chambal",
    version: str | None = None,
    base_dir: str | Path | None = None,
) -> RegionConfig:
    """Load, parse, and validate a region config.

    ``version=None`` reads the region's ``manifest.json`` for the active
    version. Raises ``FileNotFoundError`` / ``ValueError`` / ``KeyError`` on any
    structural problem — we fail at load, never mid-recommendation.
    """
    base = Path(base_dir) if base_dir is not None else _regions_base_dir()
    region_dir = base / region_code
    if not region_dir.is_dir():
        raise FileNotFoundError(
            f"region '{region_code}' not found under {base} "
            f"(set ${_ENV_CONFIG_DIR} to override the config directory)"
        )

    resolved_version = version or _active_version(region_dir)
    cfg_path = region_dir / f"{resolved_version}.json"
    if not cfg_path.is_file():
        raise FileNotFoundError(f"region config file missing: {cfg_path}")

    raw = json.loads(cfg_path.read_text(encoding="utf-8"))
    meta = raw.get("_meta", {})
    factors = raw["factors"]

    # Products ---------------------------------------------------------------
    products: dict[str, Product] = {}
    for name, p in raw["products"].items():
        if name.startswith("_"):
            continue  # skip note keys
        products[name] = Product(
            name=name,
            n_pct=float(p["n_pct"]),
            p2o5_pct=float(p["p2o5_pct"]),
            k2o_pct=float(p["k2o_pct"]),
            inr_per_bag=float(p["inr_per_bag"]),
        )
    for required in ("Urea", "DAP", "MOP"):
        if required not in products:
            raise ValueError(f"region config missing required product '{required}'")

    # Dose model -------------------------------------------------------------
    dose_model = raw["dose_model"]
    class_multiplier = {k: float(v) for k, v in dose_model["class_multiplier"].items()}
    for cls in _SOIL_CLASSES:
        if cls not in class_multiplier:
            raise ValueError(f"dose_model.class_multiplier missing soil class '{cls}'")

    # Crops ------------------------------------------------------------------
    crops: dict[str, CropSpec] = {}
    for name, c in raw["crops"].items():
        rdf = c["rdf_kgha"]
        crops[name] = CropSpec(
            name=name,
            hi=str(c["hi"]),
            rdf_n_kgha=float(rdf["n"]),
            rdf_p2o5_kgha=float(rdf["p2o5"]),
            rdf_k2o_kgha=float(rdf["k2o"]),
        )
    missing = [c for c in CANONICAL_CROPS if c not in crops]
    if missing:
        raise ValueError(
            f"region config is missing canonical crops: {missing} "
            f"(all {len(CANONICAL_CROPS)} must be defined)"
        )

    soil = raw["soil_rating"]

    return RegionConfig(
        region_code=str(meta.get("region_code", region_code)),
        version=str(meta.get("version", resolved_version)),
        agronomy_version=str(meta.get("agronomy_version", f"{region_code}@{resolved_version}")),
        provisional=bool(meta.get("provisional", False)),
        mgkg_to_kgha=float(factors["mgkg_to_kgha"]),
        p_to_p2o5=float(factors["p_to_p2o5"]),
        k_to_k2o=float(factors["k_to_k2o"]),
        bag_kg=float(raw["bag_kg"]),
        rounding=str(raw["rounding"]),
        products=products,
        rating_n=_band(soil, "n_kgha"),
        rating_p=_band(soil, "p_kgha"),
        rating_k=_band(soil, "k_kgha"),
        class_multiplier=class_multiplier,
        legumes=frozenset(raw.get("legumes", [])),
        crops=crops,
        review_required=tuple(meta.get("review_required", [])),
    )
