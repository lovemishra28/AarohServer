"""Tuning: the search space is well-formed; the NDCG@3 objective runs (dummy).

Optuna itself is not exercised here (it need not be installed); ``suggest_params``
is tested with a stub trial and the objective is tested with the pure-numpy dummy.
"""

from __future__ import annotations

from aaroh_ai.training.tuning import evaluate_ndcg3, suggest_params
from tests._helpers import fitted_pipeline, raw


class _StubTrial:
    """Records requested names and returns the low end of every range."""

    def __init__(self):
        self.names: list[str] = []

    def suggest_int(self, name, low, high, *, step=1):
        self.names.append(name)
        return low

    def suggest_float(self, name, low, high, *, log=False):
        self.names.append(name)
        return low

    def suggest_categorical(self, name, choices):
        self.names.append(name)
        return choices[0]


def test_suggest_params_lightgbm():
    p = suggest_params(_StubTrial(), "lightgbm")
    for key in ("n_estimators", "learning_rate", "max_depth", "num_leaves",
                "reg_lambda", "reg_alpha", "min_child_samples"):
        assert key in p


def test_suggest_params_xgboost():
    p = suggest_params(_StubTrial(), "xgboost")
    for key in ("n_estimators", "learning_rate", "max_depth", "gamma",
                "reg_lambda", "reg_alpha"):
        assert key in p
    assert "num_leaves" not in p  # LightGBM-specific knob absent for xgboost


def test_suggest_params_rejects_unknown_algo():
    try:
        suggest_params(_StubTrial(), "dummy")
        raise AssertionError("expected ValueError")
    except ValueError as e:
        assert "search space" in str(e)


def test_evaluate_ndcg3_runs_with_dummy():
    r = raw()
    pipe = fitted_pipeline()
    X = pipe.transform(r.features.iloc[:300])
    soft = r.soft_matrix()[:300]
    hard = r.hard_indices()[:300]
    cfg = {"framework": "dummy", "objective": "softprob", "params": {"tilt": 0.3}, "seed": 1}
    val = evaluate_ndcg3(cfg, r.classes,
                         X.iloc[:200], soft[:200], hard[:200],
                         X.iloc[200:], soft[200:], hard[200:])
    assert 0.0 <= val <= 1.0
