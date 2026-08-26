"""Model wrappers behind one interface, so the pipeline is algorithm-agnostic.

Three implementations:

* :class:`DummyRanker` — pure numpy, no third-party deps. A weak but genuine
  linear-softmax-over-features model used to smoke-test the *entire* pipeline
  (load → features → split → fit → evaluate → golden → register → report)
  without needing LightGBM installed. It is never registered as a real model.
* :class:`LightGBMRanker` — the **primary**. Two objectives selected by config:
  ``multiclass`` (softprob classifier on the *hard* label → a ranking vector,
  the v1 baseline) and ``lambdarank`` (LambdaMART on the *soft* label as graded
  relevance, the v1.1 challenger).
* :class:`XGBoostRanker` — the **benchmark**, mirroring the two objectives
  (``multi:softprob`` and ``rank:ndcg``).

LightGBM/XGBoost are imported lazily inside the methods that need them, so this
module (and everything that imports it) loads fine on a machine that only has
numpy — which is how the pure-python tests run in CI's minimal sandbox.

The LambdaMART/rank branch reframes the problem as learning-to-rank: each field
is a *query*, the 20 crops are its *documents*, a document's features are the
field's features plus the candidate ``crop`` (a categorical), and the graded
relevance is the soft-label probability quantised to integer grades. At predict
time we score all 20 candidates per field and softmax the scores into a
distribution. The reshape/quantise helpers are pure and unit-tested.
"""

from __future__ import annotations

import json
from abc import ABC, abstractmethod
from pathlib import Path

import numpy as np
import pandas as pd

from aaroh_ai.features.feature_pipeline import CATEGORICAL_FEATURES, FEATURE_ORDER, NUMERIC_FEATURES

# --- learning-to-rank helpers (pure; no ML dep) ------------------------------

# Soft probability -> integer relevance grade (0..4). LightGBM lambdarank needs
# non-negative integer labels; its default label_gain maps grade g to 2**g - 1.
SOFT_GRADE_EDGES: tuple[float, ...] = (0.02, 0.05, 0.10, 0.20)


def quantize_relevance(soft: np.ndarray) -> np.ndarray:
    """Map soft probabilities to integer relevance grades via fixed edges."""
    return np.digitize(soft, SOFT_GRADE_EDGES).astype(np.int32)


def build_ltr_frame(
    X: pd.DataFrame,
    classes: tuple[str, ...],
    soft: np.ndarray | None = None,
) -> tuple[pd.DataFrame, np.ndarray, np.ndarray | None]:
    """Expand ``(n_rows, features)`` into ``(n_rows*n_classes, features+crop)``.

    Row-major: field 0's 20 crop-candidates, then field 1's, ... — so ``group``
    is ``[n_classes]*n_rows`` and a matching ``qid`` would be
    ``repeat(arange(n_rows), n_classes)``. Returns ``(frame, group, relevance)``
    where ``relevance`` is the flattened integer grades (or ``None`` if ``soft``
    was not supplied, e.g. at inference).
    """
    n = len(X)
    c = len(classes)
    rep = X.loc[X.index.repeat(c)].reset_index(drop=True)
    crop_codes = np.tile(np.arange(c), n)
    rep["crop"] = pd.Categorical.from_codes(crop_codes, categories=list(classes))
    group = np.full(n, c, dtype=np.int32)
    relevance = None
    if soft is not None:
        # C-order flatten matches the row-major expansion above.
        relevance = quantize_relevance(np.asarray(soft, dtype=np.float64)).reshape(-1)
    return rep, group, relevance


def _softmax(z: np.ndarray) -> np.ndarray:
    z = z - z.max(axis=1, keepdims=True)
    e = np.exp(z)
    return e / e.sum(axis=1, keepdims=True)


def ltr_scores_to_proba(scores: np.ndarray, n_rows: int, n_classes: int) -> np.ndarray:
    """Reshape flat ranker scores to ``(n_rows, n_classes)`` and softmax to a dist."""
    reshaped = np.asarray(scores, dtype=np.float64).reshape(n_rows, n_classes)
    return _softmax(reshaped)


