"""ONNX export: the pure encoding + the guard that refuses LTR export.

The actual conversion (onnxmltools/skl2onnx) and onnxruntime parity check need
those libraries and a fitted tree model, so they are exercised on the user's
machine, not here. What is unit-testable without them lives in this file.
"""

from __future__ import annotations

import tempfile
from pathlib import Path
from types import SimpleNamespace

import numpy as np

from aaroh_ai.export.onnx_export import (
    CLASSIFIER_OBJECTIVES,
    export_to_onnx,
    to_float_matrix,
)
from aaroh_ai.features.feature_pipeline import CATEGORICAL_FEATURES, FEATURE_ORDER
from tests._helpers import fitted_pipeline, raw


def test_to_float_matrix_shape_and_codes():
    pipe = fitted_pipeline()
    X = pipe.transform(raw().features.iloc[:5])
    M = to_float_matrix(X)
    assert M.shape == (5, len(FEATURE_ORDER))
    assert M.dtype == np.float32
    # categorical columns are integer codes (>= -1), not the raw strings
    cat_cols = [FEATURE_ORDER.index(c) for c in CATEGORICAL_FEATURES]
    assert np.all(M[:, cat_cols] >= -1)


def test_to_float_matrix_rejects_wrong_columns():
    pipe = fitted_pipeline()
    X = pipe.transform(raw().features.iloc[:3]).drop(columns=["season"])
    try:
        to_float_matrix(X)
        raise AssertionError("expected ValueError for wrong column set")
    except ValueError:
        pass


def test_classifier_objectives_set():
    assert CLASSIFIER_OBJECTIVES == {"multiclass", "multi:softprob"}


def test_export_refuses_ltr_objective():
    # The LTR guard fires before any onnx import, so no heavy deps are needed.
    fake = SimpleNamespace(objective="lambdarank", framework="lightgbm")
    pipe = fitted_pipeline()
    X = pipe.transform(raw().features.iloc[:3])
    out = Path(tempfile.mkdtemp()) / "model.onnx"
    try:
        export_to_onnx(fake, X, out)
        raise AssertionError("expected NotImplementedError for lambdarank")
    except NotImplementedError as e:
        assert "learning-to-rank" in str(e)
    assert not out.exists()  # nothing written on refusal
