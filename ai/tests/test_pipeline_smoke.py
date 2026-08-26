"""Pipeline smoke: the full run wires together and behaves correctly end-to-end.

Uses the pure-numpy DummyRanker into a throwaway registry, so it needs no ML
libraries. It asserts the *contract* of a run — an artifact is frozen, a record
is written, gates are computed, and (because the dummy fails the golden gate) the
model is registered but NOT activated — rather than any particular metric value.
"""

from __future__ import annotations

import json
import tempfile
from pathlib import Path

from aaroh_ai.training.pipeline import run_training
from tests._helpers import dummy_config, raw


def test_full_dummy_run():
    models_root = Path(tempfile.mkdtemp())
    result = run_training(dummy_config(), raw=raw(), models_root=models_root)

    # a frozen artifact directory with the model, the exact transform, the report
    for fname in ("model.json", "feature_spec.json", "metadata.json", "eval_report.html"):
        assert (result.artifact_dir / fname).exists(), f"missing artifact: {fname}"

    # the report is a real, non-trivial HTML file
    assert result.report_path.exists() and result.report_path.stat().st_size > 10_000

    # gates were computed with the expected structure
    assert "passed" in result.gates and isinstance(result.gates["checks"], list)
    names = {c["name"] for c in result.gates["checks"]}
    assert any("golden" in n.lower() for n in names)

    # all 24 golden cases ran
    assert result.golden.n_total == 24

    # the dummy is weak → gates fail → registered but NOT activated
    assert result.activated is False

    # the registry on disk knows the version, and no model is active
    reg_path = models_root / "registry" / "registry.json"
    data = json.loads(reg_path.read_text())
    versions = [m["version"] for m in data["models"]]
    assert result.version in versions
    assert all(not m["is_active"] for m in data["models"])

    # ONNX must be skipped for the dummy framework
    assert result.onnx_parity is None
    assert not (result.artifact_dir / "model.onnx").exists()


def test_gate_activation_logic_first_model():
    # With no prior active model, baseline gates are informational (pass), so the
    # only thing that can fail the dummy is the golden gate.
    models_root = Path(tempfile.mkdtemp())
    result = run_training(dummy_config(), raw=raw(), models_root=models_root)
    baseline_gates = [c for c in result.gates["checks"] if "baseline" in c["name"].lower()]
    assert all(c["passed"] for c in baseline_gates)