# --- interface ---------------------------------------------------------------

class BaseRanker(ABC):
    """Common surface every ranker exposes to the pipeline."""

    framework: str = "base"
    algo: str = "base"

    def __init__(self, classes: tuple[str, ...], objective: str, params: dict, seed: int = 42):
        self.classes = tuple(classes)
        self.objective = objective
        self.params = dict(params)
        self.seed = seed

    @property
    def n_classes(self) -> int:
        return len(self.classes)

    @property
    def version_tag(self) -> str:
        return f"{self.algo}:{self.objective}"

    @abstractmethod
    def fit(
        self,
        X_train: pd.DataFrame,
        soft_train: np.ndarray,
        hard_train: np.ndarray,
        X_val: pd.DataFrame | None = None,
        soft_val: np.ndarray | None = None,
        hard_val: np.ndarray | None = None,
    ) -> BaseRanker: ...

    @abstractmethod
    def predict_proba(self, X: pd.DataFrame) -> np.ndarray: ...

    @abstractmethod
    def save(self, dirpath: str | Path) -> None: ...

    @classmethod
    @abstractmethod
    def load(cls, dirpath: str | Path) -> BaseRanker: ...


# --- Dummy (pure numpy) ------------------------------------------------------

class DummyRanker(BaseRanker):
    """A tiny linear-softmax model — enough to exercise the whole pipeline.

    Not a real model: its only job is to make the plumbing runnable without
    LightGBM. It learns the mean soft distribution (a sensible prior) plus a
    small seeded linear tilt on standardised features, so its predictions vary
    per row and the confusion matrix / top-k are non-degenerate.
    """

    framework = "dummy"
    algo = "dummy"

    def _matrix(self, X: pd.DataFrame) -> np.ndarray:
        num = X[list(NUMERIC_FEATURES)].to_numpy(dtype=np.float64)
        cats = np.column_stack(
            [X[c].cat.codes.to_numpy(dtype=np.float64) for c in CATEGORICAL_FEATURES]
        )
        return np.column_stack([num, cats])

    def fit(self, X_train, soft_train, hard_train, X_val=None, soft_val=None, hard_val=None):
        soft_train = np.asarray(soft_train, dtype=np.float64)
        self.prior_ = soft_train.mean(axis=0)
        m = self._matrix(X_train)
        self.mean_ = np.nanmean(m, axis=0)
        self.std_ = np.nanstd(m, axis=0) + 1e-9
        rng = np.random.default_rng(self.seed)
        tilt = float(self.params.get("tilt", 0.35))
        self.W_ = rng.normal(0.0, tilt, size=(m.shape[1], self.n_classes))
        return self

    def predict_proba(self, X: pd.DataFrame) -> np.ndarray:
        m = self._matrix(X)
        z = (m - self.mean_) / self.std_
        z = np.nan_to_num(z, nan=0.0)
        logits = np.log(self.prior_ + 1e-9)[None, :] + z @ self.W_
        return _softmax(logits)

    def save(self, dirpath: str | Path) -> None:
        d = Path(dirpath)
        d.mkdir(parents=True, exist_ok=True)
        payload = {
            "framework": self.framework, "algo": self.algo, "objective": self.objective,
            "classes": list(self.classes), "seed": self.seed, "params": self.params,
            "prior": self.prior_.tolist(), "mean": self.mean_.tolist(),
            "std": self.std_.tolist(), "W": self.W_.tolist(),
        }
        (d / "model.json").write_text(json.dumps(payload))

    @classmethod
    def load(cls, dirpath: str | Path) -> DummyRanker:
        payload = json.loads((Path(dirpath) / "model.json").read_text())
        obj = cls(
            tuple(payload["classes"]),
            payload["objective"],
            payload["params"],
            payload["seed"],
        )
        obj.prior_ = np.asarray(payload["prior"])
        obj.mean_ = np.asarray(payload["mean"])
        obj.std_ = np.asarray(payload["std"])
        obj.W_ = np.asarray(payload["W"])
        return obj


# --- LightGBM (primary) ------------------------------------------------------

