"""Agronomic golden tests — behaviour a domain expert would insist on.

Two kinds of case:

* **Median exemplars** (auto-generated, one per crop): take the median of each
  numeric feature over the rows the data labels as crop *X*, plus that crop's
  most common soil type and season, and assert the model ranks *X* within the
  top-k. A median exemplar of a crop failing to recall its own crop is a red
  flag — this is the regression tripwire.
* **Hand-authored domain rules**: a few explicit agronomic expectations
  (paddy on wet clay, a Rabi pulse in an arid winter profile, the confusable
  pulse pair Moong/Urad), each with a written rationale.

Every case runs against a ``predict_proba`` callable, so the same suite scores
LightGBM, XGBoost, or the dummy. The report shows each case, its rationale, and
the model's actual top-5 — so you really can "explain every confusion pair."
"""

from __future__ import annotations

from dataclasses import dataclass, field

import numpy as np
import pandas as pd

from aaroh_ai.data.loading import RawData

NUMERIC_RAW = ("N", "P", "K", "temperature", "humidity", "ph", "ec", "moisture", "rainfall")


@dataclass
class GoldenCase:
    name: str
    raw_record: dict[str, object]
    rationale: str
    # (crop, k): crop must appear within the top k
    expect_top_k: list[tuple[str, int]] = field(default_factory=list)
    # (crop, k): crop must NOT appear within the top k
    forbid_top_k: list[tuple[str, int]] = field(default_factory=list)
    # (crops, k): at least one of these crops within the top k
    expect_any_top_k: tuple[list[str], int] | None = None


@dataclass
class GoldenResult:
    name: str
    passed: bool
    rationale: str
    checks: list[str]
    top5: list[tuple[str, float]]


@dataclass
class GoldenReport:
    results: list[GoldenResult]

    @property
    def n_total(self) -> int:
        return len(self.results)

    @property
    def n_passed(self) -> int:
        return sum(r.passed for r in self.results)

    @property
    def passed(self) -> bool:
        return self.n_passed == self.n_total

    def failures(self) -> list[GoldenResult]:
        return [r for r in self.results if not r.passed]


def build_median_cases(raw: RawData, top_k: int = 5) -> list[GoldenCase]:
    """One 'median exemplar → recalls its own crop' case per crop."""
    df = raw.features.copy()
    df["__crop"] = raw.hard.to_numpy()
    cases: list[GoldenCase] = []
    for crop in raw.classes:
        sub = df[df["__crop"] == crop]
        if sub.empty:
            continue
        rec: dict[str, object] = {col: float(sub[col].median()) for col in NUMERIC_RAW}
        rec["soil_type"] = str(sub["soil_type"].mode().iloc[0])
        rec["season"] = str(sub["season"].mode().iloc[0])
        cases.append(
            GoldenCase(
                name=f"median::{crop}",
                raw_record=rec,
                rationale=f"A median-profile {crop} field should recall {crop} within top-{top_k}.",
                expect_top_k=[(crop, top_k)],
            )
        )
    return cases


def hand_rules() -> list[GoldenCase]:
    """A few explicit agronomic expectations, independent of the median cases."""
    return [
        GoldenCase(
            name="paddy_wet_clay",
            raw_record=dict(N=140, P=9, K=185, temperature=27.5, humidity=80,
                            ph=6.9, ec=430, moisture=78, rainfall=700,
                            soil_type="Clayey", season="Kharif"),
            rationale="Ponded clay, high moisture and monsoon rainfall is the classic paddy niche.",
            expect_top_k=[("Rice", 3)],
        ),
        GoldenCase(
            name="arid_rabi_pulse",
            raw_record=dict(N=106, P=10, K=72, temperature=18.8, humidity=60,
                            ph=6.8, ec=234, moisture=17, rainfall=90,
                            soil_type="Red", season="Rabi"),
            rationale=(
                "A dry, cool Rabi profile on red soil suits Chickpea; "
                "monsoon crops should not lead."
            ),
            expect_top_k=[("Chickpea", 5)],
            forbid_top_k=[("Rice", 3), ("Jute", 3)],
        ),
        GoldenCase(
            name="confusable_pulses_moong_urad",
            raw_record=dict(N=132, P=11, K=140, temperature=30.5, humidity=55,
                            ph=6.9, ec=290, moisture=25, rainfall=70,
                            soil_type="Clayey", season="Zaid"),
            rationale="Moong and Urad overlap heavily; either leading the ranking is acceptable.",
            expect_any_top_k=(["Moong", "Urad"], 3),
        ),
        GoldenCase(
            name="onion_rabi_black",
            raw_record=dict(N=138, P=7, K=225, temperature=18.2, humidity=60,
                            ph=7.7, ec=411, moisture=60, rainfall=108,
                            soil_type="Black", season="Rabi"),
            rationale=(
                "High-K black soil in Rabi with moderate moisture "
                "is a strong Onion signature."
            ),
            expect_top_k=[("Onion", 5)],
        ),
    ]


def build_golden_cases(raw: RawData, top_k: int = 5) -> list[GoldenCase]:
    return build_median_cases(raw, top_k=top_k) + hand_rules()


def _rank_of(order: list[str], crop: str) -> int:
    """1-indexed rank of ``crop`` in ``order`` (len+1 if absent)."""
    return order.index(crop) + 1 if crop in order else len(order) + 1


def run_golden(cases, predict_proba, pipeline, classes: tuple[str, ...]) -> GoldenReport:
    """Score every case with one batched prediction.

    ``predict_proba`` maps the pipeline's feature frame to an ``(n, n_classes)``
    array; ``pipeline`` is the shared FeaturePipeline; ``classes`` fixes column
    meaning.
    """
    raw_df = pd.DataFrame([c.raw_record for c in cases])
    X = pipeline.transform(raw_df)
    proba = np.asarray(predict_proba(X), dtype=np.float64)
    classes = tuple(classes)

    results: list[GoldenResult] = []
    for i, case in enumerate(cases):
        row = proba[i]
        order_idx = np.argsort(-row, kind="stable")
        order = [classes[j] for j in order_idx]
        top5 = [(classes[j], float(row[j])) for j in order_idx[:5]]

        checks: list[str] = []
        ok = True
        for crop, k in case.expect_top_k:
            r = _rank_of(order, crop)
            passed = r <= k
            ok &= passed
            checks.append(f"{'✓' if passed else '✗'} {crop} in top-{k} (rank {r})")
        for crop, k in case.forbid_top_k:
            r = _rank_of(order, crop)
            passed = r > k
            ok &= passed
            checks.append(f"{'✓' if passed else '✗'} {crop} NOT in top-{k} (rank {r})")
        if case.expect_any_top_k is not None:
            crops, k = case.expect_any_top_k
            ranks = {c: _rank_of(order, c) for c in crops}
            passed = any(r <= k for r in ranks.values())
            ok &= passed
            checks.append(
                f"{'✓' if passed else '✗'} any of {crops} in top-{k} "
                f"(ranks {ranks})"
            )
        results.append(GoldenResult(case.name, ok, case.rationale, checks, top5))

    return GoldenReport(results=results)
