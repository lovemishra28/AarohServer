"""Golden tests for the deterministic agronomy engine.

These lock the fertiliser arithmetic against hand-computed expected values — the
auditable contract of ADR-0004. If a number here changes, either the region
config changed (intended) or the engine regressed (not). Every expected value in
this file was computed by hand and is annotated with the working.

Fixture-free, zero-arg functions so the suite runs under pytest *and* under the
minimal no-pytest harness.
"""

from __future__ import annotations

from aaroh_ai.services.agronomy import (
    allocate_products,
    classify_soil,
    compute_dose,
    load_region_config,
    recommend,
    recommend_for_crop,
)


def _cfg():
    return load_region_config("chambal")


# --------------------------------------------------------------------------- #
# THE golden: product allocation from a fixed oxide requirement.
# Field oxide need: N=48, P2O5=24, K2O=0 kg.
#   DAP: 24 / 0.46 = 52.17 kg -> 52.17/50 = 1.043 bags -> round = 1 bag (50 kg)
#        supplies P2O5 = 50*0.46 = 23.0, N = 50*0.18 = 9.0  (N credited)
#   Urea: residual N = 48 - 9 = 39 -> 39/0.46 = 84.78 kg -> 1.696 bags -> 2 bags (100 kg)
#         supplies N = 100*0.46 = 46.0
#   MOP: K2O = 0 -> none
#   Cost = 1*1350 + 2*296 = 1942
# --------------------------------------------------------------------------- #
def test_golden_allocation_48_24_0():
    cfg = _cfg()
    lines, cost = allocate_products(48.0, 24.0, 0.0, cfg)
    assert [(line.name, line.bags_50kg, line.kg) for line in lines] == [
        ("DAP", 1, 50.0),
        ("Urea", 2, 100.0),
    ]
    assert lines[0].supplies == {"P2O5": 23.0, "N": 9.0}
    assert lines[1].supplies == {"N": 46.0}
    assert cost == 1942.0


def test_dap_nitrogen_credit_reduces_urea():
    """DAP's incidental N must be subtracted before sizing Urea (no double-count)."""
    cfg = _cfg()
    # P2O5=46 -> exactly 1 DAP bag (46/0.46=100kg=2 bags? no: 46/0.46=100kg ->2 bags).
    # Use P2O5=23 -> 23/0.46=50kg -> 1 bag, N credit 9. N=9 -> residual 0 -> no urea.
    lines, _ = allocate_products(9.0, 23.0, 0.0, cfg)
    names = [line.name for line in lines]
    assert names == ["DAP"]  # the 9 kg N is fully covered by DAP's credit


def test_round_half_up_beats_bankers_rounding():
    """2.5 bags must round to 3 (a farmer buys enough), not 2 (banker's rounding)."""
    cfg = _cfg()
    # K2O = 75 kg -> 75/0.60 = 125 kg MOP -> 125/50 = 2.5 bags -> round-half-up = 3.
    lines, _ = allocate_products(0.0, 0.0, 75.0, cfg)
    mop = [line for line in lines if line.name == "MOP"][0]
    assert mop.bags_50kg == 3  # round(2.5) would give 2 under banker's rounding


def test_empty_requirement_is_no_products_no_cost():
    cfg = _cfg()
    lines, cost = allocate_products(0.0, 0.0, 0.0, cfg)
    assert lines == []
    assert cost == 0.0


# --------------------------------------------------------------------------- #
# Dosing: class-adjusted RDF, per nutrient's own soil class.
# --------------------------------------------------------------------------- #
def test_compute_dose_low_soil_uses_125_multiplier():
    cfg = _cfg()
    # All nutrients Low -> multiplier 1.25. Wheat RDF 120-60-40.
    rating = classify_soil(50.0, 2.0, 40.0, cfg)  # low N,P,K in mg/kg
    assert rating.classes == {"n": "Low", "p": "Low", "k": "Low"}
    dose = compute_dose("Wheat", rating, cfg)
    assert (dose.n_kgha, dose.p2o5_kgha, dose.k2o_kgha) == (150.0, 75.0, 50.0)


def test_high_soil_zeroes_the_dose():
    cfg = _cfg()
    rating = classify_soil(400.0, 20.0, 200.0, cfg)  # all High
    assert rating.classes == {"n": "High", "p": "High", "k": "High"}
    dose = compute_dose("Wheat", rating, cfg)
    assert (dose.n_kgha, dose.p2o5_kgha, dose.k2o_kgha) == (0.0, 0.0, 0.0)


def test_legume_never_doses_nitrogen():
    cfg = _cfg()
    rating = classify_soil(50.0, 2.0, 40.0, cfg)  # all Low
    dose = compute_dose("Chickpea", rating, cfg)  # RDF N is 0 for legumes
    assert dose.n_kgha == 0.0
    assert dose.p2o5_kgha > 0.0  # P and K are still dosed


def test_each_nutrient_uses_its_own_class():
    cfg = _cfg()
    # N Low, P High, K Medium (mg/kg): N 50 -> Low; P 20 -> 39 kg/ha High; K 100 -> 195 Medium
    rating = classify_soil(50.0, 20.0, 100.0, cfg)
    assert rating.classes == {"n": "Low", "p": "High", "k": "Medium"}
    dose = compute_dose("Wheat", rating, cfg)  # 120-60-40
    assert dose.n_kgha == 150.0   # 120 * 1.25
    assert dose.p2o5_kgha == 0.0  # 60 * 0.0 (High)
    assert dose.k2o_kgha == 40.0  # 40 * 1.0 (Medium)