class LightGBMRanker(BaseRanker):
    """LightGBM ranker: ``multiclass`` softprob baseline or ``lambdarank``."""

    framework = "lightgbm"
    algo = "lightgbm"

    def __init__(self, classes, objective, params, seed=42):
        super().__init__(classes, objective, params, seed)
        self.model_ = None
        self.booster_ = None
        self.best_iteration_: int | None = None
        if objective not in ("multiclass", "lambdarank"):
            raise ValueError(f"LightGBMRanker: unknown objective '{objective}'")

    def _cat_features(self, include_crop: bool) -> list[str]:
        cats = list(CATEGORICAL_FEATURES)
        return cats + ["crop"] if include_crop else cats

    def fit(self, X_train, soft_train, hard_train, X_val=None, soft_val=None, hard_val=None):
        import lightgbm as lgb

        stopping = (
            int(self.params.pop("early_stopping_rounds", 50))
            if "early_stopping_rounds" in self.params
            else 50
        )
        callbacks = [lgb.early_stopping(stopping, verbose=False), lgb.log_evaluation(0)]

        if self.objective == "multiclass":
            self.model_ = lgb.LGBMClassifier(
                objective="multiclass", num_class=self.n_classes,
                random_state=self.seed, **self.params,
            )
            kw = {"categorical_feature": self._cat_features(False)}
            if X_val is not None:
                kw.update(eval_set=[(X_val, hard_val)], callbacks=callbacks)
            self.model_.fit(X_train, hard_train, **kw)
        else:  # lambdarank
            frame, group, rel = build_ltr_frame(X_train, self.classes, soft_train)
            self.model_ = lgb.LGBMRanker(
                objective="lambdarank", random_state=self.seed, **self.params,
            )
            kw = {"group": group, "categorical_feature": self._cat_features(True)}
            if X_val is not None:
                fv, gv, rv = build_ltr_frame(X_val, self.classes, soft_val)
                kw.update(eval_set=[(fv, rv)], eval_group=[gv], eval_at=[3], callbacks=callbacks)
            self.model_.fit(frame, rel, **kw)

        self.booster_ = self.model_.booster_
        self.best_iteration_ = getattr(self.model_, "best_iteration_", None) or None
        return self

    def predict_proba(self, X: pd.DataFrame) -> np.ndarray:
        if self.booster_ is None:
            raise RuntimeError("model is not fitted/loaded")
        num_it = self.best_iteration_
        if self.objective == "multiclass":
            proba = self.booster_.predict(X, num_iteration=num_it)
            return np.asarray(proba, dtype=np.float64)
        frame, _, _ = build_ltr_frame(X, self.classes)
        scores = self.booster_.predict(frame, num_iteration=num_it)
        return ltr_scores_to_proba(scores, len(X), self.n_classes)

    def save(self, dirpath: str | Path) -> None:
        d = Path(dirpath)
        d.mkdir(parents=True, exist_ok=True)
        self.booster_.save_model(str(d / "model.txt"))
        meta = {
            "framework": self.framework, "algo": self.algo, "objective": self.objective,
            "classes": list(self.classes), "seed": self.seed, "params": self.params,
            "best_iteration": self.best_iteration_,
        }
        (d / "meta.json").write_text(json.dumps(meta, indent=2))

    @classmethod
    def load(cls, dirpath: str | Path) -> LightGBMRanker:
        import lightgbm as lgb

        d = Path(dirpath)
        meta = json.loads((d / "meta.json").read_text())
        obj = cls(tuple(meta["classes"]), meta["objective"], meta["params"], meta["seed"])
        obj.booster_ = lgb.Booster(model_file=str(d / "model.txt"))
        obj.best_iteration_ = meta.get("best_iteration")
        return obj


# --- XGBoost (benchmark) -----------------------------------------------------

