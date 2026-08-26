"""Golden tests: case generation counts + the check-evaluation harness logic."""

from __future__ import annotations

import numpy as np

from aaroh_ai.evaluation.golden import (
    GoldenCase,
    build_golden_cases,
    build_median_cases,
    hand_rules,
    run_golden,
)
from tests._helpers import fitted_pipeline, raw


def _rec(soil="Black", season="Rabi") -> dict:
    return dict(N=120, P=10, K=160, temperature=25.0, humidity=60, ph=6.8,
               ec=300, moisture=30, rainfall=110, soil_type=soil, season=season)


def test_case_counts():
    r = raw()
    assert len(build_median_cases(r)) == r.n_classes == 20
    assert len(hand_rules()) == 4
    assert len(build_golden_cases(r)) == 24


def test_median_case_structure():
    r = raw()
    case = build_median_cases(r)[0]
    for col in ("N", "P", "K", "temperature", "humidity", "ph", "ec",
                "moisture", "rainfall", "soil_type", "season"):
        assert col in case.raw_record
    assert case.expect_top_k and case.expect_top_k[0][1] == 5


def test_run_golden_harness_logic():
    pipe = fitted_pipeline()
    classes = ("Rice", "Wheat", "Maize")
    cases = [
        GoldenCase("rice_first", _rec(), "row0 puts Rice first", expect_top_k=[("Rice", 1)]),
        GoldenCase("wheat_wins", _rec(), "row1 puts Wheat first",
                   forbid_top_k=[("Rice", 1)], expect_any_top_k=(["Wheat", "Maize"], 1)),
        GoldenCase("impossible", _rec(), "row2 ranks Maize last but we demand top-1",
                   expect_top_k=[("Maize", 1)]),
    ]

    # A stub predictor with fixed, known rankings per row.
    fixed = np.array([[0.6, 0.3, 0.1],   # Rice, Wheat, Maize
                      [0.2, 0.7, 0.1],   # Wheat first
                      [0.5, 0.4, 0.1]])  # Maize last

    def stub_predict(X):
        return fixed[: len(X)]

    report = run_golden(cases, stub_predict, pipe, classes)
    by_name = {r.name: r for r in report.results}
    assert by_name["rice_first"].passed
    assert by_name["wheat_wins"].passed
    assert not by_name["impossible"].passed
    assert report.n_passed == 2 and report.n_total == 3
    assert not report.passed
    assert [r.name for r in report.failures()] == ["impossible"]
    # top5 is surfaced for explainability
    assert by_name["rice_first"].top5[0][0] == "Rice"
