"""Data validation: the guard that catches a corrupt dataset before training."""

from __future__ import annotations

from aaroh_ai.data.validation import validate_raw
from tests._helpers import raw


def test_real_data_is_clean():
    report = validate_raw(raw())
    assert report.ok, f"unexpected errors: {report.errors}"
    assert len(report.errors) == 0
    # the top-1 ceiling is recorded for the report to explain
    assert "argmax_soft_vs_hard_agreement" in report.stats
    assert 0.4 < report.stats["argmax_soft_vs_hard_agreement"] < 0.7


def test_bad_label_is_error():
    r = raw()
    bad = r.hard.copy()
    bad.iloc[0] = "Wheatt"  # not in the class set
    import dataclasses
    r2 = dataclasses.replace(r, hard=bad)
    report = validate_raw(r2)
    assert not report.ok
    assert any("label" in e.lower() or "class" in e.lower() for e in report.errors)


def test_soft_not_summing_is_error():
    r = raw()
    soft = r.soft.copy()
    soft.iloc[0] = soft.iloc[0] * 2.0  # row no longer sums to 1
    import dataclasses
    r2 = dataclasses.replace(r, soft=soft)
    report = validate_raw(r2)
    assert not report.ok
    assert any("sum" in e.lower() for e in report.errors)


def test_out_of_bounds_is_warning_not_error():
    r = raw()
    feats = r.features.copy()
    feats.loc[feats.index[0], "ph"] = 99.0  # implausible but not structurally invalid
    import dataclasses
    r2 = dataclasses.replace(r, features=feats)
    report = validate_raw(r2)
    assert report.ok  # still passes hard checks
    assert any("ph" in w.lower() for w in report.warnings)