# --------------------------------------------------------------------------- #
# Per-crop recommendation: segment assignment + rationale.
# --------------------------------------------------------------------------- #
def test_segment_a_when_soil_sufficient():
    cfg = _cfg()
    rating = classify_soil(400.0, 20.0, 200.0, cfg)  # all High
    rec = recommend_for_crop("Wheat", 0.9, rating, 1.0, cfg)
    assert rec.segment == "A"
    assert rec.fertiliser is None
    assert rec.rationale_code == "SOIL_SUFFICIENT"


def test_segment_a_legume_rationale():
    cfg = _cfg()
    rating = classify_soil(400.0, 20.0, 200.0, cfg)  # all High
    rec = recommend_for_crop("Chickpea", 0.5, rating, 1.0, cfg)
    assert rec.segment == "A"
    assert rec.rationale_code == "LEGUME_FIXES_N"


def test_segment_b_rationale_lists_only_dosed_nutrients():
    cfg = _cfg()
    # N Low, P High, K Medium -> only N and K dosed -> N_ADD_UREA+K_ADD_MOP
    rating = classify_soil(50.0, 20.0, 100.0, cfg)
    rec = recommend_for_crop("Wheat", 0.7, rating, 1.0, cfg)
    assert rec.segment == "B"
    assert rec.rationale_code == "N_ADD_UREA+K_ADD_MOP"


def test_nutrient_gap_is_per_ha_dose_independent_of_area():
    cfg = _cfg()
    rating = classify_soil(50.0, 2.0, 40.0, cfg)  # all Low
    small = recommend_for_crop("Wheat", 1.0, rating, 1.0, cfg)
    big = recommend_for_crop("Wheat", 1.0, rating, 5.0, cfg)
    # per-ha dose identical regardless of field size
    assert small.fertiliser.nutrient_gap_kgha == big.fertiliser.nutrient_gap_kgha
    # but the bag counts (whole-field) scale up
    small_bags = sum(p.bags_50kg for p in small.fertiliser.products)
    big_bags = sum(p.bags_50kg for p in big.fertiliser.products)
    assert big_bags > small_bags


# --------------------------------------------------------------------------- #
# Full recommendation assembly.
# --------------------------------------------------------------------------- #
def test_recommend_splits_segments_and_preserves_rank_order():
    cfg = _cfg()
    reading = {"N": 50, "P": 2, "K": 40, "ph": 7.5}  # all Low
    ranked = [("Wheat", 0.6), ("Chickpea", 0.3), ("Rice", 0.1)]
    res = recommend(ranked, reading, 1.0, cfg, model_version="test@1")
    # all Low soil -> everything needs fertiliser -> all Segment B
    assert res.segment_a == []
    assert [c["crop"] for c in res.segment_b] == ["Wheat", "Chickpea", "Rice"]
    assert res.region_code == "chambal"
    assert res.agronomy_version == cfg.agronomy_version
    assert res.model_version == "test@1"


def test_recommend_warns_uncalibrated_and_provisional_by_default():
    cfg = _cfg()
    reading = {"N": 50, "P": 2, "K": 40, "ph": 7.5}
    res = recommend([("Wheat", 1.0)], reading, 1.0, cfg, model_version="t")
    joined = " ".join(res.warnings)
    assert "npk_proxy_uncalibrated" in joined
    assert "agronomy_config_provisional" in joined


def test_recommend_calibrated_suppresses_npk_warning():
    cfg = _cfg()
    reading = {"N": 50, "P": 2, "K": 40, "ph": 7.5}
    res = recommend([("Wheat", 1.0)], reading, 1.0, cfg, model_version="t",
                    npk_is_calibrated=True)
    assert not any("npk_proxy_uncalibrated" in w for w in res.warnings)


def test_recommend_flags_extreme_ph():
    cfg = _cfg()
    acidic = recommend([("Wheat", 1.0)], {"N": 50, "P": 2, "K": 40, "ph": 4.9},
                       1.0, cfg, model_version="t")
    alkaline = recommend([("Wheat", 1.0)], {"N": 50, "P": 2, "K": 40, "ph": 9.2},
                         1.0, cfg, model_version="t")
    assert any("acidic_soil_ph" in w for w in acidic.warnings)
    assert any("alkaline_soil_ph" in w for w in alkaline.warnings)


def test_recommend_rejects_nonpositive_area():
    cfg = _cfg()
    try:
        recommend([("Wheat", 1.0)], {"N": 50, "P": 2, "K": 40}, 0.0, cfg, model_version="t")
        raise AssertionError("expected ValueError for area_ha=0")
    except ValueError as e:
        assert "area_ha" in str(e)


def test_result_dict_matches_frozen_contract_shape():
    cfg = _cfg()
    reading = {"N": 50, "P": 2, "K": 40, "ph": 7.5}
    res = recommend([("Wheat", 0.9)], reading, 1.2, cfg, model_version="m@1").to_dict()
    assert set(res) == {
        "model_version", "agronomy_version", "region_code", "area_ha",
        "segment_a", "segment_b", "warnings",
    }
    item = res["segment_b"][0]
    assert set(item) == {"crop", "crop_hi", "score", "fertiliser", "rationale_code"}
    fert = item["fertiliser"]
    assert set(fert) == {"products", "nutrient_gap_kgha", "cost_inr"}
    assert set(fert["nutrient_gap_kgha"]) == {"n_kgha", "p2o5_kgha", "k2o_kgha"}
    assert set(fert["products"][0]) == {"name", "bags_50kg", "kg", "supplies"}
