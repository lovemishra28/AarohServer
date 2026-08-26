"""Report: the HTML renders, is well-formed enough, and inlines valid PNGs."""

from __future__ import annotations

import base64
import re
import tempfile
from pathlib import Path

import numpy as np

from aaroh_ai.evaluation.golden import GoldenReport, GoldenResult
from aaroh_ai.evaluation.metrics import (
    calibration_bins,
    confusion_matrix,
    evaluate,
    per_class_prf,
    top_confusion_pairs,
)
from aaroh_ai.evaluation.report import ReportContext, render_report_html, write_report
from tests._helpers import rand_proba


def _ctx() -> ReportContext:
    classes = ("Rice", "Wheat", "Maize")
    proba = rand_proba(30, 3, seed=1)
    y = np.arange(30) % 3
    soft = proba.copy()
    summary = evaluate(proba, y, soft)
    cm = confusion_matrix(y, proba.argmax(axis=1), 3)
    golden = GoldenReport(results=[
        GoldenResult("rice_case", True, "paddy niche", ["✓ Rice in top-3 (rank 1)"],
                     [("Rice", 0.5), ("Wheat", 0.3), ("Maize", 0.2)]),
    ])
    gates = {"passed": True, "checks": [
        {"name": "All golden tests pass", "passed": True, "detail": "1/1"},
    ]}
    return ReportContext(
        meta={"version": "crop-ranker@1.0.0", "framework": "lightgbm", "objective": "multiclass",
              "trained_at": "2026-08-26T00:00:00Z", "dataset_hash": "abcdef123456",
              "feature_spec_version": "1.0.0", "n_train": 21, "n_val": 4, "n_test": 5,
              "git_commit": None},
        summary=summary, confusion=cm, per_class=per_class_prf(cm),
        calibration=calibration_bins(proba, y, 5),
        top_pairs=top_confusion_pairs(cm, classes, 10),
        golden=golden, classes=classes, gates=gates,
    )


def test_render_has_sections_and_no_stray_jinja():
    html = render_report_html(_ctx())
    for needle in ("Read this before the numbers", "Headline metrics", "Gates",
                   "Most-confused crop pairs", "Per-crop precision",
                   "Agronomic golden tests", "NDCG@3"):
        assert needle in html, f"missing section: {needle}"
    assert "{{" not in html and "{%" not in html   # everything rendered


def test_embedded_pngs_decode():
    html = render_report_html(_ctx())
    uris = re.findall(r"data:image/png;base64,([A-Za-z0-9+/=]+)", html)
    assert len(uris) == 2  # reliability + confusion
    for u in uris:
        blob = base64.b64decode(u)
        assert blob[:8] == b"\x89PNG\r\n\x1a\n"


def test_write_report_creates_file():
    out = Path(tempfile.mkdtemp()) / "eval_report.html"
    write_report(out, _ctx())
    assert out.exists() and out.stat().st_size > 5000
