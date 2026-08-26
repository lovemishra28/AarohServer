"""Soil classification: unit conversion, band boundaries, elemental basis."""

from __future__ import annotations

from aaroh_ai.services.agronomy import classify_soil, load_region_config


def _cfg():
    return load_region_config("chambal")


def test_mgkg_to_kgha_conversion():
    cfg = _cfg()
    rating = classify_soil(100.0, 10.0, 50.0, cfg)
    # x1.95: 100->195, 10->19.5, 50->97.5
    assert rating.n.value_kgha == 195.0
    assert round(rating.p.value_kgha, 2) == 19.5
    assert round(rating.k.value_kgha, 2) == 97.5


def test_band_boundaries_are_half_open():
    """value < low_max -> Low; value == low_max -> Medium; value == med_max -> High."""
    cfg = _cfg()
    # N band low_max=280, med_max=560 (elemental kg/ha). Convert target kg/ha back to mg/kg.
    # exactly 280 kg/ha -> 280/1.95 mg/kg
    just_below = classify_soil((279.9 / 1.95), 1, 1, cfg)
    exactly_low_max = classify_soil((280.0 / 1.95), 1, 1, cfg)
    exactly_med_max = classify_soil((560.0 / 1.95), 1, 1, cfg)
    assert just_below.n.soil_class == "Low"
    assert exactly_low_max.n.soil_class == "Medium"   # not Low: strict <
    assert exactly_med_max.n.soil_class == "High"     # not Medium: strict <


def test_phosphorus_uses_elemental_not_oxide_threshold():
    """P<10 kg/ha is elemental Olsen-P; must NOT be multiplied to oxide first.

    P = 6 mg/kg -> 11.7 kg/ha elemental -> Medium (10<=11.7<25). If the engine
    wrongly converted to P2O5 (x2.291 -> 26.8) it would read High, and dose 0 —
    a real fertiliser error. This test pins the elemental basis.
    """
    cfg = _cfg()
    rating = classify_soil(1.0, 6.0, 1.0, cfg)
    assert round(rating.p.value_kgha, 2) == 11.7
    assert rating.p.soil_class == "Medium"


def test_calibration_flag_carried_through():
    cfg = _cfg()
    assert classify_soil(100, 10, 50, cfg, npk_is_calibrated=True).npk_is_calibrated is True
    assert classify_soil(100, 10, 50, cfg).npk_is_calibrated is False
