"""Region config loader: presence, structure, and override behaviour."""

from __future__ import annotations

import json
import tempfile
from pathlib import Path

from aaroh_ai.services.agronomy.config import (
    CANONICAL_CROPS,
    load_region_config,
)


def test_loads_chambal_active_version():
    cfg = load_region_config("chambal")
    assert cfg.region_code == "chambal"
    assert cfg.agronomy_version == "chambal-stcr@2026.08-provisional"
    assert cfg.provisional is True


def test_all_canonical_crops_present_with_hindi_and_rdf():
    cfg = load_region_config("chambal")
    for crop in CANONICAL_CROPS:
        spec = cfg.crop(crop)
        assert spec.hi, f"{crop} missing Hindi name"
        assert spec.rdf_p2o5_kgha >= 0
    assert len(cfg.crops) == len(CANONICAL_CROPS)


def test_required_products_and_multipliers():
    cfg = load_region_config("chambal")
    for name in ("Urea", "DAP", "MOP"):
        assert name in cfg.products
    assert cfg.products["DAP"].p2o5_pct == 46
    assert set(cfg.class_multiplier) == {"Low", "Medium", "High"}
    assert cfg.class_multiplier["High"] == 0.0


def test_legumes_include_pulses_and_oilseeds():
    cfg = load_region_config("chambal")
    for legume in ("Chickpea", "Arhar", "Moong", "Urad", "Soybean", "Groundnut"):
        assert cfg.is_legume(legume)
        assert cfg.crop(legume).rdf_n_kgha == 0.0
    assert not cfg.is_legume("Wheat")


def test_base_dir_override_and_missing_crop_raises():
    """A hand-built config missing a canonical crop must fail loudly at load."""
    cfg = load_region_config("chambal")
    # Round-trip the real config, drop one crop, and confirm load rejects it.
    src = Path(__file__).resolve().parents[1] / "src/aaroh_ai/services/agronomy/regions"
    raw = json.loads((src / "chambal" / "2026.08-provisional.json").read_text(encoding="utf-8"))
    raw["crops"].pop("Wheat")

    tmp = Path(tempfile.mkdtemp())
    region = tmp / "chambal"
    region.mkdir(parents=True)
    (region / "manifest.json").write_text(json.dumps({"active_version": "x"}))
    (region / "x.json").write_text(json.dumps(raw), encoding="utf-8")

    try:
        load_region_config("chambal", base_dir=tmp)
        raise AssertionError("expected ValueError for missing canonical crop")
    except ValueError as e:
        assert "Wheat" in str(e) or "missing canonical" in str(e)
    # sanity: the real one still loads fine
    assert cfg.crop("Wheat").hi
