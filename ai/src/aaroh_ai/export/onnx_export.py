"""Freeze a trained ranker to ONNX for the serving path, with a parity gate.

Why ONNX: the Node/mobile serving layer shouldn't depend on a Python LightGBM
runtime. A frozen ``.onnx`` graph runs under onnxruntime anywhere and pins the
model's numerical behaviour at release time.

**Scope for v1.** Export targets the *classifier* objective — LightGBM
``multiclass`` or XGBoost ``multi:softprob`` — because that is the deployable
distribution-producing model and the path ONNX converters support well. The
learning-to-rank challenger (``lambdarank`` / ``rank:ndcg``) emits per-candidate
scores that need an external softmax; exporting it is deferred with a clear
error rather than a subtly wrong graph.

**Categoricals.** The shared pipeline freezes a stable category order for
``soil_type`` and ``season``; here we encode them to those integer codes and feed
the model a single float tensor of width ``len(FEATURE_ORDER)``. The same codes
must be produced at serve time — they live in ``feature_spec.json``.

**The gate.** Every export runs an onnxruntime parity check against the source
model's ``predict_proba`` on real rows. If the maximum absolute probability
difference exceeds ``atol`` the function raises. Nothing that fails parity is
ever written as a usable artifact — a wrong-but-fast model is worse than none.
"""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path

import numpy as np
import pandas as pd

from aaroh_ai.features.feature_pipeline import CATEGORICAL_FEATURES, FEATURE_ORDER

CLASSIFIER_OBJECTIVES = {"multiclass", "multi:softprob"}


@dataclass
class ParityResult:
    max_abs_diff: float
    mean_abs_diff: float
    n_rows: int
    atol: float

    @property
    def ok(self) -> bool:
        return self.max_abs_diff <= self.atol


def to_float_matrix(X: pd.DataFrame) -> np.ndarray:
    """Encode the pipeline frame to an all-float ``(n, n_features)`` matrix.

    Numeric columns pass through; categoricals become their integer category
    codes (``-1`` for unseen/NaN, exactly as the model saw them). Column order is
    fixed to ``FEATURE_ORDER`` so the ONNX input contract is unambiguous.
    """
    if list(X.columns) != list(FEATURE_ORDER):
        raise ValueError("frame columns must equal FEATURE_ORDER before ONNX encoding")
    cols = []
    for name in FEATURE_ORDER:
        s = X[name]
        if name in CATEGORICAL_FEATURES:
            cols.append(s.cat.codes.to_numpy(dtype=np.float32))
        else:
            cols.append(s.to_numpy(dtype=np.float32))
    return np.column_stack(cols).astype(np.float32)


def _convert_to_onnx(ranker, n_features: int):
    """Framework-specific conversion to an ONNX ModelProto (lazy imports)."""
    from onnxmltools.convert.common.data_types import FloatTensorType

    initial_types = [("input", FloatTensorType([None, n_features]))]

    if ranker.framework == "lightgbm":
        from onnxmltools.convert import convert_lightgbm

        # The fitted sklearn estimator carries class metadata the converter needs.
        return convert_lightgbm(ranker.model_, initial_types=initial_types,
                                zipmap=False, target_opset=None)
    if ranker.framework == "xgboost":
        from onnxmltools.convert import convert_xgboost

        return convert_xgboost(ranker.model_, initial_types=initial_types,
                               zipmap=False, target_opset=None)
    raise NotImplementedError(f"ONNX export not implemented for framework '{ranker.framework}'")


def _onnx_proba(onnx_bytes: bytes, matrix: np.ndarray) -> np.ndarray:
    """Run the ONNX graph and return the probability tensor (n, n_classes)."""
    import onnxruntime as ort

    sess = ort.InferenceSession(onnx_bytes, providers=["CPUExecutionProvider"])
    input_name = sess.get_inputs()[0].name
    outputs = sess.run(None, {input_name: matrix})
    # With zipmap=False the probability tensor is the output whose second dim
    # equals the class count; the label vector is 1-D and is skipped.
    for arr in outputs:
        a = np.asarray(arr)
        if a.ndim == 2:
            return a.astype(np.float64)
    raise RuntimeError("no 2-D probability output found in ONNX result")


def export_to_onnx(
    ranker,
    X_sample: pd.DataFrame,
    out_path: str | Path,
    atol: float = 1e-4,
) -> ParityResult:
    """Convert ``ranker`` to ONNX at ``out_path`` and verify parity on ``X_sample``.

    Raises ``NotImplementedError`` for learning-to-rank objectives and
    ``ValueError`` if the onnxruntime probabilities diverge from the source
    model's beyond ``atol``. On success the ``.onnx`` file is written and a
    :class:`ParityResult` is returned.
    """
    if ranker.objective not in CLASSIFIER_OBJECTIVES:
        raise NotImplementedError(
            f"ONNX export targets classifier objectives {sorted(CLASSIFIER_OBJECTIVES)}; "
            f"'{ranker.objective}' (learning-to-rank) needs the deferred score-export path"
        )

    matrix = to_float_matrix(X_sample)
    onnx_model = _convert_to_onnx(ranker, matrix.shape[1])
    onnx_bytes = onnx_model.SerializeToString()

    ref = np.asarray(ranker.predict_proba(X_sample), dtype=np.float64)
    got = _onnx_proba(onnx_bytes, matrix)
    if got.shape != ref.shape:
        raise ValueError(f"ONNX output shape {got.shape} != reference {ref.shape}")

    diff = np.abs(got - ref)
    result = ParityResult(
        max_abs_diff=float(diff.max()),
        mean_abs_diff=float(diff.mean()),
        n_rows=int(matrix.shape[0]),
        atol=atol,
    )
    if not result.ok:
        raise ValueError(
            f"ONNX parity failed: max|Δp|={result.max_abs_diff:.2e} > atol={atol:.0e}. "
            "Refusing to write a divergent model."
        )

    out_path = Path(out_path)
    out_path.parent.mkdir(parents=True, exist_ok=True)
    with open(out_path, "wb") as fh:
        fh.write(onnx_bytes)
    return result