class XGBoostRanker(BaseRanker):
    """XGBoost ranker: ``multi:softprob`` baseline or ``rank:ndcg``."""

    framework = "xgboost"
    algo = "xgboost"

    def __init__(self, classes, objective, params, seed=42):
        super().__init__(classes, objective, params, seed)
        self.model_ = None
        if objective not in ("multi:softprob", "rank:ndcg"):
            raise ValueError(f"XGBoostRanker: unknown objective '{objective}'")

    def _common(self) -> dict:
        return dict(
            enable_categorical=True, tree_method="hist",
            random_state=self.seed, **self.params,
        )

    def fit(self, X_train, soft_train, hard_train, X_val=None, soft_val=None, hard_val=None):
        import xgboost as xgb

        if self.objective == "multi:softprob":
            self.model_ = xgb.XGBClassifier(
                objective="multi:softprob", num_class=self.n_classes, **self._common()
            )
            kw = {}
            if X_val is not None:
                kw = {"eval_set": [(X_val, hard_val)], "verbose": False}
            self.model_.fit(X_train, hard_train, **kw)
        else:  # rank:ndcg
            frame, _group, rel = build_ltr_frame(X_train, self.classes, soft_train)
            qid = np.repeat(np.arange(len(X_train)), self.n_classes)
            self.model_ = xgb.XGBRanker(objective="rank:ndcg", **self._common())
            kw = {"qid": qid}
            if X_val is not None:
                fv, _gv, rv = build_ltr_frame(X_val, self.classes, soft_val)
                qv = np.repeat(np.arange(len(X_val)), self.n_classes)
                kw.update(eval_set=[(fv, rv)], eval_qid=[qv], verbose=False)
            self.model_.fit(frame, rel, **kw)
        return self

    def predict_proba(self, X: pd.DataFrame) -> np.ndarray:
        if self.model_ is None:
            raise RuntimeError("model is not fitted/loaded")
        if self.objective == "multi:softprob":
            return np.asarray(self.model_.predict_proba(X), dtype=np.float64)
        frame, _, _ = build_ltr_frame(X, self.classes)
        scores = self.model_.predict(frame)
        return ltr_scores_to_proba(scores, len(X), self.n_classes)

    def save(self, dirpath: str | Path) -> None:
        d = Path(dirpath)
        d.mkdir(parents=True, exist_ok=True)
        self.model_.save_model(str(d / "model.json"))
        meta = {
            "framework": self.framework, "algo": self.algo, "objective": self.objective,
            "classes": list(self.classes), "seed": self.seed, "params": self.params,
        }
        (d / "meta.json").write_text(json.dumps(meta, indent=2))

    @classmethod
    def load(cls, dirpath: str | Path) -> XGBoostRanker:
        import xgboost as xgb

        d = Path(dirpath)
        meta = json.loads((d / "meta.json").read_text())
        obj = cls(tuple(meta["classes"]), meta["objective"], meta["params"], meta["seed"])
        model = (
            xgb.XGBClassifier() if meta["objective"] == "multi:softprob" else xgb.XGBRanker()
        )
        model.load_model(str(d / "model.json"))
        obj.model_ = model
        return obj


# --- factory -----------------------------------------------------------------

_REGISTRY: dict[str, type[BaseRanker]] = {
    "dummy": DummyRanker,
    "lightgbm": LightGBMRanker,
    "xgboost": XGBoostRanker,
}


def build_ranker(config: dict, classes: tuple[str, ...]) -> BaseRanker:
    """Instantiate a ranker from a model config block.

    Expected keys: ``framework`` (dummy|lightgbm|xgboost), ``objective``,
    ``params`` (dict), ``seed`` (int).
    """
    framework = config["framework"]
    if framework not in _REGISTRY:
        raise ValueError(f"unknown framework '{framework}'; choose from {sorted(_REGISTRY)}")
    return _REGISTRY[framework](
        classes=classes,
        objective=config["objective"],
        params=dict(config.get("params", {})),
        seed=int(config.get("seed", 42)),
    )


def assert_feature_frame(X: pd.DataFrame) -> None:
    """Guard: the matrix must be exactly the shared pipeline's output."""
    if list(X.columns) != list(FEATURE_ORDER):
        raise ValueError(
            f"feature columns {list(X.columns)} != FEATURE_ORDER {list(FEATURE_ORDER)}"
        )
