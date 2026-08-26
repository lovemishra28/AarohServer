"""Hyperparameter tuning with Optuna — maximise NDCG@3 on the validation fold.

NDCG@3 (against the *soft* label) is the objective because it is the metric that
matches the product: did we put the most-suitable crops at the top of the short
list? Tuning to top-1-vs-hard would chase the sampling-noise ceiling instead.

Optuna is imported lazily inside :func:`tune`, and :func:`suggest_params` accepts
*any* object exposing ``suggest_int`` / ``suggest_float`` / ``suggest_categorical``
(Optuna's ``Trial`` — or a stub in the tests). That keeps the search space unit
-testable on a machine without Optuna, and keeps the space definition in one
place rather than buried in a closure.
"""

from __future__ import annotations

from collections.abc import Callable
from dataclasses import dataclass
from typing import Any, Protocol

import numpy as np
import pandas as pd

from aaroh_ai.evaluation.metrics import ndcg_at_k
from aaroh_ai.training.models import build_ranker


class TrialLike(Protocol):
    """The slice of Optuna's ``Trial`` API the search space needs."""

    def suggest_int(self, name: str, low: int, high: int, *, step: int = 1) -> int: ...
    def suggest_float(self, name: str, low: float, high: float, *, log: bool = False) -> float: ...
    def suggest_categorical(self, name: str, choices: list) -> Any: ...


@dataclass
class TuningResult:
    best_params: dict
    best_value: float
    n_trials: int
    all_values: list[float]


def suggest_params(trial: TrialLike, algo: str) -> dict:
    """Propose a hyperparameter set for ``algo`` from ``trial``.

    Ranges are deliberately conservative and shared across frameworks where the
    knobs mean the same thing (depth, leaves, learning rate, regularisation),
    so a LightGBM/XGBoost comparison is apples-to-apples.
    """
    if algo not in ("lightgbm", "xgboost"):
        raise ValueError(f"no search space for algo '{algo}'")

    params: dict[str, Any] = {
        "n_estimators": trial.suggest_int("n_estimators", 200, 1200, step=100),
        "learning_rate": trial.suggest_float("learning_rate", 1e-3, 3e-1, log=True),
        "max_depth": trial.suggest_int("max_depth", 3, 12),
        "subsample": trial.suggest_float("subsample", 0.6, 1.0),
        "colsample_bytree": trial.suggest_float("colsample_bytree", 0.6, 1.0),
        "min_child_weight": trial.suggest_float("min_child_weight", 1e-2, 10.0, log=True),
    }
    if algo == "lightgbm":
        params["num_leaves"] = trial.suggest_int("num_leaves", 15, 255)
        params["reg_lambda"] = trial.suggest_float("reg_lambda", 1e-3, 10.0, log=True)
        params["reg_alpha"] = trial.suggest_float("reg_alpha", 1e-3, 10.0, log=True)
        params["min_child_samples"] = trial.suggest_int("min_child_samples", 5, 100)
    else:  # xgboost
        params["reg_lambda"] = trial.suggest_float("reg_lambda", 1e-3, 10.0, log=True)
        params["reg_alpha"] = trial.suggest_float("reg_alpha", 1e-3, 10.0, log=True)
        params["gamma"] = trial.suggest_float("gamma", 1e-3, 5.0, log=True)
    return params


def evaluate_ndcg3(
    model_config: dict,
    classes: tuple[str, ...],
    X_train: pd.DataFrame,
    soft_train: np.ndarray,
    hard_train: np.ndarray,
    X_val: pd.DataFrame,
    soft_val: np.ndarray,
    hard_val: np.ndarray,
) -> float:
    """Fit one model with ``model_config`` and return validation NDCG@3."""
    ranker = build_ranker(model_config, classes)
    ranker.fit(X_train, soft_train, hard_train, X_val, soft_val, hard_val)
    proba = ranker.predict_proba(X_val)
    return ndcg_at_k(proba, np.asarray(soft_val, dtype=np.float64), 3)


def tune(
    base_config: dict,
    classes: tuple[str, ...],
    data: dict,
    n_trials: int = 30,
    seed: int = 42,
    objective_fn: Callable[[dict], float] | None = None,
) -> TuningResult:
    """Run an Optuna study maximising validation NDCG@3.

    ``base_config`` supplies ``framework`` / ``objective`` / ``seed``; the search
    only proposes ``params``. ``data`` holds the fitted arrays with keys
    ``X_train, soft_train, hard_train, X_val, soft_val, hard_val``. ``objective_fn``
    is an injection seam for tests (defaults to a real fit-and-score).
    """
    import optuna

    algo = base_config["framework"]

    def _default_objective(params: dict) -> float:
        cfg = {**base_config, "params": {**base_config.get("params", {}), **params}}
        return evaluate_ndcg3(cfg, classes, **data)

    score = objective_fn or _default_objective

    def _optuna_objective(trial: optuna.Trial) -> float:
        return score(suggest_params(trial, algo))

    optuna.logging.set_verbosity(optuna.logging.WARNING)
    study = optuna.create_study(direction="maximize",
                                sampler=optuna.samplers.TPESampler(seed=seed))
    study.optimize(_optuna_objective, n_trials=n_trials, show_progress_bar=False)

    values = [t.value for t in study.trials if t.value is not None]
    return TuningResult(
        best_params=study.best_params,
        best_value=float(study.best_value),
        n_trials=len(study.trials),
        all_values=values,
    )
