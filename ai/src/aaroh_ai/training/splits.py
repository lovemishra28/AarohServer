"""Deterministic, seeded train/validation/test splits.

Stratified by the hard label so every crop is represented in each fold in
roughly its natural proportion. Given the same seed and ratios, the split is
byte-for-byte reproducible — the same guarantee that lets a registered model's
metrics be re-derived later.

**When real field data arrives, switch to a grouped split** (group by field id):
multiple readings from the same field must not straddle train and test, or the
model will look better than it is (spatial leakage). The synthetic v2 data has
no field id, so stratified-by-label is correct *for now* — this is called out
in ADR-0002.
"""

from __future__ import annotations

from dataclasses import dataclass

import numpy as np


@dataclass(frozen=True)
class Split:
    train: np.ndarray
    val: np.ndarray
    test: np.ndarray

    def sizes(self) -> dict[str, int]:
        return {"train": len(self.train), "val": len(self.val), "test": len(self.test)}


def stratified_split(
    y: np.ndarray,
    seed: int = 42,
    ratios: tuple[float, float, float] = (0.70, 0.15, 0.15),
) -> Split:
    """Split indices ``0..len(y)-1`` into train/val/test, stratified by ``y``.

    ``ratios`` must sum to 1. Within each class the indices are shuffled with a
    seeded RNG and sliced by the cumulative ratios, so class balance is held
    across folds and the result is deterministic.
    """
    if abs(sum(ratios) - 1.0) > 1e-9:
        raise ValueError(f"ratios must sum to 1, got {ratios} (sum={sum(ratios)})")
    rng = np.random.default_rng(seed)
    y = np.asarray(y)
    train_parts, val_parts, test_parts = [], [], []

    for cls in np.unique(y):
        idx = np.where(y == cls)[0]
        rng.shuffle(idx)
        n = len(idx)
        n_train = int(round(n * ratios[0]))
        n_val = int(round(n * ratios[1]))
        # test gets the remainder so the three always cover the class exactly
        train_parts.append(idx[:n_train])
        val_parts.append(idx[n_train:n_train + n_val])
        test_parts.append(idx[n_train + n_val:])

    train = np.concatenate(train_parts)
    val = np.concatenate(val_parts)
    test = np.concatenate(test_parts)
    # Shuffle across classes so downstream batching isn't class-ordered.
    for arr in (train, val, test):
        rng.shuffle(arr)

    # No index is lost or duplicated — a cheap invariant worth asserting.
    assert len(train) + len(val) + len(test) == len(y)
    assert len(set(train.tolist()) | set(val.tolist()) | set(test.tolist())) == len(y)
    return Split(train=train, val=val, test=test)
