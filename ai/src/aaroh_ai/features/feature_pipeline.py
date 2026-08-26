"""The single shared transform from raw sensor columns to model features.

**This module is imported by both training and inference.** That is the whole
point: if the two sides computed features differently, the model would see one
distribution in training and another in production — train/serve skew, the
quietest and most expensive ML bug there is. There is exactly one definition of
"what the model eats," and it lives here.

What the transform does (deliberately little):

* **Renames** raw sensor columns to internal names that carry their unit, so a
  bare ``p`` can never be confused with ``p_mgkg`` (probe, elemental) or a
  future ``p_kgha`` (converted, oxide). See :data:`RAW_TO_INTERNAL`.
* **Fixes column order** to :data:`FEATURE_ORDER` so the model always receives
  features in the same positions.
* **Types the categoricals** (``soil_type``, ``season``) as pandas
  ``category`` with the *fixed* category lists learned at fit time, so
  LightGBM/XGBoost assign the same integer codes in training and serving.
* **Tolerates a missing** ``soil_temp_c`` at inference (current probe firmware
  does not log root-zone soil temperature yet). The column is created as NaN;
  GBDTs handle NaN natively, so the model simply falls back to the other
  features. No imputation — fabricating a value would inject a fake signal.

What it deliberately does **not** do: no scaling (trees are scale-invariant),
no unit *conversion* (mg/kg→kg/ha, P→P₂O₅ etc. belong to the deterministic
agronomy engine in Phase 2, not the ranker — the ranker consumes sensor-native
units because that is exactly what it will see at inference), and no field-area
logic (area is a business filter applied *after* prediction, never a feature).

``feature_spec.json`` is the serialisable contract: it pins the version, the
raw→internal map, the feature order, and the exact category lists. Inference
loads it and rebuilds an identical pipeline.
"""

from __future__ import annotations

import json
from dataclasses import dataclass, field
from datetime import UTC, datetime
from pathlib import Path

import numpy as np
import pandas as pd

SPEC_VERSION = "1.0.0"

# Raw sensor/weather column  ->  internal unit-suffixed feature name.
RAW_TO_INTERNAL: dict[str, str] = {
    "N": "n_mgkg",            # 7-in-1 probe, elemental N, mg/kg
    "P": "p_mgkg",            # 7-in-1 probe, elemental P, mg/kg
    "K": "k_mgkg",            # 7-in-1 probe, elemental K, mg/kg
    "ph": "ph",               # dimensionless (1:2.5 suspension)
    "ec": "ec_uscm",          # bulk EC, µS/cm  (÷1000 → dS/m; ECe ≈ ×4)
    "moisture": "moisture_vwc",   # % volumetric water content
    "temperature": "soil_temp_c",  # root-zone SOIL temp, °C (NOT air temp)
    "humidity": "humidity_pct",    # % relative humidity (weather API)
    "rainfall": "rainfall_mm",     # mm accumulated over the season (weather API)
    "soil_type": "soil_type",      # categorical (soil map / user)
    "season": "season",            # categorical (derived from date / user)
}

# Per-feature unit tags, kept in the spec so units travel with the model.
FEATURE_UNITS: dict[str, str] = {
    "n_mgkg": "mg/kg", "p_mgkg": "mg/kg", "k_mgkg": "mg/kg",
    "ph": "pH", "ec_uscm": "uS/cm", "moisture_vwc": "%VWC",
    "soil_temp_c": "degC", "humidity_pct": "%RH", "rainfall_mm": "mm/season",
    "soil_type": "category", "season": "category",
}

CATEGORICAL_FEATURES: tuple[str, ...] = ("soil_type", "season")

# Optional AT INFERENCE: firmware does not log soil temperature yet, so the
# pipeline must not require it when serving. It IS present in training data and
# is a legitimate feature — we train with it and degrade gracefully without it.
OPTIONAL_AT_INFERENCE: tuple[str, ...] = ("soil_temp_c",)

# The exact ordered list of columns the model receives.
FEATURE_ORDER: tuple[str, ...] = (
    "n_mgkg", "p_mgkg", "k_mgkg", "ph", "ec_uscm", "moisture_vwc",
    "soil_temp_c", "humidity_pct", "rainfall_mm", "soil_type", "season",
)

NUMERIC_FEATURES: tuple[str, ...] = tuple(
    f for f in FEATURE_ORDER if f not in CATEGORICAL_FEATURES
)


@dataclass
class TransformDiagnostics:
    """Non-fatal observations from a transform — useful at the serving edge."""

    missing_optional: list[str] = field(default_factory=list)
    unseen_categories: dict[str, list[str]] = field(default_factory=dict)

    @property
    def clean(self) -> bool:
        return not self.missing_optional and not self.unseen_categories


