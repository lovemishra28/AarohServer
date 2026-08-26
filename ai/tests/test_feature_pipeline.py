"""Feature pipeline: the anti-skew contract — dtypes, ordering, NaN tolerance."""

from __future__ import annotations

import json
import tempfile
from pathlib import Path

import pandas as pd

from aaroh_ai.features.feature_pipeline import (
    FEATURE_ORDER,
    FeaturePipeline,
)


def _df() -> pd.DataFrame:
    return pd.DataFrame({
        "N": [100.0, 120.0], "P": [10.0, 12.0], "K": [150.0, 160.0],
        "temperature": [25.0, 26.0], "humidity": [60.0, 65.0], "ph": [6.5, 7.0],
        "ec": [300.0, 320.0], "moisture": [30.0, 35.0], "rainfall": [100.0, 120.0],
        "soil_type": ["Red", "Black"], "season": ["Rabi", "Kharif"],
    })


def test_fit_learns_sorted_categories():
    pipe = FeaturePipeline.fit(_df())
    assert pipe.categories["soil_type"] == ["Black", "Red"]      # sorted
    assert pipe.categories["season"] == ["Kharif", "Rabi"]       # sorted


def test_transform_order_and_dtypes():
    pipe = FeaturePipeline.fit(_df())
    X = pipe.transform(_df())
    assert list(X.columns) == list(FEATURE_ORDER)
    assert str(X["n_mgkg"].dtype) == "float64"
    assert str(X["soil_type"].dtype) == "category"
    assert str(X["season"].dtype) == "category"
    # temperature present → soil_temp_c populated, not NaN
    assert not X["soil_temp_c"].isna().any()


def test_soil_temp_c_missing_is_tolerated():
    pipe = FeaturePipeline.fit(_df())
    X, diag = pipe.transform_with_diagnostics(_df().drop(columns=["temperature"]))
    assert X["soil_temp_c"].isna().all()          # created as NaN, no imputation
    assert "soil_temp_c" in diag.missing_optional
    assert not diag.clean


def test_unseen_category_becomes_nan_code():
    pipe = FeaturePipeline.fit(_df())
    df = _df()
    df.loc[0, "soil_type"] = "Laterite"           # not seen at fit
    X, diag = pipe.transform_with_diagnostics(df)
    assert diag.unseen_categories.get("soil_type") == ["Laterite"]
    assert X["soil_type"].cat.codes.iloc[0] == -1  # missing, never silently remapped


def test_categorical_indices():
    pipe = FeaturePipeline.fit(_df())
    assert pipe.categorical_indices() == [9, 10]


def test_missing_required_feature_raises():
    pipe = FeaturePipeline.fit(_df())
    try:
        pipe.transform(_df().drop(columns=["ph"]))
        raise AssertionError("expected ValueError for missing required feature")
    except ValueError as e:
        assert "ph" in str(e)


def test_transform_record_single_row():
    pipe = FeaturePipeline.fit(_df())
    rec = {c: _df().iloc[0][c] for c in _df().columns}
    X = pipe.transform_record(rec)
    assert len(X) == 1 and list(X.columns) == list(FEATURE_ORDER)


def test_save_load_roundtrip_and_version_guard():
    pipe = FeaturePipeline.fit(_df())
    d = Path(tempfile.mkdtemp())
    p = d / "feature_spec.json"
    pipe.save(p)
    loaded = FeaturePipeline.load(p)
    assert loaded.categories == pipe.categories
    assert list(pd.Index(FEATURE_ORDER)) == list(FEATURE_ORDER)

    # Tampering the spec version must make load() refuse.
    spec = json.loads(p.read_text())
    spec["spec_version"] = "9.9.9"
    p.write_text(json.dumps(spec))
    try:
        FeaturePipeline.load(p)
        raise AssertionError("expected version-mismatch ValueError")
    except ValueError as e:
        assert "version" in str(e).lower()
