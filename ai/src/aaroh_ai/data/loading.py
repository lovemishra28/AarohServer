"""Load and align the immutable raw training data.

Two row-aligned files under ``datasets/raw`` are the only inputs to training:

* ``master_crop_training_data_v2.csv`` — the feature table plus a ``crop``
  column that is the **hard label** (a *sample* from the soft distribution,
  not its argmax — see ``SOURCE.md``).
* ``crop_soft_labels_v2.csv`` — the row-aligned probability distribution over
  the 20 crops. This is the ranker's real target.

The class order is defined **here**, once, by :data:`CROP_CLASSES`, and every
downstream array (prediction vectors, confusion matrix, registry metrics) uses
this order. The soft-label CSV is re-ordered to match on load, so a future file
that lists columns differently cannot silently scramble the classes.
"""

from __future__ import annotations

import hashlib
from dataclasses import dataclass
from pathlib import Path

import numpy as np
import pandas as pd

# --- canonical class order (soft-label column order in v2) -------------------
# Source of truth for the whole subsystem. Inference relies on this without
# reading the CSV, so it must never be reordered — only appended to for a new
# data version, and even then with a version bump.
CROP_CLASSES: tuple[str, ...] = (
    "Rice", "Wheat", "Maize", "Bajra", "Jowar", "Ragi", "Soybean", "Groundnut",
    "Chickpea", "Arhar", "Moong", "Urad", "Mustard", "Cotton", "Sugarcane",
    "Jute", "Potato", "Tomato", "Onion", "Garlic",
)

# Raw feature columns we actually feed the pipeline (order as in the CSV).
# ``crop`` is the hard label and is handled separately.
RAW_FEATURE_COLUMNS: tuple[str, ...] = (
    "N", "P", "K", "temperature", "humidity", "ph", "ec", "moisture",
    "rainfall", "soil_type", "season",
)
HARD_LABEL_COLUMN = "crop"

FEATURES_FILENAME = "master_crop_training_data_v2.csv"
SOFT_LABELS_FILENAME = "crop_soft_labels_v2.csv"
RANGES_FILENAME = "crop_ranges_v2.md"


def default_raw_dir() -> Path:
    """Locate ``ai/datasets/raw`` relative to this file (parents[3] == ``ai``)."""
    return Path(__file__).resolve().parents[3] / "datasets" / "raw"


def sha256_file(path: str | Path) -> str:
    """Streaming SHA-256 of a file — used as the reproducibility ``dataset_hash``."""
    h = hashlib.sha256()
    with open(path, "rb") as fh:
        for block in iter(lambda: fh.read(1 << 20), b""):
            h.update(block)
    return h.hexdigest()


@dataclass(frozen=True)
class RawData:
    """The aligned raw inputs plus the hashes that make a run reproducible.

    ``features`` holds only :data:`RAW_FEATURE_COLUMNS` (no label). ``hard``
    is the sampled single-crop label. ``soft`` is the (n, 20) distribution with
    columns in :data:`CROP_CLASSES` order.
    """

    features: pd.DataFrame
    hard: pd.Series
    soft: pd.DataFrame
    classes: tuple[str, ...]
    features_sha256: str
    soft_sha256: str

    @property
    def n_rows(self) -> int:
        return len(self.features)

    @property
    def n_classes(self) -> int:
        return len(self.classes)

    def hard_indices(self) -> np.ndarray:
        """Hard labels as integer class indices into :attr:`classes`."""
        lookup = {c: i for i, c in enumerate(self.classes)}
        return self.hard.map(lookup).to_numpy(dtype=np.int64)

    def soft_matrix(self) -> np.ndarray:
        """Soft labels as a plain ``float64`` array in class order."""
        return self.soft.to_numpy(dtype=np.float64)


def load_raw(data_dir: str | Path | None = None) -> RawData:
    """Read and align the two raw CSVs into a :class:`RawData`.

    Raises ``FileNotFoundError`` if a file is missing and ``ValueError`` if the
    two files are not row-aligned or the soft-label columns are not exactly the
    20 known classes.
    """
    raw_dir = Path(data_dir) if data_dir is not None else default_raw_dir()
    feat_path = raw_dir / FEATURES_FILENAME
    soft_path = raw_dir / SOFT_LABELS_FILENAME
    for p in (feat_path, soft_path):
        if not p.exists():
            raise FileNotFoundError(f"raw data file not found: {p}")

    master = pd.read_csv(feat_path)
    soft = pd.read_csv(soft_path)

    if len(master) != len(soft):
        raise ValueError(
            f"feature/soft-label row mismatch: {len(master)} vs {len(soft)} — "
            "the two files are not row-aligned."
        )

    missing_cols = [c for c in (*RAW_FEATURE_COLUMNS, HARD_LABEL_COLUMN) if c not in master.columns]
    if missing_cols:
        raise ValueError(f"feature file is missing columns: {missing_cols}")

    soft_cols = set(soft.columns)
    expected = set(CROP_CLASSES)
    if soft_cols != expected:
        raise ValueError(
            "soft-label columns do not match the 20 known classes. "
            f"missing={sorted(expected - soft_cols)} extra={sorted(soft_cols - expected)}"
        )

    # Re-order to the canonical class order (defensive: never trust CSV order).
    soft = soft[list(CROP_CLASSES)].astype(np.float64)
    features = master[list(RAW_FEATURE_COLUMNS)].copy()
    hard = master[HARD_LABEL_COLUMN].astype(str)

    return RawData(
        features=features,
        hard=hard,
        soft=soft,
        classes=CROP_CLASSES,
        features_sha256=sha256_file(feat_path),
        soft_sha256=sha256_file(soft_path),
    )