@dataclass
class FeaturePipeline:
    """Fitted feature contract. Cheap to build, trivial to serialise."""

    categories: dict[str, list[str]]
    spec_version: str = SPEC_VERSION
    created_at: str = field(default_factory=lambda: datetime.now(UTC).isoformat())
    source_hashes: dict[str, str] = field(default_factory=dict)

    # ---- construction -------------------------------------------------------
    @classmethod
    def fit(
        cls,
        raw_df: pd.DataFrame,
        source_hashes: dict[str, str] | None = None,
    ) -> FeaturePipeline:
        """Learn the fixed category lists for the categorical features.

        ``raw_df`` uses *raw* column names (``soil_type``, ``season``). Category
        order is sorted for determinism — it fixes the integer codes the trees
        will see, so it must be reproducible.
        """
        internal = _rename_raw(raw_df)
        categories: dict[str, list[str]] = {}
        for feat in CATEGORICAL_FEATURES:
            if feat not in internal.columns:
                raise ValueError(f"cannot fit: categorical feature '{feat}' absent from data")
            categories[feat] = sorted(internal[feat].astype(str).dropna().unique().tolist())
        return cls(categories=categories, source_hashes=dict(source_hashes or {}))

    # ---- the transform ------------------------------------------------------
    def transform(self, raw_df: pd.DataFrame) -> pd.DataFrame:
        """Raw columns → model matrix (``FEATURE_ORDER``, correct dtypes)."""
        X, _ = self.transform_with_diagnostics(raw_df)
        return X

    def transform_with_diagnostics(
        self, raw_df: pd.DataFrame
    ) -> tuple[pd.DataFrame, TransformDiagnostics]:
        """As :meth:`transform`, also returning what was missing/unseen."""
        internal = _rename_raw(raw_df)
        diag = TransformDiagnostics()
        out = pd.DataFrame(index=internal.index)

        for feat in FEATURE_ORDER:
            if feat in CATEGORICAL_FEATURES:
                continue  # handled below
            if feat in internal.columns:
                out[feat] = pd.to_numeric(internal[feat], errors="coerce").astype("float64")
            elif feat in OPTIONAL_AT_INFERENCE:
                # Firmware gap: create as NaN, let the GBDT treat it as missing.
                out[feat] = np.full(len(internal), np.nan, dtype="float64")
                diag.missing_optional.append(feat)
            else:
                raise ValueError(
                    f"required feature '{feat}' is absent from the input and is "
                    "not optional-at-inference"
                )

        for feat in CATEGORICAL_FEATURES:
            cats = self.categories.get(feat)
            if cats is None:
                raise ValueError(f"pipeline was not fitted for categorical '{feat}'")
            if feat not in internal.columns:
                raise ValueError(f"required categorical '{feat}' is absent from the input")
            values = internal[feat].astype(str)
            seen = set(values.dropna().unique())
            unseen = sorted(seen - set(cats))
            if unseen:
                # Unknown category → NaN code (missing), never a silent remap.
                diag.unseen_categories[feat] = unseen
            # Build from a plain ndarray, not the Series: on pandas 3.x the string
            # dtype attached to the Series makes ``pd.Categorical(series, ...)`` emit
            # a FutureWarning about dtype inference. ``.to_numpy()`` yields an object
            # array of str, which constructs the identical codes with no warning.
            out[feat] = pd.Categorical(values.to_numpy(), categories=cats)

        return out[list(FEATURE_ORDER)], diag

    def transform_record(self, record: dict[str, object]) -> pd.DataFrame:
        """Convenience for a single inference payload (a dict of raw columns)."""
        return self.transform(pd.DataFrame([record]))

    def categorical_indices(self) -> list[int]:
        """Positions of the categorical columns in ``FEATURE_ORDER`` (for XGBoost)."""
        return [FEATURE_ORDER.index(f) for f in CATEGORICAL_FEATURES]

    # ---- serialisation ------------------------------------------------------
    def to_spec(self) -> dict[str, object]:
        return {
            "spec_version": self.spec_version,
            "created_at": self.created_at,
            "raw_to_internal": RAW_TO_INTERNAL,
            "feature_order": list(FEATURE_ORDER),
            "numeric_features": list(NUMERIC_FEATURES),
            "categorical_features": list(CATEGORICAL_FEATURES),
            "optional_at_inference": list(OPTIONAL_AT_INFERENCE),
            "categorical_categories": self.categories,
            "units": FEATURE_UNITS,
            "source_hashes": self.source_hashes,
            "notes": (
                "Ranker consumes sensor-native units; unit CONVERSION "
                "(mg/kg->kg/ha, P->P2O5, K->K2O, uS/cm->dS/m) is the agronomy "
                "engine's job (Phase 2), not this pipeline. soil_temp_c may be "
                "missing at inference (firmware gap) and is passed as NaN."
            ),
        }

    def save(self, path: str | Path) -> Path:
        path = Path(path)
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps(self.to_spec(), indent=2, sort_keys=False))
        return path

    @classmethod
    def load(cls, path: str | Path) -> FeaturePipeline:
        spec = json.loads(Path(path).read_text())
        if spec.get("spec_version") != SPEC_VERSION:
            # Loud on purpose: a spec from a different feature contract must not
            # be silently used to serve a model trained under another.
            raise ValueError(
                f"feature_spec version mismatch: file={spec.get('spec_version')} "
                f"code={SPEC_VERSION}. Re-train or check out the matching code."
            )
        if list(spec.get("feature_order", [])) != list(FEATURE_ORDER):
            raise ValueError("feature_spec feature_order does not match this code version")
        return cls(
            categories={k: list(v) for k, v in spec["categorical_categories"].items()},
            spec_version=spec["spec_version"],
            created_at=spec.get("created_at", ""),
            source_hashes=spec.get("source_hashes", {}),
        )


def _rename_raw(raw_df: pd.DataFrame) -> pd.DataFrame:
    """Map any present raw column names to internal names (idempotent).

    Accepts frames that already use internal names, so callers may pass either.
    """
    rename = {raw: internal for raw, internal in RAW_TO_INTERNAL.items() if raw in raw_df.columns}
    return raw_df.rename(columns=rename)
