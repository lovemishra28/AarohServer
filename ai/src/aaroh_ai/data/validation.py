"""Data tests — fail loudly on the corruptions that quietly poison a model.

Validation runs at the top of every training run. Hard violations (missing
columns, nulls, labels outside the class set, soft rows that do not sum to 1)
raise; physically implausible values are collected as warnings so a human
decides. The philosophy mirrors the DB ``CHECK`` constraints in the server
guide (§5.4): reject impossible frames rather than train on them.
"""

from __future__ import annotations

from dataclasses import dataclass, field

import numpy as np

from .loading import RAW_FEATURE_COLUMNS, RawData

# Numeric raw columns and the range beyond which a value is *implausible*.
# These are guard rails, not the model's opinion — a value outside the band is
# almost certainly a unit slip or a broken sensor frame. Bounds are generous on
# purpose (the salinity-ceiling design produces legitimately high `ec`, and
# ponded paddy reads ~95 %VWC). See generate_crop_data_v2.py for the semantics.
PLAUSIBLE_BOUNDS: dict[str, tuple[float, float]] = {
    "N": (0.0, 500.0),          # mg/kg
    "P": (0.0, 100.0),          # mg/kg
    "K": (0.0, 800.0),          # mg/kg
    "temperature": (-10.0, 60.0),  # °C root-zone soil temp
    "humidity": (0.0, 100.0),   # % RH
    "ph": (3.0, 10.0),          # matches DB CHECK (ph BETWEEN 3 AND 10)
    "ec": (0.0, 20000.0),       # µS/cm bulk (ECe ≈ ×4; saline soils reach here)
    "moisture": (0.0, 100.0),   # % VWC
    "rainfall": (0.0, 6000.0),  # mm/season
}
CATEGORICAL_COLUMNS = ("soil_type", "season")
KNOWN_SEASONS = frozenset({"Kharif", "Rabi", "Zaid"})

SOFT_SUM_ATOL = 1e-3  # v2 rows sum to 1 ± ~3e-5 (rounding to 5 dp)


@dataclass
class ValidationReport:
    """Outcome of :func:`validate_raw`. ``ok`` is False iff there are errors."""

    errors: list[str] = field(default_factory=list)
    warnings: list[str] = field(default_factory=list)
    stats: dict[str, object] = field(default_factory=dict)

    @property
    def ok(self) -> bool:
        return not self.errors

    def raise_if_failed(self) -> ValidationReport:
        if self.errors:
            raise ValueError(
                "raw data validation failed:\n  - " + "\n  - ".join(self.errors)
            )
        return self

    def __str__(self) -> str:  # human-readable summary for logs/reports
        lines = [f"validation: {'OK' if self.ok else 'FAILED'} "
                 f"({len(self.errors)} errors, {len(self.warnings)} warnings)"]
        for e in self.errors:
            lines.append(f"  ERROR   {e}")
        for w in self.warnings:
            lines.append(f"  WARN    {w}")
        return "\n".join(lines)


def validate_raw(raw: RawData) -> ValidationReport:
    """Check structural and physical integrity of the aligned raw data."""
    rep = ValidationReport()
    feats = raw.features
    n = len(feats)
    rep.stats["n_rows"] = n
    rep.stats["n_classes"] = raw.n_classes

    # --- structure: required columns present --------------------------------
    for col in RAW_FEATURE_COLUMNS:
        if col not in feats.columns:
            rep.errors.append(f"missing required feature column '{col}'")
    if rep.errors:
        return rep  # nothing else is meaningful without the columns

    # --- nulls (hard error: GBDTs tolerate NaN features, but a NULL in a raw
    #     frame means an ingest bug, and a NULL label is unusable) -----------
    for col in RAW_FEATURE_COLUMNS:
        nulls = int(feats[col].isna().sum())
        if nulls:
            rep.errors.append(f"column '{col}' has {nulls} null(s)")
    if int(raw.hard.isna().sum()):
        rep.errors.append(f"hard label has {int(raw.hard.isna().sum())} null(s)")
    if int(raw.soft.isna().to_numpy().sum()):
        rep.errors.append("soft-label matrix contains null(s)")

    # --- numeric coercibility + physical plausibility -----------------------
    for col, (lo, hi) in PLAUSIBLE_BOUNDS.items():
        series = feats[col]
        if not np.issubdtype(series.dtype, np.number):
            rep.errors.append(f"column '{col}' is not numeric (dtype={series.dtype})")
            continue
        below = int((series < lo).sum())
        above = int((series > hi).sum())
        if below or above:
            rep.warnings.append(
                f"column '{col}': {below} below {lo} and {above} above {hi} "
                f"(range observed {series.min():.3g}..{series.max():.3g})"
            )

    # --- categoricals -------------------------------------------------------
    seasons = set(feats["season"].astype(str).unique())
    unknown_seasons = seasons - KNOWN_SEASONS
    if unknown_seasons:
        rep.warnings.append(f"unexpected season value(s): {sorted(unknown_seasons)}")
    rep.stats["soil_types"] = sorted(feats["soil_type"].astype(str).unique())
    rep.stats["seasons"] = sorted(seasons)

    # --- labels within the class set ----------------------------------------
    classes = set(raw.classes)
    bad_hard = sorted(set(raw.hard.astype(str).unique()) - classes)
    if bad_hard:
        rep.errors.append(f"hard label has crops outside the class set: {bad_hard}")

    # --- soft labels: valid probability rows --------------------------------
    soft = raw.soft_matrix()
    if soft.min() < -1e-9 or soft.max() > 1.0 + 1e-9:
        rep.errors.append(
            f"soft labels outside [0,1] (min={soft.min():.4g}, max={soft.max():.4g})"
        )
    row_sums = soft.sum(axis=1)
    bad_rows = int(np.sum(np.abs(row_sums - 1.0) > SOFT_SUM_ATOL))
    if bad_rows:
        rep.errors.append(
            f"{bad_rows} soft-label row(s) do not sum to 1 within {SOFT_SUM_ATOL} "
            f"(sum range {row_sums.min():.5f}..{row_sums.max():.5f})"
        )
    rep.stats["soft_row_sum_min"] = float(row_sums.min())
    rep.stats["soft_row_sum_max"] = float(row_sums.max())

    # --- the top-1 ceiling: how often argmax(soft) == hard ------------------
    # Recorded (not enforced) so every run reprints the number the eval report
    # leans on to explain why top-1-vs-hard tops out around 0.55. Skipped when
    # the hard labels are invalid — the statistic would be meaningless (and the
    # index cast would warn) on labels outside the class set.
    if not bad_hard:
        argmax_soft = soft.argmax(axis=1)
        agreement = float(np.mean(argmax_soft == raw.hard_indices()))
        rep.stats["argmax_soft_vs_hard_agreement"] = agreement

    return rep
