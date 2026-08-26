"""The training pipeline — one function that turns a config into a frozen,
registered, evaluated model with an agronomist-facing report.

The whole point of Phase 1 is *trustworthiness*, so this orchestrator is
deliberately linear and every step is auditable:

    load → validate → features → split → [tune] → fit → evaluate →
    golden → gates → freeze artifact → register → [ONNX] → report

Two invariants make the output trustworthy:

* **One transform, shared.** The exact :class:`FeaturePipeline` fitted on the
  training fold is saved beside the model and is the same object used for the
  golden tests here and for serving later — no train/serve skew.
* **Gates decide activation, not registration.** Every run is recorded (audit
  trail), but a model only becomes *active* if it clears the gates: Top-3 not
  below baseline, NDCG@3 not below baseline, ECE under threshold, and every
  golden test passing. A model that fails is frozen and visible but never live.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

from aaroh_ai.data.loading import RawData, load_raw
from aaroh_ai.data.validation import validate_raw
from aaroh_ai.evaluation.golden import build_golden_cases, run_golden
from aaroh_ai.evaluation.metrics import (
    calibration_bins,
    confusion_matrix,
    evaluate,
    per_class_prf,
    top_confusion_pairs,
)
from aaroh_ai.evaluation.report import ReportContext, write_report
from aaroh_ai.features.feature_pipeline import FeaturePipeline
from aaroh_ai.training.models import build_ranker
from aaroh_ai.training.registry import FileRegistry, ModelRecord, write_artifact_metadata
from aaroh_ai.training.splits import stratified_split

# Small tolerance so floating-point noise doesn't fail a "not worse" gate.
_GATE_TOL = 1e-4


@dataclass
class PipelineResult:
    version: str
    record: ModelRecord
    report_path: Path
    artifact_dir: Path
    summary: Any
    golden: Any
    gates: dict
    onnx_parity: Any | None
    activated: bool


def _now_iso() -> str:
    return datetime.now(UTC).strftime("%Y-%m-%dT%H:%M:%SZ")


def _cfg(d: dict, path: str, default=None):
    """Nested config getter: ``_cfg(cfg, 'gates.max_ece', 0.15)``."""
    cur: Any = d
    for key in path.split("."):
        if not isinstance(cur, dict) or key not in cur:
            return default
        cur = cur[key]
    return cur


def evaluate_gates(summary, golden, baseline: dict | None, gates_cfg: dict) -> dict:
    """Turn metrics + golden results into pass/fail gate rows.

    ``baseline`` is the active model's stored metrics (or ``None`` for the first
    model). Returns ``{"passed": bool, "checks": [{name, passed, detail}, ...]}``
    — the shape the report template and the registry both consume.
    """
    checks: list[dict] = []

    # Gate 1 — Top-3 coverage must not regress.
    min_top3 = gates_cfg.get("min_top3")
    if min_top3 is not None:
        passed = summary.top3 >= float(min_top3) - _GATE_TOL
        checks.append({"name": f"Top-3 ≥ {float(min_top3):.3f}", "passed": passed,
                       "detail": f"top3={summary.top3:.4f}"})
    elif baseline is not None:
        b = baseline["top3"]
        passed = summary.top3 >= b - _GATE_TOL
        checks.append({"name": "Top-3 ≥ baseline", "passed": passed,
                       "detail": f"top3={summary.top3:.4f} vs baseline {b:.4f}"})
    else:
        checks.append({"name": "Top-3 ≥ baseline", "passed": True,
                       "detail": "no baseline (first model) — informational"})

    # Gate 2 — NDCG@3 (vs soft) must not regress.
    if baseline is not None and gates_cfg.get("ndcg3_not_worse_than_baseline", True):
        b = baseline["ndcg_at_3"]
        passed = summary.ndcg_at_3 >= b - _GATE_TOL
        checks.append({"name": "NDCG@3 not worse than baseline", "passed": passed,
                       "detail": f"ndcg@3={summary.ndcg_at_3:.4f} vs baseline {b:.4f}"})
    else:
        checks.append({"name": "NDCG@3 not worse than baseline", "passed": True,
                       "detail": f"ndcg@3={summary.ndcg_at_3:.4f}; no baseline — informational"})

    # Gate 3 — calibration.
    max_ece = gates_cfg.get("max_ece")
    if max_ece is not None:
        passed = summary.ece <= float(max_ece) + _GATE_TOL
        checks.append({"name": f"ECE ≤ {float(max_ece):.3f}", "passed": passed,
                       "detail": f"ece={summary.ece:.4f}"})

    # Gate 4 — every agronomic golden test passes.
    if gates_cfg.get("require_golden_pass", True):
        checks.append({"name": "All golden tests pass", "passed": golden.passed,
                       "detail": f"{golden.n_passed}/{golden.n_total}"})

    return {"passed": all(c["passed"] for c in checks), "checks": checks}


def run_training(
    config: dict,
    *,
    raw: RawData | None = None,
    data_dir: str | Path | None = None,
    models_root: str | Path | None = None,
) -> PipelineResult:
    """Execute the full pipeline for one model ``config``.

    ``models_root`` defaults to ``<ai>/models``; tests point it at a tmp dir so a
    run never touches the real registry. ``raw`` can be injected to avoid
    re-reading the CSVs.
    """
    seed = int(config.get("seed", 42))
    name = config.get("name", "crop-ranker")
    version = f"{name}@{config['version']}"

    # 1) data
    raw = raw if raw is not None else load_raw(data_dir)
    validate_raw(raw).raise_if_failed()
    classes = raw.classes
    hard = raw.hard_indices()
    soft = raw.soft_matrix()

    # 2) split (stratified by hard label; grouped-by-field once real data lands)
    ratios = tuple(_cfg(config, "split.ratios", (0.70, 0.15, 0.15)))
    split = stratified_split(hard, seed=seed, ratios=ratios)

    # 3) features — fit on TRAIN only, then apply everywhere (no leakage)
    pipe = FeaturePipeline.fit(
        raw.features.iloc[split.train],
        source_hashes={"features": raw.features_sha256, "soft": raw.soft_sha256},
    )
    X_tr = pipe.transform(raw.features.iloc[split.train])
    X_va = pipe.transform(raw.features.iloc[split.val])
    X_te = pipe.transform(raw.features.iloc[split.test])

    model_cfg = dict(config["model"])
    model_cfg.setdefault("seed", seed)

    # 4) optional hyperparameter tuning on the val fold (maximise NDCG@3)
    if _cfg(config, "tuning.enabled", False):
        from aaroh_ai.training.tuning import tune

        data = {"X_train": X_tr, "soft_train": soft[split.train], "hard_train": hard[split.train],
                "X_val": X_va, "soft_val": soft[split.val], "hard_val": hard[split.val]}
        result = tune(model_cfg, classes, data,
                      n_trials=int(_cfg(config, "tuning.n_trials", 30)), seed=seed)
        model_cfg["params"] = {**model_cfg.get("params", {}), **result.best_params}

    # 5) fit
    ranker = build_ranker(model_cfg, classes)
    ranker.fit(X_tr, soft[split.train], hard[split.train],
               X_va, soft[split.val], hard[split.val])

    # 6) evaluate on the held-out test fold
    proba = ranker.predict_proba(X_te)
    y_te, soft_te = hard[split.test], soft[split.test]
    summary = evaluate(proba, y_te, soft_te)
    cm = confusion_matrix(y_te, proba.argmax(axis=1), len(classes))
    per_class = per_class_prf(cm)
    pairs = top_confusion_pairs(cm, classes, top_n=10)
    cal = calibration_bins(proba, y_te, n_bins=10)

    # 7) agronomic golden tests through the SAME pipeline
    golden = run_golden(build_golden_cases(raw), ranker.predict_proba, pipe, classes)

    # 8) gates (vs the currently-active model, if any)
    models_root = Path(models_root) if models_root else _default_models_root()
    registry = FileRegistry(models_root / "registry" / "registry.json")
    baseline_rec = registry.active()
    baseline_metrics = baseline_rec.metrics if baseline_rec else None
    gates = evaluate_gates(summary, golden, baseline_metrics, config.get("gates", {}))

    # 9) freeze the artifact (model + the exact transform + report)
    artifact_dir = models_root / "artifacts" / version
    artifact_dir.mkdir(parents=True, exist_ok=True)
    ranker.save(artifact_dir)
    pipe.save(artifact_dir / "feature_spec.json")

    # 10) optional ONNX freeze — only for a real classifier that cleared gates
    onnx_parity = None
    if _cfg(config, "onnx.enabled", False) and ranker.framework != "dummy" and gates["passed"]:
        from aaroh_ai.export.onnx_export import CLASSIFIER_OBJECTIVES, export_to_onnx

        if ranker.objective in CLASSIFIER_OBJECTIVES:
            sample = X_te.iloc[: int(_cfg(config, "onnx.parity_rows", 256))]
            onnx_parity = export_to_onnx(
                ranker, sample, artifact_dir / "model.onnx",
                atol=float(_cfg(config, "onnx.atol", 1e-4)),
            )

    # 11) register (always) and activate (only if gates pass, real model, config says so)
    activate = bool(_cfg(config, "registry.activate", True)) and gates["passed"] \
        and ranker.framework != "dummy"
    record = ModelRecord(
        version=version, algo=ranker.algo, objective=ranker.objective,
        trained_at=_now_iso(), dataset_hash=raw.features_sha256,
        metrics=summary.to_dict(),
        artifact_uri=str(Path("artifacts") / version),
        feature_spec_uri=str(Path("artifacts") / version / "feature_spec.json"),
        is_active=False,
        notes=config.get("notes", ""),
        tags={"gates_passed": str(gates["passed"]), "framework": ranker.framework,
              "golden": f"{golden.n_passed}/{golden.n_total}"},
    )
    registry.register(record, activate=activate, overwrite=True)

    # 12) report — written last so it can state the final gate/activation verdict
    report_path = artifact_dir / "eval_report.html"
    write_report(report_path, ReportContext(
        meta={"version": version, "framework": ranker.framework, "objective": ranker.objective,
              "trained_at": record.trained_at, "dataset_hash": raw.features_sha256[:12],
              "feature_spec_version": pipe.spec_version, "n_train": len(split.train),
              "n_val": len(split.val), "n_test": len(split.test),
              "git_commit": config.get("git_commit")},
        summary=summary, confusion=cm, per_class=per_class, calibration=cal,
        top_pairs=pairs, golden=golden, classes=classes, gates=gates,
        baseline_summary=None,
    ))
    write_artifact_metadata(artifact_dir, record,
                            extra={"gates": gates,
                                   "onnx_parity": onnx_parity.__dict__ if onnx_parity else None})

    return PipelineResult(
        version=version, record=record, report_path=report_path, artifact_dir=artifact_dir,
        summary=summary, golden=golden, gates=gates, onnx_parity=onnx_parity, activated=activate,
    )


def _default_models_root() -> Path:
    # <ai>/src/aaroh_ai/training/pipeline.py -> parents[3] == <ai>
    return Path(__file__).resolve().parents[3] / "models"
